/* JS port of firmware/remote_logic.h (key -> command mapping, request bodies, Eco packets, SIRC encoder).
 * Used by the mock devices (to label/decode what the real firmware sends) and by tests/remote.test.js,
 * which cross-checks it against the native C++ test captures in ../tests/out/captured.jsonl. */
(function (root) {
  const KEYMAP = [
    ['SonyOn', 'SonyOff', 'Vol+', 'Vol-', 'Mute'],
    ['Input', 'Up', 'Down', 'Left', 'Right'],
    ['OK', 'Back', 'Home', 'RokuSelect', 'RokuHome'],
    ['RokuBack', 'Mode', 'EcoToggle', null, null],
  ];
  const IRCC = {
    'Vol+': 'AAAAAQAAAAEAAAASAw==', 'Vol-': 'AAAAAQAAAAEAAAATAw==', Mute: 'AAAAAQAAAAEAAAAUAw==', Input: 'AAAAAQAAAAEAAAAlAw==',
    Up: 'AAAAAQAAAAEAAAB0Aw==', Down: 'AAAAAQAAAAEAAAB1Aw==', Left: 'AAAAAQAAAAEAAAA0Aw==', Right: 'AAAAAQAAAAEAAAAzAw==',
    OK: 'AAAAAQAAAAEAAABlAw==', Back: 'AAAAAgAAAJcAAAAjAw==', Home: 'AAAAAQAAAAEAAABgAw==',
  };
  const IRCC_NAME = {}; for (const k in IRCC) IRCC_NAME[IRCC[k]] = k;
  function keyCommand(b, rokuMode) {
    switch (b) {
      case 'SonyOn': return { kind: 'SONY_POWER', on: true };
      case 'SonyOff': return { kind: 'SONY_POWER', on: false };
      case 'Up': case 'Down': case 'Left': case 'Right': return rokuMode ? { kind: 'ROKU', arg: b } : { kind: 'SONY_IRCC', arg: IRCC[b] };
      case 'Vol+': case 'Vol-': case 'Mute': case 'Input': case 'OK': case 'Back': case 'Home': return { kind: 'SONY_IRCC', arg: IRCC[b] };
      case 'RokuSelect': return { kind: 'ROKU', arg: 'Select' };
      case 'RokuHome': return { kind: 'ROKU', arg: 'Home' };
      case 'RokuBack': return { kind: 'ROKU', arg: 'Back' };
      case 'EcoToggle': return { kind: 'ECO' };
      case 'Mode': return { kind: 'MODE' };
      default: return { kind: 'NONE' };
    }
  }
  const sonyIrccBody = (code) => '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + code + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
  const SONY_IRCC_CTYPE = 'text/xml; charset=UTF-8';
  const SONY_IRCC_SOAPACTION = '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"';
  const sonyPowerBody = (on) => '{"method":"setPowerStatus","id":55,"params":[{"status":' + (on ? 'true' : 'false') + '}],"version":"1.0"}';
  function ecoLegacyPacket(id, write, on, xid, t) {
    const p = new Uint8Array(write ? 130 : 128);
    p[0] = write ? 0x16 : 0x17; p[2] = 0x05; p[6] = xid & 0xff; p[7] = (xid >> 8) & 0xff; p[8] = write ? 2 : 0;
    for (let i = 0; i < Math.min(32, id.length); i++) p[16 + i] = id.charCodeAt(i);
    p[116] = t & 0xff; p[117] = (t >> 8) & 0xff; p[118] = (t >> 16) & 0xff; p[119] = (t >>> 24) & 0xff;
    p.set([0xae, 0x49, 0x52, 0x0d], 124);
    if (write) { p[128] = 1; p[129] = on ? 1 : 0; }
    return p;
  }
  const KAB_BODY = [0x79,0x76,0x51,0x43,0x3b,0x77,0x77,0x74,0x22,0x40,0x22,0x26,0x1b,0x27,0x33,0x39,0x24,0x34,0x44,0x4c,0x1a,0x79,0x65,0x1c,0x73,0x7c,0x22,0x33,0x3f,0x5b,0x77,0x85,0x48,0x68,0x88,0x98,0x51,0x75,0x99,0xab,0x5a,0x82,0xaa,0xbe,0x63,0x8f,0xbb,0xd1,0x0d,0x97,0x1f,0x2a,0x0d,0xff,0xe9,0xe5];
  function kabBuildFixed(on, rnd) {
    const b = new Uint8Array(152); b[0] = rnd & 0xff; b[1] = (rnd >> 8) & 0xff; b[2] = 0x2d; b[3] = 0xac;
    b.set([0x17, 0, 0, 0, 0, 0, 0, 0, 0xda, 0xe2, 0x0c, 0x00], 4);
    for (let i = 0; i < 56; i++) b[16 + i] = KAB_BODY[i] ^ b[i % 4];
    b[76] = 0x6a; b[80] = on ? 1 : 0; return b;
  }
  const SIRC = { POWER: 0xA90, POWER_ON: 0x750, POWER_OFF: 0xF50, VOLUP: 0x490, VOLDN: 0xC90, MUTE: 0x290, INPUT: 0xA50 };
  const SIRC_NAME = { 0xA90: 'Power toggle', 0x750: 'Power ON', 0xF50: 'Power OFF', 0x490: 'Vol+', 0xC90: 'Vol-', 0x290: 'Mute', 0xA50: 'Input' };
  function sircEncodeFrame(data, nbits = 12) {   // -> [[mark_us, space_us], ...]
    const out = [[2400, 600]]; let used = 3000;
    for (let i = 0; i < nbits; i++) { const one = (data >> (nbits - 1 - i)) & 1; out.push([one ? 1200 : 600, 600]); used += (one ? 1200 : 600) + 600; }
    out[nbits][1] = 45000 - used + 600; return out;
  }
  function sircDecode(marks) {   // marks in µs (first = header)
    if (!marks.length || Math.abs(marks[0] - 2400) > 400) return null;
    let v = 0; const bits = marks.slice(1, 13);
    if (bits.length < 12) return null;
    for (const m of bits) v = (v << 1) | (m > 900 ? 1 : 0);
    return v;
  }
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const api = { KEYMAP, IRCC, IRCC_NAME, keyCommand, sonyIrccBody, sonyPowerBody, SONY_IRCC_CTYPE, SONY_IRCC_SOAPACTION, ecoLegacyPacket, kabBuildFixed, SIRC, SIRC_NAME, sircEncodeFrame, sircDecode, hex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RemoteLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
