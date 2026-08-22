/* Persistence layer. Everything the ranger console needs to survive a reload —
   session, deployment config, alert history, the feedback-tagged dataset and
   escalation log — lives in localStorage under a single namespace. */
(function (FF) {
  'use strict';

  const KEY = 'ffds.v1';
  const cfg = FF.config;

  function deepMerge(base, over) {
    if (over === null || over === undefined) return base;
    if (Array.isArray(base) || typeof base !== 'object') return over;
    const out = {};
    Object.keys(base).forEach(function (k) { out[k] = deepMerge(base[k], over[k]); });
    Object.keys(over).forEach(function (k) { if (!(k in out)) out[k] = over[k]; });
    return out;
  }

  const blank = function () {
    return {
      session: null,
      config: JSON.parse(JSON.stringify(cfg.DEFAULT_CONFIG)),
      alerts: [],            // live + historical alerts
      clusters: [],          // cluster alerts (correlated neighbour spikes)
      feedback: [],          // labelled dataset: outcome tag + raw readings
      escalations: [],       // escalation log (who was contacted, on what channel)
      incidents: [],         // historical fire incidents for reporting
      seeded: false
    };
  };

  let state = blank();
  let saveTimer = null;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = deepMerge(blank(), parsed);
        /* Config gains new keys across versions; merge defaults underneath. */
        state.config = deepMerge(JSON.parse(JSON.stringify(cfg.DEFAULT_CONFIG)), parsed.config || {});
      }
    } catch (e) {
      console.warn('Stored state unreadable, starting clean.', e);
      state = blank();
    }
    return state;
  }

  function save() {
    /* Coalesce writes — the simulator ticks every few seconds. */
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        /* Quota exhausted: drop the oldest history and retry once. */
        state.alerts = state.alerts.slice(-400);
        state.feedback = state.feedback.slice(-400);
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e2) { console.warn('Persist failed', e2); }
      }
    }, 400);
  }

  function get() { return state; }
  function getConfig() { return state.config; }

  function setConfig(next) {
    state.config = deepMerge(state.config, next);
    save();
    return state.config;
  }

  function resetConfig() {
    state.config = JSON.parse(JSON.stringify(cfg.DEFAULT_CONFIG));
    save();
    return state.config;
  }

  /* ---- Session ----------------------------------------------------------- */

  function signIn(username, password) {
    const u = cfg.USERS.filter(function (x) {
      return x.username === String(username || '').trim().toLowerCase() && x.password === password;
    })[0];
    if (!u) return null;
    state.session = {
      username: u.username, name: u.name, role: u.role, beat: u.beat, since: Date.now()
    };
    save();
    return state.session;
  }
  function signOut() { state.session = null; save(); }
  function session() { return state.session; }

  /* ---- Alerts ------------------------------------------------------------ */

  function addAlert(alert) { state.alerts.push(alert); save(); return alert; }
  function alerts() { return state.alerts; }
  function alertById(id) { return state.alerts.filter(function (a) { return a.id === id; })[0] || null; }
  function openAlerts() { return state.alerts.filter(function (a) { return a.status === 'open'; }); }
  function openAlertForNode(nodeId) {
    return state.alerts.filter(function (a) { return a.nodeId === nodeId && a.status === 'open'; })[0] || null;
  }

  function addCluster(c) { state.clusters.push(c); save(); return c; }
  function clusters() { return state.clusters; }
  function openClusters() { return state.clusters.filter(function (c) { return c.status === 'open'; }); }
  function clusterById(id) { return state.clusters.filter(function (c) { return c.id === id; })[0] || null; }

  /* ---- Feedback loop ------------------------------------------------------
     Each acknowledged alert's outcome tag is logged against the raw readings
     that triggered it, building a labelled dataset for threshold tuning. */
  function addFeedback(record) { state.feedback.push(record); save(); return record; }
  function feedback() { return state.feedback; }

  function addEscalation(rec) { state.escalations.push(rec); save(); return rec; }
  function escalations() { return state.escalations; }

  function addIncident(i) { state.incidents.push(i); save(); return i; }
  function incidents() { return state.incidents; }

  function seedIncidents(list) {
    state.incidents = list;
    state.seeded = true;
    save();
  }
  function isSeeded() { return !!state.seeded; }

  /* ---- Retention ---------------------------------------------------------
     Alert history and feedback-tagged data age out on independent clocks. */
  function pruneRetention(now) {
    const r = state.config.retention;
    const t = now || Date.now();
    const alertCut = t - r.alertHistoryDays * 864e5;
    const fbCut = t - r.feedbackDatasetDays * 864e5;
    const before = state.alerts.length + state.feedback.length;

    state.alerts = state.alerts.filter(function (a) { return a.status === 'open' || a.createdAt >= alertCut; });
    state.clusters = state.clusters.filter(function (c) { return c.status === 'open' || c.createdAt >= alertCut; });
    state.feedback = state.feedback.filter(function (f) { return f.taggedAt >= fbCut; });
    state.escalations = state.escalations.filter(function (e) { return e.at >= alertCut; });
    state.incidents = state.incidents.filter(function (i) { return i.at >= fbCut; });

    const removed = before - (state.alerts.length + state.feedback.length);
    if (removed > 0) save();
    return removed;
  }

  function clearAll() {
    const s = state.session;
    state = blank();
    state.session = s;
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    save();
  }

  FF.store = {
    load: load, save: save, get: get,
    getConfig: getConfig, setConfig: setConfig, resetConfig: resetConfig,
    signIn: signIn, signOut: signOut, session: session,
    addAlert: addAlert, alerts: alerts, alertById: alertById, openAlerts: openAlerts,
    openAlertForNode: openAlertForNode,
    addCluster: addCluster, clusters: clusters, openClusters: openClusters, clusterById: clusterById,
    addFeedback: addFeedback, feedback: feedback,
    addEscalation: addEscalation, escalations: escalations,
    addIncident: addIncident, incidents: incidents, seedIncidents: seedIncidents, isSeeded: isSeeded,
    pruneRetention: pruneRetention, clearAll: clearAll
  };
})(window.FF = window.FF || {});
