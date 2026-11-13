/* Network/Debug log panel: timestamped WiFi/DHCP/DNS/TCP/HTTP/UDP events from the server's network bridge ({t:'netlog'})
 * plus the virtual devices' reactions. Enabled unless ?netlog=0 or localStorage netlog=0 (then nothing is requested). */
(function (root) {
  const MAX = 2000;
  class NetLog {
    constructor() {
      let off = false;
      try { off = new URLSearchParams(location.search).get('netlog') === '0' || clStorage.local.getItem('netlog') === '0'; } catch (e) { /* node */ }
      this.enabled = !off; this.rows = []; this.filter = ''; this.el = null; this.dirty = false;
    }
    clear() { this.rows = []; this.dirty = true; this.render(); }
    add(e) {
      if (!this.enabled) return;
      const now = new Date();
      this.rows.push({ wall: now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0'), ts: e.ts, k: e.k || 'info', msg: String(e.msg || ''), ok: e.ok !== false });
      if (this.rows.length > MAX) this.rows.splice(0, this.rows.length - MAX);
      this.dirty = true;
    }
    line(r) { return `${r.wall}${r.ts != null ? ' +' + Number(r.ts).toFixed(3) + 's' : ''} ${r.k.toUpperCase().padEnd(5)} ${r.ok ? '' : '!! '}${r.msg}`; }
    visible() {
      const f = this.filter.trim().toLowerCase(); if (!f) return this.rows;
      const terms = f.split(/\s+/);
      return this.rows.filter((r) => { const l = this.line(r).toLowerCase(); return terms.every((t) => (t === 'errors' ? !r.ok : l.includes(t))); });
    }
    text() { return this.visible().map((r) => this.line(r)).join('\n'); }
    render() {
      if (!this.el || !this.dirty) return; this.dirty = false;
      const atBottom = this.el.scrollTop + this.el.clientHeight > this.el.scrollHeight - 30;
      const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const v = this.visible();
      this.el.innerHTML = v.length ? v.map((r) => `<div class="nlr k-${r.k}${r.ok ? '' : ' bad'}">${esc(this.line(r))}</div>`).join('') : `<div class="muted">${this.enabled ? 'no network events yet — press ▶ Run' : 'network log disabled (remove ?netlog=0 / localStorage netlog)'}</div>`;
      if (atBottom) this.el.scrollTop = this.el.scrollHeight;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { NetLog };
  root.NetLogMod = { NetLog };
})(typeof window !== 'undefined' ? window : globalThis);
