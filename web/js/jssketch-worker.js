/* Sketch harness for a dedicated worker. No DOM. The sketch source is appended
 * as real script text, so this file never calls eval or the Function constructor.
 * The page talks through postMessage and rejects anything outside the schema. */
(function () {
  let port = null;
  if (typeof DedicatedWorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') port = self;
  if (!port) {
    try { port = require('worker_threads').parentPort; } catch (e) { port = null; }
  }
  const Proto = (typeof globalThis !== 'undefined' && globalThis.JsSketchProto) || (typeof self !== 'undefined' && self.JsSketchProto);
  const pending = new Map();
  let seq = 0;
  let running = true;
  let started = false;

  function send(msg) { if (port) port.postMessage(msg); }

  function fail(message) {
    running = false;
    send({ v: 1, type: 'error', message: message });
  }

  function onHost(data) {
    const msg = Proto ? Proto.validateHostMessage(data) : null;
    if (!msg) return;
    if (msg.type === 'go') { if (!started) { started = true; runUser(); } return; }
    if (msg.type === 'stop') {
      running = false;
      if (typeof self !== 'undefined') self.__running = false;
      for (const p of pending.values()) p.resolve();
      pending.clear();
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'resume') p.resolve();
    else if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.message || 'The sketch stopped because a call failed.'));
  }

  if (port && typeof port.on === 'function') port.on('message', onHost);
  else if (port) port.onmessage = (ev) => onHost(ev.data);

  function rpc(name, args) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ v: 1, type: 'call', id, name, args });
    });
  }

  function sleep(dt) {
    const id = ++seq;
    const n = typeof dt === 'number' && isFinite(dt) ? dt : 0;
    return new Promise((resolve) => {
      pending.set(id, { resolve, reject: resolve });
      send({ v: 1, type: 'sleep', id, dt: n });
    });
  }

  const g = typeof self !== 'undefined' ? self : globalThis;
  g.HIGH = 1; g.LOW = 0;
  g.INPUT = 'INPUT'; g.OUTPUT = 'OUTPUT'; g.INPUT_PULLUP = 'INPUT_PULLUP'; g.INPUT_PULLDOWN = 'INPUT_PULLDOWN';
  g.LED_BUILTIN = 2;
  g.pinMode = (pin, mode) => rpc('pinMode', [pin, mode]);
  g.digitalWrite = (pin, value) => rpc('digitalWrite', [pin, value]);
  g.digitalRead = (pin) => rpc('digitalRead', [pin]);
  g.analogRead = (pin) => rpc('analogRead', [pin]);
  g.analogReadMilliVolts = (pin) => rpc('analogReadMilliVolts', [pin]);
  g.analogWrite = (pin, value) => rpc('analogWrite', [pin, value]);
  g.ledcAttach = (pin, freq, res) => rpc('ledcAttach', [pin, freq, res]);
  g.ledcWrite = (pin, duty) => rpc('ledcWrite', [pin, duty]);
  g.millis = () => rpc('millis', []);
  g.micros = () => rpc('micros', []);
  g.delay = (ms) => sleep(Number(ms) / 1000);
  g.delayMicroseconds = (us) => sleep(Number(us) / 1e6);
  g.yield_ = () => sleep(1e-5);
  g.map = (x, a, b, c, d) => Math.trunc((x - a) * (d - c) / (b - a) + c);
  g.constrain = (x, a, b) => Math.min(b, Math.max(a, x));
  g.random = (a, b) => b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a));
  g.Serial = {
    begin: () => rpc('Serial.begin', []),
    print: (x, base) => rpc('Serial.print', base === undefined ? [x] : [x, base]),
    println: (x, base) => rpc('Serial.println', base === undefined ? [x === undefined ? '' : x] : [x, base]),
    printf: (f, ...args) => rpc('Serial.printf', [f, ...args]),
    available: () => rpc('Serial.available', []),
    read: () => rpc('Serial.read', []),
  };
  g.console = { log() {}, warn() {}, error() {} };
  g.__running = true;

  function runUser() {
    try { g.eval = undefined; } catch (e) { /* already locked */ }
    try { g.Function = undefined; } catch (e) { /* already locked */ }
    const start = g.__startSketch;
    if (typeof start !== 'function') { fail('The sketch could not start because it has no setup or loop.'); return; }
    Promise.resolve(start()).then(
      () => { if (running) send({ v: 1, type: 'done' }); },
      (err) => fail(Proto ? Proto.plainError(err) : 'The sketch stopped because of a problem in the code.')
    );
  }

  g.__startSketch = async function () {
    if (typeof setup === 'function') await setup();
    let n = 0;
    while (g.__running && running) {
      if (typeof loop === 'function') await loop();
      if (++n % 1 === 0) await g.yield_();
    }
  };
})();
