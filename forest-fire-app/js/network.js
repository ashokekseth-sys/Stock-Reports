/* Sensor network model + telemetry simulator.

   Sixty canopy-mounted nodes on a 100 m grid, each carrying an MQ135 gas
   sensor and a temperature/humidity element, solar-charged, reporting over a
   LoRa mesh to gateways placed every three grids where backhaul exists.

   In a real deployment this module is replaced by the gateway ingest API; the
   shape it produces (node roster + telemetry samples) is what the rest of the
   app consumes, so only this file changes. */
(function (FF) {
  'use strict';

  const U = FF.util;
  const C = FF.config;
  const D = C.DEPLOYMENT;

  const SECTORS = [
    { name: 'Kansrao Block', maxCol: 3 },
    { name: 'Motichur Block', maxCol: 6 },
    { name: 'Chilla Block', maxCol: 9 }
  ];

  const net = {
    nodes: [],
    gateways: [],
    ignitions: [],
    tick: 0,
    lastTickAt: 0,
    weather: { dryIndex: 0.62, windKph: 9, windDir: 'NW' }
  };

  const M_PER_DEG_LAT = 111320;
  /* Power budget, in percent of pack capacity per hour. A healthy panel banks
     more than the radio and sensing duty cycle spend; a degraded one does not,
     which is what makes a failing panel visible as a falling daily baseline. */
  const DRAW_PCT_PER_HOUR = 0.62;
  const SOLAR_GAIN_PER_WH = 0.42;
  function metresPerDegLng(lat) { return M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180); }

  function sectorFor(col) {
    for (let i = 0; i < SECTORS.length; i++) if (col <= SECTORS[i].maxCol) return SECTORS[i].name;
    return SECTORS[SECTORS.length - 1].name;
  }

  /* Great-circle distance is overkill at 100 m; planar is exact enough. */
  function distanceM(a, b) {
    const dy = (a.lat - b.lat) * M_PER_DEG_LAT;
    const dx = (a.lng - b.lng) * metresPerDegLng(D.origin.lat);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ---- Build ------------------------------------------------------------- */

  function build() {
    const rand = U.rng(20260822);
    net.nodes = [];
    net.gateways = [];

    const dLat = D.spacingM / M_PER_DEG_LAT;
    const dLng = D.spacingM / metresPerDegLng(D.origin.lat);

    /* Gateways sit at every third grid cell — placement follows backhaul
       availability (ridge lines with cellular signal), not a perfect lattice. */
    for (let r = 1; r < D.rows; r += D.gatewayEvery) {
      for (let c = 1; c < D.cols; c += D.gatewayEvery) {
        net.gateways.push({
          id: 'GW-' + r + c,
          label: 'Gateway ' + (net.gateways.length + 1),
          row: r, col: c,
          /* Half a cell off the lattice: masts go on the ridge between
             compartments, and it keeps them clear of the node they'd
             otherwise sit on top of on the map. */
          lat: D.origin.lat + (r + 0.5) * dLat,
          lng: D.origin.lng + (c + 0.5) * dLng,
          backhaul: rand() > 0.35 ? 'Cellular 4G' : 'Wi-Fi relay',
          online: true
        });
      }
    }

    for (let r = 0; r < D.rows; r++) {
      for (let c = 0; c < D.cols; c++) {
        /* Terrain jitter: nodes go on the best canopy within the cell. */
        const jitLat = (rand() - 0.5) * dLat * 0.32;
        const jitLng = (rand() - 0.5) * dLng * 0.32;
        const lat = D.origin.lat + r * dLat + jitLat;
        const lng = D.origin.lng + c * dLng + jitLng;

        const gw = net.gateways.reduce(function (best, g) {
          const d = distanceM({ lat: lat, lng: lng }, g);
          return !best || d < best.d ? { g: g, d: d } : best;
        }, null);
        const hops = Math.max(1, Math.round(gw.d / D.spacingM));

        /* A handful of nodes ship with a weak panel or a drifting MQ135 —
           this is what the false-positive feedback loop exists to catch. */
        const panelHealth = rand() < 0.08 ? 0.45 + rand() * 0.2 : 0.9 + rand() * 0.1;
        const sensorDrift = rand() < 0.1 ? 0.6 + rand() * 0.9 : 0;

        net.nodes.push({
          id: 'N-R' + (r + 1) + 'C' + (c + 1),
          label: 'Node R' + (r + 1) + 'C' + (c + 1),
          row: r, col: c,
          lat: U.round(lat, 6),
          lng: U.round(lng, 6),
          elevM: Math.round(420 + 90 * Math.sin(r * 0.9) + 60 * Math.cos(c * 0.7) + rand() * 25),
          canopyM: U.round(14 + rand() * 9, 1),
          sector: sectorFor(c),
          gatewayId: gw.g.id,
          hops: hops,
          rssi: Math.round(-58 - hops * 7 - rand() * 6),
          installedAt: Date.now() - Math.floor(180 + rand() * 420) * 864e5,
          firmware: 'v' + (rand() < 0.75 ? '2.4.1' : '2.3.6'),

          battery: U.round(58 + rand() * 40, 1),
          charging: true,
          solarW: 0,
          panelHealth: U.round(panelHealth, 2),
          sensorDrift: U.round(sensorDrift, 2),

          gas: 0, temp: 0, humidity: 0,
          gasRate: 0,
          riskScore: 0,
          status: 'online',
          lastSeen: Date.now(),
          consecutiveBreaches: 0,

          /* Learned per-node calibration from the feedback loop. */
          calibration: { gasOffset: 0, tempOffset: 0, humidityOffset: 0, updatedAt: 0, samples: 0 },

          hist: [],   // hourly telemetry, retained per config.retention.telemetryHours
          live: []    // recent transmissions (rolling, capped)
        });
      }
    }

    /* Neighbour index for cluster correlation — computed once, reused. */
    const radius = FF.store.getConfig().correlation.radiusM;
    net.nodes.forEach(function (n) {
      n.neighbors = net.nodes
        .filter(function (m) { return m.id !== n.id && distanceM(n, m) <= radius; })
        .map(function (m) { return m.id; });
    });

    seedHistory();
    return net;
  }

  /* Diurnal baselines. Canopy-top air is hotter and drier than trunk level in
     the afternoon, which is exactly why the nodes are mounted up there. */
  function baseline(date, node, dryIndex) {
    const h = date.getHours() + date.getMinutes() / 60;
    const dayPhase = Math.sin(((h - 9) / 24) * 2 * Math.PI);      // peaks ~15:00
    const temp = 24 + 9 * dayPhase + (node.elevM - 460) * -0.006 + dryIndex * 4;
    const humidity = 60 - 20 * dayPhase - dryIndex * 12;
    const gas = 430 + 40 * Math.max(0, dayPhase) + node.sensorDrift * 55;
    return { temp: temp, humidity: humidity, gas: gas };
  }

  function solarInput(date, node) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h < 6.5 || h > 18.5) return 0;
    const arc = Math.sin(((h - 6.5) / 12) * Math.PI);
    /* Canopy shading and panel condition both cut the yield. */
    return U.round(Math.max(0, arc * 6.4 * node.panelHealth), 2);
  }

  /* ---- Seeded history ---------------------------------------------------- */

  function seedHistory() {
    const hours = FF.store.getConfig().retention.telemetryHours;
    const now = Date.now();
    net.nodes.forEach(function (n, idx) {
      const rand = U.rng(9001 + idx * 37);
      n.hist = [];
      let batt = U.clamp(52 + rand() * 44, 8, 100);
      for (let i = hours; i >= 0; i--) {
        const t = now - i * 3600e3;
        const d = new Date(t);
        const b = baseline(d, n, net.weather.dryIndex);
        const solar = solarInput(d, n);
        batt = U.clamp(batt + (solar * SOLAR_GAIN_PER_WH - DRAW_PCT_PER_HOUR), 4, 100);
        n.hist.push({
          t: t,
          gas: U.round(U.gauss(rand, b.gas, 18), 1),
          temp: U.round(U.gauss(rand, b.temp, 1.1), 1),
          hum: U.round(U.clamp(U.gauss(rand, b.humidity, 3.2), 5, 98), 1),
          batt: U.round(batt, 1),
          online: true
        });
      }
      const last = n.hist[n.hist.length - 1];
      n.gas = last.gas; n.temp = last.temp; n.humidity = last.hum; n.battery = last.batt;
      n.live = [];
      n.riskScore = computeRisk(n, FF.store.getConfig());
    });
  }

  /* ---- Ignition + disturbance scenarios ---------------------------------- */

  /* A real ignition heats and gasses the epicentre and bleeds into adjacent
     nodes with distance falloff — which is what produces a cluster alert. */
  function startIgnition(nodeId, opts) {
    const o = opts || {};
    const node = byId(nodeId) || net.nodes[Math.floor(Math.random() * net.nodes.length)];
    const ig = {
      id: 'IG-' + Date.now().toString(36),
      nodeId: node.id,
      startedAt: Date.now(),
      kind: o.kind || 'fire',          // fire | sensor_fault | animal | haze
      intensity: o.intensity || 1,
      radiusM: o.radiusM || (o.kind === 'fire' ? 260 : 0),
      durationMs: o.durationMs || 22 * 60e3,
      rampMs: o.rampMs || 30e3
    };
    net.ignitions.push(ig);
    return ig;
  }

  function clearIgnitions() { net.ignitions = []; }

  /* Contribution of active events to one node's readings. */
  function eventEffect(node, now) {
    let gas = 0, temp = 0, hum = 0;
    net.ignitions.forEach(function (ig) {
      const age = now - ig.startedAt;
      if (age < 0 || age > ig.durationMs) return;
      const epi = byId(ig.nodeId);
      if (!epi) return;
      const d = node.id === ig.nodeId ? 0 : distanceM(node, epi);
      if (ig.radiusM === 0 && d > 0) return;
      if (d > ig.radiusM && d > 0) return;

      const ramp = U.clamp(age / ig.rampMs, 0, 1);
      const fade = age > ig.durationMs - ig.rampMs
        ? U.clamp((ig.durationMs - age) / ig.rampMs, 0, 1) : 1;
      const falloff = ig.radiusM ? Math.pow(1 - U.clamp(d / (ig.radiusM * 1.15), 0, 1), 1.4) : 1;
      const k = ramp * fade * falloff * ig.intensity;

      if (ig.kind === 'fire') { gas += 620 * k; temp += 21 * k; hum -= 26 * k; }
      else if (ig.kind === 'sensor_fault') { gas += 430 * k; }
      else if (ig.kind === 'animal') { temp += 12 * k; hum += 5 * k; }
      else if (ig.kind === 'haze') { gas += 330 * k; hum -= 5 * k; }
    });
    return { gas: gas, temp: temp, hum: hum };
  }

  /* Without operator input the range still generates events: a drifting
     sensor, an animal on a mast, haze drifting in from farmland, and — much
     more rarely — a real ignition. */
  function maybeSpontaneous(now) {
    if (net.ignitions.length >= 3) return;
    const online = net.nodes.filter(function (n) { return n.status === 'online'; });
    if (!online.length) return;
    const pick = function () { return online[Math.floor(Math.random() * online.length)]; };
    const r = Math.random();
    if (r < 0.0012) {
      startIgnition(pick().id, { kind: 'fire', intensity: 0.9 + Math.random() * 0.3, radiusM: 260, durationMs: 18 * 60e3 });
    } else if (r < 0.0055) {
      const kinds = ['sensor_fault', 'animal', 'haze'];
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      startIgnition(pick().id, {
        kind: kind,
        intensity: 0.8 + Math.random() * 0.4,
        radiusM: kind === 'haze' ? 300 : 0,
        durationMs: (8 + Math.random() * 8) * 60e3
      });
    }
  }

  /* ---- Tick -------------------------------------------------------------- */

  function step() {
    const now = Date.now();
    const cfg = FF.store.getConfig();
    net.tick++;
    net.lastStepAt = net.lastTickAt || now - 4000;
    net.lastTickAt = now;
    const date = new Date(now);
    const rand = Math.random;
    maybeSpontaneous(now);

    net.nodes.forEach(function (n) {
      /* Mesh reliability: occasional dropouts, then recovery. Deeper hops and
         low battery both make a node likelier to miss a transmission window. */
      const dropChance = 0.0016 * n.hops + (n.battery < 20 ? 0.01 : 0);
      if (n.status === 'online' && rand() < dropChance) {
        n.status = 'offline';
      } else if (n.status === 'offline' && rand() < 0.12) {
        n.status = 'online';
      }

      const solar = solarInput(date, n);
      n.solarW = solar;
      n.charging = solar > 0.35;
      /* Charge and draw are per hour, scaled by the real time since the last
         tick — a 4-second tick must not move the battery by a whole tick's
         worth of percent. */
      const dtHours = U.clamp((now - (net.lastStepAt || now - 4000)) / 3600e3, 0, 0.25);
      const draw = DRAW_PCT_PER_HOUR + (n.status === 'offline' ? 0.15 : 0);
      n.battery = U.round(U.clamp(n.battery + (solar * SOLAR_GAIN_PER_WH - draw) * dtHours, 2, 100), 1);

      if (n.status === 'offline') return;   // no packet => no new readings

      const b = baseline(date, n, net.weather.dryIndex);
      const ev = eventEffect(n, now);

      /* Smooth toward the baseline so trends look like sensor data, not noise. */
      const targetGas = b.gas + ev.gas;
      const targetTemp = b.temp + ev.temp;
      const targetHum = U.clamp(b.humidity + ev.hum, 4, 99);

      n.gas = U.round(U.clamp(U.lerp(n.gas, targetGas, 0.34) + (rand() - 0.5) * 11, 300, 3000), 1);
      n.temp = U.round(U.lerp(n.temp, targetTemp, 0.3) + (rand() - 0.5) * 0.5, 1);
      n.humidity = U.round(U.clamp(U.lerp(n.humidity, targetHum, 0.3) + (rand() - 0.5) * 1.1, 3, 99), 1);

      n.lastSeen = now;
      n.live.push({ t: now, gas: n.gas, temp: n.temp, hum: n.humidity, batt: n.battery, online: true });
      if (n.live.length > 180) n.live.shift();

      /* Rate of rise, in ppm/min — a fast climb is a fire signature even while
         the absolute reading is still under the threshold. Measured across a
         multi-minute window: tick-to-tick sensor noise on its own would clear
         any sane ppm/min threshold. */
      n.gasRate = gasRate(n, now);
      n.riskScore = computeRisk(n, cfg);

      /* Roll the hourly buffer forward. */
      const lastHist = n.hist[n.hist.length - 1];
      if (!lastHist || now - lastHist.t >= 3600e3) {
        n.hist.push({ t: now, gas: n.gas, temp: n.temp, hum: n.humidity, batt: n.battery, online: true });
        const keep = cfg.retention.telemetryHours + 1;
        if (n.hist.length > keep) n.hist.splice(0, n.hist.length - keep);
      }
    });

    /* Slow drift in the dryness index drives seasonal risk. */
    net.weather.dryIndex = U.round(U.clamp(net.weather.dryIndex + (Math.random() - 0.5) * 0.004, 0.15, 0.95), 3);
    net.ignitions = net.ignitions.filter(function (ig) { return now - ig.startedAt <= ig.durationMs; });
    return net;
  }

  const RATE_WINDOW_MS = 120e3;

  function gasRate(n, now) {
    let ref = null;
    for (let i = n.live.length - 1; i >= 0; i--) {
      /* Newest sample at least half a window old — enough separation that
         noise cancels, recent enough to catch a fast climb. */
      if (now - n.live[i].t >= RATE_WINDOW_MS * 0.5) { ref = n.live[i]; break; }
    }
    if (!ref) return 0;
    const dtMin = (now - ref.t) / 60000;
    if (dtMin <= 0) return 0;
    return U.round((n.gas - ref.gas) / dtMin, 1);
  }

  /* ---- Derived ----------------------------------------------------------- */

  /* Composite fire-risk score for a single node, 0-100. Gas carries the most
     weight (smoke is the earliest signal), then heat, then dryness. */
  function computeRisk(n, cfg) {
    const th = cfg.thresholds;
    const cal = n.calibration;
    const gasThr = th.gasPpm + cal.gasOffset;
    const tempThr = th.tempC + cal.tempOffset;
    const humThr = th.humidityPct + cal.humidityOffset;

    const gasComp = U.clamp((n.gas - 430) / Math.max(1, gasThr - 430), 0, 1.35);
    const tempComp = U.clamp((n.temp - 26) / Math.max(1, tempThr - 26), 0, 1.3);
    const humComp = U.clamp((58 - n.humidity) / Math.max(1, 58 - humThr), 0, 1.25);
    const rateComp = U.clamp(n.gasRate / Math.max(1, th.gasRatePpmPerMin), 0, 1);

    const score = 100 * (0.44 * gasComp + 0.26 * tempComp + 0.18 * humComp + 0.12 * rateComp);
    return U.round(U.clamp(score, 0, 100), 1);
  }

  /* Which metrics are past threshold right now, after per-node calibration. */
  function breaches(n, cfg) {
    const th = cfg.thresholds;
    const cal = n.calibration;
    const out = [];
    if (n.gas >= th.gasPpm + cal.gasOffset) out.push('gas');
    if (n.gasRate >= th.gasRatePpmPerMin) out.push('gas_rate');
    if (n.temp >= th.tempC + cal.tempOffset) out.push('temp');
    if (n.humidity <= th.humidityPct + cal.humidityOffset) out.push('humidity');
    return out;
  }

  /* Combustion products are the primary signal: a hot, dry afternoon crosses
     the temperature and humidity thresholds across the whole range without a
     fire anywhere, so heat and dryness only ever raise the confidence of a gas
     breach — they never open an alert on their own. */
  function isTriggering(breached) {
    return breached.indexOf('gas') >= 0 || breached.indexOf('gas_rate') >= 0;
  }

  function refreshStatuses() {
    const cfg = FF.store.getConfig();
    const cut = Date.now() - cfg.health.offlineAfterMin * 60e3;
    net.nodes.forEach(function (n) {
      if (n.lastSeen < cut) n.status = 'offline';
    });
  }

  function byId(id) { return net.nodes.filter(function (n) { return n.id === id; })[0] || null; }
  function gatewayById(id) { return net.gateways.filter(function (g) { return g.id === id; })[0] || null; }
  function nodes() { return net.nodes; }
  function gateways() { return net.gateways; }
  function weather() { return net.weather; }

  /* Merge hourly + live telemetry into one series for charting. */
  function series(node, hours, field) {
    const cut = Date.now() - hours * 3600e3;
    const pts = node.hist.filter(function (h) { return h.t >= cut; })
      .concat(node.live.filter(function (l) { return l.t >= cut; }));
    pts.sort(function (a, b) { return a.t - b.t; });
    /* Downsample so a long window stays cheap to draw. */
    const maxPts = 180;
    if (pts.length <= maxPts) return pts.map(function (p) { return { t: p.t, v: p[field] }; });
    const stride = pts.length / maxPts;
    const out = [];
    for (let i = 0; i < maxPts; i++) out.push(pts[Math.floor(i * stride)]);
    out.push(pts[pts.length - 1]);
    return out.map(function (p) { return { t: p.t, v: p[field] }; });
  }

  FF.network = {
    build: build, step: step, refreshStatuses: refreshStatuses,
    nodes: nodes, gateways: gateways, byId: byId, gatewayById: gatewayById,
    distanceM: distanceM, computeRisk: computeRisk, breaches: breaches, isTriggering: isTriggering,
    startIgnition: startIgnition, clearIgnitions: clearIgnitions,
    weather: weather, series: series, state: net
  };
})(window.FF = window.FF || {});
