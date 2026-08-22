/* Alert engine: detection, confidence tiering, neighbour correlation
   (cluster alerts), escalation on timeout, and the false-positive feedback
   loop that tunes thresholds over time. */
(function (FF) {
  'use strict';

  const U = FF.util;
  const C = FF.config;
  const store = FF.store;
  const net = FF.network;

  const listeners = [];
  function on(fn) { listeners.push(fn); }
  function emit(evt) { listeners.forEach(function (fn) { try { fn(evt); } catch (e) { console.warn(e); } }); }

  let seq = 0;
  function nextId(prefix) {
    seq++;
    return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + seq;
  }

  function tierFor(score, cfg) {
    const t = cfg.confidence.tiers;
    if (score >= t.critical) return 'critical';
    if (score >= t.high) return 'high';
    if (score >= t.moderate) return 'moderate';
    return 'low';
  }

  /* ---- Confidence -------------------------------------------------------
     Score = wMetrics · (metrics breached / 3)
           + wNeighbors · (corroborating neighbours / neighborsForFull)
           + wSeverity · (worst metric's exceedance, normalised)
           + wPersistence · (consecutive breaching samples / persistenceSamples)

     Weights and the tier cut-offs are configuration, not code, so a range can
     retune them from Settings as the labelled dataset grows. */
  function scoreAlert(node, breached, corroborating, consecutive, cfg) {
    const w = cfg.confidence;
    const th = cfg.thresholds;
    const cal = node.calibration;

    const hardMetrics = breached.filter(function (m) { return m !== 'gas_rate'; }).length;
    const metricsF = U.clamp((hardMetrics + (breached.indexOf('gas_rate') >= 0 ? 0.5 : 0)) / 3, 0, 1);
    const neighborF = U.clamp(corroborating / Math.max(1, w.neighborsForFull), 0, 1);

    const exceed = [
      (node.gas - (th.gasPpm + cal.gasOffset)) / Math.max(1, th.gasPpm * 0.35),
      (node.temp - (th.tempC + cal.tempOffset)) / 8,
      ((th.humidityPct + cal.humidityOffset) - node.humidity) / 10
    ];
    const severityF = U.clamp(Math.max.apply(null, exceed), 0, 1);
    const persistF = U.clamp(consecutive / Math.max(1, w.persistenceSamples), 0, 1);

    const score = w.wMetrics * metricsF + w.wNeighbors * neighborF +
                  w.wSeverity * severityF + w.wPersistence * persistF;

    return {
      score: U.round(U.clamp(score, 0, 100), 0),
      factors: {
        metrics: U.round(metricsF, 2),
        neighbors: U.round(neighborF, 2),
        severity: U.round(severityF, 2),
        persistence: U.round(persistF, 2)
      }
    };
  }

  /* Neighbours currently breaching within the correlation window. */
  function corroboratingNeighbors(node, cfg, now) {
    const win = cfg.correlation.windowMin * 60e3;
    return node.neighbors.filter(function (id) {
      const m = net.byId(id);
      if (!m || m.status !== 'online') return false;
      if (now - m.lastSeen > win) return false;
      return net.isTriggering(net.breaches(m, cfg));
    });
  }

  function snapshot(node) {
    return {
      gas: node.gas, temp: node.temp, humidity: node.humidity,
      gasRate: node.gasRate, battery: node.battery, riskScore: node.riskScore,
      rssi: node.rssi, at: node.lastSeen
    };
  }

  /* ---- Detection --------------------------------------------------------- */

  function evaluate() {
    const cfg = store.getConfig();
    const now = Date.now();
    const created = [];

    net.nodes().forEach(function (node) {
      if (node.status !== 'online') { node.consecutiveBreaches = 0; return; }

      const breached = net.breaches(node, cfg);
      if (!net.isTriggering(breached)) {
        node.consecutiveBreaches = 0;
        const open = store.openAlertForNode(node.id);
        /* Conditions normalised — the alert still waits for a human, but it is
           flagged so rangers can see it is no longer live. */
        if (open && !open.conditionsClearedAt) {
          open.conditionsClearedAt = now;
          store.save();
          emit({ type: 'alert-cleared', alert: open });
        }
        return;
      }

      node.consecutiveBreaches = (node.consecutiveBreaches || 0) + 1;
      const corro = corroboratingNeighbors(node, cfg, now);
      const scored = scoreAlert(node, breached, corro.length, node.consecutiveBreaches, cfg);
      const tier = tierFor(scored.score, cfg);
      const existing = store.openAlertForNode(node.id);

      if (existing) {
        existing.updatedAt = now;
        existing.conditionsClearedAt = null;
        existing.samples++;
        existing.metrics = breached;
        existing.corroboratingNodes = corro;
        existing.confidence = Math.max(existing.confidence, scored.score);
        existing.factors = scored.factors;
        existing.tier = tierFor(existing.confidence, cfg);
        existing.peak = {
          gas: Math.max(existing.peak.gas, node.gas),
          temp: Math.max(existing.peak.temp, node.temp),
          humidity: Math.min(existing.peak.humidity, node.humidity)
        };
        existing.readings.push(snapshot(node));
        if (existing.readings.length > 60) existing.readings.shift();
        store.save();
        return;
      }

      /* A single gas sample on its own is noise; require either persistence, a
         second metric, or a corroborating neighbour before opening an alert. */
      const worthOpening = node.consecutiveBreaches >= 2 || breached.length >= 2 || corro.length > 0;
      if (!worthOpening) return;

      const alert = {
        id: nextId('ALT'),
        nodeId: node.id,
        nodeLabel: node.label,
        sector: node.sector,
        lat: node.lat, lng: node.lng,
        createdAt: now,
        updatedAt: now,
        status: 'open',
        tier: tier,
        confidence: scored.score,
        factors: scored.factors,
        metrics: breached,
        corroboratingNodes: corro,
        clusterId: null,
        samples: 1,
        peak: { gas: node.gas, temp: node.temp, humidity: node.humidity },
        /* Raw readings kept with the alert so an outcome tag labels real data. */
        trigger: snapshot(node),
        readings: [snapshot(node)],
        thresholdsAtTrigger: JSON.parse(JSON.stringify(cfg.thresholds)),
        calibrationAtTrigger: JSON.parse(JSON.stringify(node.calibration)),
        conditionsClearedAt: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        outcome: null,
        note: '',
        escalatedAt: null,
        escalationLevel: 0
      };
      store.addAlert(alert);
      created.push(alert);
      emit({ type: 'alert-new', alert: alert });
    });

    if (created.length) correlate();
    return created;
  }

  /* ---- Cluster correlation ----------------------------------------------
     Adjacent nodes spiking together are one event, not N events. Connected
     components over the neighbour graph of currently-live alerts become
     cluster alerts, which outrank any single-node alert inside them. */
  function correlate() {
    const cfg = store.getConfig();
    const now = Date.now();
    const win = cfg.correlation.windowMin * 60e3;

    const live = store.openAlerts().filter(function (a) {
      return !a.conditionsClearedAt && now - a.updatedAt <= win;
    });
    if (live.length < cfg.correlation.minClusterSize) return [];

    const byNode = {};
    live.forEach(function (a) { byNode[a.nodeId] = a; });

    const seen = {};
    const components = [];
    live.forEach(function (a) {
      if (seen[a.nodeId]) return;
      const stack = [a.nodeId];
      const comp = [];
      seen[a.nodeId] = true;
      while (stack.length) {
        const id = stack.pop();
        comp.push(byNode[id]);
        const node = net.byId(id);
        (node ? node.neighbors : []).forEach(function (nb) {
          if (byNode[nb] && !seen[nb]) { seen[nb] = true; stack.push(nb); }
        });
      }
      if (comp.length >= cfg.correlation.minClusterSize) components.push(comp);
    });

    const out = [];
    components.forEach(function (comp) {
      const members = comp.map(function (a) { return a.id; }).sort();
      const key = members.join('|');
      let cluster = store.openClusters().filter(function (c) { return c.key === key; })[0];

      /* A growing cluster keeps its identity: match on any shared member. */
      if (!cluster) {
        cluster = store.openClusters().filter(function (c) {
          return c.alertIds.some(function (id) { return members.indexOf(id) >= 0; });
        })[0];
      }

      const confidences = comp.map(function (a) { return a.confidence; });
      /* Cluster confidence lifts with size: corroboration is the strongest
         signal we have that a spike is a real fire and not a bad sensor. */
      const base = Math.max.apply(null, confidences);
      const score = U.round(U.clamp(base + 8 * (comp.length - 1) + U.mean(confidences) * 0.1, 0, 100), 0);
      const tier = tierFor(Math.max(score, cfg.confidence.tiers.high), cfg);
      const centroid = {
        lat: U.mean(comp.map(function (a) { return a.lat; })),
        lng: U.mean(comp.map(function (a) { return a.lng; }))
      };

      if (cluster) {
        cluster.key = key;
        cluster.alertIds = members;
        cluster.nodeIds = comp.map(function (a) { return a.nodeId; });
        cluster.confidence = Math.max(cluster.confidence, score);
        cluster.tier = tier;
        cluster.updatedAt = now;
        cluster.size = comp.length;
        cluster.centroid = centroid;
      } else {
        cluster = {
          id: nextId('CLU'),
          key: key,
          alertIds: members,
          nodeIds: comp.map(function (a) { return a.nodeId; }),
          sector: comp[0].sector,
          size: comp.length,
          confidence: score,
          tier: tier,
          centroid: centroid,
          createdAt: now,
          updatedAt: now,
          status: 'open',
          acknowledgedAt: null,
          acknowledgedBy: null,
          outcome: null,
          escalatedAt: null,
          escalationLevel: 0
        };
        store.addCluster(cluster);
        emit({ type: 'cluster-new', cluster: cluster });
      }

      comp.forEach(function (a) {
        a.clusterId = cluster.id;
        /* Membership of a cluster raises the member's own tier floor. */
        if (C.TIER_RANK[a.tier] < C.TIER_RANK[cluster.tier]) a.tier = cluster.tier;
      });
      out.push(cluster);
    });

    store.save();
    return out;
  }

  /* ---- Escalation --------------------------------------------------------
     Push can be missed in the field, so an unacknowledged alert escalates to
     the configured secondary responders after a per-deployment timeout. */
  function checkEscalations() {
    const cfg = store.getConfig();
    if (!cfg.escalation.enabled) return [];
    const now = Date.now();
    const minRank = C.TIER_RANK[cfg.escalation.minTierToEscalate] || 0;
    const fired = [];

    function timeoutMsFor(tier) {
      const mins = tier === 'critical' ? cfg.escalation.criticalTimeoutMin : cfg.escalation.timeoutMin;
      return mins * 60e3;
    }

    function escalate(subject, kind) {
      const contacts = cfg.escalation.contacts
        .slice()
        .sort(function (a, b) { return a.order - b.order; })
        .filter(function (c) { return cfg.escalation.channels[c.channel] !== false; });
      if (!contacts.length) return;

      const level = (subject.escalationLevel || 0) + 1;
      const contact = contacts[Math.min(level - 1, contacts.length - 1)];
      subject.escalationLevel = level;
      subject.escalatedAt = now;

      const rec = {
        id: nextId('ESC'),
        at: now,
        kind: kind,                       // 'alert' | 'cluster'
        subjectId: subject.id,
        nodeLabel: subject.nodeLabel || (subject.nodeIds || []).join(', '),
        tier: subject.tier,
        confidence: subject.confidence,
        level: level,
        contactId: contact.id,
        contactName: contact.name,
        phone: contact.phone,
        channel: contact.channel,
        reason: 'No acknowledgement within ' +
                (subject.tier === 'critical' ? cfg.escalation.criticalTimeoutMin : cfg.escalation.timeoutMin) +
                ' min',
        /* In production this is the SMS gateway / voice bridge receipt. */
        delivery: 'simulated'
      };
      store.addEscalation(rec);
      fired.push(rec);
      emit({ type: 'escalation', escalation: rec, subject: subject });
    }

    store.openClusters().forEach(function (c) {
      if (c.acknowledgedAt) return;
      if (C.TIER_RANK[c.tier] < minRank) return;
      const due = c.escalatedAt ? c.escalatedAt + timeoutMsFor(c.tier) : c.createdAt + timeoutMsFor(c.tier);
      if (now >= due && c.escalationLevel < cfg.escalation.contacts.length) escalate(c, 'cluster');
    });

    store.openAlerts().forEach(function (a) {
      if (a.acknowledgedAt) return;
      if (C.TIER_RANK[a.tier] < minRank) return;
      /* Members of a cluster escalate through the cluster, not individually. */
      if (a.clusterId) return;
      const due = a.escalatedAt ? a.escalatedAt + timeoutMsFor(a.tier) : a.createdAt + timeoutMsFor(a.tier);
      if (now >= due && a.escalationLevel < cfg.escalation.contacts.length) escalate(a, 'alert');
    });

    if (fired.length) store.save();
    return fired;
  }

  /* Milliseconds until an open alert escalates (negative once overdue). */
  function timeToEscalation(subject) {
    const cfg = store.getConfig();
    if (!cfg.escalation.enabled || subject.acknowledgedAt) return null;
    if (C.TIER_RANK[subject.tier] < (C.TIER_RANK[cfg.escalation.minTierToEscalate] || 0)) return null;
    const mins = subject.tier === 'critical' ? cfg.escalation.criticalTimeoutMin : cfg.escalation.timeoutMin;
    const from = subject.escalatedAt || subject.createdAt;
    return from + mins * 60e3 - Date.now();
  }

  /* ---- Acknowledgement + feedback loop ----------------------------------- */

  function acknowledge(alertId, outcomeId, note, opts) {
    const alert = store.alertById(alertId);
    if (!alert || alert.acknowledgedAt) return null;
    const user = store.session();
    const now = Date.now();
    const tag = C.OUTCOME_TAGS.filter(function (t) { return t.id === outcomeId; })[0];

    alert.acknowledgedAt = now;
    alert.acknowledgedBy = user ? user.name : 'unknown';
    alert.outcome = outcomeId;
    alert.note = note || '';
    alert.status = 'closed';
    alert.responseMs = now - alert.createdAt;

    /* The labelled record: outcome tag against the raw readings that fired it. */
    const record = {
      id: nextId('FB'),
      alertId: alert.id,
      clusterId: alert.clusterId,
      nodeId: alert.nodeId,
      sector: alert.sector,
      taggedAt: now,
      taggedBy: alert.acknowledgedBy,
      outcome: outcomeId,
      truePositive: !!(tag && tag.truePositive),
      note: alert.note,
      tier: alert.tier,
      confidence: alert.confidence,
      factors: alert.factors,
      metrics: alert.metrics,
      corroboratingNodes: alert.corroboratingNodes,
      trigger: alert.trigger,
      peak: alert.peak,
      readings: alert.readings.slice(-20),
      thresholds: alert.thresholdsAtTrigger,
      responseMs: alert.responseMs
    };
    store.addFeedback(record);

    /* A cluster is one fire, not one per member — acknowledgeCluster files the
       single incident itself once every member is tagged. */
    if (tag && tag.truePositive && !(opts && opts.skipIncident)) {
      store.addIncident({
        id: nextId('INC'),
        at: alert.createdAt,
        nodeId: alert.nodeId,
        sector: alert.sector,
        lat: alert.lat, lng: alert.lng,
        tier: alert.tier,
        confidence: alert.confidence,
        clustered: !!alert.clusterId,
        responseMs: alert.responseMs,
        outcome: outcomeId,
        source: 'live'
      });
    }

    /* Close the parent cluster once every member has been tagged. */
    if (alert.clusterId) {
      const cluster = store.clusterById(alert.clusterId);
      if (cluster) {
        const pending = cluster.alertIds.filter(function (id) {
          const a = store.alertById(id);
          return a && !a.acknowledgedAt;
        });
        if (!pending.length) {
          cluster.status = 'closed';
          cluster.acknowledgedAt = now;
          cluster.acknowledgedBy = alert.acknowledgedBy;
          cluster.outcome = outcomeId;
        }
      }
    }

    applyTuning(alert.nodeId);
    store.save();
    emit({ type: 'alert-ack', alert: alert, feedback: record });
    return alert;
  }

  function acknowledgeCluster(clusterId, outcomeId, note) {
    const cluster = store.clusterById(clusterId);
    if (!cluster) return null;
    const tag = C.OUTCOME_TAGS.filter(function (t) { return t.id === outcomeId; })[0];
    const now = Date.now();

    cluster.alertIds.forEach(function (id) {
      acknowledge(id, outcomeId, note, { skipIncident: true });
    });

    if (tag && tag.truePositive) {
      store.addIncident({
        id: nextId('INC'),
        at: cluster.createdAt,
        nodeId: cluster.nodeIds[0],
        nodeIds: cluster.nodeIds,
        sector: cluster.sector,
        lat: cluster.centroid.lat,
        lng: cluster.centroid.lng,
        tier: cluster.tier,
        confidence: cluster.confidence,
        clustered: true,
        responseMs: now - cluster.createdAt,
        outcome: outcomeId,
        source: 'live'
      });
      store.save();
    }
    return cluster;
  }

  /* ---- Threshold tuning from labelled outcomes ---------------------------
     Repeated non-fire outcomes on a node raise that node's own trigger points
     rather than desensitising the whole network. Confirmed fires pull the
     offsets back toward zero so tuning can never blind a node. */
  function tuningFor(nodeId) {
    const fb = store.feedback().filter(function (f) { return f.nodeId === nodeId; });
    const counts = { confirmed_fire: 0, controlled_burn: 0, animal_activity: 0, sensor_fault: 0, dust_haze: 0, other: 0 };
    fb.forEach(function (f) { if (counts[f.outcome] !== undefined) counts[f.outcome]++; });

    const falseGas = counts.sensor_fault * 55 + counts.dust_haze * 35 + counts.controlled_burn * 20;
    const falseTemp = counts.animal_activity * 1.5 + counts.sensor_fault * 0.8;
    const pullback = counts.confirmed_fire * 70;

    return {
      samples: fb.length,
      counts: counts,
      gasOffset: U.round(U.clamp(falseGas - pullback, -60, 260), 0),
      tempOffset: U.round(U.clamp(falseTemp - counts.confirmed_fire * 2, -3, 5), 1),
      humidityOffset: U.round(U.clamp(-counts.dust_haze * 0.6, -4, 0), 1)
    };
  }

  function applyTuning(nodeId) {
    const node = net.byId(nodeId);
    if (!node) return null;
    const t = tuningFor(nodeId);
    node.calibration = {
      gasOffset: t.gasOffset,
      tempOffset: t.tempOffset,
      humidityOffset: t.humidityOffset,
      updatedAt: Date.now(),
      samples: t.samples
    };
    return node.calibration;
  }

  function applyAllTuning() {
    net.nodes().forEach(function (n) { applyTuning(n.id); });
  }

  /* Network-wide suggestion shown in Settings once enough labels exist. */
  function globalTuningSuggestion() {
    const fb = store.feedback();
    if (fb.length < 8) return null;
    const falsePos = fb.filter(function (f) { return !f.truePositive; });
    const truePos = fb.filter(function (f) { return f.truePositive; });
    const fpRate = falsePos.length / fb.length;
    const cfg = store.getConfig();

    const falseGasPeak = falsePos.length ? U.mean(falsePos.map(function (f) { return f.peak.gas; })) : 0;
    const trueGasPeak = truePos.length ? U.mean(truePos.map(function (f) { return f.peak.gas; })) : 0;

    let suggestedGas = cfg.thresholds.gasPpm;
    if (fpRate > 0.45 && falseGasPeak && (!trueGasPeak || trueGasPeak > falseGasPeak)) {
      /* Sit the threshold between the two population means, nearer the false one. */
      suggestedGas = Math.round(trueGasPeak ? U.lerp(falseGasPeak, trueGasPeak, 0.35) : falseGasPeak * 1.08);
    } else if (fpRate < 0.15 && truePos.length >= 3) {
      suggestedGas = Math.round(cfg.thresholds.gasPpm * 0.95);
    }

    return {
      labels: fb.length,
      falsePositiveRate: U.round(fpRate * 100, 1),
      meanFalsePeakGas: U.round(falseGasPeak, 0),
      meanTruePeakGas: U.round(trueGasPeak, 0),
      currentGas: cfg.thresholds.gasPpm,
      suggestedGas: U.clamp(suggestedGas, 500, 1400),
      changed: Math.abs(suggestedGas - cfg.thresholds.gasPpm) >= 15
    };
  }

  /* ---- Seeded history ----------------------------------------------------
     Two seasons of tagged incidents so Historical Reporting is meaningful on
     first run. Deterministic, and clearly marked source: 'seed'. */
  function seedHistory() {
    if (store.isSeeded()) return;
    const rand = U.rng(4242);
    const nodes = net.nodes();
    const incidents = [];
    const feedback = [];
    const now = Date.now();

    for (let d = 730; d > 0; d--) {
      const t = now - d * 864e5;
      const date = new Date(t);
      const month = date.getMonth();
      /* Fire season in the northern Indian forests peaks Feb–June. */
      const seasonal = [0.25, 0.6, 0.95, 1.0, 0.9, 0.7, 0.2, 0.12, 0.15, 0.3, 0.35, 0.28][month];
      const events = rand() < seasonal * 0.34 ? 1 + (rand() < 0.25 ? 1 : 0) : 0;

      for (let k = 0; k < events; k++) {
        const node = nodes[Math.floor(rand() * nodes.length)];
        const clustered = rand() < 0.42;
        const confidence = Math.round(clustered ? 62 + rand() * 36 : 30 + rand() * 45);
        const tier = confidence >= 80 ? 'critical' : confidence >= 60 ? 'high' : confidence >= 40 ? 'moderate' : 'low';

        /* Clustered, high-confidence events are far likelier to be real. */
        const roll = rand();
        let outcome;
        if (clustered && confidence > 70) outcome = roll < 0.72 ? 'confirmed_fire' : (roll < 0.85 ? 'controlled_burn' : 'dust_haze');
        else if (confidence > 55) outcome = roll < 0.34 ? 'confirmed_fire' : (roll < 0.55 ? 'controlled_burn' : (roll < 0.78 ? 'dust_haze' : 'animal_activity'));
        else outcome = roll < 0.1 ? 'confirmed_fire' : (roll < 0.42 ? 'sensor_fault' : (roll < 0.68 ? 'animal_activity' : (roll < 0.88 ? 'dust_haze' : 'other')));

        const tag = C.OUTCOME_TAGS.filter(function (x) { return x.id === outcome; })[0];
        const responseMs = Math.round((2 + rand() * 26) * 60e3);
        const peakGas = Math.round((outcome === 'confirmed_fire' ? 900 + rand() * 900 : 700 + rand() * 260));
        const peakTemp = U.round(outcome === 'confirmed_fire' ? 44 + rand() * 18 : 39 + rand() * 5, 1);
        const peakHum = U.round(outcome === 'confirmed_fire' ? 8 + rand() * 12 : 18 + rand() * 10, 1);

        feedback.push({
          id: 'FB-SEED-' + d + '-' + k,
          alertId: 'ALT-SEED-' + d + '-' + k,
          clusterId: clustered ? 'CLU-SEED-' + d + '-' + k : null,
          nodeId: node.id,
          sector: node.sector,
          taggedAt: t + responseMs,
          taggedBy: 'R. Bhatt',
          outcome: outcome,
          truePositive: !!(tag && tag.truePositive),
          note: '',
          tier: tier,
          confidence: confidence,
          factors: null,
          metrics: outcome === 'confirmed_fire' ? ['gas', 'temp', 'humidity'] : (rand() < 0.5 ? ['gas'] : ['gas', 'temp']),
          corroboratingNodes: clustered ? node.neighbors.slice(0, 1 + Math.floor(rand() * 3)) : [],
          trigger: { gas: peakGas, temp: peakTemp, humidity: peakHum, gasRate: U.round(rand() * 90, 1), battery: U.round(40 + rand() * 55, 1), riskScore: confidence, at: t },
          peak: { gas: peakGas, temp: peakTemp, humidity: peakHum },
          readings: [],
          thresholds: JSON.parse(JSON.stringify(C.DEFAULT_CONFIG.thresholds)),
          responseMs: responseMs,
          source: 'seed'
        });

        /* Mirror the label as a closed alert so the History tab is populated on
           first run, but only inside the alert-history retention window. */
        if (d <= store.getConfig().retention.alertHistoryDays) {
          store.addAlert({
            id: 'ALT-SEED-' + d + '-' + k,
            nodeId: node.id,
            nodeLabel: node.label,
            sector: node.sector,
            lat: node.lat, lng: node.lng,
            createdAt: t,
            updatedAt: t + responseMs,
            status: 'closed',
            tier: tier,
            confidence: confidence,
            factors: null,
            metrics: outcome === 'confirmed_fire' ? ['gas', 'temp', 'humidity'] : ['gas'],
            corroboratingNodes: clustered ? node.neighbors.slice(0, 2) : [],
            clusterId: clustered ? 'CLU-SEED-' + d + '-' + k : null,
            samples: 2 + Math.floor(rand() * 8),
            peak: { gas: peakGas, temp: peakTemp, humidity: peakHum },
            trigger: { gas: peakGas, temp: peakTemp, humidity: peakHum, gasRate: 0, battery: 70, riskScore: confidence, at: t },
            readings: [],
            thresholdsAtTrigger: JSON.parse(JSON.stringify(C.DEFAULT_CONFIG.thresholds)),
            calibrationAtTrigger: { gasOffset: 0, tempOffset: 0, humidityOffset: 0, updatedAt: 0, samples: 0 },
            conditionsClearedAt: t + responseMs,
            acknowledgedAt: t + responseMs,
            acknowledgedBy: 'R. Bhatt',
            outcome: outcome,
            note: '',
            responseMs: responseMs,
            escalatedAt: null,
            escalationLevel: 0,
            source: 'seed'
          });
        }

        if (tag && tag.truePositive) {
          incidents.push({
            id: 'INC-SEED-' + d + '-' + k,
            at: t,
            nodeId: node.id,
            sector: node.sector,
            lat: node.lat, lng: node.lng,
            tier: tier,
            confidence: confidence,
            clustered: clustered,
            responseMs: responseMs,
            outcome: outcome,
            areaHa: U.round(0.2 + rand() * 6.5, 2),
            source: 'seed'
          });
        }
      }
    }

    store.seedIncidents(incidents);
    feedback.forEach(function (f) { store.addFeedback(f); });
    applyAllTuning();
    store.save();
  }

  FF.alerts = {
    on: on, evaluate: evaluate, correlate: correlate,
    checkEscalations: checkEscalations, timeToEscalation: timeToEscalation,
    acknowledge: acknowledge, acknowledgeCluster: acknowledgeCluster,
    tierFor: tierFor, tuningFor: tuningFor, applyTuning: applyTuning, applyAllTuning: applyAllTuning,
    globalTuningSuggestion: globalTuningSuggestion, seedHistory: seedHistory
  };
})(window.FF = window.FF || {});
