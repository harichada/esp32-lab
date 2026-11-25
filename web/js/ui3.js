/* Studio Dark shell. Loaded only when data-ui="3". Keeps the existing control ids. */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const FEATURED = [
    ['blank', 'Blank', 'Start'],
    ['blink', 'Blink', 'Beginner'],
    ['button', 'Button + LED', 'Beginner'],
    ['pot', 'Pot dimmer', 'Beginner'],
    ['fade', 'LED fade', 'Intermediate'],
    ['transistor', 'Transistor', 'Intermediate'],
    ['i2c', 'I²C sensors + OLED', 'Intermediate'],
    ['remote', 'Wi-Fi/IR remote', 'Advanced'],
  ];
  const STARTER = ['esp32', 'breadboard', 'led', 'resistor', 'pushbutton', 'potentiometer', 'buzzer'];
  const requestedView = new URLSearchParams(location.search).get('view');
  let chip = 'All', prefer2d = false, forceSch = false, sawProject = false, tourOn = false, tourCode = false, tourOnSeen = false, tourOffSeen = false;
  let menu = null, spark = [];

  function on() { return document.documentElement.getAttribute('data-ui') === '3'; }
  function app() { return window.app; }
  function phone() { return window.matchMedia('(max-width: 1080px)').matches; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ic(id) { return `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`; }
  function click(id) { const n = document.getElementById(id); if (n) n.click(); }
  function reduced() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  function boot() {
    if (!on() || document.body.dataset.ui3 === '1') return;
    if (!app() || !app().editor) return;
    document.body.dataset.ui3 = '1';
    window.UI3 = { on: on };
    retireClassic();
    buildTop();
    buildRail();
    buildCanvas();
    buildDrawer();
    buildContext();
    buildStatus();
    buildWelcome();
    buildPhone();
    buildPaletteExtras();
    watch();
    const hasProject = !!(app().proj);
    sawProject = hasProject;
    setHome(!hasProject || !!window.__ui3NeedWelcome && !hasProject);
    if (hasProject && !requestedView) app().cmd.viewSch();
    minimapOff();
    syncAll();
  }

  function retireClassic() {
    const top = document.getElementById('top');
    const live = document.getElementById('stLive');
    if (live) document.body.appendChild(live);
    if (top) { top.setAttribute('aria-hidden', 'true'); try { top.inert = true; } catch (e) { /* older engines */ } }
  }

  function buildTop() {
    const bar = document.createElement('header');
    bar.id = 'ui3top';
    bar.innerHTML = `<div class="ui3-brand"><span class="ui3-logo" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg></span><h1>Circuit Lab</h1></div>
      <div class="ui3-crumb"><button type="button" id="ui3Name" aria-haspopup="menu" aria-expanded="false">No project</button><span id="ui3Save"></span></div>
      <button type="button" id="ui3Search" aria-keyshortcuts="Control+K">${ic('i-search')}<span>Search</span><kbd aria-hidden="true">Ctrl K</kbd></button>
      <div class="ui3-chip" id="ui3ModeDesk"><span>ESP32 DevKit V1</span> <select id="ui3Mode" aria-label="Run as"></select></div>
      <div class="ui3-run"><button type="button" id="ui3Run">Run</button><button type="button" id="ui3RunMore" aria-haspopup="menu" aria-expanded="false"><span aria-hidden="true">▾</span><span class="sr-only">Run options</span></button></div>
      <span id="ui3SwitchSlot"></span>
      <button type="button" id="ui3Help" aria-haspopup="menu" aria-expanded="false"><span aria-hidden="true">?</span><span class="sr-only">Help</span></button>
      <button type="button" id="ui3Account">Sign in</button>`;
    document.body.prepend(bar);
    const mode = document.getElementById('selMode');
    const copy = $('#ui3Mode');
    if (mode && copy) {
      copy.innerHTML = mode.innerHTML;
      copy.value = mode.value;
      copy.addEventListener('change', () => { mode.value = copy.value; mode.dispatchEvent(new Event('change')); });
      mode.addEventListener('change', () => { copy.value = mode.value; });
    }
    $('#ui3Search').onclick = () => click('bCmdk');
    $('#ui3Name').onclick = (e) => openMenu(e.currentTarget, crumbItems);
    $('#ui3Run').onclick = () => click(document.body.classList.contains('running') ? 'bStop' : 'bRun');
    $('#ui3RunMore').onclick = (e) => openMenu(e.currentTarget, [
      ['Restart', () => click('bRestart')],
      ['Reset', () => click('bReset')],
    ]);
    $('#ui3Help').onclick = (e) => openMenu(e.currentTarget, [
      ['Keyboard shortcuts', () => click('bKeys')],
      ['About', () => openDrawer('about')],
      ['Open-source notices', null, 'notices.html'],
    ]);
    $('#ui3Account').onclick = () => account();
    if (window.__placeUiSwitch) window.__placeUiSwitch();
  }

  function crumbItems() {
    return [
      ['New', () => blank()],
      ['Projects', () => app().cmd.projects()],
      ['Save', () => click('bSave')],
      ['Download', () => click('bDownload')],
      ['Import', () => click('fileIn')],
      ['Rename', () => rename()],
      ['Examples', () => openExamples()],
    ];
  }

  function buildRail() {
    const rail = document.createElement('nav');
    rail.id = 'ui3rail';
    rail.setAttribute('aria-label', 'Tools');
    const items = [
      ['home', 'Home', 'i-folder', () => setHome(true)],
      ['projects', 'Projects', 'i-folder', () => app().cmd.projects()],
      ['examples', 'Examples', 'i-examples', () => openExamples()],
      ['learn', 'Learn', 'i-keyboard', () => startTour()],
      ['parts', 'Parts', 'i-chip', () => { document.body.classList.toggle('ui3-pal-min'); syncRail(); }],
      ['code', 'Code', 'i-cmd', () => openDrawer('code')],
      ['bom', 'Parts list', 'i-examples', () => openDrawer('bom')],
      ['keys', 'Shortcuts', 'i-keyboard', () => click('bKeys')],
      ['settings', 'Settings', 'i-sun', (b) => openMenu(b, settingsItems)],
    ];
    rail.innerHTML = items.map(([id, label, icon]) => `<button type="button" data-rail="${id}" aria-label="${label}" title="${label}">${ic(icon)}</button>`).join('');
    document.body.appendChild(rail);
    rail.onclick = (e) => {
      const b = e.target.closest('[data-rail]'); if (!b) return;
      const item = items.find((x) => x[0] === b.dataset.rail);
      if (item) item[3](b);
    };
  }
  function settingsItems() {
    return [
      ['Theme', () => click('bTheme')],
      ['Minimap', () => click('bMap')],
      ['Tidy schematic', () => { click('bViewSch'); click('schLayTidy'); }],
      ['Breadboard arrangement', () => { click('bViewSch'); click('schLayBoard'); }],
    ];
  }
  function syncRail() {
    const parts = $('#ui3rail [data-rail="parts"]');
    if (parts) parts.setAttribute('aria-pressed', document.body.classList.contains('ui3-pal-min') ? 'false' : 'true');
    const code = $('#ui3rail [data-rail="code"]');
    if (code) code.setAttribute('aria-pressed', document.body.classList.contains('ui3-code') ? 'true' : 'false');
  }

  function buildCanvas() {
    const wrap = document.getElementById('stageWrap');
    const views = document.createElement('div');
    views.id = 'ui3views';
    views.setAttribute('role', 'toolbar');
    views.setAttribute('aria-label', 'Circuit view');
    views.tabIndex = 0;
    const sch = document.getElementById('bViewSch');
    const v2 = document.getElementById('bView2d');
    const v3 = document.getElementById('bView3d');
    const lay = document.getElementById('schLayout');
    if (sch) { sch.textContent = 'Schematic'; views.appendChild(sch); }
    if (v2) { v2.textContent = 'Breadboard'; views.appendChild(v2); }
    if (v3) { const span = v3.querySelector('span'); if (span) span.textContent = '3D'; views.appendChild(v3); }
    if (lay) views.appendChild(lay);
    wrap.appendChild(views);
    const tools = document.createElement('div');
    tools.id = 'ui3tools';
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', 'Edit');
    const sel = document.createElement('button');
    sel.type = 'button'; sel.id = 'ui3Select'; sel.setAttribute('aria-label', 'Select'); sel.setAttribute('aria-pressed', 'true'); sel.innerHTML = ic('i-chip');
    sel.onclick = () => { if (app().editor.cancelWire) app().editor.cancelWire(); };
    const wire = document.createElement('button');
    wire.type = 'button'; wire.id = 'ui3Wire'; wire.setAttribute('aria-label', 'Wire'); wire.setAttribute('aria-pressed', 'false'); wire.innerHTML = ic('i-wire');
    wire.onclick = () => { const ed = app().editor; if (ed.mode && ed.mode.k === 'wire' && ed.cancelWire) ed.cancelWire(); else if (ed.setHint) ed.setHint('Click a pin, then another pin, to wire'); };
    tools.append(sel, wire);
    ['selWireColor', 'cbOrtho', 'cbFlow', 'bUndo', 'bRedo', 'bRot', 'bDel'].forEach((id) => {
      const n = document.getElementById(id);
      const host = n && (n.closest('label') || n);
      if (host) tools.appendChild(host);
    });
    wrap.appendChild(tools);
    const zoom = document.createElement('div');
    zoom.id = 'ui3zoom';
    zoom.setAttribute('role', 'toolbar');
    zoom.setAttribute('aria-label', 'Zoom');
    ['bZoomOut', 'zoomPct', 'bZoomIn', 'bFit', 'schFitAll', 'bFitPill', 'bMap'].forEach((id) => {
      const n = document.getElementById(id); if (n) zoom.appendChild(n);
    });
    wrap.appendChild(zoom);
    const badges = document.createElement('div');
    badges.id = 'ui3badges';
    badges.setAttribute('aria-hidden', 'true');
    wrap.appendChild(badges);
  }

  function buildDrawer() {
    const dock = document.getElementById('dock');
    if (!dock) return;
    dock.tabIndex = 0;
    dock.inert = true;
    const close = document.createElement('button');
    close.type = 'button'; close.id = 'ui3DockClose'; close.textContent = 'Close';
    close.setAttribute('aria-label', 'Close code');
    const tabs = document.getElementById('tabs');
    if (tabs) tabs.appendChild(close);
    close.onclick = () => setDrawer(false);
  }
  function openDrawer(tab) {
    setDrawer(true);
    const btn = document.querySelector(`#tabs [data-tab="${tab}"]`);
    if (btn) btn.click();
    if (tab === 'scope' && app().ensureScope) app().ensureScope();
    if (phone()) document.body.classList.remove('ui3-parts', 'ui3-props', 'ui3-more');
  }
  function setDrawer(open) {
    document.body.classList.toggle('ui3-code', open);
    const dock = document.getElementById('dock');
    if (dock) dock.inert = !open;
    syncRail();
  }

  function buildContext() {
    const bar = document.createElement('div');
    bar.id = 'ui3ctx';
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Selection');
    bar.innerHTML = `<button type="button" data-act="rot">Rotate</button><button type="button" data-act="del">Delete</button><button type="button" data-act="props">Properties</button><button type="button" data-act="dup">Duplicate</button>`;
    document.getElementById('stageWrap').appendChild(bar);
    bar.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b || b.getAttribute('aria-disabled') === 'true') return;
      const ed = app().editor;
      if (b.dataset.act === 'rot') ed.rotateSel();
      else if (b.dataset.act === 'del') ed.deleteSel();
      else if (b.dataset.act === 'dup') ed.duplicateSel();
      else openProps();
    };
    const prev = app().editor.hooks.selected;
    app().editor.hooks.selected = (s) => { if (prev) prev(s); placeContext(s); };
  }
  function openProps() {
    document.body.classList.remove('ui3-side-min');
    if (phone()) { document.body.classList.add('ui3-props'); document.body.classList.remove('ui3-parts', 'ui3-more'); setDrawer(false); }
    const side = document.getElementById('side');
    if (side) side.tabIndex = 0;
  }
  function placeContext(sel) {
    const bar = document.getElementById('ui3ctx'); if (!bar) return;
    const sch = document.body.classList.contains('viewsch');
    bar.querySelectorAll('[data-act="rot"],[data-act="del"]').forEach((b) => {
      b.setAttribute('aria-disabled', sch ? 'true' : 'false');
      b.title = sch ? 'Switch to Breadboard to edit' : '';
    });
    if (!sel || (!sel.part && !sel.wire)) { bar.hidden = true; return; }
    bar.hidden = false;
    const dup = bar.querySelector('[data-act="dup"]');
    if (dup) dup.hidden = !sel.part;
    if (phone()) return;
    const id = sel.part;
    const el = id && (document.querySelector(`#lParts [data-id="${CSS.escape(id)}"]`) || document.querySelector(`#stageSch [data-pid="${CSS.escape(id)}"]`));
    const wrap = document.getElementById('stageWrap').getBoundingClientRect();
    const r = el ? el.getBoundingClientRect() : null;
    let left = r ? r.right - wrap.left + 8 : 80;
    let top = r ? r.top - wrap.top : 120;
    const bw = bar.offsetWidth || 220;
    if (left + bw > wrap.width - 8) left = Math.max(8, (r ? r.left - wrap.left : 80) - bw - 8);
    top = Math.max(64, Math.min(top, wrap.height - 48));
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  function buildStatus() {
    const pill = document.createElement('section');
    pill.id = 'ui3status';
    pill.setAttribute('aria-label', 'Status');
    const status = document.getElementById('status');
    const dot = document.getElementById('connDot');
    const live = document.getElementById('stLive');
    if (live) pill.appendChild(live);
    if (status) pill.appendChild(status);
    if (dot) pill.appendChild(dot);
    document.body.appendChild(pill);
    const alert = document.createElement('p');
    alert.id = 'ui3alert';
    alert.hidden = true;
    alert.setAttribute('role', 'status');
    document.body.appendChild(alert);
    const peek = document.createElement('button');
    peek.type = 'button'; peek.id = 'ui3Peek'; peek.textContent = 'Serial';
    peek.onclick = () => openDrawer('serial');
    document.body.appendChild(peek);
    const side = document.getElementById('side');
    const insp = document.getElementById('tab-insp');
    if (insp) insp.tabIndex = 0;
    document.querySelectorAll('#dock .tab').forEach((tab) => { tab.tabIndex = 0; });
    if (side && !$('#ui3check')) {
      const box = document.createElement('div');
      box.id = 'ui3check';
      box.innerHTML = '<h2>Circuit check</h2><p id="ui3checkText">No problems found.</p><canvas id="ui3spark" width="260" height="36" aria-hidden="true"></canvas>';
      side.appendChild(box);
    }
  }

  function buildWelcome() {
    const home = document.createElement('section');
    home.id = 'ui3home';
    home.tabIndex = 0;
    home.hidden = true;
    home.setAttribute('aria-label', 'Welcome');
    home.innerHTML = `<div class="ui3-bento">
      <article class="ui3-card"><h2>Blink tour</h2>
        <p class="ui3-lede">Five steps on a real ESP32 DevKit. The tidy schematic stays available beside the breadboard.</p>
        <ol class="ui3-steps"><li>Add an LED.</li><li>Add a resistor.</li><li>Wire GPIO2 to the resistor, the resistor to the LED, and the LED to GND.</li><li>Open the sketch.</li><li>Run and watch the LED turn on and off.</li></ol>
        <button type="button" id="ui3StartTour">Start the Blink tour</button></article>
      <article class="ui3-card"><h2>Recent projects</h2><div id="ui3Recent" class="ui3-recent"></div>
        <p><button type="button" id="ui3Back" hidden>Back to circuit</button></p>
        <p class="ui3-lede">Learn &amp; help</p>
        <p><button type="button" id="ui3HomeKeys">Keyboard shortcuts</button> <a href="notices.html">Open-source notices</a></p>
        <p class="ui3-lede">Simulator for ESP32. Not affiliated with Espressif, Arduino, or Wokwi.</p></article>
      <div id="ui3Gallery" class="ui3-gallery"></div>
      <div id="ui3AllEx" class="ui3-card ui3-more-ex"><h2>All examples</h2><div id="ui3AllList"></div></div>
    </div>`;
    document.getElementById('main').appendChild(home);
    $('#ui3StartTour').onclick = () => startTour();
    $('#ui3Back').onclick = () => setHome(false);
    $('#ui3HomeKeys').onclick = () => click('bKeys');
    const tour = document.createElement('aside');
    tour.id = 'ui3tour';
    tour.hidden = true;
    tour.setAttribute('aria-live', 'polite');
    tour.innerHTML = '<h2>Blink tour</h2><p id="ui3TourNow"></p><button type="button" id="ui3TourCode">Open code</button> <button type="button" id="ui3TourRun">Run</button> <button type="button" id="ui3TourHide">Dismiss</button>';
    document.body.appendChild(tour);
    $('#ui3TourCode').onclick = () => { tourCode = true; openDrawer('code'); scoreTour(); };
    $('#ui3TourRun').onclick = () => click(document.body.classList.contains('running') ? 'bStop' : 'bRun');
    $('#ui3TourHide').onclick = () => stopTour();
  }
  function setHome(open) {
    document.body.classList.toggle('ui3-home', open);
    const home = document.getElementById('ui3home');
    if (home) home.hidden = !open;
    const back = document.getElementById('ui3Back');
    if (back) back.hidden = !(open && app().proj);
    if (open) paintWelcome();
  }
  function paintWelcome() {
    const gallery = document.getElementById('ui3Gallery');
    const all = document.getElementById('ui3AllList');
    const recent = document.getElementById('ui3Recent');
    if (!gallery || !window.Examples) return;
    const list = Examples.LIST || [];
    const byKey = Object.fromEntries(list.map((row) => [row[0], row[1]]));
    gallery.innerHTML = FEATURED.filter(([k]) => byKey[k] || k === 'blank').map(([k, name, level]) =>
      `<button type="button" class="ui3-tile" data-ex="${esc(k)}"><span class="ui3-level">${esc(level)}</span><strong>${esc(byKey[k] || name)}</strong></button>`).join('');
    gallery.onclick = (e) => { const b = e.target.closest('[data-ex]'); if (b) openTemplate(b.dataset.ex); };
    if (all) {
      all.innerHTML = list.map(([k, name]) => `<button type="button" data-ex="${esc(k)}"><span>${esc(name)}</span></button>`).join('');
      all.onclick = (e) => { const b = e.target.closest('[data-ex]'); if (b) openTemplate(b.dataset.ex); };
    }
    if (recent && app().store && app().store.list) {
      const rows = app().store.list().slice(0, 6);
      recent.innerHTML = rows.length ? rows.map((p) => `<button type="button" data-proj="${esc(p.id)}">${esc(p.name || 'Untitled')}</button>`).join('') : '<p class="ui3-lede">No saved projects yet.</p>';
      recent.onclick = (e) => {
        const b = e.target.closest('[data-proj]'); if (!b) return;
        if (app().openProject(b.dataset.proj)) { forceSch = !requestedView; setHome(false); }
      };
    }
  }
  async function openTemplate(key) {
    if (key === 'blank') {
      forceSch = true;
      if (window.Examples && app().importProject(Examples.newBlank('esp32'))) setHome(false);
      return;
    }
    if (app().ensureExamples) { try { await app().ensureExamples(); } catch (e) { /* examples.js is already on the page */ } }
    forceSch = true;
    const ok = app().cmd.loadExample ? await app().cmd.loadExample(key) : false;
    if (ok === false && !(app().proj && app().proj.example === key)) return;
    setHome(false);
  }
  function blank() {
    if (!window.Examples) return;
    app().newBlankDialog($('#ui3Name') || document.body, (kind) => {
      forceSch = true;
      if (app().importProject(Examples.newBlank(kind))) setHome(false);
    });
  }
  function startTour() {
    if (!window.Examples) return;
    prefer2d = true;
    tourOn = true; tourCode = false; tourOnSeen = false; tourOffSeen = false;
    const raw = Examples.newBlank('esp32');
    raw.name = 'Blink tour';
    if (!app().importProject(raw)) return;
    setHome(false);
    const card = document.getElementById('ui3tour');
    if (card) card.hidden = false;
    scoreTour();
  }
  function stopTour() { tourOn = false; const c = document.getElementById('ui3tour'); if (c) c.hidden = true; }
  function scoreTour() {
    if (!tourOn) return;
    const proj = app().proj; if (!proj) return;
    const led = proj.parts.some((p) => p.type === 'led');
    const res = proj.parts.find((p) => p.type === 'resistor');
    let wired = false;
    try {
      if (led && res && app().sim && app().sim.netAt && window.Parts) {
        const esp = proj.parts.find((p) => p.type === 'esp32');
        const ledP = proj.parts.find((p) => p.type === 'led');
        const net = (part, name) => { const pin = Parts.T[part.type].pins(part).find((q) => q.name === name); if (!pin) return -1; const w = Parts.pinWorld(part, pin); return app().sim.netAt(w.x, w.y); };
        const drive = net(esp, 'D2'), r1 = net(res, '1'), r2 = net(res, '2'), a = net(ledP, 'A'), cth = net(ledP, 'C');
        const gnd = (n) => n === 0 || n === net(esp, 'GND.1') || n === net(esp, 'GND.2');
        const join = (x, y) => x != null && x >= 0 && x === y;
        wired = +res.props.r > 0 && ((join(drive, r1) && join(a, r2)) || (join(drive, r2) && join(a, r1))) && gnd(cth);
      }
    } catch (e) { wired = false; }
    const running = document.body.classList.contains('running');
    if (running && led) {
      const ledP = proj.parts.find((p) => p.type === 'led');
      const i = Math.abs((app().sim.partState(ledP) || {}).i || 0);
      if (i > 0.001) tourOnSeen = true;
      if (tourOnSeen && i < 0.0001) tourOffSeen = true;
    }
    const steps = [led, !!res, wired, tourCode, running && tourOnSeen && tourOffSeen];
    const labels = ['Add an LED from the parts list.', 'Add a resistor.', 'Wire GPIO2 to the resistor, the resistor to the LED anode, and the LED cathode to GND.', 'Open the sketch.', 'Run and watch the LED turn on and off.'];
    const i = steps.findIndex((ok) => !ok);
    const el = document.getElementById('ui3TourNow');
    if (el) el.textContent = i < 0 ? 'Blink is working. The LED has turned on and off.' : `Step ${i + 1} of 5. ${labels[i]}`;
  }

  function buildPhone() {
    const nav = document.createElement('nav');
    nav.id = 'ui3tabs';
    nav.setAttribute('aria-label', 'Workspace');
    nav.innerHTML = `<button type="button" data-phone="circuit">Circuit</button><button type="button" data-phone="parts">Parts</button><button type="button" id="ui3TabRun" data-phone="run">Run</button><button type="button" data-phone="code">Code</button><button type="button" data-phone="more" aria-haspopup="dialog" aria-expanded="false" aria-controls="ui3more">More</button>`;
    document.body.appendChild(nav);
    nav.onclick = (e) => {
      const b = e.target.closest('[data-phone]'); if (!b) return;
      const k = b.dataset.phone;
      if (k === 'run') { click(document.body.classList.contains('running') ? 'bStop' : 'bRun'); return; }
      document.body.classList.remove('ui3-parts', 'ui3-props', 'ui3-more');
      if (k === 'circuit') { setDrawer(false); syncPhone(); return; }
      if (k === 'parts') { setDrawer(false); document.body.classList.add('ui3-parts'); }
      else if (k === 'code') openDrawer('code');
      else { setDrawer(false); document.body.classList.add('ui3-more'); const m = document.getElementById('ui3more'); if (m) { m.hidden = false; m.focus(); } b.setAttribute('aria-expanded', 'true'); }
      syncPhone();
    };
    const more = document.createElement('section');
    more.id = 'ui3more';
    more.hidden = true;
    more.tabIndex = 0;
    more.setAttribute('role', 'dialog');
    more.setAttribute('aria-modal', 'true');
    more.setAttribute('aria-label', 'More');
    more.innerHTML = `<h2>Project</h2><div id="ui3moreProj"></div><h2>Simulation</h2><div id="ui3ModePhone"></div><button type="button" data-go="restart">Restart</button><button type="button" data-go="reset">Reset</button><button type="button" data-go="flags">Build flags</button><h2>View</h2><button type="button" data-go="sch">Schematic</button><button type="button" data-go="2d">Breadboard</button><button type="button" data-go="3d">3D</button><button type="button" data-go="tidy">Tidy layout</button><button type="button" data-go="board">Board layout</button><button type="button" data-go="theme">Theme</button><button type="button" data-go="map">Minimap</button><button type="button" data-go="ortho">Right-angle wires</button><button type="button" data-go="flow">Animate current</button><h2>Account</h2><button type="button" data-go="account">Sign in</button><button type="button" data-go="about">About</button><button type="button" data-go="keys">Keyboard shortcuts</button><h2>Legal</h2><a href="notices.html">Open-source notices</a><p>Simulator for ESP32. Not affiliated with Espressif, Arduino, or Wokwi.</p><button type="button" data-go="close">Close</button>`;
    document.body.appendChild(more);
    more.onclick = (e) => {
      const b = e.target.closest('[data-go]'); if (!b) return;
      const go = b.dataset.go;
      if (go === 'close') closeMore();
      else if (go === 'restart') click('bRestart');
      else if (go === 'reset') click('bReset');
      else if (go === 'flags') { closeMore(); openDrawer('code'); const d = document.getElementById('codeAdvanced'); if (d) d.open = true; const inp = document.getElementById('inDefines'); if (inp) inp.focus(); }
      else if (go === 'sch') click('bViewSch');
      else if (go === '2d') click('bView2d');
      else if (go === '3d') click('bView3d');
      else if (go === 'tidy') click('schLayTidy');
      else if (go === 'board') click('schLayBoard');
      else if (go === 'theme') click('bTheme');
      else if (go === 'map') click('bMap');
      else if (go === 'ortho') click('cbOrtho');
      else if (go === 'flow') click('cbFlow');
      else if (go === 'account') account();
      else if (go === 'about') { closeMore(); openDrawer('about'); }
      else if (go === 'keys') click('bKeys');
    };
    placeMode();
    window.addEventListener('resize', placeMode);
  }
  function placeMode() {
    const sel = document.getElementById('ui3Mode'); if (!sel) return;
    const slot = document.getElementById(phone() ? 'ui3ModePhone' : 'ui3ModeDesk');
    if (slot && sel.parentNode !== slot) slot.appendChild(sel);
  }
  function closeMore() {
    document.body.classList.remove('ui3-more');
    const m = document.getElementById('ui3more'); if (m) m.hidden = true;
    const b = document.querySelector('#ui3tabs [data-phone="more"]');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function syncPhone() {
    const sheet = document.body.classList.contains('ui3-parts') ? 'parts' : document.body.classList.contains('ui3-code') ? 'code' : document.body.classList.contains('ui3-more') ? 'more' : 'circuit';
    document.querySelectorAll('#ui3tabs [data-phone]').forEach((b) => b.classList.toggle('on', b.dataset.phone === sheet));
    const more = document.getElementById('ui3more');
    if (more) more.hidden = !document.body.classList.contains('ui3-more');
  }

  function buildPaletteExtras() {
    const pal = document.getElementById('palette'); if (!pal || $('#ui3chips')) return;
    document.querySelectorAll('.pitem').forEach((it) => { const g = it.closest('.pgrid'); if (g && !it.dataset.cat) it.dataset.cat = g.dataset.cat || ''; });
    const list = document.getElementById('palList');
    const cat = document.createElement('div'); cat.className = 'pcat'; cat.dataset.cat = 'Starter'; cat.textContent = 'Starter';
    const grid = document.createElement('div'); grid.className = 'pgrid'; grid.dataset.cat = 'Starter';
    list.prepend(grid); list.prepend(cat);
    STARTER.forEach((t) => { const it = list.querySelector(`.pitem[data-type="${t}"]`); if (it) { it.dataset.cat = 'Starter'; grid.appendChild(it); } });
    document.querySelectorAll('.pitem').forEach((it) => {
      if (it.querySelector('.ui3-spec') || !window.Parts) return;
      const d = Parts.T[it.dataset.type]; if (!d) return;
      const s = document.createElement('small'); s.className = 'ui3-spec'; s.textContent = specOf(it.dataset.type, d);
      if (s.textContent) it.appendChild(s);
    });
    const row = document.createElement('div');
    row.id = 'ui3chips'; row.className = 'ui3-chips'; row.tabIndex = 0; row.setAttribute('role', 'toolbar'); row.setAttribute('aria-label', 'Part categories');
    const cats = [];
    pal.querySelectorAll('.pcat').forEach((c) => { if (c.dataset.cat && !cats.includes(c.dataset.cat)) cats.push(c.dataset.cat); });
    ['All', ...cats].forEach((c, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = c; b.setAttribute('aria-pressed', i ? 'false' : 'true');
      b.onclick = () => { chip = c; row.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); applyChip(); };
      row.appendChild(b);
    });
    const search = pal.querySelector('.pal-search');
    if (search) search.after(row);
    const input = document.getElementById('palSearch');
    if (input && !input.dataset.ui3) {
      input.dataset.ui3 = '1';
      const prev = input.oninput;
      input.oninput = (e) => { if (typeof prev === 'function') prev.call(input, e); applyChip(); };
    }
  }
  function specOf(type, d) {
    const r = d.props && d.props.r;
    if (r) { const n = Number(r); const text = n >= 1000 ? (n / 1000) + ' kΩ' : n + ' Ω'; return type === 'resistor' && n === 220 ? text + ' · ¼ W' : text; }
    if (d.props && d.props.color) return String(d.props.color);
    return d.cat || '';
  }
  function applyChip() {
    if (chip === 'All') return;
    document.querySelectorAll('.pitem').forEach((it) => { if (it.dataset.cat !== chip) it.hidden = true; });
    document.querySelectorAll('.pgrid').forEach((g) => {
      const any = [...g.children].some((c) => !c.hidden);
      g.hidden = !any;
      if (g.previousElementSibling && g.previousElementSibling.classList.contains('pcat')) g.previousElementSibling.hidden = !any;
    });
  }

  function openExamples() {
    if (!window.Examples) return;
    openMenu($('#ui3rail [data-rail="examples"]') || $('#ui3Name'), () => (Examples.LIST || []).map(([k, name]) => [name, () => openTemplate(k)]));
  }
  function openMenu(anchor, items) {
    closeMenu();
    const list = typeof items === 'function' ? items() : items;
    const box = document.createElement('div');
    box.className = 'ui3-menu';
    box.tabIndex = 0;
    box.setAttribute('role', 'menu');
    list.forEach((item) => {
      const node = item[2] ? document.createElement('a') : document.createElement('button');
      if (!item[2]) node.type = 'button';
      node.setAttribute('role', 'menuitem');
      node.textContent = item[0];
      if (item[2]) node.href = item[2];
      else node.onclick = () => { closeMenu(); item[1](); };
      box.appendChild(node);
    });
    document.body.appendChild(box);
    menu = box;
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
    box.dataset.anchor = anchor.id || '';
    const first = box.querySelector('button,a'); if (first) first.focus();
  }
  function closeMenu() {
    if (!menu) return;
    const id = menu.dataset.anchor;
    if (id) { const a = document.getElementById(id); if (a) a.setAttribute('aria-expanded', 'false'); }
    menu.remove(); menu = null;
  }

  function account() {
    const state = window.clAuth && clAuth.getState && clAuth.getState();
    if (state && state.signed_in) { const out = document.getElementById('bSignOut'); if (out) out.click(); return; }
    if (window.clAuth && clAuth.openWindow) clAuth.openWindow({ opener: document.getElementById('ui3Account') });
    else click('bSignIn');
  }
  function rename() {
    const p = app().proj; if (!p || app().readOnly) return;
    const n = prompt('Project name', p.name || '');
    if (!n || !String(n).trim()) return;
    p.name = String(n).trim();
    const t = document.getElementById('projTitle'); if (t) t.textContent = p.name;
    app().cmd.save();
    syncId();
  }
  function minimapOff() {
    let saved = null;
    try { saved = clStorage.local.getItem('esp32lab.ui.minimap'); } catch (e) { saved = ''; }
    const mm = document.getElementById('minimap');
    if (saved == null && mm && !mm.classList.contains('off')) click('bMap');
  }

  function syncId() {
    const name = document.getElementById('ui3Name');
    const save = document.getElementById('ui3Save');
    const p = app() && app().proj;
    if (name) name.textContent = p ? (p.name || 'Untitled') : 'No project';
    if (save) save.textContent = !p ? '' : app().readOnly ? 'Example' : app().saveState === 'unsaved' ? 'Not saved' : 'Saved locally';
  }
  function syncRun() {
    const busy = document.getElementById('bRun');
    const spinning = busy && busy.classList.contains('spinning');
    const onRun = document.body.classList.contains('running');
    const label = spinning ? ((busy.querySelector('span') && busy.querySelector('span').textContent) || 'Building…') : onRun ? 'Stop' : 'Run';
    ['ui3Run', 'ui3TabRun'].forEach((id) => {
      const b = document.getElementById(id); if (!b) return;
      if (b.textContent !== label) b.textContent = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-busy', spinning ? 'true' : 'false');
    });
    const acc = document.getElementById('ui3Account');
    const state = window.clAuth && clAuth.getState && clAuth.getState();
    if (acc && state) acc.textContent = state.signed_in ? (state.display_name || 'Account') : 'Sign in';
  }
  function syncAlerts() {
    const dot = document.getElementById('connDot');
    const alert = document.getElementById('ui3alert');
    if (!alert || !dot) return;
    const bad = dot.classList.contains('bad');
    alert.hidden = !bad;
    if (bad) {
      const title = dot.title || '';
      alert.textContent = !title || title === 'Backend connection'
        ? "Can't reach the simulator right now. Your work is saved on this device."
        : title;
    }
    const strip = document.getElementById('compileStrip');
    const top = (strip && !strip.hidden && strip.getBoundingClientRect().height > 2) ? strip.getBoundingClientRect().bottom + 8 : (phone() ? 64 : 68);
    alert.style.top = top + 'px';
  }
  function syncLive() {
    paintNets();
    paintBadges();
    paintCheck();
    const serial = document.getElementById('serial');
    const peek = document.getElementById('ui3Peek');
    if (serial && peek) {
      const text = (serial.textContent || '').trim().split('\n').filter(Boolean).slice(-1)[0] || 'Serial';
      peek.textContent = text.length > 42 ? text.slice(0, 42) + '…' : text;
    }
    const wiring = app().editor && app().editor.mode && app().editor.mode.k === 'wire';
    const sel = document.getElementById('ui3Select');
    const wire = document.getElementById('ui3Wire');
    if (sel) sel.setAttribute('aria-pressed', wiring ? 'false' : 'true');
    if (wire) wire.setAttribute('aria-pressed', wiring ? 'true' : 'false');
    if (tourOn) scoreTour();
    if (app().editor && app().editor.sel) placeContext(app().editor.sel);
  }
  function paintNets() {
    const proj = app().proj; if (!proj) return;
    const ledNets = new Set();
    try {
      if (app().sim && app().sim.netAt && window.Parts) {
        proj.parts.forEach((p) => {
          if (p.type !== 'led' || !Parts.T.led) return;
          Parts.T.led.pins(p).forEach((pin) => {
            const w = Parts.pinWorld(p, pin);
            const n = app().sim.netAt(w.x, w.y);
            if (n != null) ledNets.add(n);
          });
        });
      }
    } catch (e) { /* the next tick retries */ }
    document.querySelectorAll('#lWires .wire').forEach((g) => {
      const w = proj.wires.find((x) => x.id === g.getAttribute('data-wid'));
      g.classList.remove('net-gnd', 'net-led', 'net-sig', 'net-pwr');
      if (!w) return;
      let cls = 'net-sig';
      if (w.color === 'black' || w.color === 'gray' || w.color === 'brown') cls = 'net-gnd';
      else if (w.color === 'red') cls = 'net-pwr';
      if (app().sim && app().sim.netAt && ledNets.size) {
        const n = app().sim.netAt(w.a.x, w.a.y);
        if (ledNets.has(n) && cls !== 'net-gnd') cls = 'net-led';
      }
      g.classList.add(cls);
    });
    const svg = document.getElementById('stageSch');
    if (!svg) return;
    let cls = 'net-sig';
    svg.querySelectorAll('.sch-hitnet, .sch-wire').forEach((el) => {
      if (el.classList.contains('sch-hitnet')) {
        const name = (el.dataset.name || '').toUpperCase();
        cls = name.includes('GND') ? 'net-gnd' : name.includes('LED') ? 'net-led' : 'net-sig';
      } else {
        el.classList.remove('net-gnd', 'net-led', 'net-sig');
        el.classList.add(cls);
      }
    });
  }
  function paintBadges() {
    const host = document.getElementById('ui3badges'); if (!host || !app().proj) return;
    const wrap = document.getElementById('stageWrap').getBoundingClientRect();
    const sch = document.body.classList.contains('viewsch');
    const rows = [];
    const push = (el, text) => {
      if (!el || !text) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2) return;
      rows.push({ text, x: Math.max(4, r.right - wrap.left + 4), y: Math.max(4, r.top - wrap.top) });
    };
    app().proj.parts.forEach((p) => {
      if (p.type !== 'led' && p.type !== 'resistor' && p.type !== 'esp32') return;
      const el = sch ? document.querySelector(`#stageSch [data-pid="${CSS.escape(p.id)}"]`) : document.querySelector(`#lParts [data-id="${CSS.escape(p.id)}"]`);
      let text = '';
      if (p.type === 'resistor') text = (Number(p.props.r) || 0) + ' Ω';
      if (p.type === 'led' && app().sim) {
        const i = Math.abs((app().sim.partState(p) || {}).i || 0);
        text = i > 0.00005 && window.Parts ? Parts.fmt(i, 'A') : (p.props.color || 'LED');
      }
      if (p.type === 'esp32' && app().sim && app().sim.espRuntime) {
        try {
          const rt = app().sim.espRuntime(p);
          const pin = rt && rt.pins && rt.pins[2];
          text = pin ? ('GPIO2 · ' + (pin.out ? (pin.level ? 'HIGH' : 'LOW') : 'IN')) : 'GPIO2';
        } catch (e) { text = 'GPIO2'; }
      }
      push(el, text);
    });
    host.innerHTML = rows.slice(0, 6).map((r) => `<span class="ui3-badge" style="left:${r.x}px;top:${r.y}px">${esc(r.text)}</span>`).join('');
  }
  function paintCheck() {
    const el = document.getElementById('ui3checkText'); if (!el || !app().proj) return;
    const res = app().proj.parts.find((p) => p.type === 'resistor' && p.id === 'R1') || app().proj.parts.find((p) => p.type === 'resistor');
    const led = app().proj.parts.find((p) => p.type === 'led');
    let text = 'No problems found.';
    const warn = document.getElementById('warnList');
    if (warn && warn.textContent && warn.textContent.trim() && warn.textContent.trim() !== 'none') text = warn.textContent.trim();
    else if (res && led && app().sim) {
      const i = Math.abs((app().sim.partState(led) || {}).i || 0);
      if (i > 0.00005) {
        const ma = (i * 1000);
        text = `Current is limited by ${res.id}, ${ma.toFixed(1)} mA, ${i < 0.02 ? 'safe' : 'high — check the resistor'}.`;
        if (!reduced()) { spark.push(ma); if (spark.length > 40) spark.shift(); drawSpark(); }
      }
    }
    if (el.textContent !== text) el.textContent = text;
  }
  function drawSpark() {
    const c = document.getElementById('ui3spark'); if (!c || !spark.length) return;
    const g = c.getContext('2d'); if (!g) return;
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#22d3ee'; g.lineWidth = 1.5; g.beginPath();
    const max = Math.max(8, ...spark);
    spark.forEach((v, i) => {
      const x = (i / Math.max(1, spark.length - 1)) * (w - 4) + 2;
      const y = h - 4 - (v / max) * (h - 8);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.stroke();
  }

  function watch() {
    new MutationObserver(syncAll).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const dot = document.getElementById('connDot');
    if (dot) new MutationObserver(syncAlerts).observe(dot, { attributes: true });
    window.addEventListener('projectchange', () => {
      syncId();
      if (!app().proj) return;
      const arriving = prefer2d || forceSch || !sawProject;
      sawProject = true;
      if (arriving) setHome(false);
      if (prefer2d) { prefer2d = false; app().cmd.view2d(); }
      else if (forceSch) { forceSch = false; if (!requestedView) app().cmd.viewSch(); }
    });
    window.addEventListener('authchange', syncRun);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (menu) { closeMenu(); return; }
      if (document.body.classList.contains('ui3-more')) { closeMore(); return; }
      if (document.body.classList.contains('ui3-code')) { setDrawer(false); return; }
      if (document.body.classList.contains('ui3-parts') || document.body.classList.contains('ui3-props')) {
        document.body.classList.remove('ui3-parts', 'ui3-props'); syncPhone();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!menu || menu.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[aria-expanded="true"]')) return;
      closeMenu();
    }, true);
    setInterval(() => { syncRun(); syncAlerts(); syncLive(); }, 400);
  }
  function syncAll() { syncId(); syncRun(); syncAlerts(); syncRail(); syncPhone(); placeMode(); }

  function kick() {
    if (!on() || (document.body && document.body.dataset.ui3 === '1')) return;
    if (!document.body || !app() || !app().editor) return;
    boot();
  }
  document.addEventListener('DOMContentLoaded', kick);
  window.addEventListener('load', kick);
  kick();
  setTimeout(kick, 0);
})();
