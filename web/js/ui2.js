/* Workbench shell. Loaded only when data-ui="2" (UI2=1 or ?ui=2). */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const STARTER = ['esp32', 'breadboard', 'led', 'resistor', 'pushbutton', 'potentiometer', 'buzzer', 'ground', 'vcc33', 'vcc5', 'label'];
  const starterSet = new Set(STARTER);
  let setName = 'starter', chip = 'All', recent = [], coach = false;

  function on() { return document.documentElement.getAttribute('data-ui') === '2'; }
  function freshStart() { window.__ui2NeedStart = true; }
  window.UI2 = { on: on, freshStart: freshStart };

  function ic(id) { return `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`; }
  function app() { return window.app; }
  function ed() { return app() && app().editor; }

  function boot() {
    if (!on() || !ed() || document.body.dataset.ui2 === '1') return;
    document.body.dataset.ui2 = '1';
    document.body.classList.add('ui2-dock-min');
    const top = $('#top'); if (top) top.setAttribute('aria-hidden', 'true');
    injectSymbols();
    buildTop();
    buildSideTabs();
    buildDockBar();
    buildPalette();
    buildToolbar();
    buildPhone();
    buildAbout();
    hookEditor();
    hookKeys();
    watchViewport();
    buildPhoneDock();
    tameSymbols();
    const obs = new MutationObserver(syncChrome);
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.body.classList.remove('c-dock');
    if (app().proj) ed().fit();
    syncChrome();
    if (window.__ui2NeedStart && !app().proj) showStart();
    if (!document.body.classList.contains('m')) openDock('code');
  }

  function injectSymbols() {
    if ($('#i-flip')) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.innerHTML = '<symbol id="i-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10M7 7l3-3M7 7l3 3"/><path d="M17 17H7M17 17l-3 3M17 17l-3-3"/></symbol>';
    document.body.prepend(svg);
  }

  function buildTop() {
    const bar = document.createElement('header');
    bar.id = 'ui2top';
    bar.innerHTML = `<h1 class="sr-only">Circuit Lab</h1>
      <div class="ui2-id"><button type="button" id="ui2Menu" aria-label="Menu">${ic('i-more')}</button>
        <span class="ui2-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg></span>
        <button type="button" id="ui2Name" class="ui2-name">No project</button><span id="ui2Save" class="ui2-save"></span></div>
      <div class="ui2-views" role="radiogroup" aria-label="View">
        <button type="button" role="radio" data-view="2d" aria-checked="true">Breadboard</button>
        <button type="button" role="radio" data-view="schematic" aria-checked="false">Schematic</button>
        <button type="button" role="radio" data-view="3d" aria-checked="false">3D</button>
        <label id="ui2Sch" hidden>Arrangement <select id="ui2SchMode" aria-label="Schematic arrangement"><option value="tidy">Tidy</option><option value="board">Breadboard</option></select></label>
      </div>
      <div class="ui2-actions">
        <button type="button" id="ui2Run" class="primary">${ic('i-play')}<span>Run</span></button>
        <button type="button" id="ui2New">${ic('i-plus')} New</button>
        <button type="button" id="ui2Examples">Examples</button>
        <button type="button" id="ui2More" aria-haspopup="menu" aria-expanded="false" aria-label="More">${ic('i-more')}</button>
        <button type="button" id="ui2Sign" hidden>Sign in</button>
      </div>`;
    document.body.prepend(bar);
    $('#ui2Menu').onclick = () => openMenu($('#ui2Menu'));
    $('#ui2Name').onclick = rename;
    bar.querySelector('.ui2-views').onclick = (e) => {
      const b = e.target.closest('[data-view]'); if (!b) return; setView(b.dataset.view);
    };
    $('#ui2SchMode').onchange = (e) => {
      const id = e.target.value === 'board' ? 'schLayBoard' : 'schLayTidy';
      const b = document.getElementById(id); if (b) b.click();
    };
    $('#ui2Run').onclick = () => { const b = document.getElementById(document.body.classList.contains('running') ? 'bStop' : 'bRun'); if (b) b.click(); if (!document.body.classList.contains('m')) openDock('code'); };
    $('#ui2New').onclick = () => { if (window.__ui2NeedStart && !app().proj) { showStart(); return; } newChooser($('#ui2New')); };
    $('#ui2Examples').onclick = () => showExamples();
    $('#ui2More').onclick = () => openMenu($('#ui2More'));
    $('#ui2Sign').onclick = () => { const b = document.getElementById('bSignIn') || document.getElementById('mSignIn'); if (b) b.click(); };
    new MutationObserver(syncSign).observe(document.body, { childList: true, subtree: true });
    syncSign();
  }

  function syncSign() {
    const src = document.getElementById('bSignIn') || document.getElementById('mSignIn');
    const btn = $('#ui2Sign'); if (!btn) return;
    btn.hidden = !src;
  }
  function syncChrome() {
    const run = $('#ui2Run'), onRun = document.body.classList.contains('running');
    if (run) {
      run.innerHTML = onRun ? ic('i-stop') + '<span>Stop</span>' : ic('i-play') + '<span>Run</span>';
      run.setAttribute('aria-label', onRun ? 'Stop' : 'Run');
    }
    const phoneRun = $('#ui2Phone [data-a="run"]');
    if (phoneRun) {
      phoneRun.innerHTML = onRun ? ic('i-stop') + '<span>Stop</span>' : ic('i-play') + '<span>Run</span>';
      phoneRun.setAttribute('aria-label', onRun ? 'Stop' : 'Run');
    }
    const sch = document.body.classList.contains('viewsch');
    const mode = document.body.classList.contains('view3d') ? '3d' : sch ? 'schematic' : '2d';
    document.querySelectorAll('#ui2top [data-view]').forEach((b) => b.setAttribute('aria-checked', b.dataset.view === mode ? 'true' : 'false'));
    const lay = $('#ui2Sch'); if (lay) lay.hidden = !sch;
    const tidy = document.getElementById('schLayTidy'), board = document.getElementById('schLayBoard');
    const sel = $('#ui2SchMode');
    if (sel && tidy && board) sel.value = board.getAttribute('aria-pressed') === 'true' ? 'board' : 'tidy';
    syncId();
    if (coach) scoreCoach();
    ensurePhone();
  }
  function syncId() {
    const name = $('#ui2Name'), save = $('#ui2Save'), p = app() && app().proj;
    if (!name) return;
    if (!p) { paintName(name, 'No project'); if (save) save.textContent = ''; syncCopy(); return; }
    paintName(name, p.name || 'Untitled');
    if (save) save.textContent = app().readOnly ? 'Example' : (p.id ? 'Saved' : 'Not saved');
    syncCopy();
  }
  function paintName(el, full) {
    const text = String(full || 'Untitled');
    el.title = text;
    const phone = document.body.classList.contains('m');
    const short = phone ? (text.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim() || text) : text;
    el.textContent = short;
    if (!phone || el.scrollWidth <= el.clientWidth + 1) return;
    const words = short.split(' ');
    let n = words.length;
    while (n > 1) {
      n -= 1;
      el.textContent = words.slice(0, n).join(' ') + '…';
      if (el.scrollWidth <= el.clientWidth + 1) return;
    }
  }
  function syncCopy() {
    const phone = document.body.classList.contains('m');
    const show = phone && app() && app().readOnly && app().proj;
    let btn = $('#ui2Copy');
    if (!show) { if (btn) btn.hidden = true; return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ui2Copy';
      btn.textContent = 'Make a copy';
      const id = document.querySelector('#ui2top .ui2-id');
      if (id) id.appendChild(btn);
      btn.onclick = () => {
        const b = document.getElementById('bCopy');
        if (b) b.click();
        else if (app() && app().cmd && app().cmd.makeCopy) app().cmd.makeCopy();
      };
    }
    btn.hidden = false;
  }
  function rename() {
    const p = app() && app().proj; if (!p || app().readOnly) return;
    const n = prompt('Project name', p.name || '');
    if (!n || !String(n).trim()) return;
    p.name = String(n).trim();
    const t = document.getElementById('projTitle'); if (t) t.textContent = p.name;
    if (p.id && app().store) { try { app().store.save(p); } catch (e) { /* the name stays on the project */ } }
    syncId();
  }
  function setView(mode) {
    const cmd = app().cmd || {};
    if (mode === '3d' && cmd.view3d) cmd.view3d();
    else if (mode === 'schematic' && cmd.viewSch) cmd.viewSch();
    else if (cmd.view2d) cmd.view2d();
    syncChrome();
  }
  async function newChooser(opener) {
    if (!app().newBlankDialog) return;
    if (app().ensureExamples) { try { await app().ensureExamples(); } catch (e) { return; } }
    if (!window.Examples) return;
    app().newBlankDialog(opener, (kind) => {
      const raw = window.Examples.newBlank(kind);
      const p = app().store.importJson(raw);
      app().openProject(p.id);
      window.__ui2NeedStart = false;
      syncId();
    });
  }

  function buildSideTabs() {
    const tabs = document.createElement('div');
    tabs.id = 'ui2SideTabs';
    tabs.setAttribute('role', 'radiogroup');
    tabs.setAttribute('aria-label', 'Side panel');
    tabs.innerHTML = '<button type="button" role="radio" data-side="parts" aria-checked="true">Parts</button><button type="button" role="radio" data-side="props" aria-checked="false">Properties</button><button type="button" id="ui2SideClose" aria-label="Toggle side panel" title="Collapse panel"></button>';
    const host = document.getElementById('main') || document.body;
    host.appendChild(tabs);
    const live = document.createElement('div');
    live.id = 'ui2Live';
    live.setAttribute('aria-live', 'polite');
    host.appendChild(live);
    new MutationObserver(() => {
      document.querySelectorAll('body > .toast').forEach((t) => live.appendChild(t));
    }).observe(document.body, { childList: true });
    tabs.onclick = (e) => {
      if (e.target.closest('#ui2SideClose')) { document.body.classList.toggle('ui2-side-min'); return; }
      const b = e.target.closest('[data-side]'); if (!b) return;
      document.body.classList.remove('ui2-side-min');
      document.body.classList.toggle('ui2-props', b.dataset.side === 'props');
      paintSide();
    };
  }
  function paintSide() {
    const props = document.body.classList.contains('ui2-props');
    document.querySelectorAll('#ui2SideTabs [data-side]').forEach((b) => b.setAttribute('aria-checked', (b.dataset.side === 'props') === props ? 'true' : 'false'));
  }

  let dockTab = null;
  function buildDockBar() {
    const dock = $('#dock'); if (!dock) return;
    const bar = document.createElement('div');
    bar.id = 'ui2DockBar';
    bar.innerHTML = '<button type="button" data-tab="code">Code</button><button type="button" data-tab="serial">Serial</button><button type="button" data-tab="scope">Scope</button><button type="button" id="ui2DockGrip" aria-label="Resize code drawer"></button>';
    dock.prepend(bar);
    bar.onclick = (e) => {
      const b = e.target.closest('[data-tab]'); if (!b) return;
      if (b.dataset.tab === dockTab && !document.body.classList.contains('ui2-dock-min')) {
        document.body.classList.add('ui2-dock-min');
      } else {
        openDock(b.dataset.tab);
      }
    };
    const grip = $('#ui2DockGrip');
    let y0 = 0, h0 = 0;
    grip.addEventListener('pointerdown', (e) => {
      y0 = e.clientY; h0 = dock.getBoundingClientRect().height; grip.setPointerCapture(e.pointerId);
      document.body.classList.remove('ui2-dock-min');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!y0) return;
      const top = ($('#ui2top') && $('#ui2top').getBoundingClientRect().height) || 48;
      const max = Math.max(180, Math.round(window.innerHeight - top - 8));
      const next = Math.max(120, Math.min(max, h0 + (y0 - e.clientY)));
      document.documentElement.style.setProperty('--ui2dock', next + 'px');
    });
    grip.addEventListener('pointerup', () => { y0 = 0; });
  }
  function openDock(tab) {
    dockTab = tab;
    if (tab === 'scope' && app() && app().ensureScope) app().ensureScope();
    document.body.classList.remove('ui2-dock-min');
    document.body.classList.remove('c-dock');
    const topH = ($('#ui2top') && $('#ui2top').getBoundingClientRect().height) || 48;
    const avail = Math.max(200, window.innerHeight - topH - 8);
    const opened = tab === 'scope' ? Math.min(avail, Math.max(280, Math.round(window.innerHeight * 0.58))) : Math.min(avail, Math.round(window.innerHeight * 0.32));
    if (tab === 'scope' || !document.documentElement.style.getPropertyValue('--ui2dock')) document.documentElement.style.setProperty('--ui2dock', opened + 'px');
    const b = document.querySelector(`#tabs [data-tab="${tab}"]`); if (b) b.click();
    document.querySelectorAll('#ui2DockBar [data-tab], #ui2PhoneDock [data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    if (document.body.classList.contains('m') && window.Mobile && Mobile.setSheet) Mobile.setSheet('dock');
  }
  function buildPhoneDock() {
    const dock = $('#dock');
    if (!dock || $('#ui2PhoneDock')) return;
    const bar = document.createElement('div');
    bar.id = 'ui2PhoneDock';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Code panels');
    bar.innerHTML = '<button type="button" role="tab" data-tab="code">Code</button><button type="button" role="tab" data-tab="serial">Serial</button><button type="button" role="tab" data-tab="scope">Scope</button>';
    const head = dock.querySelector('.m-sh-h');
    if (head) head.after(bar); else dock.prepend(bar);
    bar.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) openDock(b.dataset.tab); };
  }
  function tameSymbols() {
    const bar = document.querySelector('.m-symbar');
    if (!bar || $('#ui2Sym')) return;
    bar.id = 'ui2SymBar';
    bar.hidden = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'ui2Sym';
    btn.textContent = 'Symbols';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-controls', 'ui2SymBar');
    bar.before(btn);
    btn.addEventListener('click', () => {
      bar.hidden = !bar.hidden;
      btn.setAttribute('aria-pressed', bar.hidden ? 'false' : 'true');
    });
  }

  function buildPalette() {
    const pal = $('#palette'); if (!pal || $('#ui2PalTools')) return;
    const tools = document.createElement('div');
    tools.id = 'ui2PalTools';
    tools.innerHTML = `<div class="ui2-sets" role="radiogroup" aria-label="Part set">
        <button type="button" role="radio" data-set="starter" aria-checked="true">Starter</button>
        <button type="button" role="radio" data-set="all" aria-checked="false">All parts</button></div>
      <div id="ui2Chips" role="toolbar" aria-label="Categories" tabindex="0"></div>
      <div id="ui2Recent" role="toolbar" aria-label="Recent parts"></div>`;
    const search = pal.querySelector('.pal-search');
    if (search) search.after(tools); else pal.prepend(tools);
    const lock = document.createElement('button');
    lock.type = 'button'; lock.id = 'ui2Lock'; lock.hidden = true; lock.textContent = 'Sign in to unlock all parts';
    tools.after(lock);
    lock.onclick = () => { if (window.GuestParts) GuestParts.prompt(''); };
    stampCats();
    refreshChips();
    tools.querySelector('.ui2-sets').onclick = async (e) => {
      const b = e.target.closest('[data-set]'); if (!b) return; setName = b.dataset.set;
      tools.querySelectorAll('[data-set]').forEach((x) => x.setAttribute('aria-checked', x === b ? 'true' : 'false'));
      if (setName === 'all' && app() && app().ensureParts) { try { await app().ensureParts(); } catch (err) { /* starter parts stay usable */ } }
      applyFilter();
    };
    hookSearch();
    if (window.GuestParts && GuestParts.syncPalette && !GuestParts._ui2) {
      const orig = GuestParts.syncPalette;
      GuestParts.syncPalette = function (scope) { orig(scope); badgeLocks(); applyFilter(); };
      GuestParts._ui2 = true;
    }
    document.addEventListener('click', (e) => {
      const it = e.target.closest && e.target.closest('.pitem');
      if (!it || it.getAttribute('data-guest-locked') === '1') return;
      noteRecent(it.dataset.type);
    }, true);
    document.addEventListener('dragstart', (e) => {
      const it = e.target.closest && e.target.closest('.pitem');
      if (it) document.documentElement.dataset.dragPart = it.dataset.type || '';
    }, true);
    document.addEventListener('dragend', () => { delete document.documentElement.dataset.dragPart; if (ed()) ed()._clearGhost(); }, true);
    badgeLocks();
    applyFilter();
  }
  function badgeLocks() {
    document.querySelectorAll('.pitem-lock span').forEach((el) => el.remove());
  }
  function noteRecent(type) {
    if (!type) return;
    recent = recent.filter((t) => t !== type);
    recent.unshift(type);
    recent = recent.slice(0, 4);
    const row = $('#ui2Recent'); if (!row) return;
    row.innerHTML = recent.map((t) => {
      const d = window.Parts && Parts.T[t];
      return `<button type="button" data-recent="${t}">${d ? d.label : t}</button>`;
    }).join('');
    row.onclick = (e) => {
      const b = e.target.closest('[data-recent]'); if (!b) return;
      const tile = document.querySelector(`.pitem[data-type="${CSS.escape(b.dataset.recent)}"]`);
      if (tile) tile.click();
    };
  }
  function applyFilter() {
    const q = (($('#palSearch') && $('#palSearch').value) || '').trim().toLowerCase();
    document.querySelectorAll('.pitem').forEach((it) => {
      let show = true;
      if (setName === 'starter' && !starterSet.has(it.dataset.type)) show = false;
      if (chip !== 'All' && it.dataset.cat !== chip) show = false;
      if (q && !(it.dataset.q || '').includes(q)) show = false;
      it.hidden = !show;
    });
    document.querySelectorAll('.pgrid').forEach((g) => {
      const any = [...g.children].some((c) => !c.hidden);
      g.hidden = !any;
      if (g.previousElementSibling && g.previousElementSibling.classList.contains('pcat')) g.previousElementSibling.hidden = !any;
    });
    const guest = window.GuestParts && GuestParts.guest && GuestParts.guest();
    const locked = guest && [...document.querySelectorAll('.pitem')].some((it) => !it.hidden && it.classList.contains('pitem-locked'));
    const bar = $('#ui2Lock'); if (bar) bar.hidden = !locked;
    badgeLocks();
  }
  function stampCats() {
    document.querySelectorAll('.pgrid').forEach((g) => { [...g.children].forEach((it) => { if (!it.dataset.cat) it.dataset.cat = g.dataset.cat || ''; }); });
  }
  function refreshChips() {
    const chips = $('#ui2Chips'); if (!chips) return;
    const cats = [...document.querySelectorAll('.pcat')].map((c) => c.dataset.cat).filter(Boolean);
    if (chip !== 'All' && cats.indexOf(chip) < 0) chip = 'All';
    chips.innerHTML = ['All', ...cats].map((c) => `<button type="button" data-chip="${esc(c)}" aria-pressed="${c === chip ? 'true' : 'false'}">${esc(c)}</button>`).join('');
    chips.onclick = (e) => { const b = e.target.closest('[data-chip]'); if (!b) return; chip = b.dataset.chip; chips.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); const sel = $('#ui2Cat'); if (sel) sel.value = chip; applyFilter(); };
    let sel = $('#ui2Cat');
    if (!sel) {
      sel = document.createElement('select');
      sel.id = 'ui2Cat';
      sel.setAttribute('aria-label', 'Category');
      chips.after(sel);
      sel.onchange = () => {
        chip = sel.value;
        chips.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x.dataset.chip === chip ? 'true' : 'false'));
        applyFilter();
      };
    }
    sel.innerHTML = ['All', ...cats].map((c) => `<option value="${esc(c)}"${c === chip ? ' selected' : ''}>${esc(c)}</option>`).join('');
  }
  function hookSearch() {
    const input = $('#palSearch'); if (!input || input.dataset.ui2hook === '1') return;
    input.dataset.ui2hook = '1';
    const prev = input.oninput;
    input.oninput = async (e) => {
      if (typeof prev === 'function') prev.call(input, e);
      if ((input.value || '').trim() && app() && app().ensureParts) { try { await app().ensureParts(); } catch (err) { /* keep the starter filter */ } }
      applyFilter();
    };
  }
  function afterPalette() {
    const input = $('#palSearch'); if (input) delete input.dataset.ui2hook;
    stampCats();
    refreshChips();
    hookSearch();
    badgeLocks();
    applyFilter();
    if (document.body.classList.contains('m') && window.Mobile_track) window.Mobile_track(true);
  }
  window.UI2.afterPalette = afterPalette;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function buildToolbar() {
    const tools = $('.canvas-tools'), zoom = $('.zoom-tools');
    if (!tools || tools.dataset.ui2) return;
    tools.dataset.ui2 = '1';
    const flip = document.createElement('button');
    flip.type = 'button'; flip.id = 'bFlip'; flip.className = 'iconbtn';
    flip.setAttribute('aria-label', 'Flip'); flip.dataset.tip = 'Flip (F)';
    flip.innerHTML = ic('i-flip');
    const del = $('#bDel'); if (del) del.after(flip); else tools.appendChild(flip);
    flip.onclick = () => ed() && ed().flipSel('x');
    if (zoom) while (zoom.firstChild) tools.appendChild(zoom.firstChild);
    tools.querySelectorAll('button').forEach((b) => {
      if (!b.dataset.tip && b.title) b.dataset.tip = b.title;
      if (!b.getAttribute('aria-label') && b.title) b.setAttribute('aria-label', b.title.replace(/\s*\([^)]*\)\s*$/, ''));
    });
  }

  function buildPhone() {
    if ($('#ui2Phone')) return;
    const nav = document.createElement('nav');
    nav.id = 'ui2Phone';
    nav.setAttribute('aria-label', 'Workbench');
    nav.innerHTML = `<button type="button" data-a="parts">${ic('i-chip')}<span>Parts</span></button>
      <button type="button" data-a="wire">${ic('i-wire')}<span>Wire</span></button>
      <button type="button" data-a="code">${ic('i-cmd')}<span>Code</span></button>
      <button type="button" data-a="run" class="primary" aria-label="Run">${ic('i-play')}<span>Run</span></button>
      <button type="button" data-a="more" aria-label="More" aria-haspopup="menu" aria-expanded="false" aria-controls="ui2Pop">${ic('i-more')}<span>More</span></button>`;
    document.body.appendChild(nav);
    nav.onclick = (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'parts') { if (app() && app().ensureArt) app().ensureArt(); if (window.Mobile) Mobile.setSheet('parts'); }
      else if (a === 'code') openDock('code');
      else if (a === 'wire') { if (window.Mobile) Mobile.setSheet(null); toggleWireArm(); }
      else if (a === 'run') $('#ui2Run').click();
      else openMenu(b);
    };
    ensurePhone();
  }
  function ensurePhone() {
    const track = document.getElementById('mTrack');
    if (track && track.tabIndex < 0) { track.tabIndex = 0; track.setAttribute('aria-label', 'Parts'); }
    const sel = $('#mSel');
    if (sel && !sel.querySelector('[data-a="connect"]')) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.a = 'connect'; b.setAttribute('aria-label', 'Connect'); b.textContent = 'Connect…';
      sel.appendChild(b);
      b.onclick = (e) => { e.stopPropagation(); openConnect(ed() && ed().mode && ed().mode.k === 'wire' ? ed().mode.start : null); };
    }
  }

  function buildAbout() {
    const box = $('#aboutBox'); if (!box || $('#ui2Legal')) return;
    const sec = document.createElement('section');
    sec.id = 'ui2Legal';
    sec.innerHTML = '<h3>Real firmware</h3><div id="ui2Firm"></div><h3>Notices</h3><p>Simulator for ESP32. © 2026 Hari Kishore Chada. Not affiliated with or endorsed by Espressif Systems, Arduino SA, or Wokwi. ESP32, Arduino and Wokwi are trademarks of their respective owners.</p><p><a href="notices.html" target="_blank" rel="noopener">Open-source notices</a></p>';
    box.appendChild(sec);
  }
  function syncFirm() {
    const n = $('#modeNote'), d = $('#ui2Firm'); if (n && d) d.innerHTML = n.innerHTML;
  }

  let wireArm = false;
  function syncWireUi() {
    const editor = ed();
    const wiring = !!(editor && editor.mode && editor.mode.k === 'wire');
    const show = document.body.classList.contains('m') && (wireArm || wiring);
    const btn = document.querySelector('#ui2Phone [data-a="wire"]');
    if (btn) btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    let bar = document.getElementById('ui2WireBanner');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ui2WireBanner';
      bar.setAttribute('role', 'status');
      bar.hidden = true;
      bar.innerHTML = '<span>Wiring — tap a pin</span><button type="button" id="ui2WireX">Cancel</button>';
      (document.getElementById('stageWrap') || document.body).appendChild(bar);
      const x = bar.querySelector('#ui2WireX');
      if (x) x.onclick = (e) => { e.stopPropagation(); wireArm = false; const live = ed(); if (live) live.cancelWire(); syncWireUi(); };
    }
    bar.hidden = !show;
  }
  function toggleWireArm() {
    const editor = ed();
    const on = wireArm || !!(editor && editor.mode && editor.mode.k === 'wire');
    wireArm = !on;
    if (on && editor) editor.cancelWire();
    syncWireUi();
  }
  function hookEditor() {
    const editor = ed();
    if (window.Editor && !Editor.prototype._ui2Fit) {
      const prev = Editor.prototype.fit;
      Editor.prototype.fit = function () {
        if (!on() || !this.proj) return prev.call(this);
        try { if (fitParts(this)) return; } catch (e) { /* fall through */ }
        return prev.call(this);
      };
      Editor.prototype._ui2Fit = true;
    }
    const prevSel = editor.hooks.selected;
    let fromPalette = false;
    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.pitem')) fromPalette = true;
    }, true);
    editor.hooks.selected = (s) => {
      if (typeof prevSel === 'function') prevSel(s);
      // Adding from the drawer keeps Parts open. A click on the canvas opens Properties.
      if (fromPalette) { fromPalette = false; }
      else if (!document.body.classList.contains('m') && s && (s.part || s.wire)) document.body.classList.add('ui2-props');
      paintSide();
      ensurePhone();
    };
    const prevCh = editor.hooks.changed;
    editor.hooks.changed = (topo) => { if (typeof prevCh === 'function') prevCh(topo); syncId(); if (coach) scoreCoach(); };
    const prevCancel = editor.cancelWire.bind(editor);
    editor.cancelWire = function () { wireArm = false; prevCancel(); syncWireUi(); };
    const prevDown = editor._down.bind(editor);
    editor._down = function (ev) {
      prevDown(ev);
      if (!(editor.mode && editor.mode.k === 'wire')) wireArm = false;
      syncWireUi();
    };
    syncWireUi();
  }
  function partBounds(editor) {
    const P = window.Parts; if (!P || !editor.proj) return null;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
    for (const p of editor.proj.parts) {
      if (!p || p.type === 'breadboard') continue;
      n++;
      let box = null;
      try { box = P.gfxBox ? P.gfxBox(p) : null; } catch (e) { box = null; }
      if (box) { x0 = Math.min(x0, box.x); y0 = Math.min(y0, box.y); x1 = Math.max(x1, box.x + box.w); y1 = Math.max(y1, box.y + box.h); }
      else { x0 = Math.min(x0, p.x - 12); y0 = Math.min(y0, p.y - 12); x1 = Math.max(x1, p.x + 40); y1 = Math.max(y1, p.y + 40); }
    }
    if (!n) return null;
    const m = 28;
    return { x: x0 - m, y: y0 - m, w: (x1 - x0) + m * 2, h: (y1 - y0) + m * 2 };
  }
  function fitParts(editor) {
    const bb = partBounds(editor); if (!bb || !window.Pinch) return false;
    const r = editor.svg.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const frame = Pinch.frameOf(editor.svg);
    const limits = { min: 0.15, max: 3 };
    const clear = Pinch.resolveClear(frame, bb, 28, limits);
    const fit = Pinch.fitView(bb, frame.stage, clear, 28, limits);
    if (!fit || !isFinite(fit.s)) return false;
    let s = fit.s;
    const phone = document.body.classList.contains('m');
    const minS = phone ? 1.6 : 1.4;
    if (bb.w * minS <= r.width - 32 && bb.h * minS <= r.height - 32) s = Math.max(s, minS);
    s = Math.min(limits.max, Math.max(limits.min, s));
    const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
    editor.view = { s: s, x: cx - (r.width / s) / 2, y: cy - (r.height / s) / 2 };
    editor._autoFit = true;
    editor._fitSize = Math.round(r.width) + 'x' + Math.round(r.height);
    editor.applyView();
    const z = document.getElementById('zoomPct');
    if (z && !document.body.classList.contains('viewsch') && !document.body.classList.contains('view3d')) z.textContent = Math.round(s * 100) + '%';
    return true;
  }

  function hookKeys() {
    window.addEventListener('keydown', (e) => {
      const k = String(e.key || '').toLowerCase();
      if (k === 'escape') {
        const start = $('#ui2Start');
        if (start && !start.hidden) { start.hidden = true; e.preventDefault(); return; }
        const ex = $('#ui2Ex');
        if (ex && !ex.hidden) { ex.hidden = true; e.preventDefault(); return; }
        closePop();
        const c = $('#ui2Connect'); if (c && !c.hidden) { c.hidden = true; return; }
      }
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const editor = ed(); if (!editor) return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && k === 'c') { if (editor.copySel()) e.preventDefault(); return; }
      if (meta && k === 'v') { if (editor.pasteSel()) e.preventDefault(); return; }
      if (meta && (k === 'd')) { e.preventDefault(); editor.duplicateSel(); return; }
      if (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown') {
        if (meta || e.altKey) return;
        const step = e.shiftKey ? 40 : 10;
        const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
        const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
        if ((editor.multi && editor.multi.size) || (editor.sel && editor.sel.part)) { e.preventDefault(); editor.nudge(dx, dy); }
        return;
      }
      if (e.key === ' ' && !e.repeat) editor._spacePan = true;
    }, true);
    window.addEventListener('keyup', (e) => { if (e.key === ' ' && ed()) ed()._spacePan = false; }, true);
  }

  function visualFrame() {
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const left = vv ? vv.offsetLeft : 0;
    const height = vv ? vv.height : window.innerHeight;
    const width = vv ? vv.width : window.innerWidth;
    return { top: top, left: left, width: width, height: height, bottom: top + height, right: left + width };
  }
  function watchViewport() {
    const apply = () => {
      const frame = visualFrame();
      const root = document.documentElement;
      root.style.setProperty('--ui2-vv-top', Math.max(0, frame.top) + 'px');
      root.style.setProperty('--ui2-vv-bottom', Math.max(0, window.innerHeight - frame.bottom) + 'px');
      root.style.setProperty('--ui2-vv-height', frame.height + 'px');
      const name = $('#ui2Name');
      if (name && name.title) paintName(name, name.title);
      const pop = $('#ui2Pop');
      if (pop) fitPop(pop);
    };
    apply();
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
    }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', () => setTimeout(apply, 60));
  }
  function fitPop(pop) {
    const frame = visualFrame();
    const phone = document.body.classList.contains('m');
    const margin = 8;
    if (phone) {
      const bar = $('#ui2Phone');
      const puck = bar && bar.querySelector('[data-a="run"]');
      const topBar = $('#ui2top');
      const anchorTop = (puck || bar) ? (puck || bar).getBoundingClientRect().top - frame.top : frame.height - 84;
      const topLimit = (topBar ? topBar.getBoundingClientRect().bottom - frame.top : 52) + margin;
      const gap = 16;
      const maxBottom = Math.min(frame.height - gap, anchorTop - gap);
      const maxH = Math.max(96, maxBottom - topLimit);
      const maxW = Math.min(420, Math.max(160, frame.width - margin * 2));
      pop.style.maxHeight = maxH + 'px';
      pop.style.bottom = (window.innerHeight - (frame.top + maxBottom)) + 'px';
      pop.style.top = 'auto';
      pop.style.width = maxW + 'px';
      pop.style.right = 'auto';
      pop.style.left = (frame.left + Math.max(margin, frame.width - margin - maxW)) + 'px';
      if (frame.height <= 520) pop.classList.add('ui2-pop-cols');
      return;
    }
    const r = pop.getBoundingClientRect();
    const top = r.top - frame.top;
    const bottom = r.bottom - frame.top;
    const maxH = Math.max(120, frame.height - margin * 2);
    pop.style.maxHeight = maxH + 'px';
    if (bottom > frame.height - margin) {
      const shift = bottom - (frame.height - margin);
      const next = Math.max(frame.top + margin, (parseFloat(pop.style.top) || r.top) - shift);
      pop.style.top = next + 'px';
    } else if (top < margin) pop.style.top = (frame.top + margin) + 'px';
  }
  function closePop() { const p = $('#ui2Pop'); if (p) p.remove(); const m = $('#ui2More'); if (m) m.setAttribute('aria-expanded', 'false'); const phone = document.querySelector('#ui2Phone [data-a="more"]'); if (phone) phone.setAttribute('aria-expanded', 'false'); }
  function openMenu(anchor) {
    closePop();
    const pop = document.createElement('div');
    pop.id = 'ui2Pop'; pop.className = 'ui2-pop'; pop.setAttribute('role', 'menu'); pop.tabIndex = 0;
    const phone = document.body.classList.contains('m');
    if (phone) pop.classList.add('ui2-pop-sheet');
    const items = [
      ['Projects', 'bProjects'], ['Examples', 'ui2Examples'], ['Save', 'bSave'], ['Download', 'bDownload'], ['Import', 'fileIn'],
      ['Breadboard view', 'view:2d'], ['Schematic view', 'view:schematic'], ['3D view', 'view:3d'],
      ['Command palette', 'bCmdk'], ['Keyboard shortcuts', 'bKeys'], ['Theme', 'bTheme'],
      ['Restart', 'bRestart'], ['Reset', 'bReset'], ['About', 'about'],
    ];
    pop.innerHTML = items.map(([label, id]) => `<button type="button" role="menuitem" data-go="${id}">${label}</button>`).join('');
    document.body.appendChild(pop);
    if (!phone) {
      const frame = visualFrame();
      const r = anchor.getBoundingClientRect();
      const wide = Math.min(320, frame.width - 16);
      let left = r.right + frame.left - wide;
      left = Math.max(frame.left + 8, Math.min(left, frame.right - wide - 8));
      let top = r.bottom + frame.top + 6;
      pop.style.width = wide + 'px';
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }
    fitPop(pop);
    anchor.setAttribute('aria-expanded', 'true');
    pop.onclick = (e) => {
      const b = e.target.closest('[data-go]'); if (!b) return;
      const go = b.dataset.go;
      closePop();
      if (go.indexOf('view:') === 0) setView(go.slice(5));
      else if (go === 'about') { syncFirm(); openDock('about'); if (document.body.classList.contains('m') && window.Mobile) Mobile.openDock('about'); }
      else { const el = document.getElementById(go); if (el) el.click(); }
    };
    const first = pop.querySelector('button'); if (first) first.focus();
    setTimeout(() => {
      const closer = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchor) { closePop(); document.removeEventListener('pointerdown', closer, true); } };
      document.addEventListener('pointerdown', closer, true);
    }, 0);
  }

  function showStart() {
    if ($('#ui2Start')) { $('#ui2Start').hidden = false; return; }
    const d = document.createElement('div');
    d.id = 'ui2Start'; d.className = 'modal';
    d.innerHTML = `<div class="ui2-card" role="dialog" aria-modal="true" aria-labelledby="ui2StartTitle" tabindex="0">
      <h2 id="ui2StartTitle">Start a circuit</h2>
      <p>A blank board, the Blink example, or a four-step build. Nothing is read-only until you open an example.</p>
      <button type="button" class="ui2-choice primary" data-go="new">New blank ESP32</button>
      <button type="button" class="ui2-choice" data-go="blink">Open Blink example</button>
      <h3 style="margin:12px 0 4px;font-size:14px">Guided Blink</h3>
      <ol class="ui2-steps"><li>Add an LED</li><li>Add a resistor</li><li>Wire D2 to the resistor, the resistor to the LED, and the LED to GND</li><li>Run</li></ol>
      <button type="button" class="ui2-choice" data-go="guide">Start guided Blink</button>
      <button type="button" data-go="close">Close</button>
    </div>`;
    document.body.appendChild(d);
    d.onclick = async (e) => {
      const b = e.target.closest('[data-go]'); if (!b && e.target === d) { d.hidden = true; return; }
      if (!b) return;
      const go = b.dataset.go;
      if (go === 'close') { d.hidden = true; return; }
      d.hidden = true;
      window.__ui2NeedStart = false;
      if (app().ensureExamples) { try { await app().ensureExamples(); } catch (err) { return; } }
      if (!window.Examples) return;
      if (go === 'blink') { app().cmd.loadExample('blink'); syncId(); return; }
      const raw = window.Examples.newBlank('esp32');
      if (go === 'guide') { raw.code = window.Examples.BLINK; raw.name = 'Blink'; }
      const p = app().store.importJson(raw);
      app().openProject(p.id);
      syncId();
      if (go === 'guide') { coach = true; showCoach(); scoreCoach(); }
    };
    const first = d.querySelector('[data-go="new"]'); if (first) first.focus();
  }
  function showCoach() {
    let c = $('#ui2Coach');
    if (!c) {
      c = document.createElement('div');
      c.id = 'ui2Coach'; c.className = 'ui2-coach'; c.setAttribute('role', 'status');
      c.innerHTML = '<p id="ui2CoachNow">Step 1 of 4. Add an LED.</p><button type="button" id="ui2CoachHide">Dismiss</button>';
      $('#stageWrap').appendChild(c);
      $('#ui2CoachHide').onclick = () => { coach = false; c.hidden = true; };
    }
    c.hidden = false;
  }
  function scoreCoach() {
    const proj = app() && app().proj; if (!proj) return;
    const led = proj.parts.find((p) => p.type === 'led');
    const res = proj.parts.find((p) => p.type === 'resistor');
    const esp = proj.parts.find((p) => p.type === 'esp32');
    let wired = false;
    if (led && res && esp && app().sim && app().sim.netAt) {
      try {
        if (app().sim.settle) app().sim.settle();
        const net = (part, name) => {
          const pin = window.Parts.T[part.type].pins(part).find((q) => q.name === name);
          if (!pin) return -1;
          const w = window.Parts.pinWorld(part, pin);
          return app().sim.netAt(w.x, w.y);
        };
        const d2 = net(esp, 'D2'), r1 = net(res, '1'), r2 = net(res, '2'), a = net(led, 'A'), cth = net(led, 'C');
        const g1 = net(esp, 'GND.1'), g2 = net(esp, 'GND.2');
        const join = (x, y) => x != null && x >= 0 && x === y;
        const gnd = (n) => n === 0 || n === g1 || n === g2;
        wired = (join(d2, r1) || join(d2, r2)) && (join(a, r1) || join(a, r2)) && (gnd(cth));
      } catch (e) { wired = false; }
    }
    const running = document.body.classList.contains('running') || app().compilePhase === 'running';
    const steps = [!!led, !!res, wired, running];
    const labels = ['Add an LED.', 'Add a resistor.', 'Wire D2 to the resistor, the resistor to the LED, and the LED to GND.', 'Run.'];
    const i = steps.findIndex((ok) => !ok);
    const el = $('#ui2CoachNow'); if (!el) return;
    el.textContent = i < 0 ? 'Blink is ready.' : `Step ${i + 1} of 4. ${labels[i]}`;
  }

  function partThumb(part) {
    if (!part || !window.Parts || !Parts.T[part.type] || typeof Parts.T[part.type].svg !== 'function') return '';
    try {
      const d = Parts.T[part.type];
      const p = { id: 'T', type: part.type, x: 0, y: 0, rot: 0, props: JSON.parse(JSON.stringify(d.props || {})) };
      const sz = d.size(p);
      const pins = d.pins(p) || [];
      let x0 = 0, y0 = 0, x1 = sz.w, y1 = sz.h;
      for (const q of pins) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      const pad = 8;
      return `<svg viewBox="${x0 - pad} ${y0 - pad} ${Math.max(1, x1 - x0 + 2 * pad)} ${Math.max(1, y1 - y0 + 2 * pad)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${d.svg(p, null)}</svg>`;
    } catch (e) { return ''; }
  }
  function exampleDifficulty(parts) {
    const types = (parts || []).map((p) => p && p.type).filter((t) => t && t !== 'breadboard' && t !== 'label' && t !== 'ground' && t !== 'vcc33' && t !== 'vcc5');
    const extra = types.filter((t) => !starterSet.has(t));
    if (extra.length >= 3 || types.length >= 8) return 'Advanced';
    if (extra.length || types.length >= 5) return 'Intermediate';
    return 'Beginner';
  }
  async function showExamples() {
    if (app() && app().ensureExamples) { try { await app().ensureExamples(); } catch (e) { /* the grid shows what is already registered */ } }
    let d = $('#ui2Ex');
    if (!d) {
      d = document.createElement('div');
      d.id = 'ui2Ex'; d.className = 'modal';
      d.innerHTML = `<div class="ui2-card" role="dialog" aria-modal="true" aria-labelledby="ui2ExTitle" tabindex="0">
        <div class="row"><h2 id="ui2ExTitle" style="flex:1;margin:0">Examples</h2><button type="button" data-x="1" aria-label="Close">${ic('i-x')}</button></div>
        <p>Open a circuit to read it. Editing makes a copy in My Projects.</p>
        <div class="ui2-ex" id="ui2ExGrid"></div></div>`;
      document.body.appendChild(d);
      d.onclick = (e) => { if (e.target === d || e.target.closest('[data-x]')) { d.hidden = true; return; } };
    }
    const grid = $('#ui2ExGrid');
    const list = (window.Examples && Examples.LIST) || [];
    grid.innerHTML = list.map(([key, name]) => {
      let notes = '', chips = '', thumb = '', level = 'Beginner';
      try {
        const ex = Examples.EX[key]();
        notes = String(ex.notes || '').replace(/\s+/g, ' ').slice(0, 120);
        const labels = [];
        const parts = ex.parts || [];
        level = exampleDifficulty(parts);
        parts.forEach((p) => {
          if (!p || p.type === 'breadboard' || p.type === 'label') return;
          const lab = (Parts.T[p.type] && Parts.T[p.type].label) || p.type;
          if (labels.indexOf(lab) < 0 && labels.length < 4) labels.push(lab);
        });
        chips = labels.map((lab) => `<span>${esc(lab)}</span>`).join('');
        const hero = parts.find((p) => p && p.type && p.type !== 'breadboard' && p.type !== 'label' && p.type !== 'esp32') || parts.find((p) => p && p.type === 'esp32');
        thumb = partThumb(hero);
      } catch (err) { notes = ''; }
      const locked = window.GuestParts && GuestParts.exampleLocked && GuestParts.exampleLocked(key);
      return `<button type="button" data-ex="${esc(key)}"><span class="ui2-ex-top">${thumb ? `<span class="ui2-ex-thumb">${thumb}</span>` : ''}<span class="ui2-ex-copy"><span class="ui2-ex-title">${esc(name)}</span><span class="ui2-ex-meta"><span class="ui2-diff">${level}</span>${locked ? '<span class="ui2-badge">Locked</span>' : ''}</span></span></span>${notes ? `<span class="ui2-ex-notes">${esc(notes)}</span>` : ''}${chips ? `<span class="ui2-ex-chips">${chips}</span>` : ''}</button>`;
    }).join('');
    grid.onclick = (e) => {
      const b = e.target.closest('[data-ex]'); if (!b) return;
      const key = b.dataset.ex;
      if (window.GuestParts && GuestParts.exampleLocked(key)) { GuestParts.promptExample(key); return; }
      d.hidden = true;
      window.__ui2NeedStart = false;
      app().cmd.loadExample(key);
      syncId();
    };
    d.hidden = false;
    const close = d.querySelector('[data-x]'); if (close) close.focus();
  }

  function openConnect(start) {
    let sheet = $('#ui2Connect');
    if (!sheet) {
      sheet = document.createElement('section');
      sheet.id = 'ui2Connect';
      sheet.innerHTML = `<header><h2 id="ui2ConnectTitle">Connect to…</h2><button type="button" id="ui2ConnectX" aria-label="Close">${ic('i-x')}</button></header>
        <label class="sr-only" for="ui2PinQ">Filter pins</label><input id="ui2PinQ" placeholder="Filter pins, such as D2 or GND" autocomplete="off" style="margin:0 12px 8px">
        <div id="ui2PinList" tabindex="0"></div>`;
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'false');
      sheet.setAttribute('aria-labelledby', 'ui2ConnectTitle');
      document.body.appendChild(sheet);
      $('#ui2ConnectX').onclick = () => { sheet.hidden = true; };
      $('#ui2PinQ').oninput = () => paintPins(sheet._start);
    }
    sheet.hidden = false;
    sheet._start = start || null;
    $('#ui2ConnectTitle').textContent = start ? 'Connect to…' : 'Choose a pin';
    paintPins(start);
    const q = $('#ui2PinQ'); if (q) { q.value = ''; q.focus(); }
  }
  function paintPins(start) {
    const list = $('#ui2PinList'); if (!list || !app().proj) return;
    const q = (($('#ui2PinQ') && $('#ui2PinQ').value) || '').trim().toLowerCase();
    const rows = [];
    for (const p of app().proj.parts) {
      if (!p || !window.Parts.T[p.type] || p.type === 'breadboard') continue;
      let pins = [];
      try { pins = Parts.T[p.type].pins(p) || []; } catch (e) { pins = []; }
      for (const pin of pins) {
        if (start && start.part && start.part.id === p.id && start.pin && start.pin.name === pin.name) continue;
        const label = p.id + ' · ' + pin.name;
        if (q && label.toLowerCase().indexOf(q) < 0 && String(pin.name).toLowerCase().indexOf(q) < 0) continue;
        rows.push({ id: p.id, name: pin.name, label: label });
      }
    }
    list.innerHTML = rows.map((r) => `<button type="button" data-id="${r.id}" data-pin="${r.name}">${r.label}</button>`).join('') || '<p class="muted" style="padding:8px">No pins match.</p>';
    list.onclick = (e) => {
      const b = e.target.closest('[data-id]'); if (!b) return;
      const part = ed().part(b.dataset.id); if (!part) return;
      const pin = window.Parts.T[part.type].pins(part).find((q) => q.name === b.dataset.pin);
      if (!pin) return;
      const pos = window.Parts.pinWorld(part, pin);
      const hit = { part: part, pin: pin, pos: pos, bb: false };
      const editor = ed();
      if (!editor.mode || editor.mode.k !== 'wire') {
        editor.mode = { k: 'wire', a: pos, pts: [], start: hit, t0: Date.now(), _sheet: true };
        editor.highlight(hit);
        openConnect(hit);
        return;
      }
      editor._finishWire(pos, hit);
      $('#ui2Connect').hidden = true;
    };
  }

  function arm() {
    const start = () => { if (!(window.app && window.app.editor)) { setTimeout(start, 16); return; } boot(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
  arm();
})();
