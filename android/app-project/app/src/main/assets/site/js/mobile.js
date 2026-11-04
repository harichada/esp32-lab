/* Mobile shell: app bar, bottom tabs, FAB, sheets, drawer, touch gestures for the circuit editor.
 * Runs only when <html class="m"> (set in index.html for the APK user agent or a viewport < 768 px). */
window.addEventListener('DOMContentLoaded', function () {
  if (!document.documentElement.classList.contains('m')) return;
  const $ = (s, r) => (r || document).querySelector(s), app = window.app, ed = app.editor, P = window.Parts;
  const ic = (id) => `<svg class="ic"><use href="#${id}"/></svg>`;
  const svgI = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = { menu: svgI('<path d="M4 7h16M4 12h16M4 17h16"/>'), more: svgI('<circle cx="12" cy="5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>'),
    circuit: svgI('<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h6a2 2 0 0 1 2 2v8"/><path d="M6 8v10h10"/>'), code: svgI('<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>'),
    serial: svgI('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>'), parts: svgI('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13v7M13 16.5h7"/>'),
    log: svgI('<path d="M5 4h10l4 4v12H5z"/><path d="M8 12h8M8 16h6"/>'), book: svgI('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>') };
  const T = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstChild; };
  document.body.dataset.mv = 'circuit';

  // ---------- toast (replaces the permanent hint line) ----------
  const toastEl = document.body.appendChild(T('<div class="m-toast"></div>')); let toastT;
  const mtoast = (msg, ms) => { toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), ms || 2200); };
  ed.setHint = function () {};   // desktop hint bar is hidden; explicit messages go through mtoast

  // ---------- app bar ----------
  const bar = document.body.appendChild(T(`<header class="m-bar"><button class="m-ib" id="mMenu" aria-label="Menu">${I.menu}</button>
    <div class="m-title"><b id="mTitle">ESP32 Lab</b><div class="m-sub"><span id="mDot" class="m-dot"></span><span id="mStatus">idle</span><button id="mKind" class="m-chip"></button></div></div>
    <button class="m-ib" id="mUndo" aria-label="Undo">${ic('i-undo')}</button><button class="m-ib" id="mMore" aria-label="More">${I.more}</button></header>`));
  const sync = () => {
    $('#mTitle').textContent = ($('#projTitle') || {}).textContent || 'ESP32 Lab';
    const ro = app.readOnly, k = $('#mKind'); k.className = 'm-chip ' + (ro ? 'ex act' : 'mine'); k.textContent = ro ? 'Example · Copy' : 'Saved';
    $('#mStatus').textContent = ($('#stText') || {}).textContent || ''; $('#mDot').className = 'm-dot ' + (($('#stDot') || {}).className || '').replace('dot', '').trim();
    fab.innerHTML = document.body.classList.contains('running') ? `${ic('i-stop')}<span>Stop</span>` : document.body.classList.contains('busy') ? `${ic('i-restart')}<span>Building</span>` : `${ic('i-play')}<span>Run</span>`;
  };
  $('#mKind').onclick = () => { if (app.readOnly) { const b = $('#bCopy'); if (b) { b.click(); mtoast('Copied to My Projects'); } } else { $('#bSave').click(); } };
  $('#mUndo').onclick = () => ed.undo();

  // ---------- FAB ----------
  const fab = document.body.appendChild(T('<button class="m-fab" id="mFab"></button>'));
  fab.onclick = () => { if (document.body.classList.contains('running')) $('#bStop').click(); else { $('#bRun').click(); mtoast('Compiling…'); } };
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  for (const s of ['#stText', '#projTitle', '#projKind', '#projBanner']) { const e = $(s); if (e) new MutationObserver(sync).observe(e, { childList: true, characterData: true, subtree: true, attributes: true }); }

  // ---------- views + bottom tabs ----------
  const tabs = document.body.appendChild(T(`<nav class="m-tabs">${[['circuit', 'Circuit', I.circuit], ['code', 'Code', I.code], ['serial', 'Serial', I.serial], ['parts', 'Parts', I.parts]].map(([k, n, s]) => `<button data-mv="${k}"><i>${s}</i>${n}</button>`).join('')}</nav>`));
  const dockTab = (t) => { const b = document.querySelector(`#tabs [data-tab=${t}]`); if (b) b.click(); };
  function setView(v) {
    if (v === 'parts') { openSheet(partsSheet); return; }
    closeAll(); document.body.classList.remove('dsheet'); document.body.dataset.mv = v;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mv === v));
    if (v === 'code' || v === 'serial') { inTab = true; dockTab(v); inTab = false; }
    if (v === 'circuit') requestAnimationFrame(() => ed.applyView());
  }
  tabs.onclick = (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.mv); };
  // any other dock tab (build log after a compile error, network, …) opens as a sheet over the current view
  let inTab = false; const dock = $('#dock'); document.body.appendChild(dock); dock.appendChild(T(`<button class="m-ib dock-close" aria-label="Close">${ic('i-x')}</button>`)).onclick = () => { document.body.classList.remove('dsheet'); scrim.classList.remove('on'); if (document.body.dataset.mv !== 'circuit') dockTab(document.body.dataset.mv); };
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (!b || inTab) return; const t = b.dataset.tab;
    if (t === 'code' || t === 'serial') { if (!document.body.classList.contains('dsheet')) setView(t); } else { closeAll(); document.body.classList.add('dsheet'); scrim.classList.add('on'); openedAt = Date.now(); } });

  // ---------- sheets ----------
  const scrim = document.body.appendChild(T('<div class="m-scrim"></div>'));
  const mkSheet = (id, title, extra) => document.body.appendChild(T(`<section class="m-sheet" id="${id}"><div class="grab"></div><div class="m-sh-h"><h3>${title}</h3><button class="m-ib" data-x aria-label="Close">${ic('i-x')}</button></div>${extra || ''}<div class="m-sh-b"></div></section>`));
  let openS = null;
  let openedAt = 0;
  function openSheet(s) { closeAll(); s.classList.add('on'); scrim.classList.add('on'); openS = s; openedAt = Date.now(); }
  function closeAll() { document.querySelectorAll('.m-sheet.on,.m-drawer.on,.m-menu.on').forEach((e) => e.classList.remove('on')); if (!document.body.classList.contains('dsheet')) scrim.classList.remove('on'); openS = null; }
  scrim.onclick = () => { if (Date.now() - openedAt < 400) return; closeAll(); document.body.classList.remove('dsheet'); scrim.classList.remove('on'); if (document.body.dataset.mv !== 'circuit') dockTab(document.body.dataset.mv); };
  document.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) { closeAll(); if (e.target.closest('#mInsp')) ed.select(null); } });
  // swipe a sheet down to close
  document.addEventListener('touchstart', (e) => { const g = e.target.closest('.m-sheet .grab,.m-sh-h'); if (!g) return; const s = g.closest('.m-sheet'), y0 = e.touches[0].clientY;
    const mv = (ev) => { const dy = Math.max(0, ev.touches[0].clientY - y0); s.style.transition = 'none'; s.style.transform = `translateY(${dy}px)`; };
    const up = (ev) => { const dy = ev.changedTouches[0].clientY - y0; s.style.transition = ''; s.style.transform = ''; if (dy > 80) { closeAll(); if (s.id === 'mInsp') ed.select(null); } document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', up); };
    document.addEventListener('touchmove', mv, { passive: true }); document.addEventListener('touchend', up); }, { passive: true });

  // parts library sheet: searchable, category chips, thumbnails (reuses the desktop palette DOM + handlers)
  const partsSheet = mkSheet('mParts', 'Add a part', '<div class="m-cats"></div>'); partsSheet.classList.add('tall');
  const pb = partsSheet.querySelector('.m-sh-b'); pb.appendChild($('.pal-search')); pb.appendChild($('#palList'));
  const cats = [...document.querySelectorAll('#palList .pcat')].map((e) => e.dataset.cat);
  partsSheet.querySelector('.m-cats').innerHTML = ['All', ...cats].map((c) => `<button data-c="${c}">${c}</button>`).join('');
  partsSheet.querySelector('.m-cats').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; partsSheet.querySelectorAll('.m-cats button').forEach((x) => x.classList.toggle('on', x === b));
    const c = b.dataset.c; document.querySelectorAll('#palList .pgrid,#palList .pcat').forEach((g) => { g.style.display = c === 'All' || g.dataset.cat === c ? '' : 'none'; }); pb.scrollTop = 0; };
  partsSheet.querySelector('.m-cats button').classList.add('on');
  $('#palList').addEventListener('click', (e) => { const it = e.target.closest('.pitem'); if (!it) return; setView('circuit'); }, true);   // before the add handler: make the stage measurable
  $('#palList').addEventListener('click', (e) => { const it = e.target.closest('.pitem'); if (!it) return; const d = P.T[it.dataset.type]; mtoast(`Added ${d ? d.label : it.dataset.type} — long-press to move it`); });
  $('#palSearch').setAttribute('enterkeyhint', 'search');

  // inspector sheet for the selected part / wire
  const insp = mkSheet('mInsp', 'Part', `<div class="m-act"><button data-a="rot">${ic('i-rotate')}Rotate</button><button data-a="dup">${ic('i-copy')}Duplicate</button><button data-a="del" class="danger">${ic('i-trash')}Delete</button></div><div class="m-colors"></div>`);
  insp.querySelector('.m-sh-b').appendChild($('#insp')); const wl = $('#warnList'); if (wl) { const h = T('<h4 style="margin:14px 0 4px">Warnings</h4>'); insp.querySelector('.m-sh-b').append(h, wl); }
  insp.querySelector('.m-act').onclick = (e) => { const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'rot') ed.rotateSel(); else if (a === 'del') { ed.deleteSel(); closeAll(); mtoast('Deleted'); }
    else if (a === 'dup' && ed.sel && ed.sel.part) { const p = ed.part(ed.sel.part); const n = ed.addPart(p.type, p.x + 40, p.y + 40); n.props = JSON.parse(JSON.stringify(p.props || {})); n.rot = p.rot; ed.render(); app.editor.hooks.changed(true); } };
  insp.querySelector('.m-colors').onclick = (e) => { const c = e.target.dataset.c; if (c && ed.sel && ed.sel.wire) { ed.colorWire(ed.sel.wire, c); ed.wireColor = c; showInsp(); } };
  function showInsp() {
    const s = ed.sel; if (!s) { if (openS === insp) closeAll(); return; }
    const isW = !!s.wire, p = s.part && ed.part(s.part), d = p && P.T[p.type];
    insp.querySelector('h3').textContent = isW ? 'Wire ' + s.wire : `${p.id} · ${d ? d.label : p.type}`;
    insp.querySelector('[data-a=rot]').style.display = isW ? 'none' : ''; insp.querySelector('[data-a=dup]').style.display = isW || (p && p.type === 'esp32') ? 'none' : '';
    const w = isW && ed.wire(s.wire); insp.querySelector('.m-colors').innerHTML = isW ? Object.entries(window.WIRE_COLORS).map(([n, c]) => `<span data-c="${n}" class="${w && w.color === n ? 'on' : ''}" style="background:${c}"></span>`).join('') : '';
    if (openS !== insp) openSheet(insp);
  }

  // drawer: examples + projects
  const drawer = document.body.appendChild(T(`<aside class="m-drawer"><div class="m-brand"><span class="logo"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg></span>ESP32 Lab</div><div class="m-list">
    <h4>Projects</h4>
    <button class="m-li" data-d="projects">${ic('i-folder')}<span>My Projects…</span></button>
    <button class="m-li" data-d="save">${ic('i-save')}<span>Save</span></button>
    <button class="m-li" data-d="import">${ic('i-upload')}<span>Import JSON / Wokwi diagram</span></button>
    <button class="m-li" data-d="download">${ic('i-download')}<span>Export project JSON</span></button>
    <h4>Examples</h4><div id="mEx"></div></div></aside>`));
  $('#mEx').innerHTML = (window.Examples ? Examples.LIST : []).map(([k, n]) => `<button class="m-li" data-ex="${k}">${I.book}<span>${P.esc(n)}</span></button>`).join('');
  drawer.onclick = (e) => { const b = e.target.closest('[data-d],[data-ex]'); if (!b) return; closeAll();
    if (b.dataset.ex) { const s = $('#selExample'); s.value = b.dataset.ex; s.dispatchEvent(new Event('change')); setView('circuit'); setTimeout(() => ed.fit(), 50); return; }
    ({ projects: () => $('#bProjects').click(), save: () => $('#bSave').click(), import: () => $('#fileIn').click(), download: () => $('#bDownload').click() })[b.dataset.d](); };
  $('#mMenu').onclick = () => { closeAll(); drawer.classList.add('on'); scrim.classList.add('on'); openedAt = Date.now(); };

  // overflow menu
  const menu = document.body.appendChild(T(`<div class="m-menu">
    <button data-m="restart">${ic('i-restart')}Restart</button><button data-m="reset">${ic('i-reset')}Reset simulation</button><hr>
    <button data-m="redo">${ic('i-redo')}Redo</button><button data-m="fit">${ic('i-fit')}Fit circuit to screen</button><hr>
    <button data-m="build">${I.log}Build log</button><button data-m="net">${ic('i-flow')}Network log</button><button data-m="dev">${ic('i-chip')}Devices</button><button data-m="scope">${ic('i-flow')}Scope</button><button data-m="bom">${I.parts}Parts list (buy)</button><hr>
    <button data-m="cmdk">${ic('i-search')}Command palette</button><button data-m="theme">${ic('i-sun')}Light / dark</button><button data-m="about">${ic('i-chip')}About</button></div>`));
  $('#mMore').onclick = (e) => { e.stopPropagation(); const on = !menu.classList.contains('on'); closeAll(); if (on) { menu.classList.add('on'); } };
  document.addEventListener('pointerdown', (e) => { if (menu.classList.contains('on') && !menu.contains(e.target) && !e.target.closest('#mMore')) menu.classList.remove('on'); }, true);
  menu.onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; menu.classList.remove('on'); const m = b.dataset.m;
    ({ restart: () => $('#bRestart').click(), reset: () => $('#bReset').click(), redo: () => ed.redo(), fit: () => { setView('circuit'); ed.fit(); }, theme: () => $('#bTheme').click(), cmdk: () => $('#bCmdk').click(),
       build: () => dockTab('build'), net: () => dockTab('net'), dev: () => dockTab('dev'), scope: () => dockTab('scope'), bom: () => dockTab('bom'), about: () => dockTab('about') })[m](); };

  // ---------- circuit overlays ----------
  const wrap = $('#stageWrap');
  const cv = wrap.appendChild(T(`<div class="m-cv"><button id="mFit" aria-label="Fit to screen">${ic('i-fit')}</button><button id="mZin" aria-label="Zoom in">${ic('i-plus')}</button><button id="mZout" aria-label="Zoom out">${ic('i-minus')}</button></div>`));
  const zoomEl = wrap.appendChild(T('<div class="m-zoom"></div>')); let zT;
  const showZoom = () => { zoomEl.textContent = Math.round(ed.view.s * 100) + '%'; zoomEl.classList.add('on'); clearTimeout(zT); zT = setTimeout(() => zoomEl.classList.remove('on'), 700); };
  const zoomBy = (f, cx, cy) => { const r = svg.getBoundingClientRect(); cx = cx ?? r.left + r.width / 2; cy = cy ?? r.top + r.height / 2; const w = ed.toWorld({ clientX: cx, clientY: cy }), s = Math.min(5, Math.max(0.12, ed.view.s * f));
    ed.view = { s, x: w.x - (cx - r.left) / s, y: w.y - (cy - r.top) / s }; ed.applyView(); showZoom(); };
  $('#mFit').onclick = () => { ed.fit(); showZoom(); }; $('#mZin').onclick = () => zoomBy(1.3); $('#mZout').onclick = () => zoomBy(1 / 1.3);
  const wiring = wrap.appendChild(T('<div class="m-wiring"><span></span><button id="mWireX">Cancel</button></div>'));
  const setWiring = (txt) => { wiring.classList.toggle('on', !!txt); if (txt) wiring.firstChild.textContent = txt; };
  $('#mWireX').onclick = () => { ed.cancelWire(); setWiring(null); };
  const origCancel = ed.cancelWire.bind(ed); ed.cancelWire = function () { origCancel(); setWiring(null); };

  // ---------- touch gestures on the stage ----------
  // 1 finger: tap = select / wire (tap pin, tap pin) · drag = pan · long-press = pick up and move a part
  // 2 fingers: pinch-zoom + pan around the gesture midpoint
  const svg = $('#stage'); const pts = new Map(); let g = null, pinch = null;
  const touchy = (ev) => ev.pointerType === 'touch' || ev.pointerType === 'pen';
  const fwd = (fn, ev) => { try { fn.call(ed, ev); } catch (e) { console.warn(e); } };
  const lift = (p, on) => { const el = ed.partEls.get(p.id); if (el) el.classList.toggle('lift', on); };
  function down(ev) {
    if (!touchy(ev)) return; ev.stopImmediatePropagation(); ev.preventDefault();
    try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* */ }
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pts.size === 2) {
      if (g) { clearTimeout(g.lp); if (g.drag) { fwd(ed._up, ev); lift(g.drag, false); } if (g.pass) fwd(ed._up, ev); }
      g = null; const [a, b] = [...pts.values()], r = svg.getBoundingClientRect(), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: ed.view.s, w0: ed.toWorld({ clientX: mx, clientY: my }), r }; return;
    }
    if (pts.size > 2 || pinch) return;
    const partEl = ev.target.closest && ev.target.closest('.part'), p = partEl && ed.part(partEl.dataset.id), d = p && P.T[p.type];
    g = { x0: ev.clientX, y0: ev.clientY, v0: { ...ed.view }, moved: false, p, ev };
    if (p && d && !(ed.mode && ed.mode.k === 'wire') && ((app.editor.hooks.running() && (d.interactive || d.click)) || d.wheel)) { g.pass = true; fwd(ed._down, ev); return; }   // buttons/knobs work live
    if (p) g.lp = setTimeout(() => { if (!g || g.moved) return; const w = ed.toWorld(g.ev); ed.select({ part: p.id }); ed.mode = { k: 'drag', p, ox: p.x, oy: p.y, sx: w.x, sy: w.y, moved: false }; g.drag = p; lift(p, true); if (navigator.vibrate) navigator.vibrate(18); }, 380);
  }
  function move(ev) {
    if (!touchy(ev) || !pts.has(ev.pointerId)) return; ev.stopImmediatePropagation(); ev.preventDefault();
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && pts.size >= 2) { const [a, b] = [...pts.values()], r = pinch.r, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = Math.min(5, Math.max(0.12, pinch.s0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
      ed.view = { s, x: pinch.w0.x - (mx - r.left) / s, y: pinch.w0.y - (my - r.top) / s }; ed.applyView(); showZoom(); return; }
    if (!g) return;
    if (g.pass || g.drag) { fwd(ed._move, ev); return; }
    const dx = ev.clientX - g.x0, dy = ev.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > 9) { g.moved = true; clearTimeout(g.lp); }
    if (g.moved) { ed.view.x = g.v0.x - dx / ed.view.s; ed.view.y = g.v0.y - dy / ed.view.s; ed.applyView(); if (ed.mode && ed.mode.k === 'wire') ed._drawWirePreview(ed.toWorld(ev)); }
  }
  function up(ev) {
    if (!touchy(ev) || !pts.has(ev.pointerId)) return; ev.stopImmediatePropagation(); ev.preventDefault();
    pts.delete(ev.pointerId);
    if (pinch) { if (pts.size === 0) pinch = null; return; }
    if (!g) return; const G0 = g; g = null; clearTimeout(G0.lp);
    if (G0.pass) { fwd(ed._up, ev); return; }
    if (G0.drag) { fwd(ed._up, ev); lift(G0.drag, false); showInsp(); return; }
    if (!G0.moved && ev.type === 'pointerup') tap(ev);
  }
  // finger-sized hit testing (in screen px, independent of zoom)
  const FINGER = 26;
  function pinTouch(ev, ownPartOnly) {
    const w = ed.toWorld(ev), r = FINGER / ed.view.s; let best = null, bd = r * r;
    for (const q of ed.pinIndex()) { if (ownPartOnly && q.part !== ownPartOnly) continue; const dx = q.pos.x - w.x, dy = q.pos.y - w.y, d = dx * dx + dy * dy + (q.bb ? r * r * 0.35 : 0); if (d < bd) { bd = d; best = q; } }
    return best;
  }
  function partTouch(ev) {   // nearest non-breadboard part whose on-screen box (inflated to finger size) contains the tap
    let best = null, bd = 1e18;
    for (const [id, el] of ed.partEls) { const p = ed.part(id); if (!p || p.type === 'breadboard') continue; const r = el.getBoundingClientRect(), pad = Math.max(0, (44 - Math.min(r.width, r.height)) / 2) + 6;
      if (ev.clientX < r.left - pad || ev.clientX > r.right + pad || ev.clientY < r.top - pad || ev.clientY > r.bottom + pad) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = (cx - ev.clientX) ** 2 + (cy - ev.clientY) ** 2 + r.width * r.height * 0.02; if (d < bd) { bd = d; best = p; } }
    return best;
  }
  function startWire(pin, ev) { closeAll(); ed.select(null); ed.mode = { k: 'wire', a: pin.pos, pts: [], start: pin, t0: Date.now() }; ed._drawWirePreview(ed.toWorld(ev)); ed.highlight(pin); setWiring('From ' + ed.pinLabel(pin) + ' → tap a pin'); if (navigator.vibrate) navigator.vibrate(10); }
  function tap(ev) {
    const m = ed.mode;
    if (m && m.k === 'wire') {
      const pin = pinTouch(ev);
      if (pin) { if (pin.pos.x === m.a.x && pin.pos.y === m.a.y && !m.pts.length) { ed.cancelWire(); return; } ed._finishWire(pin.pos); setWiring(null); mtoast('Wired to ' + ed.pinLabel(pin)); return; }
      const w = ed.toWorld(ev), last = m.pts.length ? m.pts[m.pts.length - 1] : m.a, q = { x: Math.round(w.x / 10) * 10, y: Math.round(w.y / 10) * 10 };
      m.pts.push(...ed._ortho(last, q)); ed._drawWirePreview(w); mtoast('Bend added — tap the target pin'); return;
    }
    const pin = pinTouch(ev), part = partTouch(ev);
    if (pin && !pin.bb) {   // a component leg: wire from it unless the finger is clearly on that part's body centre
      const own = part && part === pin.part, el = own && ed.partEls.get(part.id), r = el && el.getBoundingClientRect();
      const ps = { x: (pin.pos.x - ed.view.x) * ed.view.s, y: (pin.pos.y - ed.view.y) * ed.view.s }, sr = svg.getBoundingClientRect(), dpx = Math.hypot(sr.left + ps.x - ev.clientX, sr.top + ps.y - ev.clientY);
      if (!own || dpx < 14 || (r && Math.max(r.width, r.height) > 120)) { startWire(pin, ev); return; }
    }
    if (part) { ed.select({ part: part.id }); showInsp(); return; }
    const wEl = ev.target.closest && ev.target.closest('.wire'); if (wEl) { ed.select({ wire: wEl.dataset.wid }); showInsp(); return; }
    if (pin) { startWire(pin, ev); return; }
    ed.select(null); closeAll();
  }
  // newly added parts: zoom in so they are big enough to touch
  const origAdd = ed.addPart.bind(ed); ed.addPart = function (t, x, y) { const p = origAdd(t, x, y); if (ed.view.s < 1.1) { const r = svg.getBoundingClientRect(), s = 1.4; ed.view = { s, x: p.x - r.width / s / 2, y: p.y - r.height / s / 2 }; ed.applyView(); } return p; };
  svg.addEventListener('pointerdown', down, true); svg.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
  svg.addEventListener('contextmenu', (e) => e.preventDefault(), true);
  // keep the sheet in sync with selection changes made elsewhere (undo, delete)
  const origSel = ed.hooks.selected; ed.hooks.selected = (s) => { origSel(s); if (!s && openS === insp) closeAll(); };

  setInterval(() => { if (wiring.classList.contains('on') && !(ed.mode && ed.mode.k === 'wire')) setWiring(null); }, 250);
  // tighter fit for small screens (desktop fit pads 40 world units per side)
  ed.fit = function () { const bb = this.bounds(), r = svg.getBoundingClientRect(); if (!bb || !r.width) return; const pad = 8;
    const s = Math.min(3, Math.max(0.12, Math.min(r.width / (bb.w - 40), r.height / (bb.h - 40)) * 0.94));
    this.view = { s, x: bb.x + 30 - (r.width / s - (bb.w - 60)) / 2, y: bb.y + 40 - pad / s - (r.height / s - (bb.h - 70)) / 2 }; this.applyView(); };
  // first paint
  sync(); setView('circuit'); setTimeout(() => { ed.applyView(); ed.fit(); }, 60);
  window.addEventListener('resize', () => setTimeout(() => ed.applyView(), 50));
  window.MobileUI = { setView, openSheet, mtoast };
});
