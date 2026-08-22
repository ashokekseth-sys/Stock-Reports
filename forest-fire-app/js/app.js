/* Application shell: authentication gate, hash router, simulation loop and
   the notification pipeline (in-app toast → browser push → escalation). */
(function (FF) {
  'use strict';

  const U = FF.util;
  const C = FF.config;
  const UI = FF.ui;
  const store = FF.store;
  const net = FF.network;
  const esc = U.esc;

  const TICK_MS = 4000;

  const NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'map', label: 'Live map', icon: '🗺' },
    { id: 'alerts', label: 'Alerts', icon: '🚨', badge: true },
    { id: 'nodes', label: 'Node monitoring', icon: '📡' },
    { id: 'reports', label: 'Historical reporting', icon: '📈' },
    { id: 'settings', label: 'Settings', icon: '⚙' }
  ];

  const app = { route: { name: 'dashboard', params: {} }, timer: null, booted: false };

  /* -------------------------------- Routing ------------------------------- */

  function parseHash() {
    const raw = (location.hash || '#/dashboard').replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    if (!parts.length) return { name: 'dashboard', params: {} };
    if (parts[0] === 'nodes' && parts[1]) return { name: 'node', params: { id: decodeURIComponent(parts[1]) } };
    const known = ['dashboard', 'map', 'alerts', 'nodes', 'reports', 'settings'];
    return known.indexOf(parts[0]) >= 0 ? { name: parts[0], params: {} } : { name: 'dashboard', params: {} };
  }

  function navigate() {
    app.route = parseHash();
    render();
  }

  function currentView() {
    return FF.views[app.route.name] || FF.views.dashboard;
  }

  function render() {
    if (!store.session()) return;
    const view = currentView();
    const host = document.getElementById('view');
    if (!host) return;

    document.getElementById('view-title').textContent = view.title;
    document.getElementById('view-crumb').textContent = view.crumb || '';
    document.querySelectorAll('.nav-item').forEach(function (a) {
      const id = a.getAttribute('data-nav');
      const active = id === app.route.name || (app.route.name === 'node' && id === 'nodes');
      a.classList.toggle('active', active);
    });

    view.render(host, app.route.params);
    refreshNav();
  }

  /* Re-render in place, keeping scroll position and not fighting the user. */
  function rerender() {
    if (!store.session()) return;
    const host = document.getElementById('view');
    if (!host) return;
    const active = document.activeElement;
    if (active && host.contains(active) &&
        ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(active.tagName) >= 0) return;
    if (document.querySelector('.modal-back')) { refreshNav(); return; }
    if (FF.map.busy()) { refreshNav(); return; }

    const scrolls = U.$$('.table-wrap', host).map(function (e) { return e.scrollTop; });
    const pageY = window.scrollY;
    currentView().render(host, app.route.params);
    U.$$('.table-wrap', host).forEach(function (e, i) { if (scrolls[i]) e.scrollTop = scrolls[i]; });
    window.scrollTo(0, pageY);
    refreshNav();
  }

  function refreshNav() {
    const open = store.openAlerts().length;
    const badge = document.querySelector('[data-nav="alerts"] .count');
    if (badge) {
      badge.textContent = open;
      badge.classList.toggle('zero', open === 0);
    }
    const pill = document.getElementById('live-pill');
    if (pill) {
      pill.innerHTML = '<span class="dot pulse"></span>' +
        net.nodes().filter(function (n) { return n.status === 'online'; }).length + '/' + net.nodes().length +
        ' nodes · updated ' + esc(U.fmtTime(Date.now()));
    }
    document.title = (open ? '(' + open + ') ' : '') + 'Forest Fire Detection System';
  }

  /* ----------------------------- Notifications ---------------------------- */

  function notifyForAlert(alert) {
    const cfg = store.getConfig();
    if (C.TIER_RANK[alert.tier] < (C.TIER_RANK[cfg.notifications.minTier] || 0)) return;
    const body = alert.nodeLabel + ' · ' + alert.sector + ' · confidence ' + alert.confidence + '% · ' +
      alert.metrics.join(', ');
    if (cfg.notifications.inAppToast) {
      UI.toast({
        kind: alert.tier === 'critical' ? 'crit' : alert.tier === 'high' ? 'high' : 'info',
        icon: '🔥',
        title: alert.tier.toUpperCase() + ' alert — ' + alert.nodeId,
        body: body,
        ttl: 12000,
        onClick: function () { location.hash = '#/alerts'; }
      });
    }
    UI.push('🔥 ' + alert.tier.toUpperCase() + ' fire alert', body, alert.id);
  }

  FF.alerts.on(function (evt) {
    if (evt.type === 'alert-new') {
      notifyForAlert(evt.alert);
    } else if (evt.type === 'cluster-new') {
      const c = evt.cluster;
      const body = c.size + ' adjacent nodes spiking together in ' + c.sector +
        ' — confidence ' + c.confidence + '%. Treat as a probable fire.';
      UI.toast({ kind: 'crit', icon: '🔥', title: 'CLUSTER ALERT — ' + c.size + ' nodes', body: body, ttl: 16000,
        onClick: function () { location.hash = '#/alerts'; } });
      UI.push('🔥 Cluster alert — ' + c.size + ' nodes', body, c.id);
    } else if (evt.type === 'escalation') {
      const e = evt.escalation;
      const channel = { sms: 'SMS', voice: 'voice call', push: 'app push' }[e.channel] || e.channel;
      UI.toast({ kind: 'high', icon: '📞',
        title: 'Escalated (level ' + e.level + ') — ' + channel,
        body: e.contactName + ' · ' + e.phone + '. ' + e.reason + '.', ttl: 14000,
        onClick: function () { location.hash = '#/alerts'; } });
      UI.push('Alert escalated to ' + e.contactName, e.reason + ' — contacted by ' + channel + '.', e.id);
    }
  });

  /* ------------------------------- Sim loop ------------------------------- */

  function tick() {
    net.step();
    net.refreshStatuses();
    FF.alerts.evaluate();
    FF.alerts.correlate();
    FF.alerts.checkEscalations();
    store.save();
    if (currentView().live) rerender(); else refreshNav();
  }

  function startLoop() {
    if (app.timer) clearInterval(app.timer);
    app.timer = setInterval(tick, TICK_MS);
  }

  /* --------------------------------- Auth --------------------------------- */

  function showLogin(message) {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-shell').classList.add('hidden');
    const err = document.getElementById('login-error');
    if (message) { err.textContent = message; err.classList.remove('hidden'); }
    else err.classList.add('hidden');
  }

  function showApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    const s = store.session();
    document.getElementById('user-name').textContent = s.name;
    document.getElementById('user-role').textContent = s.role;
    document.getElementById('user-initials').textContent =
      s.name.split(/[\s.]+/).filter(Boolean).map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase();
    navigate();
    startLoop();
  }

  function buildNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = NAV.map(function (n) {
      return '<a class="nav-item" data-nav="' + n.id + '" href="#/' + n.id + '">' +
        '<span class="icon">' + esc(n.icon) + '</span><span>' + esc(n.label) + '</span>' +
        (n.badge ? '<span class="count zero">0</span>' : '') + '</a>';
    }).join('');
  }

  /* --------------------------------- Boot --------------------------------- */

  function boot() {
    store.load();
    net.build();
    store.pruneRetention();
    FF.alerts.seedHistory();
    FF.alerts.applyAllTuning();
    buildNav();

    window.addEventListener('hashchange', navigate);

    document.getElementById('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const u = document.getElementById('login-user').value;
      const p = document.getElementById('login-pass').value;
      const s = store.signIn(u, p);
      if (!s) { showLogin('Incorrect username or password. Try ranger / forest123.'); return; }
      showApp();
      UI.requestPush();
      UI.toast({ kind: 'info', icon: '🌲', title: 'Signed in as ' + s.name,
        body: s.role + ' · ' + store.getConfig().regionName + '. Live telemetry is streaming.' });
    });

    document.getElementById('logout').addEventListener('click', function () {
      store.signOut();
      if (app.timer) clearInterval(app.timer);
      showLogin('');
      document.getElementById('login-form').reset();
    });

    document.getElementById('demo-fill').addEventListener('click', function (e) {
      e.preventDefault();
      document.getElementById('login-user').value = 'ranger';
      document.getElementById('login-pass').value = 'forest123';
    });

    if (store.session()) showApp(); else showLogin('');
    app.booted = true;

    /* One evaluation pass immediately so the console is not empty on arrival. */
    FF.alerts.evaluate();
    refreshNav();
  }

  FF.app = { boot: boot, rerender: rerender, refreshNav: refreshNav, navigate: navigate, tick: tick };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.FF = window.FF || {});
