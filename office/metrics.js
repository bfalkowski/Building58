// The Metrics page (office/metrics.html): asks GET /metrics of the relay for 1, 7 or 30 days and draws each
// chart as plain SVG, with its own legend, a Table of the same numbers, and a number on hover. A chart with
// no data says "No data yet". The numbers and where they come from are in docs/manual/how-it-works.html#metrics.
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var channel = params.get('channel'), key = params.get('key') || '';
  var NS = 'http://www.w3.org/2000/svg';
  var SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'].map(function (v) { return 'var(' + v + ')'; });
  var $ = function (id) { return document.getElementById(id); };
  var grid = $('grid'), tiles = $('tiles'), tip = $('tip'), status = $('status');
  var range = '7d', data = null;

  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hoursText(h) { return h >= 1 ? (Math.round(h * 10) / 10) + ' h' : Math.round(h * 60) + ' min'; }
  function minutesText(m) { return m === null || m === undefined ? 'none' : hoursText(m / 60); }
  function dayText(d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); }
  function timeText(at) { return range === '1d' ? at.slice(11, 16) : Number(at.slice(5, 7)) + '/' + Number(at.slice(8, 10)) + ' ' + at.slice(11, 13) + 'h'; }
  function sum(list) { return list.reduce(function (a, b) { return a + b; }, 0); }

  function showTip(ev, title, rows) {
    tip.innerHTML = '<b>' + esc(title) + '</b>' + rows.map(function (r) {
      return '<div class="row"><span>' + (r.c ? '<i style="background:' + r.c + '"></i>' : '') + esc(r.k) + '</span><span class="n">' + esc(r.v) + '</span></div>';
    }).join('');
    tip.hidden = false;
    tip.style.left = Math.max(4, Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8)) + 'px';
    tip.style.top = Math.max(4, Math.min(ev.clientY + 14, innerHeight - tip.offsetHeight - 8)) + 'px';
  }
  function hideTip() { tip.hidden = true; }

  function card(id, title, question, wide) {
    var c = document.createElement('section');
    c.className = 'card' + (wide ? ' wide' : '');
    c.id = 'chart-' + id;
    c.dataset.chart = id;
    c.innerHTML = '<header><div><h2>' + esc(title) + '</h2><p class="q">' + esc(question) + '</p></div><button class="tbl-btn" type="button" hidden>Table</button></header>';
    grid.appendChild(c);
    c.W = Math.max(260, Math.round(c.clientWidth - 28));
    return c;
  }
  function legend(c, names, colors) {
    var l = document.createElement('div');
    l.className = 'legend';
    l.innerHTML = names.map(function (n, i) { return '<span><i style="background:' + ((colors && colors[i]) || SERIES[i]) + '"></i>' + esc(n) + '</span>'; }).join('');
    c.appendChild(l);
  }
  function empty(c, words) {
    c.dataset.empty = '1';
    var d = document.createElement('div');
    d.className = 'empty';
    d.textContent = words || 'No data yet';
    c.appendChild(d);
  }
  function table(c, head, rows) {
    var t = document.createElement('table'), b = c.querySelector('.tbl-btn');
    t.className = 'data';
    t.hidden = true;
    t.innerHTML = '<tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>' + rows.map(function (r) { return '<tr>' + r.map(function (x) { return '<td>' + esc(x) + '</td>'; }).join('') + '</tr>'; }).join('');
    c.appendChild(t);
    b.hidden = false;
    b.addEventListener('click', function () {
      t.hidden = !t.hidden;
      b.textContent = t.hidden ? 'Table' : 'Chart';
      c.querySelectorAll('svg, .legend').forEach(function (x) { x.style.display = t.hidden ? '' : 'none'; });
    });
  }
  function axis(svg, W, H, L, B, T, max, steps, fmt) {
    var y = function (v) { return H - B - (v / max) * (H - B - T); };
    for (var g = 0; g <= steps; g++) {
      var v = max * g / steps;
      el('line', { x1: L, x2: W, y1: y(v), y2: y(v), class: g ? 'gl' : 'ax' }, svg);
      el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(v);
    }
    return y;
  }
  function niceMax(top, whole) {
    var max = top * 1.1 || 1;
    return whole ? Math.max(4, Math.ceil(max / 4) * 4) : max;
  }

  function stackedBars(c, labels, series, fmt, options) {
    var o = options || {}, W = c.W, H = 200, L = 38, B = 22, T = 8, n = labels.length;
    var totals = labels.map(function (_, i) { return sum(series.map(function (s) { return s.vals[i]; })); });
    var max = niceMax(Math.max.apply(null, totals.concat(o.line ? [o.line.value] : [])), o.whole);
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': c.querySelector('h2').textContent }, c);
    var y = axis(svg, W, H, L, B, T, max, 4, function (v) { return o.whole ? String(Math.round(v)) : String(Math.round(v * 10) / 10); });
    var bw = (W - L) / n, w = Math.max(3, Math.min(26, bw * 0.62)), every = Math.ceil(n / Math.max(3, Math.floor((W - L) / 56)));
    labels.forEach(function (lab, i) {
      var cx = L + bw * i + bw / 2, acc = 0, hl = el('rect', { x: cx - bw / 2, y: T, width: bw, height: H - B - T, class: 'hl' }, svg);
      series.forEach(function (s, k) {
        var v = s.vals[i];
        if (!v) return;
        var y0 = y(acc), y1 = y(acc + v);
        acc += v;
        el('rect', { x: cx - w / 2, y: y1, width: w, height: Math.max(1, y0 - y1 - (k ? 1 : 0)), rx: 2, fill: SERIES[k], class: 'mark', 'data-series': s.name }, svg);
      });
      if (i % every === 0) el('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = lab;
      var hit = el('rect', { x: cx - bw / 2, y: T, width: bw, height: H - B - T, class: 'hit' }, svg);
      hit.addEventListener('pointermove', function (ev) {
        hl.classList.add('on');
        var rows = series.map(function (s, k) { return { k: s.name, v: fmt(s.vals[i]), c: SERIES[k] }; });
        if (series.length > 1) rows.push({ k: 'Total', v: fmt(totals[i]) });
        if (o.line) rows.push({ k: o.line.name, v: fmt(o.line.value) });
        (o.extra ? o.extra(i) : []).forEach(function (r) { rows.push(r); });
        showTip(ev, lab, rows);
      });
      hit.addEventListener('pointerleave', function () { hl.classList.remove('on'); hideTip(); });
    });
    if (o.line) {
      el('line', { x1: L, x2: W, y1: y(o.line.value), y2: y(o.line.value), stroke: 'var(--pane-strong)', 'stroke-width': 2, 'stroke-dasharray': '5 4', 'pointer-events': 'none' }, svg);
      el('text', { x: L + 4, y: y(o.line.value) - 6, class: 'lbl' }, svg).textContent = o.line.name;
    }
  }

  function hBars(c, rows, fmt, color) {
    var W = c.W, narrow = W < 460, pair = rows.some(function (r) { return r.v2 !== undefined; });
    var barH = narrow ? 14 : 12, rowH = (narrow ? 42 : 26) + (pair ? barH + 2 : 0), L = narrow ? 0 : Math.min(190, Math.round(W * 0.36)), H = rows.length * rowH + 6;
    var max = Math.max.apply(null, rows.map(function (r) { return Math.max(r.v, r.v2 || 0); }).concat([0])) * 1.15 || 1;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': c.querySelector('h2').textContent }, c);
    rows.forEach(function (r, i) {
      var y = i * rowH + 4, room = W - L - 56, by = narrow ? y + 18 : y + 4;
      var hl = el('rect', { x: 0, y: y, width: W, height: rowH - 2, class: 'hl' }, svg);
      if (narrow) el('text', { x: 2, y: y + 12, class: 'lbl' }, svg).textContent = r.k;
      else el('text', { x: L - 8, y: y + (pair ? 14 : 16), 'text-anchor': 'end', class: 'lbl' }, svg).textContent = r.k;
      [[r.v, r.c || color || SERIES[0], by, r.k], [r.v2, r.c2, by + barH + 2, r.k + ' by hand']].forEach(function (b) {
        if (b[0] === undefined) return;
        var w = Math.max(2, (b[0] / max) * room), h = pair ? barH : (narrow ? 14 : rowH - 10);
        el('rect', { x: L, y: b[2], width: w, height: h, rx: 3, fill: b[1], class: 'mark', 'data-series': b[3] }, svg);
        el('text', { x: L + w + 6, y: b[2] + Math.min(h, 12) - (pair ? 1 : 0) }, svg).textContent = fmt(b[0]);
      });
      var hit = el('rect', { x: 0, y: y, width: W, height: rowH - 2, class: 'hit' }, svg);
      hit.addEventListener('pointermove', function (ev) { hl.classList.add('on'); showTip(ev, r.k, (r.tip || [{ k: r.unit || 'Total', v: fmt(r.v) }]).concat(r.extra || [])); });
      hit.addEventListener('pointerleave', function () { hl.classList.remove('on'); hideTip(); });
    });
  }

  function areaIndex(svg, ev, W, L, n) {
    var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
    return Math.max(0, Math.min(n - 1, Math.round((px - L) / (W - L) * (n - 1))));
  }
  function stackedArea(c, xs, series, max, fmt) {
    var W = c.W, H = 190, L = 38, B = 22, T = 8, n = xs.length;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': c.querySelector('h2').textContent }, c);
    var x = function (i) { return n === 1 ? L + (W - L) / 2 : L + (W - L) * i / (n - 1); };
    var y = axis(svg, W, H, L, B, T, max, 3, function (v) { return String(Math.round(v)); });
    var base = xs.map(function () { return 0; });
    series.forEach(function (s, k) {
      var top = s.vals.map(function (v, i) { return base[i] + v; });
      var pad = n === 1 ? 6 : 0;
      var d = 'M' + top.map(function (v, i) { return (x(i) - pad) + ',' + y(v); }).join('L') + (pad ? 'L' + (x(0) + pad) + ',' + y(top[0]) : '') + 'L' + (pad ? (x(0) + pad) + ',' + y(base[0]) + 'L' : '') + base.map(function (v, i) { return (x(i) - pad) + ',' + y(v); }).reverse().join('L') + 'Z';
      el('path', { d: d, fill: s.color || SERIES[k], 'fill-opacity': s.color ? 1 : 0.9, stroke: 'var(--pane)', 'stroke-width': 1.5, 'stroke-linejoin': 'round', class: 'mark', 'data-series': s.name }, svg);
      top.forEach(function (v, i) { base[i] = v; });
    });
    var every = Math.ceil(n / Math.max(3, Math.floor((W - L) / 70)));
    xs.forEach(function (lab, i) { if (i % every === 0) el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = lab; });
    var cross = el('line', { y1: T, y2: H - B, stroke: 'var(--pane-strong)', 'stroke-width': 1, opacity: 0 }, svg);
    var hit = el('rect', { x: L, y: T, width: W - L, height: H - B - T, class: 'hit' }, svg);
    hit.addEventListener('pointermove', function (ev) {
      var i = areaIndex(svg, ev, W, L, n);
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 0.6);
      showTip(ev, xs[i], series.map(function (s, k) { return { k: s.name, v: fmt(s.vals[i]), c: s.color || SERIES[k] }; }).reverse());
    });
    hit.addEventListener('pointerleave', function () { cross.setAttribute('opacity', 0); hideTip(); });
  }
  function lineChart(c, xs, vals, max, fmt, name, color) {
    var W = c.W, H = 150, L = 44, B = 22, T = 8, n = xs.length;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': c.querySelector('h2').textContent }, c);
    var x = function (i) { return n === 1 ? L + (W - L) / 2 : L + (W - L) * i / (n - 1); };
    var y = axis(svg, W, H, L, B, T, max, 2, fmt);
    el('polyline', { points: vals.map(function (v, i) { return x(i) + ',' + y(v); }).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', class: 'mark', 'data-series': name }, svg);
    var every = Math.ceil(n / Math.max(3, Math.floor((W - L) / 70)));
    xs.forEach(function (lab, i) { if (i % every === 0) el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = lab; });
    var cross = el('line', { y1: T, y2: H - B, stroke: 'var(--pane-strong)', 'stroke-width': 1, opacity: 0 }, svg);
    var dot = el('circle', { r: 4, fill: color, stroke: 'var(--pane)', 'stroke-width': 2, opacity: 0 }, svg);
    var hit = el('rect', { x: L, y: T, width: W - L, height: H - B - T, class: 'hit' }, svg);
    hit.addEventListener('pointermove', function (ev) {
      var i = areaIndex(svg, ev, W, L, n);
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 0.6);
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(vals[i])); dot.setAttribute('opacity', 1);
      showTip(ev, xs[i], [{ k: name, v: fmt(vals[i]), c: color }]);
    });
    hit.addEventListener('pointerleave', function () { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip(); });
  }

  function drawTiles(d) {
    var n = d.numbers;
    var list = [
      ['Merged', String(n.merged), 'in ' + d.days + (d.days === 1 ? ' day' : ' days')],
      ['Median time per ticket', minutesText(n.medianMinutes), 'start to merge'],
      ['Waiting on you', hoursText(n.waitingOnYouHours), 'all waits in the range'],
      ['Stalled', hoursText(n.stalledHours), 'all kinds of stall'],
      ['Jams fixed by hand', String(n.jamsFixedByHand), 'in the jam log'],
      ['Merged with no help', n.noHelpShare === null ? 'none yet' : Math.round(n.noHelpShare) + '%', 'of tickets Autopilot started']
    ];
    tiles.innerHTML = list.map(function (t) { return '<div class="tile"><div class="k">' + esc(t[0]) + '</div><div class="v">' + esc(t[1]) + '</div><div class="d">' + esc(t[2]) + '</div></div>'; }).join('');
  }

  function drawMerged(d) {
    var c = card('merged', 'Merged per day', 'How much gets done, and how much needed you to merge it.');
    var days = d.merged.days;
    if (!sum(days.map(function (x) { return x.autopilot + x.person; }))) return empty(c);
    legend(c, ['By Autopilot', 'By you']);
    var labels = days.map(function (x) { return dayText(x.day); });
    stackedBars(c, labels, [{ name: 'By Autopilot', vals: days.map(function (x) { return x.autopilot; }) }, { name: 'By you', vals: days.map(function (x) { return x.person; }) }], String, { whole: true });
    table(c, ['Day', 'By Autopilot', 'By you'], days.map(function (x) { return [x.day, x.autopilot, x.person]; }));
  }
  function drawPerTicket(d) {
    var c = card('per-ticket', 'Time per ticket', 'From start to merge, split into where the time went. The dashed line is the median.', true);
    var tickets = d.perTicket.tickets, parts = Object.keys(d.perTicket.parts), names = parts.map(function (p) { return d.perTicket.parts[p]; });
    if (!tickets.length) return empty(c);
    legend(c, names);
    var hours = function (m) { return hoursText(m / 60); };
    var series = parts.map(function (p, k) { return { name: names[k], vals: tickets.map(function (t) { return t.parts[p]; }) }; });
    stackedBars(c, tickets.map(function (t) { return t.ticket || dayText(t.mergedAt); }), series, hours, { line: { name: 'median ' + minutesText(d.perTicket.medianMinutes), value: d.perTicket.medianMinutes || 0 } });
    table(c, ['Ticket'].concat(names, ['Total']), tickets.map(function (t) { return [t.ticket || t.mergedAt].concat(parts.map(function (p) { return hours(t.parts[p]); }), [hours(t.minutes)]); }));
  }
  function drawWhere(d) {
    var c = card('where', 'Where the time went', 'All merged tickets in the range, summed. Waiting is time no one worked on it.');
    var parts = Object.keys(d.where.parts), rows = parts.map(function (p, k) { return { k: d.where.parts[p], v: d.where.minutes[p], c: SERIES[k], unit: 'Time' }; });
    if (!sum(rows.map(function (r) { return r.v; }))) return empty(c);
    rows.sort(function (a, b) { return b.v - a.v; });
    var fmt = function (m) { return hoursText(m / 60); };
    hBars(c, rows, fmt);
    table(c, ['Part', 'Time'], rows.map(function (r) { return [r.k, fmt(r.v)]; }));
  }
  function drawOutcomes(d) {
    var c = card('outcomes', 'Outcomes', 'How each ticket Autopilot started ended. The top reasons are under each.');
    var counts = d.outcomes.counts, order = [['success', 'Success', SERIES[2]], ['manual', 'Manual', SERIES[3]], ['blocked', 'Blocked', SERIES[1]], ['flawed', 'Flawed', SERIES[4]], ['open', 'Still open', SERIES[5]]];
    if (!sum(order.map(function (o) { return counts[o[0]]; }))) return empty(c);
    var rows = order.map(function (o) {
      var why = d.outcomes.reasons[o[0]] || [];
      return { k: o[1], v: counts[o[0]], c: o[2], unit: 'Tickets', extra: why.map(function (r) { return { k: r.label, v: String(r.count) }; }) };
    });
    hBars(c, rows, String);
    var list = document.createElement('ul');
    list.className = 'reasons';
    list.innerHTML = rows.filter(function (r) { return r.extra.length; }).map(function (r) {
      return '<li><b>' + esc(r.k) + '</b>: ' + r.extra.map(function (x) { return esc(x.k) + ' (' + esc(x.v) + ')'; }).join(', ') + '</li>';
    }).join('');
    c.appendChild(list);
    table(c, ['Outcome', 'Tickets', 'Top reasons'], rows.map(function (r) { return [r.k, r.v, r.extra.map(function (x) { return x.k + ' (' + x.v + ')'; }).join(', ')]; }));
  }
  function drawStalls(d) {
    var c = card('stalls', 'Stalls by kind', 'Hours lost to each kind of stall: those the room detected, and the jams you fixed by hand. The top bar is the bug to fix next.');
    var kinds = d.stalls.kinds;
    if (!kinds.length) return empty(c);
    legend(c, ['Detected by the room', 'Fixed by hand'], [SERIES[1], SERIES[3]]);
    var both = function (k, side) { return side.count + ' (' + hoursText(side.hours) + ')'; };
    var rows = kinds.map(function (k) {
      return { k: k.label, v: k.detected.hours, c: SERIES[1], v2: k.hand.hours, c2: SERIES[3], tip: [{ k: 'Detected', v: both(k, k.detected), c: SERIES[1] }, { k: 'Fixed by hand', v: both(k, k.hand), c: SERIES[3] }] };
    });
    hBars(c, rows, hoursText);
    table(c, ['Stall', 'Detected', 'Detected hours', 'By hand', 'By hand hours'], kinds.map(function (k) { return [k.label, k.detected.count, hoursText(k.detected.hours), k.hand.count, hoursText(k.hand.hours)]; }));
  }
  function drawWaits(d) {
    var c = card('waits', 'Waits on you', 'How often the room waited for you, and why. The tooltip adds how long.');
    var days = d.waits.days, reasons = Object.keys(d.waits.reasons), names = reasons.map(function (r) { return d.waits.reasons[r]; });
    if (!sum(days.map(function (x) { return x.count; }))) return empty(c);
    legend(c, names);
    var series = reasons.map(function (r, k) { return { name: names[k], vals: days.map(function (x) { return x[r]; }) }; });
    stackedBars(c, days.map(function (x) { return dayText(x.day); }), series, String, { whole: true, extra: function (i) { return [{ k: 'Waited', v: hoursText(days[i].minutes / 60) }]; } });
    table(c, ['Day'].concat(names, ['Waited']), days.map(function (x) { return [x.day].concat(reasons.map(function (r) { return x[r]; }), [hoursText(x.minutes / 60)]); }));
  }
  function drawRounds(d) {
    var c = card('rounds', 'Review rounds per PR', 'How many merged PRs took 1, 2, or 3 or more rounds.');
    var rows = d.rounds.prs.map(function (r) { return { k: r.rounds === '1' ? '1 round' : r.rounds === '2' ? '2 rounds' : '3 or more', v: r.count, unit: 'PRs' }; });
    if (!sum(rows.map(function (r) { return r.v; }))) return empty(c);
    hBars(c, rows, String);
    table(c, ['Rounds', 'PRs'], rows.map(function (r) { return [r.k, r.v]; }));
  }
  function drawDesks(d) {
    var c = card('desks', 'Desks over the day', 'What the desks were doing, from a sample every 5 minutes. Times are UTC.', true);
    var pts = d.desks.points, names = ['Working', 'Idle', 'Waiting on you', 'Stuck', 'Free'], keys = ['working', 'idle', 'waiting', 'stuck', 'free'];
    if (!pts.length) return empty(c);
    legend(c, names, [null, null, null, null, 'var(--free)']);
    var xs = pts.map(function (p) { return timeText(p.at); });
    var series = keys.map(function (k, i) { return { name: names[i], vals: pts.map(function (p) { return p[k]; }), color: k === 'free' ? 'var(--free)' : null }; });
    var max = Math.max.apply(null, pts.map(function (p) { return sum(keys.map(function (k) { return p[k]; })); }));
    stackedArea(c, xs, series, Math.max(1, Math.ceil(max)), function (v) { return (Math.round(v * 10) / 10) + ' desks'; });
    table(c, ['Time'].concat(names), pts.map(function (p, i) { return [xs[i]].concat(keys.map(function (k) { return p[k]; })); }));
  }
  function drawLoad(d) {
    var pts = d.load.points, xs = pts.map(function (p) { return timeText(p.at); });
    var cpu = card('cpu', 'Room CPU', 'CPU the room used, as a percent of one core. 100 is one full core.');
    if (!pts.length) empty(cpu, 'No data yet');
    else {
      var cmax = Math.max(100, Math.ceil(Math.max.apply(null, pts.map(function (p) { return p.cpu; })) / 100) * 100);
      lineChart(cpu, xs, pts.map(function (p) { return p.cpu; }), cmax, function (v) { return Math.round(v) + '%'; }, 'CPU', SERIES[0]);
      table(cpu, ['Time', 'CPU %'], pts.map(function (p, i) { return [xs[i], p.cpu]; }));
    }
    var mem = card('memory', 'Room memory', 'Memory the room used, against the most it may use.');
    if (!pts.length) empty(mem, 'No data yet');
    else {
      var mmax = Math.max.apply(null, pts.map(function (p) { return Math.max(p.memoryMb, p.limitMb); }));
      var gb = function (v) { return v >= 1024 ? (Math.round(v / 102.4) / 10) + ' GB' : Math.round(v) + ' MB'; };
      lineChart(mem, xs, pts.map(function (p) { return p.memoryMb; }), mmax, gb, 'Memory', SERIES[2]);
      table(mem, ['Time', 'Memory MB', 'Limit MB'], pts.map(function (p, i) { return [xs[i], p.memoryMb, p.limitMb]; }));
    }
  }
  function drawPm(d) {
    var c = card('pm', 'PM', 'Tickets the PM checked, and the hours of building its holds, closes and merges saved.', true);
    if (!d.pm.available) return empty(c, 'No data yet. This fills in once the PM keeps its verdicts.');
    var days = d.pm.days, names = ['Held', 'Closed', 'Merged', 'Moved'], keys = ['held', 'closed', 'merged', 'moved'];
    legend(c, names);
    var series = keys.map(function (k, i) { return { name: names[i], vals: days.map(function (x) { return x[k]; }) }; });
    stackedBars(c, days.map(function (x) { return dayText(x.day); }), series, String, { whole: true, extra: function (i) { return [{ k: 'Checked', v: String(days[i].checked) }, { k: 'Saved', v: hoursText(days[i].hoursSaved) }]; } });
    table(c, ['Day', 'Checked'].concat(names, ['Hours saved']), days.map(function (x) { return [x.day, x.checked].concat(keys.map(function (k) { return x[k]; }), [x.hoursSaved]); }));
  }

  function draw() {
    grid.innerHTML = '';
    hideTip();
    if (!data) return;
    drawTiles(data);
    [drawMerged, drawPerTicket, drawWhere, drawOutcomes, drawStalls, drawWaits, drawRounds, drawDesks, drawLoad, drawPm].forEach(function (f) { f(data); });
    document.body.dataset.drawn = range;
  }

  function problem(text) { status.textContent = text || ''; status.hidden = !text; }
  var base = location.origin + '/channels/' + encodeURIComponent(channel || '') + '/metrics';
  function url(format) { return base + '?range=' + range + (format ? '&format=' + format : '') + '&key=' + encodeURIComponent(key); }
  function load() {
    document.querySelectorAll('[data-range]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.range === range)); });
    delete document.body.dataset.drawn;
    fetch(url()).then(function (r) { return r.json(); }).catch(function () { return { ok: false, message: 'The relay did not answer.' }; }).then(function (r) {
      if (!r.ok) { data = null; grid.innerHTML = ''; tiles.innerHTML = ''; problem(r.message || 'The relay did not answer.'); return; }
      problem('');
      data = r;
      draw();
    });
  }
  function download(format) {
    fetch(url(format)).then(function (r) { return r.blob(); }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'building58-metrics-' + range + '.' + format;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    });
  }

  document.querySelectorAll('[data-range]').forEach(function (b) { b.addEventListener('click', function () { range = b.dataset.range; load(); }); });
  $('download-csv').addEventListener('click', function () { download('csv'); });
  $('download-json').addEventListener('click', function () { download('json'); });
  var back = $('back');
  if (channel) back.href = 'index.html?channel=' + encodeURIComponent(channel) + (key ? '&key=' + encodeURIComponent(key) : '');
  var width = window.innerWidth, queued = false;
  window.addEventListener('resize', function () {
    if (queued || window.innerWidth === width) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; width = window.innerWidth; draw(); });
  });
  if (!channel) {
    problem('This page needs the channel of your room in its address. Open it with the Metrics link on the room page.');
    document.querySelectorAll('.controls .btn, .controls button').forEach(function (b) { if (!b.hasAttribute('data-page-theme')) b.disabled = true; });
  } else load();
})();
