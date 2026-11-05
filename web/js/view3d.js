/* WebGL 3D circuit view (three.js, lazy-loaded). 2D SVG stays the editor; this mirrors the live project. */
(function (root) {
  const WIRE_HEX = { green: 0x3ddc84, red: 0xff4d4d, black: 0x1b1b1b, blue: 0x4d8dff, yellow: 0xffd23d, orange: 0xff9a3d, white: 0xe8e8e8, purple: 0xb06bff, gray: 0x9aa3b2, brown: 0xa0632e };
  const BANDC = [0x000000, 0x8b4513, 0xe02020, 0xff8c00, 0xf5d000, 0x20a020, 0x2050e0, 0x9030c0, 0x888888, 0xffffff];
  const LEDCOL = { red: 0xff2a2a, green: 0x2aff6a, blue: 0x3a8cff, yellow: 0xffe14a, white: 0xf5f7ff, orange: 0xff8a2a, ir: 0xb49cff };
  const RM = () => root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => res(); s.onerror = () => rej(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureThree() {
    if (root.THREE) return root.THREE;
    const base = (document.querySelector('script[src*="view3d"]') || { src: 'js/view3d.js' }).src.replace(/js\/view3d[^/]*$/, '');
    const v = 'vendor/three.min.js';
    await loadScript(base + v + (base.includes('?') ? '' : '?v=1'));
    if (!root.THREE) throw new Error('THREE global missing');
    // optional bloom stack (same r134 UMD)
    const extras = ['CopyShader.js', 'LuminosityHighPassShader.js', 'EffectComposer.js', 'RenderPass.js', 'ShaderPass.js', 'UnrealBloomPass.js'];
    for (const f of extras) {
      try { await loadScript(base + 'vendor/' + f + '?v=1'); } catch (e) { /* bloom optional */ break; }
    }
    return root.THREE;
  }

  function bandsOf(r) {
    if (!(r > 0)) return [0x8b4513, 0x000000, 0x000000, 0xc9a227];
    const e = Math.floor(Math.log10(r)) - 1, m = r / Math.pow(10, e), d = Math.max(10, Math.min(99, Math.round(m)));
    const mult = e >= 0 ? (BANDC[e] || 0xffffff) : (e === -1 ? 0xc9a227 : 0xc0c0c0);
    return [BANDC[Math.floor(d / 10)] || 0, BANDC[d % 10] || 0, mult, 0xc9a227];
  }

  // Lightweight orbit: 1-finger/left-drag orbit, wheel/pinch zoom, 2-finger/right-drag pan
  class Orbit {
    constructor(cam, el, target) {
      this.cam = cam; this.el = el; this.target = target.clone();
      this.sph = { theta: 0.55, phi: 1.05, r: 420 };
      this.dragging = false; this.mode = null; this.last = null; this.pinch0 = null; this.moved = false;
      this.enabled = true; this._on = {};
      this._bind(); this.apply();
    }
    _bind() {
      const el = this.el;
      el.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        if (e.pointerType === 'touch' && el._touches) { /* handled below */ }
        this.dragging = true; this.moved = false; this.last = { x: e.clientX, y: e.clientY };
        this.mode = (e.button === 2 || e.shiftKey || e.ctrlKey) ? 'pan' : 'orbit';
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
      });
      el.addEventListener('pointermove', (e) => {
        if (!this.dragging || !this.last) return;
        const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
        this.last = { x: e.clientX, y: e.clientY };
        if (this.mode === 'pan') {
          const s = this.sph.r * 0.0015;
          const right = new THREE.Vector3(); const up = new THREE.Vector3(0, 1, 0);
          right.crossVectors(this.cam.getWorldDirection(new THREE.Vector3()), up).normalize();
          this.target.addScaledVector(right, -dx * s); this.target.addScaledVector(up, dy * s);
        } else {
          this.sph.theta -= dx * 0.005; this.sph.phi = Math.max(0.12, Math.min(Math.PI - 0.12, this.sph.phi + dy * 0.005));
        }
        this.apply();
      });
      const end = () => { this.dragging = false; this.last = null; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      el.addEventListener('wheel', (e) => { if (!this.enabled) return; e.preventDefault(); this.sph.r = Math.max(60, Math.min(1800, this.sph.r * (e.deltaY > 0 ? 1.08 : 0.92))); this.apply(); }, { passive: false });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      // touch: track multi-touch for pinch/pan
      const touches = new Map(); el._touches = touches;
      el.addEventListener('touchstart', (e) => {
        for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
        if (touches.size === 2) {
          const [a, b] = [...touches.values()];
          this.pinch0 = { dist: Math.hypot(a.x - b.x, a.y - b.y), r: this.sph.r, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, target: this.target.clone() };
          this.dragging = false;
        }
      }, { passive: true });
      el.addEventListener('touchmove', (e) => {
        for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
        if (touches.size === 2 && this.pinch0) {
          e.preventDefault();
          const [a, b] = [...touches.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          this.sph.r = Math.max(60, Math.min(1800, this.pinch0.r * (this.pinch0.dist / Math.max(10, dist))));
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const s = this.sph.r * 0.0015;
          const right = new THREE.Vector3(); const up = new THREE.Vector3(0, 1, 0);
          right.crossVectors(this.cam.getWorldDirection(new THREE.Vector3()), up).normalize();
          this.target.copy(this.pinch0.target).addScaledVector(right, -(mid.x - this.pinch0.mid.x) * s).addScaledVector(up, (mid.y - this.pinch0.mid.y) * s);
          this.apply();
        } else if (touches.size === 1 && !this.dragging) {
          // one-finger orbit starts via pointer events; keep as fallback
        }
      }, { passive: false });
      el.addEventListener('touchend', (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); if (touches.size < 2) this.pinch0 = null; }, { passive: true });
    }
    apply() {
      const { theta, phi, r } = this.sph, t = this.target;
      this.cam.position.set(t.x + r * Math.sin(phi) * Math.sin(theta), t.y + r * Math.cos(phi), t.z + r * Math.sin(phi) * Math.cos(theta));
      this.cam.lookAt(t);
    }
    flyTo(pos, r) {
      this._fly = { t0: performance.now(), dur: RM() ? 1 : 700, fromT: this.target.clone(), toT: pos.clone(), fromR: this.sph.r, toR: r || this.sph.r * 0.7, fromTh: this.sph.theta, fromPh: this.sph.phi };
    }
    tick() {
      if (!this._fly) return;
      const f = this._fly, u = Math.min(1, (performance.now() - f.t0) / f.dur), e = u * u * (3 - 2 * u);
      this.target.lerpVectors(f.fromT, f.toT, e);
      this.sph.r = f.fromR + (f.toR - f.fromR) * e;
      this.apply();
      if (u >= 1) this._fly = null;
    }
  }

  class View3D {
    constructor(wrap, hooks) {
      this.wrap = wrap; this.hooks = hooks || {};
      this.active = false; this.ready = false; this.proj = null; this.sim = null;
      this.parts = new Map(); this.wires = new Map(); this.leds = []; this.displays = []; this.motors = []; this.servos = [];
      this._sig = ''; this._raf = 0; this._t = 0; this._idle = 0; this.flow = {};
      this.canvas = document.createElement('canvas'); this.canvas.id = 'stage3d'; this.canvas.className = 'stage3d';
      this.canvas.setAttribute('aria-label', '3D circuit view');
      wrap.appendChild(this.canvas);
    }

    async init() {
      if (this.ready) return;
      const THREE = await ensureThree();
      const w = this.wrap.clientWidth || 800, h = this.wrap.clientHeight || 500;
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      this.dpr = Math.min(root.devicePixelRatio || 1, /Mobi|Android/i.test(navigator.userAgent) ? 1.5 : 2);
      this.renderer.setPixelRatio(this.dpr);
      this.renderer.setSize(w, h, false);
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x07090d);
      this.scene.fog = new THREE.FogExp2(0x07090d, 0.00135);
      this.camera = new THREE.PerspectiveCamera(42, w / h, 2, 5000);
      this.orbit = new Orbit(this.camera, this.canvas, new THREE.Vector3(200, 0, 80));
      // lighting / env
      this.scene.add(new THREE.AmbientLight(0x6e7b92, 0.45));
      const hemi = new THREE.HemisphereLight(0xb7c6dd, 0x1a1410, 0.55); this.scene.add(hemi);
      const key = new THREE.DirectionalLight(0xfff2e0, 1.05); key.position.set(180, 320, 140); key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024); key.shadow.camera.near = 20; key.shadow.camera.far = 900;
      key.shadow.camera.left = -280; key.shadow.camera.right = 280; key.shadow.camera.top = 220; key.shadow.camera.bottom = -220;
      key.shadow.bias = -0.0002; this.scene.add(key); this.key = key;
      const fill = new THREE.DirectionalLight(0x7aa7ff, 0.35); fill.position.set(-160, 120, -80); this.scene.add(fill);
      const rim = new THREE.DirectionalLight(0x88e0ff, 0.2); rim.position.set(40, 80, -200); this.scene.add(rim);
      // subtle ground plane for reflections feel
      const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 48), new THREE.MeshStandardMaterial({ color: 0x0b0e14, metalness: 0.2, roughness: 0.85 }));
      ground.rotation.x = -Math.PI / 2; ground.position.y = -1.2; ground.receiveShadow = true; this.scene.add(ground);
      // bloom
      const glInfo = (this.renderer.getContext() && this.renderer.getContext().getParameter(this.renderer.getContext().RENDERER)) || '';
      const softGL = /SwiftShader|llvmpipe|Software/i.test(glInfo);
      if (!softGL && root.THREE.EffectComposer && root.THREE.UnrealBloomPass) {
        try {
          const comp = new THREE.EffectComposer(this.renderer);
          comp.addPass(new THREE.RenderPass(this.scene, this.camera));
          const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.6, 0.78);
          comp.addPass(bloom); this.composer = comp; this.bloom = bloom;
        } catch (e) { this.composer = null; }
      }
      this.root = new THREE.Group(); this.scene.add(this.root);
      this.ready = true;
      this._onResize = () => this.resize();
      root.addEventListener('resize', this._onResize);
      this.canvas.addEventListener('pointerdown', (e) => { this._ptr = { x: e.clientX, y: e.clientY, t: performance.now() }; });
      this.canvas.addEventListener('pointerup', (e) => this._onPick(e));
      this._loop();
    }

    resize() {
      if (!this.ready) return;
      const w = this.wrap.clientWidth || 1, h = this.wrap.clientHeight || 1;
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(this.dpr);
      this.renderer.setSize(w, h, false);
      if (this.composer) this.composer.setSize(w, h);
    }

    setActive(on) {
      this.active = !!on; this.canvas.classList.toggle('on', this.active);
      this.canvas.style.pointerEvents = this.active ? 'auto' : 'none';
      if (this.active) { this.resize(); if (this.proj) this.rebuild(true); }
    }

    setProject(proj) { this.proj = proj; this._sig = ''; if (this.active && this.ready) this.rebuild(true); }

    sync(sim, flow) {
      this.sim = sim; this.flow = flow || {};
      if (!this.active || !this.ready) return;
      const sig = this._projectSig();
      if (sig !== this._sig) this.rebuild(false);
      this._updateLive();
    }

    _projectSig() {
      if (!this.proj) return '';
      return this.proj.parts.map((p) => p.id + ':' + p.type + ':' + p.x + ',' + p.y + ',' + (p.rot || 0) + ':' + JSON.stringify(p.props || {})).join('|')
        + '#' + this.proj.wires.map((w) => w.id + ':' + w.color + ':' + w.a.x + ',' + w.a.y + '>' + w.b.x + ',' + w.b.y + ':' + (w.pts || []).map((q) => q.x + ',' + q.y).join(';')).join('|');
    }

    clear() {
      while (this.root && this.root.children.length) {
        const o = this.root.children[0]; this.root.remove(o);
        o.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) { if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose()); else c.material.dispose(); } });
      }
      this.parts.clear(); this.wires.clear(); this.leds = []; this.displays = []; this.motors = []; this.servos = [];
    }

    rebuild(fit) {
      if (!this.ready || !this.proj) return;
      const THREE = root.THREE;
      this.clear(); this._sig = this._projectSig();
      const gParts = new THREE.Group(); const gWires = new THREE.Group(); this.root.add(gParts); this.root.add(gWires);
      // map 2D (x right, y down) → 3D (x right, z depth, y up). y2d becomes -z.
      const to3 = (x, y, h) => new THREE.Vector3(x, h || 0, y);
      let cx = 0, cz = 0, n = 0, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const p of this.proj.parts) {
        const d = root.Parts.T[p.type]; if (!d) continue;
        let mesh = null;
        try { mesh = this._makePart(p, d, to3); } catch (err) { console.warn('3D part', p.type, err); mesh = this._makeCard(p, d); }
        if (!mesh) continue;
        const rot = (p.rot || 0) * Math.PI / 2;
        mesh.position.copy(to3(p.x, p.y, 0));
        mesh.rotation.y = -rot;
        gParts.add(mesh); this.parts.set(p.id, { mesh, part: p });
        const sz = d.size ? d.size(p) : { w: 20, h: 20 };
        cx += p.x + sz.w / 2; cz += p.y + sz.h / 2; n++;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + sz.w);
        minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y + sz.h);
      }
      for (const w of this.proj.wires) {
        const tube = this._makeWire(w, to3);
        if (tube) { gWires.add(tube); this.wires.set(w.id, tube); }
      }
      if (fit && n) {
        const tx = cx / n, tz = cz / n;
        this.orbit.target.set(tx, 8, tz);
        this.orbit.sph.r = Math.max(180, Math.min(900, Math.hypot(maxX - minX, maxZ - minZ) * 0.9 + 160));
        this.orbit.sph.theta = 0.7; this.orbit.sph.phi = 1.05; this.orbit.apply();
      }
      this._updateLive();
    }

    _mat(opts) { return new THREE.MeshStandardMaterial(Object.assign({ metalness: 0.25, roughness: 0.45 }, opts)); }

    _makeBreadboard(p, d) {
      const THREE = root.THREE, cols = p.props.cols || 63, W = cols * 10 + 10, H = 200;
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(W + 2, 9, H + 22), this._mat({ color: 0xd6d0c2, roughness: 0.7, metalness: 0.05 }));
      body.position.set(W / 2 - 5, 4.5, H / 2 - 10); body.castShadow = true; body.receiveShadow = true; g.add(body);
      // rail bands
      for (const [z, c] of [[5, 0xc9c3b5], [185, 0xc9c3b5]]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(W + 2.2, 9.2, 38), this._mat({ color: c, roughness: 0.65 }));
        band.position.set(W / 2 - 5, 4.55, z); g.add(band);
      }
      // channel
      const ch = new THREE.Mesh(new THREE.BoxGeometry(W + 2.2, 9.4, 12), this._mat({ color: 0xbdb7a8, roughness: 0.75 }));
      ch.position.set(W / 2 - 5, 4.6, 97); g.add(ch);
      // power rail stripes
      for (const [z, col] of [[0, 0x1a1a1a], [10, 0xb01010], [180, 0xb01010], [190, 0x1a1a1a]]) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(W - 12, 0.6, 1.6), this._mat({ color: col, roughness: 0.4 }));
        s.position.set(W / 2 - 5, 9.1, z); g.add(s);
      }
      // holes — instanced
      const holeGeo = new THREE.CylinderGeometry(1.35, 1.35, 3.2, 8);
      const holeMat = this._mat({ color: 0x1c1c1e, metalness: 0.6, roughness: 0.35 });
      const holes = d.pins(p);
      const inst = new THREE.InstancedMesh(holeGeo, holeMat, holes.length);
      const dummy = new THREE.Object3D();
      // metal strip under each column group
      const stripMat = this._mat({ color: 0xb0b6be, metalness: 0.85, roughness: 0.28 });
      for (let c = 1; c <= cols; c++) {
        for (const [y0, rows] of [[40, 5], [110, 5]]) {
          const strip = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.5, rows * 10 - 2), stripMat);
          strip.position.set(10 + (c - 1) * 10, 1.2, y0 + (rows - 1) * 5); g.add(strip);
        }
      }
      holes.forEach((h, i) => {
        dummy.position.set(h.x, 8.2, h.y); dummy.rotation.x = Math.PI / 2; dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true; g.add(inst);
      return g;
    }

    _makeEsp32(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const pcb = new THREE.Mesh(new THREE.BoxGeometry(150, 1.8, 90), this._mat({ color: 0x0d1a2e, metalness: 0.35, roughness: 0.45 }));
      pcb.position.set(75, 10.5, 45); pcb.castShadow = true; g.add(pcb);
      // USB
      const usb = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 14), this._mat({ color: 0xc0c6ce, metalness: 0.7, roughness: 0.3 }));
      usb.position.set(-2, 12.5, 45); g.add(usb);
      // shield can
      const can = new THREE.Mesh(new THREE.BoxGeometry(42, 3.2, 28), this._mat({ color: 0xb8bec6, metalness: 0.9, roughness: 0.22 }));
      can.position.set(78, 13.2, 38); g.add(can);
      // ESP chip
      const chip = new THREE.Mesh(new THREE.BoxGeometry(18, 1.4, 18), this._mat({ color: 0x111318, metalness: 0.4, roughness: 0.4 }));
      chip.position.set(78, 12.2, 38); g.add(chip);
      // antenna
      const ant = new THREE.Mesh(new THREE.BoxGeometry(28, 0.6, 16), this._mat({ color: 0xe8e4d8, metalness: 0.1, roughness: 0.7 }));
      ant.position.set(132, 10.6, 45); g.add(ant);
      // boot LED marker
      const led = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 10), this._mat({ color: 0x4aa3ff, emissive: 0x000000, emissiveIntensity: 0 }));
      led.position.set(30, 12.5, 66); g.add(led);
      this.leds.push({ type: 'esp32', part: p, mesh: led, light: null });
      // header pins
      const pinGeo = new THREE.BoxGeometry(1.4, 8, 1.4); const pinMat = this._mat({ color: 0xc9ccd1, metalness: 0.85, roughness: 0.25 });
      for (let i = 0; i < 15; i++) {
        for (const z of [0, 90]) {
          const pin = new THREE.Mesh(pinGeo, pinMat); pin.position.set(i * 10, 6, z); g.add(pin);
        }
      }
      return g;
    }

    _makeResistor(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const r = (root.Parts.parseVal && root.Parts.parseVal(p.props.r)) || 1000;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 22, 16), this._mat({ color: 0xd2b57e, roughness: 0.55, metalness: 0.1 }));
      body.rotation.z = Math.PI / 2; body.position.set(20, 12, 0); body.castShadow = true; g.add(body);
      const lead = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 40, 8), this._mat({ color: 0xaeb4bb, metalness: 0.9, roughness: 0.25 }));
      lead.rotation.z = Math.PI / 2; lead.position.set(20, 10.2, 0); g.add(lead);
      const bx = [-7.5, -2.5, 2.5, 8.5];
      bandsOf(r).forEach((c, i) => {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(3.35, 3.35, 2.2, 16), this._mat({ color: c, roughness: 0.5, metalness: 0.05 }));
        band.rotation.z = Math.PI / 2; band.position.set(20 + bx[i], 12, 0); g.add(band);
      });
      return g;
    }

    _makeLed(p, isIR) {
      const THREE = root.THREE, g = new THREE.Group();
      const col = isIR ? LEDCOL.ir : (LEDCOL[p.props.color] || LEDCOL.red);
      const lead = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 16, 8), this._mat({ color: 0xaeb4bb, metalness: 0.9, roughness: 0.25 }));
      lead.position.set(5, 8, 0); g.add(lead);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 2, 16), this._mat({ color: col, transparent: true, opacity: 0.85, roughness: 0.25 }));
      base.position.set(5, 14, 0); g.add(base);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(3.8, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), this._mat({ color: col, transparent: true, opacity: 0.72, emissive: col, emissiveIntensity: 0, roughness: 0.2 }));
      dome.position.set(5, 15, 0); dome.castShadow = true; g.add(dome);
      const light = new THREE.PointLight(col, 0, 90, 2); light.position.set(5, 18, 0); g.add(light);
      this.leds.push({ type: isIR ? 'irled' : 'led', part: p, mesh: dome, base, light });
      return g;
    }

    _makeButton(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(28, 6, 28), this._mat({ color: 0xb6bdc6, metalness: 0.55, roughness: 0.35 }));
      body.position.set(10, 12, 15); body.castShadow = true; g.add(body);
      const CAPS = { red: 0xe53935, green: 0x2e9e4f, blue: 0x2f6fd6, yellow: 0xf4c430, black: 0x2a2d33, white: 0xececec };
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 4, 24), this._mat({ color: CAPS[p.props.color] || 0xe53935, roughness: 0.4 }));
      cap.position.set(10, 16, 15); g.add(cap); g.userData.cap = cap;
      return g;
    }

    _makePot(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(30, 8, 24), this._mat({ color: 0x1e4f9a, roughness: 0.5 }));
      body.position.set(10, 13, -12); body.castShadow = true; g.add(body);
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 6, 24), this._mat({ color: 0x2a2f37, metalness: 0.4, roughness: 0.4 }));
      knob.position.set(10, 18, -12); g.add(knob);
      const tick = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 7), this._mat({ color: 0xf2f2f2 }));
      tick.position.set(10, 21.2, -16.5); knob.add(tick); g.userData.knob = knob;
      return g;
    }

    _makeCap(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const polar = /electro|electrolytic|uF|µF/i.test(String(p.props.c || '')) || p.type === 'capacitor';
      const body = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 14, 20), this._mat({ color: polar ? 0x2a6ad6 : 0xc4a574, metalness: 0.3, roughness: 0.4 }));
      body.position.set(10, 16, 0); body.castShadow = true; g.add(body);
      if (polar) {
        const top = new THREE.Mesh(new THREE.CylinderGeometry(5.05, 5.05, 1.2, 20), this._mat({ color: 0xd0d4da, metalness: 0.7 }));
        top.position.set(10, 23.2, 0); g.add(top);
      }
      return g;
    }

    _makeDip(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      const pins = d.pins(p), n = Math.max(4, pins.length);
      const rows = Math.ceil(n / 2), W = Math.max(30, rows * 10 - 5), D = 28;
      const body = new THREE.Mesh(new THREE.BoxGeometry(W, 4, D), this._mat({ color: 0x16191e, metalness: 0.25, roughness: 0.45 }));
      body.position.set(W / 2 - 5, 14, 5); body.castShadow = true; g.add(body);
      const notch = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 4.2, 12), this._mat({ color: 0x0c0e12 }));
      notch.rotation.x = Math.PI / 2; notch.position.set(2, 14, 5); g.add(notch);
      const pinMat = this._mat({ color: 0xc0c4ca, metalness: 0.85, roughness: 0.25 });
      for (let i = 0; i < rows; i++) {
        for (const z of [-8, 18]) {
          const pin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 8, 1.2), pinMat);
          pin.position.set(i * 10, 10, z); g.add(pin);
        }
      }
      return g;
    }

    _makeDisplay(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      const sz = d.size(p), W = Math.max(40, sz.w), H = Math.max(24, sz.h + 20);
      const pcb = new THREE.Mesh(new THREE.BoxGeometry(W, 2, H), this._mat({ color: 0x1a3a8a, metalness: 0.3, roughness: 0.5 }));
      pcb.position.set(W / 2 - 5, 11, H / 2 - 10); pcb.castShadow = true; g.add(pcb);
      const c = document.createElement('canvas'); c.width = 256; c.height = 128;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#0a1a12'; ctx.fillRect(0, 0, 256, 128);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.82, H * 0.55), new THREE.MeshStandardMaterial({ map: tex, emissive: 0x113322, emissiveIntensity: 0.4, roughness: 0.35, metalness: 0.1 }));
      screen.position.set(W / 2 - 5, 12.2, H / 2 - 10); screen.rotation.x = -Math.PI / 2; g.add(screen);
      this.displays.push({ part: p, tex, canvas: c, ctx, screen });
      return g;
    }

    _makeMotor(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 18, 24), this._mat({ color: 0xb0b4ba, metalness: 0.75, roughness: 0.3 }));
      body.rotation.z = Math.PI / 2; body.position.set(15, 16, -20); body.castShadow = true; g.add(body);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 8, 12), this._mat({ color: 0x22262c }));
      hub.rotation.z = Math.PI / 2; hub.position.set(28, 16, -20); g.add(hub);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 22), this._mat({ color: 0xe8e8e8 }));
      blade.position.set(32, 16, -20); g.add(blade); g.userData.rotor = blade;
      this.motors.push({ part: p, rotor: blade });
      return g;
    }

    _makeServo(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(28, 16, 22), this._mat({ color: 0x2f6fd6, roughness: 0.45 }));
      body.position.set(10, 16, -8); body.castShadow = true; g.add(body);
      const horn = new THREE.Mesh(new THREE.BoxGeometry(18, 2, 4), this._mat({ color: 0xf0f0f0 }));
      horn.position.set(10, 25, -8); g.add(horn); g.userData.horn = horn;
      this.servos.push({ part: p, horn });
      return g;
    }


    _makeBattery(p, t) {
      const THREE = root.THREE, g = new THREE.Group();
      const nine = /9v|battery9v/i.test(t);
      if (nine) {
        const body = new THREE.Mesh(new THREE.BoxGeometry(28, 36, 18), this._mat({ color: 0x1a1c20, metalness: 0.35, roughness: 0.45 }));
        body.position.set(10, 26, -20); body.castShadow = true; g.add(body);
        const label = new THREE.Mesh(new THREE.BoxGeometry(22, 14, 0.4), this._mat({ color: 0xd4a017, metalness: 0.5, roughness: 0.4 }));
        label.position.set(10, 28, -11); g.add(label);
        const pos = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 4, 12), this._mat({ color: 0xc0c4ca, metalness: 0.85 }));
        pos.position.set(4, 46, -20); g.add(pos);
        const neg = new THREE.Mesh(new THREE.BoxGeometry(8, 2, 8), this._mat({ color: 0xc0c4ca, metalness: 0.85 }));
        neg.position.set(16, 45, -20); g.add(neg);
      } else {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 28, 20), this._mat({ color: 0x2a6ad6, metalness: 0.3, roughness: 0.4 }));
        body.position.set(10, 20, 0); body.castShadow = true; g.add(body);
        const tip = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 4, 12), this._mat({ color: 0xc0c4ca, metalness: 0.85 }));
        tip.position.set(10, 36, 0); g.add(tip);
      }
      return g;
    }
    _makeCard(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      const sz = d.size ? d.size(p) : { w: 30, h: 20 };
      const W = Math.max(16, sz.w), D = Math.max(12, sz.h);
      // rasterize 2D svg artwork onto a canvas texture when possible
      let map = null;
      try {
        const svg = d.svg ? d.svg.call(d, p, (this.sim && this.sim.partState(p)) || {}) : '';
        if (svg) {
          const c = document.createElement('canvas'); c.width = 256; c.height = 128;
          const img = new Image();
          const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${D}" viewBox="0 0 ${W} ${D}">${svg}</svg>`);
          map = new THREE.CanvasTexture(c);
          img.onload = () => { c.getContext('2d').drawImage(img, 0, 0, 256, 128); map.needsUpdate = true; };
          img.src = url;
        }
      } catch (_) {}
      const mat = this._mat({ color: 0x2a3140, metalness: 0.2, roughness: 0.55, map: map || null });
      const body = new THREE.Mesh(new THREE.BoxGeometry(W, 6, D), mat);
      body.position.set(W / 2 - 5, 12, D / 2 - 5); body.castShadow = true; g.add(body);
      return g;
    }

    _makePart(p, d) {
      const t = p.type;
      if (t === 'breadboard') return this._makeBreadboard(p, d);
      if (t === 'esp32') return this._makeEsp32(p);
      if (t === 'resistor') return this._makeResistor(p);
      if (t === 'led') return this._makeLed(p, false);
      if (t === 'irled') return this._makeLed(p, true);
      if (t === 'pushbutton' || t === 'key' || t === 'button') return this._makeButton(p);
      if (t === 'potentiometer' || t === 'pot') return this._makePot(p);
      if (t === 'capacitor') return this._makeCap(p);
      if (t === 'ne555' || t === 'opamp' || /^74|^lm|^ne|^cd|^mcp/i.test(t) || (d.label || '').match(/DIP|IC|timer|shift/i)) return this._makeDip(p, d);
      if (/lcd|oled|tft|ssd1306|sh110|display/i.test(t)) return this._makeDisplay(p, d);
      if (t === 'motor' || t === 'dcmotor') return this._makeMotor(p);
      if (t === 'servo') return this._makeServo(p);
      if (t === 'battery' || t === 'battery9v' || t === 'coin' || t === 'vcc33' || t === 'vcc5') return this._makeBattery(p, t);
      return this._makeCard(p, d);
    }

    _makeWire(w, to3) {
      const THREE = root.THREE;
      const pts2 = [w.a, ...(w.pts || []), w.b];
      if (pts2.length < 2) return null;
      // lift wire in an arc above the board
      const pts = pts2.map((q, i) => {
        const t = i / (pts2.length - 1);
        const lift = 14 + Math.sin(t * Math.PI) * 10;
        return new THREE.Vector3(q.x, lift, q.y);
      });
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35);
      const radial = this.dpr < 1.6 ? 4 : 6;
      const geo = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 6), 1.15, radial, false);
      const col = WIRE_HEX[w.color] || 0x3ddc84;
      const mat = new THREE.MeshStandardMaterial({ color: col, metalness: 0.35, roughness: 0.4, emissive: col, emissiveIntensity: 0.05 });
      const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.userData.wid = w.id; mesh.userData.base = col;
      // flow dashes as a second thinner tube with transparent dashes via vertex colors / shader-ish: use a Line for speed on LOD
      const flowPts = curve.getPoints(32);
      const flowGeo = new THREE.BufferGeometry().setFromPoints(flowPts);
      const flowMat = new THREE.LineDashedMaterial({ color: 0xe6fdff, dashSize: 4, gapSize: 8, transparent: true, opacity: 0 });
      const flow = new THREE.Line(flowGeo, flowMat); flow.computeLineDistances(); flow.position.y = 0.4;
      mesh.add(flow); mesh.userData.flow = flow; mesh.userData.flowMat = flowMat;
      return mesh;
    }

    _updateLive() {
      if (!this.sim) return;
      const THREE = root.THREE;
      // LEDs
      for (const L of this.leds) {
        const st = this.sim.partState(L.part) || {};
        let b = st.bright || 0;
        if (L.type === 'esp32') b = (st.pinLevel && st.pinLevel[2]) ? 0.9 : 0;
        if (st.burned) b = 0;
        L.mesh.material.emissiveIntensity = b * 2.2;
        L.mesh.material.opacity = 0.55 + 0.4 * b;
        if (L.base) L.base.material.emissiveIntensity = b * 1.2;
        if (L.light) L.light.intensity = b * (L.type === 'irled' ? 0.6 : 2.4);
      }
      // wires flow
      for (const [id, mesh] of this.wires) {
        const f = this.flow[id] || { i: 0 }; const mag = Math.abs(f.i || 0);
        const fm = mesh.userData.flowMat; if (!fm) continue;
        if (mag < 1e-6 || RM()) { fm.opacity = 0; continue; }
        fm.opacity = Math.min(0.95, 0.2 + Math.log10(mag * 1e6 + 1) * 0.18);
        const speed = Math.max(0.3, Math.min(4, Math.sqrt(mag * 800) + 0.4));
        fm.dashSize = 4; fm.gapSize = 8;
        // animate by shifting line distances scale via scale on dash offset — LineDashedMaterial has no dashOffset in r134; nudge position along
        mesh.userData._ph = (mesh.userData._ph || 0) + speed * 0.35 * (f.i >= 0 ? 1 : -1);
        fm.gapSize = 8 + (mesh.userData._ph % 8);
        mesh.material.emissiveIntensity = 0.04 + Math.min(0.5, mag * 40);
      }
      // pots / buttons
      for (const [id, rec] of this.parts) {
        const p = rec.part, st = this.sim.partState(p) || {};
        if (rec.mesh.userData.knob && p.props && p.props.pos != null) {
          rec.mesh.userData.knob.rotation.y = (-135 + 270 * (+p.props.pos)) * Math.PI / 180;
        }
        if (rec.mesh.userData.cap) rec.mesh.userData.cap.position.y = st.pressed ? 14.5 : 16;
        if (rec.mesh.userData.horn && st.angle != null) rec.mesh.userData.horn.rotation.y = (st.angle - 90) * Math.PI / 180;
      }
      for (const m of this.motors) {
        const st = this.sim.partState(m.part) || {};
        if (st.on || Math.abs(st.i || 0) > 0.01) m.rotor.rotation.x += 0.35;
      }
      for (const s of this.servos) {
        const st = this.sim.partState(s.part) || {};
        if (st.angle != null) s.horn.rotation.y = (st.angle - 90) * Math.PI / 180;
      }
      // displays
      for (const d of this.displays) {
        const st = this.sim.partState(d.part) || {};
        if (st.img && st.img !== d._img) {
          d._img = st.img;
          const im = new Image();
          im.onload = () => { d.ctx.fillStyle = '#04140c'; d.ctx.fillRect(0, 0, d.canvas.width, d.canvas.height); d.ctx.drawImage(im, 0, 0, d.canvas.width, d.canvas.height); d.tex.needsUpdate = true; };
          im.src = st.img;
        } else if (st.txt && st.txt !== d._txt) {
          d._txt = st.txt; d.ctx.fillStyle = '#04140c'; d.ctx.fillRect(0, 0, 256, 128);
          d.ctx.fillStyle = '#7dffb0'; d.ctx.font = '20px monospace'; d.ctx.fillText(String(st.txt).slice(0, 32), 12, 40); d.tex.needsUpdate = true;
        }
      }
    }

    _onPick(e) {
      if (!this.active || !this.ready || !this.orbit || this.orbit.moved) return;
      if (this._ptr && performance.now() - this._ptr.t > 400) return;
      const THREE = root.THREE;
      const rect = this.canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(mouse, this.camera);
      // wires
      const wireMeshes = [...this.wires.values()];
      let hits = ray.intersectObjects(wireMeshes, true);
      for (const h of hits) {
        let o = h.object; while (o && !o.userData.wid) o = o.parent;
        if (o && o.userData.wid) {
          const id = o.userData.wid, f = this.flow[id] || { i: 0, v: 0 };
          if (this.hooks.onWire) this.hooks.onWire(id, f, e);
          return;
        }
      }
      const partMeshes = [...this.parts.values()].map((x) => x.mesh);
      hits = ray.intersectObjects(partMeshes, true);
      if (hits[0]) {
        let o = hits[0].object; while (o && o.parent !== this.root && o.parent && o.parent.parent !== this.root) o = o.parent;
        // find part id
        for (const [id, rec] of this.parts) {
          let found = false; rec.mesh.traverse((c) => { if (c === hits[0].object) found = true; });
          if (found) {
            const world = new THREE.Vector3(); rec.mesh.getWorldPosition(world);
            this.orbit.flyTo(world, Math.max(100, this.orbit.sph.r * 0.55));
            if (this.hooks.onPart) this.hooks.onPart(id, e);
            return;
          }
        }
      }
    }

    _loop() {
      const step = () => {
        this._raf = requestAnimationFrame(step);
        if (!this.ready || !this.active) return;
        this._t += 0.016;
        if (this.orbit) {
          this.orbit.tick();
          if (!this.orbit.dragging && !this.orbit._fly && !RM()) {
            this._idle += 0.016;
            if (this._idle > 2.5) { this.orbit.sph.theta += 0.0009; this.orbit.apply(); }
          } else this._idle = 0;
        }
        if (this.composer) this.composer.render();
        else this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(step);
    }

    dispose() {
      cancelAnimationFrame(this._raf); root.removeEventListener('resize', this._onResize);
      this.clear(); if (this.renderer) this.renderer.dispose();
    }
  }

  root.View3D = View3D;
  root.loadView3D = async function loadView3D(wrap, hooks) {
    const v = new View3D(wrap, hooks);
    await v.init();
    return v;
  };
})(typeof window !== 'undefined' ? window : globalThis);
