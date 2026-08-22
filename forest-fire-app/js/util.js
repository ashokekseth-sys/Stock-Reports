/* Small dependency-free helpers: seeded RNG, formatting, DOM + SVG builders. */
(function (FF) {
  'use strict';

  /* ---- Seeded pseudo-random number generator (mulberry32) -----------------
     Deterministic so that seeded history, node layout and demo incidents are
     identical on every load — important when comparing trends across sessions. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const round = (v, d) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);

  /* Box-Muller normal deviate, used to keep sensor noise realistic. */
  function gauss(rand, mu, sigma) {
    const u = Math.max(rand(), 1e-9), v = Math.max(rand(), 1e-9);
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---- Formatting -------------------------------------------------------- */

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtDateTime(ts) {
    return new Date(ts).toLocaleString([], {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtAgo(ts, now) {
    const s = Math.max(0, Math.floor(((now || Date.now()) - ts) / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  /* Escape anything that reaches innerHTML from stored/user-entered text. */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---- DOM --------------------------------------------------------------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /* Attribute string builder for the SVG/HTML template literals below. */
  function attrs(o) {
    return Object.keys(o)
      .filter(function (k) { return o[k] !== null && o[k] !== undefined; })
      .map(function (k) { return k + '="' + esc(o[k]) + '"'; })
      .join(' ');
  }

  function downloadFile(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function toCsv(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        const s = c === null || c === undefined ? '' : String(c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\n');
  }

  FF.util = {
    rng: rng, clamp: clamp, lerp: lerp, round: round, sum: sum, mean: mean, gauss: gauss,
    fmtTime: fmtTime, fmtDateTime: fmtDateTime, fmtDate: fmtDate, fmtAgo: fmtAgo, fmtDur: fmtDur,
    esc: esc, $: $, $$: $$, el: el, attrs: attrs, downloadFile: downloadFile, toCsv: toCsv
  };
})(window.FF = window.FF || {});
