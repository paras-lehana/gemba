// 3D digital twin of one plant floor (Three.js). Machines are stylised by type; each carries an andon light whose
// colour is its state. Parts flow along running lines. Lenses recolour by health, energy or quality.
// Falls back to a 2D map when WebGL or the module CDN is not available.
// v0.4: live value labels above every machine (flash green when a reading goes up, red when it goes down), stopped
// machines go dark with a red STOPPED tag and freeze their line, marks for "Repaired" / "Repair in progress".
import { store, h, STATUS, num } from "./core.js";

/** The one reading that tells most about a machine right now: vibration for anything that shakes, header pressure for
 * compressors, otherwise the power it draws. `row` is a live or time-travel machine row. */
export function primaryReading(m, row) {
  if (!m || !row) return null;
  const spec = (k) => (m.sensors || []).find((x) => x.key === k);
  if (spec("vib") && row.vib != null) return { key: "vib", label: "Vibration", unit: "mm/s", value: row.vib, d: 2, spec: spec("vib") };
  if (m.kind === "COMPRESSOR" && spec("press") && row.press != null) return { key: "press", label: "Air pressure", unit: "bar", value: row.press, d: 2, spec: spec("press"), lowIsBad: true };
  if (row.kw == null) return null;
  return { key: "kw", label: "Power", unit: "kW", value: row.kw, d: 1 };
}
/** "alarm" | "watch" | "" for a reading against its limits (pressure is bad when LOW). */
export function readingLevel(pr) {
  if (!pr?.spec || pr.value == null) return "";
  const { nominal, alarm } = pr.spec;
  if (pr.lowIsBad) return pr.value <= alarm ? "alarm" : pr.value <= nominal - (nominal - alarm) * 0.6 ? "watch" : "";
  return pr.value >= alarm ? "alarm" : pr.value >= nominal + (alarm - nominal) * 0.6 ? "watch" : "";
}
const MARK_WORD = { down: "STOPPED", alarm: "Act now", watch: "Watch", sensor: "Sensor fault", repair: "Repair in progress" };

const SIZE = {
  VMC: [2.4, 2.4, 2.2], LATHE: [3.4, 1.8, 1.8], GRINDER: [3.0, 2.0, 2.0], BALANCER: [1.8, 1.4, 1.6], HOBBER: [2.2, 2.6, 2.0],
  SHAPER: [2.0, 2.2, 1.8], FURNACE: [3.4, 3.0, 3.0], DEBURR: [1.8, 1.6, 1.6], COMPRESSOR: [2.4, 2.0, 1.6], CHILLER: [2.6, 1.8, 1.6],
  PRESS: [2.8, 4.0, 2.4], WELDER: [2.4, 2.2, 2.4], CASTING: [3.6, 3.2, 3.0], CMM: [2.2, 2.4, 2.0], WASHER: [2.6, 1.8, 1.8], LEAKTEST: [1.6, 1.6, 1.6],
};
const CSSVAR = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const STATUS_VAR = { ok: "--ok", watch: "--watch", alarm: "--alarm", down: "--down", sensor: "--sensor", idle: "--idle", repair: "--link" };

export async function createTwin(container, opts = {}) {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl || matchMedia("(prefers-reduced-motion: reduce)").matches && opts.respectMotion) throw new Error("no webgl");
    const THREE = await import("three");
    const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
    const { CSS2DRenderer, CSS2DObject } = await import("three/addons/renderers/CSS2DRenderer.js");
    return new Twin3D(container, THREE, OrbitControls, CSS2DRenderer, CSS2DObject, opts);
  } catch (e) {
    console.warn("3D twin unavailable, using 2D map", e);
    return new Twin2D(container, opts);
  }
}

class Twin3D {
  constructor(el, THREE, OrbitControls, CSS2DRenderer, CSS2DObject, opts) {
    Object.assign(this, { el, THREE, CSS2DObject, opts, lens: "health", plant: store.plant, meshes: new Map(), parts: [], highlight: new Set(),
      marks: {}, showValues: opts.showValues !== false, liveMode: true, lineSpeed: new Map() });
    const w = el.clientWidth, hgt = el.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, hgt);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute("aria-label", "3D view of the plant floor. Click a machine for details.");
    this.renderer.domElement.setAttribute("role", "img");
    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, hgt);
    Object.assign(this.labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "1" });   // own stacking context: labels stay under the overlay
    el.append(this.labels.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, w / hgt, 0.5, 400);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: Math.PI * 0.46, minDistance: 14, maxDistance: 90 });
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1d26, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(18, 30, 14); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40 });
    this.scene.add(sun);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.ray = new THREE.Raycaster(); this.mouse = new THREE.Vector2();
    this.tip = h("div", { class: "twin-tip", hidden: true });
    el.append(this.tip);
    this.renderer.domElement.addEventListener("pointermove", (e) => this.hover(e));
    this.renderer.domElement.addEventListener("pointerleave", () => { this.tip.hidden = true; this.hovered = null; });
    this.renderer.domElement.addEventListener("click", (e) => { this.hover(e); if (this.hovered) opts.onPick?.(this.hovered); });
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(el);
    this.io = new IntersectionObserver(([en]) => { this.visible = en.isIntersecting; }); this.io.observe(el);
    this.visible = true;
    this.clock = new THREE.Clock();
    this.build(store.plant);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  colors() {
    const c = {};
    for (const [k, v] of Object.entries(STATUS_VAR)) c[k] = new this.THREE.Color(CSSVAR(v) || "#888");
    this.dark = document.documentElement.dataset.theme !== "light";
    return c;
  }

  build(plant) {
    const T = this.THREE;
    this.plant = plant;
    this.root.clear(); this.meshes.clear(); this.parts = [];
    for (const l of [...this.labels.domElement.children]) l.remove();
    this.col = this.colors();
    const ms = store.catalog.machines.filter((m) => m.plant === plant);
    const xs = ms.map((m) => m.pos[0]), zs = ms.map((m) => m.pos[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 14;
    const floor = new T.Mesh(new T.PlaneGeometry(span + 16, span + 10),
      new T.MeshStandardMaterial({ color: this.dark ? 0x141a26 : 0xe9edf3, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.position.set(cx, 0, cz);
    this.root.add(floor);
    const grid = new T.GridHelper(span + 16, Math.round((span + 16) / 2), this.dark ? 0x26304a : 0xd2d8e2, this.dark ? 0x1c2335 : 0xdfe4ec);
    grid.position.set(cx, 0.01, cz); this.root.add(grid);
    // line zones + conveyors
    const lines = store.catalog.lines.filter((l) => l.plant === plant);
    for (const ln of lines) {
      const lm = ms.filter((m) => m.line === ln.id);
      if (!lm.length) continue;
      const x0 = Math.min(...lm.map((m) => m.pos[0])) - 2.6, x1 = Math.max(...lm.map((m) => m.pos[0])) + 2.6, z = lm[0].pos[1];
      const zone = new T.Mesh(new T.PlaneGeometry(x1 - x0, 6.4), new T.MeshStandardMaterial({ color: this.dark ? 0x1b2335 : 0xffffff, roughness: 1 }));
      zone.rotation.x = -Math.PI / 2; zone.position.set((x0 + x1) / 2, 0.02, z); zone.receiveShadow = true;
      this.root.add(zone);
      const stripe = new T.Mesh(new T.PlaneGeometry(x1 - x0, 0.12), new T.MeshBasicMaterial({ color: this.dark ? 0xffb547 : 0xd99a2b }));
      stripe.rotation.x = -Math.PI / 2; stripe.position.set((x0 + x1) / 2, 0.03, z + 3.2); this.root.add(stripe);
      if (ln.product) {
        const belt = new T.Mesh(new T.BoxGeometry(x1 - x0, 0.25, 0.7), new T.MeshStandardMaterial({ color: this.dark ? 0x2b3448 : 0xc9d0dc, roughness: 0.6 }));
        belt.position.set((x0 + x1) / 2, 0.45, z + 2.1); belt.castShadow = true; this.root.add(belt);
        for (let i = 0; i < 7; i++) {
          const p = new T.Mesh(new T.BoxGeometry(0.42, 0.28, 0.42), new T.MeshStandardMaterial({ color: 0xc9ced8, metalness: 0.7, roughness: 0.35 }));
          p.position.set(x0 + (x1 - x0) * (i / 7), 0.72, z + 2.1); p.castShadow = true;
          this.root.add(p);
          this.parts.push({ mesh: p, x0, x1, line: ln.id, phase: i / 7 });
        }
      }
      if (ln.product) {
        const lab = h("div", { style: "font:600 12px var(--sans);color:var(--text-dim);background:color-mix(in srgb,var(--panel) 80%,transparent);padding:2px 8px;border-radius:6px;white-space:nowrap" }, ln.name);
        const o = new this.CSS2DObject(lab); o.position.set(x0 - 0.5, 0.2, z - 3.9); this.root.add(o);
      }
    }
    for (const m of ms) {
      const [sx, sy, sz] = SIZE[m.kind] || [2, 2, 2];
      const g = new T.Group();
      g.position.set(m.pos[0], 0, m.pos[1]);
      const bodyMat = new T.MeshStandardMaterial({ color: this.dark ? 0x9aa6bd : 0xb9c2d1, metalness: 0.35, roughness: 0.45 });
      let body;
      if (m.kind === "COMPRESSOR" || m.kind === "CHILLER") {
        body = new T.Mesh(new T.CylinderGeometry(sy / 2, sy / 2, sx, 24), bodyMat); body.rotation.z = Math.PI / 2; body.position.y = sy / 2 + 0.1;
      } else {
        body = new T.Mesh(new T.BoxGeometry(sx, sy, sz), bodyMat); body.position.y = sy / 2;
      }
      body.castShadow = true; body.receiveShadow = true; body.userData.id = m.id;
      g.add(body);
      const door = new T.Mesh(new T.BoxGeometry(sx * 0.5, sy * 0.45, 0.04), new T.MeshStandardMaterial({ color: 0x223049, metalness: 0.2, roughness: 0.15, transparent: true, opacity: 0.85 }));
      door.position.set(-sx * 0.12, sy * 0.55, sz / 2 + 0.03); if (m.kind !== "COMPRESSOR" && m.kind !== "CHILLER") g.add(door);
      const accent = new T.Mesh(new T.BoxGeometry(sx * 1.002, 0.16, sz * 1.002), new T.MeshStandardMaterial({ color: 0x3a4660, roughness: 0.6 }));
      accent.position.y = 0.08; g.add(accent);
      // andon light stack: pole + lamp
      const pole = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.7, 8), new T.MeshStandardMaterial({ color: 0x5b6478 }));
      pole.position.set(sx / 2 - 0.25, sy + 0.35, -sz / 2 + 0.25); g.add(pole);
      const lampMat = new T.MeshStandardMaterial({ color: this.col.idle, emissive: this.col.idle, emissiveIntensity: 1.2 });
      const lamp = new T.Mesh(new T.CylinderGeometry(0.2, 0.2, 0.42, 16), lampMat);
      lamp.position.set(sx / 2 - 0.25, sy + 0.86, -sz / 2 + 0.25); g.add(lamp);
      const ring = new T.Mesh(new T.RingGeometry(Math.max(sx, sz) * 0.75, Math.max(sx, sz) * 0.75 + 0.18, 48), new T.MeshBasicMaterial({ color: this.col.alarm, transparent: true, opacity: 0, side: T.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; g.add(ring);
      const word = h("span", { class: "tw-word", hidden: true }), val = h("span", { class: "tw-val num" });
      const tag = h("div", { class: "tw-tag st-idle" }, h("span", { class: "tw-row" }, h("b", {}, m.id), val), word);
      const tagObj = new this.CSS2DObject(tag); tagObj.position.set(0, sy + 1.9, 0); tagObj.visible = false; g.add(tagObj);
      this.root.add(g);
      this.meshes.set(m.id, { m, g, body, door, lamp, ring, tag, word, val, tagObj, sy, prevVal: null });
    }
    const dist = span * 0.82 + 8;
    this.camera.position.set(cx + dist * 0.45, dist * 0.62, cz + dist * 0.8);
    this.controls.target.set(cx, 0, cz);
    this.controls.update();
    if (store.tick) this.update(store.tick);
  }

  setPlant(p) { if (p !== this.plant) this.build(p); }
  setLens(l) { this.lens = l; const t = this.tickData || store.tick; if (t) this.update(t); }
  setHighlight(ids) { this.highlight = new Set(ids || []); if (this.tickData) this.update(this.tickData); }
  setShowValues(on) { this.showValues = !!on; if (this.tickData) this.update(this.tickData); }
  retheme() { this.build(this.plant); }

  /** tick: live or time-travel data. extra.marks {id: {cls, text}} override the status word ("Repaired"…);
   * extra.live=false stops the flashing (time travel shows a moment, not a movement). */
  update(tick, extra = {}) {
    this.tickData = tick;
    if (extra.marks) this.marks = extra.marks;
    if (extra.live != null) this.liveMode = extra.live;
    const rates = new Map(), down = new Set();
    for (const [id, o] of this.meshes) {
      const live = tick.machines.find((x) => x.id === id);
      if (!live) continue;
      let c = this.col[live.status] || this.col.idle;
      if (this.lens === "energy") {
        c = new this.THREE.Color().setHSL(0.33 - 0.33 * Math.min(1, live.kw / 45), 0.75, 0.55);
      } else if (this.lens === "quality") {
        const sc = (this.opts.scrap?.[id] ?? 0);
        c = o.m.cycle_s ? new this.THREE.Color().setHSL(0.33 - 0.33 * Math.min(1, sc / 4), 0.75, 0.55) : this.col.idle;
      }
      o.lamp.material.color.copy(c); o.lamp.material.emissive.copy(c);
      o.status = live.status; o.live = live;
      if (o.m.line) {
        if (live.status === "down") down.add(o.m.line);
        if (live.rate) { const r = rates.get(o.m.line) || [0, 0]; rates.set(o.m.line, [r[0] + live.rate, r[1] + 1]); }
      }
      const mark = this.marks?.[id];
      const word = mark ? mark.text : MARK_WORD[live.status] || "";
      o.tag.className = `tw-tag st-${mark ? mark.cls : live.status}${live.status === "down" ? " tw-stopped" : ""}`;
      o.word.textContent = word; o.word.hidden = !word;
      const pr = primaryReading(o.m, live);
      if (pr) {
        let arrow = "";
        if (this.liveMode && o.prevVal != null && Math.abs(pr.value - o.prevVal) > 1e-9) {
          const up = pr.value > o.prevVal;
          arrow = up ? " ▲" : " ▼";
          o.val.classList.remove("up", "down"); void o.val.offsetWidth; o.val.classList.add(up ? "up" : "down");
        }
        if (this.liveMode) o.prevVal = pr.value;
        o.val.textContent = `${num(pr.value, pr.d)} ${pr.unit}${arrow}`;
        o.val.dataset.level = readingLevel(pr);
        o.val.title = pr.label;
      }
      o.val.hidden = !this.showValues || !pr;
      o.tagObj.visible = this.showValues || !!word || this.highlight.has(id) || this.showAll;
      const repairing = mark?.cls === "repair" || live.status === "repair";
      const mat = o.body.material;
      if (live.status === "down") { mat.color.set(this.dark ? 0x1a1013 : 0x3a2428); mat.emissive.set(this.dark ? 0x2a0508 : 0x1a0204); }
      else if (repairing) { mat.color.set(this.dark ? 0x35548a : 0x9db6de); mat.emissive.set(0x000000); }
      else { mat.color.set(this.dark ? 0x9aa6bd : 0xb9c2d1); mat.emissive.set(0x000000); }
      if (o.door) o.door.material.opacity = live.status === "down" ? 0.35 : 0.85;
    }
    this.lineSpeed = new Map();
    for (const [ln, [sum, n]] of rates) this.lineSpeed.set(ln, down.has(ln) ? 0 : sum / n / 4000);
    for (const ln of down) this.lineSpeed.set(ln, 0);
    this.downLines = down;
  }

  hover(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    const hit = this.ray.intersectObjects([...this.meshes.values()].map((o) => o.body))[0];
    const id = hit?.object.userData.id;
    this.hovered = id || null;
    this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
    if (!id) { this.tip.hidden = true; return; }
    const o = this.meshes.get(id), live = o.live || {};
    this.tip.hidden = false;
    this.tip.style.left = `${e.clientX - r.left}px`; this.tip.style.top = `${e.clientY - r.top}px`;
    this.tip.innerHTML = `<div class="row gap"><b>${id}</b><span class="status st-${live.status}">${STATUS[live.status] || ""}</span></div>
      <div class="dim small">${o.m.name}</div>
      <div class="small num">health ${live.health ?? "–"} · ${num(live.kw, 1)} kW${live.vib != null ? ` · ${live.vib} mm/s` : ""}${live.press != null ? ` · ${live.press} bar` : ""}${live.rate ? ` · ${num(live.rate, 0)} parts/h` : ""}</div>
      ${live.status === "down" ? `<div class="small" style="color:var(--alarm)">Stopped: no parts are made on this line.</div>` : ""}`;
  }

  resize() {
    const w = this.el.clientWidth, hgt = this.el.clientHeight;
    if (!w || !hgt) return;
    this.renderer.setSize(w, hgt); this.labels.setSize(w, hgt);
    this.camera.aspect = w / hgt; this.camera.updateProjectionMatrix();
  }

  loop() {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || document.hidden) return;
    const dt = Math.min(0.05, this.clock.getDelta()), t = this.clock.elapsedTime;
    this.controls.update();
    for (const o of this.meshes.values()) {
      const alarm = o.status === "alarm" || o.status === "down";
      o.lamp.material.emissiveIntensity = alarm ? 0.8 + 0.9 * (0.5 + 0.5 * Math.sin(t * 6)) : o.status === "watch" ? 1.0 : 0.6;
      const hl = this.highlight.has(o.m.id);
      o.ring.material.opacity = alarm ? 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3)) : hl ? 0.5 : 0;
      if (hl && !alarm) o.ring.material.color.set(CSSVAR("--lead") || "#f4e8c1"); else o.ring.material.color.copy(this.col.alarm);
      if (o.live && o.live.rate && o.status !== "down" && !this.downLines?.has(o.m.line)) o.body.position.x = Math.sin(t * 40 + o.m.pos[0]) * 0.006;
    }
    for (const p of this.parts) {
      const stopped = this.downLines?.has(p.line);
      const speed = stopped ? 0 : this.lineSpeed.get(p.line) || 0;
      p.phase = (p.phase + speed * dt * 60) % 1;
      p.mesh.position.x = p.x0 + (p.x1 - p.x0) * p.phase;
      p.mesh.visible = speed > 0 || stopped;      // a stopped line keeps its parts, frozen where they were
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.raf); this.ro.disconnect(); this.io.disconnect();
    this.renderer.dispose(); this.el.innerHTML = "";
  }
}

// ------------------------------------------------------------------ 2D fallback (SVG map)
class Twin2D {
  constructor(el, opts) { this.el = el; this.opts = opts; this.lens = "health"; this.highlight = new Set(); this.marks = {}; this.showValues = opts.showValues !== false; this.build(store.plant); }
  build(plant) {
    this.plant = plant;
    const ms = store.catalog.machines.filter((m) => m.plant === plant);
    const xs = ms.map((m) => m.pos[0]), zs = ms.map((m) => m.pos[1]);
    const x0 = Math.min(...xs) - 4, z0 = Math.min(...zs) - 5, w = Math.max(...xs) - x0 + 4, hh = Math.max(...zs) - z0 + 5;
    this.el.querySelector("svg.map2d")?.remove();
    this.el.insertAdjacentHTML("afterbegin", `<svg class="map2d" viewBox="${x0} ${z0} ${w} ${hh}" role="img" aria-label="Plant floor map">${ms.map((m) =>
      `<g data-id="${m.id}" style="cursor:pointer"><rect class="body" x="${m.pos[0] - 1.3}" y="${m.pos[1] - 1.1}" width="2.6" height="2.2" rx=".3" fill="var(--panel-3)" stroke="var(--border-2)" stroke-width=".08"/>
       <circle class="lamp" cx="${m.pos[0]}" cy="${m.pos[1]}" r=".55" fill="var(--idle)"/>
       <text x="${m.pos[0]}" y="${m.pos[1] + 2}" font-size=".8" text-anchor="middle" fill="var(--text-dim)" font-family="var(--mono)">${m.id}</text>
       <text class="v2d" x="${m.pos[0]}" y="${m.pos[1] - 1.5}" font-size=".75" text-anchor="middle" fill="var(--text)" font-family="var(--mono)"></text></g>`).join("")}</svg>`);
    this.el.querySelectorAll("g[data-id]").forEach((g) => g.addEventListener("click", () => this.opts.onPick?.(g.dataset.id)));
    if (store.tick) this.update(store.tick);
  }
  setPlant(p) { if (p !== this.plant) this.build(p); }
  setLens(l) { this.lens = l; }
  setHighlight(ids) { this.highlight = new Set(ids || []); }
  setShowValues(on) { this.showValues = !!on; if (this.tickData) this.update(this.tickData); }
  retheme() {}
  update(tick, extra = {}) {
    this.tickData = tick;
    if (extra.marks) this.marks = extra.marks;
    for (const g of this.el.querySelectorAll("g[data-id]")) {
      const live = tick.machines.find((x) => x.id === g.dataset.id);
      if (!live) continue;
      g.querySelector(".lamp").setAttribute("fill", `var(${STATUS_VAR[live.status] || "--idle"})`);
      g.querySelector(".body").setAttribute("fill", live.status === "down" ? "#2a1418" : "var(--panel-3)");
      const pr = primaryReading(store.machine(g.dataset.id), live), mark = this.marks[g.dataset.id];
      const word = mark ? mark.text : live.status === "down" ? "STOPPED" : "";
      g.querySelector(".v2d").textContent = [word, this.showValues && pr ? `${num(pr.value, pr.d)} ${pr.unit}` : ""].filter(Boolean).join(" · ");
    }
  }
  dispose() { this.el.querySelector("svg.map2d")?.remove(); }
}
