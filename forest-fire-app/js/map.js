/* Live map: node GPS positions, colour-coded risk, mesh links to gateways and
   cluster halos. Drawn as plain SVG with pan/zoom so it needs no tile server —
   range offices are frequently offline. */
(function (FF) {
  'use strict';

  const U = FF.util;
  const C = FF.config;
  const net = FF.network;
  const esc = U.esc;

  const M_PER_DEG_LAT = 111320;

  function project(nodes, gateways) {
    const lats = nodes.map(function (n) { return n.lat; });
    const lngs = nodes.map(function (n) { return n.lng; });
    const minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    const minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
    const mPerLng = M_PER_DEG_LAT * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);

    /* 1 unit = 1 metre, y flipped so north is up. */
    const to = function (p) {
      return {
        x: (p.lng - minLng) * mPerLng,
        y: (maxLat - p.lat) * M_PER_DEG_LAT
      };
    };
    const w = (maxLng - minLng) * mPerLng;
    const h = (maxLat - minLat) * M_PER_DEG_LAT;
    return { to: to, w: w, h: h, bounds: { minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng } };
  }

  const view = { scale: 1, tx: 0, ty: 0 };
  let interacting = false;

  function render(container, opts) {
    const o = opts || {};
    const nodes = net.nodes();
    const gateways = net.gateways();
    const proj = project(nodes, gateways);
    const pad = 95;
    const W = proj.w + pad * 2, H = proj.h + pad * 2;
    const openAlerts = FF.store.openAlerts();
    const alertByNode = {};
    openAlerts.forEach(function (a) { alertByNode[a.nodeId] = a; });
    const clusters = FF.store.openClusters();

    let g = '';

    /* Terrain wash: compartment cells tinted by elevation so the grid reads as
       ground rather than graph paper. */
    const cell = FF.config.DEPLOYMENT.spacingM;
    for (let r = -1; r <= FF.config.DEPLOYMENT.rows; r++) {
      for (let c = -1; c <= FF.config.DEPLOYMENT.cols; c++) {
        const shade = 0.045 + 0.035 * ((Math.sin(r * 0.8) + Math.cos(c * 0.6)) / 2 + 1) / 2;
        g += '<rect x="' + (pad + c * cell - cell / 2) + '" y="' + (pad + r * cell - cell / 2) +
             '" width="' + cell + '" height="' + cell + '" fill="rgba(63,191,127,' + U.round(shade, 3) + ')"/>';
      }
    }
    for (let r = 0; r <= FF.config.DEPLOYMENT.rows; r++) {
      const y = pad + r * cell - cell / 2;
      g += '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="rgba(255,255,255,0.045)" stroke-width="1"/>';
    }
    for (let c = 0; c <= FF.config.DEPLOYMENT.cols; c++) {
      const x = pad + c * cell - cell / 2;
      g += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '" stroke="rgba(255,255,255,0.045)" stroke-width="1"/>';
    }

    /* Mesh links: node → its gateway. Dashed when the node is unreachable. */
    nodes.forEach(function (n) {
      const gw = net.gatewayById(n.gatewayId);
      if (!gw) return;
      const a = proj.to(n), b = proj.to(gw);
      const off = n.status === 'offline';
      g += '<line x1="' + U.round(a.x + pad, 1) + '" y1="' + U.round(a.y + pad, 1) +
           '" x2="' + U.round(b.x + pad, 1) + '" y2="' + U.round(b.y + pad, 1) +
           '" stroke="' + (off ? '#64748b' : '#2f4358') + '" stroke-width="' + (off ? 0.8 : 1.1) +
           '" stroke-dasharray="' + (off ? '3 4' : '0') + '" opacity="' + (off ? 0.5 : 0.75) + '"/>';
    });

    /* Cluster halos sit under the nodes so correlated events read at a glance. */
    clusters.forEach(function (cl) {
      const pts = cl.nodeIds.map(function (id) { return net.byId(id); }).filter(Boolean).map(proj.to);
      if (!pts.length) return;
      const cx = U.mean(pts.map(function (p) { return p.x; })) + pad;
      const cy = U.mean(pts.map(function (p) { return p.y; })) + pad;
      const rr = Math.max.apply(null, pts.map(function (p) {
        return Math.hypot(p.x + pad - cx, p.y + pad - cy);
      })) + 62;
      const label = 'CLUSTER · ' + cl.size + ' NODES · ' + cl.confidence + '%';
      const lw = label.length * 10.4 + 16;
      const ly = cy - rr - 14;
      g += '<circle cx="' + U.round(cx, 1) + '" cy="' + U.round(cy, 1) + '" r="' + U.round(rr, 1) +
           '" fill="rgba(255,77,77,0.09)" stroke="#ff4d4d" stroke-width="1.4" stroke-dasharray="7 5"/>' +
           /* Pill behind the label so it stays readable over node text. */
           '<rect x="' + U.round(cx - lw / 2, 1) + '" y="' + U.round(ly - 15, 1) + '" width="' + U.round(lw, 1) +
           '" height="23" rx="11" fill="rgba(13,17,23,0.88)" stroke="#ff4d4d" stroke-width="1"/>' +
           '<text x="' + U.round(cx, 1) + '" y="' + U.round(ly, 1) + '" text-anchor="middle" ' +
           'fill="#ff8f8f" font-size="15" font-family="ui-monospace, monospace">' + esc(label) + '</text>';
    });

    gateways.forEach(function (gw) {
      const p = proj.to(gw);
      const x = U.round(p.x + pad, 1), y = U.round(p.y + pad, 1);
      g += '<g><rect x="' + (x - 11) + '" y="' + (y - 11) + '" width="22" height="22" rx="4" ' +
           'fill="#1b2532" stroke="#4c9aff" stroke-width="1.6"/>' +
           '<path d="M' + (x - 5) + ' ' + (y + 4) + ' L' + x + ' ' + (y - 5) + ' L' + (x + 5) + ' ' + (y + 4) + '" ' +
           'fill="none" stroke="#4c9aff" stroke-width="1.6"/>' +
           '<title>' + esc(gw.label + ' — ' + gw.backhaul) + '</title></g>' +
           '<text x="' + x + '" y="' + (y + 26) + '" text-anchor="middle" fill="#4c9aff" font-size="13" ' +
           'font-family="ui-monospace, monospace">' + esc(gw.id) + '</text>';
    });

    nodes.forEach(function (n) {
      const p = proj.to(n);
      const x = U.round(p.x + pad, 1), y = U.round(p.y + pad, 1);
      const offline = n.status === 'offline';
      const lvl = C.riskLevel(n.riskScore);
      const color = offline ? '#64748b' : lvl.color;
      const alert = alertByNode[n.id];
      const selected = o.selectedId === n.id;

      if (alert) {
        g += '<circle cx="' + x + '" cy="' + y + '" r="30" fill="' + C.tierColor(alert.tier) + '" opacity="0.16">' +
             '<animate attributeName="r" values="20;36;20" dur="2.4s" repeatCount="indefinite"/>' +
             '<animate attributeName="opacity" values="0.26;0.02;0.26" dur="2.4s" repeatCount="indefinite"/></circle>';
      }
      if (selected) {
        g += '<circle cx="' + x + '" cy="' + y + '" r="22" fill="none" stroke="#ffffff" stroke-width="1.6" opacity="0.85"/>';
      }

      g += '<g class="node-dot" data-node="' + esc(n.id) + '">' +
           '<circle class="hit" cx="' + x + '" cy="' + y + '" r="13" fill="' + color + '" fill-opacity="' + (offline ? 0.25 : 0.9) +
           '" stroke="' + color + '" stroke-width="' + (offline ? 1.4 : 2) + '" stroke-dasharray="' + (offline ? '3 3' : '0') + '"/>' +
           (n.battery < FF.store.getConfig().health.batteryCriticalPct
             ? '<circle cx="' + (x + 11) + '" cy="' + (y - 11) + '" r="5" fill="#ffc748" stroke="#0b1017" stroke-width="1.4"/>' : '') +
           '<title>' + esc(n.label + ' · risk ' + n.riskScore + ' · ' + n.gas + ' ppm · ' + n.temp + '°C · ' +
             n.humidity + '% RH · batt ' + n.battery + '%' + (offline ? ' · OFFLINE' : '')) + '</title></g>' +
           '<text x="' + x + '" y="' + (y + 27) + '" text-anchor="middle" fill="#7b8fa3" font-size="12" ' +
           'font-family="ui-monospace, monospace">' + esc(n.id.replace('N-', '')) + '</text>';
    });

    /* Furniture goes in the corners the overlays leave free: the legend sits
       bottom-left in HTML, the zoom controls top-right. */
    const sx0 = W - pad - 100, sx1 = W - pad;
    g += '<line x1="' + sx0 + '" y1="' + (H - 26) + '" x2="' + sx1 + '" y2="' + (H - 26) +
         '" stroke="#9fb0c0" stroke-width="2"/>' +
         '<line x1="' + sx0 + '" y1="' + (H - 31) + '" x2="' + sx0 + '" y2="' + (H - 21) + '" stroke="#9fb0c0" stroke-width="2"/>' +
         '<line x1="' + sx1 + '" y1="' + (H - 31) + '" x2="' + sx1 + '" y2="' + (H - 21) + '" stroke="#9fb0c0" stroke-width="2"/>' +
         '<text x="' + (sx0 + 50) + '" y="' + (H - 34) + '" text-anchor="middle" fill="#9fb0c0" font-size="14" ' +
         'font-family="ui-monospace, monospace">100 m</text>' +
         '<g transform="translate(' + (pad - 46) + ',' + (pad - 52) + ')">' +
         '<path d="M0 22 L0 0 M-6 8 L0 0 L6 8" stroke="#9fb0c0" stroke-width="2" fill="none"/>' +
         '<text x="0" y="38" text-anchor="middle" fill="#9fb0c0" font-size="14" font-family="ui-monospace, monospace">N</text></g>';

    container.innerHTML =
      '<svg id="map-svg" viewBox="0 0 ' + U.round(W, 1) + ' ' + U.round(H, 1) + '" ' +
      'style="height:' + (o.height || 520) + 'px">' +
      '<g id="map-layer" transform="translate(' + view.tx + ',' + view.ty + ') scale(' + view.scale + ')">' + g + '</g></svg>';

    wire(container, o, W, H);
  }

  function wire(container, o, W, H) {
    const svg = container.querySelector('#map-svg');
    const layer = container.querySelector('#map-layer');
    if (!svg || !layer) return;

    function apply() {
      layer.setAttribute('transform', 'translate(' + U.round(view.tx, 2) + ',' + U.round(view.ty, 2) + ') scale(' + U.round(view.scale, 4) + ')');
    }

    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
    interacting = false;

    svg.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false; interacting = true;
      sx = e.clientX; sy = e.clientY; ox = view.tx; oy = view.ty;
      svg.classList.add('dragging');
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const k = (W / svg.clientWidth) || 1;
      const dx = (e.clientX - sx) * k, dy = (e.clientY - sy) * k;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      view.tx = ox + dx; view.ty = oy + dy;
      apply();
    });
    function endDrag(e) {
      dragging = false;
      interacting = false;
      svg.classList.remove('dragging');
      if (e && e.pointerId !== undefined && svg.hasPointerCapture && svg.hasPointerCapture(e.pointerId)) {
        svg.releasePointerCapture(e.pointerId);
      }
    }
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('pointerleave', endDrag);

    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      const k = (W / svg.clientWidth) || 1;
      const rect = svg.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * k, my = (e.clientY - rect.top) * k;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = U.clamp(view.scale * factor, 0.5, 6);
      /* Zoom about the cursor. */
      view.tx = mx - ((mx - view.tx) / view.scale) * next;
      view.ty = my - ((my - view.ty) / view.scale) * next;
      view.scale = next;
      apply();
    }, { passive: false });

    container.querySelectorAll('.node-dot').forEach(function (dot) {
      dot.addEventListener('click', function () {
        if (moved) return;
        if (o.onSelect) o.onSelect(dot.getAttribute('data-node'));
      });
    });

    const wrap = container.closest ? container.closest('.map-wrap') : null;
    const ctl = (wrap || container).querySelector('.map-controls');
    if (ctl && !ctl.dataset.wired) {
      ctl.dataset.wired = '1';
      ctl.addEventListener('click', function (e) {
        const act = e.target.getAttribute('data-act');
        if (!act) return;
        if (act === 'in') view.scale = U.clamp(view.scale * 1.25, 0.5, 6);
        if (act === 'out') view.scale = U.clamp(view.scale / 1.25, 0.5, 6);
        if (act === 'reset') { view.scale = 1; view.tx = 0; view.ty = 0; }
        apply();
      });
    }
  }

  function resetView() { view.scale = 1; view.tx = 0; view.ty = 0; }
  function busy() { return interacting; }

  FF.map = { render: render, resetView: resetView, busy: busy };
})(window.FF = window.FF || {});
