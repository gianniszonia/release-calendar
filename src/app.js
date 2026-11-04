(function () {
  'use strict';

  /* ======================================================================
     Game Release Radar: IGDB monthly releases as a glassy Tableau data app.
     Live queries only (ds.queryAsync); nothing is baked into the package.
     ====================================================================== */

  var DS_NAME = 'IGDB API';
  var SVGNS = 'http://www.w3.org/2000/svg';

  // Facets filtered server-side (SET filters on the live query).
  var DIMS = [
    { key: 'Platform', label: 'Platform', field: 'Platform', fkey: 'platform', plural: 'Platforms' },
    { key: 'Genre', label: 'Genre', field: 'Genre', fkey: 'genre', plural: 'Genres' },
    { key: 'Theme', label: 'Theme', field: 'theme', fkey: 'theme', plural: 'Themes' },
    { key: 'Mode', label: 'Mode', field: 'Game Mode', fkey: 'mode', plural: 'Modes' },
    { key: 'Company', label: 'Company', field: 'Involved Company', fkey: 'company', plural: 'Companies' },
    { key: 'Engine', label: 'Engine', field: 'Game Engine', fkey: 'engine', plural: 'Engines' },
    { key: 'Keyword', label: 'Keyword', field: 'Keyword', fkey: 'keyword', plural: 'Keywords' }
  ];
  // Facets filtered client-side (already on each release row).
  var LOCAL = [
    { key: 'Released', label: 'Released?', prop: 'released' },
    { key: 'Status', label: 'Status', prop: 'status' }
  ];
  var SIZES = [
    { key: 'hype', label: 'Hype', get: function (g) { return g.hype; }, fmt: function (v) { return fmtInt(v); } },
    { key: 'rating', label: 'Rating', get: function (g) { return g.rating; }, fmt: function (v) { return v > 0 ? nf1.format(v) : '–'; } },
    { key: 'reviews', label: 'Reviews', get: function (g) { return g.reviews; }, fmt: function (v) { return fmtInt(v); } }
  ];
  var WEEKS = ['Days 1–7', 'Days 8–14', 'Days 15–21', 'Days 22–28', 'Days 29–31'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var nf = new Intl.NumberFormat('en-US');
  var nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  var compactNf = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

  var S = {
    ds: null,
    byMonth: new Map(),
    monthCounts: new Map(),
    monthCache: new Map(),
    optionsP: {},
    allMonths: [],
    month: null,
    view: 'bubbles',
    fill: 'color',
    arrange: 'organic',
    size: 'hype',
    server: {},
    local: {},
    options: {},
    search: '',
    selected: null,
    detailCache: new Map(),
    detailToken: 0,
    loadToken: 0,
    loading: false,
    loadedAt: null,
    runDate: null,
    cur: { rel: [], games: [] },
    bub: null,
    pop: null,
    kpiPrev: {}
  };
  DIMS.forEach(function (d) { S.server[d.key] = new Set(); });
  LOCAL.forEach(function (d) { S.local[d.key] = new Set(); });

  var R = {}; // DOM refs
  var root = document.getElementById('app');

  /* ---------------------------------------------------------------- utils */

  function extractData(result) {
    return result && Array.isArray(result.data) ? result.data : [];
  }
  function msg(err) {
    if (!err) return 'unknown error';
    var parts = [];
    if (err.errorCode) parts.push(err.errorCode);
    if (err.message && err.message !== err.errorCode) parts.push(err.message);
    if (err.data) { try { parts.push(typeof err.data === 'string' ? err.data : JSON.stringify(err.data)); } catch (e) { /* ignore */ } }
    return parts.length ? parts.join(': ') : String(err);
  }
  function fmtInt(v) { return nf.format(Math.round(v || 0)); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function sizeDef() { for (var i = 0; i < SIZES.length; i++) if (SIZES[i].key === S.size) return SIZES[i]; return SIZES[0]; }
  function weekIdx(day) { return clamp(Math.floor((day - 1) / 7), 0, 4); }
  function initials(name) {
    var w = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    return (w[0][0] + (w.length > 1 ? w[1][0] : (w[0][1] || ''))).toUpperCase();
  }
  function ymd(s) { var p = s.split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function fmtDate(s, long) {
    var p = ymd(s); var dt = new Date(p.y, p.m - 1, p.d);
    return (long ? DOW_LONG[dt.getDay()] + ', ' : DOW_LONG[dt.getDay()].slice(0, 3) + ', ') + MON3[p.m - 1] + ' ' + p.d + ', ' + p.y;
  }
  function monthName(key) { var p = key.split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0]; }
  function todayKey() {
    var t = new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
  function youtubeId(url) {
    var m = String(url || '').match(/(?:embed\/|watch\?v=|youtu\.be\/)([\w-]{6,})/);
    return m ? m[1] : null;
  }
  function safeUrl(u) { return /^https:\/\//i.test(String(u || '')) ? String(u) : null; }

  function h(tag, props, kids) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, kids);
    return el;
  }
  function sv(tag, attrs, kids) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    if (kids == null) return;
    if (!Array.isArray(kids)) kids = [kids];
    kids.forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  var ICONS = {
    chevL: { p: ['M15 18l-6-6 6-6'] },
    chevR: { p: ['M9 18l6-6-6-6'] },
    chevD: { p: ['M6 9l6 6 6-6'] },
    sun: { p: ['M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41'], c: [[12, 12, 4]] },
    moon: { p: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'] },
    bubbles: { c: [[8.5, 9, 5.5], [17, 15.5, 4], [8.5, 19, 2.5], [18, 5.5, 2]] },
    calendar: { r: [[3, 4.5, 18, 17, 3]], p: ['M16 2.5v4M8 2.5v4M3 10h18'] },
    search: { c: [[11, 11, 7]], p: ['M21 21l-4.3-4.3'] },
    x: { p: ['M18 6L6 18M6 6l12 12'] },
    check: { p: ['M20 6L9 17l-5-5'], w: 3 },
    play: { p: ['M7 4.5v15l13-7.5z'], fill: true },
    ext: { p: ['M14 4h6v6M10 14L20 4M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5'] },
    plus: { p: ['M12 5v14M5 12h14'] },
    minus: { p: ['M5 12h14'] },
    fit: { p: ['M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'] },
    filter: { p: ['M3 5h18l-7 8v6l-4 2v-8z'] },
    pad: { r: [[2, 6.5, 20, 12, 6]], p: ['M7 10.5v4M5 12.5h4'], c: [[15.5, 11.5, 1], [18, 14, 1]] },
    sparkle: { p: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'], fill: true }
  };
  function icon(name, cls) {
    var d = ICONS[name];
    var el = sv('svg', { viewBox: '0 0 24 24', fill: d.fill ? 'currentColor' : 'none', stroke: d.fill ? 'none' : 'currentColor', 'stroke-width': d.w || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: cls || null, 'aria-hidden': 'true' });
    (d.p || []).forEach(function (p) { el.appendChild(sv('path', { d: p })); });
    (d.c || []).forEach(function (c) { el.appendChild(sv('circle', { cx: c[0], cy: c[1], r: c[2] })); });
    (d.r || []).forEach(function (r) { el.appendChild(sv('rect', { x: r[0], y: r[1], width: r[2], height: r[3], rx: r[4] })); });
    return el;
  }

  function toast(text) {
    var t = h('div', { class: 'toast glass', text: text });
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 400); }, 5200);
  }

  function countUp(el, to, fmt) {
    var from = +el.dataset.v || 0;
    el.dataset.v = to;
    if (!isFinite(to)) { el.textContent = fmt(to); return; }
    var t0 = performance.now(), dur = 750;
    function step(t) {
      var k = clamp((t - t0) / dur, 0, 1);
      var e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* --------------------------------------------------------------- theme */

  function getStoredTheme() {
    try { return localStorage.getItem('grr-theme'); } catch (e) { return null; }
  }
  function setTheme(t, animate) {
    var de = document.documentElement;
    if (animate) {
      de.classList.add('theme-anim');
      setTimeout(function () { de.classList.remove('theme-anim'); }, 520);
    }
    de.setAttribute('data-theme', t);
    try { localStorage.setItem('grr-theme', t); } catch (e) { /* storage unavailable */ }
  }

  /* --------------------------------------------------------------- shell */

  function segmented(items, current, onPick, cls) {
    var wrap = h('div', { class: 'seg' + (cls ? ' ' + cls : ''), role: 'tablist' });
    wrap.style.setProperty('--n', items.length);
    var pill = h('span', { class: 'seg-pill' });
    wrap.appendChild(pill);
    var btns = items.map(function (it, i) {
      var b = h('button', { type: 'button', role: 'tab', class: it.key === current ? 'on' : null, onclick: function () { set(it.key); onPick(it.key); } },
        [it.icon ? icon(it.icon) : null, it.label]);
      wrap.appendChild(b);
      return b;
    });
    function set(key) {
      items.forEach(function (it, i) {
        var on = it.key === key;
        btns[i].classList.toggle('on', on);
        btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) wrap.style.setProperty('--i', i);
      });
    }
    set(current);
    wrap.set = set;
    return wrap;
  }

  function buildShell() {
    clear(root);

    // ---- top bar
    R.monthText = h('span', { class: 'ml-text', text: 'Loading…' });
    R.monthBtn = h('button', { class: 'month-label', type: 'button', title: 'Pick a month', onclick: function () { openMonthPicker(R.monthBtn); } }, [R.monthText, icon('chevD')]);
    R.prevBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Previous month', 'aria-label': 'Previous month', onclick: function () { stepMonth(-1); } }, icon('chevL'));
    R.nextBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Next month', 'aria-label': 'Next month', onclick: function () { stepMonth(1); } }, icon('chevR'));

    R.searchInput = h('input', { type: 'search', placeholder: 'Search games…', 'aria-label': 'Search games', autocomplete: 'off' });
    R.search = h('label', { class: 'search' }, [icon('search'), R.searchInput,
      h('button', { class: 'clear-x', type: 'button', 'aria-label': 'Clear search', onclick: function (e) { e.preventDefault(); setSearch(''); R.searchInput.value = ''; } }, icon('x'))]);
    R.searchInput.addEventListener('input', function () { setSearch(R.searchInput.value); });
    R.searchInput.addEventListener('keydown', onSearchKey);
    R.searchInput.addEventListener('focus', function () { if (S.search) openResults(); });

    R.viewSeg = segmented([{ key: 'bubbles', label: 'Bubbles', icon: 'bubbles' }, { key: 'calendar', label: 'Calendar', icon: 'calendar' }], S.view, function (k) {
      if (S.view === k) return;
      S.view = k;
      closeSheet();
      renderStage();
    });

    var themeBtn = h('button', { class: 'theme-toggle', type: 'button', title: 'Toggle light / dark', 'aria-label': 'Toggle light or dark mode', onclick: function () {
      setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light', true);
    } }, [icon('moon', 'i-moon'), icon('sun', 'i-sun')]);

    var top = h('header', { class: 'topbar glass fade-up' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'brand-icon' }, icon('pad')),
        h('div', null, [h('div', { class: 'brand-title', text: 'Release Radar' }), h('div', { class: 'brand-sub', text: 'Upcoming games from IGDB' })])
      ]),
      h('div', { class: 'month-nav' }, [R.prevBtn, R.monthBtn, R.nextBtn]),
      h('div', { class: 'top-actions' }, [R.search, R.viewSeg, themeBtn])
    ]);

    // ---- KPIs
    R.kpis = {};
    var kdefs = [
      { key: 'games', label: 'Games releasing', tint: 'var(--accent)' },
      { key: 'hype', label: 'Total hype', tint: 'var(--w4)' },
      { key: 'rating', label: 'Avg. rating', tint: 'var(--w0)' },
      { key: 'first', label: 'First releases', tint: 'var(--w2)' },
      { key: 'busy', label: 'Busiest day', tint: 'var(--w1)' }
    ];
    var kpiWrap = h('section', { class: 'kpis' });
    kdefs.forEach(function (d, i) {
      var val = h('div', { class: 'kpi-value', text: '0' });
      var sub = h('div', { class: 'kpi-sub', text: ' ' });
      var card = h('div', { class: 'kpi glass fade-up', style: '--kpi-tint:' + d.tint + ';animation-delay:' + (60 + i * 60) + 'ms' },
        [h('div', { class: 'kpi-label' }, [h('span', { class: 'dot' }), d.label]), val, sub]);
      R.kpis[d.key] = { val: val, sub: sub };
      kpiWrap.appendChild(card);
    });

    // ---- filters
    R.filters = h('section', { class: 'filters glass fade-up', style: 'animation-delay:180ms' });

    // ---- stage
    R.stageTitle = h('div', { class: 'stage-title', text: '' });
    R.stageSub = h('div', { class: 'stage-sub', text: '' });
    R.sizeSeg = segmented(SIZES, S.size, function (k) { S.size = k; renderStage(); renderDetailMetricsOnly(); });
    R.sizeLabel = h('span', { text: 'Size by' });
    R.sizeCtl = h('div', { class: 'size-ctl', title: 'Bubbles: circle size. Calendar: which games each day shows first.' }, [R.sizeLabel, R.sizeSeg]);
    R.fillSeg = segmented([{ key: 'color', label: 'Color' }, { key: 'cover', label: 'Cover art' }], S.fill, function (k) {
      if (S.fill === k) return;
      S.fill = k;
      renderStage();
    });
    R.fillCtl = h('div', { class: 'size-ctl' }, [h('span', { text: 'Circles' }), R.fillSeg]);
    R.arrangeSeg = segmented([{ key: 'organic', label: 'Organic' }, { key: 'rows', label: 'Rows' }], S.arrange, function (k) {
      if (S.arrange === k) return;
      S.arrange = k;
      renderStage();
    });
    R.arrangeCtl = h('div', { class: 'size-ctl' }, [h('span', { text: 'Layout' }), R.arrangeSeg]);
    R.stageBody = h('div', { class: 'stage-body' });
    R.tip = h('div', { class: 'tip glass' });
    R.stage = h('section', { class: 'stage glass fade-up', style: 'animation-delay:240ms' }, [
      h('div', { class: 'stage-bar' }, [h('div', null, [R.stageTitle, R.stageSub]), h('div', { class: 'grow' }), R.arrangeCtl, R.fillCtl, R.sizeCtl]),
      R.stageBody,
      R.tip,
      h('div', { class: 'loader' }, h('div', null, [h('div', { class: 'spinner' }), h('div', { class: 'loader-text', text: 'Querying IGDB live…' })]))
    ]);

    // ---- detail
    R.detailInner = h('div', { class: 'detail-inner' }, h('div', { class: 'detail-empty', text: 'Select a game to see its details.' }));
    R.detail = h('aside', { class: 'detail glass fade-up', style: 'animation-delay:300ms', 'aria-live': 'polite' }, h('div', { class: 'detail-scroll' }, R.detailInner));

    // ---- footer
    R.footer = h('footer', { class: 'footer' });

    // gradient defs for rating ring (shared, hidden)
    var defs = sv('svg', { width: 0, height: 0, style: 'position:absolute', 'aria-hidden': 'true' }, sv('defs', null,
      sv('linearGradient', { id: 'ringGrad', x1: '0', y1: '0', x2: '1', y2: '1' }, [sv('stop', { offset: '0%', 'stop-color': '#ffd60a' }), sv('stop', { offset: '100%', 'stop-color': '#ff9f0a' })])));

    append(root, [defs, top, kpiWrap, R.filters, h('main', { class: 'content' }, [R.stage, R.detail]), R.footer]);
    renderFilters();
    renderFooter();

    document.addEventListener('mousedown', function (e) {
      if (S.pop && !S.pop.el.contains(e.target) && !(S.pop.anchor && S.pop.anchor.contains(e.target))) closePopover();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (S.pop) closePopover(); else if (R.sheet) closeSheet(); return; }
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || S.pop) return;
      if (e.key === 'ArrowLeft') stepMonth(-1);
      if (e.key === 'ArrowRight') stepMonth(1);
    });
    var rz;
    // Re-flow the bubbles to the new panel shape (debounced, without replaying the entry animation).
    window.addEventListener('resize', function () {
      clearTimeout(rz);
      rz = setTimeout(function () {
        var wasFallback = root.classList.contains('scroll-fallback');
        checkFit();
        var b = S.bub;
        if (S.view !== 'bubbles' || !b) return;
        if (wasFallback !== root.classList.contains('scroll-fallback')) { drawBubbles(); S.bub && S.bub.svg.classList.add('no-anim'); applySearchDim(); return; }
        var w = R.stageBody.clientWidth, hh = R.stageBody.clientHeight;
        if (Math.abs(w - b.W) / b.W < 0.06 && Math.abs(hh - b.H) / b.H < 0.06) { updateLabels(); return; }
        drawBubbles();
        if (S.bub) S.bub.svg.classList.add('no-anim');
        applySearchDim();
      }, 220);
    });
  }

  function setLoading(on) {
    S.loading = on;
    root.classList.toggle('loading', on);
  }

  function fatal(text) {
    setLoading(false);
    clear(R.stageBody || root);
    var box = h('div', { class: 'empty' }, h('div', null, [
      h('div', { class: 'empty-icon' }, icon('x')),
      h('h3', { text: 'Live query unavailable' }),
      h('p', { class: 'error', text: text }),
      S.ds ? h('button', { type: 'button', class: 'btn primary', text: 'Try again', onclick: function () { clear(R.stageBody); loadAll(true); } }) : null
    ]));
    (R.stageBody || root).appendChild(box);
  }

  /* -------------------------------------------------------------- queries */

  function getDataSources() {
    var wb = tableau.extensions.workbook;
    if (wb && typeof wb.getAllDataSourcesAsync === 'function') return wb.getAllDataSourcesAsync();
    var wc = tableau.extensions.worksheetContent;
    if (wc && wc.worksheet && typeof wc.worksheet.getDataSourcesAsync === 'function') return wc.worksheet.getDataSourcesAsync();
    return Promise.resolve([]);
  }
  function pickDataSource(list) {
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) if (list[i].name === DS_NAME) return list[i];
    return list[0];
  }
  // All queries run one at a time (the VizQL Data Service rate-limits per site), after a single
  // metadata read. Usage-limit errors are retried once after a pause.
  var qChain = null;
  function ready() {
    if (!S.metaP) {
      S.metaP = (typeof S.ds.readMetadataAsync === 'function' ? S.ds.readMetadataAsync() : Promise.resolve())
        .then(function () {}, function () {});
    }
    return S.metaP;
  }
  function isLimitErr(err) { return /limit|429|too many|throttl/i.test(msg(err)); }
  function query(fields, filters) {
    var q = { fields: fields };
    if (filters && filters.length) q.filters = filters;
    function run() { return S.ds.queryAsync(q).then(extractData); }
    function runWithRetry() {
      return run().catch(function (err) {
        if (!isLimitErr(err)) throw err;
        return new Promise(function (res) { setTimeout(res, 4000); }).then(run);
      });
    }
    var p = (qChain || ready()).then(runWithRetry, runWithRetry);
    qChain = p.then(function () {}, function () {});
    return p;
  }
  function tryQueries(list) {
    var i = 0, lastErr;
    function next() {
      if (i >= list.length) return Promise.reject(lastErr);
      var it = list[i++];
      return query(it[0], it[1]).catch(function (err) { lastErr = err; if (isLimitErr(err)) throw err; return next(); });
    }
    return next();
  }
  function serverFilters() {
    var out = [];
    DIMS.forEach(function (d) {
      var set = S.server[d.key];
      if (set.size) out.push({ field: { fieldCaption: d.field }, filterType: 'SET', values: Array.from(set), exclude: false });
    });
    return out;
  }

  /* ------------------------------------------------------------ data load
     The app reads a packaged snapshot of the IGDB API extract (src/igdb-data.js sets
     window.IGDB_DATA). No VizQL queries at all: filtering, month switching, search and details
     all run in the browser. Regenerate the snapshot with Resources/.agents/tools/build_data.py. */

  function filterSig() {
    return DIMS.map(function (d) { return d.key + '=' + Array.from(S.server[d.key]).sort().join('\u0001'); }).join('|');
  }

  function loadSnapshot() {
    var D = window.IGDB_DATA;
    if (!D || !Array.isArray(D.games) || !Array.isArray(D.releases)) throw new Error('Data snapshot (igdb-data.js) is missing or invalid.');
    var fIndex = {};
    D.facets.forEach(function (k, i) { fIndex[k] = 9 + i; });
    S.runDate = D.runDate;
    S.topN = +D.topPerMonth || 0;
    S.monthTotals = D.monthTotals || {};

    // games: [id, name, urlSlug, coverCode, videoId, hype, rating, reviews, summary, ...facet index arrays]
    var counts = {};
    DIMS.forEach(function (d) { counts[d.key] = new Array(D.dict[d.fkey].length).fill(0); });
    S.gameInfo = D.games.map(function (r) {
      var info = { id: r[0], name: r[1] || 'Untitled', summary: r[8] || '', facets: {} };
      info.url = r[2] ? (/^https:\/\//.test(r[2]) ? r[2] : D.urlPrefix + r[2]) : null;
      info.cover = r[3] ? (/^https:\/\//.test(r[3]) ? r[3] : D.coverPrefix + r[3]) : null;
      info.video = r[4] ? 'https://www.youtube.com/embed/' + r[4] : null;
      info.hype = +r[5] || 0; info.rating = +r[6] || 0; info.reviews = +r[7] || 0;
      DIMS.forEach(function (d) {
        var idx = r[fIndex[d.fkey]] || [];
        var dict = D.dict[d.fkey];
        info.facets[d.key] = idx.map(function (i) { counts[d.key][i]++; return dict[i]; });
        info.facets[d.key].set = new Set(info.facets[d.key]);
      });
      return info;
    });
    DIMS.forEach(function (d) {
      S.options[d.key] = D.dict[d.fkey].map(function (v, i) { return { v: v, n: counts[d.key][i] }; })
        .filter(function (o) { return o.n > 0; })
        .sort(function (a, b) { return b.n - a.n || String(a.v).localeCompare(String(b.v)); });
    });

    // releases: [gameIndex, 'YYYY-MM-DD', flags (1 first, 2 re-release), [status indexes]]
    S.byMonth = new Map();
    D.releases.forEach(function (r) {
      var gi = S.gameInfo[r[0]];
      var d = String(r[1] || '');
      if (!gi || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      var g = {
        key: gi.id + '|' + d, id: gi.id, name: gi.name, date: d, month: d.slice(0, 7), day: +d.slice(8, 10),
        released: new Set(), status: new Set(),
        cover: gi.cover, video: gi.video, url: gi.url,
        hype: gi.hype, rating: gi.rating, reviews: gi.reviews, info: gi
      };
      if (r[2] & 1) g.released.add('First Release');
      if (r[2] & 2) g.released.add('Re-Release');
      (r[3] || []).forEach(function (si) { g.status.add(D.dict.status[si]); });
      if (!g.status.size) g.status.add('Unknown');
      var l = S.byMonth.get(g.month);
      if (!l) S.byMonth.set(g.month, l = []);
      l.push(g);
    });
    S.allMonths = Array.from(S.byMonth.keys()).sort();
    S.monthCounts = new Map();
    S.byMonth.forEach(function (l, k) { S.monthCounts.set(k, uniqueGames(l).length); });
  }

  function loadAll(initial) {
    try {
      if (initial) loadSnapshot();
      if (initial || !S.month || !S.byMonth.has(S.month)) S.month = defaultMonth();
      S.loadedAt = new Date();
      setLoading(false);
      render(true);
      renderFooter();
    } catch (err) {
      setLoading(false);
      fatal(msg(err));
    }
    return Promise.resolve();
  }
  function loadMonth() { return Promise.resolve(); }
  function loadOptions() { return Promise.resolve(); }
  function friendly(err) { return msg(err); }

  function loadDetails(id) {
    var gi = null;
    for (var i = 0; i < S.gameInfo.length; i++) if (S.gameInfo[i].id === id) { gi = S.gameInfo[i]; break; }
    var out = { summary: gi ? gi.summary : '' };
    DIMS.forEach(function (d) { out[d.key] = gi ? gi.facets[d.key].slice().sort(function (a, b) { return String(a).localeCompare(String(b)); }) : []; });
    return Promise.resolve(out);
  }

  /* --------------------------------------------------------------- ingest */

  function ingest(rows) {
    var map = new Map();
    rows.forEach(function (r) {
      var id = r.id;
      var d = String(r.date || '').slice(0, 10);
      if (id == null || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      var k = id + '|' + d;
      var g = map.get(k);
      if (!g) {
        g = {
          key: k, id: id, name: r.name || 'Untitled', date: d, month: d.slice(0, 7), day: +d.slice(8, 10),
          released: new Set(), status: new Set(),
          cover: safeUrl(r.cover), video: safeUrl(r.video), url: safeUrl(r.url),
          hype: 0, rating: 0, reviews: 0
        };
        map.set(k, g);
      }
      if (r.rel) g.released.add(String(r.rel).trim());
      g.status.add(r.status ? String(r.status).trim() : 'Unknown');
      g.hype = Math.max(g.hype, +r.hype || 0);
      g.rating = Math.max(g.rating, +r.rating || 0);
      g.reviews = Math.max(g.reviews, +r.reviews || 0);
      if (!g.cover && r.cover) g.cover = safeUrl(r.cover);
      if (!g.video && r.video) g.video = safeUrl(r.video);
    });
    return Array.from(map.values());
  }

  function defaultMonth() {
    var t = todayKey().slice(0, 7);
    if (S.monthCounts.has(t)) return t;
    var future = S.allMonths.filter(function (m) { return m >= t; });
    return future[0] || S.allMonths[S.allMonths.length - 1] || t;
  }

  function passLocal(g) {
    for (var j = 0; j < DIMS.length; j++) {
      var fs = S.server[DIMS[j].key];
      if (!fs.size) continue;
      var have = g.info && g.info.facets[DIMS[j].key].set;
      var hit = false;
      if (have) fs.forEach(function (v) { if (have.has(v)) hit = true; });
      if (!hit) return false;
    }
    for (var i = 0; i < LOCAL.length; i++) {
      var set = S.local[LOCAL[i].key];
      if (!set.size) continue;
      var ok = false;
      g[LOCAL[i].prop].forEach(function (v) { if (set.has(v)) ok = true; });
      if (!ok) return false;
    }
    return true;
  }
  function uniqueGames(rel) {
    var m = new Map();
    rel.forEach(function (g) { var e = m.get(g.id); if (!e || g.date < e.date) m.set(g.id, g); });
    return Array.from(m.values());
  }
  // Loaded months use exact counts (incl. Released?/Status filters); others use the month index.
  function monthGameCount(month) {
    var l = S.byMonth.get(month);
    if (!l) return S.monthCounts.get(month) || 0;
    var ids = new Set();
    l.forEach(function (g) { if (passLocal(g)) ids.add(g.id); });
    return ids.size;
  }

  /* --------------------------------------------------------------- render */

  // The page normally fits one screen exactly. If the header rows wrap (mid-size windows) and
  // leave the main panel too short, fall back to a scrolling page with a fixed-height panel.
  function checkFit() {
    root.classList.remove('scroll-fallback');
    if (R.stage && R.stage.getBoundingClientRect().height < 430) root.classList.add('scroll-fallback');
  }

  function render(dataChanged) {
    var rel = (S.byMonth.get(S.month) || []).filter(passLocal);
    S.cur = { rel: rel, games: uniqueGames(rel) };
    renderMonth();
    renderKpis();
    renderFilters();
    checkFit();
    renderStage();
    ensureSelection(dataChanged);
  }

  function renderMonth() {
    if (!S.month) return;
    if (R.monthText.textContent !== monthName(S.month)) {
      R.monthText.textContent = monthName(S.month);
      R.monthText.classList.remove('swap'); void R.monthText.offsetWidth; R.monthText.classList.add('swap');
    }
    var i = S.allMonths.indexOf(S.month);
    R.prevBtn.disabled = i <= 0;
    R.nextBtn.disabled = i < 0 || i >= S.allMonths.length - 1;
  }

  function setMonth(key) {
    if (!key || key === S.month) return Promise.resolve();
    S.month = key;
    S.selected = null;
    closeSheet();
    renderMonth();
    var token = ++S.loadToken;
    var cached = true; // snapshot: every month is already in memory
    if (!cached) setLoading(true);
    return loadMonth(key).then(function () {
      if (token !== S.loadToken) return;
      setLoading(false);
      render(false);
    }).catch(function (err) {
      if (token !== S.loadToken) return;
      setLoading(false);
      S.byMonth.delete(key);
      render(false);
      toast('Could not load ' + monthName(key) + ': ' + friendly(err));
    });
  }
  function stepMonth(dir) {
    var i = S.allMonths.indexOf(S.month);
    var n = S.allMonths[i + dir];
    if (n) setMonth(n);
  }

  function renderKpis() {
    var games = S.cur.games, rel = S.cur.rel;
    var n = games.length;

    // games + delta vs previous calendar month
    countUp(R.kpis.games.val, n, fmtInt);
    var p = S.month.split('-'); var py = +p[0], pm = +p[1] - 1;
    if (pm === 0) { pm = 12; py--; }
    var prevKey = py + '-' + String(pm).padStart(2, '0');
    var prevN = monthGameCount(prevKey);
    clear(R.kpis.games.sub);
    var total = S.monthTotals && S.monthTotals[S.month];
    if (S.topN && total > S.topN) {
      R.kpis.games.sub.textContent = 'top ' + fmtInt(S.topN) + ' of ' + fmtInt(total) + ' releasing';
    } else if (prevN > 0) {
      var ch = (n - prevN) / prevN;
      append(R.kpis.games.sub, [h('span', { class: ch >= 0 ? 'up' : 'down', text: (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(ch * 100)) + '%' }), ' vs ' + MON3[pm - 1]]);
    } else {
      R.kpis.games.sub.textContent = 'in ' + monthName(S.month);
    }

    // total hype + most hyped
    var hype = 0, top = null;
    games.forEach(function (g) { hype += g.hype; if (!top || g.hype > top.hype) top = g; });
    countUp(R.kpis.hype.val, hype, function (v) { return v >= 10000 ? compactNf.format(v) : fmtInt(v); });
    R.kpis.hype.sub.textContent = top && top.hype > 0 ? 'Top: ' + top.name : 'No hype recorded yet';

    // average rating among rated games
    var rs = 0, rn = 0;
    games.forEach(function (g) { if (g.rating > 0) { rs += g.rating; rn++; } });
    if (rn) countUp(R.kpis.rating.val, rs / rn, function (v) { return nf1.format(v); });
    else { R.kpis.rating.val.dataset.v = 0; R.kpis.rating.val.textContent = '–'; }
    R.kpis.rating.sub.textContent = rn ? fmtInt(rn) + ' rated game' + (rn === 1 ? '' : 's') : 'No ratings yet';

    // first-release share
    var first = 0;
    games.forEach(function (g) { if (g.released.has('First Release')) first++; });
    var pct = n ? first / n * 100 : 0;
    countUp(R.kpis.first.val, pct, function (v) { return Math.round(v) + '%'; });
    R.kpis.first.sub.textContent = fmtInt(n - first) + ' re-release' + (n - first === 1 ? '' : 's');

    // busiest day
    var byDay = {};
    var seen = new Set();
    rel.forEach(function (g) { var k = g.id + '|' + g.day; if (seen.has(k)) return; seen.add(k); byDay[g.day] = (byDay[g.day] || 0) + 1; });
    var bd = null, bc = 0;
    Object.keys(byDay).forEach(function (d) { if (byDay[d] > bc) { bc = byDay[d]; bd = +d; } });
    if (bd) {
      var pp = S.month.split('-');
      R.kpis.busy.val.textContent = MON3[+pp[1] - 1] + ' ' + bd;
      R.kpis.busy.sub.textContent = fmtInt(bc) + ' releases · ' + DOW_LONG[new Date(+pp[0], +pp[1] - 1, bd).getDay()];
    } else {
      R.kpis.busy.val.textContent = '–';
      R.kpis.busy.sub.textContent = 'No releases';
    }
  }

  /* -------------------------------------------------------------- filters */

  function anyFilter() {
    return DIMS.some(function (d) { return S.server[d.key].size; }) || LOCAL.some(function (d) { return S.local[d.key].size; });
  }

  function chipValue(set) {
    if (!set.size) return 'All';
    var first = Array.from(set)[0];
    return set.size === 1 ? String(first) : set.size + ' selected';
  }

  function renderFilters() {
    if (!R.filters) return;
    clear(R.filters);
    R.filters.appendChild(h('div', { class: 'filters-title' }, [icon('filter'), 'Filters']));
    DIMS.forEach(function (d) {
      var set = S.server[d.key];
      var chip = h('button', { type: 'button', class: 'chip' + (set.size ? ' active' : ''), title: 'Filter by ' + d.label },
        [h('span', { class: 'c-label', text: d.label }), h('span', { class: 'c-value', text: chipValue(set) }), icon('chevD')]);
      chip.addEventListener('click', function () { openFilter(d, true, chip); });
      R.filters.appendChild(chip);
    });
    LOCAL.forEach(function (d) {
      var set = S.local[d.key];
      var chip = h('button', { type: 'button', class: 'chip' + (set.size ? ' active' : ''), title: 'Filter by ' + d.label },
        [h('span', { class: 'c-label', text: d.label }), h('span', { class: 'c-value', text: chipValue(set) }), icon('chevD')]);
      chip.addEventListener('click', function () { openFilter(d, false, chip); });
      R.filters.appendChild(chip);
    });
    R.filters.appendChild(h('div', { class: 'spacer' }));
    if (anyFilter()) {
      R.filters.appendChild(h('button', { type: 'button', class: 'chip reset', onclick: resetFilters, text: 'Reset all' }));
    } else {
      R.filters.appendChild(h('span', { class: 'hint', text: '← → to change month' }));
    }
  }

  function resetFilters() {
    var hadServer = DIMS.some(function (d) { return S.server[d.key].size; });
    DIMS.forEach(function (d) { S.server[d.key] = new Set(); });
    LOCAL.forEach(function (d) { S.local[d.key] = new Set(); });
    if (hadServer) loadAll(false); else render(false);
  }

  function localOptions(d) {
    var counts = new Map();
    var l = S.byMonth.get(S.month) || [];
    var seen = new Set();
    l.forEach(function (g) {
      g[d.prop].forEach(function (v) {
        var k = v + '|' + g.id;
        if (seen.has(k)) return;
        seen.add(k);
        counts.set(v, (counts.get(v) || 0) + 1);
      });
    });
    S.local[d.key].forEach(function (v) { if (!counts.has(v)) counts.set(v, 0); });
    return Array.from(counts, function (e) { return { v: e[0], n: e[1] }; }).sort(function (a, b) { return b.n - a.n; });
  }

  function addServerFilter(key, value) {
    S.server[key].add(value);
    loadAll(false);
    toast('Filtered by ' + key + ': ' + value);
  }

  function openFilter(d, isServer, anchor) {
    if (S.pop && S.pop.anchor === anchor) { closePopover(); return; }
    var set = isServer ? S.server[d.key] : S.local[d.key];
    var draft = new Set(set);
    var input = h('input', { type: 'text', placeholder: 'Search ' + d.label.toLowerCase() + '…' });
    var list = h('div', { class: 'pop-list' });
    var meta = h('span', { class: 'pop-meta' });
    var LIMIT = 250;

    function commitLocal() { S.local[d.key] = new Set(draft); render(false); }
    function draw() {
      clear(list);
      var opts = isServer ? S.options[d.key] : localOptions(d);
      if (!opts) { list.appendChild(h('div', { class: 'pop-note', text: 'Loading values…' })); meta.textContent = ''; return; }
      meta.textContent = draft.size ? draft.size + ' selected' : nf.format(opts.length) + ' values';
      var q = input.value.trim().toLowerCase();
      var match = opts.filter(function (o) { return !q || String(o.v).toLowerCase().indexOf(q) >= 0; });
      var sel = match.filter(function (o) { return draft.has(o.v); });
      var rest = match.filter(function (o) { return !draft.has(o.v); });
      var shown = sel.concat(rest).slice(0, LIMIT);
      shown.forEach(function (o) {
        var on = draft.has(o.v);
        list.appendChild(h('button', { type: 'button', class: 'opt' + (on ? ' on' : ''), onclick: function () {
          if (draft.has(o.v)) draft.delete(o.v); else draft.add(o.v);
          if (!isServer) commitLocal();
          draw();
        } }, [h('span', { class: 'check' }, on ? icon('check') : null), h('span', { class: 'opt-label', text: String(o.v), title: String(o.v) }), h('span', { class: 'opt-n', text: compactNf.format(o.n) })]));
      });
      if (!match.length) list.appendChild(h('div', { class: 'pop-note', text: 'No matches' }));
      else if (match.length > LIMIT) list.appendChild(h('div', { class: 'pop-note', text: 'Showing ' + LIMIT + ' of ' + nf.format(match.length) + ', type to narrow' }));
    }
    input.addEventListener('input', draw);

    openPopover(anchor, 'popover', function (pop) {
      append(pop, [
        h('div', { class: 'pop-head' }, [h('span', { class: 'pop-title', text: d.label }), meta]),
        h('label', { class: 'pop-search' }, [icon('search'), input]),
        list,
        h('div', { class: 'pop-foot' }, [
          h('button', { type: 'button', class: 'btn', text: 'Clear', onclick: function () { draft.clear(); if (!isServer) commitLocal(); draw(); } }),
          h('button', { type: 'button', class: 'btn primary', text: isServer ? 'Apply' : 'Done', onclick: closePopover })
        ])
      ]);
      draw();
      if (isServer) loadOptions(d);
      setTimeout(function () { input.focus(); }, 30);
    }, function onClose() {
      if (!isServer) { renderFilters(); return; }
      var changed = draft.size !== set.size || Array.from(draft).some(function (v) { return !set.has(v); });
      if (changed) { S.server[d.key] = new Set(draft); renderFilters(); loadAll(false); }
    }, { key: d.key, redraw: draw });
  }

  function openPopover(anchor, cls, build, onClose, extra) {
    closePopover();
    var pop = h('div', { class: cls + ' glass', role: 'dialog' });
    build(pop);
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    var w = pop.offsetWidth;
    var left = clamp(r.left + window.scrollX, 8 + window.scrollX, window.scrollX + document.documentElement.clientWidth - w - 8);
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + window.scrollY + 8) + 'px';
    S.pop = { el: pop, anchor: anchor, onClose: onClose, key: extra && extra.key, redraw: extra && extra.redraw };
    requestAnimationFrame(function () { pop.classList.add('open'); });
    return pop;
  }
  function closePopover() {
    if (!S.pop) return;
    var p = S.pop;
    S.pop = null;
    p.el.classList.remove('open');
    setTimeout(function () { p.el.remove(); }, 200);
    if (p.onClose) p.onClose();
  }

  function openMonthPicker(anchor) {
    if (S.pop && S.pop.anchor === anchor) { closePopover(); return; }
    openPopover(anchor, 'popover month-pop', function (pop) {
      var years = {};
      S.allMonths.forEach(function (m) { years[m.slice(0, 4)] = true; });
      pop.appendChild(h('div', { class: 'pop-head' }, [h('span', { class: 'pop-title', text: 'Jump to month' }), h('span', { class: 'pop-meta', text: 'games per month' })]));
      var list = h('div', { class: 'pop-list' });
      Object.keys(years).sort().forEach(function (y) {
        list.appendChild(h('div', { class: 'mp-year', text: y }));
        var grid = h('div', { class: 'mp-grid' });
        for (var m = 1; m <= 12; m++) {
          (function (key, m) {
            var c = monthGameCount(key);
            var has = S.allMonths.indexOf(key) >= 0;
            grid.appendChild(h('button', { type: 'button', class: 'mp-cell' + (key === S.month ? ' on' : ''), disabled: !has, onclick: function () { closePopover(); setMonth(key); } },
              [h('b', { text: MON3[m - 1] }), h('span', { text: has ? compactNf.format(c) : '–' })]));
          })(y + '-' + String(m).padStart(2, '0'), m);
        }
        list.appendChild(grid);
      });
      pop.appendChild(list);
    });
  }

  /* --------------------------------------------------------------- search */

  var resultsState = { items: [], kb: -1 };

  function setSearch(v) {
    S.search = v.trim().toLowerCase();
    R.search.classList.toggle('has-text', !!v);
    applySearchDim();
    if (S.search) openResults(); else if (S.pop && S.pop.anchor === R.search) closePopover();
  }

  // Local matches come from months already loaded; "search all months" runs one server query.
  var remoteSearch = new Map();
  function searchMatches() {
    var q = S.search;
    if (!q) return [];
    var seen = new Set();
    var out = [];
    function consider(g) {
      if (g.name.toLowerCase().indexOf(q) < 0 || seen.has(g.id)) return;
      seen.add(g.id);
      out.push(g);
    }
    S.byMonth.forEach(function (list) { list.forEach(consider); });
    var rem = remoteSearch.get(q + '#' + filterSig());
    if (rem && Array.isArray(rem)) rem.forEach(consider);
    out.sort(function (a, b) {
      var am = a.month === S.month ? 0 : 1, bm = b.month === S.month ? 0 : 1;
      var ap = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1, bp = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      return am - bm || ap - bp || b.hype - a.hype || a.name.localeCompare(b.name);
    });
    return out.slice(0, 8);
  }

  function openResults() {
    var items = searchMatches();
    resultsState = { items: items, kb: -1 };
    var existing = S.pop && S.pop.anchor === R.search ? S.pop.el : null;
    var rkey = S.search + '#' + filterSig();
    var rstate = remoteSearch.get(rkey);
    function fill(pop) {
      clear(pop);
      if (!items.length) pop.appendChild(h('div', { class: 'pop-note', text: rstate === 'loading' ? 'Searching all months…' : 'No games match "' + S.search + '"' }));
      if (!rstate && S.search.length >= 2 && !window.IGDB_DATA) {
        pop.appendChild(h('button', { type: 'button', class: 'result', onmousedown: function (e) { e.preventDefault(); runRemoteSearch(); } }, [
          h('span', { class: 'avatar', style: 'background:var(--accent)' }, icon('search')),
          h('span', { class: 'r-main' }, [h('div', { class: 'r-name', text: 'Search all months for "' + S.search + '"' }), h('div', { class: 'r-meta', text: 'Runs one live query' })])
        ]));
      }
      items.forEach(function (g, i) {
        pop.appendChild(h('button', { type: 'button', class: 'result', 'data-i': i, onmousedown: function (e) { e.preventDefault(); pickResult(g); } }, [
          h('span', { class: 'avatar w' + weekIdx(g.day), text: initials(g.name) }),
          h('span', { class: 'r-main' }, [h('div', { class: 'r-name', text: g.name }), h('div', { class: 'r-meta', text: fmtDate(g.date) + (g.month === S.month ? ' · this month' : '') })]),
          h('span', { class: 'r-hype', text: '♥ ' + fmtInt(g.hype) })
        ]));
      });
    }
    if (existing) { fill(existing); return; }
    openPopover(R.search, 'popover results', fill);
  }

  function runRemoteSearch() {
    var q = S.search;
    if (!q || q.length < 2) return;
    var key = q + '#' + filterSig();
    if (remoteSearch.has(key)) return;
    remoteSearch.set(key, 'loading');
    openResults();
    query([
      { fieldCaption: 'Game Id', fieldAlias: 'id' },
      { fieldCaption: 'Name', fieldAlias: 'name' },
      { fieldCaption: 'Release Date', function: 'MIN', fieldAlias: 'date' },
      { fieldCaption: 'Hypes', function: 'MAX', fieldAlias: 'hype' }
    ], serverFilters().concat([{ field: { fieldCaption: 'Name' }, filterType: 'MATCH', contains: q }])).then(function (rows) {
      remoteSearch.set(key, ingest(rows));
    }).catch(function (err) {
      remoteSearch.delete(key);
      toast('Search failed: ' + friendly(err));
    }).then(function () {
      if (S.search === q && S.pop && S.pop.anchor === R.search) openResults();
    });
  }

  function onSearchKey(e) {
    if (!S.pop || S.pop.anchor !== R.search) return;
    var n = resultsState.items.length;
    if (!n) { if (e.key === 'Enter' && !window.IGDB_DATA) { e.preventDefault(); runRemoteSearch(); } return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      resultsState.kb = (resultsState.kb + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      Array.prototype.forEach.call(S.pop.el.querySelectorAll('.result'), function (el, i) { el.classList.toggle('kb', i === resultsState.kb); });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (resultsState.kb < 0 && !window.IGDB_DATA && !remoteSearch.has(S.search + '#' + filterSig())) { runRemoteSearch(); return; }
      pickResult(resultsState.items[Math.max(0, resultsState.kb)]);
    }
  }

  function pickResult(g) {
    if (!g) return;
    closePopover();
    R.searchInput.blur();
    setMonth(g.month).then(function () {
      var inMonth = S.cur.games.filter(function (x) { return x.id === g.id; })[0];
      if (!inMonth) { toast(g.name + ' is hidden by the Released?/Status filters.'); return; }
      select(inMonth);
      focusBubble(inMonth.id);
    });
  }

  function applySearchDim() {
    var q = S.search;
    if (S.bub) S.bub.nodes.forEach(function (n) { n.el.classList.toggle('dim', !!q && n.g.name.toLowerCase().indexOf(q) < 0); });
    Array.prototype.forEach.call(R.stageBody.querySelectorAll('.cal-item'), function (el) {
      el.classList.toggle('dim', !!q && el.dataset.name.indexOf(q) < 0);
    });
  }

  /* ---------------------------------------------------------------- stage */

  function renderStage() {
    closeTip();
    var games = S.cur.games;
    var sd = sizeDef();
    R.stageTitle.textContent = S.view === 'bubbles' ? monthName(S.month || '2026-01') + ' at a glance' : monthName(S.month || '2026-01') + ' calendar';
    R.stageSub.textContent = games.length
      ? fmtInt(games.length) + ' games' + (S.topN && (S.monthTotals || {})[S.month] > S.topN ? ' (top ' + S.topN + ' by hype of ' + fmtInt(S.monthTotals[S.month]) + ')' : '') + ' · ' + (S.view === 'bubbles' ? 'biggest = most ' + sd.label.toLowerCase() + ', ' + (S.fill === 'cover' ? 'ring' : 'color') + ' = release week' : 'ranked by ' + sd.label.toLowerCase() + ' within each day')
      : 'No games for the current filters';
    R.viewSeg.set(S.view);
    R.sizeLabel.textContent = S.view === 'bubbles' ? 'Size by' : 'Rank by';
    R.stageBody.classList.remove('enter'); void R.stageBody.offsetWidth; R.stageBody.classList.add('enter');
    if (S.view === 'bubbles') drawBubbles(); else drawCalendar();
    applySearchDim();
  }

  function emptyState() {
    return h('div', { class: 'empty' }, h('div', null, [
      h('div', { class: 'empty-icon' }, icon('pad')),
      h('h3', { text: 'Nothing on the radar' }),
      h('p', { text: anyFilter() ? 'No games match these filters in ' + monthName(S.month) + '. Loosen a filter or try another month.' : 'No releases found for ' + monthName(S.month) + '.' }),
      anyFilter() ? h('button', { type: 'button', class: 'btn primary', text: 'Reset filters', onclick: resetFilters }) : null
    ]));
  }

  /* ---- tooltip */
  function coverVariant(url, size) { return url ? url.replace('/t_720p/', '/' + size + '/') : null; }

  function showTip(g, e) {
    clear(R.tip);
    var media = h('div', { class: 'tip-cover', style: '--tint:var(--w' + weekIdx(g.day) + ')' }, h('span', { class: 'tip-initials', text: initials(g.name) }));
    if (g.cover) {
      var img = h('img', { src: coverVariant(g.cover, 't_cover_big'), alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('load', function () { media.classList.add('loaded'); });
      img.addEventListener('error', function () { img.remove(); });
      media.appendChild(img);
    }
    var pills = h('div', { class: 'tip-pills' });
    g.status.forEach(function (s) { pills.appendChild(h('span', { class: 'tip-pill', text: s })); });
    append(R.tip, [
      h('div', { class: 'tip-top' }, [
        media,
        h('div', { class: 'tip-text' }, [h('div', { class: 'tip-name', text: g.name }), h('div', { class: 'tip-date', text: fmtDate(g.date) }), pills])
      ]),
      h('div', { class: 'tip-stats' }, [
        h('div', { class: 'tip-stat' }, [h('b', { text: fmtInt(g.hype) }), h('span', { text: 'Hype' })]),
        h('div', { class: 'tip-stat' }, [h('b', { text: g.rating > 0 ? nf1.format(g.rating) : '–' }), h('span', { text: 'Rating' })]),
        h('div', { class: 'tip-stat' }, [h('b', { text: fmtInt(g.reviews) }), h('span', { text: 'Reviews' })])
      ]),
      h('div', { class: 'tip-hint', text: 'Click for details' })
    ]);
    R.tip.classList.add('show');
    moveTip(e);
  }
  function moveTip(e) {
    var r = R.stage.getBoundingClientRect();
    var x = e.clientX - r.left + 18, y = e.clientY - r.top + 18;
    var w = R.tip.offsetWidth, hh = R.tip.offsetHeight;
    if (x + w > r.width - 8) x = e.clientX - r.left - w - 18;
    if (y + hh > r.height - 8) y = e.clientY - r.top - hh - 18;
    R.tip.style.left = Math.max(8, x) + 'px';
    R.tip.style.top = Math.max(8, y) + 'px';
  }
  function closeTip() { R.tip.classList.remove('show'); }

  /* ---- bubbles: circle pack, biggest (most hyped / rated / reviewed) in the middle.
     Fill style: 'color' = flat circle in its release-week colour, 'cover' = game cover art
     with a release-week ring. */

  function radiusFn(games, sd, rMin, rMax) {
    var max = 0;
    games.forEach(function (g) { var v = sd.get(g); if (v > max) max = v; });
    return function (g) { return rMin + (max > 0 ? Math.sqrt(Math.max(0, sd.get(g)) / max) : 0) * (rMax - rMin); };
  }

  // Ranked rows: games in rank order (reading order), circle size = metric. Each row is
  // justified to the full width so the block is a clean rectangle; the scale is the largest
  // that still fits the panel height, and spare height is shared between rows.
  function rowsLayout(sorted, sd, fill, W, H) {
    var rel = radiusFn(sorted, sd, fill === 'cover' ? 0.16 : 0.12, 1);
    var raw = sorted.map(function (g) { return rel(g); });
    var box = { x0: 14, y0: 8, x1: W - 60, y1: H - 56 };
    var bw = Math.max(80, box.x1 - box.x0), bh = Math.max(80, box.y1 - box.y0);
    var STEP = 3;                                   // skyline resolution in px
    var cols = Math.max(1, Math.floor(bw / STEP));
    // Skyline ("masonry") packing in rank order: each circle goes to the lowest free spot,
    // leftmost on ties, so #1 anchors the top-left and the next ones fill around it.
    function pack(s) {
      var gap = Math.max(3, s * 0.06);
      var sky = new Float64Array(cols);
      var pos = new Array(raw.length), bottom = 0;
      for (var i = 0; i < raw.length; i++) {
        var d = raw[i] * s * 2;
        var w = Math.min(cols, Math.ceil((d + gap) / STEP));
        var bestX = 0, bestY = Infinity;
        for (var c = 0; c + w <= cols; c++) {
          var top = 0;
          for (var j = c; j < c + w; j++) if (sky[j] > top) top = sky[j];
          if (top < bestY - 0.01) { bestY = top; bestX = c; }
        }
        for (j = bestX; j < bestX + w; j++) sky[j] = bestY + d + gap;
        pos[i] = { x: bestX * STEP, y: bestY, d: d };
        bottom = Math.max(bottom, bestY + d);
      }
      return { pos: pos, h: bottom, gap: gap };
    }
    // largest scale that still fits the panel height
    var lo = 1, hi = Math.min(bh * 0.6, bw * 0.3), best = pack(lo), bestS = lo;
    for (var k = 0; k < 22; k++) {
      var mid = (lo + hi) / 2, p = pack(mid);
      if (p.h <= bh) { lo = mid; best = p; bestS = mid; } else hi = mid;
    }
    // centre the block in the box
    var maxRight = 0;
    best.pos.forEach(function (q) { maxRight = Math.max(maxRight, q.x + q.d); });
    var ox = box.x0 + (bw - maxRight) / 2, oy = box.y0 + (bh - best.h) / 2;
    var nodes = sorted.map(function (g, i) {
      var q = best.pos[i];
      return { g: g, r: q.d / 2, x: ox + q.x + q.d / 2, y: oy + q.y + q.d / 2 };
    });
    return { nodes: nodes, vb: [0, 0, W, H] };
  }

  // Fills the panel's rectangle (not one big enclosing circle): start from a circle pack
  // stretched to the panel's aspect ratio, then relax with collisions, a weak pull to the
  // centre (so the biggest stay in the middle) and the panel edges as walls.
  function fillLayout(sorted, sd, fill, W, H) {
    var rel = radiusFn(sorted, sd, fill === 'cover' ? 0.14 : 0.1, 1);
    var nodes = sorted.map(function (g) { return { g: g, r: rel(g) }; });
    // keep clear of the legend (bottom-left) and zoom buttons (bottom-right)
    var box = { x0: 10, y0: 6, x1: W - 62, y1: H - 54 };
    var bw = Math.max(50, box.x1 - box.x0), bh = Math.max(50, box.y1 - box.y0);
    var sumSq = 0;
    nodes.forEach(function (n) { sumSq += n.r * n.r; });
    var s = Math.sqrt(0.66 * bw * bh / (Math.PI * Math.max(sumSq, 1e-6)));
    s = Math.min(s, Math.min(bw, bh) * 0.32);   // never let one bubble take over the panel
    nodes.forEach(function (n) { n.r *= s; });
    d3.packSiblings(nodes);
    var cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    var asp = bw / bh, sx = Math.pow(asp, 0.75), sy = 1 / Math.pow(asp, 0.25);
    nodes.forEach(function (n) { n.x = cx + n.x * sx; n.y = cy + n.y * sy; });
    var N = nodes.length, iters = 260;
    // pull toward a horizontal line through the centre (weak in x) so the mass spreads wide
    var gx = 1 / (asp * asp);
    for (var it = 0; it < iters; it++) {
      var a = 0.035 * (1 - it / iters) + 0.004;
      for (var i = 0; i < N; i++) {
        var p = nodes[i];
        p.x += (cx - p.x) * a * gx;
        p.y += (cy - p.y) * a;
      }
      for (i = 0; i < N; i++) {
        var A = nodes[i];
        for (var j = i + 1; j < N; j++) {
          var B = nodes[j];
          var dx = B.x - A.x, dy = B.y - A.y, min = A.r + B.r + 1.5;
          if (dx > min || dx < -min || dy > min || dy < -min) continue;
          var d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          var d = Math.sqrt(d2) || 0.01;
          var push = (min - d) / d, wa = B.r / (A.r + B.r), wb = A.r / (A.r + B.r);
          A.x -= dx * push * wa; A.y -= dy * push * wa;
          B.x += dx * push * wb; B.y += dy * push * wb;
        }
      }
      for (i = 0; i < N; i++) {
        var q = nodes[i];
        q.x = clamp(q.x, box.x0 + q.r, box.x1 - q.r);
        q.y = clamp(q.y, box.y0 + q.r, box.y1 - q.r);
      }
    }
    return { nodes: nodes, vb: [0, 0, W, H] };
  }

  function buildBubble(n, i, fill) {
    var g = sv('g', { class: 'bubble w' + weekIdx(n.g.day), transform: 'translate(' + n.x.toFixed(2) + ',' + n.y.toFixed(2) + ')' });
    var inner = sv('g', { class: 'inner' });
    inner.style.animationDelay = Math.min(i * 0.8, 900) + 'ms';
    var r = n.r.toFixed(2);
    inner.appendChild(sv('circle', { class: 'b-circle', r: r }));
    if (fill === 'cover' && n.g.cover) {
      var img = sv('image', { class: 'b-cover', x: -n.r, y: -n.r, width: n.r * 2, height: n.r * 2, preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#bClip)' });
      img.setAttribute('href', coverVariant(n.g.cover, n.r >= 20 ? 't_cover_big' : 't_cover_small'));
      img.addEventListener('error', function () { img.remove(); g.classList.remove('has-cover'); });
      inner.appendChild(img);
      inner.appendChild(sv('circle', { class: 'b-ring', r: r }));
      g.classList.add('has-cover');
    }
    g.appendChild(inner);
    n.el = g; n.inner = inner;
    g.addEventListener('mouseenter', function (e) { hoverIn(n, e); });
    g.addEventListener('mousemove', moveTip);
    g.addEventListener('mouseleave', function () { hoverOut(); });
    g.addEventListener('click', function () { if (!S.bub.dragged) select(n.g); });
    return g;
  }

  function drawBubbles() {
    var body = R.stageBody;
    clear(body);
    S.bub = null;
    R.sizeCtl.style.display = '';
    R.fillCtl.style.display = '';
    R.arrangeCtl.style.display = '';
    var games = S.cur.games;
    if (!games.length) { body.appendChild(emptyState()); return; }
    if (!window.d3 || typeof d3.packSiblings !== 'function') { body.appendChild(h('p', { class: 'error', text: 'Circle-packing library failed to load.' })); return; }
    var fill = S.fill;

    var sd = sizeDef();
    var sorted = games.slice().sort(function (a, b) {
      return sd.get(b) - sd.get(a) || b.hype - a.hype || b.reviews - a.reviews || a.name.localeCompare(b.name);
    });
    var W = Math.max(320, Math.round(body.clientWidth)), H = Math.max(260, Math.round(body.clientHeight));
    var geo = S.arrange === 'organic' ? fillLayout(sorted, sd, fill, W, H) : rowsLayout(sorted, sd, fill, W, H);
    var nodes = geo.nodes, vb = geo.vb;

    var svg = sv('svg', { class: 'bubbles fill-' + fill, viewBox: vb.map(function (v) { return v.toFixed(2); }).join(' '), preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Bubble chart of ' + games.length + ' games releasing in ' + monthName(S.month) + ', sized by ' + sd.label.toLowerCase() });
    // glass fills for Color mode: release-week colour, strong top-left fading to see-through
    var defs = sv('defs', null, sv('clipPath', { id: 'bClip', clipPathUnits: 'objectBoundingBox' }, sv('circle', { cx: 0.5, cy: 0.5, r: 0.5 })));
    for (var w = 0; w < 5; w++) {
      defs.appendChild(sv('linearGradient', { id: 'gw' + w, x1: '0.15', y1: '0', x2: '0.85', y2: '1' }, [
        sv('stop', { offset: '0', style: 'stop-color:var(--w' + w + ');stop-opacity:0.92' }),
        sv('stop', { offset: '0.55', style: 'stop-color:var(--w' + w + ');stop-opacity:0.55' }),
        sv('stop', { offset: '1', style: 'stop-color:var(--w' + w + ');stop-opacity:0.22' })
      ]));
    }
    svg.appendChild(defs);
    var vp = sv('g', { class: 'viewport' });
    var base = sv('g', { class: 'layer-base' });
    var selL = sv('g', { class: 'layer-sel' });
    var hov = sv('g', { class: 'layer-hover' });
    append(vp, [base, selL, hov]);
    svg.appendChild(vp);

    S.bub = { svg: svg, vp: vp, base: base, selL: selL, hov: hov, nodes: nodes, vb: vb, k: 1, x: 0, y: 0, dragged: false, clone: null, fill: fill, W: W, H: H };
    nodes.forEach(function (n, i) { base.appendChild(buildBubble(n, i, fill)); });
    body.appendChild(svg);

    var legend = h('div', { class: 'legend glass' }, h('span', { class: 'lg-title', text: fill === 'cover' ? 'Ring = release week' : 'Release week' }));
    WEEKS.forEach(function (w, i) {
      var b = h('button', { type: 'button', class: 'lg w' + i }, [h('i'), w]);
      b.addEventListener('mouseenter', function () { svg.setAttribute('data-focus', i); });
      b.addEventListener('mouseleave', function () { svg.removeAttribute('data-focus'); });
      legend.appendChild(b);
    });
    body.appendChild(legend);

    body.appendChild(h('div', { class: 'zoom-ctl glass' }, [
      h('button', { type: 'button', class: 'icon-btn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: function () { zoomBy(1.6); } }, icon('plus')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: function () { zoomBy(1 / 1.6); } }, icon('minus')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Reset view', 'aria-label': 'Reset view', onclick: function () { applyZoom(1, 0, 0, true); } }, icon('fit'))
    ]));

    attachZoom(svg);
    requestAnimationFrame(function () { updateLabels(); markSelected(); });
  }

  function pxPerUnit() {
    var b = S.bub;
    if (!b) return 1;
    var w = b.svg.clientWidth || 1, hh = b.svg.clientHeight || 1;
    return Math.min(w / b.vb[2], hh / b.vb[3]);
  }

  function wrapLabel(name, r, fs) {
    var maxChars = Math.max(3, Math.floor((2 * r * 0.84) / (fs * 0.56)));
    if (name.length <= maxChars) return [name];
    var words = name.split(/\s+/);
    var l1 = '';
    while (words.length && (l1 + (l1 ? ' ' : '') + words[0]).length <= maxChars) l1 += (l1 ? ' ' : '') + words.shift();
    if (!l1) { return [name.slice(0, maxChars - 1) + '…']; }
    var l2 = words.join(' ');
    var max2 = Math.floor(maxChars * 0.86);
    if (l2.length > max2) l2 = l2.slice(0, Math.max(1, max2 - 1)) + '…';
    return l2 ? [l1, l2] : [l1];
  }

  function updateLabels() {
    var b = S.bub;
    if (!b) return;
    var eff = pxPerUnit() * b.k;
    b.nodes.forEach(function (n) {
      var show = n.r * eff >= 21;
      if (show && !n.label) {
        var fs2 = n.r * 0.27;
        var lines = wrapLabel(n.g.name, n.r, fs2);
        var t = sv('text', { class: 'b-label' + (n.el.classList.contains('has-cover') ? ' on-cover' : ''), 'font-size': fs2.toFixed(2), 'stroke-width': (fs2 * 0.22).toFixed(2) });
        lines.forEach(function (ln, i) {
          var dy = lines.length === 1 ? 0 : (i === 0 ? -0.55 : 0.55) * fs2 * 1.05;
          t.appendChild(sv('tspan', { x: 0, y: dy.toFixed(2) }, ln));
        });
        n.inner.appendChild(t);
        n.label = t;
      }
      if (n.label) n.label.style.display = show ? '' : 'none';
    });
  }

  function hoverIn(n, e) {
    var b = S.bub;
    removeClone(true);
    var clone = n.el.cloneNode(true);
    clone.classList.add('hover-clone');
    clone.classList.remove('dim');
    var inner = clone.querySelector('.inner');
    inner.style.animationDelay = '0ms';
    var eff = pxPerUnit() * b.k;
    var zs = clamp(30 / Math.max(0.01, n.r * eff), 1.25, 6);
    clone.style.setProperty('--zs', zs.toFixed(3));
    // the zoomed clone deserves a sharper cover
    var img = clone.querySelector('image');
    if (img && n.g.cover) img.setAttribute('href', coverVariant(n.g.cover, 't_cover_big'));
    b.hov.appendChild(clone);
    b.clone = clone;
    showTip(n.g, e);
  }
  function hoverOut() { removeClone(false); closeTip(); }
  function removeClone(now) {
    var b = S.bub;
    if (!b || !b.clone) return;
    var c = b.clone;
    b.clone = null;
    if (now) { c.remove(); return; }
    c.classList.add('out');
    setTimeout(function () { c.remove(); }, 230);
  }

  function attachZoom(svg) {
    var b = S.bub;
    function svgPoint(e) {
      var pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = svgPoint(e);
      var k2 = clamp(b.k * Math.exp(-e.deltaY * 0.0016), 1, 14);
      applyZoom(k2, p.x - (p.x - b.x) * (k2 / b.k), p.y - (p.y - b.y) * (k2 / b.k), false);
    }, { passive: false });
    svg.addEventListener('dblclick', function (e) {
      var p = svgPoint(e);
      var k2 = clamp(b.k * 2, 1, 14);
      applyZoom(k2, p.x - (p.x - b.x) * (k2 / b.k), p.y - (p.y - b.y) * (k2 / b.k), true);
    });
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var start = { x: e.clientX, y: e.clientY, bx: b.x, by: b.y };
      var scale = svg.getScreenCTM().a || 1;
      b.dragged = false;
      function move(ev) {
        var dx = (ev.clientX - start.x) / scale, dy = (ev.clientY - start.y) / scale;
        if (!b.dragged && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) { b.dragged = true; svg.classList.add('dragging'); hoverOut(); }
        if (b.dragged) applyZoom(b.k, start.bx + dx, start.by + dy, false);
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        svg.classList.remove('dragging');
        setTimeout(function () { b.dragged = false; }, 0);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  var labelRaf = 0;
  function applyZoom(k, x, y, smooth) {
    var b = S.bub;
    if (!b) return;
    if (k <= 1.0001) { k = 1; if (!smooth) { x = clamp(x, -b.vb[2] * 0.5, b.vb[2] * 0.5); y = clamp(y, -b.vb[3] * 0.5, b.vb[3] * 0.5); } }
    b.k = k; b.x = x; b.y = y;
    b.vp.classList.toggle('smooth', !!smooth);
    b.vp.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + k + ')';
    cancelAnimationFrame(labelRaf);
    labelRaf = requestAnimationFrame(updateLabels);
  }
  function zoomBy(f) {
    var b = S.bub;
    if (!b) return;
    var cx = b.vb[0] + b.vb[2] / 2, cy = b.vb[1] + b.vb[3] / 2;
    var k2 = clamp(b.k * f, 1, 14);
    applyZoom(k2, cx - (cx - b.x) * (k2 / b.k), cy - (cy - b.y) * (k2 / b.k), true);
  }
  function focusBubble(id) {
    var b = S.bub;
    if (!b) return;
    var n = b.nodes.filter(function (x) { return x.g.id === id; })[0];
    if (!n) return;
    var eff = pxPerUnit();
    var k2 = clamp(60 / Math.max(0.01, n.r * eff), 1, 10);
    var cx = b.vb[0] + b.vb[2] / 2, cy = b.vb[1] + b.vb[3] / 2;
    applyZoom(k2, cx - n.x * k2, cy - n.y * k2, true);
  }

  function markSelected() {
    var id = S.selected && S.selected.id;
    var b = S.bub;
    if (b) {
      clear(b.selL);
      var n = id != null && b.nodes.filter(function (x) { return x.g.id === id; })[0];
      if (n) {
        var gg = sv('g', { transform: 'translate(' + n.x + ',' + n.y + ')' });
        gg.appendChild(sv('circle', { class: 'sel-pulse', r: n.r + 1 }));
        gg.appendChild(sv('circle', { class: 'sel-ring', r: n.r + 1 }));
        b.selL.appendChild(gg);
      }
    }
    Array.prototype.forEach.call(R.stageBody.querySelectorAll('.cal-item'), function (el) {
      el.classList.toggle('selected', String(el.dataset.id) === String(id));
    });
  }

  /* ---- calendar */
  function drawCalendar() {
    var body = R.stageBody;
    clear(body);
    S.bub = null;
    R.sizeCtl.style.display = '';
    R.fillCtl.style.display = 'none';
    R.arrangeCtl.style.display = 'none';
    var rel = S.cur.rel;
    var sd = sizeDef();
    var p = S.month.split('-'); var y = +p[0], m = +p[1];
    var lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    var days = new Date(y, m, 0).getDate();
    var byDay = {};
    var seen = new Set();
    rel.forEach(function (g) {
      if (seen.has(g.key)) return;
      seen.add(g.key);
      (byDay[g.day] = byDay[g.day] || []).push(g);
    });
    var max = 1;
    Object.keys(byDay).forEach(function (d) {
      byDay[d].sort(function (a, b) { return sd.get(b) - sd.get(a) || b.hype - a.hype || a.name.localeCompare(b.name); });
      max = Math.max(max, byDay[d].length);
    });
    var today = todayKey();

    var wrap = h('div', { class: 'cal-wrap' });
    var cal = h('div', { class: 'cal', role: 'grid', 'aria-label': monthName(S.month) + ' release calendar' });
    DOW.forEach(function (d) { cal.appendChild(h('div', { class: 'cal-dow', text: d })); });
    for (var i = 0; i < lead; i++) cal.appendChild(h('div', { class: 'cal-cell blank' }));
    for (var d = 1; d <= days; d++) {
      (function (d) {
        var list = byDay[d] || [];
        var dateKey = S.month + '-' + String(d).padStart(2, '0');
        var dow = (lead + d - 1) % 7;
        var heat = list.length ? 0.15 + 0.85 * Math.sqrt(list.length / max) : 0;
        var cell = h('div', {
          class: 'cal-cell' + (list.length ? ' has' : '') + (dateKey === today ? ' today' : '') + (dow >= 5 ? ' weekend' : ''),
          style: '--heat:' + heat.toFixed(3) + ';animation-delay:' + Math.min((lead + d) * 14, 600) + 'ms',
          role: 'gridcell'
        });
        cell.appendChild(h('div', { class: 'cal-head' }, [h('span', { class: 'cal-day', text: d }), list.length ? h('span', { class: 'cal-count', text: fmtInt(list.length) }) : null]));
        list.slice(0, 3).forEach(function (g) {
          var it = h('button', { type: 'button', class: 'cal-item w' + weekIdx(g.day), 'data-id': g.id, 'data-name': g.name.toLowerCase(), 'aria-label': g.name }, [
            h('span', { class: 'cal-dot' }), h('span', { class: 'cal-name', text: g.name }), h('span', { class: 'cal-metric', text: sd.get(g) > 0 ? compactNf.format(sd.get(g)) : '' })
          ]);
          it.addEventListener('click', function (e) { e.stopPropagation(); select(g); });
          it.addEventListener('mouseenter', function (e) { showTip(g, e); });
          it.addEventListener('mousemove', moveTip);
          it.addEventListener('mouseleave', closeTip);
          cell.appendChild(it);
        });
        if (list.length > 3) {
          cell.appendChild(h('button', { type: 'button', class: 'cal-more', text: '+' + fmtInt(list.length - 3) + ' more', onclick: function (e) { e.stopPropagation(); openSheet(dateKey, list); } }));
        }
        if (list.length) cell.addEventListener('click', function () { openSheet(dateKey, list); });
        cal.appendChild(cell);
      })(d);
    }
    var total = lead + days;
    for (var t = total; t % 7 !== 0; t++) cal.appendChild(h('div', { class: 'cal-cell blank' }));
    cal.style.gridTemplateRows = 'auto repeat(' + Math.ceil(total / 7) + ', minmax(84px, 1fr))';
    wrap.appendChild(cal);
    body.appendChild(wrap);
    if (!rel.length) body.appendChild(emptyState());
    markSelected();
  }

  function openSheet(dateKey, list) {
    closeSheet(true);
    var sd = sizeDef();
    var scrim = h('div', { class: 'sheet-scrim', onclick: function () { closeSheet(); } });
    var rows = h('div', { class: 'sheet-list' });
    list.forEach(function (g, i) {
      rows.appendChild(h('button', { type: 'button', class: 'row', style: 'animation-delay:' + Math.min(i * 18, 500) + 'ms', onclick: function () { select(g); }, onmouseenter: function (e) { showTip(g, e); }, onmousemove: moveTip, onmouseleave: closeTip }, [
        h('span', { class: 'rank', text: i + 1 }),
        h('span', { class: 'avatar w' + weekIdx(g.day), text: initials(g.name) }),
        h('span', { class: 'r-main' }, [h('div', { class: 'r-name', text: g.name }), h('div', { class: 'r-meta', text: Array.from(g.status).join(', ') + ' · ' + Array.from(g.released).join(', ') })]),
        h('span', { class: 'r-stats' }, [
          h('span', null, [h('b', { text: fmtInt(g.hype) }), ' hype']),
          h('span', null, [h('b', { text: g.rating > 0 ? nf1.format(g.rating) : '–' }), ' rating'])
        ])
      ]));
    });
    var sheet = h('div', { class: 'sheet glass', role: 'dialog', 'aria-label': 'Releases on ' + fmtDate(dateKey, true) }, [
      h('div', { class: 'sheet-grip' }),
      h('div', { class: 'sheet-head' }, [
        h('div', null, [h('div', { class: 'sheet-title', text: fmtDate(dateKey, true) }), h('div', { class: 'sheet-sub', text: fmtInt(list.length) + ' release' + (list.length === 1 ? '' : 's') + ' · sorted by ' + sd.label.toLowerCase() })]),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: function () { closeSheet(); } }, icon('x'))
      ]),
      rows
    ]);
    R.stage.appendChild(scrim);
    R.stage.appendChild(sheet);
    R.sheet = { sheet: sheet, scrim: scrim };
    requestAnimationFrame(function () { scrim.classList.add('open'); sheet.classList.add('open'); });
  }
  function closeSheet(now) {
    closeTip();
    if (!R.sheet) return;
    var s = R.sheet;
    R.sheet = null;
    if (now) { s.sheet.remove(); s.scrim.remove(); return; }
    s.sheet.classList.remove('open'); s.scrim.classList.remove('open');
    setTimeout(function () { s.sheet.remove(); s.scrim.remove(); }, 380);
  }

  /* --------------------------------------------------------------- detail */

  function ensureSelection(dataChanged) {
    var games = S.cur.games;
    if (S.selected) {
      var same = games.filter(function (g) { return g.id === S.selected.id; })[0];
      if (same) { if (dataChanged) { S.selected = same; markSelected(); } else markSelected(); return; }
    }
    if (!games.length) { S.selected = null; renderDetailEmpty(); return; }
    var top = games.reduce(function (a, b) { return b.hype > a.hype ? b : a; }, games[0]);
    select(top);
  }

  function renderDetailEmpty() {
    clear(R.detailInner);
    R.detailInner.appendChild(h('div', { class: 'detail-empty', text: 'No game selected. Pick a bubble or a calendar entry.' }));
  }

  function select(g) {
    if (S.selected && S.selected.id === g.id && R.detailInner.dataset.id === String(g.id)) { markSelected(); return; }
    S.selected = g;
    markSelected();
    renderDetail(g);
  }

  function coverFallback(g) {
    return h('div', { class: 'cover-fallback', style: 'background:linear-gradient(135deg, var(--w' + weekIdx(g.day) + '), var(--accent-2))', text: initials(g.name) });
  }

  function imgOrFallback(src, cls, fallback) {
    if (!src) return fallback();
    var img = h('img', { src: src, alt: '', class: cls || null, loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', function () { if (img.parentNode) img.parentNode.replaceChild(fallback(), img); });
    return img;
  }

  function rankIn(g, key) {
    var sd = SIZES.filter(function (s) { return s.key === key; })[0];
    var v = sd.get(g);
    if (!(v > 0)) return null;
    var r = 1;
    S.cur.games.forEach(function (x) { if (sd.get(x) > v) r++; });
    return r;
  }

  function renderDetail(g) {
    var token = ++S.detailToken;
    var inner = R.detailInner;
    clear(inner);
    inner.dataset.id = g.id;
    inner.classList.remove('swap'); void inner.offsetWidth; inner.classList.add('swap');

    // hero
    var bg = h('div', { class: 'hero-bg' + (g.cover ? '' : ' fallback') });
    bg.style.background = 'linear-gradient(135deg, var(--w' + weekIdx(g.day) + '), var(--accent-2))';
    if (g.cover) {
      var probe = new Image();
      probe.onload = function () { bg.style.backgroundImage = 'url("' + g.cover.replace(/"/g, '%22') + '")'; bg.classList.remove('fallback'); };
      probe.src = g.cover;
    }
    var links = h('div', { class: 'hero-links' });
    if (g.url) links.appendChild(h('a', { class: 'link-btn', href: g.url, target: '_blank', rel: 'noopener noreferrer' }, [icon('ext'), 'IGDB page']));
    var pills = h('div', { class: 'pills' }, [h('span', { class: 'pill accent', text: fmtDate(g.date) })]);
    g.status.forEach(function (s) { pills.appendChild(h('span', { class: 'pill', text: s })); });
    g.released.forEach(function (s) { pills.appendChild(h('span', { class: 'pill', text: s })); });
    var hero = h('div', { class: 'hero' }, [
      bg,
      h('div', { class: 'cover' }, imgOrFallback(g.cover, null, function () { return coverFallback(g); })),
      h('div', { class: 'hero-main' }, [h('h2', { class: 'hero-title', text: g.name }), pills, links])
    ]);

    // summary
    var sumP = h('p', { class: 'summary' }, [h('span', { class: 'skel-line', style: 'width:96%' }), h('span', { class: 'skel-line', style: 'width:88%' }), h('span', { class: 'skel-line', style: 'width:64%' })]);
    var sumWrap = h('div', { class: 'section' }, [h('div', { class: 'section-title', text: 'About' }), sumP]);

    // metrics
    R.metricsSlot = h('div', { class: 'section' });
    fillMetrics(g);

    // video
    var vid = youtubeId(g.video);
    var video;
    if (vid) {
      var ytUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(vid);
      video = h('a', { class: 'video', href: ytUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Watch the trailer on YouTube' }, [
        g.cover ? h('div', { class: 'video-cover-fallback', style: 'background-image:url("' + g.cover.replace(/"/g, '%22') + '")' }) : null,
        imgOrFallback('https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/hqdefault.jpg', null, function () { return h('span'); }),
        h('span', { class: 'play' }, icon('play')),
        h('span', { class: 'video-cap' }, [h('span', { class: 'yt-badge', text: 'YouTube' }), 'Watch trailer'])
      ]);
    } else {
      video = h('div', { class: 'video none', text: 'No trailer available yet' });
    }
    var videoWrap = h('div', { class: 'section' }, [h('div', { class: 'section-title', text: 'Trailer' }), video]);

    // facets
    var facets = h('div', { class: 'facets' });
    var facetEls = {};
    DIMS.forEach(function (d) {
      var chips = h('div', { class: 'facet-chips' }, [h('span', { class: 'skel', style: 'width:70px' }), h('span', { class: 'skel', style: 'width:96px' })]);
      facetEls[d.key] = chips;
      facets.appendChild(h('div', null, [h('div', { class: 'facet-label', text: d.plural }), chips]));
    });
    var facetWrap = h('div', { class: 'section' }, [h('div', { class: 'section-title', text: 'Details' }), facets]);

    append(inner, [hero, sumWrap, R.metricsSlot, videoWrap, facetWrap]);
    if (R.detail.firstChild) R.detail.firstChild.scrollTop = 0;

    loadDetails(g.id).then(function (det) {
      if (token !== S.detailToken) return;
      clear(sumP);
      var txt = det.summary || 'No description available.';
      sumP.textContent = txt;
      if (txt.length > 240) {
        var more = h('button', { type: 'button', class: 'more-link', text: 'Read more' });
        more.addEventListener('click', function () { var open = sumP.classList.toggle('open'); more.textContent = open ? 'Show less' : 'Read more'; });
        sumWrap.appendChild(more);
      }
      DIMS.forEach(function (d) {
        var el = facetEls[d.key];
        clear(el);
        var vals = det[d.key] || [];
        var LIM = d.key === 'Keyword' ? 18 : 30;
        if (!vals.length) { el.appendChild(h('span', { class: 'fchip none', text: '—' })); return; }
        vals.slice(0, LIM).forEach(function (v, i) {
          var c = h('button', { type: 'button', class: 'fchip', title: 'Filter by ' + d.label + ': ' + v, text: String(v), style: 'animation-delay:' + Math.min(i * 25, 400) + 'ms' });
          c.addEventListener('click', function () { if (!S.server[d.key].has(v)) addServerFilter(d.key, v); });
          el.appendChild(c);
        });
        if (vals.length > LIM) el.appendChild(h('span', { class: 'fchip none', text: '+' + (vals.length - LIM) }));
      });
    }).catch(function (err) {
      if (token !== S.detailToken) return;
      sumP.textContent = 'Could not load details: ' + msg(err);
      DIMS.forEach(function (d) { clear(facetEls[d.key]); facetEls[d.key].appendChild(h('span', { class: 'fchip none', text: '—' })); });
    });
  }

  function fillMetrics(g) {
    var slot = R.metricsSlot;
    if (!slot) return;
    clear(slot);
    var C = 2 * Math.PI * 28;
    var val = sv('circle', { class: 'val', cx: 33, cy: 33, r: 28, 'stroke-dasharray': C.toFixed(2), 'stroke-dashoffset': C.toFixed(2) });
    var ring = sv('svg', { class: 'ring', viewBox: '0 0 66 66' }, [sv('circle', { class: 'track', cx: 33, cy: 33, r: 28 }), val]);
    var rRank = rankIn(g, 'reviews');
    var ringCard = h('div', { class: 'metric-card ring-card' }, [
      h('div', { class: 'ring-wrap' }, [ring, h('div', { class: 'ring-num', text: g.rating > 0 ? Math.round(g.rating) : '–' })]),
      h('div', null, [
        h('div', { class: 'm-label', text: 'Weighted rating' }),
        h('div', { class: 'm-value', text: fmtInt(g.reviews) }),
        h('div', { class: 'm-note', text: 'reviews' + (rRank ? ' · #' + rRank + ' this month' : '') })
      ])
    ]);
    var maxHype = 1;
    S.cur.games.forEach(function (x) { if (x.hype > maxHype) maxHype = x.hype; });
    var bar = h('i');
    var hRank = rankIn(g, 'hype');
    var hypeCard = h('div', { class: 'metric-card hype-card' }, [
      h('div', { class: 'hype-row' }, [h('span', { class: 'm-label', text: 'Hype' }), h('span', { class: 'm-value', text: fmtInt(g.hype) })]),
      h('div', { class: 'bar' }, bar),
      h('div', { class: 'm-note', text: hRank ? '#' + hRank + ' most hyped in ' + monthName(S.month) : 'No hype yet' })
    ]);
    append(slot, [h('div', { class: 'section-title', text: 'Metrics' }), h('div', { class: 'metrics' }, [ringCard, hypeCard])]);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        val.setAttribute('stroke-dashoffset', (C * (1 - clamp(g.rating / 100, 0, 1))).toFixed(2));
        bar.style.width = (g.hype > 0 ? Math.max(3, g.hype / maxHype * 100) : 0) + '%';
      });
    });
  }
  function renderDetailMetricsOnly() { if (S.selected) fillMetrics(S.selected); }

  /* --------------------------------------------------------------- footer */

  function renderFooter() {
    if (!R.footer) return;
    clear(R.footer);
    var left = h('span', null, ['Data from ', h('a', { href: 'https://www.igdb.com', target: '_blank', rel: 'noopener noreferrer' }, h('b', { text: 'IGDB.com' })), ' · trailers on YouTube · snapshot, not live']);
    var parts = [];
    if (S.runDate) parts.push('data as of ' + fmtDate(String(S.runDate).slice(0, 10)));
    if (S.gameInfo) parts.push(fmtInt(S.gameInfo.length) + ' games');
    append(R.footer, [left, h('span', { text: parts.join(' · ') })]);
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    setTheme(getStoredTheme() || 'dark', false);
    buildShell();
    setLoading(true);
    // Render from the packaged snapshot right away; the Extensions API handshake is not needed
    // for data, so a slow or failed initialize never blocks the app.
    setTimeout(function () { loadAll(true); }, 0);
    if (window.tableau && tableau.extensions) {
      tableau.extensions.initializeAsync().catch(function () { /* data does not depend on it */ });
    }
  }

  boot();
})();
