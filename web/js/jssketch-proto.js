/* Message schema for a JS sketch Worker. No DOM. No eval.
 * The page and the worker both check every message against this list. */
(function (root) {
  const CALLS = [
    'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogReadMilliVolts',
    'analogWrite', 'ledcAttach', 'ledcWrite', 'millis', 'micros',
    'Serial.begin', 'Serial.print', 'Serial.println', 'Serial.printf', 'Serial.available', 'Serial.read',
  ];
  const RUNAWAY = 'The sketch was stopped because it ran too long without a pause.';
  const BAD = 'The sketch sent something the page could not use, so it was stopped.';
  const SYNTAX = 'The sketch could not start because the code has a syntax error.';

  function isPrim(v) {
    if (v === null) return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.length <= 4000;
    return typeof v === 'boolean';
  }

  function plainError(err) {
    const raw = err && err.message ? String(err.message) : String(err || '');
    const one = raw.split('\n')[0].replace(/\s+/g, ' ').trim();
    if (!one) return 'The sketch stopped because of a problem in the code.';
    if (/syntaxerror/i.test(one)) return SYNTAX;
    if (one.indexOf('The sketch ') === 0) return one.slice(0, 200);
    return ('The sketch stopped: ' + one).slice(0, 200);
  }

  function validateWorkerMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
    if (msg.v !== 1 || typeof msg.type !== 'string') return null;
    if (msg.type === 'call') {
      if (!Number.isInteger(msg.id) || msg.id < 1) return null;
      if (typeof msg.name !== 'string' || CALLS.indexOf(msg.name) < 0) return null;
      if (!Array.isArray(msg.args) || msg.args.length > 16) return null;
      if (!msg.args.every(isPrim)) return null;
      return { v: 1, type: 'call', id: msg.id, name: msg.name, args: msg.args.slice() };
    }
    if (msg.type === 'sleep') {
      if (!Number.isInteger(msg.id) || msg.id < 1) return null;
      if (typeof msg.dt !== 'number' || !Number.isFinite(msg.dt)) return null;
      return { v: 1, type: 'sleep', id: msg.id, dt: msg.dt };
    }
    if (msg.type === 'error') {
      if (typeof msg.message !== 'string') return null;
      return { v: 1, type: 'error', message: msg.message.slice(0, 200) };
    }
    if (msg.type === 'done') return { v: 1, type: 'done' };
    return null;
  }

  function validateHostMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.v !== 1) return null;
    if (msg.type === 'result') {
      if (!Number.isInteger(msg.id) || msg.id < 1) return null;
      if (msg.ok === true && isPrim(msg.value)) return { v: 1, type: 'result', id: msg.id, ok: true, value: msg.value };
      if (msg.ok === false && typeof msg.message === 'string') return { v: 1, type: 'result', id: msg.id, ok: false, message: msg.message.slice(0, 200) };
      return null;
    }
    if (msg.type === 'resume' && Number.isInteger(msg.id) && msg.id > 0) return { v: 1, type: 'resume', id: msg.id };
    if (msg.type === 'stop') return { v: 1, type: 'stop' };
    if (msg.type === 'go') return { v: 1, type: 'go' };
    return null;
  }

  const api = { CALLS, RUNAWAY, BAD, SYNTAX, isPrim, plainError, validateWorkerMessage, validateHostMessage };
  root.JsSketchProto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
