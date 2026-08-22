/* Hand-rolled SVG charts. No chart library — the console has to work from a
   ranger's laptop on a range office connection with nothing cached. */
(function (FF) {
  'use strict';

  const U = FF.util;
  const esc = U.esc;

  function extent(vals, pad) {
    let lo = Math.min.apply(null, vals);
    let hi = Math.max.apply(null, vals);
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const p = (hi - lo) * (pad === undefined ? 0.12 : pad);
    return [lo - p, hi + p];
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const start = Math.ceil(lo / step) * step;
    const out = [];
    for (let v = start; v <= hi + 1e-9; v += step) out.push(U.round(v, 6));
    return out;
  }

  /* --------------------------------- Sparkline ---------------------------- */

  function sparkline(points, opts) {
    const o = opts || {};
    const w = o.width || 120, h = o.height || 30;
    const vals = points.map(function (p) { return p.v; });
    if (!vals.length) return '<svg class="spark" width="' + w + '" height="' + h + '"></svg>';
    const ex = extent(vals, 0.15);
    const n = points.length;
    const x = function (i) { return (i / Math.max(1, n - 1)) * (w - 2) + 1; };
    const y = function (v) { return h - 2 - ((v - ex[0]) / (ex[1] - ex[0])) * (h - 4); };
    let d = '';
    points.forEach(function (p, i) { d += (i ? 'L' : 'M') + U.round(x(i), 1) + ' ' + U.round(y(p.v), 1); });
    const area = d + 'L' + U.round(x(n - 1), 1) + ' ' + h + 'L1 ' + h + 'Z';
    const color = o.color || '#4c9aff';
    const id = 'sg' + Math.random().toString(36).slice(2, 8);
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.35"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + id + ')"/>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<circle cx="' + U.round(x(n - 1), 1) + '" cy="' + U.round(y(vals[n - 1]), 1) + '" r="2" fill="' + color + '"/>' +
      '</svg>';
  }

  /* ------------------------------- Line chart ----------------------------- */
  /* series: [{ name, color, points: [{t, v}] }]; opts.thresholds: [{v,label,color}] */

  function lineChart(series, opts) {
    const o = opts || {};
    const W = 820, H = o.height || 240;
    const M = { t: 14, r: 14, b: 26, l: 46 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;

    const all = series.reduce(function (a, s) { return a.concat(s.points.map(function (p) { return p.v; })); }, []);
    const ts = series.reduce(function (a, s) { return a.concat(s.points.map(function (p) { return p.t; })); }, []);
    if (!all.length) return '<div class="empty">No telemetry in this window.</div>';

    let ex = extent(all, 0.14);
    (o.thresholds || []).forEach(function (th) {
      ex = [Math.min(ex[0], th.v - Math.abs(th.v) * 0.03), Math.max(ex[1], th.v + Math.abs(th.v) * 0.03)];
    });
    if (o.min !== undefined) ex[0] = Math.min(ex[0], o.min);
    if (o.max !== undefined) ex[1] = Math.max(ex[1], o.max);

    const t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts);
    const x = function (t) { return M.l + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw); };
    const y = function (v) { return M.t + ih - ((v - ex[0]) / (ex[1] - ex[0])) * ih; };

    let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.title || 'trend chart') + '">';

    niceTicks(ex[0], ex[1], 4).forEach(function (v) {
      svg += '<line class="grid-line" x1="' + M.l + '" y1="' + U.round(y(v), 1) + '" x2="' + (M.l + iw) + '" y2="' + U.round(y(v), 1) + '"/>' +
             '<text x="' + (M.l - 7) + '" y="' + U.round(y(v) + 3.5, 1) + '" text-anchor="end">' + esc(U.round(v, 1)) + '</text>';
    });

    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + ((t1 - t0) * i) / ticks;
      const span = t1 - t0;
      const label = span > 36 * 3600e3
        ? new Date(t).toLocaleDateString([], { day: '2-digit', month: 'short' })
        : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      svg += '<text x="' + U.round(x(t), 1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(label) + '</text>';
    }

    (o.thresholds || []).forEach(function (th) {
      svg += '<line x1="' + M.l + '" y1="' + U.round(y(th.v), 1) + '" x2="' + (M.l + iw) + '" y2="' + U.round(y(th.v), 1) +
             '" stroke="' + (th.color || '#ff4d4d') + '" stroke-width="1" stroke-dasharray="5 4" opacity="0.75"/>' +
             '<text x="' + (M.l + iw - 3) + '" y="' + U.round(y(th.v) - 5, 1) + '" text-anchor="end" fill="' + (th.color || '#ff4d4d') + '">' +
             esc(th.label || '') + '</text>';
    });

    series.forEach(function (s, si) {
      if (!s.points.length) return;
      const color = s.color || ['#4c9aff', '#ff8a3d', '#3fbf7f', '#c98cff'][si % 4];
      let d = '';
      s.points.forEach(function (p, i) { d += (i ? 'L' : 'M') + U.round(x(p.t), 1) + ' ' + U.round(y(p.v), 1); });
      if (s.fill !== false) {
        const gid = 'lg' + si + Math.random().toString(36).slice(2, 7);
        const areaD = d + 'L' + U.round(x(s.points[s.points.length - 1].t), 1) + ' ' + (M.t + ih) +
                      'L' + U.round(x(s.points[0].t), 1) + ' ' + (M.t + ih) + 'Z';
        svg += '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
               '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.22"/>' +
               '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
               '<path d="' + areaD + '" fill="url(#' + gid + ')"/>';
      }
      svg += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>';
      const last = s.points[s.points.length - 1];
      svg += '<circle cx="' + U.round(x(last.t), 1) + '" cy="' + U.round(y(last.v), 1) + '" r="3" fill="' + color + '"/>';
    });

    svg += '<line class="axis" x1="' + M.l + '" y1="' + (M.t + ih) + '" x2="' + (M.l + iw) + '" y2="' + (M.t + ih) + '"/></svg>';
    return svg;
  }

  /* ------------------------------ Bar charts ------------------------------ */
  /* groups: [{ label, parts: [{ value, color, name }] }] — single-part groups
     render as a plain bar chart, multi-part groups stack. */

  function stackedBars(groups, opts) {
    const o = opts || {};
    const W = 820, H = o.height || 230;
    const M = { t: 12, r: 12, b: 30, l: 42 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    if (!groups.length) return '<div class="empty">Nothing to plot yet.</div>';

    const totals = groups.map(function (g) { return U.sum(g.parts.map(function (p) { return p.value; })); });
    const maxV = Math.max(1, Math.max.apply(null, totals));
    const bw = iw / groups.length;
    const barW = Math.max(3, Math.min(o.maxBarWidth || 34, bw * 0.66));
    const y = function (v) { return M.t + ih - (v / maxV) * ih; };

    let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.title || 'bar chart') + '">';
    niceTicks(0, maxV, 4).forEach(function (v) {
      svg += '<line class="grid-line" x1="' + M.l + '" y1="' + U.round(y(v), 1) + '" x2="' + (M.l + iw) + '" y2="' + U.round(y(v), 1) + '"/>' +
             '<text x="' + (M.l - 6) + '" y="' + U.round(y(v) + 3.5, 1) + '" text-anchor="end">' + esc(U.round(v, 0)) + '</text>';
    });

    groups.forEach(function (g, i) {
      const cx = M.l + bw * i + bw / 2;
      let acc = 0;
      g.parts.forEach(function (p) {
        if (p.value <= 0) return;
        const y1 = y(acc), y0 = y(acc + p.value);
        svg += '<rect x="' + U.round(cx - barW / 2, 1) + '" y="' + U.round(y0, 1) + '" width="' + U.round(barW, 1) +
               '" height="' + U.round(Math.max(1, y1 - y0), 1) + '" fill="' + (p.color || '#4c9aff') + '" rx="2">' +
               '<title>' + esc(g.label + ' — ' + (p.name || '') + ': ' + p.value) + '</title></rect>';
        acc += p.value;
      });
      const every = Math.ceil(groups.length / (o.labelEvery || 12));
      if (i % every === 0) {
        svg += '<text x="' + U.round(cx, 1) + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(g.label) + '</text>';
      }
    });

    svg += '<line class="axis" x1="' + M.l + '" y1="' + (M.t + ih) + '" x2="' + (M.l + iw) + '" y2="' + (M.t + ih) + '"/></svg>';
    return svg;
  }

  function hBars(rows, opts) {
    const o = opts || {};
    const max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    return '<div style="display:flex;flex-direction:column;gap:9px">' + rows.map(function (r) {
      const pct = (r.value / max) * 100;
      return '<div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">' +
        '<span style="color:var(--text-2)">' + esc(r.label) + '</span>' +
        '<span style="font-family:var(--mono);color:var(--text-3)">' + esc(r.display !== undefined ? r.display : r.value) + '</span></div>' +
        '<div class="meter" style="height:7px"><i style="width:' + U.round(pct, 1) + '%;background:' + (r.color || '#4c9aff') + '"></i></div>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* -------------------------------- Donut --------------------------------- */

  function donut(parts, opts) {
    const o = opts || {};
    const size = o.size || 150, r = size / 2 - 10, cx = size / 2, cy = size / 2;
    const total = U.sum(parts.map(function (p) { return p.value; }));
    if (!total) return '<div class="empty">No tagged outcomes yet.</div>';
    let a0 = -Math.PI / 2;
    let svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">';
    parts.forEach(function (p) {
      if (p.value <= 0) return;
      const a1 = a0 + (p.value / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      svg += '<path d="M' + U.round(x0, 2) + ' ' + U.round(y0, 2) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' +
             U.round(x1, 2) + ' ' + U.round(y1, 2) + '" fill="none" stroke="' + p.color + '" stroke-width="15">' +
             '<title>' + esc(p.label + ': ' + p.value) + '</title></path>';
      a0 = a1;
    });
    svg += '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" style="font-size:21px;fill:var(--text);font-family:var(--mono)">' +
           esc(o.centerValue !== undefined ? o.centerValue : total) + '</text>' +
           '<text x="' + cx + '" y="' + (cy + 14) + '" text-anchor="middle" style="font-size:9px;letter-spacing:0.08em">' +
           esc((o.centerLabel || 'TOTAL').toUpperCase()) + '</text></svg>';
    return svg;
  }

  FF.charts = { sparkline: sparkline, lineChart: lineChart, stackedBars: stackedBars, hBars: hBars, donut: donut };
})(window.FF = window.FF || {});
