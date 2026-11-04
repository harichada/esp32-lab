/* Mock network devices for the Wi-Fi/IR remote example: Sony Bravia (IRCC-IP + JSON-RPC, PSK, network standby,
 * IR receiver), Roku (ECP), Eco Plug (legacy UDP + KAB fixed-body). They answer the real firmware's requests that
 * the QemuNet shim frames on UART0 as "@NET {json}". Pure logic + an HTML renderer (browser only). */
(function (root) {
  const R = root.RemoteLogic || (typeof require !== 'undefined' ? require('./remote_logic.js') : null);
  const TILES = ['YouTube', 'Netflix', 'Prime Video', 'Live TV', 'Music', 'Photos', 'Settings', 'Apps', 'Disney+', 'Spotify', 'Browser', 'Inputs'];
  const ROKU_TILES = ['Home', 'Netflix', 'Hulu', 'YouTube', 'Pluto TV', 'Max', 'Apple TV', 'Search'];
  const INPUTS = ['HDMI 1', 'HDMI 2', 'HDMI 3 (Roku)', 'TV'];
  const hexToBytes = (h) => { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };

  class MockWorld {
    constructor() {
      this.tv = { power: 'off', networkStandby: true, psk: '0000', volume: 12, muted: false, input: 2, screen: 'live', cur: 0, app: null, osd: '', lastIR: null };
      this.roku = { screen: 'home', cur: 0, app: null };
      this.eco = { on: false, last: '' };
      this.log = [];       // {t, dir, proto, summary, detail}
      this.wifiUp = true;
      this.onchange = null;
    }
    _log(proto, summary, detail, code) { const e = { t: Date.now(), proto, summary, detail, code }; this.log.push(e); if (this.onlog) try { this.onlog(e); } catch (x) { /* ignore */ } if (this.log.length > 300) this.log.shift(); this.onchange && this.onchange(); }
    _osd(s) { this.tv.osd = s; this.tv.osdT = Date.now(); }
    isSony(u) { return /\/sony\//.test(u.pathname); }
    // -> {code, body}
    http(j) {
      let u; try { u = new URL(j.url); } catch (e) { return { code: -1 }; }
      if (!this.wifiUp) { this._log('HTTP', `${j.method} ${j.url} → no Wi-Fi`, j, -1); return { code: -1 }; }
      if (this.isSony(u)) return this._sony(j, u);
      if (u.port === '8060' || /\/keypress\//.test(u.pathname)) return this._roku(j, u);
      this._log('HTTP', `${j.method} ${j.url} → no host`, j, -1); return { code: -1 };
    }
    _sony(j, u) {
      const tv = this.tv, h = Object.fromEntries(Object.entries(j.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      if (tv.power === 'off' && !tv.networkStandby) { this._log('HTTP', `${j.method} ${u.pathname} → TV fully off (Wi-Fi asleep) — no answer`, j, -1); return { code: -1 }; }
      if ((h['x-auth-psk'] || '') !== tv.psk) { this._log('HTTP', `${j.method} ${u.pathname} → 403 (PSK "${h['x-auth-psk'] || ''}" ≠ "${tv.psk}")`, j, 403); return { code: 403, body: '{"error":[403,"Forbidden"]}' }; }
      if (u.pathname === '/sony/system') {
        let body; try { body = JSON.parse(j.body); } catch (e) { return { code: 400 }; }
        if (body.method === 'setPowerStatus') {
          const on = !!(body.params && body.params[0] && body.params[0].status);
          tv.power = on ? 'on' : 'off'; this._osd(on ? 'Power on (network)' : 'Standby');
          this._log('HTTP', `JSON-RPC setPowerStatus(${on}) → 200`, j, 200);
          return { code: 200, body: '{"result":[],"id":55}' };
        }
        this._log('HTTP', `JSON-RPC ${body.method} → 200`, j, 200); return { code: 200, body: '{"result":[]}' };
      }
      if (u.pathname === '/sony/IRCC') {
        const m = /<IRCCCode>([^<]+)<\/IRCCCode>/.exec(j.body || ''); const code = m && m[1], name = R.IRCC_NAME[code] || code;
        if (!/X_SendIRCC/.test(h.soapaction || '')) { this._log('HTTP', 'IRCC without SOAPACTION → 500', j, 500); return { code: 500 }; }
        if (tv.power !== 'on') { this._log('HTTP', `IRCC ${name} while in standby → 200 (ignored)`, j, 200); return { code: 200 }; }
        this._ircc(name);
        this._log('HTTP', `IRCC ${name} (${code}) → 200`, j, 200);
        return { code: 200 };
      }
      if (u.pathname === '/sony/appControl') {
        this._log('HTTP', 'appControl → 200', j, 200); try { const b = JSON.parse(j.body); if (b.method === 'setTextForm') this._osd('Text: ' + (b.params[0].text || b.params[0])); } catch (e) {}
        return { code: 200, body: '{"result":[]}' };
      }
      this._log('HTTP', `${u.pathname} → 404`, j, 404); return { code: 404 };
    }
    _ircc(name) {
      const tv = this.tv;
      switch (name) {
        case 'Vol+': tv.volume = Math.min(100, tv.volume + 1); tv.muted = false; this._osd('Volume ' + tv.volume); break;
        case 'Vol-': tv.volume = Math.max(0, tv.volume - 1); this._osd('Volume ' + tv.volume); break;
        case 'Mute': tv.muted = !tv.muted; this._osd(tv.muted ? 'Muted' : 'Volume ' + tv.volume); break;
        case 'Input': tv.input = (tv.input + 1) % INPUTS.length; tv.screen = 'live'; tv.app = null; this._osd('Input: ' + INPUTS[tv.input]); break;
        case 'Home': tv.screen = 'home'; break;
        case 'Back': if (tv.app) tv.app = null; else tv.screen = 'live'; break;
        case 'Up': if (tv.screen === 'home') tv.cur = (tv.cur + 8) % 12; break;
        case 'Down': if (tv.screen === 'home') tv.cur = (tv.cur + 4) % 12; break;
        case 'Left': if (tv.screen === 'home') tv.cur = (tv.cur + 11) % 12; break;
        case 'Right': if (tv.screen === 'home') tv.cur = (tv.cur + 1) % 12; break;
        case 'OK': if (tv.screen === 'home') { tv.app = TILES[tv.cur]; if (tv.app === 'Inputs') { tv.input = 2; tv.app = null; tv.screen = 'live'; } } break;
      }
    }
    _roku(j, u) {
      const key = u.pathname.split('/').pop(), r = this.roku;
      const tvShowsRoku = this.tv.power === 'on' && this.tv.input === 2 && this.tv.screen === 'live' && !this.tv.app;
      switch (key) {
        case 'Home': r.screen = 'home'; r.app = null; break;
        case 'Back': if (r.app) r.app = null; break;
        case 'Select': if (!r.app) r.app = ROKU_TILES[r.cur]; break;
        case 'Up': if (!r.app) r.cur = (r.cur + 4) % 8; break;
        case 'Down': if (!r.app) r.cur = (r.cur + 4) % 8; break;
        case 'Left': if (!r.app) r.cur = (r.cur + 7) % 8; break;
        case 'Right': if (!r.app) r.cur = (r.cur + 1) % 8; break;
      }
      this._log('HTTP', `Roku ECP keypress/${key} → 200` + (tvShowsRoku ? '' : ' (TV not on HDMI 3)'), j, 200);
      return { code: 200 };
    }
    // UDP: returns array of reply datagrams [{ip, sport, dport, hex}]
    udp(j) {
      const b = hexToBytes(j.hex || '');
      if (j.dport === 80 && b.length >= 128 && (b[0] === 0x16 || b[0] === 0x17)) {
        const id = String.fromCharCode(...b.slice(16, 48)).replace(/\0.*$/, '');
        if (b[0] === 0x16 && b.length >= 130) this.eco.on = !!b[129];
        const reply = new Uint8Array(130); reply.set(b.slice(0, 128)); reply[128] = 1; reply[129] = this.eco.on ? 1 : 0;
        this.eco.last = `legacy ${b[0] === 0x16 ? 'write' : 'query'} id=${id} xid=${(b[6] | b[7] << 8).toString(16)}`;
        this._log('UDP', `Eco legacy ${b[0] === 0x16 ? 'SET ' + (this.eco.on ? 'ON' : 'OFF') : 'query'} → reply`, j, 200);
        return [{ ip: j.dst, sport: 80, dport: j.sport, hex: R.hex(reply) }];
      }
      if ((j.dport === 1022 || j.dport === 9090) && b.length === 152 && b[76] === 0x6a) {
        const on = !!b[80]; this.eco.on = on; this.eco.last = `KAB set ${on ? 'ON' : 'OFF'} (fixed body, txid ${R.hex(b.slice(0, 2))})`;
        this._log('UDP', `Eco KAB SET ${on ? 'ON' : 'OFF'} (152 B, opcode 0x6A)`, j, 200);
        return [{ ip: j.dst, sport: 1022, dport: j.sport, hex: R.hex(b.slice(0, 32)) }];
      }
      if (j.dport === 25 || j.dport === 5888) { this._log('UDP', `Eco discovery broadcast :${j.dport}`, j, 0); return []; }
      if (j.dport === 9 && b.length === 102) { this._log('UDP', 'Wake-on-LAN magic packet', j, 0); if (this.tv.power === 'off' && this.tv.networkStandby) { this.tv.power = 'on'; this._osd('Power on (WoL)'); } return []; }
      this._log('UDP', `${j.dst}:${j.dport} ${b.length} B (no listener)`, j, 0); return [];
    }
    // IR: decoded SIRC code arriving at the TV's IR receiver (only if the IR LED actually emitted)
    ir(code, emitted = true) {
      const n = R.SIRC_NAME[code] || ('0x' + code.toString(16));
      this.tv.lastIR = { code, name: n, t: Date.now(), emitted };
      if (!emitted) { this._log('IR', `SIRC 0x${code.toString(16)} (${n}) — IR LED did not light (check driver circuit)`, null, 0); return; }
      const tv = this.tv;
      if (code === R.SIRC.POWER_ON) { tv.power = 'on'; this._osd('Power on (IR)'); }
      else if (code === R.SIRC.POWER_OFF) { tv.power = 'off'; }
      else if (code === R.SIRC.POWER) { tv.power = tv.power === 'on' ? 'off' : 'on'; }
      else if (tv.power === 'on') { const m = { 0x490: 'Vol+', 0xC90: 'Vol-', 0x290: 'Mute', 0xA50: 'Input' }[code]; if (m) this._ircc(m); }
      this._log('IR', `SIRC 0x${code.toString(16).padStart(3, '0')} ×3 (${n}) received by TV`, null, 0);
    }
    // ----- HTML renderer -----
    render() {
      const tv = this.tv, r = this.roku;
      const osd = tv.osd && Date.now() - tv.osdT < 2500 ? `<div class="tv-osd">${tv.osd}</div>` : '';
      let screen;
      if (tv.power !== 'on') screen = `<div class="tv-off">${tv.networkStandby ? 'standby (network standby ON)' : 'fully OFF — Wi-Fi asleep, only IR can wake it'}</div>`;
      else if (tv.app) screen = `<div class="tv-app">▶ ${tv.app}</div>`;
      else if (tv.screen === 'home') screen = `<div class="tv-home">${TILES.map((t, i) => `<div class="tile ${i === tv.cur ? 'cur' : ''}">${t}</div>`).join('')}</div>`;
      else if (tv.input === 2) screen = `<div class="roku-on-tv">${this._rokuScreen()}</div>`;
      else screen = `<div class="tv-live">${INPUTS[tv.input]}<br><small>live picture</small></div>`;
      const vol = `<div class="tv-vol"><div style="width:${tv.muted ? 0 : tv.volume}%"></div></div><span class="tv-vol-t">${tv.muted ? '🔇' : '🔊 ' + tv.volume}</span>`;
      return `<div class="dev tv"><div class="dev-h">Sony Bravia <span class="led-dot ${tv.power === 'on' ? 'on' : tv.networkStandby ? 'stby' : ''}"></span><span class="dev-sub">${tv.power.toUpperCase()} · ${INPUTS[tv.input]}</span></div>
        <div class="tv-screen">${screen}${osd}</div><div class="tv-bar">${vol}<span class="ir-rx ${tv.lastIR && Date.now() - tv.lastIR.t < 600 ? 'hit' : ''}" title="IR receiver">IR◉</span></div></div>
        <div class="dev roku"><div class="dev-h">Roku <span class="dev-sub">${r.app ? 'in ' + r.app : 'home'} (shown on TV via HDMI 3)</span></div><div class="roku-screen">${this._rokuScreen()}</div></div>
        <div class="dev eco"><div class="dev-h">Eco Plug + lamp</div><div class="lamp ${this.eco.on ? 'on' : ''}"><div class="bulb"></div><div class="lamp-base"></div></div><div class="dev-sub">${this.eco.on ? 'ON' : 'OFF'} · ${this.eco.last || 'no packets yet'}</div></div>`;
    }
    _rokuScreen() { const r = this.roku; if (r.app) return `<div class="roku-app">${r.app}</div>`; return `<div class="roku-grid">${ROKU_TILES.map((t, i) => `<div class="rtile ${i === r.cur ? 'cur' : ''}">${t}</div>`).join('')}</div>`; }
  }
  const api = { MockWorld, hexToBytes, INPUTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Devices = api;
})(typeof window !== 'undefined' ? window : globalThis);
