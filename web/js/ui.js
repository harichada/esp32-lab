/* Workspace chrome: collapsible/resizable panels, command palette (Ctrl+K), shortcut overlay (?), theme switch,
 * minimap + zoom controls, pinch-zoom, code view wiring. Initialised by app.js once the editor exists: UI.init(app). */
(function (root) {
  const $ = (s) => document.querySelector(s), LS = root.localStorage;
  const get = (k, d) => { try { const v = LS.getItem('esp32lab.ui.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const put = (k, v) => { try { LS.setItem('esp32lab.ui.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const SHORTCUTS = [['Run / compile', 'Ctrl Enter'], ['Command palette', 'Ctrl K'], ['Save (copies an example)', 'Ctrl S'], ['Undo / redo', 'Ctrl Z · Ctrl Y'], ['Wire: click pin → click pin', 'Click'], ['Add bend while wiring', 'Click empty'], ['Cancel wire / deselect', 'Esc'], ['Delete selection', 'Del · ⌫'], ['Rotate part', 'R'], ['Flip part / mirror symbol', 'F'], ['Fit to view', 'Shift F'], ['Zoom in / out', '+ · −'], ['Wire menu', 'Right-click'], ['Add bend to a wire', 'Double-click'], ['Pan canvas', 'Drag background'], ['Toggle parts / inspector / dock', 'Ctrl 1 · 2 · 3'], ['This overlay', '?']];
  // The collapse control lives in #tabs. Treating every button as a tab used to
  // clear the selected tab, so reopening the dock showed its full height with
  // nothing in it. Only real tabs change the selection, and the last one is restored.
  function selectDockTab(name, doc) {
    doc = doc || document;
    const tabs = [...doc.querySelectorAll('#tabs [data-tab]')];
    let btn = tabs.find((b) => b.dataset.tab === name && b.style.display !== 'none');
    if (!btn) btn = tabs.find((b) => b.style.display !== 'none') || tabs[0];
    if (!btn) return '';
    for (const b of doc.querySelectorAll('#tabs button')) b.classList.toggle('on', b === btn);
    for (const t of doc.querySelectorAll('#dock .tab')) t.classList.toggle('on', t.id === 'tab-' + btn.dataset.tab);
    put('dockTab', btn.dataset.tab);
    return btn.dataset.tab;
  }
  function dockTabClick(e) {
    const b = e && e.target && e.target.closest && e.target.closest('button');
    if (!b || !b.dataset || !b.dataset.tab) return false;
    selectDockTab(b.dataset.tab);
    return true;
  }
  function restoreDock(doc) {
    doc = doc || document;
    const dh = get('dockH', 0);
    const rootStyle = doc.documentElement && doc.documentElement.style;
    if (dh && rootStyle) rootStyle.setProperty('--dockH', dh + 'px');
    const on = doc.querySelector('#tabs [data-tab].on');
    if (on && on.style.display !== 'none') return on.dataset.tab;
    return selectDockTab(get('dockTab', ''), doc);
  }
  function init(app) {
    const ed = app.editor, body = document.body;
    // ----- code view -----
    if (root.CodeViewMod) app.codeview = new CodeViewMod.CodeView($('#code'), $('#codeHl'), $('#codeGutter'), () => app.file);
    // ----- panels: collapse + resize (persisted) -----
    const setC = (k, v) => { body.classList.toggle('c-' + k, v); put('c-' + k, v); if (k === 'dock' && !v) restoreDock(); setTimeout(() => ed.applyView(), 0); };
    for (const k of ['palette', 'side', 'dock']) body.classList.toggle('c-' + k, !!get('c-' + k, false));
    document.addEventListener('click', (e) => { const c = e.target.closest('[data-collapse]'), r = e.target.closest('[data-reopen]'); if (c) setC(c.dataset.collapse, true); if (r) setC(r.dataset.reopen, false); });
    const rs = document.documentElement.style; const dh = get('dockH', 0), sw = get('sideW', 0); if (dh) rs.setProperty('--dockH', dh + 'px'); if (sw) rs.setProperty('--sideW', sw + 'px');
    function drag(el, onMove, done) { el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('drag'); el.setPointerCapture(e.pointerId); const mv = (ev) => { onMove(ev); ed.applyView(); }; const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); done(); }; el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); }); }
    let curH = dh || 300, curW = sw || 300;
    drag($('#dockResizer'), (e) => { const r = $('#center').getBoundingClientRect(); curH = Math.max(120, Math.min(r.height - 140, r.bottom - e.clientY)); rs.setProperty('--dockH', curH + 'px'); }, () => put('dockH', curH));
    drag($('#sideResizer'), (e) => { curW = Math.max(220, Math.min(560, innerWidth - e.clientX)); rs.setProperty('--sideW', curW + 'px'); }, () => put('sideW', curW));
    // ----- theme -----
    $('#bTheme').onclick = () => { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = t; LS.setItem('esp32lab.theme', t); drawMap(true); };
    // ----- zoom + minimap -----
    const zoomBy = (f, client) => {
      if (app.view3d && app.view3d.active && typeof app.view3d.zoomBy === 'function') { app.view3d.zoomBy(f); return; }
      if (app.schematic && app.schematic.active) { app.schematic.zoomBy(f, client); return; }
      ed.markUserView && ed.markUserView();
      const stage = $('#stage');
      const frame = root.Pinch.frameOf(stage);
      const limits = { min: 0.15, max: 3 };
      const clear = root.Pinch.resolveClear(frame, ed.bounds(), 14, limits);
      const anchor = client || { x: (clear.left + clear.right) / 2, y: (clear.top + clear.bottom) / 2 };
      const v = root.Pinch.zoomAbout(ed.view, f, anchor, frame.stage, { min: 0.15, max: 4 });
      ed.view.x = v.x; ed.view.y = v.y; ed.view.s = v.s; ed.applyView();
    };
    app.zoomBy = zoomBy; $('#bZoomIn').onclick = () => zoomBy(1.25); $('#bZoomOut').onclick = () => zoomBy(0.8);
    const fitActive = () => {
      if (app.view3d && app.view3d.active && typeof app.view3d.fit === 'function') { app.view3d.fit(); return; }
      if (app.schematic && app.schematic.active) { app.schematic.fit(); return; }
      ed.fit();
    };
    const pct = $('#zoomPct');
    if (pct) {
      pct.setAttribute('role', 'button'); pct.tabIndex = 0; pct.title = 'Zoom level. Tap to fit the circuit';
      pct.addEventListener('click', fitActive);
      pct.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fitActive(); } });
    }
    const mm = $('#minimap'); if (!get('minimap', window.innerWidth > 1400)) mm.classList.add('off'); $('#bMap').classList.toggle('on', !mm.classList.contains('off'));
    $('#bMap').onclick = () => { mm.classList.toggle('off'); put('minimap', !mm.classList.contains('off')); $('#bMap').classList.toggle('on', !mm.classList.contains('off')); drawMap(true); };
    let mmT = null, lastKey = '';
    function drawMap(force) {
      if (app.schematic && app.schematic.active) return;
      // 3D writes its own percent (fit distance, not the breadboard scale).
      if (app.view3d && app.view3d.active) return;
      const pct = Math.round(ed.view.s * 100) + '%'; if ($('#zoomPct').textContent !== pct) $('#zoomPct').textContent = pct;
      if (mm.classList.contains('off') || !ed.proj) return;
      const r = $('#stage').getBoundingClientRect(), v = ed.view, key = [v.x, v.y, v.s, r.width, r.height, ed.proj.parts.length, ed.proj.wires.length, document.documentElement.dataset.theme].join();
      if (!force && key === lastKey) return; lastKey = key;
      const bb = ed.bounds(); const g = mm.getContext('2d'), W = mm.width, H = mm.height; g.clearRect(0, 0, W, H); if (!bb) return;
      const vw = { x: v.x, y: v.y, w: r.width / v.s, h: r.height / v.s }, x0 = Math.min(bb.x, vw.x), y0 = Math.min(bb.y, vw.y), x1 = Math.max(bb.x + bb.w, vw.x + vw.w), y1 = Math.max(bb.y + bb.h, vw.y + vw.h);
      const sc = Math.min((W - 16) / (x1 - x0), (H - 16) / (y1 - y0)), ox = 8 - x0 * sc + ((W - 16) - (x1 - x0) * sc) / 2, oy = 8 - y0 * sc + ((H - 16) - (y1 - y0) * sc) / 2; mmT = { sc, ox, oy };
      const P = root.Parts, light = document.documentElement.dataset.theme === 'light';
      g.lineWidth = 1;
      for (const w of ed.proj.wires) { g.strokeStyle = (root.WIRE_COLORS[w.color] || '#3ddc84') + 'aa'; g.beginPath(); const pts = [w.a, ...(w.pts || []), w.b]; pts.forEach((q, i) => (i ? g.lineTo : g.moveTo).call(g, ox + q.x * sc, oy + q.y * sc)); g.stroke(); }
      for (const p of ed.proj.parts) { const d = P.T[p.type]; if (!d) continue; const sz = d.size(p); const rot = (p.rot || 0) & 1; g.fillStyle = p.type === 'breadboard' ? (light ? '#d9d5c8' : '#3a3a36') : p.type === 'esp32' ? '#22d3ee' : (light ? '#7c848f' : '#5b6470'); g.fillRect(ox + p.x * sc, oy + (p.y - (p.type === 'breadboard' ? 14 : 10)) * sc, Math.max(2, (rot ? sz.h : sz.w) * sc), Math.max(2, (rot ? sz.w : sz.h) * sc)); }
      g.strokeStyle = '#22d3ee'; g.lineWidth = 1.5; g.fillStyle = 'rgba(34,211,238,.08)'; g.fillRect(ox + vw.x * sc, oy + vw.y * sc, vw.w * sc, vw.h * sc); g.strokeRect(ox + vw.x * sc, oy + vw.y * sc, vw.w * sc, vw.h * sc);
    }
    app.drawMap = drawMap; setInterval(() => drawMap(false), 120);
    const mmGo = (e) => { if (!mmT) return; ed.markUserView && ed.markUserView(); const b = mm.getBoundingClientRect(), wx = ((e.clientX - b.left) * mm.width / b.width - mmT.ox) / mmT.sc, wy = ((e.clientY - b.top) * mm.height / b.height - mmT.oy) / mmT.sc, r = $('#stage').getBoundingClientRect(); ed.view.x = wx - r.width / ed.view.s / 2; ed.view.y = wy - r.height / ed.view.s / 2; ed.applyView(); drawMap(true); };
    mm.addEventListener('pointerdown', (e) => { mmGo(e); mm.setPointerCapture(e.pointerId); const mv = (ev) => mmGo(ev); mm.addEventListener('pointermove', mv); mm.addEventListener('pointerup', () => mm.removeEventListener('pointermove', mv), { once: true }); });
    // ----- pinch zoom (touch). Phones use mobile.js, which anchors on the fingers.
    // This path is the touch laptop: same anchor, and the second finger cancels a wire or drag.
    const pts = new Map(); let pinch = null, gestureSel = null; const st = $('#stage');
    st.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || document.body.classList.contains('m')) return;
      if (pts.size === 0) gestureSel = root.Pinch.cloneSel(ed.sel);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2) {
        ed._pinchLock = true;
        root.Pinch.cancelEditorGesture(ed, gestureSel);
        const [a, b] = [...pts.values()], rect = st.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const w = root.Pinch.worldAt(ed.view, mid, rect);
        pinch = { dist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), s: ed.view.s, wx: w.x, wy: w.y };
        e.preventDefault(); e.stopPropagation();
      }
    }, true);
    st.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || document.body.classList.contains('m')) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], rect = st.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const next = root.Pinch.applyView(pinch, mid, Math.hypot(a.x - b.x, a.y - b.y), rect, { min: 0.15, max: 4 });
        ed.markUserView && ed.markUserView();
        ed.view.s = next.s; ed.view.x = next.x; ed.view.y = next.y; ed.applyView();
        e.preventDefault(); e.stopPropagation();
      }
    }, true);
    const pend = (e) => {
      if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) ed._pinchLock = false;
      else e.stopPropagation();
    };
    st.addEventListener('pointerup', pend, true); st.addEventListener('pointercancel', pend, true);
    // ----- shortcuts overlay -----
    $('#keysList').innerHTML = SHORTCUTS.map(([a, k]) => `<div class="krow"><span>${a}</span><span>${k.split(' · ').map((x) => `<kbd>${x}</kbd>`).join(' ')}</span></div>`).join('');
    const keysDlg = $('#keysDlg'); const showKeys = () => { keysDlg.hidden = false; }; $('#bKeys').onclick = showKeys;
    keysDlg.addEventListener('click', (e) => { if (e.target === keysDlg || e.target.closest('[data-close]')) keysDlg.hidden = true; });
    // ----- command palette -----
    const tabs = [...document.querySelectorAll('#tabs [data-tab]')].map((b) => b.dataset.tab);
    const cmds = () => [
      ['Run simulation', 'Run', () => app.cmd.run()], ['Stop simulation', 'Run', () => app.cmd.stop()], ['Restart simulation', 'Run', () => app.cmd.restart()],
      ['Save project', 'Project', () => app.cmd.save()], ['Make a copy of this example', 'Project', () => app.cmd.makeCopy()], ['Open My Projects', 'Project', () => app.cmd.projects()], ['Download project JSON', 'Project', () => app.cmd.download()],
      ...tabs.map((t) => [`Show ${document.querySelector(`#tabs [data-tab=${t}]`).textContent} panel`, 'View', () => { setC('dock', false); document.querySelector(`#tabs [data-tab=${t}]`).click(); }]),
      ['Toggle parts panel', 'View', () => setC('palette', !body.classList.contains('c-palette'))], ['Toggle inspector', 'View', () => setC('side', !body.classList.contains('c-side'))], ['Toggle bottom panel', 'View', () => setC('dock', !body.classList.contains('c-dock'))],
      ['2D breadboard view', 'View', () => app.cmd.view2d()], ['Schematic view', 'View', () => app.cmd.viewSch && app.cmd.viewSch()], ['3D view', 'View', () => app.cmd.view3d()],
      ['Fit circuit to view', 'View', () => (app.schematic && app.schematic.active ? app.schematic.fit() : ed.fit())], ['Zoom in', 'View', () => zoomBy(1.25)], ['Zoom out', 'View', () => zoomBy(0.8)], ['Toggle minimap', 'View', () => $('#bMap').click()], ['Toggle light / dark theme', 'View', () => $('#bTheme').click()],
      ['Toggle current-flow animation', 'View', () => $('#cbFlow').click()], ['Toggle right-angle wires', 'Edit', () => $('#cbOrtho').click()], ['Undo', 'Edit', () => ed.undo()], ['Redo', 'Edit', () => ed.redo()], ['Keyboard shortcuts', 'Help', showKeys],
      ...root.Examples.LIST.map(([k, n]) => [`Open example: ${n}`, 'Example', () => app.cmd.loadExample(k)]),
      ...Object.entries(root.Parts.T).map(([k, d]) => [`Add part: ${d.label}`, 'Part', () => ed.addPartInView(k)]),
    ];
    const ck = $('#cmdk'), inp = $('#cmdkIn'), list = $('#cmdkList'); let items = [], sel = 0;
    const renderCk = () => {
      const q = inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      items = cmds().filter(([n, g]) => q.every((t) => (n + ' ' + g).toLowerCase().includes(t))).slice(0, 60); sel = Math.min(sel, Math.max(0, items.length - 1));
      list.innerHTML = items.map(([n, g], i) => `<div class="ck ${i === sel ? 'on' : ''}" data-i="${i}"><span>${n.replace(/[&<>]/g, '')}</span><span class="ck-g">${g}</span></div>`).join('') || '<div class="ck"><span class="muted">No matching commands</span></div>';
      const on = list.querySelector('.ck.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const openCk = () => { ck.hidden = false; inp.value = ''; sel = 0; renderCk(); setTimeout(() => inp.focus(), 0); };
    const runCk = (i) => { const it = items[i]; ck.hidden = true; if (it) it[2](); };
    app.openCommandPalette = openCk; $('#bCmdk').onclick = openCk;
    inp.addEventListener('input', () => { sel = 0; renderCk(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); renderCk(); e.preventDefault(); } else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderCk(); e.preventDefault(); } else if (e.key === 'Enter') { runCk(sel); e.preventDefault(); } else if (e.key === 'Escape') { ck.hidden = true; } e.stopPropagation(); });
    list.addEventListener('click', (e) => { const c = e.target.closest('[data-i]'); if (c) runCk(+c.dataset.i); });
    ck.addEventListener('click', (e) => { if (e.target === ck) ck.hidden = true; });
    window.addEventListener('keydown', (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); ck.hidden ? openCk() : (ck.hidden = true); return; }
      if ((e.ctrlKey || e.metaKey) && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); const k = { 1: 'palette', 2: 'side', 3: 'dock' }[e.key]; setC(k, !body.classList.contains('c-' + k)); return; }
      if (e.key === 'Escape') { if (!ck.hidden) ck.hidden = true; if (!keysDlg.hidden) keysDlg.hidden = true; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey || app.run) return;
      if (e.key === '?') { e.preventDefault(); keysDlg.hidden ? showKeys() : (keysDlg.hidden = true); }
      else if (e.key === '+' || e.key === '=') zoomBy(1.2); else if (e.key === '-') zoomBy(1 / 1.2);
    }, true);
    drawMap(true);
  }
  root.UI = { init, selectDockTab, dockTabClick, restoreDock };
})(window);
