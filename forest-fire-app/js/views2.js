/* Views: Node Monitoring, Node Detail, Historical Reporting, Settings. */
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

  /* ============================ Node monitoring =========================== */

  const nodeState = { query: '', sort: 'risk', filter: 'all' };

  FF.views.nodes = {
    title: 'Node monitoring',
    crumb: 'Charging state, last communication and environmental trends',
    live: true,
    render: function (root) {
      const cfg = store.getConfig();
      let list = net.nodes().slice();

      if (nodeState.filter === 'offline') list = list.filter(function (n) { return n.status !== 'online'; });
      if (nodeState.filter === 'lowbatt') list = list.filter(function (n) { return n.battery <= cfg.health.batteryLowPct; });
      if (nodeState.filter === 'alerting') {
        const ids = {};
        store.openAlerts().forEach(function (a) { ids[a.nodeId] = true; });
        list = list.filter(function (n) { return ids[n.id]; });
      }
      if (nodeState.query) {
        const q = nodeState.query.toLowerCase();
        list = list.filter(function (n) {
          return (n.id + ' ' + n.label + ' ' + n.sector + ' ' + n.gatewayId).toLowerCase().indexOf(q) >= 0;
        });
      }
      const sorters = {
        risk: function (a, b) { return b.riskScore - a.riskScore; },
        battery: function (a, b) { return a.battery - b.battery; },
        lastSeen: function (a, b) { return a.lastSeen - b.lastSeen; },
        id: function (a, b) { return a.id.localeCompare(b.id); }
      };
      list.sort(sorters[nodeState.sort] || sorters.risk);

      const s = FF.views.summary();

      root.innerHTML =
        '<div class="grid g-4" style="margin-bottom:14px">' +
          miniStat('Reporting', s.online + ' / ' + s.total, 'Nodes transmitting inside the ' +
            cfg.health.offlineAfterMin + '-minute window') +
          miniStat('Charging now', s.charging + ' / ' + s.total, 'Solar input above 0.35 W') +
          miniStat('Mean battery', s.meanBattery + '%', s.lowBattery.length + ' below ' + cfg.health.batteryLowPct + '%') +
          miniStat('Mesh gateways', net.gateways().length, 'One per ' + C.DEPLOYMENT.gatewayEvery + ' grids with backhaul') +
        '</div>' +
        '<div class="card">' +
          '<div class="toolbar">' +
            '<input type="search" id="node-q" placeholder="Search node, sector or gateway…" value="' + esc(nodeState.query) + '">' +
            '<div class="seg">' +
              ['all', 'alerting', 'offline', 'lowbatt'].map(function (f) {
                const label = { all: 'All', alerting: 'Alerting', offline: 'Offline', lowbatt: 'Low battery' }[f];
                return '<button data-filter="' + f + '" class="' + (nodeState.filter === f ? 'active' : '') + '">' + label + '</button>';
              }).join('') +
            '</div>' +
            '<span class="spacer"></span>' +
            '<select id="node-sort" style="width:auto">' +
              [['risk', 'Sort: risk'], ['battery', 'Sort: battery'], ['lastSeen', 'Sort: last seen'], ['id', 'Sort: node ID']]
                .map(function (o) {
                  return '<option value="' + o[0] + '"' + (nodeState.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
                }).join('') +
            '</select>' +
            '<button class="btn btn-sm" id="node-export">Export CSV</button>' +
          '</div>' +
          (list.length ? '<div class="table-wrap"><table><thead><tr>' +
            '<th>Node</th><th>Status</th><th>Risk</th><th class="num">Gas ppm</th><th class="num">Temp °C</th>' +
            '<th class="num">RH %</th><th>Battery</th><th>Charging</th><th>Last comms</th><th>Link</th><th>24 h gas</th>' +
            '</tr></thead><tbody>' +
            list.map(function (n) {
              const alert = store.openAlertForNode(n.id);
              return '<tr class="clickable" data-node="' + esc(n.id) + '">' +
                '<td><strong>' + esc(n.id) + '</strong>' +
                  '<div style="font-size:11px;color:var(--text-3)">' + esc(n.sector) + '</div></td>' +
                '<td>' + (n.status === 'online'
                  ? '<span class="badge ok">online</span>' : '<span class="badge muted">offline</span>') +
                  (alert ? ' ' + UI.tierBadge(alert.tier) : '') + '</td>' +
                '<td>' + UI.riskBadge(n) + '</td>' +
                '<td class="num">' + esc(n.gas) + '</td>' +
                '<td class="num">' + esc(n.temp) + '</td>' +
                '<td class="num">' + esc(n.humidity) + '</td>' +
                '<td>' + UI.batteryCell(n) + '</td>' +
                '<td>' + (n.charging
                  ? '<span class="badge warn">☀ ' + n.solarW + ' W</span>'
                  : '<span class="badge muted">discharging</span>') + '</td>' +
                '<td style="white-space:nowrap;color:var(--text-2)">' + esc(U.fmtAgo(n.lastSeen)) + '</td>' +
                '<td style="white-space:nowrap;font-family:var(--mono);font-size:11.5px;color:var(--text-3)">' +
                  esc(n.rssi) + ' dBm · ' + n.hops + 'h</td>' +
                '<td>' + charts.sparkline(net.series(n, 24, 'gas'), {
                  color: C.riskLevel(n.riskScore).color, width: 110, height: 26 }) + '</td>' +
                '</tr>';
            }).join('') + '</tbody></table></div>'
            : '<div class="empty"><span class="big">🔍</span>No nodes match this filter.</div>') +
        '</div>';

      const q = root.querySelector('#node-q');
      q.addEventListener('input', function () {
        nodeState.query = q.value;
        FF.views.nodes.render(root);
        const nq = root.querySelector('#node-q');
        nq.focus();
        nq.setSelectionRange(nq.value.length, nq.value.length);
      });
      root.querySelector('#node-sort').addEventListener('change', function (e) {
        nodeState.sort = e.target.value;
        FF.views.nodes.render(root);
      });
      root.querySelectorAll('[data-filter]').forEach(function (b) {
        b.addEventListener('click', function () {
          nodeState.filter = b.getAttribute('data-filter');
          FF.views.nodes.render(root);
        });
      });
      root.querySelectorAll('tr[data-node]').forEach(function (tr) {
        tr.addEventListener('click', function () { location.hash = '#/nodes/' + tr.getAttribute('data-node'); });
      });
      root.querySelector('#node-export').addEventListener('click', function () {
        const rows = [['node_id', 'sector', 'lat', 'lng', 'elevation_m', 'status', 'risk_score', 'gas_ppm', 'temp_c',
                       'humidity_pct', 'battery_pct', 'charging', 'solar_w', 'last_seen', 'gateway', 'hops', 'rssi_dbm',
                       'firmware', 'gas_offset_ppm']];
        net.nodes().forEach(function (n) {
          rows.push([n.id, n.sector, n.lat, n.lng, n.elevM, n.status, n.riskScore, n.gas, n.temp, n.humidity,
            n.battery, n.charging, n.solarW, new Date(n.lastSeen).toISOString(), n.gatewayId, n.hops, n.rssi,
            n.firmware, n.calibration.gasOffset]);
        });
        U.downloadFile('node-roster-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv', U.toCsv(rows));
      });
    }
  };

  function miniStat(label, value, foot) {
    return '<div class="card stat"><div class="label">' + esc(label) + '</div>' +
      '<div class="value" style="font-size:22px">' + value + '</div>' +
      '<div class="foot">' + esc(foot) + '</div></div>';
  }

  /* ============================== Node detail ============================= */

  const detailState = { window: 24 };

  FF.views.node = {
    title: 'Node detail',
    crumb: '',
    live: true,
    render: function (root, params) {
      const n = net.byId(params.id);
      if (!n) {
        root.innerHTML = '<div class="card"><div class="empty"><span class="big">❓</span>Unknown node ' +
          esc(params.id) + '. <a href="#/nodes">Back to node monitoring</a></div></div>';
        return;
      }
      const cfg = store.getConfig();
      const alert = store.openAlertForNode(n.id);
      const hrs = detailState.window;
      const gw = net.gatewayById(n.gatewayId);
      const nodeFeedback = store.feedback().filter(function (f) { return f.nodeId === n.id; })
        .sort(function (a, b) { return b.taggedAt - a.taggedAt; });
      const nodeAlerts = store.alerts().filter(function (a) { return a.nodeId === n.id; })
        .sort(function (a, b) { return b.createdAt - a.createdAt; });
      const tuning = FF.alerts.tuningFor(n.id);

      root.innerHTML =
        '<div class="toolbar">' +
          '<a class="btn btn-sm" href="#/nodes">← All nodes</a>' +
          '<h2 style="font-size:16px;margin-left:6px">' + esc(n.label) + '</h2>' +
          UI.riskBadge(n, 'risk') +
          (n.status === 'online' ? '<span class="badge ok">online</span>' : '<span class="badge muted">offline</span>') +
          (alert ? UI.tierBadge(alert.tier, 'alert') : '') +
          '<span class="spacer"></span>' +
          '<div class="seg">' +
            [6, 24, 72].map(function (h) {
              return '<button data-win="' + h + '" class="' + (hrs === h ? 'active' : '') + '">' + h + ' h</button>';
            }).join('') +
          '</div>' +
          (alert ? '<button class="btn btn-sm btn-primary" data-ack="' + esc(alert.id) + '">Acknowledge alert</button>' : '') +
        '</div>' +

        '<div class="grid g-4" style="margin-bottom:14px">' +
          miniStat('Gas (MQ135)', n.gas + '<small> ppm</small>',
            'Threshold ' + (cfg.thresholds.gasPpm + n.calibration.gasOffset) + ' ppm · rise ' + n.gasRate + ' ppm/min') +
          miniStat('Temperature', n.temp + '<small> °C</small>', 'Threshold ' + cfg.thresholds.tempC + ' °C at canopy') +
          miniStat('Humidity', n.humidity + '<small> %</small>', 'Alerts below ' + cfg.thresholds.humidityPct + '%') +
          miniStat('Battery', n.battery + '<small> %</small>',
            (n.charging ? '☀ charging at ' + n.solarW + ' W' : '🌙 discharging') +
            ' · panel ' + Math.round(n.panelHealth * 100) + '%') +
        '</div>' +

        '<div class="grid g-2-1" style="margin-bottom:14px">' +
          '<div class="card">' +
            '<div class="card-head"><h3>Gas trend</h3><span class="spacer"></span>' +
            '<span class="sub">MQ135 CO₂-equivalent, ' + hrs + ' h</span></div>' +
            charts.lineChart([{ name: 'Gas', color: '#ff8a3d', points: net.series(n, hrs, 'gas') }],
              { height: 200, thresholds: [{ v: cfg.thresholds.gasPpm + n.calibration.gasOffset, label: 'trigger', color: '#ff4d4d' }] }) +
          '</div>' +
          '<div class="card">' +
            '<div class="card-head"><h3>Link &amp; hardware</h3></div>' +
            '<dl class="kv">' +
              '<dt>Gateway</dt><dd>' + esc(n.gatewayId) + '</dd>' +
              '<dt>Backhaul</dt><dd>' + esc(gw ? gw.backhaul : '—') + '</dd>' +
              '<dt>Mesh hops</dt><dd>' + n.hops + '</dd>' +
              '<dt>RSSI</dt><dd>' + n.rssi + ' dBm</dd>' +
              '<dt>Last comms</dt><dd>' + esc(U.fmtAgo(n.lastSeen)) + '</dd>' +
              '<dt>Position</dt><dd>' + n.lat + ', ' + n.lng + '</dd>' +
              '<dt>Elevation</dt><dd>' + n.elevM + ' m</dd>' +
              '<dt>Canopy height</dt><dd>' + n.canopyM + ' m</dd>' +
              '<dt>Firmware</dt><dd>' + esc(n.firmware) + '</dd>' +
              '<dt>Installed</dt><dd>' + esc(U.fmtDate(n.installedAt)) + '</dd>' +
              '<dt>Panel health</dt><dd>' + Math.round(n.panelHealth * 100) + '%</dd>' +
            '</dl>' +
          '</div>' +
        '</div>' +

        '<div class="grid g-2" style="margin-bottom:14px">' +
          '<div class="card"><div class="card-head"><h3>Temperature &amp; humidity</h3></div>' +
            charts.lineChart([
              { name: 'Temp °C', color: '#ff4d4d', points: net.series(n, hrs, 'temp'), fill: false },
              { name: 'Humidity %', color: '#4c9aff', points: net.series(n, hrs, 'hum'), fill: false }
            ], { height: 200 }) +
            '<div class="legend" style="margin-top:8px">' +
              '<span><i style="background:#ff4d4d"></i>Temperature °C</span>' +
              '<span><i style="background:#4c9aff"></i>Relative humidity %</span></div>' +
          '</div>' +
          '<div class="card"><div class="card-head"><h3>Battery &amp; charging</h3></div>' +
            charts.lineChart([{ name: 'Battery %', color: '#3fbf7f', points: net.series(n, hrs, 'batt') }],
              { height: 200, min: 0, max: 100,
                thresholds: [{ v: cfg.health.batteryLowPct, label: 'low', color: '#ffc748' }] }) +
            '<div class="note" style="margin-top:10px">Solar-charged: the daily saw-tooth is normal. A falling ' +
            'baseline across days means panel shading or a failing cell.</div>' +
          '</div>' +
        '</div>' +

        '<div class="grid g-2">' +
          '<div class="card"><div class="card-head"><h3>Alert history for this node</h3></div>' +
            (nodeAlerts.length ? '<div class="table-wrap" style="max-height:280px"><table><thead><tr>' +
              '<th>Raised</th><th>Tier</th><th class="num">Conf.</th><th>Outcome</th></tr></thead><tbody>' +
              nodeAlerts.slice(0, 40).map(function (a) {
                const tag = C.OUTCOME_TAGS.filter(function (t) { return t.id === a.outcome; })[0];
                return '<tr><td>' + esc(U.fmtDateTime(a.createdAt)) + '</td><td>' + UI.tierBadge(a.tier) + '</td>' +
                  '<td class="num">' + esc(a.confidence) + '</td><td>' +
                  (a.status === 'open' ? '<span class="badge warn">open</span>' : esc(tag ? tag.label : '—')) + '</td></tr>';
              }).join('') + '</tbody></table></div>'
              : '<div class="empty">No alerts recorded for this node.</div>') +
          '</div>' +
          '<div class="card"><div class="card-head"><h3>Feedback-driven calibration</h3></div>' +
            '<dl class="kv">' +
              '<dt>Labelled outcomes</dt><dd>' + tuning.samples + '</dd>' +
              '<dt>Confirmed fires</dt><dd>' + tuning.counts.confirmed_fire + '</dd>' +
              '<dt>Sensor faults</dt><dd>' + tuning.counts.sensor_fault + '</dd>' +
              '<dt>Animal activity</dt><dd>' + tuning.counts.animal_activity + '</dd>' +
              '<dt>Dust / haze</dt><dd>' + tuning.counts.dust_haze + '</dd>' +
              '<dt>Gas offset applied</dt><dd style="color:' + (n.calibration.gasOffset ? 'var(--accent-2)' : 'var(--text-2)') + '">' +
                signed(n.calibration.gasOffset) + ' ppm</dd>' +
              '<dt>Temp offset</dt><dd>' + signed(n.calibration.tempOffset) + ' °C</dd>' +
              '<dt>Effective gas trigger</dt><dd>' + (cfg.thresholds.gasPpm + n.calibration.gasOffset) + ' ppm</dd>' +
            '</dl>' +
            '<div class="note" style="margin-top:12px">Non-fire outcomes raise this node\'s own trigger points; ' +
            'confirmed fires pull them back toward the network default. Tuning is per node, so one drifting MQ135 ' +
            'never desensitises the rest of the mesh.</div>' +
            (nodeFeedback.length ? '<div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">' +
              nodeFeedback.slice(0, 8).map(function (f) {
                const tag = C.OUTCOME_TAGS.filter(function (t) { return t.id === f.outcome; })[0];
                return '<span class="chip" title="' + esc(U.fmtDate(f.taggedAt)) + '">' +
                  esc(tag ? tag.label : f.outcome) + '</span>';
              }).join('') + '</div>' : '') +
          '</div>' +
        '</div>';

      root.querySelectorAll('[data-win]').forEach(function (b) {
        b.addEventListener('click', function () {
          detailState.window = +b.getAttribute('data-win');
          FF.views.node.render(root, params);
        });
      });
      FF.views.wireAlertRows(root);
    }
  };

  /* ========================= Historical reporting ========================== */

  const reportState = { months: 12 };

  FF.views.reports = {
    title: 'Historical reporting',
    crumb: 'Fire incidents over time, response performance and false-positive trend',
    render: function (root) {
      const months = reportState.months;
      const cutoff = Date.now() - months * 30.44 * 864e5;
      const incidents = store.incidents().filter(function (i) { return i.at >= cutoff; })
        .sort(function (a, b) { return b.at - a.at; });
      const feedback = store.feedback().filter(function (f) { return f.taggedAt >= cutoff; });

      /* Monthly buckets. */
      const buckets = {};
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        buckets[key] = { label: d.toLocaleDateString([], { month: 'short' }) +
          (d.getMonth() === 0 || i === months - 1 ? " '" + String(d.getFullYear()).slice(2) : ''),
          fires: 0, clustered: 0, alerts: 0, falsePos: 0 };
      }
      function keyOf(t) {
        const d = new Date(t);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      }
      incidents.forEach(function (i) {
        const b = buckets[keyOf(i.at)];
        if (!b) return;
        b.fires++;
        if (i.clustered) b.clustered++;
      });
      feedback.forEach(function (f) {
        const b = buckets[keyOf(f.taggedAt)];
        if (!b) return;
        b.alerts++;
        if (!f.truePositive) b.falsePos++;
      });

      const order = Object.keys(buckets);
      const truePos = feedback.filter(function (f) { return f.truePositive; }).length;
      const fpRate = feedback.length ? U.round(((feedback.length - truePos) / feedback.length) * 100, 1) : 0;
      const responses = feedback.map(function (f) { return f.responseMs; }).filter(function (v) { return v > 0; });
      const meanResp = responses.length ? U.fmtDur(U.mean(responses)) : '—';
      const areaBurned = U.round(U.sum(incidents.map(function (i) { return i.areaHa || 0; })), 1);
      const clusteredShare = incidents.length
        ? U.round((incidents.filter(function (i) { return i.clustered; }).length / incidents.length) * 100, 0) : 0;

      const bySector = {};
      incidents.forEach(function (i) { bySector[i.sector] = (bySector[i.sector] || 0) + 1; });
      const byNode = {};
      feedback.forEach(function (f) {
        byNode[f.nodeId] = byNode[f.nodeId] || { total: 0, fp: 0 };
        byNode[f.nodeId].total++;
        if (!f.truePositive) byNode[f.nodeId].fp++;
      });
      const worstNodes = Object.keys(byNode).map(function (id) {
        return { id: id, total: byNode[id].total, fp: byNode[id].fp };
      }).sort(function (a, b) { return b.fp - a.fp; }).slice(0, 8);

      const tierCounts = { critical: 0, high: 0, moderate: 0, low: 0 };
      feedback.forEach(function (f) { if (tierCounts[f.tier] !== undefined) tierCounts[f.tier]++; });

      /* Confidence-tier reliability: does a higher tier really mean a real fire? */
      const reliability = C.TIERS.slice().reverse().map(function (t) {
        const set = feedback.filter(function (f) { return f.tier === t; });
        const tp = set.filter(function (f) { return f.truePositive; }).length;
        return { tier: t, n: set.length, rate: set.length ? U.round((tp / set.length) * 100, 0) : 0 };
      });

      root.innerHTML =
        '<div class="toolbar">' +
          '<div class="seg">' +
            [6, 12, 24].map(function (m) {
              return '<button data-months="' + m + '" class="' + (months === m ? 'active' : '') + '">' +
                m + ' months</button>';
            }).join('') +
          '</div>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-sm" id="rep-export">Export incidents CSV</button>' +
        '</div>' +

        '<div class="grid g-4" style="margin-bottom:14px">' +
          miniStat('Confirmed fires', incidents.length, 'Ground-verified incidents in the last ' + months + ' months') +
          miniStat('Area affected', areaBurned + '<small> ha</small>', 'Sum of recorded incident extents') +
          miniStat('False-positive rate', fpRate + '<small>%</small>',
            (feedback.length - truePos) + ' of ' + feedback.length + ' tagged alerts were not fires') +
          miniStat('Mean time to acknowledge', meanResp, 'From alert raised to ranger acknowledgement') +
        '</div>' +

        '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3>Fire incidents over time</h3><span class="spacer"></span>' +
          '<span class="sub">' + clusteredShare + '% were cluster-detected</span></div>' +
          charts.stackedBars(order.map(function (k) {
            const b = buckets[k];
            return { label: b.label, parts: [
              { name: 'Cluster-detected', value: b.clustered, color: '#ff4d4d' },
              { name: 'Single-node', value: b.fires - b.clustered, color: '#ff8a3d' }
            ] };
          }), { height: 220 }) +
          '<div class="legend" style="margin-top:10px">' +
            '<span><i style="background:#ff4d4d"></i>Cluster-detected fire</span>' +
            '<span><i style="background:#ff8a3d"></i>Single-node detection</span></div>' +
        '</div>' +

        '<div class="grid g-2" style="margin-bottom:14px">' +
          '<div class="card"><div class="card-head"><h3>Alert volume vs false positives</h3></div>' +
            charts.stackedBars(order.map(function (k) {
              const b = buckets[k];
              return { label: b.label, parts: [
                { name: 'True positive', value: b.alerts - b.falsePos, color: '#3fbf7f' },
                { name: 'False positive', value: b.falsePos, color: '#64748b' }
              ] };
            }), { height: 210 }) +
            '<div class="legend" style="margin-top:10px">' +
              '<span><i style="background:#3fbf7f"></i>True positive</span>' +
              '<span><i style="background:#64748b"></i>False positive</span></div>' +
          '</div>' +
          '<div class="card"><div class="card-head"><h3>Does confidence tier predict a real fire?</h3></div>' +
            charts.hBars(reliability.map(function (r) {
              return { label: r.tier + ' (' + r.n + ' alerts)', value: r.rate, display: r.rate + '% real',
                       color: C.tierColor(r.tier) };
            })) +
            '<div class="note" style="margin-top:14px">Cluster and multi-metric alerts land in the higher tiers, ' +
            'and those tiers are where the confirmed fires are. A tier whose hit rate drifts down is the signal to ' +
            'retune weights in Settings.</div>' +
          '</div>' +
        '</div>' +

        '<div class="grid g-2">' +
          '<div class="card"><div class="card-head"><h3>Incidents by sector</h3></div>' +
            (Object.keys(bySector).length ? charts.hBars(Object.keys(bySector).map(function (k) {
              return { label: k, value: bySector[k], color: '#ff8a3d' };
            })) : '<div class="empty">No incidents in this window.</div>') +
            '<div class="card-head" style="margin-top:20px"><h3>Nodes generating most false positives</h3></div>' +
            (worstNodes.length ? '<table><thead><tr><th>Node</th><th class="num">Alerts</th>' +
              '<th class="num">False</th><th class="num">Gas offset</th></tr></thead><tbody>' +
              worstNodes.map(function (w) {
                const node = net.byId(w.id);
                return '<tr><td><a href="#/nodes/' + esc(w.id) + '">' + esc(w.id) + '</a></td>' +
                  '<td class="num">' + w.total + '</td><td class="num">' + w.fp + '</td>' +
                  '<td class="num">' + (node ? signed(node.calibration.gasOffset) + ' ppm' : '—') + '</td></tr>';
              }).join('') + '</tbody></table>' : '<div class="empty">No labelled alerts yet.</div>') +
          '</div>' +
          '<div class="card"><div class="card-head"><h3>Incident register</h3><span class="sub">' +
            incidents.length + ' records</span></div>' +
            (incidents.length ? '<div class="table-wrap" style="max-height:430px"><table><thead><tr>' +
              '<th>Date</th><th>Node</th><th>Sector</th><th>Detection</th><th class="num">Conf.</th>' +
              '<th class="num">Area ha</th><th class="num">Response</th></tr></thead><tbody>' +
              incidents.slice(0, 250).map(function (i) {
                return '<tr><td style="white-space:nowrap">' + esc(U.fmtDate(i.at)) + '</td>' +
                  '<td style="white-space:nowrap"><a href="#/nodes/' + esc(i.nodeId) + '">' + esc(i.nodeId) + '</a></td>' +
                  '<td style="color:var(--text-2)">' + esc(i.sector) + '</td>' +
                  '<td>' + (i.clustered ? '<span class="badge cluster">cluster</span>'
                                        : '<span class="badge muted">single node</span>') + '</td>' +
                  '<td class="num">' + esc(i.confidence) + '</td>' +
                  '<td class="num">' + esc(i.areaHa !== undefined ? i.areaHa : '—') + '</td>' +
                  '<td class="num">' + esc(i.responseMs ? U.fmtDur(i.responseMs) : '—') + '</td></tr>';
              }).join('') + '</tbody></table></div>'
              : '<div class="empty"><span class="big">🌲</span>No confirmed fires in this window.</div>') +
          '</div>' +
        '</div>';

      root.querySelectorAll('[data-months]').forEach(function (b) {
        b.addEventListener('click', function () {
          reportState.months = +b.getAttribute('data-months');
          FF.views.reports.render(root);
        });
      });
      root.querySelector('#rep-export').addEventListener('click', function () {
        const rows = [['incident_id', 'date', 'node', 'sector', 'lat', 'lng', 'tier', 'confidence',
                       'cluster_detected', 'area_ha', 'response_seconds']];
        incidents.forEach(function (i) {
          rows.push([i.id, new Date(i.at).toISOString(), i.nodeId, i.sector, i.lat, i.lng, i.tier, i.confidence,
            i.clustered ? 'yes' : 'no', i.areaHa !== undefined ? i.areaHa : '',
            i.responseMs ? Math.round(i.responseMs / 1000) : '']);
        });
        U.downloadFile('fire-incidents-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv', U.toCsv(rows));
      });
    }
  };

  /* ================================ Settings ============================== */

  FF.views.settings = {
    title: 'Settings',
    crumb: 'Thresholds, confidence weights, escalation policy and retention — per deployment',
    render: function (root) {
      const cfg = store.getConfig();
      const suggestion = FF.alerts.globalTuningSuggestion();

      root.innerHTML =
        '<div class="grid g-2">' +

          '<div class="card"><div class="card-head"><h3>Sensor thresholds</h3>' +
            '<span class="sub">' + esc(cfg.regionName) + '</span></div>' +
            numField('thresholds.gasPpm', 'Gas — MQ135 CO₂-equivalent (ppm)', cfg.thresholds.gasPpm, 1) +
            numField('thresholds.gasRatePpmPerMin', 'Gas rate of rise (ppm/min)', cfg.thresholds.gasRatePpmPerMin, 1) +
            numField('thresholds.tempC', 'Temperature (°C, canopy)', cfg.thresholds.tempC, 0.5) +
            numField('thresholds.humidityPct', 'Humidity floor (%, alert below)', cfg.thresholds.humidityPct, 1) +
            (suggestion && suggestion.changed
              ? '<div class="note" style="border-left-color:var(--accent);margin-top:12px">' +
                '<strong style="color:var(--text)">Tuning suggestion from ' + suggestion.labels + ' labels</strong><br>' +
                'False positives peak around ' + suggestion.meanFalsePeakGas + ' ppm; confirmed fires around ' +
                (suggestion.meanTruePeakGas || '—') + ' ppm. Suggested gas threshold <strong>' +
                suggestion.suggestedGas + ' ppm</strong> (currently ' + suggestion.currentGas + ').' +
                '<div style="margin-top:9px"><button class="btn btn-sm btn-primary" id="apply-suggestion">' +
                'Apply suggested threshold</button></div></div>'
              : '<div class="note" style="margin-top:12px">Thresholds are compared per node after feedback-driven ' +
                'calibration offsets. ' + (suggestion
                  ? 'Current false-positive rate ' + suggestion.falsePositiveRate + '% across ' + suggestion.labels + ' labels.'
                  : 'Tag more alerts to unlock a network-wide tuning suggestion.') + '</div>') +
          '</div>' +

          '<div class="card"><div class="card-head"><h3>Confidence scoring</h3>' +
            '<span class="sub">weights total ' +
            (cfg.confidence.wMetrics + cfg.confidence.wNeighbors + cfg.confidence.wSeverity + cfg.confidence.wPersistence) +
            '</span></div>' +
            numField('confidence.wMetrics', 'Weight — metrics breached simultaneously', cfg.confidence.wMetrics, 1) +
            numField('confidence.wNeighbors', 'Weight — neighbouring-node corroboration', cfg.confidence.wNeighbors, 1) +
            numField('confidence.wSeverity', 'Weight — exceedance severity', cfg.confidence.wSeverity, 1) +
            numField('confidence.wPersistence', 'Weight — persistence across samples', cfg.confidence.wPersistence, 1) +
            '<div class="grid g-3" style="gap:10px">' +
              numField('confidence.tiers.critical', 'Critical at', cfg.confidence.tiers.critical, 1) +
              numField('confidence.tiers.high', 'High at', cfg.confidence.tiers.high, 1) +
              numField('confidence.tiers.moderate', 'Moderate at', cfg.confidence.tiers.moderate, 1) +
            '</div>' +
            '<div class="note">score = w<sub>metrics</sub>·(breached/3) + w<sub>neighbours</sub>·(corroborating/' +
            cfg.confidence.neighborsForFull + ') + w<sub>severity</sub>·exceedance + w<sub>persistence</sub>·(samples/' +
            cfg.confidence.persistenceSamples + ')</div>' +
          '</div>' +

          '<div class="card"><div class="card-head"><h3>Neighbour correlation</h3>' +
            '<span class="sub">cluster alerts</span></div>' +
            numField('correlation.radiusM', 'Correlation radius (m)', cfg.correlation.radiusM, 10) +
            numField('correlation.windowMin', 'Simultaneity window (minutes)', cfg.correlation.windowMin, 1) +
            numField('correlation.minClusterSize', 'Minimum nodes for a cluster', cfg.correlation.minClusterSize, 1) +
            numField('confidence.neighborsForFull', 'Neighbours for full corroboration credit',
              cfg.confidence.neighborsForFull, 1) +
            numField('confidence.persistenceSamples', 'Samples for full persistence credit',
              cfg.confidence.persistenceSamples, 1) +
            '<div class="note">At ' + C.DEPLOYMENT.spacingM + ' m grid spacing, a ' + cfg.correlation.radiusM +
            ' m radius captures the four orthogonal neighbours and the diagonals at ' +
            Math.round(C.DEPLOYMENT.spacingM * 1.414) + ' m.</div>' +
          '</div>' +

          '<div class="card"><div class="card-head"><h3>Escalation policy</h3>' +
            '<span class="sub">per deployment</span></div>' +
            '<div class="field"><label>Escalation</label>' +
              '<select data-path="escalation.enabled">' +
                '<option value="true"' + (cfg.escalation.enabled ? ' selected' : '') + '>Enabled</option>' +
                '<option value="false"' + (!cfg.escalation.enabled ? ' selected' : '') + '>Disabled</option>' +
              '</select></div>' +
            numField('escalation.timeoutMin', 'Timeout before escalation (minutes)', cfg.escalation.timeoutMin, 0.5) +
            numField('escalation.criticalTimeoutMin', 'Timeout for critical alerts (minutes)',
              cfg.escalation.criticalTimeoutMin, 0.5) +
            '<div class="field"><label>Minimum tier that escalates</label>' +
              '<select data-path="escalation.minTierToEscalate">' +
                C.TIERS.map(function (t) {
                  return '<option value="' + t + '"' + (cfg.escalation.minTierToEscalate === t ? ' selected' : '') +
                    '>' + t + '</option>';
                }).join('') +
              '</select></div>' +
            '<div class="field"><label>Channels</label>' +
              '<div style="display:flex;gap:14px;flex-wrap:wrap">' +
                ['push', 'sms', 'voice'].map(function (ch) {
                  return '<label style="display:flex;align-items:center;gap:7px;font-size:13px;text-transform:none;' +
                    'letter-spacing:0;color:var(--text-2)">' +
                    '<input type="checkbox" data-channel="' + ch + '"' +
                    (cfg.escalation.channels[ch] ? ' checked' : '') + ' style="width:auto"> ' +
                    { push: '📲 App push', sms: '💬 SMS gateway', voice: '📞 Voice call' }[ch] + '</label>';
                }).join('') +
              '</div></div>' +
            '<div class="field"><label>Escalation contacts (in order)</label>' +
              '<div id="contact-list">' + cfg.escalation.contacts.slice()
                .sort(function (a, b) { return a.order - b.order; })
                .map(function (c, i) {
                  return '<div style="display:flex;gap:8px;align-items:center;margin-bottom:7px">' +
                    '<span class="chip">' + (i + 1) + '</span>' +
                    '<input type="text" data-contact="' + esc(c.id) + '" data-field="name" value="' + esc(c.name) + '">' +
                    '<input type="text" data-contact="' + esc(c.id) + '" data-field="phone" value="' + esc(c.phone) +
                      '" style="max-width:150px">' +
                    '<select data-contact="' + esc(c.id) + '" data-field="channel" style="max-width:100px">' +
                      ['sms', 'voice', 'push'].map(function (ch) {
                        return '<option value="' + ch + '"' + (c.channel === ch ? ' selected' : '') + '>' + ch + '</option>';
                      }).join('') +
                    '</select>' +
                    '<button class="btn btn-sm btn-danger" data-remove-contact="' + esc(c.id) + '">✕</button>' +
                    '</div>';
                }).join('') + '</div>' +
              '<button class="btn btn-sm" id="add-contact">+ Add contact</button>' +
            '</div>' +
            '<div class="note">An unacknowledged alert at or above the minimum tier escalates to the next contact ' +
            'in this list each time the timeout elapses. Push notifications get missed in the field, so SMS and ' +
            'voice sit behind them.</div>' +
          '</div>' +

          '<div class="card"><div class="card-head"><h3>Retention</h3></div>' +
            numField('retention.alertHistoryDays', 'Alert history (days)', cfg.retention.alertHistoryDays, 1) +
            numField('retention.feedbackDatasetDays', 'Feedback-tagged dataset (days)',
              cfg.retention.feedbackDatasetDays, 1) +
            numField('retention.telemetryHours', 'Per-node telemetry buffer (hours)', cfg.retention.telemetryHours, 1) +
            '<div class="note">Labelled feedback outlives raw alert history on purpose — it is the training set for ' +
            'future threshold and model tuning. Open alerts are never pruned.</div>' +
            '<div class="card-head" style="margin-top:18px"><h3>Node health</h3></div>' +
            numField('health.offlineAfterMin', 'Mark offline after (minutes without a packet)',
              cfg.health.offlineAfterMin, 1) +
            numField('health.batteryLowPct', 'Battery low (%)', cfg.health.batteryLowPct, 1) +
            numField('health.batteryCriticalPct', 'Battery critical (%)', cfg.health.batteryCriticalPct, 1) +
          '</div>' +

          '<div class="card"><div class="card-head"><h3>Notifications</h3></div>' +
            '<div class="field"><label>Browser push</label>' +
              '<select data-path="notifications.browserPush">' +
                '<option value="true"' + (cfg.notifications.browserPush ? ' selected' : '') + '>Enabled</option>' +
                '<option value="false"' + (!cfg.notifications.browserPush ? ' selected' : '') + '>Disabled</option>' +
              '</select></div>' +
            '<div class="field"><label>Minimum tier to notify</label>' +
              '<select data-path="notifications.minTier">' +
                C.TIERS.map(function (t) {
                  return '<option value="' + t + '"' + (cfg.notifications.minTier === t ? ' selected' : '') +
                    '>' + t + '</option>';
                }).join('') +
              '</select></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
              '<button class="btn btn-sm" id="enable-push">Enable browser notifications</button>' +
              '<button class="btn btn-sm" id="test-push">Send test notification</button>' +
            '</div>' +
            '<div class="card-head" style="margin-top:20px"><h3>Data</h3></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
              '<button class="btn btn-sm" id="export-config">Export configuration</button>' +
              '<button class="btn btn-sm" id="reset-config">Reset to defaults</button>' +
              '<button class="btn btn-sm btn-danger" id="wipe">Clear all stored data</button>' +
            '</div>' +
            '<div class="note" style="margin-top:12px">Alerts, labelled outcomes and configuration live in this ' +
            'browser\'s local storage. Clearing wipes the console\'s history; the node roster rebuilds on reload.</div>' +
          '</div>' +

        '</div>';

      /* --- wiring --- */
      root.querySelectorAll('[data-path]').forEach(function (input) {
        input.addEventListener('change', function () {
          const path = input.getAttribute('data-path').split('.');
          let value = input.value;
          if (input.type === 'number') value = parseFloat(value);
          if (value === 'true') value = true;
          if (value === 'false') value = false;
          if (typeof value === 'number' && !isFinite(value)) return;
          const patch = {};
          let cur = patch;
          path.forEach(function (k, i) {
            if (i === path.length - 1) cur[k] = value;
            else { cur[k] = {}; cur = cur[k]; }
          });
          store.setConfig(patch);
          UI.toast({ kind: 'info', icon: '⚙', title: 'Setting saved',
            body: path.join('.') + ' → ' + value, ttl: 3200 });
          FF.app.refreshNav();
        });
      });

      root.querySelectorAll('[data-channel]').forEach(function (box) {
        box.addEventListener('change', function () {
          const patch = { escalation: { channels: {} } };
          patch.escalation.channels[box.getAttribute('data-channel')] = box.checked;
          store.setConfig(patch);
        });
      });

      root.querySelectorAll('[data-contact]').forEach(function (input) {
        input.addEventListener('change', function () {
          const id = input.getAttribute('data-contact');
          const field = input.getAttribute('data-field');
          const contacts = store.getConfig().escalation.contacts;
          const c = contacts.filter(function (x) { return x.id === id; })[0];
          if (!c) return;
          c[field] = input.value;
          store.save();
        });
      });

      root.querySelectorAll('[data-remove-contact]').forEach(function (b) {
        b.addEventListener('click', function () {
          const id = b.getAttribute('data-remove-contact');
          const cfg2 = store.getConfig();
          cfg2.escalation.contacts = cfg2.escalation.contacts.filter(function (c) { return c.id !== id; });
          store.save();
          FF.views.settings.render(root);
        });
      });

      root.querySelector('#add-contact').addEventListener('click', function () {
        const cfg2 = store.getConfig();
        cfg2.escalation.contacts.push({
          id: 'c' + Date.now().toString(36),
          name: 'New responder',
          phone: '+91 ',
          channel: 'sms',
          order: cfg2.escalation.contacts.length + 1
        });
        store.save();
        FF.views.settings.render(root);
      });

      const apply = root.querySelector('#apply-suggestion');
      if (apply) apply.addEventListener('click', function () {
        store.setConfig({ thresholds: { gasPpm: suggestion.suggestedGas } });
        UI.toast({ kind: 'info', icon: '🎛', title: 'Threshold retuned',
          body: 'Gas threshold set to ' + suggestion.suggestedGas + ' ppm from ' + suggestion.labels + ' labelled outcomes.' });
        FF.views.settings.render(root);
      });

      root.querySelector('#enable-push').addEventListener('click', function () {
        UI.requestPush().then(function (p) {
          UI.toast({ kind: p === 'granted' ? 'info' : 'high', icon: '📲',
            title: 'Browser notifications: ' + p,
            body: p === 'granted' ? 'Critical and high-confidence alerts will be pushed to this device.'
                                  : 'Escalation to SMS/voice still applies when push cannot be delivered.' });
        });
      });
      root.querySelector('#test-push').addEventListener('click', function () {
        UI.push('Test — Forest Fire Detection', 'Notification channel is working.', 'test');
        UI.toast({ kind: 'info', icon: '🔔', title: 'Test notification sent',
          body: 'If nothing appeared, browser notifications are blocked for this site.' });
      });
      root.querySelector('#export-config').addEventListener('click', function () {
        U.downloadFile('deployment-config-' + store.getConfig().deploymentId + '.json', 'application/json',
          JSON.stringify(store.getConfig(), null, 2));
      });
      root.querySelector('#reset-config').addEventListener('click', function () {
        store.resetConfig();
        UI.toast({ kind: 'info', icon: '↺', title: 'Configuration reset', body: 'Deployment defaults restored.' });
        FF.views.settings.render(root);
      });
      root.querySelector('#wipe').addEventListener('click', function () {
        UI.openModal({
          title: 'Clear all stored data?',
          body: '<div class="note" style="border-left-color:var(--crit)">This removes every alert, escalation ' +
            'record and labelled feedback outcome held in this browser, along with configuration overrides. ' +
            'It cannot be undone.</div>',
          footer: '<button class="btn" data-close>Cancel</button>' +
                  '<button class="btn btn-danger" id="wipe-confirm">Clear everything</button>',
          onMount: function (back) {
            back.querySelector('[data-close]').addEventListener('click', UI.closeModal);
            back.querySelector('#wipe-confirm').addEventListener('click', function () {
              store.clearAll();
              UI.closeModal();
              location.reload();
            });
          }
        });
      });
    }
  };

  /* Offsets read as deltas: "+90 ppm", "-60 ppm", "0 ppm" — never "+-60". */
  function signed(v) { return (v > 0 ? '+' : '') + U.round(v, 1); }

  function numField(path, label, value, step) {
    return '<div class="field"><label>' + esc(label) + '</label>' +
      '<input type="number" step="' + step + '" data-path="' + esc(path) + '" value="' + esc(value) + '"></div>';
  }
})(window.FF = window.FF || {});
