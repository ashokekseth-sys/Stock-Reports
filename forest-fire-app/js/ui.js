/* Shared UI pieces: badges, meters, modals, toasts and browser push. */
(function (FF) {
  'use strict';

  const U = FF.util;
  const C = FF.config;
  const esc = U.esc;

  const TIER_CLASS = { critical: 'crit', high: 'high', moderate: 'warn', low: 'info' };

  /* An optional prefix keeps two same-worded badges apart when they sit side
     by side — "risk: critical" next to "alert: critical". */
  function tierBadge(tier, prefix) {
    return '<span class="badge ' + (TIER_CLASS[tier] || 'muted') + '">' +
      (prefix ? esc(prefix) + ': ' : '') + esc(tier) + '</span>';
  }

  function confBar(score) {
    const tier = FF.alerts.tierFor(score, FF.store.getConfig());
    return '<div class="conf-bar"><div class="track"><i style="width:' + U.clamp(score, 0, 100) +
      '%;background:' + C.tierColor(tier) + '"></i></div><span class="n">' + esc(score) + '</span></div>';
  }

  function riskBadge(node, prefix) {
    if (node.status === 'offline') return '<span class="badge muted">offline</span>';
    const lvl = C.riskLevel(node.riskScore);
    const cls = { normal: 'ok', elevated: 'warn', high: 'high', critical: 'crit' }[lvl.id];
    return '<span class="badge ' + cls + '">' + (prefix ? esc(prefix) + ': ' : '') + esc(lvl.label) + '</span>';
  }

  function batteryCell(node) {
    const cfg = FF.store.getConfig();
    const color = node.battery <= cfg.health.batteryCriticalPct ? 'var(--crit)'
      : node.battery <= cfg.health.batteryLowPct ? 'var(--warn)' : 'var(--ok)';
    return '<div style="display:flex;align-items:center;gap:8px">' +
      '<div class="meter"><i style="width:' + U.clamp(node.battery, 0, 100) + '%;background:' + color + '"></i></div>' +
      '<span style="font-family:var(--mono);font-size:12px;color:var(--text-2)">' + esc(U.round(node.battery, 0)) + '%</span>' +
      (node.charging ? '<span title="Solar charging" style="color:var(--warn)">☀</span>'
                     : '<span title="Discharging" style="color:var(--text-3)">🌙</span>') +
      '</div>';
  }

  function metricChips(metrics) {
    const label = { gas: 'GAS', temp: 'TEMP', humidity: 'RH', gas_rate: 'GAS↑' };
    return (metrics || []).map(function (m) {
      return '<span class="chip">' + esc(label[m] || m) + '</span>';
    }).join(' ');
  }

  /* -------------------------------- Modal --------------------------------- */

  let modalEl = null;

  function openModal(opts) {
    closeModal();
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><h3>' + esc(opts.title) + '</h3>' +
      '<button class="x" aria-label="Close">&times;</button></div>' +
      '<div class="modal-body">' + opts.body + '</div>' +
      (opts.footer ? '<div class="modal-foot">' + opts.footer + '</div>' : '') +
      '</div>';
    document.body.appendChild(back);
    modalEl = back;
    back.addEventListener('click', function (e) { if (e.target === back) closeModal(); });
    back.querySelector('.x').addEventListener('click', closeModal);
    document.addEventListener('keydown', escKey);
    if (opts.onMount) opts.onMount(back);
    return back;
  }

  function escKey(e) { if (e.key === 'Escape') closeModal(); }

  function closeModal() {
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
    document.removeEventListener('keydown', escKey);
  }

  /* -------------------------------- Toasts -------------------------------- */

  function toast(opts) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const t = document.createElement('div');
    t.className = 'toast ' + (opts.kind || 'info');
    t.innerHTML = '<div class="t">' + (opts.icon ? esc(opts.icon) + ' ' : '') + esc(opts.title) + '</div>' +
                  '<div class="d">' + esc(opts.body || '') + '</div>';
    t.addEventListener('click', function () {
      if (opts.onClick) opts.onClick();
      if (t.parentNode) t.parentNode.removeChild(t);
    });
    host.appendChild(t);
    /* Cap the stack: a busy fire day would otherwise bury the corner of the
       screen — and whatever control sits under it — in notifications. */
    while (host.children.length > 4) host.removeChild(host.firstChild);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, opts.ttl || 9000);
  }

  /* ---- Browser push -------------------------------------------------------
     Field push can be missed, which is exactly why escalation exists; this is
     the first, cheapest notification hop. */
  function requestPush() {
    if (!('Notification' in window)) return Promise.resolve('unsupported');
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Promise.resolve(Notification.permission);
    }
    try { return Notification.requestPermission(); } catch (e) { return Promise.resolve('denied'); }
  }

  function push(title, body, tag) {
    const cfg = FF.store.getConfig();
    if (!cfg.notifications.browserPush) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body: body, tag: tag, icon: 'assets/icon.svg', badge: 'assets/icon.svg' });
    } catch (e) { /* some browsers require a service worker; toast still fires */ }
  }

  FF.ui = {
    tierBadge: tierBadge, confBar: confBar, riskBadge: riskBadge, batteryCell: batteryCell,
    metricChips: metricChips, openModal: openModal, closeModal: closeModal,
    toast: toast, requestPush: requestPush, push: push
  };
})(window.FF = window.FF || {});
