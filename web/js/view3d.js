/* WebGL 3D circuit view — product-render polish. 2D SVG remains the editor.
 * Scale: 2D G=10 = 0.1" = 2.54 mm → 1 SVG unit = 0.254 mm. Soft-GL safe. */
(function (root) {
  const WIRE_HEX = { green: 0x2ecc71, red: 0xe74c3c, black: 0x1c1c1e, blue: 0x3498db, yellow: 0xf1c40f, orange: 0xe67e22, white: 0xecf0f1, purple: 0x9b59b6, gray: 0x7f8c8d, brown: 0x6d4c41 };
  const BANDC = [0x111111, 0x6d4c41, 0xe53935, 0xfb8c00, 0xfdd835, 0x43a047, 0x1e88e5, 0x8e24aa, 0x9e9e9e, 0xfafafa];
  const LEDCOL = { red: 0xff1744, green: 0x00e676, blue: 0x2979ff, yellow: 0xffea00, white: 0xf5f7ff, orange: 0xff9100, ir: 0xb388ff };
  const MM = 1 / 0.254;
  const WIRE_R = 0.28 * MM; // ~0.7 mm OD insulation (AWG22-ish jumper)
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

  class Orbit {
    constructor(cam, el, target) {
      this.cam = cam; this.el = el; this.target = target.clone();
      this.sph = { theta: 0.70, phi: 1.05, r: 280 };
      this.goal = { theta: 0.70, phi: 1.05, r: 280, target: target.clone() };
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
          this.goal.phi = Math.max(0.22, Math.min(Math.PI * 0.46, this.goal.phi + dy * 0.0045));
        }
      });
      const end = () => { this.dragging = false; this.last = null; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      el.addEventListener('wheel', (e) => {
        if (!this.enabled) return; e.preventDefault(); this._fly = null;
        this.goal.r = Math.max(60, Math.min(1200, this.goal.r * (e.deltaY > 0 ? 1.07 : 0.93)));
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
          this.goal.r = Math.max(60, Math.min(1200, this.pinch0.r * (this.pinch0.dist / Math.max(10, dist))));
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const s = this.goal.r * 0.0012;
          const right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
          right.crossVectors(this.cam.getWorldDirection(new THREE.Vector3()), up).normalize();
          this.goal.target.copy(this.pinch0.target).addScaledVector(right, -(mid.x - this.pinch0.mid.x) * s).addScaledVector(up, (mid.y - this.pinch0.mid.y) * s);
        }
      }, { passive: false });
      el.addEventListener('touchend', (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); if (touches.size < 2) this.pinch0 = null; }, { passive: true });
    }
    apply() {
      const { theta, phi, r } = this.sph, t = this.target;
      this.cam.position.set(t.x + r * Math.sin(phi) * Math.sin(theta), t.y + r * Math.cos(phi), t.z + r * Math.sin(phi) * Math.cos(theta));
      this.cam.lookAt(t);
    }
    frameBox(box, angleDeg) {
      if (!box || box.isEmpty()) return;
      const c = new THREE.Vector3(); box.getCenter(c);
      const size = new THREE.Vector3(); box.getSize(size);
      const span = Math.max(size.x, size.z, 40);
      this.goal.target.set(c.x, Math.max(8, Math.min(14, size.y * 0.1 + 5)), c.z);
      this.goal.theta = (angleDeg != null ? angleDeg : 40) * Math.PI / 180;
      this.goal.phi = 1.10;
      const vfov = (this.cam.fov || 40) * Math.PI / 180;
      // Fit the narrower of vertical/horizontal FOV so portrait phones don't open inside the breadboard
      const hfov = 2 * Math.atan(Math.tan(vfov * 0.5) * Math.max(0.2, this.cam.aspect || 1));
      const fov = Math.min(vfov, hfov);
      const fit = (span * 0.52) / Math.max(0.12, Math.tan(fov * 0.5));
      this.goal.r = Math.max(110, Math.min(1100, fit * 1.08 + 30));
      this.sph.theta = this.goal.theta; this.sph.phi = this.goal.phi; this.sph.r = this.goal.r;
      this.target.copy(this.goal.target); this.apply();
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
        this.apply();
        if (u >= 1) this._fly = null;
        return;
      }
      const k = 1 - Math.pow(0.001, Math.max(0.001, dt));
      this.sph.theta += (this.goal.theta - this.sph.theta) * k;
      this.sph.phi += (this.goal.phi - this.sph.phi) * k;
      this.sph.r += (this.goal.r - this.sph.r) * k;
      this.target.lerp(this.goal.target, k);
      this.apply();
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
      this._virtualBB = false;
    }

    async init() {
      if (this.ready) return;
      const THREE = await ensureThree();
      const w = this.wrap.clientWidth || 800, h = this.wrap.clientHeight || 500;
      this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._lost = true; this._fail(new Error('WebGL context lost')); }, false);
      this.canvas.addEventListener('webglcontextrestored', () => { this._lost = false; }, false);
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      this.renderer.setClearColor(0x0a0b0e, 1);
      this.dpr = Math.min(root.devicePixelRatio || 1, /Mobi|Android/i.test(navigator.userAgent) ? 1.5 : 2);
      this.renderer.setPixelRatio(this.dpr);
      this.renderer.setSize(w, h, false);
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.28;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.physicallyCorrectLights = false;

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(40, w / h, 1.2, 5000);
      this.orbit = new Orbit(this.camera, this.canvas, new THREE.Vector3(200, 10, 100));

      // Soft-GL detect (ANGLE masks RENDERER)
      (() => {
        const gl = this.renderer.getContext();
        let info = '';
        try {
          const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
          if (dbg) info = (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') + ' ' + (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
        } catch (_) {}
        try { info += ' ' + (gl.getParameter(gl.RENDERER) || ''); } catch (_) {}
        this.softGL = /SwiftShader|llvmpipe|Software|Subzero|Microsoft Basic Render/i.test(info);
        // ?gl3d=hw forces the real-GPU render path (bloom/PMREM/shadows) for testing under SwiftShader
        const q = (root.location && root.location.search) || '';
        if (/[?&]gl3d=hw\b/.test(q)) this.softGL = false;
        if (/[?&]gl3d=soft\b/.test(q)) this.softGL = true;
        // HOTFIX: the real-GPU "fx" path (PMREM env + UnrealBloom composer + shadows) renders a blank
        // (NaN → white on many mobile/desktop GPUs, empty under SwiftShader). Use the verified safe path
        // everywhere; the fx path is opt-in with ?fx3d=1 for further work.
        this.gpuFx = !this.softGL && /[?&]fx3d=1\b/.test(q);
        this.realGPU = !this.softGL;
        if (!this.gpuFx) this.softGL = true;
        this._glInfo = info.trim();
      })();

      this._makeStudio();

      // Lights
      this.scene.add(new THREE.AmbientLight(0xb0b8c8, this.softGL ? 0.72 : 0.38));
      const hemi = new THREE.HemisphereLight(0xdde6f5, 0x1a1410, this.softGL ? 0.75 : 0.45); this.scene.add(hemi);
      const key = new THREE.DirectionalLight(0xfff4e6, this.softGL ? 1.55 : 1.9);
      key.position.set(180, 320, 140);
      if (!this.softGL) {
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.near = 10; key.shadow.camera.far = 1400;
        key.shadow.camera.left = -400; key.shadow.camera.right = 400;
        key.shadow.camera.top = 300; key.shadow.camera.bottom = -300;
        key.shadow.bias = -0.0002; key.shadow.normalBias = 0.6;
      } else {
        this.renderer.shadowMap.enabled = false;
      }
      this.scene.add(key); this.key = key;
      const fill = new THREE.DirectionalLight(0x9eb6ff, this.softGL ? 0.7 : 0.55); fill.position.set(-200, 140, -100); this.scene.add(fill);
      const rim = new THREE.DirectionalLight(0x7ad7ff, this.softGL ? 0.55 : 0.7); rim.position.set(30, 100, -240); this.scene.add(rim);
      const kick = new THREE.PointLight(0xffe0c0, this.softGL ? 0.55 : 0.4, 900, 2); kick.position.set(0, 70, 0); this.scene.add(kick); this.kick = kick;

      // PMREM only on real GPU
      if (!this.softGL) {
        try {
          const pmrem = new THREE.PMREMGenerator(this.renderer);
          const envScene = new THREE.Scene();
          const envMat = new THREE.ShaderMaterial({
            side: THREE.BackSide, uniforms: {},
            vertexShader: 'varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.); vW=normalize(w.xyz); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
            fragmentShader: 'varying vec3 vW; void main(){ float y=vW.y*0.5+0.5; vec3 top=vec3(0.35,0.40,0.50); vec3 mid=vec3(0.05,0.055,0.07); vec3 bot=vec3(0.01,0.01,0.015); vec3 c=mix(bot,mid,smoothstep(0.0,0.5,y)); c=mix(c,top,smoothstep(0.5,1.0,y)); gl_FragColor=vec4(c,1.); }'
          });
          envScene.add(new THREE.Mesh(new THREE.SphereGeometry(40, 24, 12), envMat));
          this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
          pmrem.dispose();
        } catch (_) {}
        if (root.THREE.EffectComposer && root.THREE.UnrealBloomPass) {
          try {
            const comp = new THREE.EffectComposer(this.renderer);
            comp.addPass(new THREE.RenderPass(this.scene, this.camera));
            const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 0.85, 0.5, 0.68);
            comp.addPass(bloom); this.composer = comp; this.bloom = bloom;
          } catch (_) { this.composer = null; }
        }
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

    _makeStudio() {
      const THREE = root.THREE;
      // Deep charcoal backdrop — no blue grid
      this.scene.background = new THREE.Color(0x0a0b0e);
      this.scene.fog = new THREE.FogExp2(0x0a0b0e, 0.00055);

      // Soft radial floor (charcoal, faint vignette feel)
      const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(512, 512, 30, 512, 512, 500);
      grd.addColorStop(0, '#14161c');
      grd.addColorStop(0.4, '#0c0d11');
      grd.addColorStop(0.8, '#07080a');
      grd.addColorStop(1, '#040506');
      g.fillStyle = grd; g.fillRect(0, 0, 1024, 1024);
      // extremely faint concentric rings (studio plate)
      g.strokeStyle = 'rgba(255,255,255,0.025)'; g.lineWidth = 1;
      for (let i = 1; i <= 8; i++) {
        g.beginPath(); g.arc(512, 512, i * 55, 0, Math.PI * 2); g.stroke();
      }
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(1600, 64),
        new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, metalness: 0.08, roughness: 0.95, envMapIntensity: 0.2 })
      );
      floor.rotation.x = -Math.PI / 2; floor.position.y = -1.2; floor.receiveShadow = true;
      this.scene.add(floor); this.floor = floor;
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
      this._virtualBB = false;
    }
    _mat(opts) {
      return new THREE.MeshStandardMaterial(Object.assign({ metalness: 0.18, roughness: 0.48, envMapIntensity: this.softGL ? 0.15 : 0.85 }, opts));
    }
    _shadowDisc(rad) {
      const THREE = root.THREE;
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(rad, 24),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depth: THREE.NormalBlending, depthWrite: false })
      );
      m.rotation.x = -Math.PI / 2; m.position.y = 0.08; m.renderOrder = -1;
      return m;
    }

    rebuild(fit) {
      if (!this.ready || !this.proj) return;
      const THREE = root.THREE;
      this.clear(); this._sig = this._projectSig();
      const gParts = new THREE.Group(), gWires = new THREE.Group(); this.root.add(gParts); this.root.add(gWires);
      const box = new THREE.Box3();
      let hasBB = this.proj.parts.some((p) => p.type === 'breadboard');

      // Virtual breadboard / acrylic under floating schematic circuits
      if (!hasBB) {
        const virt = this._makeVirtualBoard(this.proj.parts);
        if (virt) {
          gParts.add(virt.mesh);
          box.expandByObject(virt.mesh);
          this._virtualBB = true;
          hasBB = true;
        }
      }

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
        if (p.type !== 'breadboard') {
          try {
            const sz = d.size ? d.size(p) : { w: 24, h: 20 };
            mesh.add(this._shadowDisc(Math.max(6, Math.max(sz.w || 20, sz.h || 20) * 0.32)));
          } catch (_) { mesh.add(this._shadowDisc(10)); }
        }
      }
      for (const w of this.proj.wires) {
        const tube = this._makeWire(w, hasBB);
        if (tube) { gWires.add(tube.group); this.wires.set(w.id, tube); box.expandByObject(tube.group); }
      }
      if (this.kick && !box.isEmpty()) {
        const c = new THREE.Vector3(); box.getCenter(c); this.kick.position.set(c.x, 70, c.z);
      }
      if (fit) {
        const focus = new THREE.Box3();
        let n = 0;
        for (const [, rec] of this.parts) {
          if (rec.part.type === 'breadboard') continue;
          focus.expandByObject(rec.mesh); n++;
        }
        const use = (n > 0 && !focus.isEmpty()) ? focus : box;
        if (n > 0) { const pad = new THREE.Vector3(55, 20, 55); use.min.sub(pad); use.max.add(pad); }
        // also expand by virtual board lightly so floor shows
        this.orbit.frameBox(use, 40);
      }
      this._updateLive();
    }

    /* ---- Virtual acrylic/breadboard for schematic circuits ---- */
    _makeVirtualBoard(parts) {
      const THREE = root.THREE;
      if (!parts.length) return null;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of parts) {
        const d = root.Parts.T[p.type]; if (!d) continue;
        let w = 40, h = 30;
        try { const sz = d.size(p); w = sz.w || 40; h = sz.h || 30; } catch (_) {}
        minX = Math.min(minX, p.x - 20); maxX = Math.max(maxX, p.x + w + 20);
        minZ = Math.min(minZ, p.y - 20); maxZ = Math.max(maxZ, p.y + h + 20);
      }
      // Snap to ~0.1" pitch aesthetic; pad to look like a protoboard
      const pad = 28;
      minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
      // snap extents to 0.1" pitch
      minX = Math.floor(minX / 10) * 10; maxX = Math.ceil(maxX / 10) * 10;
      minZ = Math.floor(minZ / 10) * 10; maxZ = Math.ceil(maxZ / 10) * 10;
      const W = maxX - minX, D = maxZ - minZ;
      if (!(W > 40 && D > 40)) return null;

      const g = new THREE.Group();
      const cols = Math.max(12, Math.round(W / 10));
      const tex = this._bbTexture(cols);
      const H = 9.5 * MM;
      const sideMat = this._mat({ color: 0xe0d8c8, roughness: 0.75, metalness: 0.04 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), sideMat);
      body.position.set(minX + W / 2, -H / 2, minZ + D / 2);
      body.castShadow = true; body.receiveShadow = true; g.add(body);
      // Top face with breadboard texture (UV correct)
      const top = new THREE.Mesh(
        new THREE.PlaneGeometry(W - 0.5, D - 0.5),
        this._mat({ map: tex, color: 0xffffff, roughness: 0.68, metalness: 0.04 })
      );
      top.rotation.x = -Math.PI / 2; top.position.set(minX + W / 2, 0.05, minZ + D / 2); top.receiveShadow = true; g.add(top);
      // denser recessed holes
      const holeMat = this._mat({ color: 0x1a1a1c, metalness: 0.5, roughness: 0.4 });
      const holeGeo = new THREE.CylinderGeometry(1.05, 1.15, 1.6, 8);
      const step = 10;
      for (let x = minX + 10; x < maxX; x += step) {
        for (let z = minZ + 10; z < maxZ; z += step) {
          const hole = new THREE.Mesh(holeGeo, holeMat);
          hole.position.set(x, 0.05, z); g.add(hole);
        }
      }
      g.userData.virtualBB = true;
      return { mesh: g, minX, maxX, minZ, maxZ };
    }

    _bbTexture(cols) {
      const THREE = root.THREE;
      const W = Math.max(256, cols * 10 + 20);
      const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
      const g = c.getContext('2d'), sx = 1024 / (W + 12), sy = 512 / 222;
      g.fillStyle = '#ebe4d6'; g.fillRect(0, 0, 1024, 512);
      const rg = g.createLinearGradient(0, 0, 0, 512);
      rg.addColorStop(0, 'rgba(255,255,255,0.28)'); rg.addColorStop(0.5, 'rgba(255,255,255,0)'); rg.addColorStop(1, 'rgba(60,45,30,0.1)');
      g.fillStyle = rg; g.fillRect(0, 0, 1024, 512);
      g.fillStyle = 'rgba(0,0,0,0.045)'; g.fillRect(0, 0, 1024, 38 * sy); g.fillRect(0, 170 * sy, 1024, 38 * sy);
      const rail = (y, col) => { g.fillStyle = col; g.fillRect(16 * sx, y * sy, (W - 20) * sx, 2.2 * sy); };
      rail(0, '#1565c0'); rail(10, '#c62828'); rail(180, '#c62828'); rail(190, '#1565c0');
      g.fillStyle = 'rgba(0,0,0,0.07)'; g.fillRect(0, 91 * sy, 1024, 14 * sy);
      // hole dots — high contrast so readable from camera distance
      for (let col = 1; col <= cols; col++) {
        const x = (10 + (col - 1) * 10) * sx;
        for (const y of [0, 10, 40, 50, 60, 70, 80, 110, 120, 130, 140, 150, 180, 190]) {
          g.fillStyle = 'rgba(0,0,0,0.18)';
          g.beginPath(); g.arc(x, y * sy + 2, 2.8 * sx, 0, Math.PI * 2); g.fill();
          g.fillStyle = 'rgba(15,15,18,0.75)';
          g.beginPath(); g.arc(x, y * sy + 2, 1.7 * sx, 0, Math.PI * 2); g.fill();
        }
      }
      g.fillStyle = 'rgba(40,40,45,0.5)'; g.font = 'bold ' + Math.max(8, 9 * sx) + 'px ui-sans-serif,system-ui,sans-serif';
      g.textAlign = 'center';
      for (let col = 1; col <= cols; col++) if (col === 1 || col % 5 === 0) {
        const x = (10 + (col - 1) * 10) * sx;
        g.fillText(String(col), x, 28 * sy); g.fillText(String(col), x, 164 * sy);
      }
      const tex = new THREE.CanvasTexture(c); tex.anisotropy = 8; tex.encoding = THREE.sRGBEncoding;
      return tex;
    }

    _makeBreadboard(p, d) {
      const THREE = root.THREE, cols = p.props.cols || 63;
      const W = cols * 10 + 10, D = 200, H = 9.5 * MM;
      const g = new THREE.Group();
      const tex = this._bbTexture(cols);
      const body = new THREE.Mesh(new THREE.BoxGeometry(W + 4, H, D + 8), this._mat({ color: 0xe0d8c8, roughness: 0.75, metalness: 0.04 }));
      body.position.set(W / 2 - 5, -H / 2, D / 2 - 10); body.castShadow = true; body.receiveShadow = true; g.add(body);
      const top = new THREE.Mesh(new THREE.PlaneGeometry(W + 3.5, D + 7.5), this._mat({ map: tex, color: 0xffffff, roughness: 0.68, metalness: 0.04 }));
      top.rotation.x = -Math.PI / 2; top.position.set(W / 2 - 5, 0.05, D / 2 - 10); top.receiveShadow = true; g.add(top);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(W + 4.4, 0.45, D + 8.4), this._mat({ color: 0xd9d2c3, roughness: 0.65 }));
      lip.position.set(W / 2 - 5, 0.28, D / 2 - 10); g.add(lip);
      const holes = d.pins(p);
      const holeGeo = new THREE.CylinderGeometry(1.15, 1.25, 1.4, 8);
      const holeMat = this._mat({ color: 0x1a1a1c, metalness: 0.55, roughness: 0.35 });
      const inst = new THREE.InstancedMesh(holeGeo, holeMat, holes.length);
      const dummy = new THREE.Object3D();
      holes.forEach((h, i) => {
        // Slightly proud of the top plane so soft-GL shows real hole recesses
        dummy.position.set(h.x, 0.05, h.y); dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true; g.add(inst);
      return g;
    }

    _espPcbTex() {
      const THREE = root.THREE;
      const c = document.createElement('canvas'); c.width = 512; c.height = 320;
      const g = c.getContext('2d');
      g.fillStyle = '#0d5c2e'; g.fillRect(0, 0, 512, 320);
      // copper pour hint
      g.fillStyle = 'rgba(184,115,51,0.12)'; g.fillRect(0, 0, 512, 320);
      // silkscreen
      g.fillStyle = '#e8e8e0'; g.font = 'bold 22px monospace';
      g.fillText('ESP32', 200, 40); g.font = '14px monospace';
      g.fillText('DevKit V1', 195, 60);
      g.font = '11px monospace';
      const left = ['3V3','EN','VP','VN','34','35','32','33','25','26','27','14','12','GND','13','D2','D15'];
      const right = ['VIN','GND','D23','D22','TX','RX','D21','D19','D18','D5','D4','D0','D16','D17','D15','D2','D13'];
      left.forEach((n, i) => { g.fillText(n, 18, 28 + i * 16); });
      right.forEach((n, i) => { g.textAlign = 'right'; g.fillText(n, 495, 28 + i * 16); g.textAlign = 'left'; });
      // antenna region
      g.fillStyle = '#d8d4c4'; g.fillRect(380, 200, 110, 90);
      g.strokeStyle = '#b0a890'; g.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        g.strokeRect(390 + i * 4, 210 + (i % 2) * 20, 40, 8);
      }
      // USB silkscreen
      g.fillStyle = '#222'; g.fillRect(8, 140, 50, 40);
      g.fillStyle = '#ccc'; g.font = '9px monospace'; g.fillText('USB', 18, 164);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 4;
      return tex;
    }

    _makeEsp32(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const boardH = 1.6 * MM;
      const pcbW = 28.0 * MM, pcbD = 51.5 * MM; // ~DOIT DevKit footprint in mm → SVG
      // Use 2D layout size (150x110) as board footprint for pin alignment
      const W = 150, D = 90;
      const tex = this._espPcbTex();
      const pcb = new THREE.Mesh(
        new THREE.BoxGeometry(W - 10, boardH, D),
        this._mat({ map: tex, color: 0xffffff, metalness: 0.15, roughness: 0.55 })
      );
      pcb.position.set(W / 2 - 5, boardH / 2 + 0.2, D / 2 - 5); pcb.castShadow = true; pcb.receiveShadow = true; g.add(pcb);

      // ESP32 module metal can
      const can = new THREE.Mesh(
        new THREE.BoxGeometry(18 * MM, 2.2 * MM, 25.5 * MM),
        this._mat({ color: 0x2a2d32, metalness: 0.85, roughness: 0.28 })
      );
      can.position.set(55, boardH + 1.2 * MM, 40); can.castShadow = true; g.add(can);
      // can vents
      for (let i = 0; i < 4; i++) {
        const v = new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 8), this._mat({ color: 0x111214, metalness: 0.5, roughness: 0.5 }));
        v.position.set(48 + i * 4, boardH + 2.3 * MM, 40); g.add(v);
      }
      // antenna meander region
      const ant = new THREE.Mesh(new THREE.BoxGeometry(22 * MM, 0.3 * MM, 14 * MM), this._mat({ color: 0xe8e4d6, roughness: 0.7, metalness: 0.05 }));
      ant.position.set(120, boardH + 0.25 * MM, 42); g.add(ant);

      // USB micro connector
      const usb = new THREE.Mesh(new THREE.BoxGeometry(8 * MM, 2.5 * MM, 5.5 * MM), this._mat({ color: 0xc0c4ca, metalness: 0.8, roughness: 0.25 }));
      usb.position.set(8, boardH + 1.2 * MM, 45); g.add(usb);
      const usbInner = new THREE.Mesh(new THREE.BoxGeometry(5 * MM, 1.2 * MM, 3 * MM), this._mat({ color: 0x111111 }));
      usbInner.position.set(6.5, boardH + 1.2 * MM, 45); g.add(usbInner);

      // Reset / Boot buttons
      for (const [x, z, label] of [[35, 12, 'RST'], [35, 78, 'BOOT']]) {
        const base = new THREE.Mesh(new THREE.BoxGeometry(4 * MM, 1.2 * MM, 3 * MM), this._mat({ color: 0x222428, roughness: 0.55 }));
        base.position.set(x, boardH + 0.7 * MM, z); g.add(base);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.1 * MM, 1.1 * MM, 0.8 * MM, 16), this._mat({ color: 0xeeeeee, roughness: 0.4 }));
        cap.position.set(x, boardH + 1.5 * MM, z); g.add(cap);
      }

      // Onboard LED
      const led = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 10), this._mat({ color: 0x40c4ff, emissive: 0x40c4ff, emissiveIntensity: 0 }));
      led.position.set(48, boardH + 1.4 * MM, 72); g.add(led);
      const glow = this._glowSprite(0x40c4ff); glow.position.copy(led.position); glow.scale.setScalar(10); glow.visible = false; g.add(glow);
      this.leds.push({ type: 'esp32', part: p, mesh: led, light: null, glow });

      // Header pins (2×15)
      const pinMat = this._mat({ color: 0xd0d4da, metalness: 0.9, roughness: 0.22 });
      const plastic = this._mat({ color: 0x1a1a1e, roughness: 0.7 });
      for (const z of [2, 88]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(148, 2.2, 2.4), plastic);
        bar.position.set(70, -0.3, z); g.add(bar);
        for (let i = 0; i < 15; i++) {
          const pin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 9.5, 0.9), pinMat);
          pin.position.set(i * 10, 4.2, z); g.add(pin);
        }
      }
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
      grd.addColorStop(0.12, 'rgba(' + r + ',' + gv + ',' + b + ',1)');
      grd.addColorStop(0.35, 'rgba(' + r + ',' + gv + ',' + b + ',0.7)');
      grd.addColorStop(0.65, 'rgba(' + Math.floor(r * 0.6) + ',' + Math.floor(gv * 0.35) + ',' + Math.floor(b * 0.35) + ',0.28)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(c);
      // Additive vanishes on white breadboards under soft-GL — use Normal there
      const blend = this.softGL ? THREE.NormalBlending : THREE.AdditiveBlending;
      const mat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, blending: blend, depthWrite: false, opacity: 0, depth: blend });
      return new THREE.Sprite(mat);
    }

    _makeLed(p, isIR) {
      const THREE = root.THREE, g = new THREE.Group();
      const col = isIR ? LEDCOL.ir : (LEDCOL[p.props.color] || LEDCOL.red);
      const pitch = 10, leadY = 10;
      const leadMat = this._mat({ color: 0xc0c4ca, metalness: 0.9, roughness: 0.22 });
      for (const x of [0, pitch]) {
        const lead = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * MM, 0.22 * MM, leadY + 2, 8), leadMat);
        lead.position.set(x, leadY / 2, 0); g.add(lead);
      }
      const R = 2.5 * MM, bodyH = 5.0 * MM;
      const bodyMat = this._mat({ color: col, transparent: true, opacity: 0.78, roughness: 0.15, metalness: 0.05, emissive: col, emissiveIntensity: 0 });
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R, R, bodyH, 28), bodyMat);
      cyl.position.set(pitch / 2, leadY + bodyH / 2, 0); cyl.castShadow = true; g.add(cyl);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat.clone());
      dome.position.set(pitch / 2, leadY + bodyH, 0); g.add(dome);
      const flat = new THREE.Mesh(new THREE.BoxGeometry(0.35, bodyH * 0.85, R * 1.5), bodyMat.clone());
      flat.position.set(pitch / 2 - R + 0.12, leadY + bodyH / 2, 0); g.add(flat);
      const die = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.35, 0.8), this._mat({ color: 0xfff8e1, emissive: col, emissiveIntensity: 0.25, roughness: 0.4 }));
      die.position.set(pitch / 2, leadY + 1.3, 0); g.add(die);
      // Point light for spill onto breadboard
      const light = new THREE.PointLight(col, 0, 90, 2); light.position.set(pitch / 2, leadY + bodyH + 3, 0); g.add(light);
      const glow = this._glowSprite(col); glow.position.set(pitch / 2, leadY + bodyH + 1.5, 0); glow.scale.setScalar(18); glow.renderOrder = 5; g.add(glow);
      const glow2 = this._glowSprite(col); glow2.position.set(pitch / 2, leadY + bodyH + 1.0, 0); glow2.scale.setScalar(36); glow2.renderOrder = 4; g.add(glow2);
      // Spill disc on floor/board (soft-GL substitute for GI)
      const spill = new THREE.Mesh(
        new THREE.CircleGeometry(18, 28),
        new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: 0, depthWrite: false,
          blending: this.softGL ? THREE.NormalBlending : THREE.AdditiveBlending
        })
      );
      spill.rotation.x = -Math.PI / 2; spill.position.set(pitch / 2, 0.25, 0); spill.renderOrder = 3; g.add(spill);
      this.leds.push({ type: isIR ? 'irled' : 'led', part: p, mesh: dome, base: cyl, die, light, glow, glow2, flat, spill });
      return g;
    }

    _makeResistor(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const r = (root.Parts.parseVal && root.Parts.parseVal(p.props.r)) || 1000;
      const bodyLen = 6.3 * MM, bodyR = 1.15 * MM, leadY = 10;
      const leadMat = this._mat({ color: 0xc0c4ca, metalness: 0.9, roughness: 0.22 });
      const mkLead = (x0, x1) => {
        const pts = [new THREE.Vector3(x0, 0, 0), new THREE.Vector3(x0, leadY * 0.55, 0), new THREE.Vector3(x1, leadY, 0)];
        g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.25 * MM, 6, false), leadMat));
      };
      mkLead(0, bodyLen * 0.15 + 8); mkLead(40, 40 - bodyLen * 0.15 - 8);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyR, bodyR, bodyLen, 20), this._mat({ color: 0xd7b27a, roughness: 0.55, metalness: 0.08 }));
      body.rotation.z = Math.PI / 2; body.position.set(20, leadY, 0); body.castShadow = true; g.add(body);
      for (const dx of [-bodyLen / 2 + 0.4, bodyLen / 2 - 0.4]) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(bodyR * 1.05, bodyR * 1.05, 1.2, 16), this._mat({ color: 0xb0a090, metalness: 0.35, roughness: 0.4 }));
        cap.rotation.z = Math.PI / 2; cap.position.set(20 + dx, leadY, 0); g.add(cap);
      }
      const bx = [-2.2, -0.6, 1.0, 2.6].map((v) => v * MM);
      bandsOf(r).forEach((c, i) => {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(bodyR * 1.04, bodyR * 1.04, 0.7 * MM, 16), this._mat({ color: c, roughness: 0.45 }));
        band.rotation.z = Math.PI / 2; band.position.set(20 + bx[i], leadY, 0); g.add(band);
      });
      return g;
    }

    _makeDip(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      const pins = d.pins(p);
      const n = pins.length, rows = n / 2, pitch = 10;
      const bodyW = (rows - 1) * pitch + 4, bodyH = 3.3 * MM, bodyD = 6.5 * MM;
      const body = new THREE.Mesh(new THREE.BoxGeometry(bodyW, bodyH, bodyD), this._mat({ color: 0x1a1a1e, roughness: 0.72, metalness: 0.08 }));
      body.position.set((rows - 1) * pitch / 2, 10 + bodyH / 2, 5); body.castShadow = true; g.add(body);
      // pin-1 notch + dot
      const notch = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, bodyH + 0.1, 16, 1, false, 0, Math.PI), this._mat({ color: 0x0e0e10 }));
      notch.rotation.z = Math.PI / 2; notch.position.set(-1.5, 10 + bodyH / 2, 5); g.add(notch);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), this._mat({ color: 0xe0e0e0 }));
      dot.position.set(2, 10 + bodyH + 0.3, 5 - bodyD / 2 + 1.5); g.add(dot);
      // label
      const lc = document.createElement('canvas'); lc.width = 256; lc.height = 64;
      const lg = lc.getContext('2d'); lg.fillStyle = '#1a1a1e'; lg.fillRect(0, 0, 256, 64);
      lg.fillStyle = '#c8c8c0'; lg.font = 'bold 28px monospace'; lg.textAlign = 'center';
      lg.fillText((d.label || p.type || 'IC').toString().slice(0, 12).toUpperCase(), 128, 40);
      const ltex = new THREE.CanvasTexture(lc); ltex.encoding = THREE.sRGBEncoding;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(bodyW * 0.85, bodyD * 0.45), this._mat({ map: ltex, roughness: 0.6, metalness: 0.05, color: 0xffffff }));
      label.rotation.x = -Math.PI / 2; label.position.set((rows - 1) * pitch / 2, 10 + bodyH + 0.05, 5); g.add(label);
      // pins
      const pinMat = this._mat({ color: 0xc0c4ca, metalness: 0.9, roughness: 0.22 });
      pins.forEach((pin) => {
        const lead = new THREE.Mesh(new THREE.BoxGeometry(0.7, 11, 0.55), pinMat);
        lead.position.set(pin.x, 5.5, pin.y); g.add(lead);
      });
      return g;
    }

    _makeBatteryFixed(p, t) {
      const THREE = root.THREE, g = new THREE.Group();
      if (/9v|battery9v/i.test(t)) {
        // Real 9V: 48.5 × 26.5 × 17.5 mm — lay on SIDE so height is 17.5mm (not a tower)
        // Real 9V 48.5×26.5×17.5mm on its side; slight 0.72 display scale so schematic layouts stay readable
        const S = 0.72;
        const L = 48.5 * MM * S, W = 17.5 * MM * S, H = 26.5 * MM * S;
        const body = new THREE.Mesh(new THREE.BoxGeometry(L, W, H), this._mat({ color: 0x2a2d33, metalness: 0.35, roughness: 0.4 }));
        body.position.set(L / 2, W / 2, 0); body.castShadow = true; g.add(body);
        // Label on top face
        const lc = document.createElement('canvas'); lc.width = 256; lc.height = 128;
        const lg = lc.getContext('2d');
        lg.fillStyle = '#d4a017'; lg.fillRect(0, 0, 256, 128);
        lg.fillStyle = '#1a1a1a'; lg.font = 'bold 36px sans-serif'; lg.textAlign = 'center';
        lg.fillText('9V', 128, 50); lg.font = '16px sans-serif'; lg.fillText('ALKALINE', 128, 80);
        lg.fillStyle = '#333'; lg.fillRect(70, 95, 116, 22); lg.fillStyle = '#d4a017'; lg.font = 'bold 12px sans-serif'; lg.fillText('DURACELL', 128, 111);
        const ltex = new THREE.CanvasTexture(lc); ltex.encoding = THREE.sRGBEncoding;
        const label = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.7, H * 0.55), this._mat({ map: ltex, metalness: 0.3, roughness: 0.35, color: 0xffffff }));
        label.rotation.x = -Math.PI / 2; label.position.set(L / 2, W + 0.1, 0); g.add(label);
        // Snap terminals at +X end
        const pos = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 2.8 * MM, 16), this._mat({ color: 0xd0d4da, metalness: 0.9 }));
        pos.rotation.z = Math.PI / 2; pos.position.set(L + 1.2 * MM, W * 0.55, -4); g.add(pos);
        const neg = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 1.6 * MM, 6), this._mat({ color: 0xd0d4da, metalness: 0.9 }));
        neg.rotation.z = Math.PI / 2; neg.position.set(L + 0.7 * MM, W * 0.55, 5); g.add(neg);
      } else {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(7 * MM, 7 * MM, 50 * MM, 28), this._mat({ color: 0x1e88e5, metalness: 0.25, roughness: 0.4 }));
        body.position.set(10, 10 + 25 * MM, 0); body.castShadow = true; g.add(body);
      }
      return g;
    }

    _makeCap(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const isCer = p.type === 'ceramic' || p.type === 'capacitor';
      if (isCer) {
        const body = new THREE.Mesh(new THREE.BoxGeometry(4 * MM, 3 * MM, 2.5 * MM), this._mat({ color: 0xf5e6c8, roughness: 0.45 }));
        body.position.set(5, 10 + 1.5 * MM, 0); body.castShadow = true; g.add(body);
      } else {
        // electrolytic — blue sleeve
        const R = 3.2 * MM, H = 8 * MM;
        const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 20), this._mat({ color: 0x1e88e5, roughness: 0.4, metalness: 0.15 }));
        body.position.set(5, 10 + H / 2, 0); body.castShadow = true; g.add(body);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.95, R * 0.95, 0.4, 20), this._mat({ color: 0xc0c4ca, metalness: 0.7 }));
        top.position.set(5, 10 + H + 0.1, 0); g.add(top);
      }
      const leadMat = this._mat({ color: 0xc0c4ca, metalness: 0.9, roughness: 0.22 });
      for (const x of [0, 10]) {
        const lead = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * MM, 0.22 * MM, 12, 6), leadMat);
        lead.position.set(x, 6, 0); g.add(lead);
      }
      return g;
    }

    _makeButton(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(6 * MM, 3.2 * MM, 6 * MM), this._mat({ color: 0x2a2d33, roughness: 0.55 }));
      base.position.set(10, 10 + 1.6 * MM, 10); base.castShadow = true; g.add(base);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.2 * MM, 2.2 * MM, 2 * MM, 20), this._mat({ color: 0xe74c3c, roughness: 0.4 }));
      cap.position.set(10, 10 + 3.2 * MM + 1.0 * MM, 10); g.add(cap); g.userData.cap = cap; g.userData.capY = cap.position.y;
      return g;
    }
    _makePot(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(10 * MM, 6 * MM, 9 * MM), this._mat({ color: 0x1e88e5, roughness: 0.45 }));
      body.position.set(10, 10 + 3 * MM, -6); body.castShadow = true; g.add(body);
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(3 * MM, 3.2 * MM, 3 * MM, 20), this._mat({ color: 0xeeeeee, roughness: 0.35 }));
      knob.position.set(10, 10 + 6 * MM + 1.5 * MM, -6); g.add(knob); g.userData.knob = knob;
      return g;
    }
    _makeDisplay(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      let W = 80, H = 36;
      try { const sz = d.size(p); W = sz.w || 80; H = sz.h || 36; } catch (_) {}
      const pcb = new THREE.Mesh(new THREE.BoxGeometry(W, 1.6 * MM, H), this._mat({ color: 0x0d5c2e, roughness: 0.55 }));
      pcb.position.set(W / 2 - 5, 10 + 0.8 * MM, H / 2 - 8); pcb.castShadow = true; g.add(pcb);
      const c = document.createElement('canvas'); c.width = 256; c.height = 64;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#03140c'; ctx.fillRect(0, 0, 256, 64);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.78, H * 0.48), this._mat({ map: tex, emissive: 0x0a3d22, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.05, color: 0xffffff }));
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
    _makeCard(p, d) {
      const THREE = root.THREE, g = new THREE.Group();
      const sz = d.size ? d.size(p) : { w: 30, h: 20 };
      const W = Math.max(14, sz.w), D = Math.max(10, sz.h);
      const body = new THREE.Mesh(new THREE.BoxGeometry(W, 4 * MM, D), this._mat({ color: 0x2a3140, metalness: 0.2, roughness: 0.55 }));
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

    /* ---- tidy Manhattan / jumper wires ---- */
    _makeWire(w, onBoard) {
      const THREE = root.THREE;
      const a = w.a, b = w.b;
      if (!a || !b) return null;
      const boardTop = 1.8;
      const A = new THREE.Vector3(a.x, boardTop, a.y);
      const B = new THREE.Vector3(b.x, boardTop, b.y);
      const dx = B.x - A.x, dz = B.z - A.z;
      const dist = Math.hypot(dx, dz);
      let pts;
      if (onBoard && dist > 8) {
        // 90° jumper aesthetic: rise → run → drop, with optional mid bend
        const rise = boardTop + Math.min(7, 2.5 + dist * 0.02);
        const p0 = A.clone(); p0.y = boardTop + 0.4;
        const p1 = A.clone(); p1.y = rise;
        let mid;
        if (Math.abs(dx) > 4 && Math.abs(dz) > 4) {
          // prefer longer axis first
          if (Math.abs(dx) >= Math.abs(dz)) {
            mid = new THREE.Vector3(B.x, rise, A.z);
          } else {
            mid = new THREE.Vector3(A.x, rise, B.z);
          }
        } else {
          mid = A.clone().lerp(B, 0.5); mid.y = rise;
        }
        const p2 = B.clone(); p2.y = rise;
        const p3 = B.clone(); p3.y = boardTop + 0.4;
        pts = Math.abs(dx) > 4 && Math.abs(dz) > 4 ? [p0, p1, mid, p2, p3] : [p0, p1, p2, p3];
      } else {
        const mid = A.clone().lerp(B, 0.5);
        mid.y = boardTop + 1.5 + Math.min(6, dist * 0.04);
        pts = [A.clone().setY(boardTop + 0.4), mid, B.clone().setY(boardTop + 0.4)];
      }
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.15);
      const radial = this.dpr < 1.6 ? 5 : 6;
      const segs = Math.max(12, Math.floor(curve.getLength() / 4));
      const col = WIRE_HEX[w.color] || 0x2ecc71;
      const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, WIRE_R * 0.45, radial, false), this._mat({ color: 0xb8bcc2, metalness: 0.85, roughness: 0.28 }));
      const ins = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, WIRE_R, radial, false), this._mat({
        color: col, metalness: 0.06, roughness: 0.42,
        emissive: col, emissiveIntensity: this.softGL ? 0.1 : 0.02
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
        const geo = new THREE.SphereGeometry(0.32 * MM, 8, 6);
        const mat = this._mat({ color: 0xffffff, emissive: 0xe6fdff, emissiveIntensity: 2.2, transparent: true, opacity: 0, roughness: 0.2 });
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
        setE(L.mesh, b * 3.2); setE(L.base, b * 2.0); setE(L.flat, b * 2.0); setE(L.die, 0.4 + b * 4);
        if (L.mesh && L.mesh.material) L.mesh.material.opacity = 0.55 + 0.4 * b;
        if (L.light) L.light.intensity = b * (this.softGL ? 9.0 : 4.5);
        if (L.glow) {
          L.glow.material.opacity = b * (this.softGL ? 1.0 : 0.8);
          L.glow.visible = b > 0.02;
          const s = (this.softGL ? 22 : 14) + b * (this.softGL ? 40 : 24);
          L.glow.scale.set(s, s, 1);
        }
        if (L.glow2) {
          L.glow2.material.opacity = b * (this.softGL ? 0.55 : 0.35);
          L.glow2.visible = b > 0.05;
          const s2 = (this.softGL ? 40 : 28) + b * (this.softGL ? 55 : 35);
          L.glow2.scale.set(s2, s2, 1);
        }
        if (L.spill) {
          L.spill.material.opacity = b * (this.softGL ? 0.75 : 0.4);
          L.spill.scale.setScalar(1.2 + b * 1.8);
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
          d._txt = st.txt;
          d.ctx.fillStyle = '#03140c'; d.ctx.fillRect(0, 0, d.canvas.width, d.canvas.height);
          d.ctx.fillStyle = '#7dffb0'; d.ctx.font = 'bold 16px monospace';
          String(st.txt).split('\n').forEach((line, i) => d.ctx.fillText(line, 8, 22 + i * 20));
          d.tex.needsUpdate = true;
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
        p.mat.emissiveIntensity = 1.5 + Math.min(2, mag * 80);
        const s = 0.32 * MM * (1 + Math.min(1.2, mag * 35));
        p.mesh.scale.setScalar(s / (0.32 * MM));
      }
    }

    _onPick(e) {
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
            this.orbit.flyTo(world, Math.max(100, this.orbit.sph.r * 0.55));
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
            if (this._idle > 4) this.orbit.goal.theta += 0.0004;
          } else this._idle = 0;
        }
        try {
          this._updatePulses(dt);
          if (this.composer) this.composer.render();
          else this.renderer.render(this.scene, this.camera);
          this._frames = (this._frames || 0) + 1; this._errs = 0;
          if (this._probe) this._probe();
        } catch (e) {
          // composer/bloom failures: drop to plain renderer once; persistent errors bail to 2D
          if (this.composer) { console.warn('3D composer failed, plain render', e); this.composer = null; return; }
          if (++this._errs > 3) this._fail(e);
        }
      };
      this._raf = requestAnimationFrame(step);
    }
    _fail(e) {
      if (this._failed) return; this._failed = true;
      try { this.setActive(false); } catch (_) {}
      if (this.hooks.onFail) this.hooks.onFail(e);
      setTimeout(() => { this._failed = false; }, 1500);
    }
    // Resolves {ok} after a couple of real frames: fails on lost context, no frames, or an all-white frame.
    _cameraInsideBoard() {
      const THREE = root.THREE; if (!THREE || !this.camera) return false;
      const cp = this.camera.position;
      for (const [, rec] of this.parts) {
        if (!rec || !rec.part || rec.part.type !== 'breadboard' || !rec.mesh) continue;
        const bb = new THREE.Box3().setFromObject(rec.mesh); bb.expandByScalar(4);
        if (bb.containsPoint(cp)) return true;
      }
      if (this._vbbMesh) { const bb = new THREE.Box3().setFromObject(this._vbbMesh); bb.expandByScalar(4); if (bb.containsPoint(cp)) return true; }
      return cp.y < 6;   // below/inside the board plane
    }
    _whiteFraction(gl) {
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const buf = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let n = 0, white = 0;
      const sx = Math.max(1, Math.floor(W / 48)), sy = Math.max(1, Math.floor(H / 32));
      for (let y = Math.floor(sy / 2); y < H; y += sy) for (let x = Math.floor(sx / 2); x < W; x += sx) {
        const i = (y * W + x) * 4, r = buf[i], g = buf[i + 1], b = buf[i + 2];
        n++; if (Math.min(r, g, b) > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 40) white++;
      }
      return n ? white / n : 0;
    }
    // Resolves {ok} after real frames: fails on lost context, camera inside the board, or a frame
    // that is >60% near-white (the "white screen").
    healthCheck(timeout = 3000) {
      return new Promise((res) => {
        if (!this.ready) return res({ ok: false, why: 'not ready' });
        if (this._cameraInsideBoard()) return res({ ok: false, why: 'camera', camera: true });
        const start = this._frames || 0, t0 = performance.now();
        const gl = this.renderer.getContext();
        let worst = 0, checked = 0;
        this._probe = () => {
          if ((this._frames || 0) - start < 2) return;
          try {
            if (gl.isContextLost()) { this._probe = null; return res({ ok: false, why: 'WebGL context lost' }); }
            worst = Math.max(worst, this._whiteFraction(gl));
          } catch (_) {}
          checked++;
          this.lastWhite = worst;
          if (worst > 0.6) { this._probe = null; return res({ ok: false, why: 'white frame', camera: true, white: worst }); }
          if (checked >= 2) { this._probe = null; res({ ok: true, white: worst }); }
        };
        const wait = () => {
          if (!this._probe) return;
          if (this._lost) { this._probe = null; return res({ ok: false, why: 'WebGL context lost' }); }
          if (performance.now() - t0 > timeout) {
            this._probe = null;
            return res(gl.isContextLost() ? { ok: false, why: 'WebGL context lost' } : { ok: true, white: worst, noFrames: true });
          }
          setTimeout(wait, 100);
        };
        wait();
      });
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
