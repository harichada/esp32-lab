/* WebGL 3D circuit view — product-render polish. 2D SVG remains the editor.
 * Scale: 2D G=10 = 0.1" = 2.54 mm → 1 SVG unit = 0.254 mm. Soft-GL safe. */
(function (root) {
  const WIRE_HEX = { green: 0x2ecc71, red: 0xe74c3c, black: 0x2b2b30, blue: 0x3498db, yellow: 0xf1c40f, orange: 0xe67e22, white: 0xecf0f1, purple: 0x9b59b6, gray: 0x7f8c8d, brown: 0x6d4c41 };
  const wireHex = (c) => { if (WIRE_HEX[c] != null) return WIRE_HEX[c]; const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim()); if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((q) => q + q).join(''); return parseInt(h, 16); } return 0x2ecc71; };
  const CAPC = { red: 0xe53935, green: 0x2e9e4f, blue: 0x2f6fd6, yellow: 0xf4c430, black: 0x2a2d33, white: 0xececec };
  const BANDC = [0x111111, 0x6d4c41, 0xe53935, 0xfb8c00, 0xfdd835, 0x43a047, 0x1e88e5, 0x8e24aa, 0x9e9e9e, 0xfafafa];
  const LEDCOL = { red: 0xff1744, green: 0x00e676, blue: 0x2979ff, yellow: 0xffea00, white: 0xf5f7ff, orange: 0xff9100, ir: 0xb388ff };
  const MM = 1 / 0.254;
  const GND_HEX = 0x22c55e;   // ground marker green (posts, rings, symbols)
  const LANE_JOG = 3; // run length before a lane-shifted run leaves the riser top
  const WIRE_R = 0.5 * MM; // 1.0 mm OD — chunkier than AWG22 so jumpers read at framed distance (was 0.7 mm → ~2 px)
  // dedicated package models (2D print text, sub-line)
  const TO92 = { npn: ['2N2222', 'NPN'], pnp: ['2N2907', 'PNP'], n2n3904: ['2N3904', 'NPN'], p2n3906: ['2N3906', 'PNP'] };
  const TO220 = { tip120: ['TIP120', 'NPN DARL.'], lm7805: ['L7805CV', '5V 1.5A'], irlz44n: ['IRLZ44N', 'N-MOSFET'] };
  const DIP_RE = /^(ne555|opamp|ic74|74|cd40|cd45|lm358|lm393|lm324|mcp3008|mcp23017|l293d|pc817|uln2803)/i;
  // 2D-art blocks: body height per type (units; 1 mm = MM). Default 3 mm.
  const ART_OPTS = { label: { noBody: true, backing: true }, battery: { h: 7 * 3.937 }, coin: { h: 3 * 3.937 }, battery9v: { h: 9 * 3.937, round: 5 }, buzzer: { h: 9 * 3.937 }, voltmeter: { h: 6 * 3.937 }, ammeter: { h: 6 * 3.937 }, bench: { h: 10 * 3.937 },
    keypad: { h: 1 * 3.937 }, relay1: { h: 4 * 3.937 }, lamp: { h: 5 * 3.937 }, solenoid: { h: 6 * 3.937 }, stepper28: { h: 8 * 3.937 }, scope: { h: 4 * 3.937 },
    aapack: { h: 5 * 3.937 }, coincell: { h: 2 * 3.937 }, fuse: { h: 2 * 3.937 }, d1n4007: { h: 2 * 3.937 }, d1n5819: { h: 2 * 3.937 }, diode: { h: 1.8 * 3.937 } };
  const RM = () => root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function loadScript(src) {
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
  function t3d(k) {
    try {
      const bag = root.__t3d || (root.__t3d = {});
      if (bag[k] == null) bag[k] = performance.now();
    } catch (_) {}
  }
  // Postprocessing (bloom) is opt-in. The default path never constructs a composer.
  function wants3dFx(search) {
    return /[?&]fx3d=1\b/.test(search || '');
  }
  async function ensureThree() {
    const base = (document.querySelector('script[src*="view3d"]') || { src: 'js/view3d.js' }).src.replace(/js\/view3d[^/]*$/, '');
    if (!root.THREE) {
      t3d('threeStart');
      await loadScript(base + 'vendor/three.min.js?v=2');
      if (!root.THREE) throw new Error('THREE global missing');
    }
    t3d('threeEval');
    // Each bloom file is its own round trip and none of them run unless ?fx3d=1.
    const q = (root.location && root.location.search) || '';
    if (wants3dFx(q) && !(root.THREE.EffectComposer && root.THREE.UnrealBloomPass)) {
      t3d('fxStart');
      for (const f of ['CopyShader.js', 'LuminosityHighPassShader.js', 'EffectComposer.js', 'RenderPass.js', 'ShaderPass.js', 'UnrealBloomPass.js']) {
        try { await loadScript(base + 'vendor/' + f + '?v=2'); } catch (e) { break; }
      }
      t3d('fxEval');
    }
    t3d('scriptsDone');
    return root.THREE;
  }
  function bandsOf(r) {
    if (!(r > 0)) return [0x6d4c41, 0x111111, 0x111111, 0xc9a227];
    const e = Math.floor(Math.log10(r)) - 1, m = r / Math.pow(10, e), d = Math.max(10, Math.min(99, Math.round(m)));
    const mult = e >= 0 ? (BANDC[e] || 0xffffff) : (e === -1 ? 0xc9a227 : 0xc0c0c0);
    return [BANDC[Math.floor(d / 10)] || 0, BANDC[d % 10] || 0, mult, 0xc9a227];
  }

  // Place `cam` so every corner of `box` lands inside `margins` (NDC) at the
  // orbit angle. Distance is solved from the real projection, so a phone-narrow
  // viewport pulls back instead of cropping the board.
  function fitCameraToBox(cam, box, opts) {
    const THREE = root.THREE || globalThis.THREE;
    opts = opts || {};
    const theta = (opts.angleDeg != null ? opts.angleDeg : 40) * Math.PI / 180;
    const phi = opts.phi != null ? opts.phi : 1.10;
    const margins = opts.margins || { xMin: -0.9, xMax: 0.9, yMin: -0.86, yMax: 0.9 };
    const target = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    if (cam.far < span * 20) { cam.far = span * 40; cam.updateProjectionMatrix(); }
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const ndc = new THREE.Vector3();
    const place = (r) => {
      cam.position.set(
        target.x + r * Math.sin(phi) * Math.sin(theta),
        target.y + r * Math.cos(phi),
        target.z + r * Math.sin(phi) * Math.cos(theta)
      );
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
    };
    const fits = () => {
      for (let i = 0; i < corners.length; i++) {
        ndc.copy(corners[i]).project(cam);
        if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) return false;
        if (ndc.z < -1 || ndc.z > 1) return false;
        if (ndc.x < margins.xMin || ndc.x > margins.xMax || ndc.y < margins.yMin || ndc.y > margins.yMax) return false;
      }
      return true;
    };
    let lo = Math.max(40, span * 0.2), hi = lo, guard = 0;
    place(hi);
    while (!fits() && hi < span * 80 && guard++ < 28) { lo = hi; hi *= 1.45; place(hi); }
    if (fits()) {
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        place(mid);
        if (fits()) hi = mid; else lo = mid;
      }
    }
    const r = hi * 1.03;
    place(r);
    return { target: target.clone(), theta: theta, phi: phi, r: r };
  }

  // Modest margin around the parts and wires. A long breadboard only gains a
  // sliver; a small loose circuit is not parked inside a huge empty margin.
  function contentPadding(span) {
    return Math.min(18, Math.max(8, span * 0.04));
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
    frameBox(box, angleDeg, margins) {
      if (!box || box.isEmpty()) return;
      const pose = fitCameraToBox(this.cam, box, { angleDeg: angleDeg, phi: 1.10, margins: margins });
      this.goal.target.copy(pose.target);
      this.goal.theta = pose.theta; this.goal.phi = pose.phi; this.goal.r = pose.r;
      this.sph.theta = pose.theta; this.sph.phi = pose.phi; this.sph.r = pose.r;
      this.target.copy(pose.target); this.apply();
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
      this.parts = new Map(); this.wires = new Map(); this.arts = []; this.leds = []; this.displays = []; this.motors = []; this.servos = [];
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
      // Colours: all hex colours here are authored in sRGB. three r134 treats Color(hex) as linear, so with
      // sRGB output every colour was gamma-lifted twice → pastel/grey parts. We linearize them (_linearize)
      // and drop ACES (it further desaturated) in favour of plain output.
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.toneMappingExposure = 1.0;
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
      this.scene.add(new THREE.AmbientLight(0xb0b8c8, this.softGL ? 0.62 : 0.38));
      const hemi = new THREE.HemisphereLight(0xdde6f5, 0x1a1410, this.softGL ? 0.6 : 0.45); this.scene.add(hemi);
      const key = new THREE.DirectionalLight(0xfff4e6, this.softGL ? 1.35 : 1.9);
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

      this._linearize(this.scene);
      this.root = new THREE.Group(); this.scene.add(this.root);
      this.pulseRoot = new THREE.Group(); this.scene.add(this.pulseRoot);
      this.ready = true;
      this._onResize = () => {
        if (this._resizeRaf) return;
        this._resizeRaf = requestAnimationFrame(() => { this._resizeRaf = 0; this.resize(); });
      };
      root.addEventListener('resize', this._onResize);
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this._onResize());
        this._ro.observe(this.wrap);
      }
      // Interactive parts (buttons, switches, pots) get the pointer before the orbit camera does.
      // Capture-phase listeners on the canvas run before Orbit's own (bubble) listeners.
      this.canvas.addEventListener('pointerdown', (e) => {
        this._ptr = { x: e.clientX, y: e.clientY, t: performance.now() };
        if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !this.hooks.onPartDown) return;
        const hit = this._hitPart(e);
        if (!hit || hit.part.type === 'breadboard') return;
        let kind = false; try { kind = this.hooks.onPartDown(hit.id, e); } catch (err) { console.error(err); }
        if (!kind) return;
        this._act = { kind, id: hit.id, x: e.clientX, y: e.clientY, pid: e.pointerId };
        e.stopImmediatePropagation(); e.preventDefault();
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
      }, true);
      this.canvas.addEventListener('pointermove', (e) => {
        if (!this._act) return;
        e.stopImmediatePropagation();
        if (this.hooks.onPartMove) try { this.hooks.onPartMove(this._act.id, this._act.kind, e.clientX - this._act.x, e.clientY - this._act.y); } catch (err) { console.error(err); }
      }, true);
      const actEnd = (e) => {
        if (!this._act) return;
        const a = this._act; this._act = null; this._ptr = null;
        e.stopImmediatePropagation();
        if (this.hooks.onPartUp) try { this.hooks.onPartUp(a.id, a.kind); } catch (err) { console.error(err); }
      };
      this.canvas.addEventListener('pointerup', actEnd, true);
      this.canvas.addEventListener('pointercancel', actEnd, true);
      this.canvas.addEventListener('pointerup', (e) => this._onPick(e));
      // Double-click focuses the camera on a part (single clicks never move the camera)
      this.canvas.addEventListener('dblclick', (e) => {
        const hit = this._hitPart(e); if (!hit || hit.part.type === 'breadboard') return;
        const world = new root.THREE.Vector3(); new root.THREE.Box3().setFromObject(hit.rec.mesh).getCenter(world);
        this.orbit.flyTo(world, Math.max(100, this.orbit.sph.r * 0.55));
      });
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
      const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
      if (w < 2 || h < 2) return;
      const same = w === this._vw && h === this._vh;
      this._vw = w; this._vh = h;
      if (!same) {
        this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
        this.dpr = Math.min(root.devicePixelRatio || 1, /Mobi|Android/i.test(navigator.userAgent) ? 1.5 : 2);
        this.renderer.setPixelRatio(this.dpr); this.renderer.setSize(w, h, false);
        if (this.composer) this.composer.setSize(w, h);
      }
      if (this.active && this._fitBox) this._applyFrame();
    }
    // Safe NDC window: keep the board off the stage edges and out from under the
    // banner, view toolbar, and (on a phone-width layout) the bottom dial.
    _safeNdc() {
      const w = this.wrap.clientWidth || 1, h = this.wrap.clientHeight || 1;
      const wrap = this.wrap.getBoundingClientRect();
      let top = Math.max(12, h * 0.04), bot = Math.max(14, h * 0.05), left = Math.max(12, w * 0.04), right = Math.max(12, w * 0.04);
      let extra = [];
      try { extra = [...document.querySelectorAll('body.m #mHub, body.m #mIgnite, body.m #mParts')]; } catch (_) {}
      const nodes = [...this.wrap.querySelectorAll('.projbanner, .canvas-tools, .zoom-tools, .exit3d'), ...extra];
      for (const el of nodes) {
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const l = Math.max(r.left, wrap.left), ri = Math.min(r.right, wrap.right);
        const t = Math.max(r.top, wrap.top), b = Math.min(r.bottom, wrap.bottom);
        if (ri - l < 8 || b - t < 8) continue;
        const fromTop = t - wrap.top, fromBot = wrap.bottom - b;
        if (fromTop <= fromBot && fromTop < h * 0.45) top = Math.max(top, (b - wrap.top) + 10);
        else if (fromBot < h * 0.58) bot = Math.max(bot, (wrap.bottom - t) + 10);
      }
      if (top + bot > h * 0.62) { const s = (h * 0.62) / (top + bot); top *= s; bot *= s; }
      if (left + right > w * 0.5) { const s = (w * 0.5) / (left + right); left *= s; right *= s; }
      return {
        xMin: (left / w) * 2 - 1, xMax: 1 - (right / w) * 2,
        yMin: (bot / h) * 2 - 1, yMax: 1 - (top / h) * 2,
      };
    }
    _applyFrame() {
      if (!this._fitBox || !this.orbit) return;
      this.orbit.frameBox(this._fitBox, 40, this._safeNdc());
      if (this.scene && this.scene.fog && this.scene.fog.isFogExp2) {
        const r = this.orbit.sph.r;
        this.scene.fog.density = Math.min(0.00055, 0.45 / Math.max(r, 1));
      }
    }
    setActive(on) {
      this.active = !!on; this.canvas.classList.toggle('on', this.active);
      this.canvas.style.pointerEvents = this.active ? 'auto' : 'none';
      if (this.active) { this.resize(); if (this.proj) this.rebuild(true); t3d('rebuild'); }
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
          if (c.geometry && !c.geometry.userData.keep) c.geometry.dispose();
          if (c.material) {
            const ms = Array.isArray(c.material) ? c.material : [c.material];
            ms.forEach((m) => {
              if (m.map && !m.map.userData.keep) m.map.dispose();
              if (!m.userData.keep) m.dispose();
            });
          }
        });
      }
      while (this.pulseRoot && this.pulseRoot.children.length) {
        const o = this.pulseRoot.children[0]; this.pulseRoot.remove(o);
        if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose();
      }
      this.parts.clear(); this.wires.clear(); this.arts = []; this.leds = []; this.displays = []; this.motors = []; this.servos = []; this.pulses = [];
      this._virtualBB = false;
    }
    _mat(opts) {
      const m = new THREE.MeshStandardMaterial(Object.assign({ metalness: 0.18, roughness: 0.48, envMapIntensity: this.softGL ? 0.15 : 0.85 }, opts));
      // no environment map on the safe path: metals would render near-black/grey, so cap metalness
      if (this.softGL) m.metalness = Math.min(m.metalness, 0.3);
      return m;
    }
    // Geometries and materials reused across rebuilds. clear() must not dispose them.
    _keepGeo(key, build) {
      if (!this._geoCache) this._geoCache = new Map();
      let g = this._geoCache.get(key);
      if (!g) { g = build(); g.userData.keep = true; this._geoCache.set(key, g); }
      return g;
    }
    _keepMat(key, build) {
      if (!this._matCache) this._matCache = new Map();
      let m = this._matCache.get(key);
      if (!m) { m = build(); m.userData.keep = true; this._matCache.set(key, m); }
      return m;
    }
    _keepTex(key, build) {
      if (!this._texCache) this._texCache = new Map();
      let t = this._texCache.get(key);
      if (!t) { t = build(); t.userData.keep = true; this._texCache.set(key, t); }
      return t;
    }
    _addSolid(box, obj) {
      if (!obj) return;
      obj.updateMatrixWorld(true);
      const b = this._solidBox(obj);
      if (b && !b.isEmpty()) box.union(b);
    }
    // Convert sRGB-authored material/light colours to linear once (textures already carry sRGBEncoding).
    _linearize(obj) {
      obj.traverse((o) => {
        if (o.isLight && o.color && !o.userData.lin) { o.color.convertSRGBToLinear(); if (o.groundColor) o.groundColor.convertSRGBToLinear(); o.userData.lin = true; }
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of ms) {
          if (!m || m.userData.lin) continue; m.userData.lin = true;
          if (m.color) m.color.convertSRGBToLinear();
          if (m.emissive) m.emissive.convertSRGBToLinear();
          m.needsUpdate = true;
        }
      });
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
      const tBuild = performance.now(), lap = { t: tBuild };
      const tick = () => { const n = performance.now(), d = n - lap.t; lap.t = n; return Math.round(d * 10) / 10; };
      this.clear(); this._sig = this._projectSig();
      const gParts = new THREE.Group(), gWires = new THREE.Group(); this.root.add(gParts); this.root.add(gWires);
      this.root.updateMatrixWorld(true);
      const box = new THREE.Box3();
      const realBB = this.proj.parts.some((p) => p.type === 'breadboard');
      // Floating circuits get a stand-in board, so jumpers still rise off the table.
      // It is sized to the parts and framed by its top, not by its thickness.
      let hasBB = realBB || this.proj.parts.length > 0;

      for (const p of this.proj.parts) {
        const d = root.Parts.T[p.type]; if (!d) continue;
        let mesh = null;
        try { mesh = this._makePart(p, d); } catch (err) { console.warn('3D part', p.type, err); mesh = this._makeCard(p, d); }
        if (!mesh) continue;
        const rot = (p.rot || 0) * Math.PI / 2;
        mesh.position.set(p.x, 0, p.y);
        mesh.rotation.y = -rot;
        gParts.add(mesh); this.parts.set(p.id, { mesh, part: p });
        this._addSolid(box, mesh);
        if (p.type !== 'breadboard') {
          try {
            const sz = d.size ? d.size(p) : { w: 24, h: 20 };
            mesh.add(this._shadowDisc(Math.max(6, Math.max(sz.w || 20, sz.h || 20) * 0.32)));
          } catch (_) { mesh.add(this._shadowDisc(10)); }
        }
      }
      this._partBoxes = []; this._pinOwners = new Map(); this._pinNames = new Map();
      for (const [, rec] of this.parts) if (rec.part.type === 'breadboard') {
        try { for (const pin of root.Parts.T.breadboard.pins(rec.part)) { const q = root.Parts.pinWorld(rec.part, pin); this._pinNames.set(Math.round(q.x) + ',' + Math.round(q.y), pin.name); } } catch (_) {}
      }
      for (const [id, rec] of this.parts) {
        if (rec.part.type === 'breadboard') continue;
        try {
          rec.mesh.updateMatrixWorld(true); const bb = this._solidBox(rec.mesh);
          if (bb && !bb.isEmpty()) this._partBoxes.push({ id, box: bb, pinTop: rec.mesh.userData.pinTop != null ? rec.mesh.userData.pinTop : null, keepClear: !!rec.mesh.userData.keepClear });
          const d = root.Parts.T[rec.part.type];
          for (const pin of (d && d.pins ? d.pins(rec.part) : [])) { const q = root.Parts.pinWorld(rec.part, pin), kk = Math.round(q.x) + ',' + Math.round(q.y); this._pinOwners.set(kk, id); this._pinNames.set(kk, pin.name); }
        } catch (_) {}
      }
      const partMs = tick();
      const plans = this.proj.wires.map((w) => this._planWire(w, hasBB));
      try { this._layoutWires(plans); } catch (e) { console.warn('3D wire layout', e); }
      for (const p of plans) {
        const tube = p && this._buildWire(p);
        if (tube) { gWires.add(tube.group); this.wires.set(tube.id, tube); this._addSolid(box, tube.group); }
      }
      const wireMs = tick();
      if (!realBB) {
        const virt = this._makeVirtualBoard(box);
        if (virt) {
          gParts.add(virt.mesh); this._virtualBB = true;
          // The stand-in is part of the picture, but its underside is hidden.
          const y = box.min.y;
          box.expandByPoint(new THREE.Vector3(virt.minX, y, virt.minZ));
          box.expandByPoint(new THREE.Vector3(virt.maxX, y, virt.maxZ));
        } else hasBB = realBB;
      }
      const boardMs = tick();
      if (this.kick && !box.isEmpty()) {
        const c = new THREE.Vector3(); box.getCenter(c); this.kick.position.set(c.x, 70, c.z);
      }
      if (fit && !box.isEmpty()) {
        // Real breadboards are parts, so they are already in `box`. The stand-in's
        // top was unioned in above; its hidden underside is not.
        const use = box.clone();
        const size = use.getSize(new THREE.Vector3());
        use.expandByScalar(contentPadding(Math.max(size.x, size.z)));
        this._fitBox = use;
        this._applyFrame();
      }
      this._linearize(this.root);
      this._updateLive();
      if (this.active && this.renderer && this.scene && this.camera) {
        try { this.renderer.compile(this.scene, this.camera); } catch (_) {}
      }
      const compileMs = tick();
      let meshes = 0;
      this.root.traverse((o) => { if (o.isMesh) meshes++; });
      this._buildMs = { parts: partMs, wires: wireMs, board: boardMs, compile: compileMs, total: Math.round((performance.now() - tBuild) * 10) / 10, meshes };
    }

    /* ---- Virtual acrylic/breadboard for schematic circuits ---- */
    _makeVirtualBoard(bounds) {
      const THREE = root.THREE;
      if (!bounds || bounds.isEmpty()) return null;
      // Sit just outside the parts. A wide pad made a sparse board, and fitting that
      // board left the circuit small in the frame.
      const margin = 8;
      let minX = Math.floor((bounds.min.x - margin) / 10) * 10;
      let maxX = Math.ceil((bounds.max.x + margin) / 10) * 10;
      let minZ = Math.floor((bounds.min.z - margin) / 10) * 10;
      let maxZ = Math.ceil((bounds.max.z + margin) / 10) * 10;
      const W = maxX - minX, D = maxZ - minZ;
      if (!(W > 40 && D > 40)) return null;

      const g = new THREE.Group();
      const cols = Math.max(8, Math.round(W / 10));
      const tex = this._bbTexture(cols);
      const H = 9.5 * MM;
      const sideMat = this._keepMat('vboard-side', () => this._mat({ color: 0xe0d8c8, roughness: 0.75, metalness: 0.04 }));
      const body = new THREE.Mesh(this._keepGeo('vboard-body:' + W + 'x' + D, () => new THREE.BoxGeometry(W, H, D)), sideMat);
      body.position.set(minX + W / 2, -H / 2, minZ + D / 2);
      body.castShadow = true; body.receiveShadow = true; g.add(body);
      const top = new THREE.Mesh(
        new THREE.PlaneGeometry(W - 0.5, D - 0.5),
        this._mat({ map: tex, color: 0xf7f1e3, roughness: 0.68, metalness: 0.04 })
      );
      top.rotation.x = -Math.PI / 2; top.position.set(minX + W / 2, 0.05, minZ + D / 2); top.receiveShadow = true; g.add(top);
      const xs = [], zs = [];
      for (let x = minX + 10; x < maxX - 4; x += 10) xs.push(x);
      for (let z = minZ + 10; z < maxZ - 4; z += 10) zs.push(z);
      const n = xs.length * zs.length;
      if (n > 0) {
        const holeGeo = this._keepGeo('vhole', () => new THREE.CylinderGeometry(1.05, 1.15, 1.6, 8));
        const holeMat = this._keepMat('vhole', () => this._mat({ color: 0x1a1a1c, metalness: 0.5, roughness: 0.4 }));
        const inst = new THREE.InstancedMesh(holeGeo, holeMat, n);
        const dummy = new THREE.Object3D();
        let i = 0;
        for (const x of xs) for (const z of zs) {
          dummy.position.set(x, 0.05, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          inst.setMatrixAt(i++, dummy.matrix);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.userData.noSolid = true;
        g.add(inst);
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
      const tex = this._bbTexture2D(cols);
      // 2D body spans x −6…W−4, y −14…208 (222 deep); match it exactly so texture rails sit on the real rail holes
      const BW = W + 2, BD = 222, cx = W / 2 - 5, cz = 97;
      const body = new THREE.Mesh(new THREE.BoxGeometry(BW, H, BD), this._mat({ color: 0xe0d8c8, roughness: 0.75, metalness: 0.04 }));
      body.position.set(cx, -H / 2, cz); body.castShadow = true; body.receiveShadow = true; g.add(body);
      const top = new THREE.Mesh(new THREE.PlaneGeometry(BW, BD), this._mat({ map: tex, color: 0xffffff, roughness: 0.68, metalness: 0.04 }));
      top.rotation.x = -Math.PI / 2; top.position.set(cx, 0.05, cz); top.receiveShadow = true; g.add(top);
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
      const gndPin = this._mat({ color: GND_HEX, metalness: 0.3, roughness: 0.35, emissive: GND_HEX, emissiveIntensity: 0.25 });
      for (const z of [0, 90]) {   // same rows as the 2D pins (y=0 / y=90)
        const bar = new THREE.Mesh(new THREE.BoxGeometry(148, 2.2, 2.4), plastic);
        bar.position.set(70, -0.3, z); g.add(bar);
        for (let i = 0; i < 15; i++) {
          const isG = i === 1;   // GND.2 (top row) / GND.1 (bottom row)
          const pin = new THREE.Mesh(new THREE.BoxGeometry(isG ? 1.4 : 0.9, 9.5, isG ? 1.4 : 0.9), isG ? gndPin : pinMat);
          pin.position.set(i * 10, 4.2, z); g.add(pin);
          if (isG) {
            const collar = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.2, 4.2), gndPin);
            collar.position.set(i * 10, 9.6, z); g.add(collar);
            const tag = this._labelSprite('GND', '#04130b', '#3ddc84'); tag.position.set(i * 10, 15, z + (z ? 6 : -6)); g.add(tag);
          }
        }
      }
      g.userData.pinTop = 9.0;   // header pin tops: jumpers land here
      return g;
    }

    _glowSprite(color) {
      const THREE = root.THREE;
      const hex = ((color >>> 0) & 0xffffff);
      const blend = this.softGL ? THREE.NormalBlending : THREE.AdditiveBlending;
      const tex = this._keepTex('glow:' + (this.softGL ? 's' : 'h') + ':' + hex, () => {
        const c = document.createElement('canvas'); c.width = 128; c.height = 128;
        const g = c.getContext('2d');
        const r = (hex >> 16) & 255, gv = (hex >> 8) & 255, b = hex & 255;
        const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
        grd.addColorStop(0, 'rgba(255,255,255,1)');
        grd.addColorStop(0.12, 'rgba(' + r + ',' + gv + ',' + b + ',1)');
        grd.addColorStop(0.35, 'rgba(' + r + ',' + gv + ',' + b + ',0.7)');
        grd.addColorStop(0.65, 'rgba(' + Math.floor(r * 0.6) + ',' + Math.floor(gv * 0.35) + ',' + Math.floor(b * 0.35) + ',0.28)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
        const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding;
        return t;
      });
      // Additive vanishes on white breadboards under soft-GL — use Normal there.
      // One texture per colour; each LED still has its own material so opacity can differ.
      const mat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, blending: blend, depthWrite: false, opacity: 0, depth: blend });
      return new THREE.Sprite(mat);
    }

    _makeLed(p, isIR) {
      const THREE = root.THREE, g = new THREE.Group();
      const col = isIR ? LEDCOL.ir : (LEDCOL[p.props.color] || LEDCOL.red);
      const pitch = 10, leadY = 10;
      const leadMat = this._keepMat('led-lead', () => this._mat({ color: 0xc0c4ca, metalness: 0.9, roughness: 0.22 }));
      const leadGeo = this._keepGeo('led-lead', () => new THREE.CylinderGeometry(0.22 * MM, 0.22 * MM, leadY + 2, 8));
      for (const x of [0, pitch]) {
        const lead = new THREE.Mesh(leadGeo, leadMat);
        lead.position.set(x, leadY / 2, 0); g.add(lead);
      }
      const R = 2.5 * MM, bodyH = 5.0 * MM;
      const bodyMat = this._mat({ color: col, transparent: true, opacity: 0.78, roughness: 0.15, metalness: 0.05, emissive: col, emissiveIntensity: 0 });
      const cyl = new THREE.Mesh(this._keepGeo('led-cyl', () => new THREE.CylinderGeometry(R, R, bodyH, 28)), bodyMat);
      cyl.position.set(pitch / 2, leadY + bodyH / 2, 0); cyl.castShadow = true; g.add(cyl);
      const dome = new THREE.Mesh(this._keepGeo('led-dome', () => new THREE.SphereGeometry(R, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2)), bodyMat.clone());
      dome.position.set(pitch / 2, leadY + bodyH, 0); g.add(dome);
      const flat = new THREE.Mesh(this._keepGeo('led-flat', () => new THREE.BoxGeometry(0.35, bodyH * 0.85, R * 1.5)), bodyMat.clone());
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

    // Pushbutton / key: the 2D shield + legend as the body (labels match 2D), with a real coloured cap that presses down.
    _makeButton(p, d) {
      const THREE = root.THREE, H = 3.2 * MM;
      const g = d ? this._makeArt(p, d, { h: H }) : null;
      if (!g || !g.userData.art.bodyRect) {
        const g2 = new THREE.Group();
        const base = new THREE.Mesh(new THREE.BoxGeometry(6 * MM, 3.2 * MM, 6 * MM), this._mat({ color: 0x2a2d33, roughness: 0.55 }));
        base.position.set(10, 1.6 * MM, 10); base.castShadow = true; g2.add(base);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.2 * MM, 2.2 * MM, 2 * MM, 20), this._mat({ color: 0xe74c3c, roughness: 0.4 }));
        cap.position.set(10, 3.2 * MM + 1.0 * MM, 10); g2.add(cap); g2.userData.cap = cap; g2.userData.capY = cap.position.y;
        return g2;
      }
      const b = g.userData.art.bodyRect, isKey = p.type === 'key';
      const cx = isKey ? 15 : (p.type === 'pushbutton' ? 10 : (b.x0 + b.x1) / 2), cz = isKey ? -1 : (p.type === 'pushbutton' ? 15 : (b.y0 + b.y1) / 2);
      const lbl = (p.props && p.props.label) || '';
      const col = CAPC[p.props && p.props.color] || CAPC[/up|plus|\+/i.test(lbl) ? 'green' : /down|minus/i.test(lbl) ? 'blue' : 'red'];
      const r = isKey ? 6.6 : 7.6;
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(r + 1.6, r + 1.6, 0.8, 24), this._mat({ color: 0x0b0c0e, roughness: 0.7 }));
      ring.position.set(cx, H + 0.4, cz); g.add(ring);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r, 2 * MM, 28), this._mat({ color: col, roughness: 0.35, emissive: col, emissiveIntensity: 0.08 }));
      cap.position.set(cx, H + 1.0 * MM + 0.4, cz); cap.castShadow = true; g.add(cap);
      g.userData.cap = cap; g.userData.capY = cap.position.y;
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
    _labelSprite(text, bg, fg) {
      const THREE = root.THREE;
      const c = document.createElement('canvas'); c.width = 128; c.height = 48;
      const g = c.getContext('2d');
      g.fillStyle = bg; g.beginPath(); if (g.roundRect) g.roundRect(2, 2, 124, 44, 10); else g.rect(2, 2, 124, 44); g.fill();
      g.strokeStyle = fg; g.lineWidth = 3; g.stroke();
      g.fillStyle = fg; g.font = 'bold 28px ui-monospace,monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 26);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
      sp.scale.set(17, 6.4, 1); sp.renderOrder = 6; sp.userData.label = true;
      return sp;
    }
    // 2D ground symbol (⏚) as a 3D marker: black post + three green bars + GND tag
    _makeGround(p) {
      const THREE = root.THREE, g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 8, 12), this._mat({ color: 0x15171a, metalness: 0.3, roughness: 0.4 }));
      post.position.set(0, 4, 0); g.add(post);
      const bm = this._mat({ color: GND_HEX, metalness: 0.2, roughness: 0.35, emissive: GND_HEX, emissiveIntensity: 0.3 });
      [[16, 8.6], [10, 10.4], [4, 12.2]].forEach(([w, y]) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, 1.4, 3), bm); b.position.set(0, y, 0); b.castShadow = true; g.add(b); });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.6, 8, 20), bm); ring.rotation.x = Math.PI / 2; ring.position.set(0, 0.5, 0); g.add(ring);
      const tag = this._labelSprite('GND', '#04130b', '#3ddc84'); tag.position.set(0, 18, 0); g.add(tag);
      g.userData.pinTop = 7.5;   // wires land on the post top
      return g;
    }
    // vcc33 / vcc5 supply: compact module with a red + post and a green GND post (2D pins: + at 0, GND at 20)
    _makeSupply(p, t) {
      const THREE = root.THREE, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(30, 8, 14), this._mat({ color: 0x7f1d1d, roughness: 0.45, metalness: 0.1 }));
      body.position.set(10, 4, -12); body.castShadow = true; g.add(body);
      const tag = this._labelSprite(t === 'vcc5' ? '5V' : '3V3', '#2a0707', '#ff8a80'); tag.position.set(10, 13, -12); g.add(tag);
      const mk = (x, col) => { const m = this._mat({ color: col, metalness: 0.3, roughness: 0.35, emissive: col, emissiveIntensity: 0.25 });
        const post = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 7, 12), m); post.position.set(x, 3.5, 0); g.add(post);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.6, 8, 20), m); ring.rotation.x = Math.PI / 2; ring.position.set(x, 0.5, 0); g.add(ring); };
      mk(0, 0xef4444); mk(20, GND_HEX);
      const gt = this._labelSprite('GND', '#04130b', '#3ddc84'); gt.position.set(20, 11, 3); g.add(gt);
      g.userData.pinTop = 7;
      return g;
    }
    // Breadboard top drawn in the exact 2D coordinates (x −6…W−4, y −14…208) so rails/holes line up with pins
    _bbTexture2D(cols) {
      const THREE = root.THREE, W = cols * 10 + 10, k = 3;
      const c = document.createElement('canvas'); c.width = Math.round((W + 2) * k); c.height = 222 * k;
      const g = c.getContext('2d');
      const X = (x) => (x + 6) * k, Y = (y) => (y + 14) * k;
      g.fillStyle = '#f1ebdd'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#e4dccb'; g.fillRect(0, Y(-14), c.width, 38 * k); g.fillRect(0, Y(170), c.width, 38 * k);
      g.fillStyle = '#d6cdb9'; g.fillRect(0, Y(91), c.width, 12 * k);
      const rail = (y, col) => { g.fillStyle = col; g.fillRect(X(4), Y(y - 0.6), (W - 12) * k, 2.8 * k); };
      rail(-9.6, '#1d4ed8'); rail(17.4, '#dc2626'); rail(171.4, '#dc2626'); rail(197.4, '#1d4ed8');
      g.font = 'bold ' + (11 * k) + 'px ui-sans-serif,system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const x of [-1, W - 4]) { g.fillStyle = '#1d4ed8'; g.fillText('−', X(x), Y(0)); g.fillText('−', X(x), Y(190)); g.fillStyle = '#dc2626'; g.fillText('+', X(x), Y(10)); g.fillText('+', X(x), Y(180)); }
      for (const h of root.Parts.T.breadboard.pins({ props: { cols } })) {
        const neg = /^(tn|bn)/.test(h.name);
        g.fillStyle = neg ? 'rgba(29,78,216,0.22)' : 'rgba(0,0,0,0.14)'; g.fillRect(X(h.x - 3.4), Y(h.y - 3.4), 6.8 * k, 6.8 * k);
        g.fillStyle = '#26262b'; g.fillRect(X(h.x - 2.2), Y(h.y - 2.2), 4.4 * k, 4.4 * k);
      }
      g.fillStyle = 'rgba(40,40,45,0.6)'; g.font = 'bold ' + (7 * k) + 'px ui-sans-serif,system-ui,sans-serif';
      for (let col = 1; col <= cols; col++) if (col === 1 || col % 5 === 0) { const x = 10 + (col - 1) * 10; g.fillText(String(col), X(x), Y(29)); g.fillText(String(col), X(x), Y(164)); }
      const rows = { a: 40, b: 50, c: 60, d: 70, e: 80, f: 110, g: 120, h: 130, i: 140, j: 150 };
      for (const r in rows) { g.fillText(r, X(1), Y(rows[r])); g.fillText(r, X(W - 4), Y(rows[r])); }
      const tex = new THREE.CanvasTexture(c); tex.anisotropy = 8; tex.encoding = THREE.sRGBEncoding;
      return tex;
    }
    // Jumper contact: metal pin into the hole + collar; ground contacts get a green ring
    _contact(pos, col, isGnd) {
      const THREE = root.THREE, g = new THREE.Group();
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.35 * MM, 0.35 * MM, 3.2, 8), this._mat({ color: 0xd8dce2, metalness: 0.3, roughness: 0.25 }));
      pin.position.set(pos.x, pos.y - 1.2, pos.z); g.add(pin);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(WIRE_R * 1.15, WIRE_R * 1.15, 2.4, 12), this._mat({ color: col, roughness: 0.45 }));
      collar.position.set(pos.x, pos.y + 0.6, pos.z); g.add(collar);
      if (isGnd) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(WIRE_R * 2.2, 0.45, 8, 20), this._mat({ color: GND_HEX, emissive: GND_HEX, emissiveIntensity: 0.35, roughness: 0.35 }));
        ring.rotation.x = Math.PI / 2; ring.position.set(pos.x, Math.max(0.6, pos.y - WIRE_R), pos.z); g.add(ring);
      }
      return g;
    }
    _isGndPoint(x, z) {
      const k = Math.round(x) + ',' + Math.round(z);
      const n = this._pinNames && this._pinNames.get(k);
      return !!n && (/GND|^-$/i.test(n) || /^(tn|bn)\d+$/.test(n));
    }
    /* ---- 2D-art parts: the part's own 2D SVG rasterised onto a 3D body (so 3D matches 2D) ---- */
    // Off-screen SVG host in the page so the 2D stylesheet classes resolve; we inline computed styles before rasterising.
    _artHost() {
      if (this._artSvg && this._artSvg.isConnected) return this._artSvg;
      const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg');
      s.setAttribute('width', '1000'); s.setAttribute('height', '1000'); s.setAttribute('aria-hidden', 'true'); s.id = 'art3dHost';
      s.style.cssText = 'position:fixed;left:-30000px;top:0;pointer-events:none;overflow:visible';
      document.body.appendChild(s); this._artSvg = s; return s;
    }
    _artDefs() {
      const d = document.querySelector('#stage defs');
      return d ? d.innerHTML : '';
    }
    // Inline the computed presentation styles of every element (class-based CSS doesn't exist inside an <img> SVG).
    _artInline(g) {
      const PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'filter', 'display'];
      for (const el of g.querySelectorAll('*')) {
        const cs = getComputedStyle(el); let s = '';
        for (const k of PROPS) { let v = cs.getPropertyValue(k); if (!v) continue; v = v.replace(/url\("?[^"#)]*#([^")]+)"?\)/g, 'url(#$1)'); s += k + ':' + v + ';'; }
        if (el.tagName === 'circle') { const r = cs.getPropertyValue('r'); if (r && r !== 'auto' && el.classList.contains('pin')) s += 'r:' + r + ';'; }
        el.setAttribute('style', s); el.removeAttribute('class');
      }
    }
    // Measure the 2D art: full extent (decal) and the solid "body" (what becomes the 3D block).
    _artMeasure(p, d, st) {
      const host = this._artHost(), NS = 'http://www.w3.org/2000/svg';
      const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'part'); g.setAttribute('transform', 'translate(500,500)');
      let html = ''; try { html = d.svg(p, st || null); } catch (_) { html = ''; }
      g.innerHTML = html; host.appendChild(g);
      const hr = host.getBoundingClientRect(), O = (r) => ({ x0: r.left - hr.left - 500, y0: r.top - hr.top - 500, x1: r.right - hr.left - 500, y1: r.bottom - hr.top - 500 });
      const U = (a, b) => (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : b);
      let full = null, body = null, nBody = 0, circ = null;
      for (const el of g.querySelectorAll('rect,path,circle,ellipse,polygon,polyline,line,text,image')) {
        const r = el.getBoundingClientRect(); if (!(r.width || r.height)) continue;
        const b = O(r); full = U(full, b);
        const cs = getComputedStyle(el), tag = el.tagName;
        if (tag === 'line' || tag === 'text' || tag === 'polyline' || el.classList.contains('pin') || /lead|wire-|plbl|w-flow|pot-ind/.test(el.getAttribute('class') || '')) continue;
        if (cs.fill === 'none' || +cs.opacity < 0.5 || +cs.fillOpacity < 0.5) continue;
        if (r.width < 3 || r.height < 3) continue;
        // glow / hot overlays drawn with a filter + low opacity attributes are skipped above; keep solid shapes
        body = U(body, b); nBody++;
        if (tag === 'circle' && !circ) circ = { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, r: (b.x1 - b.x0) / 2 };
      }
      this._artInline(g);
      const inner = g.innerHTML; host.removeChild(g);
      if (!full) return null;
      full = { x0: Math.floor(full.x0 - 3), y0: Math.floor(full.y0 - 3), x1: Math.ceil(full.x1 + 3), y1: Math.ceil(full.y1 + 4) };
      const isCirc = !!(circ && nBody === 1);
      return { full, body, isCirc, circ, inner, svg: html };
    }
    _artRaster(art, inner, done) {
      const f = art.full, W = f.x1 - f.x0, H = f.y1 - f.y0, k = art.k;
      const src = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(W * k)}" height="${Math.round(H * k)}" viewBox="${f.x0} ${f.y0} ${W} ${H}"><defs>${this._artDefsCache || (this._artDefsCache = this._artDefs())}</defs>${inner}</svg>`;
      const im = new Image();
      im.onload = () => {
        const c = art.canvas, x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height);
        if (art.backing) { x.fillStyle = 'rgba(14,17,23,0.78)'; x.beginPath(); if (x.roundRect) x.roundRect(2, 2, c.width - 4, c.height - 4, 4 * k); else x.rect(2, 2, c.width - 4, c.height - 4); x.fill(); }
        x.drawImage(im, 0, 0, c.width, c.height);
        if (art.topCanvas) {
          const b = art.bodyRect, t = art.topCanvas, tx = t.getContext('2d');
          const sx = (b.x0 - f.x0) * k, sy = (b.y0 - f.y0) * k, sw = (b.x1 - b.x0) * k, sh = (b.y1 - b.y0) * k;
          if (!art.bg) {   // average opaque colour of the body → block sides / background behind transparent art
            try { const px = x.getImageData(Math.max(0, sx | 0), Math.max(0, sy | 0), Math.max(1, sw | 0), Math.max(1, sh | 0)).data; const hist = new Map(); let best = null;   // dominant (quantised) opaque colour, not a muddy average
              for (let i = 0; i < px.length; i += 16) if (px[i + 3] > 200) { const key = (px[i] >> 5) << 6 | (px[i + 1] >> 5) << 3 | (px[i + 2] >> 5); let e = hist.get(key); if (!e) hist.set(key, e = [0, 0, 0, 0]); e[0] += px[i]; e[1] += px[i + 1]; e[2] += px[i + 2]; e[3]++; if (!best || e[3] > best[3]) best = e; }
              if (best) art.bg = [best[0] / best[3], best[1] / best[3], best[2] / best[3]]; } catch (_) {}
            if (art.bg && art.side && !art.sideFixed) { art.side.color.setRGB(art.bg[0] / 255 * 0.8, art.bg[1] / 255 * 0.8, art.bg[2] / 255 * 0.8).convertSRGBToLinear(); }
          }
          tx.clearRect(0, 0, t.width, t.height);
          if (!art.topClear) { const bg = art.bg || [40, 46, 56]; tx.fillStyle = `rgb(${bg[0] | 0},${bg[1] | 0},${bg[2] | 0})`; tx.fillRect(0, 0, t.width, t.height); }
          tx.drawImage(c, sx, sy, sw, sh, 0, 0, t.width, t.height);
          art.topTex.needsUpdate = true;
        }
        art.tex.needsUpdate = true; art.busy = false; if (done) done();
      };
      im.onerror = () => { art.busy = false; };
      art.busy = true; im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
    }
    // opts: h (block height), body {x0,y0,x1,y1} override, noBody, topClear, side (hex), round (corner radius), bodyY (lift)
    _makeArt(p, d, opts) {
      const THREE = root.THREE; opts = opts || {};
      const st = this.sim && this.sim.partState ? (this.sim.partState(p) || null) : null;
      const m = this._artMeasure(p, d, st); if (!m) return null;
      const g = new THREE.Group(), f = m.full, W = f.x1 - f.x0, H = f.y1 - f.y0;
      const k = Math.max(2, Math.min(10, 1024 / Math.max(W, H)));
      const c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(H * k);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 4;
      const art = { part: p, d, full: f, k, canvas: c, tex, svg: m.svg, busy: false, topClear: !!opts.topClear, backing: !!opts.backing };
      // flat decal on the board: the complete 2D drawing (leads, labels, pin dots) exactly where 2D draws it
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.7, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 }));
      decal.rotation.x = -Math.PI / 2; decal.position.set(f.x0 + W / 2, 0.2, f.y0 + H / 2); decal.renderOrder = 1; decal.userData.decal = true; g.add(decal);
      let body = opts.body || m.body;
      const bw = body ? body.x1 - body.x0 : 0, bh = body ? body.y1 - body.y0 : 0;
      if (!opts.noBody && body && bw >= 4 && bh >= 4) {
        const h = opts.h || 3 * MM, y0 = opts.bodyY || 0;
        art.bodyRect = body;
        const t = document.createElement('canvas'); t.width = Math.max(8, Math.round(bw * k)); t.height = Math.max(8, Math.round(bh * k));
        const ttex = new THREE.CanvasTexture(t); ttex.encoding = THREE.sRGBEncoding; ttex.anisotropy = 4;
        art.topCanvas = t; art.topTex = ttex;
        const side = this._mat({ color: opts.side != null ? opts.side : 0x2a3140, roughness: 0.55, metalness: 0.08 });
        art.side = side; art.sideFixed = opts.side != null;
        const cx = (body.x0 + body.x1) / 2, cz = (body.y0 + body.y1) / 2;
        let blk, top;
        if (m.isCirc && !opts.body && !opts.round) {
          const r = m.circ.r;
          blk = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32), side); blk.position.set(m.circ.cx, y0 + h / 2, m.circ.cy);
          top = new THREE.Mesh(new THREE.CircleGeometry(r, 32), new THREE.MeshStandardMaterial({ map: ttex, roughness: 0.5, metalness: 0.05 }));
          top.rotation.x = -Math.PI / 2; top.position.set(m.circ.cx, y0 + h + 0.06, m.circ.cy);
        } else {
          let geo;
          const rr = Math.min(opts.round || 0, bw / 2 - 0.5, bh / 2 - 0.5);
          if (rr > 0.5) {
            const s = new THREE.Shape(), x0 = -bw / 2, z0 = -bh / 2;
            s.moveTo(x0 + rr, z0); s.lineTo(x0 + bw - rr, z0); s.quadraticCurveTo(x0 + bw, z0, x0 + bw, z0 + rr); s.lineTo(x0 + bw, z0 + bh - rr); s.quadraticCurveTo(x0 + bw, z0 + bh, x0 + bw - rr, z0 + bh);
            s.lineTo(x0 + rr, z0 + bh); s.quadraticCurveTo(x0, z0 + bh, x0, z0 + bh - rr); s.lineTo(x0, z0 + rr); s.quadraticCurveTo(x0, z0, x0 + rr, z0);
            geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 6 });
            geo.rotateX(Math.PI / 2); geo.translate(0, h / 2, 0);   // shape XY → XZ (z kept: 2D y → 3D z), extruded downward then centred
          } else geo = new THREE.BoxGeometry(bw, h, bh);
          blk = new THREE.Mesh(geo, side); blk.position.set(cx, y0 + h / 2, cz);
          top = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), new THREE.MeshStandardMaterial({ map: ttex, roughness: 0.5, metalness: 0.05, transparent: !!opts.topClear, alphaTest: opts.topClear ? 0.05 : 0 }));
          top.rotation.x = -Math.PI / 2; top.position.set(cx, y0 + h + 0.06, cz);
        }
        blk.castShadow = true; blk.receiveShadow = true; g.add(blk); g.add(top);
        art.top = top; art.h = h; art.y0 = y0;
      }
      this._artRaster(art, m.inner);
      this.arts.push(art);
      g.userData.art = art;
      return g;
    }
    _updateArts() {
      const now = performance.now(); if (now - (this._artT || 0) < 250) return; this._artT = now;
      for (const a of this.arts) {
        if (a.busy || a.static) continue;
        const st = this.sim && this.sim.partState ? (this.sim.partState(a.part) || null) : null;
        let s = ''; try { s = a.d.svg(a.part, st); } catch (_) { continue; }
        if (s === a.svg) continue; a.svg = s;
        const host = this._artHost(), NS = 'http://www.w3.org/2000/svg', g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'part'); g.innerHTML = s; host.appendChild(g); this._artInline(g); const inner = g.innerHTML; host.removeChild(g);
        this._artRaster(a, inner);
      }
    }
    _canvasTex(w, h, draw) {
      const THREE = root.THREE, c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t;
    }
    _lead(g, pts, col, r) {
      const THREE = root.THREE;
      const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(q[0], q[1], q[2]))), 16, r || 0.22 * MM, 6, false), this._mat({ color: col, metalness: col === 0xc0c4ca ? 0.9 : 0.1, roughness: 0.3 }));
      m.castShadow = true; g.add(m); return m;
    }
    // Digital multimeter: yellow rounded housing exactly over the 2D body (x −14…44, y −92…−10), the 2D face
    // (LCD with live reading, mode legends, jacks) as the top, a real rotary selector and 4 mm jacks, probe leads to the pins.
    _makeMultimeter(p, d) {
      const THREE = root.THREE, H = 5 * MM;
      const g = this._makeArt(p, d, { h: H, body: { x0: -14, y0: -92, x1: 44, y1: -10 }, side: 0xe9b417, round: 7, topClear: true });
      if (!g) return this._makeCard(p, d);
      // dark rubber face bezel edge for depth
      const rim = new THREE.Mesh(new THREE.BoxGeometry(50, 0.6, 74), this._mat({ color: 0x2b2d31, roughness: 0.7 }));
      rim.position.set(15, H + 0.02, -51); g.add(rim);
      // LCD window: slight bevel frame
      const lcdF = new THREE.Mesh(new THREE.BoxGeometry(44, 0.9, 20), this._mat({ color: 0x111214, roughness: 0.5 }));
      lcdF.position.set(15, H + 0.3, -75); g.add(lcdF);
      g.userData.art.top.position.y = H + 0.8;   // face texture above bezel/frame
      // rotary selector
      const ang = { V: -40, A: 40, 'Ω': 0 }[p.props.mode || 'V'] || 0;
      const knob = new THREE.Group(); knob.position.set(15, H + 0.8, -46);
      const kb = new THREE.Mesh(new THREE.CylinderGeometry(10, 11, 1.6 * MM, 32), this._mat({ color: 0x1a1b1e, roughness: 0.6 }));
      kb.position.y = 0.8 * MM; kb.castShadow = true; knob.add(kb);
      const ptr = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.6, 12), this._mat({ color: 0xf2f2f2, roughness: 0.4 }));
      ptr.position.set(0, 1.6 * MM + 1.6 * MM + 0.2, -5.5); knob.add(ptr);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(5, 1.6 * MM, 19), this._mat({ color: 0x26282c, roughness: 0.55 }));
      grip.position.set(0, 1.6 * MM + 0.8 * MM, 0); knob.add(grip);
      knob.rotation.y = -ang * Math.PI / 180; g.add(knob); g.userData.dmmKnob = knob;
      // 4 mm banana jacks: red VΩA at (0,−22), black COM at (30,−22)
      const jack = (x, col) => {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 1.4 * MM, 24), this._mat({ color: col, roughness: 0.45, emissive: col, emissiveIntensity: col === 0xc62828 ? 0.12 : 0 }));
        ring.position.set(x, H + 0.8 + 0.7 * MM, -22); g.add(ring);
        const hole = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 1.5 * MM + 0.1, 16), this._mat({ color: 0x050505, roughness: 0.9 }));
        hole.position.copy(ring.position); hole.position.y += 0.05; g.add(hole);
        // plugged probe lead: plug body + cable running off the front edge down to the pin
        const plug = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 4 * MM, 16), this._mat({ color: col, roughness: 0.4 }));
        plug.position.set(x, H + 0.8 + 1.4 * MM + 2 * MM, -22); plug.castShadow = true; g.add(plug);
        const ytop = H + 0.8 + 1.4 * MM + 4 * MM;
        this._lead(g, [[x, ytop, -22], [x, ytop + 3, -16], [x, H + 4, -6], [x, 3, -1], [x, 0.6, 0]], col === 0xc62828 ? 0xd32f2f : 0x222222, 0.45 * MM).userData.noSolid = true;
        // probe tip pushed into the board hole at the pin
        const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.35, 2.4, 10), this._mat({ color: 0xc0c4ca, metalness: 0.3, roughness: 0.3 }));
        tip.position.set(x, 0.3, 0); tip.userData.noSolid = true; g.add(tip);
      };
      jack(0, 0xc62828); jack(30, 0x16171a);
      // No pinTop: the + / COM pins are the probe tips on the board in front of the housing (2D y=0), not on top of it.
      // With pinTop set, _endY/_heightAt counted the whole meter box (≈47 high) at the pin, so every jumper to the DMM
      // ended — and rose — in mid-air above the meter. Like LED/resistor leads, wires now plug in at board-top height.
      // The probe leads/tips are left out of the solid box (noSolid) so the pins stay clear, while keepClear makes
      // jumpers to the meter still arch over the housing instead of cutting through it.
      g.userData.keepClear = true;
      return g;
    }
    _pkgLabel(name, sub, w, h, bg, fg) {
      return this._canvasTex(Math.round(w * 8), Math.round(h * 8), (x, W, Hh) => {
        x.fillStyle = bg; x.fillRect(0, 0, W, Hh); x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.font = `bold ${Math.round(Hh * (sub ? 0.3 : 0.42))}px ui-monospace,Menlo,monospace`; x.fillText(name, W / 2, Hh * (sub ? 0.36 : 0.5), W * 0.92);
        if (sub) { x.globalAlpha = 0.75; x.font = `${Math.round(Hh * 0.22)}px ui-monospace,Menlo,monospace`; x.fillText(sub, W / 2, Hh * 0.72, W * 0.92); }
      });
    }
    // TO-92 (2N2222/2N3904/…): standing D-profile epoxy body like the 2D silhouette, flat face forward with print, three legs to the pins.
    _makeTo92(p, d, name, sub) {
      const THREE = root.THREE, g = new THREE.Group(), xs = [0, 10, 20];
      const legY = 7, w = 28, hR = 10, hA = 10, dep = 4 * MM, zf = -4;
      const s = new THREE.Shape(); s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, hR); s.absellipse(0, hR, w / 2, hA, 0, Math.PI, false); s.lineTo(-w / 2, 0);
      const geo = new THREE.ExtrudeGeometry(s, { depth: dep, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 2, curveSegments: 16 });
      const body = new THREE.Mesh(geo, this._mat({ color: 0x1c1e22, roughness: 0.62, metalness: 0.05 }));
      body.position.set(10, legY, zf - dep); body.castShadow = true; g.add(body);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 4, hR + 4), new THREE.MeshStandardMaterial({ map: this._pkgLabel(name, sub, w - 4, hR + 4, '#1c1e22', '#d8dce2'), roughness: 0.6 }));
      face.position.set(10, legY + (hR + 4) / 2 + 1, zf + 0.7); g.add(face);
      for (const x of xs) this._lead(g, [[x, 0, 0], [x, 2.5, -0.5], [10 + (x - 10) * 0.55, legY + 0.5, zf - dep / 2]], 0xc0c4ca);
      // flat "E B C" legend on the board like 2D
      const lg = new THREE.Mesh(new THREE.PlaneGeometry(30, 7), new THREE.MeshBasicMaterial({ map: this._canvasTex(240, 56, (x, W, Hh) => { x.fillStyle = '#9aa6b6'; x.font = 'bold 30px ui-monospace,monospace'; x.textAlign = 'center'; x.textBaseline = 'middle'; const n = d.pins(p).map((q) => q.name); n.forEach((t, i) => x.fillText(t, (i * 10 + 5) * 8, Hh / 2)); }), transparent: true, depthWrite: false }));
      lg.rotation.x = -Math.PI / 2; lg.position.set(10, 0.25, 8); g.add(lg);
      return g;
    }
    // TO-220 (TIP120, LM7805, IRLZ44N): standing black body with print + aluminium tab with mounting hole, like the 2D package.
    _makeTo220(p, d, name, sub) {
      const THREE = root.THREE, g = new THREE.Group(), pins = d.pins(p), xs = pins.map((q) => q.x);
      const x0 = xs[0] - 8, w = xs[xs.length - 1] - xs[0] + 16, cx = x0 + w / 2, legY = 9, bodyH = 28, tabH = 22, dep = 4.5 * MM, zf = -5;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, bodyH, dep), this._mat({ color: 0x17181b, roughness: 0.6, metalness: 0.05 }));
      body.position.set(cx, legY + bodyH / 2, zf - dep / 2); body.castShadow = true; g.add(body);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 2, bodyH - 4), new THREE.MeshStandardMaterial({ map: this._pkgLabel(name, sub, w - 2, bodyH - 4, '#17181b', '#e6e8eb'), roughness: 0.6 }));
      face.position.set(cx, legY + bodyH / 2, zf + 0.06); g.add(face);
      const tm = this._mat({ color: 0xb9bfc7, metalness: 0.3, roughness: 0.3 });
      const ts = new THREE.Shape(); ts.moveTo(-w / 2 + 1, 0); ts.lineTo(w / 2 - 1, 0); ts.lineTo(w / 2 - 1, tabH); ts.lineTo(-w / 2 + 1, tabH); ts.lineTo(-w / 2 + 1, 0);
      const hole = new THREE.Path(); hole.absarc(0, tabH * 0.45, 4.2, 0, Math.PI * 2, true); ts.holes.push(hole);
      const tab = new THREE.Mesh(new THREE.ExtrudeGeometry(ts, { depth: 1.3 * MM, bevelEnabled: false, curveSegments: 20 }), tm);
      tab.position.set(cx, legY + bodyH - 0.5, zf - dep); tab.castShadow = true; g.add(tab);
      for (const x of xs) this._lead(g, [[x, 0, 0], [x, 3, -0.5], [x, legY + 0.5, zf - dep / 2]], 0xc0c4ca, 0.3 * MM);
      if (p.props && p.props.heatsink) {
        const hs = new THREE.Mesh(new THREE.BoxGeometry(w + 8, 18, 3 * MM), this._mat({ color: 0x1a1c20, roughness: 0.5 }));
        hs.position.set(cx, legY + bodyH + 10, zf - dep - 1.5 * MM - 1.3 * MM); g.add(hs);
      }
      const lg = new THREE.Mesh(new THREE.PlaneGeometry(w, 7), new THREE.MeshBasicMaterial({ map: this._canvasTex(Math.round(w * 8), 56, (x, W, Hh) => { x.fillStyle = '#9aa6b6'; x.font = 'bold 30px ui-monospace,monospace'; x.textAlign = 'center'; x.textBaseline = 'middle'; pins.forEach((q) => x.fillText(q.name, (q.x - x0) * 8, Hh / 2)); }), transparent: true, depthWrite: false }));
      lg.rotation.x = -Math.PI / 2; lg.position.set(cx, 0.25, 8); g.add(lg);
      return g;
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
      if (t === 'pushbutton' || t === 'key' || t === 'button') return this._makeButton(p, d);
      if (t === 'potentiometer' || t === 'pot') return this._makePot(p);
      if (t === 'capacitor' || t === 'ecap' || t === 'ceramic') return this._makeCap(p);
      if (t === 'multimeter') return this._makeMultimeter(p, d);
      if (TO92[t]) return this._makeTo92(p, d, TO92[t][0], TO92[t][1]);
      if (TO220[t]) return this._makeTo220(p, d, TO220[t][0], TO220[t][1]);
      if (DIP_RE.test(t) && this._dipPins(d, p)) return this._makeDip(p, d);
      if (/lcd|oled|tft|ssd1306|sh110|display/i.test(t)) return this._makeDisplay(p, d);
      if (t === 'motor' || t === 'dcmotor') return this._makeMotor(p);
      if (t === 'servo') return this._makeServo(p);
      if (t === 'ground') return this._makeGround(p);
      if (t === 'vcc33' || t === 'vcc5') return this._makeSupply(p, t);
      
      // everything else: the part's own 2D drawing on a 3D block (matches 2D instead of a plain dark box)
      const a = this._makeArt(p, d, ART_OPTS[t] || {});
      return a || this._makeCard(p, d);
    }
    _dipPins(d, p) { try { const ps = d.pins(p); if (ps.length < 4 || ps.length % 2) return false; const ys = [...new Set(ps.map((q) => q.y))]; return ys.length === 2; } catch (_) { return false; } }

    /* ---- tidy Manhattan / jumper wires ---- */
    // Height of the tallest non-breadboard part covering (x,z) — wires must clear it / land on it.
    // Parts that own a pin are skipped (a wire plugs in next to an LED/resistor lead, not on top of it),
    // except boards with a header (pinTop) where the wire lands on the header pin.
    _heightAt(x, z, pad, skip) {
      let h = 0;
      for (const e of (this._partBoxes || [])) {
        if (skip && skip.has(e.id) && e.pinTop == null && !e.keepClear) continue;
        const b = e.box;
        if (x >= b.min.x - pad && x <= b.max.x + pad && z >= b.min.z - pad && z <= b.max.z + pad) h = Math.max(h, b.max.y);
      }
      return h;
    }
    _heightAlong(A, B, skip) {
      let h = 0;
      for (let i = 0; i <= 24; i++) { const t = i / 24; h = Math.max(h, this._heightAt(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t, 2, skip)); }
      return h;
    }
    _endY(x, z, base) {
      const own = (this._pinOwners && this._pinOwners.get(Math.round(x) + ',' + Math.round(z))) || null;
      let h = this._heightAt(x, z, 0.5, own ? new Set([own]) : null);
      if (own) { const e = this._partBoxes.find((q) => q.id === own); if (e && e.pinTop != null) h = Math.max(h, e.pinTop); }
      return { y: Math.max(base, h ? h + WIRE_R * 0.6 : base), own };
    }
    // Phase 1 — endpoints + base route of one jumper, no meshes yet (so all wires can be laid out together).
    _planWire(w, onBoard) {
      const THREE = root.THREE;
      const a = w.a, b = w.b;
      if (!a || !b) return null;
      const boardTop = WIRE_R + 0.4;
      // Endpoints: on the board surface, or on top of a part that covers the pin (ESP32 headers, modules)
      const ea = this._endY(a.x, a.y, boardTop), eb = this._endY(b.x, b.y, boardTop);
      const ya = ea.y, yb = eb.y, skip = new Set([ea.own, eb.own].filter(Boolean));
      const A = new THREE.Vector3(a.x, ya, a.y);
      const B = new THREE.Vector3(b.x, yb, b.y);
      const dx = B.x - A.x, dz = B.z - A.z;
      const dist = Math.hypot(dx, dz);
      const via = (w.pts || []).filter((q) => q && isFinite(q.x) && isFinite(q.y));
      // clear anything the run passes over
      let clear = 0; { let prev = A; for (const q of [...via.map((q) => new THREE.Vector3(q.x, 0, q.y)), B]) { clear = Math.max(clear, this._heightAlong(prev, q, skip)); prev = q; } }
      if (onBoard && dist > 8) {
        const rise = Math.max(boardTop + Math.min(7, 2.5 + dist * 0.02), clear + WIRE_R * 2 + 1.5, ya + 2, yb + 2);
        let mids;
        if (via.length) mids = via.map((q) => ({ x: q.x, z: q.y }));
        else if (Math.abs(dx) > 4 && Math.abs(dz) > 4) mids = [Math.abs(dx) >= Math.abs(dz) ? { x: B.x, z: A.z } : { x: A.x, z: B.z }];
        else mids = [];
        // horizontal run (x,z) at height `rise`: above A → bends → above B; drop repeated bends
        let run = [{ x: A.x, z: A.z }, ...mids, { x: B.x, z: B.z }].filter((q, i, s) => i === 0 || Math.hypot(q.x - s[i - 1].x, q.z - s[i - 1].z) > 0.05);
        // straight-through bends (collinear, e.g. a 2D via in the middle of a straight run) are not corners
        run = run.filter((q, i, s) => i === 0 || i === s.length - 1 || Math.abs((q.x - s[i - 1].x) * (s[i + 1].z - q.z) - (q.z - s[i - 1].z) * (s[i + 1].x - q.x)) > 0.5 || (q.x - s[i - 1].x) * (s[i + 1].x - q.x) + (q.z - s[i - 1].z) * (s[i + 1].z - q.z) < 0);
        if (run.length < 2) run.push({ x: B.x, z: B.z });
        return { w, a, b, A, B, kind: 'run', run, base: rise, hs: run.slice(1).map(() => rise), off: run.slice(1).map(() => ({ x: 0, z: 0 })), lean: [{ x: 0, z: 0 }, { x: 0, z: 0 }] };
      }
      const mid = A.clone().lerp(B, 0.5);
      mid.y = Math.max(Math.max(ya, yb) + 1.5 + Math.min(6, dist * 0.04), clear + WIRE_R * 2 + 1);
      return { w, a, b, A, B, kind: 'arch', pts: [A, mid, B] };
    }
    // Phase 2 — keep every jumper a separate, readable lead. Root cause of "merged" leads: every Manhattan run over a
    // region rose to the same height (rise only depends on length/obstacles, ~21.4 over the ESP32), so runs that share a
    // breadboard row/column in 2D were drawn as one coincident tube, perpendicular runs crossed *through* each other at
    // the same height (a fused T/X blob), and a run passing over another jumper's pin cut through its riser.
    // Fix: (1) height layers per run segment — segments that cross, touch end-to-end, or pass over another jumper's
    // riser get heights at least one wire diameter + gap apart (greedy, lowest first, capped); the lifted segment's
    // neighbours ramp up at the bend, the rest of the wire stays low; (2) lanes — parallel runs sharing a corridor are
    // fanned out sideways by a wire diameter + gap at the same height (no stacking that hides a lead from the camera);
    // (3) jumpers sharing one hole lean their risers apart, each along its own run (fanned by rank). Pin contact points (board-top / header heights) never move.
    _layoutWires(plans) {
      const R2 = WIRE_R * 2, GAP = 1.4, H = R2 + GAP, LANE = R2 + GAP, MAXUP = 6 * H;
      const P = plans.filter((p) => p && p.kind === 'run');
      if (P.length < 2) return;
      const unit = (s, e) => { const L = Math.hypot(e.x - s.x, e.z - s.z) || 1; return { x: (e.x - s.x) / L, z: (e.z - s.z) / L, L }; };
      const key = (q) => Math.round(q.x) + ',' + Math.round(q.z), pinUse = new Map();
      P.forEach((p, pi) => [p.run[0], p.run[p.run.length - 1]].forEach((q, k) => { const kk = key(q); if (!pinUse.has(kk)) pinUse.set(kk, []); pinUse.get(kk).push({ pi, k }); }));
      const segs = [];
      P.forEach((p, pi) => { for (let k = 0; k < p.run.length - 1; k++) { const s = p.run[k], e = p.run[k + 1], L = Math.hypot(e.x - s.x, e.z - s.z); if (L < 0.05) continue; segs.push({ pi, k, s, e, L, ux: (e.x - s.x) / L, uz: (e.z - s.z) / L }); } });
      const ptSeg = (q, S) => { const t = Math.max(0, Math.min(S.L, (q.x - S.s.x) * S.ux + (q.z - S.s.z) * S.uz)); return Math.hypot(S.s.x + S.ux * t - q.x, S.s.z + S.uz * t - q.z); };
      const mkSeg = (s, e) => { const L = Math.hypot(e.x - s.x, e.z - s.z); return L < 0.05 ? null : { s, e, L, ux: (e.x - s.x) / L, uz: (e.z - s.z) / L }; };
      const segSeg = (S, T) => {
        const d1 = (T.s.x - S.s.x) * S.uz - (T.s.z - S.s.z) * S.ux, d2 = (T.e.x - S.s.x) * S.uz - (T.e.z - S.s.z) * S.ux;
        const d3 = (S.s.x - T.s.x) * T.uz - (S.s.z - T.s.z) * T.ux, d4 = (S.e.x - T.s.x) * T.uz - (S.e.z - T.s.z) * T.ux;
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
        return Math.min(ptSeg(T.s, S), ptSeg(T.e, S), ptSeg(S.s, T), ptSeg(S.e, T));
      };
      // conflicts are per run *segment* (not per wire), so a wire only climbs where it actually crosses/touches another and
      // stays at its own height elsewhere (whole-wire layers stacked parallel neighbours and hid the lower ones from the camera)
      const conflict = segs.map(() => new Set()), over = segs.map(() => new Set()); // over[e] ∋ s: segment s passes over the riser at the end of segment e → s above e
      const link = (x, y) => { conflict[x].add(y); conflict[y].add(x); };
      const parent = segs.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let x = 0; x < segs.length; x++) for (let y = x + 1; y < segs.length; y++) {
        const S = segs[x], T = segs[y]; if (S.pi === T.pi) continue;
        if (Math.abs(S.ux * T.uz - S.uz * T.ux) < 0.2) {
          const px = T.s.x - S.s.x, pz = T.s.z - S.s.z, perp = Math.abs(px * S.uz - pz * S.ux);
          if (perp > R2 + GAP) continue;
          const t0 = px * S.ux + pz * S.uz, t1 = (T.e.x - S.s.x) * S.ux + (T.e.z - S.s.z) * S.uz;
          const ov = Math.min(S.L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
          // a shared corridor → fan out sideways into lanes at the same height (stacking them instead hid the lower lead
          // under the upper one from the default camera); only an end-to-end touch needs a height step
          if (ov > R2) parent[find(x)] = find(y); else if (ov > -R2) link(x, y);
        } else if (segSeg(S, T) < R2 + GAP * 0.5) link(x, y);
      }
      // (2) lanes: fan parallel runs sharing a corridor out sideways, one lane per wire, ordered by position then wire order
      const groups = new Map();
      segs.forEach((S, x) => { const r = find(x); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(S); });
      for (const G of groups.values()) {
        const byWire = new Map(); for (const S of G) { if (!byWire.has(S.pi)) byWire.set(S.pi, []); byWire.get(S.pi).push(S); }
        if (byWire.size < 2) continue;
        const nx = -G[0].uz, nz = G[0].ux;
        const m = [...byWire].map(([pi, Ss]) => ({ pi, Ss, perp: Ss.reduce((s, S) => s + S.s.x * nx + S.s.z * nz, 0) / Ss.length })).sort((u, v) => u.perp - v.perp || u.pi - v.pi);
        let pos = m.map((q) => q.perp); for (let k = 1; k < pos.length; k++) pos[k] = Math.max(pos[k], pos[k - 1] + LANE);
        const shift = m.reduce((s, q, k) => s + (q.perp - pos[k]), 0) / m.length; pos = pos.map((v) => v + shift);
        m.forEach((q, k) => { const d = pos[k] - q.perp; for (const S of q.Ss) { const o = P[S.pi].off[S.k]; o.x += nx * d; o.z += nz * d; } });
      }
      // (3) jumpers sharing one hole: each riser leans along its own run and sideways (its lane, else fanned by rank),
      // so the leads leave the hole as separate wires instead of one stacked post
      for (const users of pinUse.values()) if (users.length > 1) {
        const U = users.map(({ pi, k }) => { const p = P[pi], m = p.run.length; return { p, k, u: k ? unit(p.run[m - 1], p.run[m - 2]) : unit(p.run[0], p.run[1]), lane: p.off[k ? m - 2 : 0] }; });
        U.forEach((q) => {
          // fan sideways only among leads leaving the hole in (about) the same direction; others already part along their runs
          const same = U.filter((o) => o.u.x * q.u.x + o.u.z * q.u.z > 0.7), r = same.indexOf(q);
          const along = Math.min(LANE * (1 + r), 0.4 * q.u.L), side = (r - (same.length - 1) / 2) * LANE, hasLane = !!(q.lane.x || q.lane.z);
          const l = hasLane ? { x: q.u.x * along + q.lane.x, z: q.u.z * along + q.lane.z } : { x: q.u.x * along - q.u.z * side, z: q.u.z * along + q.u.x * side };
          l.along = along; l.u = q.u; l.lane = hasLane; q.p.lean[q.k] = l;
        });
      }
      // runs passing over another jumper's riser (pin → lean point; it climbs to that jumper's end-segment height)
      const segAt = new Map(); segs.forEach((S, x) => segAt.set(S.pi + ':' + S.k, x));
      P.forEach((p, i) => [0, 1].forEach((k) => {
        const q = k ? p.run[p.run.length - 1] : p.run[0], top = { x: q.x + p.lean[k].x, z: q.z + p.lean[k].z }, F = mkSeg(q, top);
        const E = segAt.get(i + ':' + (k ? p.run.length - 2 : 0)); if (E == null) return;
        const sharers = new Set((pinUse.get(key(q)) || []).map((u) => u.pi));
        segs.forEach((S, x) => {
          if (S.pi === i || sharers.has(S.pi)) return;
          if ((F ? segSeg(F, S) : ptSeg(q, S)) < R2 + GAP * 0.5) { over[E].add(x); link(E, x); }
        });
      }));
      // (1) heights: lowest segments first; each takes the lowest height ≥ its wire's clearance that is a full layer away
      // from every conflicting segment already placed (and above any placed riser it passes over)
      const base = segs.map((S) => P[S.pi].base), h = base.slice();
      const order = segs.map((_, x) => x).sort((x, y) => base[x] - base[y] || segs[x].pi - segs[y].pi || segs[x].k - segs[y].k), done = new Set();
      const fits = (x, c) => { for (const y of conflict[x]) if (done.has(y) && Math.abs(c - h[y]) < H - 1e-6) return false; for (const y of done) if (over[y].has(x) && c < h[y] + H - 1e-6) return false; return true; };
      for (const x of order) {
        let lo = base[x]; for (const y of done) if (over[y].has(x)) lo = Math.max(lo, h[y] + H);
        const cands = [lo, ...[...conflict[x]].filter((y) => done.has(y)).map((y) => h[y] + H)].filter((c) => c >= lo).sort((a, b) => a - b);
        let c = cands.find((v) => fits(x, v)); if (c == null) c = lo;
        h[x] = Math.min(c, base[x] + MAXUP); done.add(x);
      }
      for (let pass = 0; pass < 4; pass++) for (let e = 0; e < segs.length; e++) for (const x of over[e]) if (h[x] < h[e] + H && h[e] + H <= base[x] + MAXUP) h[x] = h[e] + H;
      segs.forEach((S, x) => { P[S.pi].hs[S.k] = h[x]; });
      for (const p of P) [0, 1].forEach((k) => { const l = p.lean[k]; if (!l.u) return; const y = k ? p.B.y : p.A.y, hh = k ? p.hs[p.hs.length - 1] : p.hs[0], extra = Math.max(0, Math.min(0.3 * (hh - y), 2 * LANE, 0.4 * l.u.L) - LANE); l.x += l.u.x * extra; l.z += l.u.z * extra; });
    }
    // Phase 3 — polyline from the laid-out run (height h, lane offsets, leaning risers) and the meshes.
    _wirePoints(p) {
      const THREE = root.THREE;
      if (p.kind !== 'run') return p.pts;
      const r = p.run, hs = p.hs, o = p.off, n = r.length, V = (x, z, y) => new THREE.Vector3(x, y, z), out = [p.A.clone()];
      const dir = (k) => { const L = Math.hypot(r[k + 1].x - r[k].x, r[k + 1].z - r[k].z) || 1; return { x: (r[k + 1].x - r[k].x) / L, z: (r[k + 1].z - r[k].z) / L, L }; };
      const ramp = (k) => Math.min(10, 0.3 * dir(k).L);
      const u0 = dir(0), ue = dir(n - 2), l0 = p.lean[0], l1 = p.lean[1];
      out.push(V(r[0].x + l0.x, r[0].z + l0.z, hs[0]));
      if ((o[0].x || o[0].z) && !l0.lane) out.push(V(r[0].x + l0.x + u0.x * LANE_JOG + o[0].x, r[0].z + l0.z + u0.z * LANE_JOG + o[0].z, hs[0]));
      for (let k = 1; k < n - 1; k++) {
        const u1 = dir(k - 1), u2 = dir(k), o1 = o[k - 1], o2 = o[k], h1 = hs[k - 1], h2 = hs[k], top = Math.max(h1, h2), den = u1.x * u2.z - u1.z * u2.x;
        if (Math.abs(den) < 0.2) { out.push(V(r[k].x + o1.x, r[k].z + o1.z, h1)); if (Math.hypot(o2.x - o1.x, o2.z - o1.z) > 0.05 || h2 !== h1) out.push(V(r[k].x + o2.x, r[k].z + o2.z, h2)); continue; }
        const qx = o2.x - o1.x, qz = o2.z - o1.z, t = (qx * u2.z - qz * u2.x) / den;   // r+o1+t·u1 = r+o2+s·u2
        const cx = r[k].x + o1.x + t * u1.x, cz = r[k].z + o1.z + t * u1.z;
        // a segment that was lifted over a crossing meets its lower neighbour at the bend: the lower one ramps up to it there
        if (h1 < top) { const d = ramp(k - 1); out.push(V(cx - u1.x * d, cz - u1.z * d, h1)); }
        out.push(V(cx, cz, top));
        if (h2 < top) { const d = ramp(k); out.push(V(cx + u2.x * d, cz + u2.z * d, h2)); }
      }
      const oe = o[n - 2], he = hs[n - 2];
      if ((oe.x || oe.z) && !l1.lane) out.push(V(r[n - 1].x + l1.x - ue.x * LANE_JOG + oe.x, r[n - 1].z + l1.z - ue.z * LANE_JOG + oe.z, he));
      out.push(V(r[n - 1].x + l1.x, r[n - 1].z + l1.z, he));
      out.push(p.B.clone());
      return out;
    }
    _filletPts(pts, rad) {
      const out = [pts[0].clone()];
      for (let i = 1; i < pts.length - 1; i++) {
        const P0 = pts[i - 1], P = pts[i], P1 = pts[i + 1];
        const a = P.clone().sub(P0), b = P1.clone().sub(P), la = a.length(), lb = b.length();
        if (la < 1e-6 || lb < 1e-6) continue;
        a.divideScalar(la); b.divideScalar(lb);
        const d = Math.min(rad, 0.45 * la, 0.45 * lb);
        if (a.dot(b) > 0.995 || d < 0.3) { out.push(P.clone()); continue; }
        const s = P.clone().addScaledVector(a, -d), e = P.clone().addScaledVector(b, d);
        for (let k = 0; k <= 4; k++) { const t = k / 4, u = 1 - t; out.push(new root.THREE.Vector3(u * u * s.x + 2 * u * t * P.x + t * t * e.x, u * u * s.y + 2 * u * t * P.y + t * t * e.y, u * u * s.z + 2 * u * t * P.z + t * t * e.z)); }
      }
      out.push(pts[pts.length - 1].clone());
      return out.filter((q, i) => i === 0 || q.distanceTo(out[i - 1]) > 0.05);
    }
    _makeWire(w, onBoard) { const p = this._planWire(w, onBoard); return p ? this._buildWire(p) : null; }
    _buildWire(p) {
      const THREE = root.THREE, w = p.w, a = p.a, b = p.b;
      let pts = this._wirePoints(p);
      // drop consecutive duplicates (CatmullRom NaNs on zero-length segments)
      pts = pts.filter((q, i) => i === 0 || q.distanceTo(pts[i - 1]) > 0.05);
      if (pts.length < 2) return null;
      // Runs: round each bend with a small fillet and spline through the dense result (centripetal). A plain Catmull-Rom
      // through the sparse Manhattan bends bowed long runs ~4 units sideways, so neighbours one breadboard pitch apart touched.
      const curve = p.kind === 'run' && pts.length > 2 ? new THREE.CatmullRomCurve3(this._filletPts(pts, 4.5), false, 'centripetal')
        : new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.15);
      const radial = 8;
      const segs = Math.max(12, Math.floor(curve.getLength() / 3));
      const col = wireHex(w.color);
      const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, WIRE_R * 0.45, radial, false), this._mat({ color: 0xb8bcc2, metalness: 0.85, roughness: 0.28 }));
      const ins = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, WIRE_R, radial, false), this._mat({
        color: col, metalness: 0.06, roughness: 0.42,
        emissive: col, emissiveIntensity: this.softGL ? 0.22 : 0.08
      }));
      ins.castShadow = true;
      // 1-px colored centre line: keeps every wire visible even when zoomed far out
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(Math.max(16, segs))), new THREE.LineBasicMaterial({ color: col }));
      const group = new THREE.Group(); group.add(core); group.add(ins); group.add(line);
      const gA = this._isGndPoint(a.x, a.y), gB = this._isGndPoint(b.x, b.y);
      group.add(this._contact(pts[0], col, gA)); group.add(this._contact(pts[pts.length - 1], col, gB));
      group.userData.gnd = gA || gB;
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
        const geo = new THREE.SphereGeometry(WIRE_R * 1.45, 10, 8);
        const mat = this._mat({ color: 0xffffff, emissive: 0xe6fdff, emissiveIntensity: 2.2, transparent: true, opacity: 0, roughness: 0.2 });
        const mesh = new THREE.Mesh(geo, mat);
        this.pulseRoot.add(mesh);
        this.pulses.push({ id, mesh, mat, t: Math.random(), curve: w.curve });
      }
      this._linearize(this.pulseRoot);
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
      try { this._updateArts(); } catch (e) { console.warn('3D art update', e); }
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
        p.mesh.scale.setScalar(1 + Math.min(1.2, mag * 35));
      }
    }

    _hitPart(e) {
      const THREE = root.THREE; if (!THREE || !this.camera) return null;
      const rect = this.canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(mouse, this.camera);
      const hits = ray.intersectObjects([...this.parts.values()].map((x) => x.mesh), true);
      for (const h of hits) {
        if (h.object.isSprite) continue;
        let o = h.object;
        while (o) { for (const [id, rec] of this.parts) if (rec.mesh === o) return { id, rec, part: rec.part, point: h.point }; o = o.parent; }
      }
      return null;
    }
    _onPick(e) {
      if (!this._ptr || performance.now() - this._ptr.t > 400) return;
      if (Math.hypot(e.clientX - this._ptr.x, e.clientY - this._ptr.y) > 5) return;   // that was an orbit drag
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
            // select only — no camera move on a single click (that read as "click zooms the canvas")
            if (rec.part.type === 'breadboard') return;
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
          if (this._frames === 1) t3d('firstFrame');
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
    // Box of solid meshes only (skips glow sprites, lights, shadow discs)
    _solidBox(obj) {
      const THREE = root.THREE, box = new THREE.Box3(), tmp = new THREE.Box3();
      obj.traverse((c) => {
        if (!c.isMesh || c.isSprite || !c.geometry || !c.visible || c.userData.noSolid) return;
        if (c.material && c.material.transparent && c.material.depthWrite === false) return;
        if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
        tmp.copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld); box.union(tmp);
      });
      return box;
    }
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
    // Sample the dark margins, not the cream breadboard (it reads as "near white").
    // A blank white frame lights the margins up; a framed board leaves them dark.
    // One edge row instead of the whole drawing buffer — the full readback stalled the first frames.
    _whiteFraction(gl) {
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      if (W < 2 || H < 2) return 0;
      const prev = gl.getParameter(gl.PACK_ALIGNMENT);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      const buf = new Uint8Array(W * 4);
      let n = 0, white = 0;
      try {
        gl.readPixels(0, H - 1, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const step = Math.max(1, Math.floor(W / 48));
        for (let x = 0; x < W; x += step) {
          const i = x * 4, r = buf[i], g = buf[i + 1], b = buf[i + 2];
          n++; if (Math.min(r, g, b) > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 40) white++;
        }
      } finally { gl.pixelStorei(gl.PACK_ALIGNMENT, prev || 4); }
      return n ? white / n : 0;
    }
    // Resolves {ok} on the first real frame so the loader can drop. The white-frame
    // readback is deferred to the next frame: doing it here stalled presentation
    // (~300 ms on SwiftShader) because readPixels waits for the GPU.
    healthCheck(timeout = 3000) {
      return new Promise((res) => {
        if (!this.ready) return res({ ok: false, why: 'not ready' });
        if (this._cameraInsideBoard()) return res({ ok: false, why: 'camera', camera: true });
        const start = this._frames || 0, t0 = performance.now();
        const gl = this.renderer.getContext();
        const whiteLater = () => {
          let worst = 0;
          try {
            if (!gl || gl.isContextLost()) { if (this.hooks.onFail) this.hooks.onFail(new Error('WebGL context lost')); return; }
            worst = this._whiteFraction(gl);
          } catch (_) { return; }
          this.lastWhite = worst;
          if (worst > 0.6 && this.hooks.onFail) { const er = new Error('white frame'); er.camera = true; this.hooks.onFail(er); }
        };
        this._probe = () => {
          if ((this._frames || 0) - start < 1) return;
          this._probe = null;
          if (gl && gl.isContextLost()) return res({ ok: false, why: 'WebGL context lost' });
          res({ ok: true });
          requestAnimationFrame(whiteLater);
        };
        const wait = () => {
          if (!this._probe) return;
          if (this._lost) { this._probe = null; return res({ ok: false, why: 'WebGL context lost' }); }
          if (performance.now() - t0 > timeout) {
            this._probe = null;
            return res(gl && gl.isContextLost() ? { ok: false, why: 'WebGL context lost' } : { ok: true, noFrames: true });
          }
          setTimeout(wait, 100);
        };
        wait();
      });
    }
    dispose() {
      cancelAnimationFrame(this._raf); cancelAnimationFrame(this._resizeRaf);
      root.removeEventListener('resize', this._onResize);
      if (this._ro) this._ro.disconnect();
      this.clear();
      if (this._geoCache) for (const g of this._geoCache.values()) g.dispose();
      if (this._matCache) for (const m of this._matCache.values()) m.dispose();
      if (this._texCache) for (const t of this._texCache.values()) t.dispose();
      this._geoCache = this._matCache = this._texCache = null;
      if (this.renderer) this.renderer.dispose();
    }
  }

  root.View3D = View3D;
  root.View3DFit = { fitCameraToBox: fitCameraToBox, contentPadding: contentPadding };
  root.View3DLoad = { wants3dFx: wants3dFx };
  root.loadView3D = async function loadView3D(wrap, hooks) {
    t3d('initStart');
    const v = new View3D(wrap, hooks);
    await v.init();
    t3d('init');
    return v;
  };
})(typeof window !== 'undefined' ? window : globalThis);
