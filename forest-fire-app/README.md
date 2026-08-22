# Forest Fire Detection System — Ranger Console

A web application for a forest fire early-warning network: solar-powered,
canopy-mounted sensor nodes on a ~100 m grid, reporting gas (MQ135),
temperature and humidity over a LoRa mesh to gateways placed every few grids,
relayed to the ranger-facing console in this repository.

Built from `forestfireappspec.md`. Zero dependencies, zero build step — open
`index.html` in a browser, or serve the folder over any static host.

```bash
# from this directory
python3 -m http.server 8080     # then open http://localhost:8080
```

Demo sign-in: **`ranger` / `forest123`** (also `officer`, `watch`).

> The console ships with a telemetry simulator standing in for the gateway
> ingest API, so every screen has live, plausible data and the alerting,
> correlation and escalation paths can be exercised end to end. See
> [Replacing the simulator](#replacing-the-simulator).

---

## What's in it

| Spec section | Where it lives |
|---|---|
| 2.1 Login | `index.html` login screen, `js/store.js` session |
| 2.2 Dashboard — totals, online/offline, active alerts, battery health | `js/views.js` → `FF.views.dashboard` |
| 2.3 Live map — GPS positions, colour-coded risk | `js/map.js`, `FF.views.map` |
| 2.4 Alerts — push, history, acknowledge | `js/alerts.js`, `FF.views.alerts` |
| 2.4 False-positive feedback loop | `FF.alerts.acknowledge` → `tuningFor` / `applyTuning` |
| 2.4 Cluster alerts (neighbour correlation) | `FF.alerts.correlate` |
| 2.4 Escalation / timeout | `FF.alerts.checkEscalations` |
| 2.5 Node monitoring — charging, last comms, trends | `js/views2.js` → `FF.views.nodes`, `FF.views.node` |
| 2.6 Historical reporting — incidents over time | `FF.views.reports` |
| 3. Confidence tiering | `FF.alerts.scoreAlert` |
| 3. Feedback-loop storage | `FF.store.addFeedback` — outcome tag + raw readings |
| 3. Escalation configuration | `js/config.js` + Settings view, per deployment |

### Screens

- **Dashboard** — total / online / offline nodes, active alerts with cluster
  count, fleet battery health, 24 h network gas trend against threshold, risk
  by sector, and an attention list (flat batteries, dropped nodes,
  auto-calibrated sensors).
- **Live map** — every node at its GPS position on the 100 m grid, coloured by
  risk, with LoRa links to its gateway (dashed when the node has missed its
  window), pulsing halos on alerting nodes and a dashed ring around correlated
  clusters. Pan, zoom, click a node for its readings.
- **Alerts** — cluster alerts first, then single-node alerts, each with tier,
  confidence bar, breached metrics, neighbour corroboration and a live
  escalation countdown. Tabs for history, the escalation log and the labelled
  feedback dataset (exportable as CSV/JSON).
- **Node monitoring** — sortable, filterable roster with charging state, last
  communication, link quality and a 24 h gas sparkline; node detail adds gas,
  temperature/humidity and battery trend charts over 6/24/72 h, link and
  hardware facts, per-node alert history and its feedback-driven calibration.
- **Historical reporting** — confirmed fires per month split by cluster vs
  single-node detection, alert volume against false positives, whether each
  confidence tier actually predicts a real fire, incidents by sector, the nodes
  generating the most false positives, and the incident register.
- **Settings** — thresholds, confidence weights and tier cut-offs, correlation
  radius/window, the full escalation policy, retention periods, node-health
  limits and notification preferences.

---

## How the alerting works

### Confidence score

```
score = w_metrics     · (metrics breached / 3)
      + w_neighbors   · (corroborating neighbours / neighborsForFull)
      + w_severity    · (worst metric's exceedance, normalised)
      + w_persistence · (consecutive breaching samples / persistenceSamples)
```

Defaults: `35 / 40 / 15 / 10`. Tiers: **critical ≥ 80**, **high ≥ 60**,
**moderate ≥ 40**, else **low**. Every weight and cut-off is editable in
Settings and stored per deployment.

Corroboration carries the most weight deliberately: a neighbouring node
smelling the same smoke is the strongest evidence available that a spike is a
fire and not a failing sensor.

**Gas is the primary signal.** Heat and dryness never open an alert on their
own — a hot, dry afternoon crosses the temperature and humidity thresholds
across the whole range without a fire anywhere. They raise the confidence of a
gas breach instead. Gas triggers on either an absolute level or a rate of rise
measured over a multi-minute window.

### Cluster alerts

Live alerts are joined into connected components over the neighbour graph
(nodes within `correlation.radiusM`, default 160 m — the four orthogonal
neighbours at 100 m plus the diagonals at 141 m). Two or more adjacent nodes
spiking inside the simultaneity window become one **cluster alert**, which:

- gets its own card above the single-node table,
- scores `max(member confidence) + 8 × (size − 1)` and never sits below the
  *high* tier,
- raises the tier floor of every member alert,
- escalates as one event, and acknowledges as one event.

Isolated single-node spikes stay where they belong: lower confidence, lower in
the list.

### Escalation

An unacknowledged alert at or above `minTierToEscalate` escalates when its
timeout elapses (default 10 min; 4 min for critical). Each escalation moves to
the next contact in the ordered list, over that contact's channel — SMS
gateway, voice call, or app push. Every escalation is logged with the contact,
channel, level and reason. Timeout, tiers, channels and contacts are all
configuration, per deployment/region.

### False-positive feedback loop

Acknowledging an alert requires an outcome tag: **confirmed fire**, controlled
burn, animal activity, sensor fault, dust/haze, or other. The tag is stored
against the raw readings that triggered the alert — trigger values, peaks, the
metrics that breached, corroborating nodes, and the thresholds and calibration
in force at the time — building a labelled dataset for future tuning.

That dataset feeds back two ways:

1. **Per node.** Repeated non-fire outcomes raise that node's own trigger
   points (`+55 ppm` per sensor fault, `+35` per dust/haze, `+20` per
   controlled burn, capped at `+260`); confirmed fires pull them back
   (`−70` each, floor `−60`). One drifting MQ135 never desensitises the mesh.
2. **Network-wide.** Once at least eight outcomes are labelled, Settings shows
   the mean peak gas of false positives against that of confirmed fires and
   suggests a threshold between them — applied only when a ranger accepts it.

The reporting view closes the loop by showing whether each confidence tier
still predicts real fires.

---

## Decisions on the spec's open items (§4)

These were left for further definition; the app implements a working default
for each, all configurable rather than hardcoded.

| Open item | Implemented default | Where to change |
|---|---|---|
| Escalation channels | Ordered contact list, each on SMS / voice / app push; channels toggleable per deployment | Settings → Escalation policy |
| Escalation timeout | 10 min, 4 min for critical; minimum tier *moderate* | Settings → Escalation policy |
| Confidence formula | Weighted 4-term score above, tiers at 80/60/40 | Settings → Confidence scoring |
| Retention | Alert history 365 days; feedback-tagged data 730 days; telemetry buffer 72 h | Settings → Retention |

Labelled feedback deliberately outlives raw alert history — it is the training
set. Open alerts are never pruned.

---

## Replacing the simulator

`js/network.js` is the only file that fabricates data. It exposes the node
roster and telemetry samples that everything else consumes:

```js
FF.network.nodes()            // [{ id, lat, lng, gas, temp, humidity, battery, charging,
                              //    status, lastSeen, gatewayId, hops, rssi, hist, live, … }]
FF.network.gateways()
FF.network.series(node, hours, field)   // chart-ready [{ t, v }]
FF.network.breaches(node, config)       // metrics currently past threshold
```

To go live: replace `build()` with a fetch of the node roster from the gateway
API, and `step()` with a poll (or WebSocket subscription) that writes incoming
telemetry onto the same node objects and appends to `hist` / `live`. The alert
engine, map, charts and views need no changes.

On first run the app also seeds two fire seasons of tagged incidents and
labelled outcomes (deterministic, marked `source: 'seed'`) so Historical
Reporting and the feedback dataset are meaningful immediately. Everything after
that is real console activity. Clearing stored data from Settings wipes both.

The scenario buttons on the Dashboard and Live Map (`ignition`, `single-node
gas spike`, `animal disturbance`, `external haze`) drive the simulator so the
alert, cluster, escalation and feedback paths can be demonstrated without
waiting for a real fire; drop them with the simulator.

## Before field deployment

- **Authentication is a prototype.** Credentials are checked in the browser
  against `js/config.js`. Wire the login screen to the department's identity
  provider and move session handling server-side.
- **Storage is local.** Alerts, outcomes and configuration live in the
  browser's `localStorage`, so history is per-device. A real deployment needs
  the alert store, feedback dataset and escalation log on the server, shared
  across officers.
- **Push is browser push.** Delivery to a phone in the field needs a service
  worker plus a push service, and the escalation channels need a real SMS
  gateway and voice bridge behind them — the console logs what it *would*
  send, marked `delivery: simulated`.

## Layout

```
index.html          app shell + login screen
css/app.css         dark ops theme
js/util.js          seeded RNG, formatting, DOM/SVG helpers
js/config.js        deployment, thresholds, weights, escalation, outcome tags
js/store.js         localStorage persistence, session, retention
js/network.js       sensor network model + telemetry simulator  ← swap for the gateway API
js/alerts.js        detection, confidence, correlation, escalation, feedback tuning
js/charts.js        SVG line/bar/donut/sparkline charts
js/map.js           SVG live map with pan/zoom
js/ui.js            badges, meters, modals, toasts, browser push
js/views.js         Dashboard, Live map, Alerts
js/views2.js        Node monitoring, Node detail, Reporting, Settings
js/app.js           auth gate, hash router, simulation loop, notifications
```
