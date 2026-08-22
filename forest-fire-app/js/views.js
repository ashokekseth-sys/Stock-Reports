/* Views: Dashboard, Live Map, Alerts. */
(function (FF) {
  'use strict';

  const U = FF.util;
  const C = FF.config;
  const UI = FF.ui;
  const store = FF.store;
  const net = FF.network;
  const charts = FF.charts;
  const esc = U.esc;

  FF.views = FF.views || {};

  /* Roll-up used by the dashboard and the top bar. */
  function summary() {
    const nodes = net.nodes();
    const cfg = store.getConfig();
    const online = nodes.filter(function (n) { return n.status === 'online'; });
    const offline = nodes.filter(function (n) { return n.status !== 'online'; });
    const open = store.openAlerts();
    const clusters = store.openClusters();
    const batteries = nodes.map(function (n) { return n.battery; });
    return {
      nodes: nodes,
      total: nodes.length,
      online: online.length,
      offline: offline.length,
      offlineNodes: offline,
      alerts: open,
      unacked: open.filter(function (a) { return !a.acknowledgedAt; }),
      clusters: clusters,
      charging: nodes.filter(function (n) { return n.charging; }).length,
      meanBattery: U.round(U.mean(batteries), 1),
      lowBattery: nodes.filter(function (n) { return n.battery <= cfg.health.batteryLowPct; }),
      criticalBattery: nodes.filter(function (n) { return n.battery <= cfg.health.batteryCriticalPct; }),
      atRisk: online.filter(function (n) { return n.riskScore >= 55; }),
      meanRisk: U.round(U.mean(online.map(function (n) { return n.riskScore; })), 1)
    };
  }

  /* Scenario controls — drive the simulator so the alerting, correlation and
     escalation paths can be exercised without waiting for a real fire. */
  function scenarioBar() {
    return '<div class="toolbar">' +
      '<span style="font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3)">Simulate</span>' +
      '<button class="btn btn-sm" data-sim="fire">🔥 Ignition (cluster)</button>' +
      '<button class="btn btn-sm" data-sim="sensor_fault">⚠ Single-node gas spike</button>' +
      '<button class="btn btn-sm" data-sim="animal">🐘 Animal disturbance</button>' +
      '<button class="btn btn-sm" data-sim="haze">🌫 External haze</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-sm" data-sim="clear">Clear simulated events</button>' +
      '</div>';
  }

  function wireScenario(root) {
    root.querySelectorAll('[data-sim]').forEach(function (b) {
      b.addEventListener('click', function () {
        const kind = b.getAttribute('data-sim');
        if (kind === 'clear') {
          net.clearIgnitions();
          UI.toast({ kind: 'info', icon: '✔', title: 'Simulated events cleared', body: 'Readings will settle back to baseline over the next few transmissions.' });
          return;
        }
        const nodes = net.nodes().filter(function (n) { return n.status === 'online'; });
        const node = nodes[Math.floor(Math.random() * nodes.length)];
        const opts = kind === 'fire'
          ? { kind: 'fire', intensity: 1, radiusM: 260, durationMs: 20 * 60e3 }
          : kind === 'sensor_fault'
            ? { kind: 'sensor_fault', intensity: 1, radiusM: 0, durationMs: 14 * 60e3 }
            : kind === 'animal'
              ? { kind: 'animal', intensity: 1, radiusM: 0, durationMs: 8 * 60e3 }
              : { kind: 'haze', intensity: 0.8, radiusM: 300, durationMs: 16 * 60e3 };
        net.startIgnition(node.id, opts);
        UI.toast({
          kind: 'info', icon: '⚙',
          title: 'Scenario injected at ' + node.label,
          body: kind === 'fire'
            ? 'Gas, temperature and humidity will diverge across the node and its neighbours.'
            : 'A localised disturbance is now affecting this node only.'
        });
      });
    });
  }

  /* =============================== Dashboard ============================== */

  FF.views.dashboard = {
    title: 'Dashboard',
    crumb: 'Network status at a glance',
    live: true,
    render: function (root) {
      const s = summary();
      const cfg = store.getConfig();
      const w = net.weather();
      const escalationsToday = store.escalations().filter(function (e) { return Date.now() - e.at < 864e5; });

      const bySector = {};
      s.nodes.forEach(function (n) {
        bySector[n.sector] = bySector[n.sector] || { total: 0, online: 0, risk: [], alerts: 0 };
        bySector[n.sector].total++;
        if (n.status === 'online') { bySector[n.sector].online++; bySector[n.sector].risk.push(n.riskScore); }
      });
      s.alerts.forEach(function (a) { if (bySector[a.sector]) bySector[a.sector].alerts++; });

      /* Network-average telemetry for the last 24 h, from the node histories. */
      const sample = s.nodes.slice(0, 18);
      function avgSeries(field) {
        const buckets = {};
        sample.forEach(function (n) {
          net.series(n, 24, field).forEach(function (p) {
            const k = Math.round(p.t / 18e5) * 18e5;     // 30-minute buckets
            (buckets[k] = buckets[k] || []).push(p.v);
          });
        });
        return Object.keys(buckets).sort().map(function (k) {
          return { t: +k, v: U.round(U.mean(buckets[k]), 1) };
        });
      }

      root.innerHTML =
        scenarioBar() +
        '<div class="grid g-4" style="margin-bottom:14px">' +
          statCard('Total nodes', s.total, '📡',
            s.online + ' reporting · ' + net.gateways().length + ' gateways · ' + cfg.regionName) +
          statCard('Online / offline',
            '<span style="color:var(--ok)">' + s.online + '</span><small> / </small>' +
            '<span style="color:' + (s.offline ? 'var(--crit)' : 'var(--text-3)') + '">' + s.offline + '</span>', '🔗',
            s.offline ? s.offlineNodes.slice(0, 3).map(function (n) { return n.id; }).join(', ') +
              (s.offline > 3 ? ' +' + (s.offline - 3) + ' more' : '') : 'Full mesh connectivity') +
          statCard('Active alerts',
            '<span style="color:' + (s.alerts.length ? 'var(--crit)' : 'var(--text)') + '">' + s.alerts.length + '</span>', '🚨',
            (s.clusters.length ? '<span class="badge cluster">' + s.clusters.length + ' cluster</span> ' : '') +
            s.unacked.length + ' awaiting acknowledgement') +
          statCard('Battery health', s.meanBattery + '<small>%</small>', '🔋',
            s.charging + ' charging · ' + s.lowBattery.length + ' low · ' + s.criticalBattery.length + ' critical') +
        '</div>' +

        '<div class="grid g-2-1" style="margin-bottom:14px">' +
          '<div class="card">' +
            '<div class="card-head"><h3>Network telemetry — 24 h average</h3><span class="spacer"></span>' +
            '<span class="sub">' + sample.length + '-node sample</span></div>' +
            '<div id="dash-chart"></div>' +
            '<div class="legend" style="margin-top:10px">' +
              '<span><i style="background:#ff8a3d"></i>Gas (MQ135 ppm CO₂-eq)</span>' +
              '<span><i style="background:#ff4d4d"></i>Gas threshold ' + cfg.thresholds.gasPpm + ' ppm</span>' +
            '</div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-head"><h3>Conditions</h3></div>' +
            '<dl class="kv">' +
              '<dt>Dryness index</dt><dd>' + w.dryIndex + '</dd>' +
              '<dt>Mean node risk</dt><dd>' + s.meanRisk + ' / 100</dd>' +
              '<dt>Nodes at high risk</dt><dd>' + s.atRisk.length + '</dd>' +
              '<dt>Escalations (24 h)</dt><dd>' + escalationsToday.length + '</dd>' +
              '<dt>Labelled outcomes</dt><dd>' + store.feedback().length + '</dd>' +
              '<dt>Escalation timeout</dt><dd>' + cfg.escalation.timeoutMin + ' min</dd>' +
            '</dl>' +
            '<div style="margin-top:14px">' + charts.hBars(Object.keys(bySector).map(function (k) {
              const v = bySector[k];
              const r = U.round(U.mean(v.risk), 0);
              return { label: k, value: r, display: r + ' risk · ' + v.online + '/' + v.total + ' up',
                       color: C.riskLevel(r).color };
            })) + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="grid g-2-1">' +
          '<div class="card">' +
            '<div class="card-head"><h3>Active alerts</h3><span class="spacer"></span>' +
            '<a class="btn btn-sm" href="#/alerts">Open alerts view</a></div>' +
            (s.clusters.length ? s.clusters.map(clusterCard).join('') : '') +
            alertsTable(s.alerts.filter(function (a) { return !a.clusterId; }).slice(0, 8), {
              compact: true,
              emptyMessage: s.clusters.length
                ? 'Every active alert is correlated into the cluster above.'
                : null
            }) +
          '</div>' +
          '<div class="card">' +
            '<div class="card-head"><h3>Attention list</h3></div>' +
            attentionList(s) +
          '</div>' +
        '</div>';

      const chartHost = root.querySelector('#dash-chart');
      if (chartHost) {
        chartHost.innerHTML = charts.lineChart(
          [{ name: 'Gas', color: '#ff8a3d', points: avgSeries('gas') }],
          { height: 226, thresholds: [{ v: cfg.thresholds.gasPpm, label: 'gas threshold', color: '#ff4d4d' }] }
        );
      }
      wireScenario(root);
      wireAlertRows(root);
    }
  };

  function statCard(label, value, icon, foot) {
    return '<div class="card stat">' +
      '<div class="label">' + esc(icon) + ' ' + esc(label) + '</div>' +
      '<div class="value">' + value + '</div>' +
      '<div class="foot">' + foot + '</div></div>';
  }

  function attentionList(s) {
    const cfg = store.getConfig();
    const items = [];
    s.criticalBattery.forEach(function (n) {
      items.push({ icon: '🔋', kind: 'crit', title: n.label + ' battery ' + n.battery + '%',
        body: (n.panelHealth < 0.7 ? 'Panel output degraded (' + Math.round(n.panelHealth * 100) + '%). ' : '') +
              'Below critical floor of ' + cfg.health.batteryCriticalPct + '%.', href: '#/nodes/' + n.id });
    });
    s.offlineNodes.forEach(function (n) {
      items.push({ icon: '📴', kind: 'warn', title: n.label + ' offline',
        body: 'Last packet ' + U.fmtAgo(n.lastSeen) + ' via ' + n.gatewayId + ' (' + n.hops + ' hops).', href: '#/nodes/' + n.id });
    });
    net.nodes().filter(function (n) { return n.calibration.samples >= 2 && n.calibration.gasOffset >= 80; })
      .forEach(function (n) {
        items.push({ icon: '🎛', kind: 'info', title: n.label + ' auto-calibrated',
          body: 'Gas trigger raised +' + n.calibration.gasOffset + ' ppm from ' + n.calibration.samples +
                ' tagged outcomes.', href: '#/nodes/' + n.id });
      });

    if (!items.length) {
      return '<div class="empty"><span class="big">✓</span>Every node is reporting, charged and within threshold.</div>';
    }
    return '<div style="display:flex;flex-direction:column;gap:10px;max-height:430px;overflow:auto">' +
      items.slice(0, 14).map(function (i) {
        return '<a href="' + esc(i.href) + '" style="text-decoration:none;color:inherit">' +
          '<div class="note" style="border-left-color:' +
          (i.kind === 'crit' ? 'var(--crit)' : i.kind === 'warn' ? 'var(--warn)' : 'var(--info)') + '">' +
          '<strong style="color:var(--text);font-size:12.5px">' + esc(i.icon) + ' ' + esc(i.title) + '</strong><br>' +
          esc(i.body) + '</div></a>';
      }).join('') + '</div>';
  }

  /* =============================== Live map =============================== */

  const mapState = { selected: null, filter: 'all' };

  FF.views.map = {
    title: 'Live map',
    crumb: 'GPS positions, mesh topology and colour-coded risk',
    live: true,
    render: function (root) {
      const s = summary();
      const selected = mapState.selected ? net.byId(mapState.selected) : null;

      root.innerHTML =
        '<div class="grid g-2-1">' +
          '<div>' +
            '<div class="map-wrap" style="margin-bottom:14px">' +
              '<div id="map-host"></div>' +
              '<div class="map-overlay">' +
                '<div style="font-size:12px;font-weight:600;margin-bottom:7px">' + esc(store.getConfig().regionName) + '</div>' +
                '<div class="legend" style="flex-direction:column;gap:5px">' +
                  C.RISK_LEVELS.map(function (l) {
                    return '<span><i style="background:' + l.color + '"></i>' + esc(l.label) + ' (' + l.min + '+)</span>';
                  }).join('') +
                  '<span><i style="background:#64748b"></i>Offline</span>' +
                  '<span><i style="background:#4c9aff;border-radius:2px"></i>Gateway</span>' +
                '</div>' +
              '</div>' +
              '<div class="map-controls">' +
                '<button data-act="in" title="Zoom in">+</button>' +
                '<button data-act="out" title="Zoom out">−</button>' +
                '<button data-act="reset" title="Reset view">⟲</button>' +
              '</div>' +
            '</div>' +
            scenarioBar() +
            '<div class="note">Nodes are canopy-mounted on a ' + C.DEPLOYMENT.spacingM +
            ' m grid across ' + esc(store.getConfig().regionName) + '. Thin lines show each node\'s LoRa route to its ' +
            'gateway; dashed lines are nodes that have missed their transmission window. Drag to pan, scroll to zoom, ' +
            'click a node for detail.</div>' +
          '</div>' +
          '<div class="card" style="align-self:start">' +
            (selected ? nodePanel(selected) :
              '<div class="empty"><span class="big">📍</span>Select a node on the map to inspect its readings, ' +
              'link quality and power state.</div>') +
          '</div>' +
        '</div>';

      FF.map.render(root.querySelector('#map-host'), {
        height: 560,
        selectedId: mapState.selected,
        onSelect: function (id) {
          mapState.selected = id;
          FF.views.map.render(root);
        }
      });
      wireScenario(root);
      wireAlertRows(root);
    }
  };

  function nodePanel(n) {
    const cfg = store.getConfig();
    const alert = store.openAlertForNode(n.id);
    const lvl = C.riskLevel(n.riskScore);
    return '<div class="card-head"><h3>' + esc(n.label) + '</h3><span class="spacer"></span>' +
      UI.riskBadge(n, 'risk') + '</div>' +
      (alert ? '<div class="note" style="border-left-color:' + C.tierColor(alert.tier) + ';margin-bottom:12px">' +
        '<strong style="color:var(--text)">Active ' + esc(alert.tier) + ' alert</strong> — confidence ' +
        alert.confidence + '%, raised ' + esc(U.fmtAgo(alert.createdAt)) + '.' +
        (alert.clusterId ? ' Part of a cluster alert.' : '') + '</div>' : '') +
      '<dl class="kv">' +
        '<dt>Risk score</dt><dd style="color:' + lvl.color + '">' + n.riskScore + ' / 100</dd>' +
        '<dt>Gas (MQ135)</dt><dd>' + n.gas + ' ppm</dd>' +
        '<dt>Rate of rise</dt><dd>' + n.gasRate + ' ppm/min</dd>' +
        '<dt>Temperature</dt><dd>' + n.temp + ' °C</dd>' +
        '<dt>Humidity</dt><dd>' + n.humidity + ' %</dd>' +
        '<dt>Battery</dt><dd>' + n.battery + '% ' + (n.charging ? '☀ charging' : '🌙 discharging') + '</dd>' +
        '<dt>Solar input</dt><dd>' + n.solarW + ' W</dd>' +
        '<dt>Last packet</dt><dd>' + esc(U.fmtAgo(n.lastSeen)) + '</dd>' +
        '<dt>Route</dt><dd>' + esc(n.gatewayId) + ' · ' + n.hops + ' hops · ' + n.rssi + ' dBm</dd>' +
        '<dt>Position</dt><dd>' + n.lat + ', ' + n.lng + '</dd>' +
        '<dt>Elevation</dt><dd>' + n.elevM + ' m · canopy ' + n.canopyM + ' m</dd>' +
        '<dt>Calibration</dt><dd>' + (n.calibration.samples
          ? (n.calibration.gasOffset > 0 ? '+' : '') + n.calibration.gasOffset + ' ppm (' +
            n.calibration.samples + ' labels)' : 'factory') + '</dd>' +
      '</dl>' +
      '<div style="margin-top:14px;display:flex;gap:8px">' +
        '<a class="btn btn-sm btn-block" href="#/nodes/' + esc(n.id) + '">Open node monitor</a>' +
        (alert ? '<button class="btn btn-sm btn-primary btn-block" data-ack="' + esc(alert.id) + '">Acknowledge</button>' : '') +
      '</div>';
  }

  /* ================================ Alerts ================================ */

  const alertState = { tab: 'active', tierFilter: 'all', query: '' };

  FF.views.alerts = {
    title: 'Alerts',
    crumb: 'Confidence-tiered alerts, cluster correlation, escalation and outcome tagging',
    live: true,
    render: function (root) {
      const cfg = store.getConfig();
      const open = store.openAlerts();
      const clusters = store.openClusters();
      const history = store.alerts().filter(function (a) { return a.status === 'closed'; })
        .sort(function (a, b) { return b.createdAt - a.createdAt; });
      const escalations = store.escalations().slice().sort(function (a, b) { return b.at - a.at; });
      const feedback = store.feedback().slice().sort(function (a, b) { return b.taggedAt - a.taggedAt; });

      const tabs = [
        { id: 'active', label: 'Active', count: open.length },
        { id: 'history', label: 'History', count: history.length },
        { id: 'escalations', label: 'Escalations', count: escalations.length },
        { id: 'dataset', label: 'Feedback dataset', count: feedback.length }
      ];

      let body = '';
      if (alertState.tab === 'active') {
        const filtered = open.filter(function (a) {
          return alertState.tierFilter === 'all' || a.tier === alertState.tierFilter;
        });
        const single = filtered.filter(function (a) { return !a.clusterId; });
        const clustered = filtered.filter(function (a) { return a.clusterId; });
        body =
          (clusters.length
            ? '<div class="card" style="margin-bottom:14px"><div class="card-head">' +
              '<h3>Cluster alerts</h3><span class="sub">Adjacent nodes spiking together — highest confidence</span></div>' +
              clusters.map(clusterCard).join('') + '</div>'
            : '') +
          '<div class="card"><div class="card-head"><h3>Single-node alerts</h3>' +
          '<span class="sub">Isolated spikes — treated with lower confidence</span><span class="spacer"></span>' +
          '<select id="tier-filter" style="width:auto">' +
            ['all'].concat(C.TIERS.slice().reverse()).map(function (t) {
              return '<option value="' + t + '"' + (alertState.tierFilter === t ? ' selected' : '') + '>' +
                (t === 'all' ? 'All tiers' : t) + '</option>';
            }).join('') +
          '</select></div>' +
          alertsTable(single, { emptyMessage: clustered.length
            ? 'Every active alert is correlated into a cluster above — no isolated spikes right now.'
            : null }) +
          (clustered.length ? '<div class="note" style="margin-top:12px">' + clustered.length +
            ' further alert(s) are rolled into the cluster cards above.</div>' : '') +
          '</div>';
      } else if (alertState.tab === 'history') {
        body = '<div class="card"><div class="card-head"><h3>Alert history</h3>' +
          '<span class="sub">Retained ' + cfg.retention.alertHistoryDays + ' days</span>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-sm" id="export-history">Export CSV</button></div>' +
          historyTable(history) + '</div>';
      } else if (alertState.tab === 'escalations') {
        body = '<div class="card"><div class="card-head"><h3>Escalation log</h3>' +
          '<span class="sub">Timeout ' + cfg.escalation.timeoutMin + ' min · critical ' +
          cfg.escalation.criticalTimeoutMin + ' min</span><span class="spacer"></span>' +
          '<a class="btn btn-sm" href="#/settings">Configure</a></div>' +
          escalationTable(escalations) + '</div>';
      } else {
        body = datasetPanel(feedback);
      }

      root.innerHTML =
        '<div class="toolbar">' +
          '<div class="seg">' + tabs.map(function (t) {
            return '<button data-tab="' + t.id + '" class="' + (alertState.tab === t.id ? 'active' : '') + '">' +
              esc(t.label) + ' (' + t.count + ')</button>';
          }).join('') + '</div>' +
          '<span class="spacer"></span>' +
          '<span class="badge ' + (open.length ? 'crit' : 'muted') + '">' + open.length + ' open</span>' +
          '<span class="badge ' + (clusters.length ? 'cluster' : 'muted') + '">' + clusters.length + ' cluster</span>' +
        '</div>' + body;

      root.querySelectorAll('[data-tab]').forEach(function (b) {
        b.addEventListener('click', function () {
          alertState.tab = b.getAttribute('data-tab');
          FF.views.alerts.render(root);
        });
      });
      const tf = root.querySelector('#tier-filter');
      if (tf) tf.addEventListener('change', function () {
        alertState.tierFilter = tf.value;
        FF.views.alerts.render(root);
      });
      const ex = root.querySelector('#export-history');
      if (ex) ex.addEventListener('click', function () { exportHistory(history); });
      wireAlertRows(root);
    }
  };

  function clusterCard(cl) {
    const eta = FF.alerts.timeToEscalation(cl);
    return '<div class="cluster-card">' +
      '<div class="head">' +
        '<span class="badge cluster">Cluster · ' + cl.size + ' nodes</span>' +
        UI.tierBadge(cl.tier) +
        '<strong style="font-size:13.5px">' + esc(cl.sector) + '</strong>' +
        '<span style="color:var(--text-3);font-size:12px">raised ' + esc(U.fmtAgo(cl.createdAt)) + '</span>' +
        '<span class="spacer"></span>' + UI.confBar(cl.confidence) +
      '</div>' +
      '<div style="font-size:12.5px;color:var(--text-2);line-height:1.6">' +
        'Correlated spikes across adjacent nodes within ' + store.getConfig().correlation.radiusM +
        ' m — treated as one high-confidence event rather than ' + cl.size + ' independent alerts.' +
      '</div>' +
      '<div class="nodes">' + cl.nodeIds.map(function (id) {
        return '<span class="chip">' + esc(id) + '</span>';
      }).join('') + '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">' +
        '<button class="btn btn-sm btn-primary" data-ack-cluster="' + esc(cl.id) + '">Acknowledge cluster</button>' +
        '<a class="btn btn-sm" href="#/map">Show on map</a>' +
        escalationChip(cl, eta) +
      '</div></div>';
  }

  function escalationChip(subject, eta) {
    if (subject.escalationLevel > 0) {
      return '<span class="badge crit">escalated · level ' + subject.escalationLevel + '</span>' +
        '<span style="font-size:11.5px;color:var(--text-3)">' + esc(U.fmtAgo(subject.escalatedAt)) + '</span>';
    }
    if (eta === null) return '<span class="badge muted">below escalation tier</span>';
    if (eta <= 0) return '<span class="badge warn">escalating…</span>';
    return '<span style="font-size:11.5px;color:var(--text-3)">escalates in ' + esc(U.fmtDur(eta)) + '</span>';
  }

  function alertsTable(list, opts) {
    const o = opts || {};
    if (!list.length) {
      return '<div class="empty"><span class="big">🌲</span>' +
        esc(o.emptyMessage || 'No active alerts. All nodes within threshold.') + '</div>';
    }
    const sorted = list.slice().sort(function (a, b) {
      return (C.TIER_RANK[b.tier] - C.TIER_RANK[a.tier]) || (b.confidence - a.confidence) || (b.createdAt - a.createdAt);
    });
    return '<div class="table-wrap"><table><thead><tr>' +
      '<th>Tier</th><th>Node</th><th>Metrics</th><th class="num">Gas</th><th class="num">Temp</th><th class="num">RH</th>' +
      '<th>Confidence</th><th>Raised</th>' + (o.compact ? '' : '<th>Escalation</th>') + '<th></th>' +
      '</tr></thead><tbody>' +
      sorted.map(function (a) {
        const eta = FF.alerts.timeToEscalation(a);
        return '<tr class="alert-row tier-' + esc(a.tier) + '">' +
          '<td>' + UI.tierBadge(a.tier) + (a.conditionsClearedAt ? ' <span class="badge muted">cleared</span>' : '') + '</td>' +
          '<td><a href="#/nodes/' + esc(a.nodeId) + '">' + esc(a.nodeId) + '</a>' +
            '<div style="font-size:11px;color:var(--text-3)">' + esc(a.sector) + '</div></td>' +
          '<td>' + UI.metricChips(a.metrics) +
            (a.corroboratingNodes.length ? ' <span class="badge cluster">+' + a.corroboratingNodes.length + ' neighbour</span>' : '') + '</td>' +
          '<td class="num">' + esc(U.round(a.peak.gas, 0)) + '</td>' +
          '<td class="num">' + esc(U.round(a.peak.temp, 1)) + '</td>' +
          '<td class="num">' + esc(U.round(a.peak.humidity, 0)) + '</td>' +
          '<td>' + UI.confBar(a.confidence) + '</td>' +
          '<td style="white-space:nowrap;color:var(--text-2)">' + esc(U.fmtAgo(a.createdAt)) + '</td>' +
          (o.compact ? '' : '<td>' + escalationChip(a, eta) + '</td>') +
          '<td><button class="btn btn-sm btn-primary" data-ack="' + esc(a.id) + '">Acknowledge</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function historyTable(list) {
    if (!list.length) return '<div class="empty"><span class="big">🗂</span>No acknowledged alerts yet.</div>';
    return '<div class="table-wrap"><table><thead><tr>' +
      '<th>Raised</th><th>Node</th><th>Tier</th><th class="num">Conf.</th><th>Outcome</th>' +
      '<th class="num">Response</th><th>Acknowledged by</th><th>Note</th>' +
      '</tr></thead><tbody>' +
      list.slice(0, 300).map(function (a) {
        const tag = C.OUTCOME_TAGS.filter(function (t) { return t.id === a.outcome; })[0];
        return '<tr>' +
          '<td style="white-space:nowrap">' + esc(U.fmtDateTime(a.createdAt)) + '</td>' +
          '<td><a href="#/nodes/' + esc(a.nodeId) + '">' + esc(a.nodeId) + '</a></td>' +
          '<td>' + UI.tierBadge(a.tier) + (a.clusterId ? ' <span class="badge cluster">cluster</span>' : '') + '</td>' +
          '<td class="num">' + esc(a.confidence) + '</td>' +
          '<td><span class="badge ' + (tag && tag.truePositive ? 'crit' : 'muted') + '">' +
            esc(tag ? tag.label : a.outcome || '—') + '</span></td>' +
          '<td class="num">' + esc(a.responseMs ? U.fmtDur(a.responseMs) : '—') + '</td>' +
          '<td style="color:var(--text-2)">' + esc(a.acknowledgedBy || '—') + '</td>' +
          '<td style="color:var(--text-3);max-width:240px">' + esc(a.note || '') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function escalationTable(list) {
    if (!list.length) {
      return '<div class="empty"><span class="big">📞</span>No escalations. Every qualifying alert has been ' +
        'acknowledged inside the timeout window.</div>';
    }
    const icon = { sms: '💬', voice: '📞', push: '📲' };
    return '<div class="table-wrap"><table><thead><tr>' +
      '<th>When</th><th>Subject</th><th>Tier</th><th>Level</th><th>Channel</th><th>Contact</th><th>Reason</th>' +
      '</tr></thead><tbody>' +
      list.slice(0, 200).map(function (e) {
        return '<tr>' +
          '<td style="white-space:nowrap">' + esc(U.fmtDateTime(e.at)) + '</td>' +
          '<td><span class="chip">' + esc(e.kind === 'cluster' ? 'CLUSTER' : 'ALERT') + '</span> ' + esc(e.nodeLabel) + '</td>' +
          '<td>' + UI.tierBadge(e.tier) + '</td>' +
          '<td class="num">' + esc(e.level) + '</td>' +
          '<td>' + esc(icon[e.channel] || '') + ' ' + esc(e.channel.toUpperCase()) + '</td>' +
          '<td>' + esc(e.contactName) + '<div style="font-size:11px;color:var(--text-3);font-family:var(--mono)">' +
            esc(e.phone) + '</div></td>' +
          '<td style="color:var(--text-3)">' + esc(e.reason) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function datasetPanel(feedback) {
    const counts = {};
    C.OUTCOME_TAGS.forEach(function (t) { counts[t.id] = 0; });
    feedback.forEach(function (f) { if (counts[f.outcome] !== undefined) counts[f.outcome]++; });
    const truePos = feedback.filter(function (f) { return f.truePositive; }).length;
    const colors = { confirmed_fire: '#ff4d4d', controlled_burn: '#ff8a3d', dust_haze: '#ffc748',
                     animal_activity: '#4c9aff', sensor_fault: '#c98cff', other: '#64748b' };

    return '<div class="grid g-1-2">' +
      '<div class="card">' +
        '<div class="card-head"><h3>Labelled outcomes</h3></div>' +
        '<div style="display:grid;place-items:center;margin-bottom:14px">' +
          charts.donut(C.OUTCOME_TAGS.map(function (t) {
            return { label: t.label, value: counts[t.id], color: colors[t.id] };
          }), { centerValue: feedback.length, centerLabel: 'labels', size: 168 }) +
        '</div>' +
        charts.hBars(C.OUTCOME_TAGS.map(function (t) {
          return { label: t.label, value: counts[t.id], color: colors[t.id] };
        })) +
        '<div class="note" style="margin-top:14px">' +
          'False-positive rate <strong style="color:var(--text)">' +
          (feedback.length ? U.round(((feedback.length - truePos) / feedback.length) * 100, 1) : 0) +
          '%</strong> across ' + feedback.length + ' labelled alerts. Each record stores the outcome tag against the ' +
          'raw readings that triggered it — thresholds, calibration and all — so it can train future tuning.' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
          '<button class="btn btn-sm btn-block" id="export-json">Export JSON</button>' +
          '<button class="btn btn-sm btn-block" id="export-csv">Export CSV</button>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><h3>Feedback records</h3><span class="sub">Retained ' +
        store.getConfig().retention.feedbackDatasetDays + ' days</span></div>' +
        (feedback.length ? '<div class="table-wrap"><table><thead><tr>' +
          '<th>Tagged</th><th>Node</th><th>Outcome</th><th class="num">Conf.</th><th>Metrics</th>' +
          '<th class="num">Peak gas</th><th class="num">Peak °C</th><th class="num">Min RH</th><th>Label</th>' +
          '</tr></thead><tbody>' +
          feedback.slice(0, 300).map(function (f) {
            const tag = C.OUTCOME_TAGS.filter(function (t) { return t.id === f.outcome; })[0];
            return '<tr><td style="white-space:nowrap">' + esc(U.fmtDate(f.taggedAt)) + '</td>' +
              '<td><a href="#/nodes/' + esc(f.nodeId) + '">' + esc(f.nodeId) + '</a></td>' +
              '<td>' + esc(tag ? tag.label : f.outcome) + '</td>' +
              '<td class="num">' + esc(f.confidence) + '</td>' +
              '<td>' + UI.metricChips(f.metrics) + '</td>' +
              '<td class="num">' + esc(U.round(f.peak.gas, 0)) + '</td>' +
              '<td class="num">' + esc(U.round(f.peak.temp, 1)) + '</td>' +
              '<td class="num">' + esc(U.round(f.peak.humidity, 0)) + '</td>' +
              '<td><span class="badge ' + (f.truePositive ? 'crit' : 'ok') + '">' +
                (f.truePositive ? 'true positive' : 'false positive') + '</span></td></tr>';
          }).join('') + '</tbody></table></div>'
          : '<div class="empty"><span class="big">🏷</span>No labelled records yet.</div>') +
      '</div></div>';
  }

  function exportHistory(list) {
    const rows = [['alert_id', 'node', 'sector', 'raised', 'tier', 'confidence', 'metrics', 'peak_gas_ppm',
                   'peak_temp_c', 'min_rh_pct', 'cluster', 'outcome', 'response_seconds', 'acknowledged_by', 'note']];
    list.forEach(function (a) {
      rows.push([a.id, a.nodeId, a.sector, new Date(a.createdAt).toISOString(), a.tier, a.confidence,
        (a.metrics || []).join(' '), U.round(a.peak.gas, 0), U.round(a.peak.temp, 1), U.round(a.peak.humidity, 0),
        a.clusterId ? 'yes' : 'no', a.outcome || '', a.responseMs ? Math.round(a.responseMs / 1000) : '',
        a.acknowledgedBy || '', a.note || '']);
    });
    U.downloadFile('alert-history-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv', U.toCsv(rows));
  }

  /* ---- Acknowledgement + outcome tagging --------------------------------- */

  function wireAlertRows(root) {
    root.querySelectorAll('[data-ack]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        openAckModal(b.getAttribute('data-ack'), null);
      });
    });
    root.querySelectorAll('[data-ack-cluster]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        openAckModal(null, b.getAttribute('data-ack-cluster'));
      });
    });
    root.querySelectorAll('#export-json').forEach(function (b) {
      b.addEventListener('click', function () {
        U.downloadFile('feedback-dataset-' + new Date().toISOString().slice(0, 10) + '.json',
          'application/json', JSON.stringify(store.feedback(), null, 2));
      });
    });
    root.querySelectorAll('#export-csv').forEach(function (b) {
      b.addEventListener('click', function () {
        const rows = [['record_id', 'alert_id', 'node', 'sector', 'tagged_at', 'outcome', 'true_positive', 'tier',
                       'confidence', 'metrics', 'corroborating_nodes', 'trigger_gas_ppm', 'trigger_temp_c',
                       'trigger_rh_pct', 'peak_gas_ppm', 'gas_threshold', 'temp_threshold', 'rh_threshold', 'note']];
        store.feedback().forEach(function (f) {
          rows.push([f.id, f.alertId, f.nodeId, f.sector, new Date(f.taggedAt).toISOString(), f.outcome,
            f.truePositive, f.tier, f.confidence, (f.metrics || []).join(' '),
            (f.corroboratingNodes || []).join(' '), f.trigger.gas, f.trigger.temp, f.trigger.humidity,
            f.peak.gas, f.thresholds.gasPpm, f.thresholds.tempC, f.thresholds.humidityPct, f.note || '']);
        });
        U.downloadFile('feedback-dataset-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv', U.toCsv(rows));
      });
    });
  }

  function openAckModal(alertId, clusterId) {
    const cluster = clusterId ? store.clusterById(clusterId) : null;
    const alert = alertId ? store.alertById(alertId) : null;
    if (!cluster && !alert) return;

    const subjectLabel = cluster
      ? 'Cluster · ' + cluster.size + ' nodes · ' + cluster.sector
      : alert.nodeLabel + ' · ' + alert.sector;
    const conf = cluster ? cluster.confidence : alert.confidence;
    const tier = cluster ? cluster.tier : alert.tier;

    const detail = alert ? '<dl class="kv" style="margin-bottom:16px">' +
      '<dt>Gas at trigger</dt><dd>' + alert.trigger.gas + ' ppm (threshold ' +
        (alert.thresholdsAtTrigger.gasPpm + alert.calibrationAtTrigger.gasOffset) + ')</dd>' +
      '<dt>Temperature</dt><dd>' + alert.trigger.temp + ' °C</dd>' +
      '<dt>Humidity</dt><dd>' + alert.trigger.humidity + ' %</dd>' +
      '<dt>Rate of rise</dt><dd>' + alert.trigger.gasRate + ' ppm/min</dd>' +
      '<dt>Corroborating nodes</dt><dd>' + (alert.corroboratingNodes.length || 'none') + '</dd>' +
      '<dt>Samples</dt><dd>' + alert.samples + '</dd>' +
      '</dl>' : '<div class="note" style="margin-bottom:16px">Tagging the cluster applies the same outcome to all ' +
      cluster.size + ' member alerts, and closes them together.</div>';

    UI.openModal({
      title: 'Acknowledge alert',
      body:
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">' +
          UI.tierBadge(tier) + UI.confBar(conf) +
          '<strong style="font-size:13.5px">' + esc(subjectLabel) + '</strong>' +
        '</div>' + detail +
        '<div class="field"><label>Outcome — what did the ranger find?</label>' +
        '<div class="outcome-grid" id="outcome-grid">' +
          C.OUTCOME_TAGS.map(function (t) {
            return '<button class="outcome-opt" data-outcome="' + esc(t.id) + '">' +
              '<span class="t">' + esc(t.label) + '</span><span class="d">' + esc(t.desc) + '</span></button>';
          }).join('') +
        '</div></div>' +
        '<div class="field"><label>Field note (optional)</label>' +
        '<textarea id="ack-note" placeholder="What was observed, action taken, crew dispatched…"></textarea></div>' +
        '<div class="note">The outcome tag is stored against the raw readings that triggered this alert. ' +
        'Repeated non-fire outcomes raise this node\'s own trigger points; confirmed fires pull them back.</div>',
      footer:
        '<button class="btn" data-close>Cancel</button>' +
        '<button class="btn btn-primary" id="ack-confirm" disabled>Acknowledge &amp; log outcome</button>',
      onMount: function (back) {
        let chosen = null;
        back.querySelectorAll('[data-outcome]').forEach(function (b) {
          b.addEventListener('click', function () {
            back.querySelectorAll('.outcome-opt').forEach(function (x) { x.classList.remove('selected'); });
            b.classList.add('selected');
            chosen = b.getAttribute('data-outcome');
            back.querySelector('#ack-confirm').disabled = false;
          });
        });
        back.querySelector('[data-close]').addEventListener('click', UI.closeModal);
        back.querySelector('#ack-confirm').addEventListener('click', function () {
          if (!chosen) return;
          const note = back.querySelector('#ack-note').value;
          if (cluster) FF.alerts.acknowledgeCluster(cluster.id, chosen, note);
          else FF.alerts.acknowledge(alert.id, chosen, note);
          UI.closeModal();
          const tag = C.OUTCOME_TAGS.filter(function (t) { return t.id === chosen; })[0];
          UI.toast({
            kind: tag && tag.truePositive ? 'crit' : 'info',
            icon: '✔',
            title: 'Alert acknowledged — ' + (tag ? tag.label : chosen),
            body: 'Logged against the triggering readings. Node calibration updated from the feedback loop.'
          });
          FF.app.rerender();
        });
      }
    });
  }

  FF.views.summary = summary;
  FF.views.openAckModal = openAckModal;
  FF.views.wireAlertRows = wireAlertRows;
})(window.FF = window.FF || {});
