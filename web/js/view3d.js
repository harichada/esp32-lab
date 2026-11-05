/* WebGL 3D circuit view — SpaceX-quality polish. 2D SVG remains the editor; this mirrors the live project.
 * Scale: 2D G=10 units = 0.1" = 2.54 mm → 1 SVG unit = 0.254 mm. */
(function (root) {
  const WIRE_HEX = { green: 0x3ddc84, red: 0xe53935, black: 0x2e2e32, blue: 0x1e88e5, yellow: 0xfdd835, orange: 0xfb8c00, white: 0xe8e8ec, purple: 0x8e24aa, gray: 0x9e9e9e, brown: 0x6d4c41 };
  const BANDC = [0x111111, 0x6d4c41, 0xe53935, 0xfb8c00, 0xfdd835, 0x43a047, 0x1e88e5, 0x8e24aa, 0x9e9e9e, 0xfafafa];
  const LEDCOL = { red: 0xff1744, green: 0x00e676, blue: 0x2979ff, yellow: 0xffea00, white: 0xf5f7ff, orange: 0xff9100, ir: 0xb388ff };
  const MM = 1 / 0.254;   // SVG units per millimetre
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
    await loadScript(base + 'vendor/three.min.js?v=2');
    if (!root.THREE) throw new Error('THREE global missing');
    for (const f of ['CopyShader.js', 'LuminosityHighPassShader.js', 'EffectComposer.js', 'RenderPass.js', 'ShaderPass.js', 'UnrealBloomPass.js']) {
      try { await loadScript(base + 'vendor/' + f + '?v=2'); } catch (e) { break; }
    }
    return root.THREE;
  }
  function bandsOf(r) {
    if (!(r > 0)) return [0x6d4c41, 0x111111, 0x111111, 0xc9a227];
    const e = Math.floor(Math.log10(r)) - 1, m = r / Math.pow(10, e), d = Math.max(10, Math.min(99, Math.round(m)));
    const mult = e >= 0 ? (BANDC[e] || 0xffffff) : (e === -1 ? 0xc9a227 : 0xc0c0c0);
    return [BANDC[Math.floor(d / 10)] || 0, BANDC[d % 10] || 0, mult, 0xc9a227];
  }
  function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  class Orbit {
    constructor(cam, el, target) {
      this.cam = cam; this.el = el; this.target = target.clone();
      this.sph = { theta: 0.72, phi: 1.05, r: 380 };
      this.goal = { theta: 0.72, phi: 1.05, r: 380, target: target.clone() };
      this.dragging = false; this.mode = null; this.last = null; this.pinch0 = null; this.moved = false;
      this.enabled = true; this._fly = null; this._bind(); this.apply(true);
    }
    _bind() {
      const el = this.el;
      el.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        this.dragging = true; this.moved = false; this.last = { x: e.clientX, y: e.clientY };
        this.mode = (e.button === 2 || e.shiftKey || e.ctrlKey) ? 'pan' : 'orbit';
        this._fly = null;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
      });
      el.addEventListener('pointermove', (e) => {
        if (!this.dragging || !this.last) return;
        const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
        this.last = { x: e.clientX, y: e.clientY };
        if (this.mode === 'pan') {
          const s = this.sph.r * 0.0012;
          const right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
          right.crossVectors(this.cam.getWorldDirection(new THREE.Vector3()), up).normalize();
          this.goal.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
        } else {
          this.goal.theta -= dx * 0.0045;
          this.goal.phi = Math.max(0.18, Math.min(Math.PI * 0.48, this.goal.phi + dy * 0.0045));
        }
      });
      const end = () => { this.dragging = false; this.last = null; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      el.addEventListener('wheel', (e) => {
        if (!this.enabled) return; e.preventDefault(); this._fly = null;
        this.goal.r = Math.max(80, Math.min(1400, this.goal.r * (e.deltaY > 0 ? 1.07 : 0.93)));
      }, { passive: false });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      const touches = new Map(); el._touches = touches;
      el.addEventListener('touchstart', (e) => {
        for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
        if (touches.size === 2) {
          const [a, b] = [...touches.values()];
          this.pinch0 = { dist: Math.hypot(a.x - b.x, a.y - b.y), r: this.goal.r, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, target: this.goal.target.clone() };
          this.dragging = false; this._fly = null;
        }
      }, { passive: true });
      el.addEventListener('touchmove', (e) => {
        for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
        if (touches.size === 2 && this.pinch0) {
          e.preventDefault();
          const [a, b] = [...touches.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          this.goal.r = Math.max(80, Math.min(1400, this.pinch0.r * (this.pinch0.dist / Math.max(10, dist))));
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const s = this.goal.r * 0.0012;
          const right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
          right.crossVectors(this.cam.getWorldDirection(new THREE.Vector3()), up).normalize();
          this.goal.target.copy(this.pinch0.target).addScaledVector(right, -(mid.x - this.pinch0.mid.x) * s).addScaledVector(up, (mid.y - this.pinch0.mid.y) * s);
        }
      }, { passive: false });
      el.addEventListener('touchend', (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); if (touches.size < 2) this.pinch0 = null; }, { passive: true });
    }
    apply(immediate) {
      if (immediate) {
        this.sph.theta = this.goal.theta; this.sph.phi = this.goal.phi; this.sph.r = this.goal.r; this.target.copy(this.goal.target);
      }
      const { theta, phi, r } = this.sph, t = this.target;
      this.cam.position.set(t.x + r * Math.sin(phi) * Math.sin(theta), t.y + r * Math.cos(phi), t.z + r * Math.sin(phi) * Math.cos(theta));
      this.cam.lookAt(t);
    }
    frameBox(box, angleDeg) {
      if (!box || box.isEmpty()) return;
      const c = new THREE.Vector3(); box.getCenter(c);
      const size = new THREE.Vector3(); box.getSize(size);
      const spanXZ = Math.max(size.x, size.z, 36);
      this.goal.target.set(c.x, Math.max(10, Math.min(20, size.y * 0.08 + 8)), c.z);
      this.goal.theta = (angleDeg != null ? angleDeg : 40) * Math.PI / 180;
      this.goal.phi = 1.15;
      const fov = (this.cam.fov || 38) * Math.PI / 180;
      const fit = (spanXZ * 0.38) / Math.max(0.2, Math.tan(fov * 0.5));
      this.goal.r = Math.max(85, Math.min(260, fit * 1.0 + 18));
      this.sph.theta = this.goal.theta; this.sph.phi = this.goal.phi; this.sph.r = this.goal.r;
      this.target.copy(this.goal.target); this.apply(true);
    }
    flyTo(pos, r) {
      this._fly = { t0: performance.now(), dur: RM() ? 1 : 780, fromT: this.target.clone(), toT: pos.clone(), fromR: this.sph.r, toR: r || this.sph.r * 0.62, fromTh: this.sph.theta, fromPh: this.sph.phi };
      this.goal.target.copy(pos); this.goal.r = r || this.goal.r * 0.62;
    }
    tick(dt) {
      if (this._fly) {
        const f = this._fly, u = Math.min(1, (performance.now() - f.t0) / f.dur), e = u * u * (3 - 2 * u);
        this.target.lerpVectors(f.fromT, f.toT, e);
        this.sph.r = f.fromR + (f.toR - f.fromR) * e;
        this.sph.theta = f.fromTh; this.sph.phi = f.fromPh;
        this.apply(true);
        if (u >= 1) this._fly = null;
        return;
      }
      const k = 1 - Math.pow(0.001, Math.max(0.001, dt));
      this.sph.theta += (this.goal.theta - this.sph.theta) * k;
      this.sph.phi += (this.goal.phi - this.sph.phi) * k;
      this.sph.r += (this.goal.r - this.sph.r) * k;
      this.target.lerp(this.goal.target, k);
      this.apply(true);
    }
  }

  class View3D {
    constructor(wrap, hooks) {
      this.wrap = wrap; this.hooks = hooks || {};
      this.active = false; this.ready = false; this.proj = null; this.sim = null;
      this.parts = new Map(); this.wires = new Map(); this.leds = []; this.displays = []; this.motors = []; this.servos = [];
      this.pulses = []; this._sig = ''; this._raf = 0; this._t = 0; this._idle = 0; this.flow = {}; this._last = 0;
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
      this.renderer.toneMappingExposure = 1.35;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.physicallyCorrectLights = false;

      this.scene = new THREE.Scene();
      this._makeBackdrop();
      this.camera = new THREE.PerspectiveCamera(38, w / h, 1.5, 4000);
      this.orbit = new Orbit(this.camera, this.canvas, new THREE.Vector3(200, 12, 100));

      // Studio lights
      this.scene.add(new THREE.AmbientLight(0x9aa8c0, 0.65));
      const hemi = new THREE.HemisphereLight(0xd0daf0, 0x2a2018, 0.85); this.scene.add(hemi);
      const key = new THREE.DirectionalLight(0xfff6ea, 1.85); key.position.set(220, 380, 160); key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048); key.shadow.camera.near = 10; key.shadow.camera.far = 1200;
      key.shadow.camera.left = -320; key.shadow.camera.right = 320; key.shadow.camera.top = 240; key.shadow.camera.bottom = -240;
      key.shadow.bias = -0.00015; key.shadow.normalBias = 0.5; this.scene.add(key); this.key = key;
      const fill = new THREE.DirectionalLight(0xa8c4ff, 0.85); fill.position.set(-220, 160, -120); this.scene.add(fill);
      const rim = new THREE.DirectionalLight(0x9aeeff, 0.65); rim.position.set(40, 120, -260); this.scene.add(rim);
      const kick = new THREE.PointLight(0x80d8ff, 0.9, 800, 2); kick.position.set(0, 80, 0); this.scene.add(kick); this.kick = kick;

      // Detect software GL (SwiftShader/llvmpipe) — ANGLE often masks the renderer string
      (() => {
        const gl = this.renderer.getContext();
        let info = '';
        try {
          const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
          if (dbg) info = (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') + ' ' + (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
        } catch (_) {}
        try { info += ' ' + (gl.getParameter(gl.RENDERER) || ''); } catch (_) {}
        this.softGL = /SwiftShader|llvmpipe|Software|Subzero|Microsoft Basic Render/i.test(info);
        this._glInfo = info.trim();
      })();

      // PMREM env map breaks MeshStandard lighting on SwiftShader — only on real GPUs
      if (!this.softGL) {
        try {
          const pmrem = new THREE.PMREMGenerator(this.renderer);
          const envScene = new THREE.Scene();
          const envGeo = new THREE.SphereGeometry(50, 32, 16);
          const envMat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {},
            vertexShader: 'varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.); vW=normalize(w.xyz); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
            fragmentShader: 'varying vec3 vW; void main(){ float y=vW.y*0.5+0.5; vec3 top=vec3(0.45,0.55,0.72); vec3 mid=vec3(0.08,0.10,0.16); vec3 bot=vec3(0.02,0.02,0.04); vec3 c=mix(bot,mid,smoothstep(0.0,0.45,y)); c=mix(c,top,smoothstep(0.45,1.0,y)); gl_FragColor=vec4(c,1.); }'
          });
          envScene.add(new THREE.Mesh(envGeo, envMat));
          this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
          pmrem.dispose();
        } catch (e) { /* env optional */ }
      }

      // Bloom needs float/half-float RTs; skip on soft GL (glow sprites cover LEDs)
      if (!this.softGL && root.THREE.EffectComposer && root.THREE.UnrealBloomPass) {
        try {
          const comp = new THREE.EffectComposer(this.renderer);
          comp.addPass(new THREE.RenderPass(this.scene, this.camera));
          const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 0.72, 0.55, 0.72);
          comp.addPass(bloom); this.composer = comp; this.bloom = bloom;
        } catch (e) { this.composer = null; }
      }

      // Soft GL: no shadows (broken maps → black receivers), boost fill light
      if (this.softGL) {
        this.renderer.shadowMap.enabled = false;
        if (this.key) this.key.castShadow = false;
        this.scene.add(new THREE.AmbientLight(0xb8c4d8, 0.55));
      }

      this.root = new THREE.Group(); this.scene.add(this.root);
      this.pulseRoot = new THREE.Group(); this.scene.add(this.pulseRoot);
      this.ready = true;
      this._onResize = () => this.resize();
      root.addEventListener('resize', this._onResize);
      this.canvas.addEventListener('pointerdown', (e) => { this._ptr = { x: e.clientX, y: e.clientY, t: performance.now() }; });
      this.canvas.addEventListener('pointerup', (e) => this._onPick(e));
      this._last = performance.now();
      this._loop();
    }

    _makeBackdrop() {
      const THREE = root.THREE;
      // Deep navy→black floor with faint grid fading into fog
      const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(512, 512, 40, 512, 512, 520);
      grd.addColorStop(0, '#243044'); grd.addColorStop(0.45, '#121a2a'); grd.addColorStop(1, '#080b12');
      g.fillStyle = grd; g.fillRect(0, 0, 1024, 1024);
      g.strokeStyle = 'rgba(100,140,200,0.14)'; g.lineWidth = 1;
      for (let i = 0; i <= 32; i++) {
        const p = i * 32; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 1024); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(1024, p); g.stroke();
      }
      g.strokeStyle = 'rgba(120,170,230,0.22)';
      for (let i = 0; i <= 8; i++) {
        const p = i * 128; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 1024); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(1024, p); g.stroke();
      }
      const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
      const floor = new THREE.Mesh(new THREE.CircleGeometry(1400, 64), new THREE.MeshStandardMaterial({
        map: tex, color: 0xffffff, metalness: 0.15, roughness: 0.92, envMapIntensity: 0.35
      }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = -42; floor.receiveShadow = true; this.scene.add(floor);
      this.scene.background = new THREE.Color(0x05070c);
      this.scene.fog = new THREE.FogExp2(0x070a12, 0.00028);
    }

    resize() {
      if (!this.ready) return;
      const w = Math.max(1, this.wrap.clientWidth), h = Math.max(1, this.wrap.clientHeight);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(this.dpr); this.renderer.setSize(w, h, false);
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
        o.traverse((c) => {
          if (c.geometry) c.geometry.dispose();
          if (c.material) {
            const ms = Array.isArray(c.material) ? c.material : [c.material];
            ms.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
          }
        });
      }
      while (this.pulseRoot && this.pulseRoot.children.length) {
        const o = this.pulseRoot.children[0]; this.pulseRoot.remove(o);
        if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose();
      }
      this.parts.clear(); this.wires.clear(); this.leds = []; this.displays = []; this.motors = []; this.servos = []; this.pulses = [];
    }
    _mat(opts) { return new THREE.MeshStandardMaterial(Object.assign({ metalness: 0.2, roughness: 0.45, envMapIntensity: 0.85 }, opts)); }

    rebuild(fit) {
      if (!this.ready || !this.proj) return;
      const THREE = root.THREE;
      this.clear(); this._sig = this._projectSig();
      const gParts = new THREE.Group(), gWires = new THREE.Group(); this.root.add(gParts); this.root.add(gWires);
      const box = new THREE.Box3();
      for (const p of this.proj.parts) {
        const d = root.Parts.T[p.type]; if (!d) continue;
        let mesh = null;
        try { mesh = this._makePart(p, d); } catch (err) { console.warn('3D part', p.type, err); mesh = this._makeCard(p, d); }
        if (!mesh) continue;
        const rot = (p.rot || 0) * Math.PI / 2;
        mesh.position.set(p.x, 0, p.y);
        mesh.rotation.y = -rot;
        gParts.add(mesh); this.parts.set(p.id, { mesh, part: p });
        box.expandByObject(mesh);
        if (this.softGL && p.type !== 'breadboard') {
          let rad = 10;
          try { if (d.size) { const sz = d.size(p); rad = Math.max(6, Math.max(sz.w || 0, sz.h || 0) * 0.28); } } catch (_) {}
          const sh = new THREE.Mesh(
            new THREE.CircleGeometry(rad, 18),
            new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depth: THREE.NormalBlending, depthWrite: false })
          );
          sh.rotation.x = -Math.PI / 2; sh.position.set(0, 0.12, 0); sh.renderOrder = -1; mesh.add(sh);
        }
      }
      for (const w of this.proj.wires) {
        const tube = this._makeWire(w);
        if (tube) { gWires.add(tube.group); this.wires.set(w.id, tube); box.expandByObject(tube.group); }
      }
      if (this.kick && !box.isEmpty()) {
        const c = new THREE.Vector3(); box.getCenter(c); this.kick.position.set(c.x, 90, c.z);
      }
      if (fit) {
        // Prefer framing the "action" (non-breadboard parts) so empty BB expanse doesn't push camera away
        const focus = new THREE.Box3();
        let nFocus = 0;
        for (const [, rec] of this.parts) {
          if (rec.part.type === 'breadboard') continue;
          focus.expandByObject(rec.mesh); nFocus++;
        }
        const use = (nFocus > 0 && !focus.isEmpty()) ? focus : box;
        // Pad focus slightly so nearby BB still visible
        if (nFocus > 0) {
          const pad = new THREE.Vector3(40, 20, 40);
          use.min.sub(pad); use.max.add(pad);
        }
        this.orbit.frameBox(use, 38);
      }
      this._updateLive();
    }

    /* ---------- breadboard: ivory, holes, rails, labels ---------- */
    _bbTexture(cols) {
      const W = Math.max(256, cols * 10 + 20), H = 220;
      const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
      const g = c.getContext('2d'), sx = 1024 / (W + 12), sy = 512 / 222;
      g.fillStyle = '#e8e2d4'; g.fillRect(0, 0, 1024, 512);
      const rg = g.createLinearGradient(0, 0, 0, 512);
      rg.addColorStop(0, 'rgba(255,255,255,0.25)'); rg.addColorStop(0.5, 'rgba(255,255,255,0)'); rg.addColorStop(1, 'rgba(80,60,40,0.08)');
      g.fillStyle = rg; g.fillRect(0, 0, 1024, 512);
      // rail bands
      g.fillStyle = 'rgba(0,0,0,0.04)'; g.fillRect(0, 0, 1024, 38 * sy); g.fillRect(0, 170 * sy, 1024, 38 * sy);
      // rail lines: tn(−) y0 blue, tp(+) y10 red, bp(+) y180 red, bn(−) y190 blue
      const rail = (y, col) => { g.fillStyle = col; g.fillRect(16 * sx, y * sy, (W - 20) * sx, 2.0 * sy); };
      rail(0, '#1565c0'); rail(10, '#c62828'); rail(180, '#c62828'); rail(190, '#1565c0');
      // channel
      g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(0, 91 * sy, 1024, 12 * sy);
      // labels
      g.fillStyle = 'rgba(40,40,45,0.55)'; g.font = 'bold ' + Math.max(8, 9 * sx) + 'px ui-sans-serif,system-ui,sans-serif';
      g.textAlign = 'center';
      for (let col = 1; col <= cols; col++) if (col === 1 || col % 5 === 0) {
        const x = (10 + (col - 1) * 10) * sx;
        g.fillText(String(col), x, 30 * sy); g.fillText(String(col), x, 165 * sy);
      }
      const rows = { a: 40, b: 50, c: 60, d: 70, e: 80, f: 110, g: 120, h: 130, i: 140, j: 150 };
      g.textAlign = 'left';
      for (const r in rows) { g.fillText(r, 2 * sx, rows[r] * sy + 3 * sy); g.fillText(r, (W - 2) * sx, rows[r] * sy + 3 * sy); }
      g.fillStyle = '#c62828'; g.font = 'bold ' + Math.max(10, 11 * sx) + 'px sans-serif';
      g.fillText('+', (W - 6) * sx, 14 * sy); g.fillText('+', 2 * sx, 14 * sy);
      g.fillText('+', (W - 6) * sx, 184 * sy); g.fillText('+', 2 * sx, 184 * sy);
      g.fillStyle = '#1565c0';
      g.fillText('−', (W - 6) * sx, 5 * sy); g.fillText('−', 2 * sx, 5 * sy);
      g.fillText('−', (W - 6) * sx, 195 * sy); g.fillText('−', 2 * sx, 195 * sy);
      const tex = new THREE.CanvasTexture(c); tex.anisotropy = 8; tex.encoding = THREE.sRGBEncoding; return tex;
    }
    _makeBreadboard(p, d) {
      const THREE = root.THREE, cols = p.props.cols || 63;
      // Real ~9.5 mm thick, but TOP sits at y=0 so through-hole parts (leadY≈10) rest on the surface
      const W = cols * 10 + 10, D = 200, H = 9.5 * MM;
      const g = new THREE.Group();
      const tex = this._bbTexture(cols);
      const bodyMat = this._mat({ map: tex, color: 0xffffff, roughness: 0.72, metalness: 0.05, envMapIntensity: 0.25 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(W + 4, H, D + 8), bodyMat);
      body.position.set(W / 2 - 5, -H / 2, D / 2 - 10); body.castShadow = true; body.receiveShadow = true; g.add(body);
      // slight top bevel lip at surface
      const lip = new THREE.Mesh(new THREE.BoxGeometry(W + 4.4, 0.5, D + 8.4), this._mat({ color: 0xd9d2c3, roughness: 0.65, metalness: 0.05 }));
      lip.position.set(W / 2 - 5, 0.15, D / 2 - 10); g.add(lip);
      // recessed holes (vertical cylinders into top face)
      const holes = d.pins(p);
      const holeGeo = new THREE.CylinderGeometry(1.1, 1.2, 2.2, 8);
      const holeMat = this._mat({ color: 0x1a1a1c, metalness: 0.55, roughness: 0.35, envMapIntensity: 0.8 });
      const inst = new THREE.InstancedMesh(holeGeo, holeMat, holes.length);
      const dummy = new THREE.Object3D();
      // metal clips inside body under columns
      const stripMat = this._mat({ color: 0xb8bec8, metalness: 0.9, roughness: 0.22, envMapIntensity: 1.0 });
      for (let c = 1; c <= cols; c++) {
        for (const [y0, n] of [[40, 5], [110, 5]]) {
          const strip = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.45, n * 10 - 3), stripMat);
          strip.position.set(10 + (c - 1) * 10, -H + 1.4, y0 + (n - 1) * 5); g.add(strip);
        }
      }
      holes.forEach((h, i) => {
        dummy.position.set(h.x, -0.9, h.y); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true; inst.castShadow = false; g.add(inst);
      return g;
    }

    _makeEsp32(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const boardH = 1.6 * MM;
      const pcb = new THREE.Mesh(new THREE.BoxGeometry(150, boardH, 90), this._mat({ color: 0x0b3d1e, metalness: 0.25, roughness: 0.48, envMapIntensity: 0.5 }));
      pcb.position.set(75, 10 + boardH / 2, 45); pcb.castShadow = true; pcb.receiveShadow = true; g.add(pcb);
      // silkscreen-ish edge
      const edge = new THREE.Mesh(new THREE.BoxGeometry(148, 0.15, 88), this._mat({ color: 0xdce3d8, roughness: 0.6, metalness: 0.1 }));
      edge.position.set(75, 10 + boardH + 0.1, 45); g.add(edge);
      // USB-UART
      const usb = new THREE.Mesh(new THREE.BoxGeometry(7.5 * MM, 3.2 * MM, 9 * MM), this._mat({ color: 0xcfd5dc, metalness: 0.75, roughness: 0.28 }));
      usb.position.set(-1, 10 + 2.2 * MM, 45); g.add(usb);
      // shield can
      const can = new THREE.Mesh(new THREE.BoxGeometry(25 * MM, 2.2 * MM, 18 * MM), this._mat({ color: 0xc5ccd4, metalness: 0.92, roughness: 0.18, envMapIntensity: 1.2 }));
      can.position.set(78, 10 + boardH + 1.2 * MM, 40); can.castShadow = true; g.add(can);
      // ESP die under can (hint)
      const chip = new THREE.Mesh(new THREE.BoxGeometry(7 * MM, 0.9 * MM, 7 * MM), this._mat({ color: 0x111318, metalness: 0.4, roughness: 0.4 }));
      chip.position.set(78, 10 + boardH + 0.5 * MM, 40); g.add(chip);
      // antenna region
      const ant = new THREE.Mesh(new THREE.BoxGeometry(22 * MM, 0.35 * MM, 14 * MM), this._mat({ color: 0xe8e4d6, metalness: 0.05, roughness: 0.7 }));
      ant.position.set(130, 10 + boardH + 0.2 * MM, 45); g.add(ant);
      // meander hint
      for (let i = 0; i < 5; i++) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(10, 0.2, 1.2), this._mat({ color: 0xb0a890, metalness: 0.6, roughness: 0.3 }));
        t.position.set(122 + i * 3, 10 + boardH + 0.35 * MM, 40 + (i % 2) * 6); g.add(t);
      }
      // boot LED
      const led = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 10), this._mat({ color: 0x40c4ff, emissive: 0x40c4ff, emissiveIntensity: 0 }));
      led.position.set(30, 10 + boardH + 1.5, 66); g.add(led);
      const glow = this._glowSprite(0x40c4ff); glow.position.copy(led.position); glow.scale.set(14, 14, 1); glow.visible = false; g.add(glow);
      this.leds.push({ type: 'esp32', part: p, mesh: led, light: null, glow });
      // headers
      const pinGeo = new THREE.BoxGeometry(1.0, 8.5, 1.0), pinMat = this._mat({ color: 0xd0d4da, metalness: 0.85, roughness: 0.25 });
      const plastic = this._mat({ color: 0x1a1a1e, roughness: 0.7, metalness: 0.1 });
      for (const z of [0, 90]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(148, 2.4, 2.6), plastic);
        bar.position.set(70, 10 - 0.2, z); g.add(bar);
        for (let i = 0; i < 15; i++) {
          const pin = new THREE.Mesh(pinGeo, pinMat); pin.position.set(i * 10, 6.2, z); g.add(pin);
        }
      }
      return g;
    }

    _makeResistor(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const r = (root.Parts.parseVal && root.Parts.parseVal(p.props.r)) || 1000;
      // body ~6.3×2.3 mm, leads span 40 SVG (0.4")
      const bodyLen = 6.3 * MM, bodyR = 1.15 * MM, leadY = 10;
      // leads (bent)
      const leadMat = this._mat({ color: 0xc0c4ca, metalness: 0.9, roughness: 0.22 });
      const mkLead = (x0, x1) => {
        const pts = [new THREE.Vector3(x0, 0, 0), new THREE.Vector3(x0, leadY * 0.55, 0), new THREE.Vector3(x1, leadY, 0)];
        const curve = new THREE.CatmullRomCurve3(pts);
        const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.28 * MM, 6, false), leadMat);
        g.add(mesh);
      };
      mkLead(0, bodyLen * 0.15 + 8); mkLead(40, 40 - bodyLen * 0.15 - 8);
      // body
      const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyR, bodyR, bodyLen, 20), this._mat({ color: 0xd7b27a, roughness: 0.55, metalness: 0.08 }));
      body.rotation.z = Math.PI / 2; body.position.set(20, leadY, 0); body.castShadow = true; g.add(body);
      // end caps
      for (const dx of [-bodyLen / 2 + 0.4, bodyLen / 2 - 0.4]) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(bodyR * 1.05, bodyR * 1.05, 1.2, 16), this._mat({ color: 0xb0a090, metalness: 0.35, roughness: 0.4 }));
        cap.rotation.z = Math.PI / 2; cap.position.set(20 + dx, leadY, 0); g.add(cap);
      }
      const bx = [-2.2, -0.6, 1.0, 2.6].map((v) => v * MM);
      bandsOf(r).forEach((c, i) => {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(bodyR * 1.04, bodyR * 1.04, 0.7 * MM, 16), this._mat({ color: c, roughness: 0.45, metalness: 0.05 }));
        band.rotation.z = Math.PI / 2; band.position.set(20 + bx[i], leadY, 0); g.add(band);
      });
      return g;
    }

    _glowSprite(color) {
      const THREE = root.THREE;
      const c = document.createElement('canvas'); c.width = 128; c.height = 128;
      const g = c.getContext('2d');
      const hex = ((color >>> 0) & 0xffffff);
      const r = (hex >> 16) & 255, gv = (hex >> 8) & 255, b = hex & 255;
      const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.18, 'rgba(' + r + ',' + gv + ',' + b + ',0.95)');
      grd.addColorStop(0.45, 'rgba(' + r + ',' + gv + ',' + b + ',0.45)');
      grd.addColorStop(0.75, 'rgba(' + Math.floor(r*0.5) + ',' + Math.floor(gv*0.4) + ',' + Math.floor(b*0.4) + ',0.12)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, depth: THREE.AdditiveBlending });
      return new THREE.Sprite(mat);
    }

    _makeLed(p, isIR) {
      const THREE = root.THREE, g = new THREE.Group();
      const col = isIR ? LEDCOL.ir : (LEDCOL[p.props.color] || LEDCOL.red);
      const pitch = 10, leadY = 10;
      // leads
      const leadMat = this._mat({ color: 0xc0c4ca, metalness: 0.9, roughness: 0.22 });
      for (const x of [0, pitch]) {
        const lead = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * MM, 0.25 * MM, leadY + 2, 8), leadMat);
        lead.position.set(x, leadY / 2, 0); g.add(lead);
      }
      // epoxy body: cylinder + hemispherical dome (5mm)
      const R = 2.5 * MM, bodyH = 4.5 * MM;
      const bodyMat = this._mat({ color: col, transparent: true, opacity: 0.72, roughness: 0.18, metalness: 0.05, emissive: col, emissiveIntensity: 0, envMapIntensity: 0.9 });
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R, R, bodyH, 24), bodyMat);
      cyl.position.set(pitch / 2, leadY + bodyH / 2, 0); cyl.castShadow = true; g.add(cyl);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat.clone());
      dome.position.set(pitch / 2, leadY + bodyH, 0); g.add(dome);
      // flat edge (cathode)
      const flat = new THREE.Mesh(new THREE.BoxGeometry(0.4, bodyH * 0.9, R * 1.6), bodyMat.clone());
      flat.position.set(pitch / 2 - R + 0.15, leadY + bodyH / 2, 0); g.add(flat);
      // internal die
      const die = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 0.9), this._mat({ color: 0xfff8e1, emissive: col, emissiveIntensity: 0.2, roughness: 0.4 }));
      die.position.set(pitch / 2, leadY + 1.2, 0); g.add(die);
      const light = new THREE.PointLight(col, 0, 120, 2); light.position.set(pitch / 2, leadY + bodyH + 2, 0); g.add(light);
      const glow = this._glowSprite(col); glow.position.set(pitch / 2, leadY + bodyH + 1, 0); glow.scale.set(22, 22, 1); g.add(glow);
      this.leds.push({ type: isIR ? 'irled' : 'led', part: p, mesh: dome, base: cyl, die, light, glow, flat });
      return g;
    }

    _makeButton(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const CAPS = { red: 0xe53935, green: 0x2e9e4f, blue: 0x2f6fd6, yellow: 0xf4c430, black: 0x2a2d33, white: 0xececec };
      const base = new THREE.Mesh(new THREE.BoxGeometry(12 * MM, 3.2 * MM, 12 * MM), this._mat({ color: 0xb0b6be, metalness: 0.55, roughness: 0.35 }));
      base.position.set(10, 10 + 1.6 * MM, 10); base.castShadow = true; g.add(base);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(4.2 * MM, 4.2 * MM, 2.2 * MM, 28), this._mat({ color: CAPS[p.props.color] || 0xe53935, roughness: 0.4 }));
      cap.position.set(10, 10 + 3.2 * MM + 1.1 * MM, 10); g.add(cap); g.userData.cap = cap; g.userData.capY = cap.position.y;
      return g;
    }
    _makePot(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(9.5 * MM, 6 * MM, 9.5 * MM), this._mat({ color: 0x1565c0, roughness: 0.5 }));
      body.position.set(10, 10 + 3 * MM, -6); body.castShadow = true; g.add(body);
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(3.2 * MM, 3.2 * MM, 3 * MM, 28), this._mat({ color: 0x2a2f37, metalness: 0.35, roughness: 0.4 }));
      knob.position.set(10, 10 + 6 * MM + 1.5 * MM, -6); g.add(knob);
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.6 * MM, 0.5 * MM, 3 * MM), this._mat({ color: 0xf2f2f2 }));
      tick.position.set(0, 1.2 * MM, -1.6 * MM); knob.add(tick); g.userData.knob = knob;
      return g;
    }
    _makeCap(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const cval = String(p.props.c || ''), polar = /uF|µF|electro/i.test(cval) || (+(root.Parts.parseVal && root.Parts.parseVal(cval)) >= 1e-6);
      if (polar) {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2 * MM, 3.2 * MM, 8 * MM, 24), this._mat({ color: 0x1e88e5, metalness: 0.25, roughness: 0.4 }));
        body.position.set(10, 10 + 4 * MM, 0); body.castShadow = true; g.add(body);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(3.25 * MM, 3.25 * MM, 0.6 * MM, 24), this._mat({ color: 0xd0d4da, metalness: 0.7 }));
        top.position.set(10, 10 + 8.2 * MM, 0); g.add(top);
        // sleeve print
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.28 * MM, 3.28 * MM, 1.2 * MM, 24), this._mat({ color: 0xffffff, roughness: 0.5 }));
        ring.position.set(10, 10 + 5 * MM, 0); g.add(ring);
      } else {
        const body = new THREE.Mesh(new THREE.BoxGeometry(3.2 * MM, 2.5 * MM, 1.6 * MM), this._mat({ color: 0xc4a574, roughness: 0.45, metalness: 0.15 }));
        body.position.set(10, 10 + 1.4 * MM, 0); body.castShadow = true; g.add(body);
      }
      return g;
    }
    _makeDip(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      const pins = d.pins(p), n = Math.max(8, pins.length), rows = Math.ceil(n / 2);
      const pitch = 10, bodyW = (rows - 1) * pitch + 4 * MM, bodyD = 6.2 * MM, bodyH = 3.3 * MM;
      const body = new THREE.Mesh(new THREE.BoxGeometry(bodyW, bodyH, bodyD), this._mat({ color: 0x12141a, metalness: 0.15, roughness: 0.65, envMapIntensity: 0.3 }));
      body.position.set((rows - 1) * pitch / 2, 10 + bodyH / 2, 5); body.castShadow = true; g.add(body);
      // pin-1 notch + dot
      const notch = new THREE.Mesh(new THREE.CylinderGeometry(1.1 * MM, 1.1 * MM, bodyH + 0.2, 16), this._mat({ color: 0x0a0b0e }));
      notch.rotation.x = Math.PI / 2; notch.position.set(1.2 * MM, 10 + bodyH / 2, 5); g.add(notch);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.45 * MM, 10, 8), this._mat({ color: 0xe0e0e0 }));
      dot.position.set(2.2 * MM, 10 + bodyH + 0.2, 5 - bodyD / 2 + 1.2 * MM); g.add(dot);
      // label
      const label = new THREE.Mesh(new THREE.PlaneGeometry(bodyW * 0.7, bodyD * 0.35), this._mat({ color: 0xc0c4ca, roughness: 0.55, metalness: 0.1 }));
      label.rotation.x = -Math.PI / 2; label.position.set((rows - 1) * pitch / 2, 10 + bodyH + 0.05, 5); g.add(label);
      const pinMat = this._mat({ color: 0xc5c9d0, metalness: 0.88, roughness: 0.22 });
      for (let i = 0; i < rows; i++) {
        for (const [z, side] of [[5 - bodyD / 2 - 1.5, -1], [5 + bodyD / 2 + 1.5, 1]]) {
          const pin = new THREE.Mesh(new THREE.BoxGeometry(0.5 * MM, 8, 0.25 * MM), pinMat);
          pin.position.set(i * pitch, 6, z); g.add(pin);
        }
      }
      return g;
    }
    _makeDisplay(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      const sz = d.size(p), W = Math.max(40, sz.w), H = Math.max(24, sz.h + 16);
      const pcb = new THREE.Mesh(new THREE.BoxGeometry(W, 1.6 * MM, H), this._mat({ color: 0x0d47a1, metalness: 0.25, roughness: 0.5 }));
      pcb.position.set(W / 2 - 5, 10 + 0.8 * MM, H / 2 - 8); pcb.castShadow = true; g.add(pcb);
      const c = document.createElement('canvas'); c.width = 256; c.height = 128;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#03140c'; ctx.fillRect(0, 0, 256, 128);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.78, H * 0.48), new THREE.MeshStandardMaterial({ map: tex, emissive: 0x0a3d22, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.05 }));
      screen.position.set(W / 2 - 5, 10 + 1.6 * MM + 0.15, H / 2 - 8); screen.rotation.x = -Math.PI / 2; g.add(screen);
      this.displays.push({ part: p, tex, canvas: c, ctx, screen });
      return g;
    }
    _makeMotor(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(6 * MM, 6 * MM, 12 * MM, 24), this._mat({ color: 0xb0b4ba, metalness: 0.75, roughness: 0.28 }));
      body.rotation.z = Math.PI / 2; body.position.set(12, 10 + 6 * MM, -16); body.castShadow = true; g.add(body);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(1.2 * MM, 0.6 * MM, 14 * MM), this._mat({ color: 0xeeeeee }));
      blade.position.set(12 + 7 * MM, 10 + 6 * MM, -16); g.add(blade); g.userData.rotor = blade;
      this.motors.push({ part: p, rotor: blade }); return g;
    }
    _makeServo(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(12 * MM, 11 * MM, 22 * MM), this._mat({ color: 0x1e88e5, roughness: 0.45 }));
      body.position.set(10, 10 + 5.5 * MM, -6); body.castShadow = true; g.add(body);
      const horn = new THREE.Mesh(new THREE.BoxGeometry(14 * MM, 1.2 * MM, 3 * MM), this._mat({ color: 0xf0f0f0 }));
      horn.position.set(10, 10 + 12 * MM, -6); g.add(horn); g.userData.horn = horn;
      this.servos.push({ part: p, horn }); return g;
    }
    _makeBatteryFixed(p, t) {
      const THREE = root.THREE, g = new THREE.Group();
      if (/9v|battery9v/i.test(t)) {
        const W9 = 17.5 * MM, H9 = 48.5 * MM, D9 = 26.5 * MM;
        const body = new THREE.Mesh(new THREE.BoxGeometry(W9, H9, D9), this._mat({ color: 0x2a2d33, metalness: 0.35, roughness: 0.4 }));
        body.position.set(10, 10 + H9 / 2, -8); body.castShadow = true; g.add(body);
        // chamfer-ish top/bottom caps
        for (const dy of [H9 / 2 - 0.8, -H9 / 2 + 0.8]) {
          const cap = new THREE.Mesh(new THREE.BoxGeometry(W9 * 0.98, 1.6, D9 * 0.98), this._mat({ color: 0x1a1c20, metalness: 0.4, roughness: 0.35 }));
          cap.position.set(10, 10 + H9 / 2 + dy, -8); g.add(cap);
        }
        // gold label with print
        const lc = document.createElement('canvas'); lc.width = 128; lc.height = 256;
        const lg = lc.getContext('2d');
        lg.fillStyle = '#d4a017'; lg.fillRect(0, 0, 128, 256);
        lg.fillStyle = '#1a1a1a'; lg.font = 'bold 28px sans-serif'; lg.textAlign = 'center';
        lg.fillText('9V', 64, 70); lg.font = '16px sans-serif'; lg.fillText('ALKALINE', 64, 110);
        lg.fillStyle = '#333'; lg.fillRect(24, 140, 80, 60); lg.fillStyle = '#d4a017'; lg.font = 'bold 14px sans-serif'; lg.fillText('DURACELL', 64, 175);
        const ltex = new THREE.CanvasTexture(lc); ltex.encoding = THREE.sRGBEncoding;
        const label = new THREE.Mesh(new THREE.PlaneGeometry(D9 * 0.72, H9 * 0.62), this._mat({ map: ltex, metalness: 0.35, roughness: 0.35, color: 0xffffff }));
        label.position.set(10 + W9 / 2 + 0.15, 10 + H9 / 2, -8); label.rotation.y = Math.PI / 2; g.add(label);
        // snap terminals
        const pos = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 3.2 * MM, 16), this._mat({ color: 0xd0d4da, metalness: 0.9, roughness: 0.2 }));
        pos.position.set(10 - 4 * MM, 10 + H9 + 1.6 * MM, -8); g.add(pos);
        const neg = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 1.8 * MM, 6), this._mat({ color: 0xd0d4da, metalness: 0.9, roughness: 0.2 }));
        neg.position.set(10 + 4.5 * MM, 10 + H9 + 0.9 * MM, -8); g.add(neg);
      } else {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(7 * MM, 7 * MM, 50 * MM, 28), this._mat({ color: 0x1e88e5, metalness: 0.25, roughness: 0.4 }));
        body.position.set(10, 10 + 25 * MM, 0); body.castShadow = true; g.add(body);
        const tip = new THREE.Mesh(new THREE.CylinderGeometry(2.5 * MM, 2.5 * MM, 3 * MM, 16), this._mat({ color: 0xc0c4ca, metalness: 0.85 }));
        tip.position.set(10, 10 + 51.5 * MM, 0); g.add(tip);
      }
      return g;
    }
    _makeCard(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      const sz = d.size ? d.size(p) : { w: 30, h: 20 };
      const W = Math.max(14, sz.w), D = Math.max(10, sz.h);
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
      const body = new THREE.Mesh(new THREE.BoxGeometry(W, 4 * MM, D), this._mat({ color: 0x2a3140, metalness: 0.2, roughness: 0.55, map: map || null }));
      body.position.set(W / 2 - 5, 10 + 2 * MM, D / 2 - 5); body.castShadow = true; g.add(body);
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
      if (t === 'capacitor' || t === 'ecap' || t === 'ceramic') return this._makeCap(p);
      if (t === 'ne555' || t === 'opamp' || /^74|^lm|^ne|^cd|^mcp/i.test(t) || (d.label || '').match(/DIP|IC|timer|shift/i)) return this._makeDip(p, d);
      if (/lcd|oled|tft|ssd1306|sh110|display/i.test(t)) return this._makeDisplay(p, d);
      if (t === 'motor' || t === 'dcmotor') return this._makeMotor(p);
      if (t === 'servo') return this._makeServo(p);
      if (t === 'battery' || t === 'battery9v' || t === 'coin' || t === 'vcc33' || t === 'vcc5') return this._makeBatteryFixed(p, t);
      return this._makeCard(p, d);
    }

    /* wires: thin insulated jumpers with tidy arcs + current pulses */
    _makeWire(w) {
      const THREE = root.THREE;
      const pts2 = [w.a, ...(w.pts || []), w.b];
      if (pts2.length < 2) return null;
      const boardTop = 2.2;
      // Tidy jumper: endpoints + 1–2 arc control points (ignore long 2D snakes)
      const a2 = pts2[0], b2 = pts2[pts2.length - 1];
      const A = new THREE.Vector3(a2.x, boardTop + 0.45 * MM, a2.y);
      const B = new THREE.Vector3(b2.x, boardTop + 0.45 * MM, b2.y);
      const dist = A.distanceTo(B);
      const mid = A.clone().lerp(B, 0.5);
      const side = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3(0, 1, 0));
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0); else side.normalize();
      const bow = Math.min(7, dist * 0.035);
      mid.y = boardTop + 1.4 * MM + Math.min(9, dist * 0.045);
      mid.addScaledVector(side, bow);
      let pts;
      if (dist > 90 && pts2.length >= 3) {
        // long run: two humps using a constrained mid from 2D path
        const q = pts2[Math.floor(pts2.length / 2)];
        const M = new THREE.Vector3(q.x, boardTop + 2.2 * MM, q.y);
        // pull M toward AB so we don't follow wild snakes
        const onAB = A.clone().lerp(B, 0.5);
        M.lerp(onAB, 0.55); M.y = boardTop + 2.0 * MM + Math.min(8, dist * 0.03);
        const m1 = A.clone().lerp(M, 0.5); m1.y = boardTop + 1.5 * MM;
        const m2 = M.clone().lerp(B, 0.5); m2.y = boardTop + 1.5 * MM;
        pts = [A, m1, M, m2, B];
      } else {
        pts = [A, mid, B];
      }
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.3);
      const radial = this.dpr < 1.6 ? 5 : 7;
      const segs = Math.max(16, Math.floor(curve.getLength() / 3));
      const col = WIRE_HEX[w.color] || 0x3ddc84;
      // ~0.5mm core, ~0.85mm OD insulation
      const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.15 * MM, radial, false), this._mat({ color: 0xc0c4ca, metalness: 0.85, roughness: 0.28 }));
      const ins = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.30 * MM, radial, false), this._mat({
        color: col, metalness: 0.06, roughness: 0.4, envMapIntensity: 0.55,
        emissive: col, emissiveIntensity: this.softGL ? 0.12 : 0.03
      }));
      ins.castShadow = true;
      const group = new THREE.Group(); group.add(core); group.add(ins);
      group.userData.wid = w.id; group.userData.curve = curve; group.userData.color = col;
      return { group, curve, color: col, id: w.id };
    }

    _ensurePulses() {
      const THREE = root.THREE;
      while (this.pulseRoot.children.length) {
        const o = this.pulseRoot.children[0]; this.pulseRoot.remove(o);
        if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose();
      }
      this.pulses = [];
      for (const [id, w] of this.wires) {
        const geo = new THREE.SphereGeometry(0.35 * MM, 8, 6);
        const mat = this._mat({ color: 0xffffff, emissive: 0xe6fdff, emissiveIntensity: 2.5, transparent: true, opacity: 0, roughness: 0.2 });
        const mesh = new THREE.Mesh(geo, mat);
        this.pulseRoot.add(mesh);
        this.pulses.push({ id, mesh, mat, t: Math.random(), curve: w.curve });
      }
    }

    _updateLive() {
      if (!this.sim) return;
      if (!this.pulses.length && this.wires.size) this._ensurePulses();
      for (const L of this.leds) {
        const st = this.sim.partState(L.part) || {};
        let b = st.bright || 0;
        if (L.type === 'esp32') b = (st.pinLevel && st.pinLevel[2]) ? 0.85 : 0;
        if (st.burned) b = 0;
        const setE = (m, v) => { if (m && m.material) m.material.emissiveIntensity = v; };
        setE(L.mesh, b * 2.8); setE(L.base, b * 1.6); setE(L.flat, b * 1.6); setE(L.die, 0.3 + b * 3);
        if (L.mesh && L.mesh.material) L.mesh.material.opacity = 0.55 + 0.4 * b;
        if (L.light) L.light.intensity = b * (L.type === 'irled' ? 1.2 : (this.softGL ? 5.5 : 3.6));
        if (L.glow) {
          L.glow.material.opacity = b * (this.softGL || !this.composer ? 0.85 : 0.65);
          L.glow.visible = b > 0.02;
          const s = (this.softGL ? 8 : 10) + b * (this.softGL ? 14 : 16); L.glow.scale.set(s, s, 1);
        }
      }
      for (const [id, rec] of this.parts) {
        const p = rec.part, st = this.sim.partState(p) || {};
        if (rec.mesh.userData.knob && p.props && p.props.pos != null)
          rec.mesh.userData.knob.rotation.y = (-135 + 270 * (+p.props.pos)) * Math.PI / 180;
        if (rec.mesh.userData.cap) rec.mesh.userData.cap.position.y = (rec.mesh.userData.capY || 16) - (st.pressed ? 1.2 * MM : 0);
        if (rec.mesh.userData.horn && st.angle != null) rec.mesh.userData.horn.rotation.y = (st.angle - 90) * Math.PI / 180;
      }
      for (const m of this.motors) {
        const st = this.sim.partState(m.part) || {};
        if (st.on || Math.abs(st.i || 0) > 0.01) m.rotor.rotation.x += 0.4;
      }
      for (const s of this.servos) {
        const st = this.sim.partState(s.part) || {};
        if (st.angle != null) s.horn.rotation.y = (st.angle - 90) * Math.PI / 180;
      }
      for (const d of this.displays) {
        const st = this.sim.partState(d.part) || {};
        if (st.img && st.img !== d._img) {
          d._img = st.img; const im = new Image();
          im.onload = () => { d.ctx.fillStyle = '#03140c'; d.ctx.fillRect(0, 0, d.canvas.width, d.canvas.height); d.ctx.drawImage(im, 0, 0, d.canvas.width, d.canvas.height); d.tex.needsUpdate = true; };
          im.src = st.img;
        } else if (st.txt && st.txt !== d._txt) {
          d._txt = st.txt; d.ctx.fillStyle = '#03140c'; d.ctx.fillRect(0, 0, 256, 128);
          d.ctx.fillStyle = '#7dffb0'; d.ctx.font = '20px monospace'; d.ctx.fillText(String(st.txt).slice(0, 32), 12, 40); d.tex.needsUpdate = true;
        }
      }
    }

    _updatePulses(dt) {
      if (RM() || !this.pulses.length) return;
      for (const p of this.pulses) {
        const f = this.flow[p.id] || { i: 0 }; const mag = Math.abs(f.i || 0);
        if (mag < 1e-6) { p.mat.opacity = 0; continue; }
        const speed = Math.max(0.15, Math.min(1.8, Math.sqrt(mag * 600) + 0.2));
        const dir = f.i >= 0 ? 1 : -1;
        p.t = (p.t + dt * speed * dir + 1) % 1;
        const pos = p.curve.getPointAt((p.t + 1) % 1);
        p.mesh.position.copy(pos);
        p.mat.opacity = Math.min(0.95, 0.35 + Math.log10(mag * 1e6 + 1) * 0.2);
        p.mat.emissiveIntensity = 1.5 + Math.min(3, mag * 80);
        const s = 0.35 * MM * (1 + Math.min(1.2, mag * 35));
        p.mesh.scale.setScalar(s / (0.35 * MM));
      }
    }

    _onPick(e) {
      if (!this.active || !this.ready || !this.orbit || this.orbit.moved) return;
      if (this._ptr && performance.now() - this._ptr.t > 400) return;
      const THREE = root.THREE;
      const rect = this.canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(mouse, this.camera);
      const wireMeshes = [...this.wires.values()].map((w) => w.group);
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
        for (const [id, rec] of this.parts) {
          let found = false; rec.mesh.traverse((c) => { if (c === hits[0].object) found = true; });
          if (found) {
            const world = new THREE.Vector3(); rec.mesh.getWorldPosition(world);
            this.orbit.flyTo(world, Math.max(110, this.orbit.sph.r * 0.55));
            if (this.hooks.onPart) this.hooks.onPart(id, e);
            return;
          }
        }
      }
    }

    _loop() {
      const step = (now) => {
        this._raf = requestAnimationFrame(step);
        if (!this.ready || !this.active) return;
        const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now; this._t += dt;
        if (this.orbit) {
          this.orbit.tick(dt);
          if (!this.orbit.dragging && !this.orbit._fly && !RM()) {
            this._idle += dt;
            if (this._idle > 3) this.orbit.goal.theta += 0.00055;
          } else this._idle = 0;
        }
        this._updatePulses(dt);
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
