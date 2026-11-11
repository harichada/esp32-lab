/* Mobile shell (<=820px): full-screen canvas, slim top bar, bottom tab bar, bottom sheets, touch gestures.
   Everything here is gated on body.m, which is only set while the viewport is <=820px; desktop is untouched. */
(function () {
  const MQ = window.matchMedia('(max-width: 820px), (pointer: coarse) and (max-height: 520px)');   // phones in portrait, and phones in landscape
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const ic = (id) => `<svg class="ic"><use href="#${id}"/></svg>`;
  const ICONS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' +
    '<symbol id="m-circuit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4a2.5 2.5 0 0 1 2.5 2.5v5"/><circle cx="6.5" cy="17.5" r="2.5"/><path d="M6.5 10v5"/></symbol>' +
    '<symbol id="m-code" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16"/></symbol>' +
    '<symbol id="m-parts" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><path d="M17.25 14v6.5M14 17.25h6.5"/></symbol>' +
    '<symbol id="m-serial" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M6.5 9l3 3-3 3M12 15h5"/></symbol>' +
    '<symbol id="m-more" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></symbol>' +
    '<symbol id="m-scope" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M5 14h3l2-6 3 9 2-5h4"/></symbol>' +
    '<symbol id="m-sliders" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></symbol>' +
    '</svg>';
  let built = false, app, ed, sheet = null;

  function setSheet(name) {
    sheet = name || null; document.body.dataset.msheet = sheet || '';
    $$('.m-tab').forEach((b) => b.classList.toggle('on', b.dataset.m === (sheet === 'dock' ? 'more' : sheet || 'circuit')));
    const si = $('#scopeInst'), ms = $('#mScope');
    if (si && ms) { if (sheet === 'scope') { if (si.parentNode !== ms) ms.appendChild(si); } else if (si.parentNode === ms) $('#tab-scope').appendChild(si); }
    const cur = { scope: ['m-scope', 'SCOPE'], code: ['m-code', 'CODE'], parts: ['m-parts', 'PARTS'], serial: ['m-serial', 'SERIAL'], insp: ['m-sliders', 'INSPECT'], more: ['m-more', 'MORE'], dock: ['m-more', 'PANEL'] }[sheet] || ['m-circuit', 'CIRCUIT'];
    const hub = $('#mHub'); if (hub) { hub.querySelector('use').setAttribute('href', '#' + cur[0]); hub.querySelector('.m-hub-t').textContent = cur[1]; }
    if (sheet === 'code') dockTab('code'); else if (sheet === 'serial') dockTab('serial');
    if (sheet === 'parts' && window.Mobile_orbit) setTimeout(window.Mobile_orbit, 30);
    if (sheet === 'code') setTimeout(() => app.codeView && app.codeView.refresh && app.codeView.refresh(), 0);
    if (!sheet) $$('.m-sheet input, #dock textarea, #palSearch').forEach((x) => x.blur());
    setTimeout(() => ed && ed.applyView(), 260);
  }
  function dockTab(t) { const b = $(`#tabs [data-tab=${t}]`); if (b && !b.classList.contains('on')) b.click(); const h = $('#dock .m-sh-t'); if (h) h.textContent = b ? b.textContent : t; }
  function openDock(t) { setSheet('dock'); dockTab(t); }

  // drag-to-dismiss on a sheet's handle/header
  function dragClose(el, handle) {
    let y0 = null, dy = 0;
    handle.addEventListener('pointerdown', (e) => { if (e.target.closest('button,input,select')) return; y0 = e.clientY; dy = 0; el.style.transition = 'none'; handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); el.style.transform = `translateY(${dy}px)`; });
    const end = () => { if (y0 == null) return; y0 = null; el.style.transition = ''; el.style.transform = ''; if (dy > 70) setSheet(null); };
    handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  }
  function sheetHead(el, title, extra) {
    const h = document.createElement('div'); h.className = 'm-sh-h';
    h.innerHTML = `<i class="m-grab"></i><div class="m-sh-row"><span class="m-sh-t">${title}</span>${extra || ''}<button class="m-x" aria-label="Close">${ic('i-x')}</button></div>`;
    el.prepend(h); h.querySelector('.m-x').onclick = () => setSheet(null); dragClose(el, h); return h;
  }

  function build() {
    built = true; app = window.app; ed = app.editor;
    document.body.insertAdjacentHTML('afterbegin', ICONS);
    // top bar: overflow + compact stop
    const top = $('header#top');
    top.insertAdjacentHTML('beforeend', `<button id="mMenu" class="iconbtn m-only" aria-label="More">${ic('m-more')}</button>`);
    $('#mMenu').onclick = () => setSheet(sheet === 'more' ? null : 'more');
    // orbital command dial (bottom centre) + ignition (bottom right) + telemetry ticker
    const modes = [['circuit', 'Circuit', 'm-circuit'], ['code', 'Code', 'm-code'], ['parts', 'Parts', 'm-parts'], ['serial', 'Serial', 'm-serial'], ['insp', 'Inspect', 'm-sliders'], ['scope', 'Scope', 'm-scope'], ['more', 'More', 'm-more']];
    document.body.insertAdjacentHTML('beforeend', `<div id="mScrim" class="m-only"></div>
      <nav id="mDial" class="m-only" aria-label="Mode dial"><div class="m-orbit">${modes.map(([k, n, i], j) => `<button class="m-tab" data-m="${k}" style="--j:${j}" aria-label="${n}">${ic(i)}<span>${n}</span></button>`).join('')}</div>
        <button id="mHub" aria-label="Open mode dial"><svg class="m-ring" viewBox="0 0 80 80"><circle cx="40" cy="40" r="36"/><circle cx="40" cy="40" r="30" class="m-ring2"/></svg><span class="m-hub-i">${ic('m-circuit')}</span><span class="m-hub-t">CIRCUIT</span></button></nav>
      <button id="mIgnite" class="m-only" aria-label="Run"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" class="m-ig-bg"/><circle cx="40" cy="40" r="34" class="m-ig-p" pathLength="100"/></svg><span class="m-ig-i">${ic('i-play')}</span><span class="m-ig-t">RUN</span></button>
      <div id="mTicker" class="m-only"><div id="mTickT"></div></div><div id="mCount" class="m-only"></div><div id="mFlash" class="m-only"></div>`);
    const dial = $('#mDial'); let dialOpen = false;
    const openDial = (v) => { dialOpen = v; dial.classList.toggle('open', v); document.body.classList.toggle('m-dial', v); haptic(6); };
    $('#mHub').onclick = () => openDial(!dialOpen);
    dial.querySelector('.m-orbit').onclick = (e) => { const b = e.target.closest('.m-tab'); if (!b) return; const k = b.dataset.m; openDial(false); haptic(10);
      if (k === 'insp' && !(ed.sel && ed.sel.part)) { app.cmd.toast('Select a part first, then Inspect'); return; } setSheet(k === 'circuit' || k === sheet ? null : k); };
    $('#mScrim').onclick = () => { if (dialOpen) openDial(false); setSheet(null); };
    $('#mMenu').onclick = () => setSheet(sheet === 'more' ? null : 'more');
    ignition();
    $('#stageWrap').insertAdjacentHTML('beforeend', `<button id="mParts" class="m-only" aria-label="Add parts">${ic('i-plus')}<span>PARTS</span></button>`);
    $('#mParts').onclick = () => { haptic(6); setSheet(sheet === 'parts' ? null : 'parts'); setTimeout(() => window.Mobile_orbit && window.Mobile_orbit(), 350); };
    telemetry();
    // sheets: parts (palette), code/serial/other (dock), inspector (side), more (new)
    const pal = $('#palette'); pal.classList.add('m-sheet'); sheetHead(pal, 'Parts');
    const chips = document.createElement('div'); chips.className = 'm-chips';
    const cats = $$('.pcat', pal).map((c) => c.dataset.cat);
    chips.innerHTML = ['All', ...cats].map((c, i) => `<button class="m-chip${i ? '' : ' on'}" data-c="${c}">${c}</button>`).join('');
    $('.pal-search', pal).after(chips);
    chips.onclick = (e) => { const b = e.target.closest('.m-chip'); if (!b) return; $$('.m-chip', chips).forEach((x) => x.classList.toggle('on', x === b)); filterCat(b.dataset.c); track.scrollLeft = 0; requestAnimationFrame(() => window.Mobile_orbit()); b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); };
    function filterCat(c) { $$('.pitem', track).forEach((it) => it.classList.toggle('m-off', c !== 'All' && it.dataset.cat !== c)); $$('.pcat', pal).forEach((h) => { const on = c === 'All' || h.dataset.cat === c; h.classList.toggle('m-off', !on); h.nextElementSibling.classList.toggle('m-off', !on); if (on) { h.classList.remove('closed'); h.nextElementSibling.classList.remove('closed'); } }); }
    $('#palSearch').setAttribute('enterkeyhint', 'search');
    const pl = $('#palList'); let cr = 0;
    const track = document.createElement('div'); track.id = 'mTrack'; track.className = 'm-only'; pl.before(track);
    $$('.pgrid', pl).forEach((g) => [...g.children].forEach((it) => { it.dataset.cat = g.dataset.cat; }));
    window.Mobile_track = (on) => { if (on) $$('.pitem', pl).forEach((it) => track.appendChild(it)); else { $$('.pitem', track).forEach((it) => { const g = pl.querySelector(`.pgrid[data-cat="${CSS.escape(it.dataset.cat)}"]`); if (g) g.appendChild(it); it.style.transform = ''; it.style.opacity = ''; }); } };
    const orbit = () => { cr = 0; if (!document.body.classList.contains('m') || sheet !== 'parts') return; const r = track.getBoundingClientRect(), cx = r.left + r.width / 2;
      for (const it of track.querySelectorAll('.pitem')) { if (it.offsetParent === null) continue; const b = it.getBoundingClientRect(); const d = Math.max(-1.6, Math.min(1.6, (b.left + b.width / 2 - cx) / (r.width / 2)));
        it.style.transform = RM.matches ? '' : `perspective(700px) translateZ(${(-Math.abs(d) * 70).toFixed(1)}px) rotateY(${(-d * 32).toFixed(1)}deg)`; it.style.opacity = (1 - Math.min(0.65, Math.abs(d) * 0.4)).toFixed(2); it.classList.toggle('m-focus', Math.abs(d) < 0.22); } };
    track.addEventListener('scroll', () => { if (!cr) cr = requestAnimationFrame(orbit); }, { passive: true });
    window.Mobile_orbit = () => requestAnimationFrame(orbit);
    $('#palSearch').addEventListener('input', () => { track.scrollLeft = 0; const any = $$('.pitem', track).some((x) => !x.hidden && !x.classList.contains('m-off')); track.classList.toggle('m-empty', !any); requestAnimationFrame(orbit); });
    track.addEventListener('click', (e) => { const it = e.target.closest('.pitem'); if (!it) return; setSheet(null); app.cmd.toast('Added ' + it.querySelector('span').textContent + ' · drag to place'); }, true);
    const dock = $('#dock'); dock.classList.add('m-sheet'); sheetHead(dock, 'Code');
    const side = $('#side'); side.classList.add('m-sheet'); sheetHead(side, 'Properties');
    // symbol bar for the code editor
    const syms = ['Tab', '{', '}', '(', ')', ';', '=', '"', '<', '>', '[', ']', '&', '|', '!', '+', '-', '*', '/', '#', "'", '_', ':', ','];
    const sb = document.createElement('div'); sb.className = 'm-symbar m-only'; sb.innerHTML = syms.map((s) => `<button data-s="${s.replace(/"/g, '&quot;')}">${s.replace(/</g, '&lt;')}</button>`).join('');
    $('#codeWrap').after(sb);
    sb.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the keyboard up
    sb.onclick = (e) => { const b = e.target.closest('[data-s]'); if (!b) return; const ta = $('#code'); const t = b.dataset.s === 'Tab' ? '  ' : b.dataset.s;
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: t, bubbles: true, cancelable: true }));
      const s = ta.selectionStart; ta.setRangeText(t, s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); };
    $('#code').setAttribute('autocorrect', 'off');
    // More sheet
    const more = document.createElement('section'); more.id = 'mMore'; more.className = 'panel m-sheet m-only';
    more.innerHTML = `<div class="m-more-b">
      <div class="m-grp"><div class="m-lbl">Examples</div><div class="m-selwrap" id="mExWrap"></div></div>
      <div class="m-grp"><div class="m-lbl">Project</div><div class="m-grid">
        <button data-a="projects">${ic('i-folder')}<span>My projects</span></button><button data-a="save">${ic('i-save')}<span>Save</span></button>
        <button data-a="download">${ic('i-download')}<span>Download</span></button><button data-a="import">${ic('i-upload')}<span>Import</span></button></div></div>
      <div class="m-grp"><div class="m-lbl">Simulation</div><div class="m-grid">
        <button data-a="restart">${ic('i-restart')}<span>Restart</span></button><button data-a="reset">${ic('i-reset')}<span>Reset state</span></button>
        <button data-a="fit">${ic('i-fit')}<span>Fit to view</span></button><button data-a="theme">${ic('i-sun')}<span>Theme</span></button></div></div>
      <div class="m-grp"><div class="m-lbl">Panels</div><div class="m-list">
        <button data-d="code">Code</button><button data-d="serial">Serial</button><button data-d="bom">Parts list (BOM)</button><button data-d="net">Network</button><button data-d="dev">Devices</button><button data-d="scope">Scope</button><button data-d="build">Build log</button><button data-d="about">About</button></div></div>
      <div class="m-grp"><div class="m-lbl">Wiring</div><div class="m-wire" id="mWire"><p class="m-wire-cap">New wire colour. This does not change a selected part.</p></div></div>
      <div class="m-grp"><div class="m-lbl">Feedback</div><div class="m-wire"><label class="m-sw"><input type="checkbox" id="mHap"><span>Haptics</span></label><label class="m-sw"><input type="checkbox" id="mSnd"><span>Sound effects</span></label></div></div>
      <div class="m-legal"><span id="mConn" class="conn"><i></i><span>backend</span></span><a href="notices.html" target="_blank" rel="noopener">Open-source notices</a><small>Simulator for ESP32 · © 2026 Hari Kishore Chada. Not affiliated with Espressif, Arduino or Wokwi.</small></div></div>`;
    document.body.appendChild(more); sheetHead(more, 'More');
    // full-screen oscilloscope HUD sheet (the instrument DOM moves here while open)
    const msc = document.createElement('section'); msc.id = 'mScope'; msc.className = 'panel m-sheet m-only'; document.body.appendChild(msc); sheetHead(msc, 'Oscilloscope', '<span class="m-sc-tag">MSO-4 · LIVE</span>');
    if (window.Instruments) { Instruments.onArm = () => { if (document.body.classList.contains('m') && sheet === 'scope') { setSheet(null); app.cmd.toast('Tap a pin or wire to probe'); } }; Instruments.onProbed = () => { if (document.body.classList.contains('m')) setSheet('scope'); }; }
    more.onclick = (e) => { const b = e.target.closest('[data-a],[data-d]'); if (!b) return; const a = b.dataset.a;
      if (b.dataset.d === 'scope' || b.dataset.d === 'code' || b.dataset.d === 'serial') { setSheet(b.dataset.d); return; }
      if (b.dataset.d) { openDock(b.dataset.d); return; }
      if (a === 'projects') { setSheet(null); app.cmd.projects(); } else if (a === 'save') { app.cmd.save(); } else if (a === 'download') app.cmd.download();
      else if (a === 'import') $('#fileIn').click(); else if (a === 'restart') { setSheet(null); app.cmd.restart(); } else if (a === 'reset') $('#bReset').click();
      else if (a === 'fit') { setSheet(null); ed.fit(); } else if (a === 'theme') $('#bTheme').click(); };
    // examples select: a mobile copy that drives the real one
    const ex = $('#selExample').cloneNode(true); ex.id = 'mSelExample'; ex.value = ''; $('#mExWrap').appendChild(ex);
    ex.onchange = () => { const v = ex.value; ex.value = ''; if (!v) return; const s = $('#selExample'); s.value = v; s.dispatchEvent(new Event('change')); setSheet(null); };
    $('#mWire').append($('#selWireColor').cloneNode(true)); const wc = $('#mWire select'); wc.id = 'mWireColor'; wc.value = $('#selWireColor').value; wc.onchange = () => { const s = $('#selWireColor'); s.value = wc.value; s.dispatchEvent(new Event('change')); };
    for (const id of ['cbOrtho', 'cbFlow']) { const src = $('#' + id), l = document.createElement('label'); l.className = 'm-sw'; l.innerHTML = `<input type="checkbox"><span>${id === 'cbOrtho' ? 'Right-angle wires' : 'Animate current flow'}</span>`; const c = l.firstChild; c.checked = src.checked; c.onchange = () => { if (src.checked !== c.checked) src.click(); }; $('#mWire').append(l); }
    $('#mHap').checked = localStorage.getItem('esp32lab.haptics') !== '0'; $('#mHap').onchange = (e) => localStorage.setItem('esp32lab.haptics', e.target.checked ? '1' : '0');
    $('#mSnd').checked = localStorage.getItem('esp32lab.sound') === '1'; $('#mSnd').onchange = (e) => { localStorage.setItem('esp32lab.sound', e.target.checked ? '1' : '0'); sound(660); };
    new MutationObserver(() => { $('#mConn').className = $('#connDot').className; $('#mConn').title = $('#connDot').title; }).observe($('#connDot'), { attributes: true });
    $('#mConn').className = $('#connDot').className;
    // selection actions floating over the canvas
    const sel = document.createElement('div'); sel.id = 'mSel'; sel.className = 'm-only';
    sel.innerHTML = `<button data-a="rot" aria-label="Rotate">${ic('i-rotate')}</button><button data-a="flip" aria-label="Flip">Flip</button><button data-a="flipH" aria-label="Flip horizontal" hidden>Flip H</button><button data-a="flipV" aria-label="Flip vertical" hidden>Flip V</button><button data-a="props" aria-label="Properties">${ic('m-sliders')}<span>Properties</span></button><button data-a="del" class="danger" aria-label="Delete">${ic('i-trash')}</button>`;
    $('#stageWrap').appendChild(sel);
    sel.onclick = (e) => { const b = e.target.closest('[data-a]'); if (!b || b.getAttribute('aria-disabled') === 'true') return; if (document.body.classList.contains('viewsch') && (b.dataset.a === 'rot' || b.dataset.a === 'del')) return; if (b.dataset.a === 'rot') ed.rotateSel(); else if (b.dataset.a === 'flip' || b.dataset.a === 'flipH') ed.flipSel('x'); else if (b.dataset.a === 'flipV') ed.flipSel('y'); else if (b.dataset.a === 'del') ed.deleteSel(); else setSheet('insp'); };
    const hs = ed.hooks.selected; ed.hooks.selected = (s) => {
      hs(s);
      const has = !!(s && (s.part || s.wire));
      document.body.classList.toggle('m-has-sel', has);
      sel.querySelector('[data-a=rot]').hidden = !(s && s.part);
      const sch = document.body.classList.contains('viewsch');
      const part = s && s.part && ed.part(s.part);
      const physical = !!(part && window.Parts && Parts.canPhysicalFlip(part));
      const tip = (window.Parts && Parts.NO_FLIP_TIP) || "Real parts can't be mirrored; rotate instead";
      const show = !!(s && s.part);
      const one = sel.querySelector('[data-a=flip]');
      one.hidden = !show || sch;
      one.setAttribute('aria-disabled', physical ? 'false' : 'true');
      one.title = physical ? 'Turn end for end' : tip;
      const fh = sel.querySelector('[data-a=flipH]'), fv = sel.querySelector('[data-a=flipV]');
      fh.hidden = !show || !sch; fv.hidden = !show || !sch;
      fh.setAttribute('aria-disabled', 'false'); fv.setAttribute('aria-disabled', 'false');
      fh.title = 'Mirror the symbol (drawing only)'; fv.title = 'Mirror the symbol (drawing only)';
      // A wire used to leave only the trash button: Properties was part-only, and nothing opened the sheet.
      sel.querySelector('[data-a=props]').hidden = !(s && (s.part || s.wire));
      if (s && s.wire && document.body.classList.contains('m')) setSheet('insp');
      else if (!has && sheet === 'insp') setSheet(null);
    };
    // wiring state -> highlight valid targets, larger hit radius while wiring
    const pn = ed.pinNear.bind(ed);
    ed.pinNear = function (w, ev, maxR) { if (document.body.classList.contains('m') && this.mode && this.mode.k === 'wire') maxR = Math.max(maxR || 14, Math.min(30, 30 / this.view.s)); return pn(w, ev, maxR); };
    setInterval(() => { const on = !!(ed.mode && ed.mode.k === 'wire'); if (on !== document.body.classList.contains('m-wiring')) { document.body.classList.toggle('m-wiring', on); $('#mWireBar').hidden = !on; } }, 100);
    $('#stageWrap').insertAdjacentHTML('beforeend', `<div id="mWireBar" class="m-only" hidden><span>Tap a highlighted pin to connect</span><button id="mWireX">Cancel</button></div>`);
    $('#mWireX').onclick = () => ed.cancelWire();
    touch();
    const fw = ed._finishWire.bind(ed); ed._finishWire = function (b, pin) { const n = this.proj.wires.length; fw(b, pin); if (this.proj.wires.length > n && document.body.classList.contains('m')) { haptic([8, 30, 14]); sound(880); } };
    const ap = ed.addPart.bind(ed); ed.addPart = function (...a) { const r = ap(...a); if (document.body.classList.contains('m')) { haptic(10); sound(660); } return r; };
    const dw = ed._down.bind(ed); ed._down = function (ev) { const was = this.mode && this.mode.k; dw(ev); if (document.body.classList.contains('m') && was !== 'wire' && this.mode && this.mode.k === 'wire') { haptic(6); sound(520); } };
    const av = ed.applyView.bind(ed); ed.applyView = function () { av(); const w = $('#stageWrap'); if (w) { w.style.setProperty('--px', (-this.view.x * 0.08 % 400).toFixed(1) + 'px'); w.style.setProperty('--py', (-this.view.y * 0.08 % 400).toFixed(1) + 'px'); } };
    // hint text for phones
    ed.setHint = function (t) { if (!this.hintEl) return; if (document.body.classList.contains('viewsch')) { this.hintEl.textContent = 'F mirrors the symbol (drawing only, wiring unchanged)'; return; } this.hintEl.textContent = t || (document.body.classList.contains('m') ? 'Tap a part to select it. Tap a pin, then another pin, to wire' : this.defaultHint()); };
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet && document.body.classList.contains('m')) setSheet(null); });
  }

  const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
  function haptic(p) { try { if (navigator.vibrate && localStorage.getItem('esp32lab.haptics') !== '0') navigator.vibrate(p); } catch (e) { /* */ } }
  let actx = null;
  function sound(f) { if (localStorage.getItem('esp32lab.sound') !== '1') return; try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.05, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.12); o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.13); } catch (e) { /* */ } }
  function ignition() {
    // The round control used to say HOLD: a 650 ms press, then a T−3 countdown, before it
    // clicked the real Run button (which is hidden on a phone). A tap did nothing useful.
    const b = $('#mIgnite');
    const running = () => document.body.classList.contains('running') || !!app.run;
    const paint = () => {
      const on = running(), busy = !on && document.body.classList.contains('busy');
      b.classList.toggle('live', on);
      b.querySelector('use').setAttribute('href', on ? '#i-stop' : '#i-play');
      b.querySelector('.m-ig-t').textContent = on ? 'STOP' : busy ? 'BOOT' : 'RUN';
      b.setAttribute('aria-label', on ? 'Stop' : busy ? 'Starting' : 'Run');
    };
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (running()) { haptic(20); $('#bStop').click(); return; }
      haptic(12); sound(440); $('#bRun').click();
    });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    new MutationObserver(paint).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    paint();
  }
  function telemetry() {
    const el = $('#mTickT'), wrap = $('#stageWrap'); let burned0 = 0, t = 0;
    const f = (v, u) => { const a = Math.abs(v); return a >= 1 ? a.toFixed(2) + u : a >= 1e-3 ? (a * 1e3).toFixed(1) + 'm' + u : (a * 1e6).toFixed(0) + 'µ' + u; };
    setInterval(() => {
      if (!document.body.classList.contains('m') || !app.proj || !app.sim) return;
      let I = 0, lit = 0, burned = 0; const hi = [];
      for (const q of app.proj.parts) { const s = app.sim.state[q.id]; if (!s) continue; if (s.i) I += Math.abs(s.i); if (s.bright > 0.01) lit++; if (s.burned) burned++; }
      const esp = app.proj.parts.find((q) => q.type === 'esp32');
      if (esp && app.run) { try { for (const pin of window.Parts.T.esp32.pins(esp)) if (/^D\d+$/.test(pin.name) && app.sim.pinVoltage(esp, pin.name) > 2) hi.push(pin.name.slice(1)); } catch (e) { /* */ } }
      const st = ($('#stText') || {}).textContent || '', tm = ($('#stTime') || {}).textContent || '';
      el.innerHTML = [['SYS', st.toUpperCase()], tm && ['T+', tm], ['I', f(I, 'A')], ['LIT', lit], hi.length && ['GPIO↑', hi.slice(0, 6).join(',')], ...(window.Instruments ? Instruments.tickerItems().map(([k, v]) => ['◉ ' + k, v]) : []), ['PARTS', app.proj.parts.length], ['TRACES', app.proj.wires.length], burned && ['BURN', burned]].filter(Boolean).map(([k, v]) => `<span><b>${k}</b>${window.Parts.esc(String(v))}</span>`).join('');
      // energy traces: brighter and faster with more current
      const k = Math.min(1, I / 0.04); wrap.style.setProperty('--flowDur', (1.6 - 1.2 * k).toFixed(2) + 's'); wrap.style.setProperty('--flowGlow', (0.35 + 0.65 * k).toFixed(2));
      if (burned > burned0) { const fl = $('#mFlash'); fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on'); haptic([30, 20, 60]); sound(120); }
      burned0 = burned;
    }, 250);
  }
  function touch() {
    const wrap = $('#stageWrap'), st = $('#stage'); const pts = new Map(); let g = null, lp = null;
    const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
    const on = () => document.body.classList.contains('m');
    wrap.addEventListener('pointerdown', (e) => {
      if (!on() || e.pointerType !== 'touch' || !st.contains(e.target)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {   // long-press on a part -> action menu
        const pg = e.target.closest && e.target.closest('.part'); clearTimeout(lp && lp.t);
        if (pg) lp = { x: e.clientX, y: e.clientY, id: pg.dataset.id, t: setTimeout(() => longPress(lp), 480) }; else lp = null;
      }
      if (pts.size === 2) {
        e.stopPropagation(); clearTimeout(lp && lp.t); lp = null;
        if (ed.mode && ed.mode.k === 'drag' && ed.mode.moved) { ed.mode.p.x = ed.mode.ox; ed.mode.p.y = ed.mode.oy; ed.undoS.pop(); ed.render(); }
        if (ed.mode && ed.mode.k === 'wire' && Date.now() - (ed.mode.t0 || 0) < 400) ed.cancelWire(); else if (!(ed.mode && ed.mode.k === 'wire')) ed.mode = null;
        const m = mid(), r = st.getBoundingClientRect(); g = { m, s: ed.view.s, wx: ed.view.x + (m.x - r.left) / ed.view.s, wy: ed.view.y + (m.y - r.top) / ed.view.s };
      }
    }, true);
    wrap.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) { clearTimeout(lp.t); lp = null; }
      if (g && pts.size === 2) { e.stopPropagation(); e.preventDefault(); const m = mid(), r = st.getBoundingClientRect(); const s = Math.min(4, Math.max(0.15, g.s * m.d / (g.m.d || 1)));
        ed.markUserView && ed.markUserView();
        ed.view.s = s; ed.view.x = g.wx - (m.x - r.left) / s; ed.view.y = g.wy - (m.y - r.top) / s; ed.applyView(); const z = $('#zoomPct'); if (z) z.textContent = Math.round(s * 100) + '%'; }
    }, true);
    const up = (e) => { if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); if (lp) { clearTimeout(lp.t); lp = null; } if (pts.size < 2) { if (g) e.stopPropagation(); g = null; } };
    wrap.addEventListener('pointerup', up, true); wrap.addEventListener('pointercancel', up, true);
    st.addEventListener('contextmenu', (e) => { if (on() && e.target.closest('.part')) e.preventDefault(); });
    ['gesturestart', 'gesturechange'].forEach((n) => document.addEventListener(n, (e) => e.preventDefault()));
  }
  function longPress(l) {
    if (!l || ed.mode && ed.mode.k === 'wire') return; const p = ed.part(l.id); if (!p) return;
    if (ed.mode && ed.mode.k === 'drag') { if (ed.mode.moved) return; ed.mode = null; }
    ed.select({ part: p.id }); if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) { /* */ }
    $('#mPartMenu') && $('#mPartMenu').remove();
    const P = window.Parts, label = (P.T[p.type] && P.T[p.type].label) || p.type;
    const m = document.createElement('div'); m.id = 'mPartMenu'; m.className = 'm-only';
    const flipOk = P.canPhysicalFlip(p);
    const tip = P.NO_FLIP_TIP;
    m.innerHTML = `<div class="m-pm-t">${P.esc(label)} <small>${P.esc(p.id)}</small></div><button data-a="rot">${ic('i-rotate')}<span>Rotate 90°</span></button><button data-a="flip" aria-disabled="${flipOk ? 'false' : 'true'}" title="${P.esc(flipOk ? 'Turn end for end' : tip)}"><span>↔ Flip</span></button><button data-a="props">${ic('m-sliders')}<span>Properties</span></button><button data-a="del" class="danger">${ic('i-trash')}<span>Delete</span></button>`;
    document.body.appendChild(m);
    const close = () => { m.remove(); document.removeEventListener('pointerdown', away, true); };
    const away = (e) => { if (!m.contains(e.target)) close(); }; setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    m.onclick = (e) => { const b = e.target.closest('[data-a]'); if (!b || b.getAttribute('aria-disabled') === 'true') return; close(); if (b.dataset.a === 'rot') ed.rotateSel(); else if (b.dataset.a === 'flip') ed.flipSel('x'); else if (b.dataset.a === 'del') ed.deleteSel(); else setSheet('insp'); };
  }

  // sheets must live at <body> level on phones (so they stack above the canvas and scrim); put them back for desktop
  const homes = new Map();
  function relocate(m) {
    for (const id of ['palette', 'dock', 'side']) { const el = document.getElementById(id); if (!el) continue;
      if (m) { if (!homes.has(id)) homes.set(id, { parent: el.parentNode, next: el.nextSibling }); if (el.parentNode !== document.body) document.body.appendChild(el); }
      else if (homes.has(id)) { const h = homes.get(id); h.parent.insertBefore(el, h.next && h.next.parentNode === h.parent ? h.next : null); } }
  }
  function apply() {
    const m = MQ.matches, entered = m && !document.body.classList.contains('m');
    document.body.classList.toggle('m', m);
    if (m && !built && window.app && window.app.editor) build();
    if (built) { relocate(m); window.Mobile_track && window.Mobile_track(m); }
    if (!m) setSheet(null);
    // Entering the phone layout (or opening on one) refits. A desktop fit near 177%
    // otherwise stays put and clips the breadboard once the canvas is ~500px wide.
    setTimeout(() => {
      const ed = window.app && window.app.editor; if (!ed) return;
      if (entered || ed._autoFit || !ed._fitSize) ed.fit(); else ed.applyView();
    }, 60);
    if (window.app && window.app.editor) window.app.editor.setHint();
  }
  window.addEventListener('DOMContentLoaded', () => { apply(); if (MQ.addEventListener) MQ.addEventListener('change', apply); else MQ.addListener(apply); if (document.body.classList.contains('m')) setTimeout(() => window.app && window.app.editor && window.app.editor.fit(), 200); });
  window.Mobile = { setSheet, openDock };
})();
