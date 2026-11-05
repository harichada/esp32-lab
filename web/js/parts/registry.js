/* Part registration API for add-on part files under js/parts/ (load after parts.js, sim.js, i2cdev.js, examples.js, bom.js).
 *   PartsReg.register(type, def, {bom, i2c})  -> adds Parts.T[type]; bom: (props) => {key,name,q,note?}; i2c: (part) => device model
 *   def.espStep(part, ctx)   called before each circuit build (ESP32 pin state changed) - decode bit-banged protocols, set drives
 *   def.tick(part, ctx, dt)  called after each sim step; return true to force a rebuild (time-based outputs)
 *   PartsReg.example(key, name, factory, group) -> adds to Examples.EX / LIST
 * ctx: { sim, state(p), gpio(p, pinName) -> {rt, g, pin} | null, t } */
(function (root) {
  if (root.PartsReg) return;
  const P = root.Parts, I2C = {}, BOM = {}, EXS = [];
  function bomFlush() { const B = root.Bom; if (B && B.CATALOG) for (const k in BOM) if (!B.CATALOG[k]) B.CATALOG[k] = BOM[k]; }
  function register(type, d, o = {}) {
    d.type = type; P.T[type] = d;
    if (o.bom) { BOM[type] = o.bom; bomFlush(); }
    if (o.i2c) I2C[type] = o.i2c;
    return d;
  }
  function example(key, name, factory, group) {
    EXS.push([key, name, factory, group]);
    const E = root.Examples; if (E && E.EX && !E.EX[key]) { E.EX[key] = factory; const i = E.LIST.findIndex((x) => x[0] === 'blank'); const row = group ? [key, name, group] : [key, name]; if (i >= 0) E.LIST.splice(i, 0, row); else E.LIST.push(row); }
  }
  function ctx(sim, dt) {
    const esp = sim.project.parts.find((q) => q.type === 'esp32');
    return {
      sim, t: sim.t, dt: dt || 0, state: (p) => sim.partState(p),
      gpio(p, name) {
        if (!esp || !sim.pinNet) return null; const n = sim.pinNet.get(p.id + ':' + name); if (!(n > 0)) return null;
        for (const pn of [...P.ESP_TOP, ...P.ESP_BOT]) { const g = P.espGpio(pn); if (g >= 0 && sim.pinNet.get(esp.id + ':' + pn) === n) { const rt = sim.espRuntime(esp); return { rt, g, pin: rt.pins[g] }; } }
        return null;
      },
      // level the MCU is driving on a part pin (1/0), or null when the GPIO is an input (or not wired)
      drive(p, name) { const c = this.gpio(p, name); if (!c || !c.pin.out) return null; return c.pin.level ? 1 : 0; },
      powered(p, a = 'VCC', b = 'GND', v = 2.5) { return sim.pinVoltage(p, a) - sim.pinVoltage(p, b) > v || !sim.circuit; },
    };
  }
  // hooks called from sim.js
  function beforeBuild(sim) {
    const c = ctx(sim);
    for (const p of sim.project.parts) { const d = P.T[p.type]; if (d && d.espStep) try { d.espStep(p, c); } catch (e) { /* keep sim alive */ } }
  }
  function after(sim, dt) {
    let dirty = false; const c = ctx(sim, dt);
    for (const p of sim.project.parts) { const d = P.T[p.type]; if (d && d.tick) try { if (d.tick(p, c, dt)) dirty = true; } catch (e) { /* ignore */ } }
    return dirty;
  }
  const isI2c = (type) => !!I2C[type];
  const i2cDev = (q) => I2C[q.type] ? I2C[q.type](q) : null;
  root.PartsReg = { register, example, beforeBuild, after, isI2c, i2cDev, bomFlush, I2C, BOM, EXS };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PartsReg;
})(typeof window !== 'undefined' ? window : globalThis);
