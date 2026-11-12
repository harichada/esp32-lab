async function fetchRetry(u,o,n=4){for(let i=0;;i++){try{const r=await fetch(u,o);if(r.status>=502&&r.status<=504&&i<n)throw new Error('gw');return r;}catch(e){if(i>=n)throw e;await new Promise(z=>setTimeout(z,1500*(i+1)));}}}
/* Application glue: project state, runtimes (QEMU over websocket / JS sketch), panels, devices, persistence. */
(function () {
  const P = window.Parts, { Sim } = window.SimCore, R = window.RemoteLogic, $ = (s) => document.querySelector(s);
  const STORE = 'esp32lab.project.v1';
  const store = new Projects.ProjectStore();
  const app = window.app = { store, readOnly: false, netlog: new NetLogMod.NetLog(), proj: null, sim: null, world: new Devices.MockWorld(), run: null, serialText: '', file: 'sketch', irFrames: [], lastBits: null };
  // ---------------- project ----------------
  function normalize(p) {
    p.parts = p.parts || []; p.wires = p.wires || []; p.files = p.files || {}; p.mode = p.mode || 'qemu'; p.defines = p.defines || []; p.code = p.code ?? '';
    for (const w of p.wires) w.pts = w.pts || [];
    for (const q of p.parts) { q.rot = q.rot || 0; q.props = Object.assign({}, (P.T[q.type] || {}).props, q.props || {}); }
    return p;
  }
  function setProject(p, opts) {
    stopRun(); app.readOnly = !!(opts && opts.readOnly);
    if (window.Netlist) { try { Netlist.migrate(p); } catch (e) { /* open the board even if its netlist cannot be built */ } }
    app.proj = normalize(p); app.sim = new Sim(app.proj); app.file = 'sketch'; app.world = new Devices.MockWorld(); app.world.onchange = () => (app.devDirty = true); app.world.onlog = (e) => app.netlog.add({ k: 'dev', msg: `${e.proto}: ${e.summary}`, ok: !(e.code < 0 || e.code >= 400) });
    app.editor.setProject(app.proj);
    // Editor.setProject drops the selection without notifying the Inspector.
    app.editor.select(null);
    setTimeout(() => app.editor.fit(), 0);
    $('#selMode').value = app.proj.mode; $('#inDefines').value = app.proj.defines.join(','); renderFileTabs(); loadCode(); modeNote();
    $('#cbDiodes').checked = !app.proj.parts.some((q) => q.type === 'diode' && q.props.bypass);
    const hasDev = !!app.proj.devices; document.querySelector('[data-tab=dev]').style.display = hasDev ? '' : 'none';
    if (window.Instruments) Instruments.setProject(app.proj, app.sim);
    serialClear(); app.irFrames = [];
    serialAppend(`— ${app.proj.name || 'project'} —\n${app.proj.notes ? app.proj.notes + '\n' : ''}`);
    app.devDirty = true; setStatus('idle', 'idle'); renderBanner();
    if (window.Bom) Bom.render(document.getElementById('bomView'), app.proj);
    if (app.view3d) app.view3d.setProject(app.proj);
    if (app.schematic) { app.schematic.sel = null; app.schematic.setProject(app.proj); }
  }
  async function loadExample(k) {
    const ex = Examples.EX[k](); ex.example = k;
    if (ex.fetch) {
      for (const [name, url] of Object.entries(ex.fetch)) {
        try { const t = await (await fetch(url)).text(); if (name === 'sketch') ex.code = t; else ex.files[name] = t; }
        catch (e) { ex.code = ex.code || `// could not fetch ${url} (serve the site with server.py)`; }
        ex.files = ex.files || {};
      }
    }
    setProject(ex, { readOnly: true }); setUrl({ ex: k });
  }
  Examples.EX.remote = ((f) => () => { const e = f(); e.files = {}; return e; })(Examples.EX.remote);
  // ---------------- projects: examples are read-only, edits go to a copy in My Projects ----------------
  function setUrl(o) { const u = new URL(location.href); u.searchParams.delete('ex'); u.searchParams.delete('p'); u.searchParams.delete('t'); for (const k in o) u.searchParams.set(k, o[k]); history.replaceState(null, '', u); }
  function makeCopy(auto) {
    syncDefines(); syncCode(); const was = app.proj.name;
    const c = store.copy(app.proj); Object.assign(app.proj, { id: c.id, name: c.name, copiedFrom: c.copiedFrom }); delete app.proj.example;
    app.readOnly = false; store.save(app.proj); setUrl({ p: app.proj.id }); renderBanner();
    toast(auto ? `Examples are read-only — your change is in a copy: “${app.proj.name}” (My Projects)` : `Copied “${was}” to My Projects as “${app.proj.name}”`);
    return app.proj;
  }
  function beforeEdit() { if (app.readOnly) makeCopy(true); }
  let saveT = 0;
  function autosave() { if (app.readOnly || !app.proj) return; clearTimeout(saveT); saveT = setTimeout(() => { syncCode(); store.save(app.proj); renderBanner(true); }, 600); }
  function syncDefines() { if (app.proj) app.proj.defines = $('#inDefines').value.split(',').map((x) => x.trim()).filter(Boolean); }
  function openProject(id) { const p = store.get(id); if (!p) { toast('Project not found', true); return false; } setProject(p); setUrl({ p: id }); store.save(app.proj); return true; }
  function renderBanner(saved) {
    const b = $('#projBanner'); if (!b || !app.proj) return;
    if (app.readOnly) b.innerHTML = `<span class="pb-ex">📘 Example: <b>${P.esc(app.proj.name || '')}</b> — read-only</span><button id="bCopy" class="primary">Make a copy</button><span class="muted">editing anything makes a copy automatically</span>`;
    else b.innerHTML = `<span class="pb-my">✎ My project: <b id="pbName" title="Click to rename">${P.esc(app.proj.name || 'Untitled')}</b></span><span class="muted">${saved ? 'saved ' + new Date().toLocaleTimeString() : 'auto-saved'}</span>`;
    const pt = $('#projTitle'); if (pt) { pt.textContent = app.proj.name || 'Untitled'; const k = $('#projKind'); k.textContent = app.readOnly ? 'Example · read-only' : 'My project'; k.className = 'chip-tag ' + (app.readOnly ? 'ex' : 'mine'); }
    const bc = $('#bCopy'); if (bc) bc.onclick = () => makeCopy(false);
    const pn = $('#pbName'); if (pn) pn.onclick = () => { const n = prompt('Rename project', app.proj.name); if (n) { app.proj.name = n; store.rename(app.proj.id, n); renderBanner(true); } };
  }
  function save() { syncCode(); syncDefines(); if (app.readOnly) { makeCopy(false); return; } store.save(app.proj); renderBanner(true); toast('Saved “' + app.proj.name + '” to My Projects' + (store.serverSync ? ' (+ server copy)' : '')); }
  function projectsDialog() {
    let d = $('#projDlg'); if (!d) { d = document.createElement('div'); d.id = 'projDlg'; d.className = 'modal'; document.body.appendChild(d); }
    const L = store.list();
    d.innerHTML = `<div class="modal-box"><div class="row"><h3 style="flex:1;margin:0">My Projects</h3><button data-a="close">✕</button></div>
      <div class="row"><button data-a="new">＋ New blank</button><label class="btn">⤒ Import JSON / diagram.json<input type="file" id="projImp" accept=".json,application/json" hidden></label>
      <label title="Also keep a copy of each project on the simulator server"><input type="checkbox" id="cbSrv" ${store.serverSync ? 'checked' : ''}> server copy</label><button data-a="srv">From server…</button></div>
      <table class="projs">${L.map((e) => `<tr data-id="${e.id}" class="${app.proj && app.proj.id === e.id ? 'cur' : ''}"><td class="pn">${P.esc(e.name)}<br><small class="muted">${new Date(e.updated).toLocaleString()}${e.from ? ' · from ' + P.esc(e.from) : ''}</small></td>
        <td><button data-a="open">Open</button><button data-a="ren">Rename</button><button data-a="dup">Duplicate</button><button data-a="exp">Export</button><button data-a="del">Delete</button></td></tr>`).join('') || '<tr><td class="muted">No projects yet. Open an example and press “Make a copy” (or just start editing it).</td></tr>'}</table><div id="srvList"></div></div>`;
    d.hidden = false;
    d.onclick = async (e) => {
      if (e.target === d) { d.hidden = true; return; }
      const b = e.target.closest('[data-a]'); if (!b) return; const id = b.closest('tr') && b.closest('tr').dataset.id; const a = b.dataset.a;
      if (a === 'close') d.hidden = true;
      else if (a === 'new') newBlankDialog(b, (kind) => { const p = store.importJson(Examples.newBlank(kind)); openProject(p.id); d.hidden = true; });
      else if (a === 'open') { openProject(id); d.hidden = true; }
      else if (a === 'ren') { const n = prompt('Rename project', store.list().find((x) => x.id === id).name); if (n) { store.rename(id, n); if (app.proj.id === id) { app.proj.name = n; renderBanner(true); } projectsDialog(); } }
      else if (a === 'dup') { store.duplicate(id); projectsDialog(); }
      else if (a === 'exp') { const t = store.exportJson(id); const bl = new Blob([t], { type: 'application/json' }); const l = document.createElement('a'); l.href = URL.createObjectURL(bl); l.download = (JSON.parse(t).name || 'project').replace(/[^\w.-]+/g, '_') + '.json'; l.click(); }
      else if (a === 'del') { if (confirm('Delete this project? (Export it first if you want a backup)')) { store.remove(id); if (app.proj.id === id) loadExample('blink'); projectsDialog(); } }
      else if (a === 'srv') { try { const S = await store.listServer(); $('#srvList').innerHTML = '<h4>On the server</h4>' + (S.map((x) => `<div class="row"><span style="flex:1">${P.esc(x.name)}</span><button data-a="pull" data-sid="${P.esc(x.id)}">Open</button></div>`).join('') || '<p class="muted">none</p>'); } catch (er) { toast('Server list failed', true); } }
      else if (a === 'pull') { try { await store.pullServer(b.dataset.sid); openProject(b.dataset.sid); d.hidden = true; } catch (er) { toast(er.message, true); } }
    };
    $('#cbSrv').onchange = (e) => { store.serverSync = e.target.checked; if (e.target.checked && !app.readOnly) store.save(app.proj); };
    $('#projImp').onchange = (e) => { const f = e.target.files[0]; if (!f) return; f.text().then((t) => { try { const o = JSON.parse(t); const p = store.importJson(o.connections && o.parts && !o.wires ? importWokwi(o) : o); openProject(p.id); d.hidden = true; toast('Imported ' + f.name); } catch (er) { toast('Could not import: ' + er.message, true); } }); };
  }
  // "+ New blank" chooser: Basic circuit (bare breadboard, no ESP32) vs ESP32 (DevKit V1, empty sketch, real firmware).
  // Cancel / ✕ / Esc / backdrop close it without touching the current project. Focus is trapped while open.
  function newBlankDialog(opener, onPick) {
    let d = $('#newBlankDlg'); if (!d) { d = document.createElement('div'); d.id = 'newBlankDlg'; d.className = 'modal nb-modal'; document.body.appendChild(d); }
    d.innerHTML = `<div class="modal-box nb-box" role="dialog" aria-modal="true" aria-labelledby="nbTitle" aria-describedby="nbSub">
      <div class="row"><h3 id="nbTitle" style="flex:1;margin:0">New blank project</h3><button data-a="cancel" aria-label="Close">✕</button></div>
      <p id="nbSub" class="muted nb-sub">What are you building?</p>
      <div class="nb-opts" role="group" aria-label="Project type">
        <button class="nb-opt" data-k="basic"><span class="nb-t">Basic circuit</span><span class="nb-tag">No code</span>
          <span class="nb-d">An empty breadboard with no microcontroller. Add batteries, resistors, LEDs, switches and meters. The circuit is solved live, with nothing to compile.</span></button>
        <button class="nb-opt" data-k="esp32"><span class="nb-t">ESP32</span><span class="nb-tag">Real firmware</span>
          <span class="nb-d">An ESP32 DevKit V1 on a breadboard with an empty sketch. Your Arduino code is compiled and run on an emulated ESP32 (QEMU).</span></button>
      </div>
      <div class="row nb-foot"><button data-a="cancel">Cancel</button></div></div>`;
    const prevFocus = opener || document.activeElement;
    const close = () => { d.hidden = true; window.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus(); };
    const focusables = () => [...d.querySelectorAll('button:not([disabled])')];
    function onKey(e) {
      if (d.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      if (e.key === 'Tab') {
        const f = focusables(); if (!f.length) return; const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
        return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') && document.activeElement && document.activeElement.classList.contains('nb-opt')) {
        const o = [...d.querySelectorAll('.nb-opt')], i = o.indexOf(document.activeElement); e.preventDefault(); o[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? o.length - 1 : 1)) % o.length].focus();
      }
    }
    window.addEventListener('keydown', onKey, true);
    d.onclick = (e) => {
      if (e.target === d) { close(); return; }
      const opt = e.target.closest('.nb-opt'); if (opt) { const k = opt.dataset.k; d.hidden = true; window.removeEventListener('keydown', onKey, true); onPick(k); return; }
      if (e.target.closest('[data-a=cancel]')) close();
    };
    d.hidden = false; const first = d.querySelector('.nb-opt'); if (first) first.focus();
  }
  app.newBlankDialog = newBlankDialog;
  app.makeCopy = makeCopy; app.openProject = openProject;
  function download() { syncCode(); const b = new Blob([JSON.stringify(app.proj, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = (app.proj.name || 'project').replace(/[^\w.-]+/g, '_') + '.json'; a.click(); }
  function openFile(f) {
    const rd = new FileReader();
    rd.onload = () => { try { const o = JSON.parse(rd.result); const p = store.importJson(o.connections && o.parts && !o.wires ? importWokwi(o) : o); openProject(p.id); toast('Loaded ' + f.name + ' into My Projects'); } catch (e) { toast('Could not load: ' + e.message, true); } };
    rd.readAsText(f);
  }
  // ---------------- third-party diagram.json import (interoperability) ----------------
  const WOKWI = { 'wokwi-esp32-devkit-v1': 'esp32', 'board-esp32-devkit-c-v4': 'esp32', 'wokwi-led': 'led', 'wokwi-resistor': 'resistor', 'wokwi-pushbutton': 'pushbutton', 'wokwi-pushbutton-6mm': 'pushbutton', 'wokwi-potentiometer': 'potentiometer', 'wokwi-slide-potentiometer': 'potentiometer', 'wokwi-buzzer': 'buzzer', 'wokwi-slide-switch': 'slideswitch', 'wokwi-photoresistor-sensor': 'ldr', 'wokwi-breadboard': 'breadboard', 'wokwi-breadboard-half': 'breadboard', 'wokwi-ir-receiver': null, 'wokwi-ir-remote': null };
  const WOKWI_PIN = { potentiometer: { VCC: '1', SIG: 'W', GND: '2' }, buzzer: { 1: '-', 2: '+' }, led: { A: 'A', C: 'C' }, slideswitch: { 1: '1', 2: '2', 3: '3' }, ldr: { VCC: '1', AO: '2', GND: '2' } };
  function importWokwi(d) {
    const parts = [], wires = [], skipped = [];
    for (const wp of d.parts) {
      const t = WOKWI[wp.type]; if (!t) { skipped.push(wp.type); continue; }
      const a = wp.attrs || {}, props = {};
      if (t === 'led' && a.color) props.color = a.color; if (t === 'resistor' && a.value) props.r = a.value; if (t === 'potentiometer' && a.value) props.r = a.value;
      parts.push({ id: wp.id, type: t, x: Math.round((wp.left || 0) / 10) * 10, y: Math.round((wp.top || 0) / 10) * 10 + 40, rot: Math.round(((wp.rotate || 0) % 360) / 90) & 3, props });
    }
    const pinPos = (ref) => {
      const [id, ...rest] = ref.split(':'); const pin = rest.join(':'); const p = parts.find((q) => q.id === id); if (!p) return null;
      const name = (WOKWI_PIN[p.type] || {})[pin] || pin; const def = P.T[p.type].pins(p).find((q) => q.name === name); return def ? P.pinWorld(p, def) : null;
    };
    let n = 0;
    for (const c of d.connections || []) {
      const a = pinPos(c[0]), b = pinPos(c[1]); if (!a || !b) continue;
      const col = String(c[2] || 'green').replace(/^#.*/, 'green');
      wires.push({ id: 'w' + (++n), a, b, pts: a.x !== b.x && a.y !== b.y ? [{ x: a.x, y: b.y }] : [], color: window.WIRE_COLORS[col] ? col : 'green' });
    }
    return { name: 'Imported from diagram.json', mode: 'qemu', code: Examples.BLINK, parts, wires, notes: skipped.length ? 'Skipped unsupported diagram.json parts: ' + [...new Set(skipped)].join(', ') : 'Imported diagram.json (sketch not included in diagram.json — paste it in the Code tab).' };
  }
  app.importWokwi = importWokwi;
  // ---------------- code editor ----------------
  function renderFileTabs() {
    const names = ['sketch', ...Object.keys(app.proj.files)];
    $('#fileTabs').innerHTML = names.map((n) => `<button data-f="${n}" class="${n === app.file ? 'on' : ''}">${n === 'sketch' ? (app.proj.mode === 'js' ? 'sketch.js' : 'sketch.ino') : n}</button>`).join('') + `<button data-f="+" title="Add a header/source file">＋</button>`;
  }
  function syncCode() { const v = $('#code').value; if (app.file === 'sketch') app.proj.code = v; else app.proj.files[app.file] = v; }
  function loadCode() { $('#code').value = app.file === 'sketch' ? app.proj.code : app.proj.files[app.file] || ''; }
  function modeNote() {
    $('#modeNote').innerHTML = app.proj.mode === 'qemu'
      ? '<b>Real firmware.</b> Compiled by arduino-cli (esp32 core 3.3, DOIT DevKit V1) and executed in Espressif QEMU (Xtensa LX6). GPIO out/in/enable, pull-ups, RMT (IR) and UART0 are bridged to this circuit. ADC (SAR with a typical chip’s non-linear response + eFuse Vref, so analogReadMilliVolts is right up to 3.13 V), LEDC PWM + hardware fades, I²C (SSD1306, BME280, MPU6050) and SPI (ILI9341 TFT, MCP3008, microSD/FAT) are bridged; Wi-Fi sketches run real lwIP (TCP/HTTP + UDP) over QEMU’s open_eth NIC. <span class="warn">Not emulated: the 802.11 radio, Bluetooth, deep sleep.</span>'
      : app.proj.mode === 'circuit' ? '<b>Basic circuit (no ESP32).</b> No code and no compile step: the circuit is solved live (MNA + Newton-Raphson, backward-Euler transient). Press switches/buttons, turn knobs and watch LEDs, lamps, motors and meters respond. Over-current burns out LEDs, resistors and lamps — press Run (or Stop/Run) to reset.'
      : '<b>JS sketch.</b> Arduino-style JavaScript in the browser, virtual time. <span class="warn">Not Xtensa emulation</span> — use it for analogRead/analogWrite/ledcWrite experiments that the QEMU bridge does not cover.';
  }
  // ---------------- serial ----------------
  // rows keep a timestamp per line; rendering is batched per animation frame and colour-coded by line kind
  app.serRows = []; let serRaf = 0;
  function serialClear() { app.serialText = ''; app.serRows = []; const el = $('#serial'); if (el) el.innerHTML = '<div class="empty-t">No serial output yet — press Run.</div>'; }
  function serialAppend(t) {
    app.serialText += t; if (app.serialText.length > 200000) app.serialText = app.serialText.slice(-150000);
    const parts = String(t).split('\n'), now = Date.now(), R = app.serRows;
    if (R.length && !R[R.length - 1].done) R[R.length - 1].s += parts[0]; else R.push({ t: now, s: parts[0] });
    for (let i = 1; i < parts.length; i++) { R[R.length - 1].done = true; R.push({ t: now, s: parts[i] }); }
    if (R.length > 5000) R.splice(0, R.length - 4000);
    if (!serRaf) serRaf = requestAnimationFrame(serialRender);
  }
  const SER_CLS = [[/error|fail|panic|guru|abort|exception|backtrace/i, 'err'], [/warn|timeout|no reply|skipped/i, 'wrn'], [/^\[(net|qemu-eth)\]/, 'net'], [/^(POST|GET|\[lwIP)/, 'http'], [/^(\[qemu\]|\[compiled|—|\[qemu exited)/, 'sys'], [/^(ets |rst:|load:|entry |configsip|clk_drv|mode:DIO)/, 'boot'], [/^» /, 'in']];
  function serialRender() {
    serRaf = 0; const el = $('#serial'); if (!el) return;
    const follow = $('#cbFollow') ? $('#cbFollow').checked : true, ts = $('#cbSerTs') && $('#cbSerTs').checked;
    const rows = app.serRows.slice(-2500); if (rows.length && rows[rows.length - 1].s === '' && rows.length > 1) rows.pop();
    if (!rows.length || (rows.length === 1 && !rows[0].s)) { el.innerHTML = '<div class="empty-t">No serial output yet — press Run.</div>'; return; }
    el.innerHTML = rows.map((r) => { let c = ''; for (const [re, k] of SER_CLS) if (re.test(r.s)) { c = k; break; } const d = new Date(r.t);
      return `<span class="ln ${c}">${ts ? `<span class="ts">${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}</span>` : ''}${P.esc(r.s) || ' '}</span>`; }).join('');
    if (follow) el.scrollTop = el.scrollHeight;
  }
  app.serialRender = serialRender;
  let uartBuf = '';
  function onUart(d) {
    uartBuf += d.replace(/\r/g, '');
    let i;
    while ((i = uartBuf.indexOf('\n')) >= 0) {
      let line = uartBuf.slice(0, i); uartBuf = uartBuf.slice(i + 1);
      const k = line.indexOf('\x1ePX ');   // NeoPixel frame from the QemuNeoPixel show() back end (may follow partial text)
      if (k >= 0) { onPixels(line.slice(k + 4)); line = line.slice(0, k); if (!line) continue; serialAppend(line); continue; }
      if (line.startsWith('@NET ')) { handleNet(line.slice(5)); if ($('#cbNetLines').checked) serialAppend(line + '\n'); }
      else serialAppend(line + '\n');
    }
    if (uartBuf && !uartBuf.startsWith('@') && uartBuf.indexOf('\x1e') < 0) { serialAppend(uartBuf); uartBuf = ''; }
    else if (uartBuf.length > 4096) { serialAppend(uartBuf.replace(/\x1e/g, '')); uartBuf = ''; }
  }
  function handleNet(js) {
    let j; try { j = JSON.parse(js); } catch (e) { serialAppend('[bad @NET] ' + js + '\n'); return; }
    if (j.k === 'http') { const r = app.world.http(j); sendRun({ t: 'uart', d: `@R ${r.code} ${String(r.body || '').replace(/\n/g, ' ')}\n` }); }
    else if (j.k === 'udp') { for (const r of app.world.udp(j)) sendRun({ t: 'uart', d: `@U ${r.ip} ${r.sport} ${r.dport} ${r.hex}\n` }); }
    else if (j.k === 'wifi') { app.world._log('WiFi', `WiFi.begin("${j.ssid}") — association simulated (no radio)`, j, 0); }
    app.devDirty = true;
  }
  // ---------------- runtimes ----------------
  function sendRun(m) { if (app.run && app.run.ws && app.run.ws.readyState === 1) app.run.ws.send(JSON.stringify(m)); }
  function espPart() { return app.proj.parts.find((q) => q.type === 'esp32'); }
  function setStatus(kind, text) { $('#stDot').className = 'dot ' + kind; $('#stText').textContent = text; document.body.classList.toggle('busy', kind === 'busy'); document.body.classList.toggle('running', kind === 'run'); const st = $('#stage'); if (st) st.classList.toggle('live', kind === 'run'); }
  window.addEventListener('pagehide', (ev) => { if (ev.persisted || !app.run || app.run.kind !== 'qemu') return; if (app.run.ws && app.run.ws.readyState === 1) { try { app.run.ws.send(JSON.stringify({ t: 'stop', why: STOP_ON_CLOSE ? 'user' : 'pagehide' })); } catch (e) { /* closing */ } if (STOP_ON_CLOSE) try { sessionStorage.removeItem('esp32run'); } catch (e) { /* none */ } } });
  // ?keeprun=0 restores the old "closing the tab stops QEMU" behaviour; by default a closed/discarded/reloaded tab can
  // re-attach to its still-running QEMU session (saved in sessionStorage), and the server reaps it after SIM_RESUME_GRACE.
  const STOP_ON_CLOSE = new URLSearchParams(location.search).get('keeprun') === '0';
  function saveRun(run) { try { if (run && run.sid && !run.ended) sessionStorage.setItem('esp32run', JSON.stringify({ bid: run.bid, sid: run.sid, at: Date.now() })); else sessionStorage.removeItem('esp32run'); } catch (e) { /* storage off */ } }
  function kickReconnect() {   // tab visible again / network back: don't wait out a (throttled) backoff timer
    const r = app.run; if (!r || r.kind !== 'qemu' || !r.sid || r.ended) return;
    if (!r.ws) { clearTimeout(r.retryT); r.tries = Math.min(r.tries, 1); connectRun(r); }
    else if (r.ws.readyState <= 1 && Date.now() - r.lastMsgAt > 15000) { try { r.ws.onclose && r.ws.onclose(); } catch (e) { /* */ } }
  }
  // A hidden/frozen tab stops reading the socket; the server is back-pressured and kernel/ngrok buffers fill with stale
  // GPIO snapshots, so after wake-up everything (keys, IR) lags by that backlog forever. Re-attaching instead makes the
  // server replay only what matters (latest GPIO + all UART/events) -> instantly live again. ?wakeresume=0 disables.
  let hiddenAt = document.hidden ? Date.now() : 0; const WAKE_RESUME = new URLSearchParams(location.search).get('wakeresume') !== '0';
  function onWake(force) {
    const r = app.run;
    if (WAKE_RESUME && r && r.kind === 'qemu' && r.sid && !r.ended && r.ws && (force || (hiddenAt && Date.now() - hiddenAt > 10000))) {
      app.netlog.add({ k: 'info', msg: 'tab woke up — re-attaching to drop the stale backlog' }); const ws = r.ws; r.tries = 0; try { ws.onclose && ws.onclose(); } catch (e) { /* */ }
      clearTimeout(r.retryT); if (app.run === r && !r.ws) connectRun(r);
    } else kickReconnect();
    hiddenAt = 0;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else onWake(false); });
  document.addEventListener('freeze', () => { hiddenAt = hiddenAt || Date.now() - 60000; });
  document.addEventListener('resume', () => onWake(true));
  window.addEventListener('online', kickReconnect); window.addEventListener('focus', kickReconnect);
  window.addEventListener('pageshow', kickReconnect);
  app.resumeSavedRun = function () {   // after a reload / tab discard: re-attach to the QEMU run that kept going on the server
    let s; try { s = JSON.parse(sessionStorage.getItem('esp32run') || 'null'); } catch (e) { s = null; }
    if (!s || !s.sid || app.run || !espPart()) return false;
    const run = app.run = { kind: 'qemu', t0: performance.now(), bid: s.bid, sid: s.sid, lastN: 0, tries: 1, resumedFromStorage: true };
    app.sim.resetState(); serialAppend('\n[re-attaching to the QEMU run still running on the server…]\n'); connectRun(run); return true;
  };
  function stopRun() {
    const r = app.run; app.run = null; if (!r) return; try { sessionStorage.removeItem('esp32run'); } catch (e) { /* */ }
    clearTimeout(r.retryT); clearInterval(r.hbT); document.body.classList.remove('reconnecting');
    if (r.ws) { try { r.ws.send(JSON.stringify({ t: 'stop', why: 'stop button' })); r.ws.close(); } catch (e) { /* closed */ } }
    if (r.sketch) r.sketch.stop();
    const e = espPart(); if (e) app.sim.espRuntime(e).reset(); app.sim.dirty = true; setStatus('idle', 'stopped');
  }
  // A firmware-cache hit must not keep the stage lines a previous build (or this
  // request's progress poll) wrote into the log. One summary line replaces them.
  function cachedCompileLog(log) {
    const lines = String(log || '').split('\n').map((ln) => ln.trim()).filter(Boolean);
    const stage = /^(?:Building network stack\b.*|Using cached network stack\.\.\.|Compiling sketch\.\.\.|Linking\.\.\.|compiling…)$/;
    const hit = lines.find((ln) => /^\[\d+(?:\.\d+)?s\] cached\b/.test(ln));
    if (hit) return hit + '\n';
    const rest = lines.filter((ln) => !stage.test(ln));
    return rest.length ? rest.join('\n') + '\n' : '';
  }
  let compileBusy = false;
  function setRunBusy(on) {
    compileBusy = !!on;
    const b = $('#bRun');
    if (!b) return;
    b.disabled = !!on;
    b.classList.toggle('spinning', !!on);
    b.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function retryAfterSeconds(r) {
    const h = r && r.headers && r.headers.get && r.headers.get('Retry-After');
    const n = parseInt(h, 10);
    return Number.isFinite(n) && n > 0 && n < 120 ? n : 3;
  }
  async function startRun() {
    if (compileBusy) return;
    syncCode(); stopRun(); app.proj.defines = $('#inDefines').value.split(',').map((s) => s.trim()).filter(Boolean);
    const esp = espPart();
    if (!esp || app.proj.mode === 'circuit') {   // basic circuit (no ESP32): nothing to compile — the MNA solver already runs live; Run just (re)starts it from t=0
      app.sim.resetState(); app.run = { kind: 'circuit', t0: performance.now() }; setStatus('run', 'running (circuit — no ESP32, no compile)');
      serialAppend('\n[circuit simulation started — no ESP32 in this circuit, so there is no firmware to compile]\n'); return;
    }
    app.sim.resetState(); uartBuf = ''; app.lastBits = null; app.i2c = {}; app.i2cCur = null; app.spi = {}; app.spiMask = -1;
    if (app.proj.mode === 'js') {
      const sk = new JsSketchMod.JsSketch(app.proj.code, { sim: app.sim, espPart: esp, serial: serialAppend, onError: (e) => { serialAppend('\n[JS error] ' + e.message + '\n'); setStatus('err', 'error'); } });
      app.run = { kind: 'js', sketch: sk, t0: performance.now() }; setStatus('run', 'running (JS sketch)');
      try { await sk.start(); } catch (e) { return; }
      return;
    }
    const run = app.run = { kind: 'qemu', t0: performance.now() };
    app.netlog.add({ k: 'info', msg: `—— run: ${app.proj.name || 'sketch'} ——` });
    setRunBusy(true);
    setStatus('busy', 'compiling…'); $('#buildLog').textContent = '';
    let res;
    try {
      const bl = $('#buildLog'); bl.textContent = 'compiling…\n';
      run.poll = setInterval(async () => { try { const q = await (await fetch('api/compile/progress')).json(); if (app.run !== run || !run.poll || run.settled) return; if (q.unpacking) setStatus('busy', `unpacking toolchain… ${Math.round((q.unpackProgress || 0) * 100)}%`); else if (q.active) { const stage = q.stage || 'compiling…'; bl.textContent = q.log || (stage + '\n'); bl.scrollTop = bl.scrollHeight; setStatus('busy', `${stage} ${Math.round(q.elapsed)}s`); } } catch (e) {} }, 400);
      const r = await fetchRetry('api/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sketch: app.proj.code, files: app.proj.files, defines: app.proj.defines }) });
      clearInterval(run.poll); run.poll = null;
      if (r.status === 429) {
        const wait = retryAfterSeconds(r);
        try { await r.json(); } catch (e) { /* the status line is the message */ }
        const msg = `Please wait ${wait} second${wait === 1 ? '' : 's'} before compiling again`;
        setStatus('warn', msg); toast(msg);
        $('#buildLog').textContent = msg + '\n';
        serialAppend('\n[' + msg + ']\n');
        app.run = null;
        return;
      }
      res = await r.json();
      run.settled = true;
    } catch (e) { clearInterval(run.poll); run.poll = null; setStatus('err', 'backend unreachable'); serialAppend('\n[backend] cannot reach /api/compile — start server/server.py (see README) or switch to JS sketch mode.\n'); app.run = null; return; }
    finally { setRunBusy(false); }
    if (app.run !== run) return;
    $('#buildLog').textContent = res.cached ? cachedCompileLog(res.log) : (res.log || ''); if (app.codeview) app.codeview.setLog(res.ok ? '' : (res.log || ''));
    if (!res.ok) { setStatus('err', 'compile error'); $('#buildDet').open = true; document.querySelector('[data-tab=build]').click(); if (app.codeview) app.codeview.setLog(res.log || ''); serialAppend('\n[compile failed — see build log in Code tab]\n'); app.run = null; return; }
    serialAppend(`\n[compiled ${res.cached ? '(cached)' : ''}${res.netShim ? ' + QemuNet shim' : ''}; starting QEMU]\n`);
    run.bid = res.id; run.lastN = 0; run.tries = 0; connectRun(run);
  }
  // Resumable run websocket: the server keeps QEMU alive for a grace period when the socket drops (ngrok heartbeat
  // timeouts, network blips). We reconnect with backoff and resume the same session from the last message we saw.
  function connectRun(run) {
    const resume = !!run.sid;
    const q = resume ? `?sid=${run.sid}&since=${run.lastN}` : '';
    const ws = run.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/[^/]*$/, '') + 'api/run/' + run.bid + q);
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'sync', on: true })); ws.send(JSON.stringify({ t: 'i2cfast', on: new URLSearchParams(location.search).get('i2cfast') !== '0' })); if (!app.netlog.enabled) ws.send(JSON.stringify({ t: 'netlog', on: false })); if (new URLSearchParams(location.search).get('gcache') === '0') ws.send(JSON.stringify({ t: 'gcache', on: false }));
      app.spiMask = -1; spiCfg(); setStatus('run', 'running (QEMU)'); document.body.classList.remove('reconnecting'); run.tq = run.tq || performance.now();
      if (resume) { ws.send(JSON.stringify({ t: 'inv' })); app.lastBits = null; replyInputs(true); app.netlog.add({ k: 'info', msg: `websocket resumed (attempt ${run.tries})` }); toast('Reconnected — simulation kept running'); }
      run.tries = 0; run.openedAt = Date.now();
    };
    run.lastMsgAt = Date.now();
    clearInterval(run.hbT); run.hbT = setInterval(() => {   // half-open tunnel (ngrok heartbeat timeout): no data, no close event
      if (app.run !== run) { clearInterval(run.hbT); return; }
      if (run.ws === ws && ws.readyState <= 1 && Date.now() - run.lastMsgAt > 15000) { app.netlog.add({ k: 'info', msg: 'websocket silent for 15 s — reconnecting', ok: false }); lost(); }
    }, 2000);
    ws.onmessage = (ev) => {
      run.lastMsgAt = Date.now();
      const m = JSON.parse(ev.data);
      if (m.t === 'hb') return;
      if (m._n) { if (m._n <= run.lastN) return; run.lastN = m._n; }
      if (m.t === 'session') { run.sid = m.sid; run.grace = (m.grace_s || 0) * 1000; saveRun(run); return; }
      if (m.t === 'exit' || (m.t === 'error' && m.expired)) { run.ended = true; saveRun(run); if (m.expired && run.resumedFromStorage && !run.lastN) { app.run = null; setStatus('idle', 'previous run ended'); return; } }
      onQemu(m);
    };
    const lost = () => {
      if (app.run !== run || run.ws !== ws) return;
      run.ws = null; ws.onclose = ws.onmessage = null; try { ws.close(); } catch (e) { /* already closed */ }
      if (run.ended || !run.sid) { setStatus(run.ended ? 'idle' : 'err', run.ended ? 'QEMU exited' : 'connection lost'); document.body.classList.remove('reconnecting'); app.run = null; return; }
      if (!run.lostAt || run.tries === 0) run.lostAt = Date.now();
      if (run.grace && Date.now() - run.lostAt > run.grace + 600000) { setStatus('err', 'connection lost'); document.body.classList.remove('reconnecting'); serialAppend('\n[connection lost — run expired on the server]\n'); app.run = null; return; }
      const d = Math.min(8000, 400 * Math.pow(2, run.tries++));
      setStatus('warn', `reconnecting… (${run.tries})`); document.body.classList.add('reconnecting');
      if (run.tries === 1) app.netlog.add({ k: 'info', msg: 'websocket dropped — reconnecting, QEMU keeps running on the server', ok: false });
      run.retryT = setTimeout(() => { if (app.run === run) connectRun(run); }, d);
    };
    ws.onclose = lost;
  }
  function replyInputs(force, q) {
    const esp = espPart(); if (!esp) return; const b = app.sim.inputBits(esp); const k = b.in + ':' + b.in1;
    if (force || k !== app.lastBits) { app.lastBits = k; const m = { t: 'in', in: b.in, in1: b.in1 }; if (q != null) m.q = q; sendRun(m); }
  }
  function onQemu(m) {
    const esp = espPart(); if (!esp) return; const rt = app.sim.espRuntime(esp);
    switch (m.t) {
      case 'uart': onUart(m.d); break;
      case 'gpio': case 'mux': case 'rtc': case 'reset': case 'fsel':
        if (!m.fast && (m.t === 'mux' || m.t === 'rtc')) app.lastLockstep = performance.now();   // pin reconfig bursts (DHT read)
        rt.apply(m); if (m.t !== 'fsel' && app.proj.parts.some((q) => q.type === 'dht22')) dhtStep(esp, rt); if (m.t === 'gpio') { app.gpioCount = (app.gpioCount || 0) + 1; spiCsCheck(esp, rt); } if (m.t !== 'fsel') { app.sim.settle(); if (m.fast) { const b = app.sim.inputBits(esp); app.lastBits = b.in + ':' + b.in1; } else replyInputs(true, m.q); } break;
      case 'spi': onSpi(m, esp, rt); break;
      case 'rmt': onRmt(m, esp, rt); break;
      case 'net': {   // real TCP/UDP from lwIP (open_eth -> slirp guestfwd / frame tap -> server) -> mock device
        if (m.k === 'udp') {
          const rs = app.world.udp(m); sendRun({ t: 'udpr', id: m.id, replies: rs });
          serialAppend(`[lwIP UDP] ${m.src}:${m.sport} → ${m.dst}:${m.dport} ${m.hex.length / 2} B → ${rs.length} repl${rs.length === 1 ? 'y' : 'ies'}\n`); app.devDirty = true; break;
        }
        const r = app.world.http(m); sendRun({ t: 'netr', id: m.id, code: r.code, body: r.body || '' });
        serialAppend(`[lwIP→host] ${m.method} ${m.url} → ${r.code}\n`); app.devDirty = true; break;
      }
      case 'i2c': onI2c(m, esp); break;
      case 'pwm': if (rt.apply(m)) app.sim.dirty = true; break;
      case 'adcq': {   // firmware started a SAR conversion: answer with the solved pin voltage, then release the vCPU
        app.sim.settle();
        const tbl = m.u ? P.ADC2 : P.ADC1; const g = +Object.keys(tbl).find((k) => tbl[k] === m.ch);
        const raw = g >= 0 ? app.sim.analogRead(esp, g) : 0;
        sendRun({ t: 'adc', u: m.u, ch: m.ch, v: raw }); replyInputs(true); break;
      }
      case 'netlog': app.netlog.add(m); break;
      case 'invack': onInvAck(); break;
      case 'status': serialAppend(`[qemu] ${m.msg}\n`); break;
      case 'error': app.netlog.add({ k: 'info', msg: 'error: ' + m.msg, ok: false }); serialAppend(`[error] ${m.msg}\n`); setStatus('err', 'error'); break;
      case 'exit': serialAppend(`[qemu exited ${m.code}]\n`); break;
    }
  }
  // ---------------- servo / NeoPixel / DHT22 (state that the parts render; parts never see the ESP32 runtime) ----------------
  function gpioOf(esp, q, pin) {   // which ESP32 GPIO shares a net with part pin q:pin (-1 if none)
    const S = app.sim, n = S.pinNet.get(q.id + ':' + pin); if (!(n > 0)) return -1;
    for (let g = 0; g < 40; g++) if (S.pinNet.get(esp.id + ':D' + g) === n) return g;
    return -1;
  }
  function powered(q, a, b, v) { return app.sim.pinVoltage(q, a) - app.sim.pinVoltage(q, b) > v; }
  function onPixels(s) {
    const m = /^(\d+) ([0-9a-f]*)/.exec(s); if (!m) return; const esp = espPart(); if (!esp) return;
    const gpio = +m[1], hex = m[2], px = [];
    for (let i = 0; i + 6 <= hex.length; i += 6) { const gg = parseInt(hex.substr(i, 2), 16), r = parseInt(hex.substr(i + 2, 2), 16), b = parseInt(hex.substr(i + 4, 2), 16); px.push([r, gg, b]); }   // wire order GRB
    for (const q of app.proj.parts) {
      if (q.type !== 'neopixel' && q.type !== 'neoring') continue;
      if (gpioOf(esp, q, 'DIN') !== gpio) continue;
      const st = app.sim.partState(q), on = powered(q, 'VCC', 'GND', 2.5), n = Math.max(1, +q.props.n || 8);
      st.px = on ? px.slice(0, n) : []; st.frames = (st.frames || 0) + 1; st.gpio = gpio; app.sim.dirty = true;
    }
  }
  function updateServos(dt) {
    const esp = espPart(); const rt = esp && app.run && app.run.kind === 'qemu' ? app.sim.espRuntime(esp) : null;
    for (const q of app.proj.parts) {
      if (q.type !== 'servo') continue; const st = app.sim.partState(q);
      if (st.angle === undefined) st.angle = 90;
      const g = rt ? gpioOf(esp, q, 'SIG') : -1, pin = g >= 0 ? rt.pins[g] : null;
      st.lowV = !!rt && !powered(q, 'V+', 'GND', 4); const live = !!rt && powered(q, 'V+', 'GND', 3);
      if (pin && pin.out && pin.pwm !== undefined && pin.pwmFreq > 20 && pin.pwmFreq < 400 && pin.pwm > 0) {
        st.us = pin.pwm * 1e6 / pin.pwmFreq; st.hz = pin.pwmFreq;
        const lo = +q.props.min || 544, hi = +q.props.max || 2400;
        st.target = Math.max(0, Math.min(180, (st.us - lo) / (hi - lo) * 180));
      } else { st.us = 0; }
      if (live && st.us && st.target !== undefined) {   // SG90: about 0.1 s / 60 degrees
        const step = 600 * dt, d = st.target - st.angle; st.angle += Math.abs(d) <= step ? d : Math.sign(d) * step;
      }
    }
  }
  function dhtStep(esp, rt) {
    for (const q of app.proj.parts) {
      if (q.type !== 'dht22') continue; const g = gpioOf(esp, q, 'DATA'); if (g < 0) continue;
      const pin = rt.pins[g], st = app.sim.partState(q), prev = st.drive;
      if (!powered(q, 'VCC', 'GND', 2.5)) { st.armed = false; st.drive = undefined; }
      else if (pin.out && !pin.level) { st.armed = true; st.bit = -1; st.lastPu = null; st.drive = undefined; }
      else if (st.armed && !pin.out) {
        if (st.lastPu === null) st.lastPu = pin.pu;
        else if (pin.pu !== st.lastPu) {
          st.lastPu = pin.pu; st.bit++;
          if (st.bit < 40) { const b = P.T.dht22.bytes(q); st.drive = (b[st.bit >> 3] >> (7 - (st.bit & 7))) & 1; }
          else { st.drive = undefined; st.armed = false; st.reads = (st.reads || 0) + 1; }
        }
      }
      if (st.drive !== prev) app.sim.dirty = true;
    }
  }
  // ---------------- I2C bus (QEMU I2C controller -> virtual modules) ----------------
  function i2cDev(q) {
    app.i2c = app.i2c || {}; let d = app.i2c[q.id];
    if (!d) {
      const env = () => q.props;
      if (window.PartsReg && PartsReg.isI2c(q.type)) return (app.i2c[q.id] = PartsReg.i2cDev(q));   // add-on I2C parts (js/parts/)
      d = app.i2c[q.id] = q.type === 'lcd1602' ? new I2CDev.LCD1602() : q.type === 'ssd1306' ? new I2CDev.SSD1306() : q.type === 'bme280' ? new I2CDev.BME280(() => ({ temp: +q.props.temp, hum: +q.props.hum, press: +q.props.press })) : new I2CDev.MPU6050(() => ({ ax: +q.props.ax, ay: +q.props.ay, az: +q.props.az, gx: +q.props.gx, gy: +q.props.gy, gz: +q.props.gz, temp: +q.props.temp }));
    }
    return d;
  }
  function i2cFind(esp, bus, addr) {
    const S = app.sim, sda = S.pinNet.get(esp.id + ':D21'), scl = S.pinNet.get(esp.id + ':D22');
    for (const q of app.proj.parts) {
      if (!(/^(ssd1306|bme280|mpu6050|lcd1602)$/.test(q.type) || (window.PartsReg && PartsReg.isI2c(q.type))) || parseInt(q.props.addr, 16) !== addr) continue;
      const qs = S.pinNet.get(q.id + ':SDA'), qc = S.pinNet.get(q.id + ':SCL');
      const wired = bus === 0 ? (qs === sda && qc === scl && sda > 0 && scl > 0) : (qs > 0 && qc > 0);
      if (wired && S.pinVoltage(q, 'VCC') - S.pinVoltage(q, 'GND') > 2.5) return q;
    }
    return null;
  }
  function onI2c(m, esp) {
    const a = m.a;
    if (m.op === 'S') {
      app.sim.settle(); const q = i2cFind(esp, a[0], a[1]); app.i2cCur = q;
      if (q) { i2cDev(q).start(!!a[2]); const st = app.sim.partState(q); st.i2cN = (st.i2cN || 0) + 1; st.i2cInfo = `${st.i2cN} transactions`; }
      if (!m.fast) { sendRun({ t: 'i2cr', ack: q ? 0 : 1 }); replyInputs(true); }   // fast: the server already ACKed from this page's earlier answer
    } else if (m.op === 'W') { if (app.i2cCur) { const d = i2cDev(app.i2cCur); for (const b of a) d.write(b); } }
    else if (m.op === 'R') { const b = app.i2cCur ? i2cDev(app.i2cCur).read() : 0xff; sendRun({ t: 'i2cr', b }); replyInputs(true); }
    else if (m.op === 'P') { if (app.i2cCur) i2cDev(app.i2cCur).stop(); app.i2cCur = null; }
  }
  // ---------------- SPI bus (QEMU SPI2/SPI3 controllers -> virtual parts; CS / D/C are ordinary GPIOs) ----------------
  const SPI_PINS = { 3: { sck: 18, mosi: 23, miso: 19 }, 2: { sck: 14, mosi: 13, miso: 12 } };
  const SPI_TYPES = /^(ili9341|mcp3008|sdcard)$/;
  function spiDev(q) {
    let d = app.spi[q.id];
    if (!d) {
      if (q.type === 'ili9341') d = new SPIDev.ILI9341();
      else if (q.type === 'mcp3008') d = new SPIDev.MCP3008(() => { const S = app.sim, g = S.pinVoltage(q, 'GND'), vr = S.pinVoltage(q, 'VDD') - g; return { vref: vr > 0.5 ? vr : 3.3, ch: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => S.pinVoltage(q, 'CH' + i) - g) }; });
      else d = new SPIDev.SDCard(SPIDev.fat16Image([['HELLO.TXT', String(q.props.hello || '') + '\r\n']]));
      app.spi[q.id] = d;
    }
    return d;
  }
  function espGpioOnNet(esp, net) { if (!(net > 0)) return -1; for (let g = 0; g < 40; g++) if (app.sim.pinNet.get(esp.id + ':' + ({ 1: 'TX0', 3: 'RX0', 16: 'RX2', 17: 'TX2' }[g] || 'D' + g)) === net) return g; return -1; }
  function spiCfg() {   // tell QEMU which GPIOs are chip-selects of parts that answer on MISO (those transactions run in lock-step)
    const esp = espPart(); if (!esp || !app.run || app.run.kind !== 'qemu') return; let mask = 0n;
    for (const q of app.proj.parts) if (q.type === 'mcp3008' || q.type === 'sdcard') { const g = espGpioOnNet(esp, app.sim.pinNet.get(q.id + ':CS')); if (g >= 0) mask |= 1n << BigInt(g); }
    if (Number(mask) !== app.spiMask) { app.spiMask = Number(mask); sendRun({ t: 'spicfg', mask: app.spiMask }); }
  }
  function spiSelected(esp, rt, bus) {
    const S = app.sim, pins = SPI_PINS[bus]; if (!pins) return [];
    const sck = S.pinNet.get(esp.id + ':D' + pins.sck), mosi = S.pinNet.get(esp.id + ':D' + pins.mosi), miso = S.pinNet.get(esp.id + ':D' + pins.miso), out = [];
    for (const q of app.proj.parts) {
      if (!SPI_TYPES.test(q.type)) continue;
      const clk = S.pinNet.get(q.id + (q.type === 'mcp3008' ? ':CLK' : ':SCK')), din = S.pinNet.get(q.id + (q.type === 'mcp3008' ? ':DIN' : ':MOSI'));
      if (!(sck > 0) || clk !== sck || din !== mosi) continue;
      const g = espGpioOnNet(esp, S.pinNet.get(q.id + ':CS')); if (g < 0) continue; const p = rt.pin(g); if (!p.out || p.level) continue;
      const vcc = q.type === 'mcp3008' ? 'VDD' : 'VCC'; if (S.pinVoltage(q, vcc) - S.pinVoltage(q, 'GND') < 2.5) continue;
      const dcg = q.type === 'ili9341' ? espGpioOnNet(esp, S.pinNet.get(q.id + ':DC')) : -1;
      out.push({ q, dc: dcg >= 0 ? rt.pin(dcg).level : 1, miso: S.pinNet.get(q.id + (q.type === 'mcp3008' ? ':DOUT' : ':MISO')) === miso && miso > 0 });
    }
    return out;
  }
  function spiCsCheck(esp, rt) {   // CS released -> part resets its framing
    if (!app.spiSel) return;
    for (const id of [...app.spiSel]) { const q = app.proj.parts.find((x) => x.id === id); const g = q ? espGpioOnNet(esp, app.sim.pinNet.get(q.id + ':CS')) : -1; if (!q || g < 0 || rt.pin(g).level || !rt.pin(g).out) { if (q && app.spi[id]) app.spi[id].deselect(); app.spiSel.delete(id); } }
  }
  function onSpi(m, esp, rt) {
    const sel = spiSelected(esp, rt, m.bus), h = m.hex || '', n = h.length >> 1; app.spiSel = app.spiSel || new Set();
    const rx = m.r ? new Array(n).fill(0xff) : null;
    for (const s of sel) {
      const d = spiDev(s.q), ctx = { dc: s.dc }; app.spiSel.add(s.q.id);
      for (let i = 0; i < n; i++) { const r = d.xfer(parseInt(h.substr(i * 2, 2), 16), ctx); if (rx && s.miso) rx[i] = r; }
      const st = app.sim.partState(s.q); st.spiN = (st.spiN || 0) + n; st.spiInfo = `${st.spiN} bytes`;
    }
    if (m.r) { sendRun({ t: 'spir', hex: rx.map((b) => (b & 255).toString(16).padStart(2, '0')).join('') }); replyInputs(true); }
  }
  function renderTfts() {   // panel RAM -> image; a landscape-mounted module shows the 240x320 glass turned 90° counter-clockwise
    for (const q of app.proj.parts) {
      if (q.type !== 'ili9341' || !app.spi) continue; const d = app.spi[q.id]; if (!d || d.version === d._drawn) continue;
      d._drawn = d.version; const land = q.props.view !== 'portrait', W = d.W, H = d.H, cw = land ? H : W, ch = land ? W : H;
      const key = 'tftCanvas' + cw; const c = app[key] || (app[key] = Object.assign(document.createElement('canvas'), { width: cw, height: ch }));
      const g = c.getContext('2d'), im = g.createImageData(cw, ch), o = im.data, f = d.fb;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const si = (y * W + x) * 4, di = land ? (((W - 1 - x) * cw) + y) * 4 : si;
        if (!d.on) { o[di] = o[di + 1] = o[di + 2] = 8; } else if (d.inv) { o[di] = 255 - f[si]; o[di + 1] = 255 - f[si + 1]; o[di + 2] = 255 - f[si + 2]; } else { o[di] = f[si]; o[di + 1] = f[si + 1]; o[di + 2] = f[si + 2]; }
        o[di + 3] = 255;
      }
      g.putImageData(im, 0, 0); app.sim.partState(q).img = c.toDataURL();
    }
  }
  function renderLcd(q, d) {   // 16x2 HD44780: 5x8 dots per cell, 1-dot gaps, drawn 1:1 then scaled by the svg <image>
    const c = app.lcdCanvas || (app.lcdCanvas = Object.assign(document.createElement('canvas'), { width: 16 * 6 - 1, height: 2 * 9 - 1 }));
    const g = c.getContext('2d'), green = q.props.color === 'green', bl = d.backlight;
    const on = green ? (bl ? '#1b2a06' : '#141c06') : (bl ? '#eef4ff' : '#3c4a80'), off = green ? (bl ? 'rgba(0,0,0,.07)' : 'rgba(0,0,0,.05)') : (bl ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.04)');
    g.clearRect(0, 0, c.width, c.height);
    for (let r = 0; r < 2; r++) for (let col = 0; col < 16; col++) {
      const rows = d.disp ? d.glyph(d.charAt(r, col)) : new Array(8).fill(0), cur = d.disp && d.cursor && !d.cg && d.ac === (r ? 0x40 : 0) + col;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 5; x++) { const lit = (rows[y] >> (4 - x)) & 1 || (cur && y === 7); g.fillStyle = lit ? on : off; g.fillRect(col * 6 + x, r * 9 + y, 1, 1); }
    }
    const st = app.sim.partState(q); st.img = c.toDataURL(); st.bl = bl;
  }
  function renderOleds() {
    if (!app.i2c) return;
    for (const q of app.proj.parts) {
      if (q.type === 'lcd1602') { const d = app.i2c[q.id]; if (d && d.version !== d._drawn) { d._drawn = d.version; renderLcd(q, d); } continue; }
      if (q.type !== 'ssd1306') continue; const d = app.i2c[q.id]; if (!d || d.version === d._drawn) continue;
      d._drawn = d.version; const c = app.oledCanvas || (app.oledCanvas = Object.assign(document.createElement('canvas'), { width: 128, height: 64 }));
      const g = c.getContext('2d'), im = g.createImageData(128, 64);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) { const o = (y * 128 + x) * 4, on = d.lit(x, y); im.data[o] = on ? 120 : 4; im.data[o + 1] = on ? 220 : 8; im.data[o + 2] = on ? 255 : 12; im.data[o + 3] = 255; }
      g.putImageData(im, 0, 0); app.sim.partState(q).img = c.toDataURL();
    }
  }
  // IR: RMT frame -> marks; verify the IR LED really conducts when the RMT pin is high, then deliver to the TV
  function onRmt(m, esp, rt) {
    const segs = [], marks = [];
    for (const h of m.items) { const w = parseInt(h, 16) >>> 0; for (const [d, l] of [[w & 0x7fff, (w >>> 15) & 1], [(w >>> 16) & 0x7fff, (w >>> 31) & 1]]) { if (!d) continue; const us = d * m.tick_ns / 1000; segs.push([l, us]); if (l) marks.push(us); } }
    const code = R.sircDecode(marks), g = rt.rmtPin(m.ch) >= 0 ? rt.rmtPin(m.ch) : 4;
    const pin = rt.pins[g], save = { out: pin.out, level: pin.level, pwm: pin.pwm };
    pin.out = true; pin.level = 1; pin.pwm = undefined; rt.version++; app.sim.settle();
    let iIr = 0; const irs = app.proj.parts.filter((q) => q.type === 'irled');
    for (const q of irs) { const e = app.sim.mains.get(q.id); if (e) iIr = Math.max(iIr, app.sim.circuit.current(e)); }
    Object.assign(pin, save); rt.version++; app.sim.settle();
    const emitted = irs.length > 0 && iIr > 0.005;
    for (const q of irs) app.sim.partState(q).flashUntil = performance.now() + 120;
    const fhz = m.car_en ? 80e6 / (m.car_hi + m.car_lo) : 0;
    app.irFrames.push({ segs, code, fhz, i: iIr, emitted, pin: g, t: performance.now() }); if (app.irFrames.length > 20) app.irFrames.shift();
    const now = performance.now();
    if (code !== null && !(app.lastIr && app.lastIr.code === code && now - app.lastIr.t < 200)) app.world.ir(code, emitted);
    app.lastIr = { code, t: now };
    $('#irInfo').innerHTML = `GPIO${g} · ${segs.length} RMT items · ${code !== null ? `SIRC <b>0x${code.toString(16).padStart(3, '0')}</b> (${R.SIRC_NAME[code] || '?'})` : 'not SIRC'} · carrier ${fhz ? (fhz / 1000).toFixed(1) + ' kHz' : 'off'} · IR LED current when on: <b>${P.fmt(iIr, 'A')}</b> ${emitted ? '✅ emits' : '❌ IR LED does not light — check the driver'}`;
    drawIr(); app.devDirty = true;
  }
  // ---------------- main loop ----------------
  let last = performance.now(), busy = false, frame = 0;
  async function tick() {
    if (!app.proj) { requestAnimationFrame(tick); return; }
    const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now; frame++;
    if (!busy) {
      busy = true;
      try {
        const r = app.run;
        if (r && r.kind === 'js' && r.sketch.running) await r.sketch.runUntil(r.sketch.now + dt, (h) => app.sim.advance(h));
        else app.sim.advance(dt);
        if (r && r.kind === 'qemu') replyInputs(false);
      } catch (e) { console.error(e); }
      busy = false;
    }
    for (const q of app.proj.parts) if (q.type === 'irled') { const st = app.sim.partState(q); if (st.flashUntil > now) st.bright = 1; }
    if (frame % 3 === 0) renderOleds();
    if (app.proj.parts.some((q) => q.type === 'servo')) updateServos(dt);
    if (frame % 6 === 3) renderTfts();
    if (frame % 30 === 0) spiCfg();
    app.editor.refreshDynamic();
    if (frame % 2 === 0) { try { updateWireFlow(); } catch (e) { console.error(e); } }
    if (app.view3d && app.view3d.active && frame % 2 === 0) { try { app.view3d.sync(app.sim, app.sim._wireFlow || {}); } catch (e) { view3dFail(e); } }
    if (app.schematic && app.schematic.active) { try { if (frame % 8 === 0) app.schematic.touch(); app.schematic.sync(); } catch (e) { console.error(e); } }
    if (frame % 6 === 0) updatePanels();
    requestAnimationFrame(tick);
  }
  function updateWireFlow() {
    if (!app.sim || !app.proj) return;
    const flow = app.sim.wireFlow();
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const w of app.proj.wires) {
      const el = app.editor.lWires && app.editor.lWires.querySelector(`[data-wid="${w.id}"]`); if (!el) continue;
      const f = flow[w.id] || { i: 0 }; const mag = Math.abs(f.i || 0);
      if (mag < 1e-6 || reduced) { el.style.setProperty('--wo', '0'); continue; }
      const dur = Math.max(0.25, Math.min(3.2, 0.55 / Math.sqrt(mag * 500 + 0.02)));
      const op = Math.min(0.95, 0.22 + Math.log10(mag * 1e6 + 1) * 0.16);
      el.style.setProperty('--wd', dur + 's');
      el.style.setProperty('--wo', String(op));
      el.style.setProperty('--wdir', f.i >= 0 ? 'normal' : 'reverse');
    }
  }
  function collectWarnings() {
    return ((app.sim && app.sim.warnings) || []).concat((app.editor && app.editor.warnings) || []);
  }
  function renderWarnings() {
    const w = collectWarnings();
    const list = $('#warnList'); if (list) list.innerHTML = w.length ? w.map((x) => `<div class="w">⚠ ${x.id ? '<b>' + x.id + '</b>: ' : ''}${P.esc(x.msg)}</div>`).join('') : 'none';
    const box = $('#warnBox'); if (box) { box.hidden = !w.length; box.innerHTML = w.slice(0, 4).map((x) => `⚠ ${x.id || ''} ${P.esc(x.msg)}`).join('<br>'); }
    if (app.editor) for (const [id, g] of app.editor.partEls) g.classList.toggle('warn', w.some((x) => x.id === id));
  }
  function updatePanels() {
    const r = app.run; $('#stTime').textContent = r ? ` · ${(r.kind === 'js' ? r.sketch.now : (performance.now() - (r.tq || r.t0)) / 1000).toFixed(1)} s` : '';
    renderWarnings();
    if (!document.body.classList.contains('c-side')) updateReadouts();
    if (app.devDirty || frame % 30 === 0) { if ($('#tab-dev').classList.contains('on')) renderDevices(); }
  }
  // ---------------- inspector ----------------
  // The part currently drawn in the Inspector. Delete uses this, not a selection
  // that still names a part from before the last undo.
  let shownPartId = null;
  function renderInspector(sel) {
    const el = $('#insp');
    shownPartId = null;
    if (!sel) { el.innerHTML = '<p class="muted">Select a part or wire.</p>'; return; }
    if (sel.wire) {
      const w = app.proj.wires.find((q) => q.id === sel.wire); if (!w) { el.innerHTML = '<p class="muted">Select a part or wire.</p>'; return; }
      el.innerHTML = `<h3>Wire ${w.id}</h3><div class="insp-k">Colour</div><div class="row wrap">${Object.keys(window.WIRE_COLORS).map((c) => `<button class="sw ${w.color === c ? 'on' : ''}" data-col="${c}" style="background:${window.WIRE_COLORS[c]}" title="${c}"></button>`).join('')}</div><p id="ro" class="ro"></p><div class="row probe-row"><button class="probe-b" data-probe='${JSON.stringify({ kind: 'wire', wire: w.id })}'>⌁ Probe on scope</button><button class="probe-b" data-watch='${JSON.stringify({ kind: 'wire', wire: w.id })}'>📌 Telemetry</button></div><button id="iDel">Delete wire</button>`;
      el.querySelectorAll('[data-col]').forEach((b) => b.onclick = () => { app.editor.setWireColor(b.dataset.col); renderInspector(sel); });
      $('#iDel').onclick = () => app.editor.deleteSel(); return;
    }
    const p = app.editor.part(sel.part); if (!p) { el.innerHTML = '<p class="muted">Select a part or wire.</p>'; return; } shownPartId = p.id; const d = P.T[p.type];
    let h = `<h3>${P.esc(d.label)} <small>${p.id}</small></h3>`;
    for (const e of d.edit || []) {
      const v = p.props[e.k];
      if (e.t === 'sel') h += `<label>${e.label}<select data-k="${e.k}">${e.opts.map((o) => `<option ${String(o) === String(v) ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
      else if (e.t === 'bool') h += `<label><input type="checkbox" data-k="${e.k}" ${v ? 'checked' : ''}> ${e.label}</label>`;
      else if (e.t === 'range') h += `<label>${e.label}<input type="range" data-k="${e.k}" min="${e.log ? Math.log10(e.min) : e.min}" max="${e.log ? Math.log10(e.max) : e.max}" step="${e.log ? 0.01 : e.step}" value="${e.log ? Math.log10(v) : v}" data-log="${e.log ? 1 : ''}"></label>`;
      else h += `<label>${e.label}<input data-k="${e.k}" value="${P.esc(v)}" data-t="${e.t}"></label>`;
    }
    if (p.type === 'esp32') h += `<label>Power<select data-k="power"><option ${p.props.power === 'usb' ? 'selected' : ''}>usb</option><option ${p.props.power !== 'usb' ? 'selected' : ''}>external</option></select></label>`;
    const sch = document.body.classList.contains('viewsch');
    const physical = P.canPhysicalFlip(p);
    let flipBtns;
    if (sch) {
      const tipH = 'Mirror the symbol (drawing only)', tipV = 'Mirror the symbol (drawing only)';
      flipBtns = `<button id="iFlipH" class="${p.schFlipX ? 'on' : ''}" title="${P.esc(tipH)}">↔ Flip H</button><button id="iFlipV" class="${p.schFlipY ? 'on' : ''}" title="${P.esc(tipV)}">↕ Flip V</button>`;
    } else {
      const on = !!(p.flipX || p.flipY);
      const tip = physical ? 'Turn this part end for end (F)' : P.NO_FLIP_TIP;
      flipBtns = `<button id="iFlip" class="${on ? 'on' : ''} ${physical ? '' : 'is-off'}" aria-disabled="${physical ? 'false' : 'true'}" title="${P.esc(tip)}">↔ Flip</button>`;
    }
    h += `<p id="ro" class="ro"></p><div class="row"><button id="iRot">⟳ Rotate</button>${flipBtns}<button id="iDel">🗑 Delete</button></div><div id="pinTable"></div>`;
    el.innerHTML = h;
    el.querySelectorAll('[data-k]').forEach((inp) => {
      const k = inp.dataset.k, ev = inp.type === 'range' ? 'input' : 'change';
      inp.addEventListener(ev, () => {
        let v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.type === 'range') v = inp.dataset.log ? Math.pow(10, +v) : +v; else if (inp.dataset.t === 'num') v = +v;
        if (inp.type !== 'range') app.editor.push(); else beforeEdit();
        p.props[k] = v; app.sim.dirty = true; app.editor.refreshDynamic(); if (inp.type !== 'range') app.editor.render(); autosave();
      });
    });
    $('#iRot').onclick = () => app.editor.rotateSel();
    const wireFlip = (id, axis) => { const b = $('#' + id); if (!b || b.getAttribute('aria-disabled') === 'true') return; app.editor.flipSel(axis); };
    const iFlip = $('#iFlip'); if (iFlip) iFlip.onclick = () => wireFlip('iFlip', 'x');
    const iFlipH = $('#iFlipH'); if (iFlipH) iFlipH.onclick = () => wireFlip('iFlipH', 'x');
    const iFlipV = $('#iFlipV'); if (iFlipV) iFlipV.onclick = () => wireFlip('iFlipV', 'y');
    $('#iDel').onclick = () => app.editor.deleteSel();
    updateReadouts();
  }
  function updateReadouts() {
    const sel = app.editor.sel, ro = $('#ro'); if (!sel || !ro) return;
    // settle() rebuilds the nets but skips measure(), so a flipped LED would
    // keep the previous current until the next animation frame. Measure once.
    if (app.sim && app.sim.needsRebuild && app.sim.needsRebuild()) { try { app.sim.settle(); app.sim._after(0); } catch (e) { /* the last solved readout stays until the next tick */ } }
    if (sel.wire) { const w = app.proj.wires.find((q) => q.id === sel.wire); if (w) { const f = (app.sim._wireFlow || {})[w.id] || { i: 0, v: app.sim.nodeVoltage(app.sim.netAt(w.a.x, w.a.y)) }; ro.textContent = `V ${P.fmt(f.v, 'V')} · I ${P.fmt(f.i, 'A')}`; } return; }
    const p = app.editor.part(sel.part); if (!p) return;
    ro.textContent = app.sim.readout(p) || '';
    const d = P.T[p.type]; if (p.type === 'breadboard') return;
    const rt = p.type === 'esp32' ? app.sim.espRuntime(p) : null;
    $('#pinTable').innerHTML = '<table class="pins">' + d.pins(p).map((q) => {
      const v = app.sim.pinVoltage(p, q.name); let extra = '';
      if (rt) { const g = P.espGpio(q.name); if (g >= 0) { const s = rt.pins[g]; extra = `<td>${s.out ? (s.pwm !== undefined ? 'PWM ' + Math.round(s.pwm * 100) + '%' : 'OUT ' + s.level) : 'IN' + (s.pu ? '↑' : '') + (s.pd ? '↓' : '')}</td><td class="muted">${P.esc(d.info(q.name))}</td>`; } else extra = '<td></td><td></td>'; }
      const pj = P.esc(JSON.stringify({ kind: 'pin', part: p.id, pin: q.name, label: p.id + '.' + q.name }));
      return `<tr><td>${P.esc(q.name)}</td><td>${P.fmt(v, 'V')}</td>${extra}<td class="pacts"><button class="pa" title="Probe on scope" data-probe="${pj}">⌁</button><button class="pa" title="Pin to telemetry strip" data-watch="${pj}">📌</button></td></tr>`;
    }).join('') + '</table>';
  }
  // ---------------- hover tooltip ----------------
  function hover(h) {
    const tip = $('#tip'); if (!h || (!h.pin && !h.part && !h.wire)) { tip.hidden = true; return; }
    let t = '';
    if (h.wire) {
      const flow = (app.sim._wireFlow || app.sim.wireFlow && app.sim.wireFlow() || {})[h.wire.id] || { i: 0, v: app.sim.nodeVoltage(app.sim.netAt(h.wire.a.x, h.wire.a.y)) };
      t = `<b>Wire ${P.esc(h.wire.id)}</b> · ${P.esc(h.wire.color || '')}<br>V <b>${P.fmt(flow.v, 'V')}</b> · I <b>${P.fmt(flow.i, 'A')}</b>`;
    } else if (h.pin) {
      const net = app.sim.netAt(h.pin.pos.x, h.pin.pos.y), v = app.sim.nodeVoltage(net);
      const info = h.part.type === 'esp32' ? P.T.esp32.info(h.pin.pin.name) : '';
      t = `<b>${P.esc(h.label || (h.part.id + '.' + h.pin.pin.name))}</b>${info ? ' · ' + P.esc(info) : ''}<br>${net < 0 ? 'unconnected' : net === 0 ? 'GND (0 V)' : 'node ' + net + ': <b>' + P.fmt(v, 'V') + '</b>'}`;
    } else if (h.part && h.part.type !== 'breadboard') {
      const r = app.sim.readout(h.part); t = `<b>${P.esc(h.part.id)}</b> ${P.esc(P.T[h.part.type].label)}${r ? '<br>' + P.esc(r) : ''}`;
    }
    if (!t) { tip.hidden = true; return; }
    const wr = $('#stageWrap').getBoundingClientRect();
    tip.innerHTML = t; tip.hidden = false; tip.style.left = (h.ev.clientX - wr.left + 14) + 'px'; tip.style.top = (h.ev.clientY - wr.top + 14) + 'px';
  }
  // ---------------- scope ----------------
  const SCOL = ['#ffd84a', '#4ae0ff', '#ff5ad1', '#7dff6a'];
  function drawScope() {
    if (app.scopeFrozen) return;
    const c = $('#scope'), g = c.getContext('2d'), W = c.width, H = c.height, td = +$('#selTdiv').value, vd = +$('#selVdiv').value, span = td * 10, t1 = app.sim.t, t0 = t1 - span;
    g.fillStyle = '#0b0f16'; g.fillRect(0, 0, W, H); g.strokeStyle = '#1f2a3a'; g.lineWidth = 1;
    for (let i = 0; i <= 10; i++) { g.beginPath(); g.moveTo(i * W / 10, 0); g.lineTo(i * W / 10, H); g.stroke(); }
    for (let i = 0; i <= 6; i++) { g.beginPath(); g.moveTo(0, i * H / 6); g.lineTo(W, i * H / 6); g.stroke(); }
    const y = (v) => H - 10 - v / vd * (H / 6);
    let leg = [];
    for (let ch = 1; ch <= 4; ch++) {
      const a = app.sim.scope[ch]; if (!a || !a.length) continue; g.strokeStyle = SCOL[ch - 1]; g.lineWidth = 1.6; g.beginPath(); let started = false, lastv = 0;
      for (const [t, v] of a) { if (t < t0) continue; const x = (t - t0) / span * W; if (!started) { g.moveTo(x, y(v)); started = true; } else g.lineTo(x, y(v)); lastv = v; }
      g.stroke(); leg.push([ch, lastv]);
    }
    g.font = '12px ui-monospace,monospace'; leg.forEach(([ch, v], i) => { g.fillStyle = SCOL[ch - 1]; g.fillText(`CH${ch} ${v.toFixed(3)} V`, 8 + i * 130, 16); });
    g.fillStyle = '#7b8798'; g.fillText(`${td} s/div  ${vd} V/div  t=${t1.toFixed(2)} s`, W - 220, H - 6);
  }
  // ---------------- IR waveform ----------------
  function drawIr() {
    const c = $('#irCanvas'), g = c.getContext('2d'), W = c.width, H = c.height; g.fillStyle = '#0b0f16'; g.fillRect(0, 0, W, H);
    const f = app.irFrames[app.irFrames.length - 1]; if (!f) return;
    const total = f.segs.reduce((s, x) => s + x[1], 0) || 1; let t = 0; g.strokeStyle = f.emitted ? '#b48cff' : '#ff5a5a'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, 70);
    for (const [l, us] of f.segs) { const x0 = t / total * (W - 10) + 5, x1 = (t + us) / total * (W - 10) + 5, yy = l ? 30 : 70; g.lineTo(x0, yy); g.lineTo(x1, yy); if (l) { g.fillStyle = f.emitted ? 'rgba(180,140,255,.25)' : 'rgba(255,90,90,.2)'; g.fillRect(x0, 30, x1 - x0, 40); } t += us; }
    g.stroke();
    // zoom inset: first 300 µs of the header showing the 40 kHz carrier
    if (f.fhz) { const per = 1e6 / f.fhz; g.strokeStyle = '#ffd84a'; g.lineWidth = 1; g.beginPath(); const ox = 5, sc = (W - 10) / 300; let x = 0; g.moveTo(ox, 112); while (x < 300) { g.lineTo(ox + x * sc, 112); g.lineTo(ox + x * sc, 86); g.lineTo(ox + (x + per / 3) * sc, 86); g.lineTo(ox + (x + per / 3) * sc, 112); x += per; } g.stroke(); g.fillStyle = '#ffd84a'; g.font = '11px ui-monospace,monospace'; g.fillText(`carrier zoom: first 300 µs (${(f.fhz / 1000).toFixed(1)} kHz, 1/3 duty)`, W - 300, 100); }
    g.fillStyle = '#c9d4e3'; g.font = '11px ui-monospace,monospace'; g.fillText(`frame ${(total / 1000).toFixed(1)} ms`, 6, 14);
  }
  // ---------------- devices ----------------
  function renderDevices() {
    app.devDirty = false; $('#devView').innerHTML = app.world.render();
    const L = app.world.log.slice(-60).reverse();
    $('#netLog').innerHTML = L.map((e) => `<details class="nl c${e.code}"><summary><span class="pr">${e.proto}</span> ${P.esc(e.summary)}</summary>${e.detail ? `<pre>${P.esc(JSON.stringify(e.detail, null, 1))}</pre>` : ''}</details>`).join('') || '<p class="muted">no traffic yet</p>';
  }
  // ---------------- misc UI ----------------
  function toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
  function buildPalette() {
    const cats = {}; for (const [k, d] of Object.entries(P.T)) (cats[d.cat || 'Misc'] = cats[d.cat || 'Misc'] || []).push([k, d]);
    const thumb = (k, d) => { try { const p = { id: 'T', type: k, x: 0, y: 0, rot: 0, props: JSON.parse(JSON.stringify(d.props || {})) }; const sz = d.size(p); const pins = d.pins(p);
        let x0 = 0, y0 = 0, x1 = sz.w, y1 = sz.h; for (const q of pins) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
        if (k === 'breadboard') { p.props.cols = 20; x1 = 210; y0 = -14; y1 = 208; }
        const pad = 14; return `<svg viewBox="${x0 - pad} ${y0 - pad - 20} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad + 20}" preserveAspectRatio="xMidYMid meet">${d.svg(p, null)}</svg>`; } catch (e) { return ''; } };
    let h = ''; for (const [c, list] of Object.entries(cats)) { h += `<div class="pcat" data-cat="${P.esc(c)}">${c}</div><div class="pgrid" data-cat="${P.esc(c)}">`; for (const [k, d] of list) h += `<div class="pitem" draggable="true" data-type="${k}" data-q="${P.esc((d.label + ' ' + k + ' ' + c + ' ' + (d.keywords || '')).toLowerCase())}" title="${P.esc(d.label)} — drag onto the canvas or click to add">${thumb(k, d)}<span>${P.esc(d.label)}</span></div>`; h += '</div>'; }
    $('#palList').innerHTML = h + '<div class="pal-empty" hidden>No parts match.</div>';
    $('#palList').querySelectorAll('.pcat').forEach((el) => el.onclick = () => { el.classList.toggle('closed'); el.nextElementSibling.classList.toggle('closed'); });
    $('#palSearch').oninput = (e) => { const q = e.target.value.trim().toLowerCase(); let n = 0;
      document.querySelectorAll('.pitem').forEach((it) => { const m = !q || it.dataset.q.includes(q); it.hidden = !m; n += m; });
      document.querySelectorAll('.pgrid').forEach((g) => { const any = [...g.children].some((c) => !c.hidden); g.hidden = !any; g.previousElementSibling.hidden = !any; if (q) g.classList.remove('closed'); });
      document.querySelector('.pal-empty').hidden = n > 0; };
    document.querySelectorAll('.pitem').forEach((el) => {
      el.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/x-part', el.dataset.type));
      el.addEventListener('click', () => app.editor.addPartInView(el.dataset.type));
    });
  }
  function about() {
    $('#aboutBox').innerHTML = `<h3>What is emulated — honestly</h3>
<ul>
<li><b>✅ Stage 1 — real firmware, digital GPIO, UART:</b> your sketch is compiled with <code>arduino-cli</code> (esp32:esp32 3.3.x) and runs in <b>Espressif's QEMU</b> (Xtensa LX6, ROM, flash, FreeRTOS, ESP-IDF timers). A patched GPIO device streams OUT/ENABLE/IO_MUX/RTC pad writes to this page; the page solves the circuit and replies with GPIO_IN in lock-step. UART0 ↔ Serial tab. Verified with the unmodified Blink and Button examples and the unmodified remote firmware.</li>
<li><b>✅ RMT TX (IR):</b> RMT items + carrier are forwarded, decoded (SIRC), drawn, and delivered to the mock TV only if the IR LED actually conducts in the solved circuit.</li>
<li><b>✅ Stage 2 — ADC + LEDC/PWM:</b> the patched QEMU implements the SENS SAR-ADC registers: each conversion asks this page for the solved pin voltage (lock-step), so <code>analogRead()</code> in real firmware returns the circuit's value. A typical chip's eFuse Vref is burned in, so <code>analogReadMilliVolts()</code> follows the pin up to about 3.13 V. LEDC duty, timer and hardware fades are forwarded and applied as average drive (frequency shown in the Inspector). Timers run on deterministic virtual time (icount). <span class="warn">Not modelled: ADC noise, or the per-cycle PWM waveform (the pin sees the average).</span></li>
<li><b>✅ Stage 3 — networking:</b> <code>WiFi.begin()</code> brings up a <b>real esp_netif + lwIP stack</b> on QEMU's OpenCores Ethernet (open_eth) NIC with slirp user networking (DHCP → 10.0.2.15). The genuine Arduino <code>HTTPClient</code>/<code>NetworkClient</code> run over lwIP TCP; <code>*.sim.internal</code> (legacy <code>*.wokwi.internal</code> also accepted) resolves to a slirp guest-forward that the server bridges to the mock Sony/Roku devices here. <span class="warn">The 802.11 radio itself is not emulated (no scan/RSSI/AP); TLS untested.</span> UDP goes through a raw-frame tap to the virtual devices; TCP to private LAN IPs (e.g. 192.168.1.50) is redirected to them. Every packet is shown in the <b>Network</b> tab.</li>
<li><b>✅ I²C devices</b> (QEMU I²C controller → these parts). Each one answers the bus; none of them is a physical die:
<ul>
<li><b>SSD1306 OLED</b> — on/off, contrast, column/page address and flips. The framebuffer the sketch writes is drawn on the module. Not modelled: charge-pump timing.</li>
<li><b>BME280</b> — chip id <code>0x60</code>. A sample decodes to the Inspector temperature, humidity and pressure. Not a real atmosphere.</li>
<li><b>MPU6050</b> — WHO_AM_I <code>0x68</code>. Accel, gyro and temperature follow the Inspector sliders and the full-scale registers. Not modelled: FIFO, DMP, interrupts.</li>
</ul></li>
<li><b>✅ SPI devices</b> (QEMU SPI controller → these parts, chip-select is a GPIO):
<ul>
<li><b>ILI9341 TFT</b> — RGB565 framebuffer, address window, MADCTL rotation and display on/off are drawn on the module. Other init commands are accepted and ignored.</li>
<li><b>MCP3008</b> — 10-bit conversion of each channel against its VDD pin.</li>
<li><b>microSD</b> — SPI SDHC with a FAT16 image that already contains <code>HELLO.TXT</code>. Sector reads and writes stick in that image. Not modelled: the rest of the SD command set, card-detect, or wear. The sketch's own FAT library is what creates or appends files.</li>
</ul></li>
<li>❌ Not modelled: touch, DAC, hall sensor, deep-sleep currents, Bluetooth, the 802.11 radio, analog behaviour of the ESP32 die beyond a 40 Ω driver / 45 kΩ pulls.</li>
</ul>
<h3>Circuit solver</h3><p>Modified nodal analysis with Newton–Raphson (diode/LED Shockley, zener breakdown, Ebers–Moll BJT, square-law MOSFET, LDO), backward-Euler transient for capacitors. LEDs burn out above 2× their rating; supply/GPIO shorts are flagged.</p>
<h3>Shortcuts</h3><p>Ctrl+Enter run · click pin → click pin to wire · R rotate · F flip (two-lead parts, or the schematic symbol) · Shift+F fit · Del/Backspace delete · right-click wire for menu · double-click wire adds a bend · Ctrl+Z / Ctrl+Y undo/redo · Ctrl+S save (examples: makes a copy) · Esc cancel · keys/buttons respond to their labelled keyboard key while running.</p>`;
  }
  function keyPart(k) { const kp = app.proj.parts.find((q) => q.type === 'keypad' && P.T.keypad.keyAt(q, k) >= 0); if (kp) { kp._kidx = P.T.keypad.keyAt(kp, k); return kp; } return app.proj.parts.find((q) => P.T[q.type] && P.T[q.type].interactive && q.props.key && (q.props.key === k || q.props.key.toLowerCase() === String(k).toLowerCase())); }
  const MIN_SCANS = 400, MAX_LATCH_MS = 6000;   // ~400 GPIO updates ≈ 30+ matrix scans ≈ well past the firmware's 30 ms debounce
  function press(p, v, kidx) {
    const st = app.sim.partState(p);
    if (v && p.type === 'keypad' && !p._kpApply) {   // one key at a time: Keypad.h getKey() only reports a key that goes down after the previous one went up
      const k = kidx !== undefined ? kidx : p._kidx;
      if (st.pressed || kpQueued.has(p)) {
        st.queue = (st.queue || []).concat(k);
        if (!kpQueued.has(p)) { kpQueued.add(p); st.pressed = false; st.releasePending = false; latched.delete(p); st.gapAt = app.gpioCount || 0; st.gapT = performance.now(); app.sim.dirty = true; app.editor.refreshDynamic(); invalidateGpio(); }
        return;
      }
      st.kidx = k;
    }
    if (v) { st.pressed = true; st.gpioAtPress = app.run && app.run.kind === 'qemu' ? null : (app.gpioCount || 0); pressedWait.add(st); st.tPress = performance.now(); st.releasePending = false; }
    else if (app.run && app.run.kind === 'qemu' && !directReleaseOk(p, st) && (st.gpioAtPress == null || directButton(p) || (app.gpioCount || 0) - st.gpioAtPress < (p.type === 'keypad' ? KP_SCANS : MIN_SCANS)) && performance.now() - (st.tPress || 0) < MAX_LATCH_MS) { st.releasePending = true; latched.add(p); return; }
    else { st.pressed = false; st.releasePending = false; latched.delete(p); }
    app.sim.dirty = true; app.editor.refreshDynamic(); invalidateGpio();
  }
  // A switch with one side on GND or the ESP32's 3V3 is read directly (digitalRead), not scanned through a matrix: once the
  // page has pushed the press (invack) and it has been held for DIRECT_MIN_MS, release it when the user does, instead of
  // latching until MIN_SCANS GPIO writes (sketches that only poll an input write almost no GPIOs, so taps stuck for 6 s).
  const DIRECT_MIN_MS = 60;
  function directButton(p) {
    const S = app.sim, esp = espPart(); if (!esp) return false;
    const rail = new Set([S.pinNet.get(esp.id + ':3V3'), 0]);
    return P.T[p.type].pins(p).some((q) => rail.has(S.pinNet.get(p.id + ':' + q.name)));
  }
  // ...and while the firmware is in a burst of pin-reconfiguration exchanges (a DHT read toggles the pull-up 40x) it is not polling the
  // button, so the 60 ms only count from the end of the burst (capped at DIRECT_MAX_MS so a busy sketch still releases).
  const DIRECT_MAX_MS = 1500;
  function directReleaseOk(p, st) {
    if (st.gpioAtPress == null || !directButton(p)) return false;
    const now = performance.now(), t0 = st.tPress || 0;
    return now - t0 >= DIRECT_MAX_MS || (now - t0 >= DIRECT_MIN_MS && now - Math.max(t0, app.lastLockstep || 0) >= DIRECT_MIN_MS);
  }
  function invalidateGpio() { if (app.run && app.run.kind === 'qemu') { app.sim.settle(); sendRun({ t: 'inv' }); } }
  const latched = new Set(), pressedWait = new Set(), kpQueued = new Set();
  const KP_SCANS = 120, KP_GAP = 60;
  // the server echoes 'invack' once it has dropped cached GPIO answers; only GPIO traffic after that point saw the new key state
  function onInvAck() { for (const st of pressedWait) if (st.gpioAtPress == null) st.gpioAtPress = app.gpioCount || 0; pressedWait.clear(); }
  function latchTick() {   // release taps once the firmware has had time to see them
    for (const p of [...kpQueued]) { const st = app.sim.partState(p);
      if (!app.run || !(st.queue || []).length) { kpQueued.delete(p); st.queue = []; continue; }
      if (st.pressed) continue;
      if (st.gapAt === Infinity) { st.gapAt = app.gpioCount || 0; st.gapT = performance.now(); continue; }   // just released: give the scan a gap
      if ((app.gpioCount || 0) - st.gapAt >= KP_GAP || performance.now() - st.gapT > 1500) {
        const k = st.queue.shift(); p._kpApply = true; st.kidx = k; press(p, true, k); press(p, false); p._kpApply = false; st.gapAt = Infinity;
        if (!st.queue.length) kpQueued.delete(p);
      } }
    for (const p of [...latched]) { const st = app.sim.partState(p); if (!st.releasePending) { latched.delete(p); continue; }
      if (!app.run || directReleaseOk(p, st) || (st.gpioAtPress != null && !directButton(p) && (app.gpioCount || 0) - st.gpioAtPress >= (p.type === 'keypad' ? KP_SCANS : MIN_SCANS)) || performance.now() - st.tPress >= MAX_LATCH_MS) press(p, false); }
  }
  setInterval(latchTick, 20);
  function init() {
    app.editor = new Editor($('#stage'), {
      changed: (topo) => {
        if (window.Netlist && app.proj) { try { Netlist.syncFromWires(app.proj); } catch (e) { /* the wires stay; the next load rebuilds the netlist */ } }
        if (topo) app.sim.topoDirty = true; app.sim.dirty = true; invalidateGpio(); autosave(); if (app.schematic) app.schematic.invalidate();
        if (window.Bom) Bom.sync(document.getElementById('bomView'), app.proj);
      }, beforeEdit,
      netKey: (x, y) => { app.sim.netAt(x, y); return app.sim.uf.find(Math.round(x) + ',' + Math.round(y)); },
      selected: (s) => { renderInspector(s); if (s) { /* keep current tab */ } },
      shownPart: () => shownPartId,
      warnings: () => renderWarnings(),
      hover, state: (p) => app.sim ? app.sim.partState(p) : null, running: () => !!app.run || !espPart(), press,
    });
    buildPalette(); about();
    { const grp = {}; for (const [k, n, c] of Examples.LIST) (grp[c || 'ESP32 projects'] = grp[c || 'ESP32 projects'] || []).push(`<option value="${k}">${n}</option>`);
      $('#selExample').innerHTML = '<option value="">Examples…</option>' + Object.entries(grp).map(([c, o]) => `<optgroup label="${P.esc(c)}">${o.join('')}</optgroup>`).join(''); }
    $('#selExample').onchange = (e) => { if (e.target.value) loadExample(e.target.value); e.target.value = ''; };
    $('#selWireColor').innerHTML = ['auto', ...Object.keys(window.WIRE_COLORS)].map((c) => `<option>${c}</option>`).join(''); $('#selWireColor').onchange = (e) => app.editor.setWireColor(e.target.value);
    $('#bRun').onclick = startRun; $('#bStop').onclick = stopRun; $('#bReset').onclick = () => { app.sim.resetState(); app.editor.render(); };
    $('#bUndo').onclick = () => app.editor.undo(); $('#bRedo').onclick = () => app.editor.redo(); $('#bRot').onclick = () => app.editor.rotateSel(); $('#bDel').onclick = () => app.editor.deleteSel();
    $('#bSave').onclick = save; $('#bDownload').onclick = download; $('#fileIn').onchange = (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; }; $('#bFit').onclick = () => { if (viewMode === '3d' && app.view3d && app.view3d.fit) app.view3d.fit(); else if (viewMode === 'schematic' && app.schematic) app.schematic.fit(); else app.editor.fit(); };
    $('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab)); if (b.dataset.tab === 'dev') { renderDevices(); drawIr(); } if (b.dataset.tab === 'net') { app.netlog.dirty = true; app.netlog.render(); } };
    $('#selMode').onchange = (e) => { beforeEdit(); app.proj.mode = e.target.value; autosave(); modeNote(); renderFileTabs(); };
    $('#fileTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; syncCode(); if (b.dataset.f === '+') { const n = prompt('File name (e.g. config.h)'); if (!n || !/^[\w.-]+\.(h|hpp|c|cpp|ino)$/.test(n)) return; beforeEdit(); app.proj.files[n] = ''; autosave(); app.file = n; } else app.file = b.dataset.f; renderFileTabs(); loadCode(); };
    $('#code').addEventListener('beforeinput', beforeEdit); $('#inDefines').addEventListener('beforeinput', beforeEdit);
    $('#code').addEventListener('input', () => { syncCode(); autosave(); }); $('#inDefines').addEventListener('input', () => { syncDefines(); autosave(); });
    $('#bProjects').onclick = projectsDialog;
    $('#bRestart').onclick = () => { stopRun(); startRun(); };
    $('#cbFlow').checked = localStorage.getItem('esp32lab.flow') !== '0'; $('#stage').classList.toggle('flow', $('#cbFlow').checked);
    $('#cbFlow').onchange = (e) => { $('#stage').classList.toggle('flow', e.target.checked); localStorage.setItem('esp32lab.flow', e.target.checked ? '1' : '0'); };
    if (window.Schematic) {
      app.schematic = new Schematic.SchematicView($('#stageWrap'), {
        select: (id) => app.editor.select(id ? { part: id } : null),
        state: (p) => (app.sim ? app.sim.partState(p) : null),
        voltage: (p, name) => app.sim.pinVoltage(p, name),
        readout: (p) => app.sim.readout(p),
      });
      if (app.proj) app.schematic.setProject(app.proj);
    }
    setupViewToggle();
    app.cmd = { run: startRun, stop: stopRun, restart: () => { stopRun(); startRun(); }, save, projects: projectsDialog, loadExample, makeCopy: () => makeCopy(false), toast, download, view3d: () => setViewMode('3d'), view2d: () => setViewMode('2d'), viewSch: () => setViewMode('schematic') };
    $('#cbOrtho').checked = localStorage.getItem('esp32lab.ortho') !== '0'; app.editor.ortho = $('#cbOrtho').checked; $('#cbOrtho').onchange = (e) => { app.editor.ortho = e.target.checked; localStorage.setItem('esp32lab.ortho', e.target.checked ? '1' : '0'); };
    app.editor.setHint();
    $('#code').addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); syncCode(); } });
    $('#serialIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { sendRun({ t: 'uart', d: e.target.value + '\n' }); serialAppend('» ' + e.target.value + '\n'); e.target.value = ''; } });
    $('#bSerialClr').onclick = serialClear; serialClear();
    $('#cbSerTs').onchange = serialRender; $('#cbFollow').onchange = serialRender;
    $('#bSerialCopy').onclick = async () => { try { await navigator.clipboard.writeText(app.serialText); toast('Serial output copied'); } catch (e) { toast('Copy failed', true); } };
    $('#serial').addEventListener('wheel', (e) => { if (e.deltaY < 0 && $('#cbFollow').checked) { $('#cbFollow').checked = false; } }, { passive: true });
    app.netlog.el = $('#netPanel'); app.netlog.dirty = true; app.netlog.render(); setInterval(() => { if ($('#tab-net').classList.contains('on')) app.netlog.render(); }, 250);
    $('#netFilter').oninput = (e) => { app.netlog.filter = e.target.value; app.netlog.dirty = true; app.netlog.render(); };
    $('#bNetClr').onclick = () => app.netlog.clear();
    $('#bNetCopy').onclick = async () => { const t = app.netlog.text(); try { await navigator.clipboard.writeText(t); toast('Network log copied (' + t.split('\n').length + ' lines)'); } catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Network log copied'); } };
    if (window.Instruments) { Instruments.mount($('#tab-scope'), { app, toast }); Instruments.renderStrip(true); }
    $('#insp').addEventListener('click', (e) => {   // Inspector → probe / pin-to-telemetry buttons
      const b = e.target.closest('[data-probe],[data-watch]'); if (!b || !window.Instruments) return; const pr = JSON.parse(b.dataset.probe || b.dataset.watch);
      if (b.dataset.watch) Instruments.watchProbe(pr); else { Instruments.probe(pr); if (document.body.classList.contains('m') && window.Mobile) Mobile.setSheet('scope'); else { const t = document.querySelector('#tabs [data-tab=scope]'); if (t && !t.classList.contains('on')) t.click(); } }
    });
    $('#inPsk').onchange = (e) => { app.world.tv.psk = e.target.value; app.devDirty = true; };
    $('#cbStandby').onchange = (e) => { app.world.tv.networkStandby = e.target.checked; app.devDirty = true; };
    $('#cbWifi').onchange = (e) => { app.world.wifiUp = e.target.checked; };
    $('#bTvPower').onclick = () => { const tv = app.world.tv; tv.power = tv.power === 'on' ? 'off' : 'on'; app.devDirty = true; renderDevices(); };
    $('#cbDiodes').onchange = (e) => { for (const q of app.proj.parts) if (q.type === 'diode') q.props.bypass = !e.target.checked; app.sim.dirty = true; app.editor.render(); toast(e.target.checked ? 'Diodes fitted' : 'Diodes replaced by wires — press 3 keys forming a rectangle corner to see a ghost key'); };
    const typing = (e) => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); startRun(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); return; }
      // Value fields keep native text undo. Delete moves focus back to the canvas first, so Ctrl+Z still undoes that delete.
      if (typing(e)) return;
      const chord = Editor.editChord(e);
      if (chord === 'undo') { e.preventDefault(); app.editor.undo(); return; }
      if (chord === 'redo') { e.preventDefault(); app.editor.redo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const kp = app.run ? keyPart(e.key) : null; if (kp) { e.preventDefault(); if (!e.repeat) press(kp, true); return; }   // labelled keys only act as buttons while running
      if (e.key === 'Escape') { app.editor.cancelWire(); app.editor.select(null); if (app.schematic) app.schematic.select(null); }
      else if (viewMode === 'schematic' && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'r' || e.key === 'R')) { if (e.key === 'Delete' || e.key === 'Backspace') e.preventDefault(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); app.editor.deleteSel(); }
      else if (e.key === 'r' || e.key === 'R') app.editor.rotateSel();
      else if (e.key === 'f' || e.key === 'F') {
        if (e.shiftKey) { if (viewMode === 'schematic' && app.schematic) app.schematic.fit(); else app.editor.fit(); }
        else app.editor.flipSel('x');
      }
    });
    window.addEventListener('keyup', (e) => { if (typing(e)) return; const kp = keyPart(e.key); if (kp && app.sim.partState(kp).pressed) press(kp, false); });
    // start-up: ?p=<project> > ?ex=<example, read-only> > last open project > legacy single-slot save > Blink example
    const sp = new URLSearchParams(location.search), q = sp.get('ex'), pid = sp.get('p'), saved = localStorage.getItem(STORE);
    if (saved && !store.list().length) { try { const o = JSON.parse(saved); if (!o.example) { o.name = o.name || 'My saved project'; store.importJson(o); } } catch (e) { /* ignore */ } localStorage.removeItem(STORE); }
    if (pid && store.get(pid)) openProject(pid);
    else if (q && Examples.EX[q]) loadExample(q);
    else if (store.current() && store.get(store.current())) openProject(store.current());
    else loadExample('blink');
    fetch('api/health').then((r) => r.json()).then((h) => { app.health = h; $('#connDot').className = 'conn ' + (h.ok ? 'ok' : 'bad'); $('#connDot').title = h.ok ? 'Backend connected: arduino-cli + QEMU ready' : 'Backend missing QEMU/arduino-cli'; if (!h.ok) toast('Backend found but QEMU/arduino-cli missing — JS sketch mode only', true); }).catch(() => { $('#connDot').className = 'conn bad'; toast('No backend: real-firmware mode needs server/server.py (JS sketch mode still works)', true); });
    requestAnimationFrame(tick); if (window.UI) window.UI.init(app);
    if (new URLSearchParams(location.search).get('resume') !== '0') setTimeout(() => app.resumeSavedRun(), 300);
    if (new URLSearchParams(location.search).get('tab')) document.querySelector(`[data-tab=${new URLSearchParams(location.search).get('tab')}]`).click();
  }

  // ---------------- 2D / 3D view ----------------
  let viewMode = '2d', view3dLoading = null, knob3d = null;
  const VIEW3D_SRC = 'js/view3d.js?v=56';
  const THREE_SRC = 'vendor/three.min.js?v=2';
  function loadScriptOnce(src) {
    return new Promise((res, rej) => {
      let abs = src;
      try { abs = new URL(src, document.baseURI).href; } catch (_) {}
      const existing = [...document.scripts].find((s) => s.src === abs);
      if (existing) {
        if (existing.dataset.loaded === '1') return res();
        existing.addEventListener('load', () => res(), { once: true });
        existing.addEventListener('error', () => rej(new Error('failed to load ' + src)), { once: true });
        return;
      }
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => { s.dataset.loaded = '1'; res(); };
      s.onerror = () => rej(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  // Start view3d.js and three.min.js together. The click path used to wait for
  // view3d.js to parse before it even requested three.js. Real script tags, not
  // <link rel=preload>: a cache-disabled load still shares the in-flight request.
  function preload3dScripts() {
    loadScriptOnce(VIEW3D_SRC).catch((e) => console.warn(e));
    loadScriptOnce(THREE_SRC).catch((e) => console.warn(e));
  }
  async function prefetch3dScripts() {
    if (window.__3dPrefetching || window.__3dPrefetchDone) return;
    window.__3dPrefetching = true;
    try {
      await Promise.all([loadScriptOnce(VIEW3D_SRC), loadScriptOnce(THREE_SRC)]);
      window.__3dPrefetchDone = true;
    } catch (e) { console.warn('3D prefetch failed', e); }
    finally { window.__3dPrefetching = false; }
  }
  function schedule3dPrefetch() {
    if (no3dDevice()) return;
    let q = '';
    try { q = location.search || ''; } catch (_) {}
    if (/[?&]noprefetch=1\b/.test(q)) return;
    const run = () => { prefetch3dScripts(); };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 500);
  }
  async function ensureView3d() {
    if (app.view3d) return app.view3d;
    if (view3dLoading) return view3dLoading;
    view3dLoading = (async () => {
      if (!window.loadView3D) await loadScriptOnce(VIEW3D_SRC);
      const v = await window.loadView3D($('#stageWrap'), {
        onWire: (id, f, ev) => {
          const w = app.proj.wires.find((q) => q.id === id); if (!w) return;
          app.editor.select({ wire: id });
          hover({ wire: w, ev });
        },
        onPart: (id) => { app.editor.select({ part: id }); },
        // 3D part interaction mirrors the 2D editor: buttons press while running, click-parts toggle, pots turn by drag
        onPartDown: (id) => {
          const p = app.proj.parts.find((q) => q.id === id); if (!p) return false;
          const d = P.T[p.type] || {}, H = app.editor.hooks;
          if (d.wheel) { app.editor.select({ part: id }); knob3d = { p, pos0: +p.props.pos || 0 }; return 'knob'; }
          if (H.running() && d.interactive && !d.keyAt) { H.press(p, true); return 'press'; }
          if (H.running() && d.click) { if (d.click(p)) { app.editor.render(); H.changed(false); } return 'click'; }
          return false;
        },
        onPartMove: (id, kind, dx, dy) => {
          if (kind !== 'knob' || !knob3d) return;
          knob3d.p.props.pos = Math.min(1, Math.max(0, knob3d.pos0 + (dx - dy) / 150));
          app.editor.hooks.changed(false); app.editor.refreshDynamic(); app.editor.hooks.selected(app.editor.sel);
        },
        onPartUp: (id, kind) => {
          const p = app.proj.parts.find((q) => q.id === id);
          if (kind === 'press' && p) app.editor.hooks.press(p, false);
          if (kind === 'knob') knob3d = null;
        },
        onFail: (e) => view3dFail(e),
      });
      app.view3d = v; if (app.proj) v.setProject(app.proj); return v;
    })();
    try { return await view3dLoading; } finally { view3dLoading = null; }
  }
  // 3D is opt-in per session-safe rules: the 3D preference is only persisted after a frame actually
  // rendered, any WebGL/runtime failure drops back to 2D with a toast, and a 2D exit (toolbar, Exit 3D
  // button, Esc) is always reachable because those controls sit above the 3D canvas.
  let viewSeq = 0;
  const LSV = 'esp32lab.view';
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  function show3dLoad(on) {
    const el = $('#view3dLoad');
    if (el) { el.hidden = !on; el.setAttribute('aria-busy', on ? 'true' : 'false'); }
    document.body.classList.toggle('view3d-busy', !!on);
  }
  function paintFrame() { return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); }
  function applyViewChrome() {
    document.body.classList.toggle('view3d', viewMode === '3d');
    document.body.classList.toggle('viewsch', viewMode === 'schematic');
    const b2 = $('#bView2d'), b3 = $('#bView3d'), bs = $('#bViewSch');
    if (b2) b2.classList.toggle('on', viewMode === '2d');
    if (bs) bs.classList.toggle('on', viewMode === 'schematic');
    if (b3) b3.classList.toggle('on', viewMode === '3d');
    const f2 = $('#bForce2d');
    if (f2 && window.ViewChrome) {
      const c = ViewChrome.viewChipState(viewMode, { compact: (window.innerWidth || 0) <= 820 });
      f2.textContent = c.text; f2.title = c.title; f2.setAttribute('aria-label', c.aria);
      f2.dataset.view = viewMode;
    }
  }
  function view3dFail(e) {
    console.error('3D view failed', e);
    lsSet(LSV, '2d');
    if (viewMode !== '3d') { if (app.view3d) try { app.view3d.setActive(false); } catch (_) {} return; }
    viewMode = '2d'; viewSeq++;
    try { if (app.view3d) app.view3d.setActive(false); } catch (_) {}
    show3dLoad(false);
    applyViewChrome();
    toast(e && e.camera ? '3D camera failed — back to 2D' : '3D view unavailable (' + ((e && e.message) || 'WebGL error') + ') — back to 2D', true);
  }
  // Touch-first phones stay on the 2D hotfix. A resized desktop window (phone width, fine pointer) keeps 3D.
  function no3dDevice() {
    const mm = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
    const touchUA = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
    const env = { coarse: mm('(pointer: coarse)'), fine: mm('(any-pointer: fine)'), touchUA: touchUA };
    if (window.ViewChrome) return ViewChrome.blocks3d(env);
    return !!(touchUA || (env.coarse && !env.fine));
  }
  function applyNo3d() {
    const off = no3dDevice();
    document.body.classList.toggle('no3d', off);
    if (off && viewMode === '3d') setViewMode('2d');
    return off;
  }
  function leaveSchematic() {
    try { if (app.schematic) app.schematic.setActive(false); } catch (e) { console.error(e); }
  }
  async function setViewMode(mode, quiet) {
    if (mode === '3d' && applyNo3d()) { mode = '2d'; if (!quiet) toast('3D view is desktop-only for now — staying in 2D'); }
    if (mode === 'schematic' && !app.schematic) mode = '2d';
    const seq = ++viewSeq;
    viewMode = mode === '3d' ? '3d' : mode === 'schematic' ? 'schematic' : '2d';
    applyViewChrome();
    try { if (app.editor) { if (app.editor.hooks.selected) app.editor.hooks.selected(app.editor.sel); else renderInspector(app.editor.sel); app.editor.setHint(); } } catch (_) {}
    if (viewMode !== '3d') {
      show3dLoad(false);
      try { if (app.view3d) app.view3d.setActive(false); } catch (e) { console.error(e); }
    }
    if (viewMode === '2d') {
      try { localStorage.removeItem(LSV); } catch (_) {}
      leaveSchematic();
      try { app.editor && app.editor.render && app.editor.render(); } catch (_) {}
      const z = $('#zoomPct'); if (z && app.editor) z.textContent = Math.round(app.editor.view.s * 100) + '%';
      return;
    }
    if (viewMode === 'schematic') {
      try { localStorage.removeItem(LSV); } catch (_) {}
      app.schematic.setProject(app.proj);
      app.schematic.setActive(true);
      if (!quiet) toast('Schematic — view only · select a part to inspect · pan and zoom · edit in 2D');
      return;
    }
    leaveSchematic();
    show3dLoad(true);
    preload3dScripts();
    try {
      await paintFrame(); // spinner paints while the preloads are already in flight
      if (seq !== viewSeq || viewMode !== '3d') return;
      const v = await ensureView3d();
      if (seq !== viewSeq || viewMode !== '3d') return;       // user went back to 2D while loading
      v.setActive(true);
      let flow = {}; try { flow = (app.sim && (app.sim._wireFlow || app.sim.wireFlow())) || {}; } catch (_) {}
      v.sync(app.sim, flow);
      const ok = await v.healthCheck();
      if (seq !== viewSeq || viewMode !== '3d') return;
      if (!ok.ok) { const er = new Error(ok.why || 'blank frame'); er.camera = !!ok.camera; throw er; }
      show3dLoad(false);
      if (!quiet) toast('3D view — drag orbit · pinch/wheel zoom · Esc or Back to 2D to exit');
    } catch (e) { if (seq === viewSeq) view3dFail(e); show3dLoad(false); }
  }
  function setupViewToggle() {
    const b2 = $('#bView2d'), b3 = $('#bView3d'), bs = $('#bViewSch'); if (!b2 || !b3) return;
    b2.onclick = () => setViewMode('2d'); b3.onclick = () => setViewMode('3d');
    if (bs) bs.onclick = () => setViewMode('schematic');
    const ex = $('#bExit3d'); if (ex) ex.onclick = () => setViewMode('2d');
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && viewMode === '3d' && !document.querySelector('#newBlankDlg:not([hidden])')) { e.preventDefault(); setViewMode('2d'); } }, true);
    // HOTFIX: always boot in 2D and drop any saved 3D preference.
    try { localStorage.removeItem(LSV); } catch (_) {}
    const f2 = $('#bForce2d'); if (f2) f2.onclick = () => { if (viewMode === '2d') return; setViewMode('2d'); toast('2D editor'); };
    applyNo3d();
    applyViewChrome();
    schedule3dPrefetch();
    window.addEventListener('resize', () => { applyNo3d(); applyViewChrome(); });
    window.addEventListener('orientationchange', () => setTimeout(applyNo3d, 300));
  }

  window.addEventListener('DOMContentLoaded', init);
})();

;(function(){const b=document.querySelector('#tabs [data-tab=bom]');if(b)b.addEventListener('click',()=>{try{if(window.Bom&&window.app&&app.proj)Bom.render(document.getElementById('bomView'),app.proj)}catch(e){}});})();
