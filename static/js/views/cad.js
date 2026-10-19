// CAD drill-down: a procedural 3D model of one machine that you can pull apart (exploded view), cut open (section
// plane) and click down through Company > Plant > Line > Machine > Assembly > Component > Sensor. Every part says in
// plain words what it does, how it is doing right now (live readings from /api/machines/<id>), which sensor watches
// it, how it usually fails and why that matters to the customer order. Geometry is built in code: no model files.
import { api, store, h, num, hours, statusChip } from "../core.js";
import { term, explain } from "../learn.js";

const COMPANY = "Meridian Precision Components";
const tok = (n, fb = "#888888") => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
const t_ = (key, label) => { try { return term(key, label); } catch (e) { return label || key; } };
const fmt = (v) => v == null ? "–" : num(v, Math.abs(v) < 20 ? 2 : Math.abs(v) < 200 ? 1 : 0);
const txt = (v) => typeof v === "function" ? v() : v;

// ------------------------------------------------------------------ readings: what a number means
function readingOf(st, key) {
  if (key === "kw") return st.kw == null ? null : { value: st.kw, unit: "kW", label: "Electric power" };
  return st.readings?.[key] || null;
}
function band(r) {
  if (!r || r.nominal == null || r.alarm == null) return "ok";
  const v = r.value, inv = r.alarm < r.nominal;
  if (inv) { if (v <= r.trip) return "trip"; if (v <= r.alarm) return "alarm"; return v < r.nominal - (r.nominal - r.alarm) * 0.5 ? "watch" : "ok"; }
  if (v >= r.trip) return "trip"; if (v >= r.alarm) return "alarm"; return v > r.nominal + (r.alarm - r.nominal) * 0.5 ? "watch" : "ok";
}
const BAND_STATUS = { ok: "ok", watch: "watch", alarm: "alarm", trip: "alarm" };
const MOVING = new Set(["vib", "amps", "rpm"]);
function readingSentence(r, key, st) {
  if (!r) return "";
  if (key === "kw") return `It is drawing ${fmt(r.value)} kW of electricity right now. More power for the same work means waste.`;
  if (!st.running && MOVING.has(key)) return `The machine is not running right now, so ${r.label.toLowerCase()} reads close to zero. Judge it when it runs.`;
  const inv = r.alarm < r.nominal, b = band(r), ratio = r.value / r.nominal;
  const judge = {
    ok: "That is in the normal range.",
    watch: inv ? "That is lower than it should be: worth a look." : `That is ${num(ratio, 1)} times normal: higher than it should be.`,
    alarm: inv ? "That is below the alarm level: act now." : "That is past the alarm level: plan a repair now.",
    trip: "That is at the trip limit: the machine should stop itself.",
  }[b];
  return `Normal is about ${fmt(r.nominal)} ${r.unit}. The alarm level is ${fmt(r.alarm)} and the machine stops itself for safety at ${fmt(r.trip)} (the trip limit). ${judge}`;
}
function gauge(r) {
  if (!r || r.nominal == null || r.alarm == null) return null;
  const inv = r.alarm < r.nominal;
  const lo = inv ? r.trip - (r.nominal - r.trip) * 0.3 : 0, hi = inv ? r.nominal + (r.nominal - r.trip) * 0.4 : r.trip * 1.18;
  const p = (v) => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
  const mid = inv ? r.nominal - (r.nominal - r.alarm) * 0.5 : r.nominal + (r.alarm - r.nominal) * 0.5;
  const zones = inv ? [["trip", lo, r.trip], ["alarm", r.trip, r.alarm], ["watch", r.alarm, mid], ["ok", mid, hi]]
    : [["ok", lo, mid], ["watch", mid, r.alarm], ["alarm", r.alarm, r.trip], ["trip", r.trip, hi]];
  return h("div", { class: "cad-gauge", role: "img", "aria-label": `${r.label} ${fmt(r.value)} ${r.unit}; alarm ${fmt(r.alarm)}, trip ${fmt(r.trip)}` },
    h("div", { class: "cad-gauge-bar" }, ...zones.map(([z, a, b]) => h("span", { class: `z-${z}`, style: `width:${p(b) - p(a)}%` })),
      h("i", { class: "cad-gauge-mark", style: `left:${p(r.value)}%` })),
    h("div", { class: "cad-gauge-ticks tiny dim" },
      h("span", { style: `left:${p(r.nominal)}%` }, "normal"), h("span", { style: `left:${p(r.alarm)}%` }, "alarm"), h("span", { style: `left:${p(r.trip)}%` }, "trip")));
}

// ------------------------------------------------------------------ the models (procedural geometry + plain words)
// Part: { id, asm, name, partNo?, does, inside?, failures[], why[], watch[], at[x,y,z], ex[dx,dy,dz] (exploded offset),
//         cut? (section plane cuts it), ghost? (see-through), build(add, T) }. Sensor: { id, key, name, mount, at, does, means }.
// Units are metres; the machine front faces +z.
function vmcModel(cat) {
  const asm = [
    { id: "structure", name: "Structure", does: "The heavy iron frame that holds everything still. Stiffness is what makes a machine accurate." },
    { id: "spindle", name: "Spindle head", does: () => ["Where the cutting happens. The ", t_("spindle", "spindle"), " spins the tool very fast; its ", t_("bearing", "bearings"), " keep it steady. Most expensive breakdowns on this machine start here."] },
    { id: "tooling", name: "Tool changer", does: "Stores the cutting tools and swaps them in automatically, so one machine can drill, mill and tap one part after another." },
    { id: "workholding", name: "Table and fixture", does: "Moves and holds the engine part under the spindle." },
    { id: "coolant", name: "Coolant system", does: () => ["Sprays ", t_("coolant", "coolant"), " on the cut to keep the tool cool and wash away metal chips."] },
    { id: "enclosure", name: "Enclosure", does: "The see-through guard that keeps chips, coolant and people apart." },
  ];
  const parts = [
    { id: "base", asm: "structure", name: "Machine base (bed)", does: "A heavy cast-iron block that everything sits on. Its weight soaks up shaking so cuts stay accurate.",
      failures: ["Levelling bolts work loose, so the machine rocks slightly", "Chips and coolant pile up and rust the slideways"],
      why: ["Machine out of level", "Holes drilled a little off position", "Parts fail inspection"], watch: [], at: [0, 0.25, 0], ex: [0, 0, 0],
      build(add, T) { add(new T.BoxGeometry(2.0, 0.5, 1.5), "casting");
        for (const [x, z] of [[-0.85, -0.6], [0.85, -0.6], [-0.85, 0.6], [0.85, 0.6]]) add(new T.CylinderGeometry(0.07, 0.09, 0.08, 16), "dark", { p: [x, -0.27, z] }); } },
    { id: "column", asm: "structure", name: "Column", does: () => ["The tall upright that carries the spindle head up and down (the ", t_("z-axis", "Z axis"), "). It must not bend while cutting."],
      failures: ["Guide rails or the ball screw wear, so the head wobbles", "The slideway loses its oil film"],
      why: ["Head moves unevenly", "Rougher surface on the part", "Rework or scrap"], watch: [], at: [0, 1.5, -0.45], ex: [0, 0, -0.75],
      build(add, T) { add(new T.BoxGeometry(0.9, 2.0, 0.7), "paint");
        for (const x of [-0.3, 0.3]) add(new T.BoxGeometry(0.07, 1.9, 0.05), "steel", { p: [x, 0, 0.37] }); } },
    { id: "head", asm: "spindle", name: "Spindle head casting", cut: true, does: "The iron housing that carries the spindle cartridge and slides up and down the column on two rails.",
      failures: ["Slide gibs wear loose", "A crash cracks the casting (rare)"], why: ["The tool tilts slightly", "Holes come out at an angle", "Scrap"],
      watch: ["vib"], at: [0, 1.95, 0.2], ex: [0, 0.35, 0.45],
      build(add, T) { add(new T.BoxGeometry(0.6, 0.75, 0.6), "paint"); add(new T.BoxGeometry(0.62, 0.06, 0.62), "dark", { p: [0, 0.4, 0] }); } },
    { id: "housing", asm: "spindle", name: "Spindle cartridge housing", cut: true, does: "A precise steel tube that holds the spindle and its bearings in a perfectly straight line, to a few thousandths of a millimetre.",
      failures: ["Bearing seats wear after a bearing fails", "Coolant gets in past the front seal"], why: ["Bearings fit loosely", "Vibration climbs again soon after a repair"],
      watch: ["vib", "temp"], at: [0, 1.7, 0.22], ex: [0.62, 0.0, 1.05],
      build(add, T) { add(new T.LatheGeometry([new T.Vector2(0.125, -0.4), new T.Vector2(0.165, -0.4), new T.Vector2(0.165, 0.4), new T.Vector2(0.125, 0.4), new T.Vector2(0.125, -0.4)], 40), "steelpaint");
        add(new T.CylinderGeometry(0.19, 0.19, 0.05, 40, 1, true), "dark", { p: [0, -0.22, 0] }); } },
    { id: "shaft", asm: "spindle", name: "Spindle shaft", does: () => ["The shaft that spins the cutting tool at about 12 000 ", t_("rpm", "rpm"), " (200 turns every second). It turns inside the bearings."],
      failures: ["Bent or out of balance after a tool crash", "The tool clamp (drawbar) springs weaken, so the tool slips"],
      why: ["Spindle runs out of true", "Oversize holes", "Scrap"], watch: ["rpm", "vib"], at: [0, 1.65, 0.22], ex: [0, -0.2, 1.05],
      build(add, T) { add(new T.CylinderGeometry(0.058, 0.058, 1.0, 28), "steel"); add(new T.CylinderGeometry(0.075, 0.075, 0.06, 28), "steel", { p: [0, -0.47, 0] }); } },
    { id: "bearingF", asm: "spindle", name: "Front bearing set (2 × 7014)", short: "Worn bearings", partNo: "SPB-7014",
      does: () => ["Two ", t_("bearing", "angular-contact ball bearings"), " next to the tool. They let the spindle spin freely while holding it rock-steady against the cutting force. They carry most of the load, so they wear out first."],
      inside: "Each bearing has an outer ring, an inner ring and 16 steel balls in a cage. Wear starts as tiny pits on the rings. Every ball that rolls over a pit gives a small tap, and thousands of taps a second are what the vibration sensor feels.",
      failures: ["The grease breaks down, so metal rubs on metal", "Tiny pits (spalling) form on the rings", "Coolant gets past the seal and rusts the balls", "Overheating changes the fit until the spindle seizes"],
      why: ["Worn bearing", "Vibration rises", "Tool chatters: wavy marks on the part", "Parts are scrapped", "The customer order ships late"],
      watch: ["vib", "temp"], at: [0, 1.445, 0.22], ex: [0, -0.62, 1.05],
      build(add, T) { for (const y of [-0.025, 0.025]) bearing(add, T, y); } },
    { id: "bearingR", asm: "spindle", name: "Rear bearing (7014)", partNo: "SPB-7014",
      does: "Supports the top of the spindle and lets the shaft grow slightly as it warms up, so the front bearings are not squeezed.",
      inside: "Same build as the front bearings: two rings and 16 balls. It carries less load, so it usually outlasts the front set.",
      failures: ["Wears in sympathy when the front set is left too long", "Dirty grease"], why: ["Spindle noise", "Heat", "Longer repair: the whole cartridge comes out"],
      watch: ["vib", "temp"], at: [0, 1.98, 0.22], ex: [0, 0.55, 1.05], build(add, T) { bearing(add, T, 0); } },
    { id: "tool", asm: "spindle", name: "Cutting tool and holder", does: "The sharp tip that actually removes metal, held in a taper so it sits dead centre in the spindle.",
      failures: ["Edge gets blunt with use", "Chips (breaks) on a hard spot"], why: ["More cutting force", "More motor current and heat", "Poor finish or a broken tool"],
      watch: ["amps"], at: [0, 1.08, 0.22], ex: [0, -1.05, 1.05],
      build(add, T) { add(new T.CylinderGeometry(0.075, 0.04, 0.12, 24), "steel", { p: [0, 0.09, 0] }); add(new T.CylinderGeometry(0.026, 0.026, 0.16, 16), "accent", { p: [0, -0.04, 0] }); } },
    { id: "motor", asm: "spindle", name: "Spindle motor", does: "An electric motor (about 18 kW, like 12 home air conditioners) that turns the spindle.",
      failures: ["Winding insulation ages with heat", "The cooling fan clogs with oil mist", "The coupling or belt wears"],
      why: ["Motor draws more current", "It overheats and trips", "Machine stops mid-cycle"], watch: ["amps", "rpm", "kw"], at: [0, 2.56, 0.22], ex: [0, 1.05, 0.45],
      build(add, T) { add(new T.CylinderGeometry(0.17, 0.17, 0.42, 32), "dark"); add(new T.CylinderGeometry(0.18, 0.18, 0.04, 32), "steel", { p: [0, 0.23, 0] });
        add(new T.BoxGeometry(0.1, 0.12, 0.12), "dark", { p: [0.22, 0, 0] }); add(new T.CylinderGeometry(0.018, 0.018, 0.4, 10), "dark", { p: [0.26, -0.24, 0] }); } },
    { id: "carousel", asm: "tooling", name: "Tool changer (16-pocket carousel)", does: "Stores 16 cutting tools and swaps one into the spindle in about 2 seconds, without a person.",
      failures: ["A pocket drifts out of position, so a tool change crashes", "Low air pressure makes the gripper slow"],
      why: ["Tool change fails", "Machine waits for an operator", "Lost hours on the line"], watch: [], at: [-0.75, 2.0, -0.05], ex: [-0.75, 0.3, 0],
      build(add, T) { add(new T.CylinderGeometry(0.4, 0.4, 0.1, 40), "paint", { r: [0, 0, Math.PI / 2] }); add(new T.BoxGeometry(0.3, 0.12, 0.12), "dark", { p: [0.25, 0, -0.2] });
        for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; add(new T.CylinderGeometry(0.03, 0.03, 0.14, 10), i % 4 ? "accent" : "steel", { p: [-0.02, Math.cos(a) * 0.34, Math.sin(a) * 0.34], r: [0, 0, Math.PI / 2], edges: false }); } } },
    { id: "table", asm: "workholding", name: "Work table (X and Y axes)", does: () => ["Slides left-right and in-out under the spindle, carrying the part. ", t_("ball-screw", "Ball screws"), " move it in steps of one thousandth of a millimetre."],
      failures: ["Ball screw wear causes backlash (a little slack)", "Chips scratch the way covers"], why: ["Hole positions drift", "Parts fail the measuring machine", "Rework"],
      watch: [], at: [0, 0.6, 0.22], ex: [0, 0.22, 0.75],
      build(add, T) { add(new T.BoxGeometry(0.9, 0.1, 0.7), "dark", { p: [0, -0.05, -0.05] }); add(new T.BoxGeometry(1.3, 0.12, 0.6), "steelpaint", { p: [0, 0.06, 0] });
        for (const z of [-0.18, 0, 0.18]) add(new T.BoxGeometry(1.3, 0.012, 0.03), "dark", { p: [0, 0.122, z], edges: false }); } },
    { id: "vise", asm: "workholding", name: "Fixture (vise)", does: () => ["A ", t_("fixture", "fixture"), " clamps the part in exactly the same place every time, so every hole lands where the drawing says."],
      failures: ["Clamping jaws wear", "A chip trapped under the part tilts it"], why: ["Part sits crooked", "Faces cut at an angle", "Scrap"],
      watch: [], at: [0, 0.76, 0.22], ex: [0, 0.55, 0.95],
      build(add, T) { add(new T.BoxGeometry(0.42, 0.05, 0.22), "dark"); for (const x of [-0.19, 0.19]) add(new T.BoxGeometry(0.05, 0.1, 0.22), "steel", { p: [x, 0.06, 0] }); } },
    { id: "workpiece", asm: "workholding", name: `Workpiece: ${cat.product || "CH-15"} cylinder head`, does: "The aluminium engine part this line makes. This machine mills its faces and drills the valve and bolt holes.",
      failures: ["Chatter marks from a shaky spindle", "Holes oversize from a worn tool", "Porosity (tiny gas bubbles) from the casting supplier"],
      why: ["Fails inspection", "Scrapped: metal, machine time and energy wasted", "Fewer good parts for the order"], watch: ["scrap"], at: [0, 0.86, 0.22], ex: [0, 0.95, 1.1],
      build(add, T) { add(new T.BoxGeometry(0.33, 0.1, 0.16), "alu");
        for (let i = 0; i < 4; i++) add(new T.CylinderGeometry(0.026, 0.026, 0.104, 16), "dark", { p: [-0.12 + i * 0.08, 0.002, 0], edges: false }); } },
    { id: "tank", asm: "coolant", name: "Coolant tank", does: "Holds about 300 litres of water-based coolant that is pumped round and round.",
      failures: ["Bacteria grow and the coolant smells", "Chips settle and block the outlet"], why: ["Skin problems for operators", "Tools rust", "Unplanned clean-out"],
      watch: [], at: [1.32, 0.18, 0.1], ex: [0.8, 0, 0.3],
      build(add, T) { add(new T.BoxGeometry(0.5, 0.36, 0.8), "coolant"); add(new T.BoxGeometry(0.52, 0.03, 0.82), "dark", { p: [0, 0.19, 0] }); } },
    { id: "pump", asm: "coolant", name: "Coolant pump", does: "Pushes coolant up the hose and onto the cut through nozzles near the tool.",
      failures: ["The pump seal leaks", "Chips block the filter, so flow drops"], why: ["Tool runs hot", "Tool wears out faster", "Rough finish and higher tool cost"],
      watch: [], at: [1.32, 0.45, 0.32], ex: [0.8, 0.45, 0.4],
      build(add, T) { add(new T.CylinderGeometry(0.07, 0.07, 0.2, 20), "dark");
        const c = new T.CatmullRomCurve3([new T.Vector3(0, 0.1, 0), new T.Vector3(0, 0.7, 0), new T.Vector3(-0.6, 1.0, 0.1), new T.Vector3(-1.12, 0.78, 0.0)]);
        add(new T.TubeGeometry(c, 40, 0.014, 8), "coolant", { edges: false }); } },
    { id: "doors", asm: "enclosure", name: "Enclosure and doors", ghost: true, does: () => ["Keeps chips and coolant in and people safe. The machine will not cut while a door is open (an ", t_("interlock", "interlock"), ")."],
      failures: ["The door switch is taped over (unsafe)", "Window scratched so the operator cannot see the cut"], why: ["Injury risk", "Audit finding", "Machine stopped by safety"],
      watch: [], at: [0, 1.15, 0.86], ex: [0, 0, 1.6],
      build(add, T) { for (const x of [-0.5, 0.5]) { add(new T.BoxGeometry(0.98, 1.2, 0.02), "glass", { p: [x, 0, 0] }); add(new T.BoxGeometry(0.04, 0.3, 0.04), "accent", { p: [x > 0 ? -0.43 : 0.43, 0, 0.03] }); }
        for (const x of [-1.0, 1.0]) add(new T.BoxGeometry(0.02, 1.2, 0.95), "glass", { p: [x, 0, -0.47] });
        add(new T.BoxGeometry(2.02, 0.08, 0.06), "paint", { p: [0, 0.64, 0] }); } },
  ];
  const sensors = [
    { id: "s-vib", key: "vib", name: "Vibration sensor (accelerometer)", mount: "housing", at: [0.168, -0.24, 0], kind: "puck", tag: [[0.03, 0.05, 0], [-0.08, 1]],
      does: () => ["A small sensor bolted to the spindle housing that feels shaking, like a fingertip on the machine. It reports ", t_("vibration", "vibration"), " as ", t_("rms", "mm/s RMS"), ": an average shaking speed."],
      means: "A healthy spindle hums at about 1.6 mm/s. Worn bearings make it climb steadily; a sudden jump usually means a crash or a loose part." },
    { id: "s-temp", key: "temp", name: "Bearing temperature sensor", mount: "housing", at: [-0.118, -0.27, 0.118], kind: "probe", tag: [[0, -0.05, 0], [1.05, 0]],
      does: "A probe that touches the outside of the front bearing ring. A dry or worn bearing rubs and heats up.",
      means: "Temperature rises after vibration does. When both rise together, the bearing is the cause, not the sensor." },
    { id: "s-amps", key: "amps", name: "Current clamp on the motor cable", mount: "motor", at: [0.26, -0.3, 0], kind: "clamp", tag: [[0.05, 0, 0], [-0.08, 0.5]],
      does: "A clip around the motor cable that measures how much electric current the motor draws.",
      means: "More current means the motor is working harder: a blunt tool, a dragging bearing or a heavier cut." },
    { id: "s-rpm", key: "rpm", name: "Speed encoder", mount: "motor", at: [0, 0.27, 0], kind: "puck", tag: [[0, 0.05, 0], [0.5, 1.1]],
      does: () => ["Counts how fast the spindle turns, in ", t_("rpm", "revolutions per minute"), "."],
      means: "Speed should match the program. A slip under load points at the drive or the coupling." },
  ];
  const dims = [
    { a: [-1.25, 0, 0.9], b: [-1.25, 2.79, 0.9], text: "2 790 mm high" },
    { a: [-1.0, 0.0, 1.12], b: [1.0, 0.0, 1.12], text: "2 000 mm" },
    { a: [-0.65, 0.73, 0.6], b: [0.65, 0.73, 0.6], text: "table 1 300 mm" },
  ];
  return { asm, parts, sensors, dims, target: [0, 1.25, 0.2], size: 3.2, primaryKey: "bearingF", cutHint: "Turn on Cut away to slice the spindle open and see the bearings inside.",
    tags: { bearingF: "7014 bearing · 70 mm bore × 110 mm × 20 mm" } };
}

function bearing(add, T, y) {
  const ring = (r0, r1, hh) => new T.LatheGeometry([new T.Vector2(r0, -hh), new T.Vector2(r1, -hh), new T.Vector2(r1, hh), new T.Vector2(r0, hh), new T.Vector2(r0, -hh)], 40);
  add(ring(0.104, 0.124, 0.02), "steel", { p: [0, y, 0] });
  add(ring(0.059, 0.077, 0.02), "steel", { p: [0, y, 0] });
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; add(new T.SphereGeometry(0.0145, 10, 8), "ball", { p: [Math.cos(a) * 0.0905, y, Math.sin(a) * 0.0905], edges: false }); }
}

function compressorModel(cat) {
  const asm = [
    { id: "frame", name: "Frame", does: "The steel skid the whole package is bolted to." },
    { id: "drive", name: "Drive and air end", does: () => ["The motor and the ", t_("compressor", "compressor"), " head that squeeze outside air. This is where almost all the electricity goes."] },
    { id: "storage", name: "Air storage and cooling", does: "Cools the hot squeezed air, removes water and stores it in a tank." },
    { id: "distribution", name: "Air distribution", does: "Pipes that carry the air to every machine. Leaks hide here." },
  ];
  const parts = [
    { id: "skid", asm: "frame", name: "Base frame (skid)", does: "A welded steel frame with rubber mounts so the compressor's shaking does not travel into the floor.",
      failures: ["Rubber mounts harden and crack"], why: ["Shaking spreads to pipes", "Joints loosen", "More leaks"], watch: [], at: [0, 0.06, 0], ex: [0, 0, 0],
      build(add, T) { add(new T.BoxGeometry(2.4, 0.12, 1.2), "casting"); } },
    { id: "tank", asm: "storage", name: "Air receiver tank", cut: true, does: "A pressure tank that stores compressed air, so the compressor does not start and stop for every puff of air the plant uses.",
      failures: ["Water left in the tank rusts it from inside", "The safety valve sticks"], why: ["Wet air reaches the tools", "Air tools and valves rust", "Machines stop"],
      watch: ["press"], at: [0, 0.62, -0.28], ex: [0, 0.15, -0.8],
      build(add, T) { add(new T.CylinderGeometry(0.36, 0.36, 1.4, 40, 1, true), "paintblue", { r: [0, 0, Math.PI / 2] });
        for (const x of [-0.7, 0.7]) add(new T.SphereGeometry(0.36, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), "paintblue", { p: [x, 0, 0], r: [0, 0, x < 0 ? Math.PI / 2 : -Math.PI / 2] });
        for (const x of [-0.45, 0.45]) add(new T.BoxGeometry(0.12, 0.2, 0.5), "dark", { p: [x, -0.4, 0] }); } },
    { id: "condensate", asm: "storage", name: "Condensate (water) in the tank", does: () => ["Air carries moisture. When it is squeezed and cooled, water drops out and collects at the bottom of the tank. This ", t_("condensate", "condensate"), " must be drained every day."],
      failures: ["The automatic drain valve sticks shut"], why: ["Water builds up", "Wet air reaches the machines", "Rust and sticky valves"], watch: [], at: [0, 0.32, -0.28], ex: [0, -0.1, -0.8],
      build(add, T) { add(new T.BoxGeometry(1.5, 0.05, 0.34), "water", { edges: false }); } },
    { id: "motor", asm: "drive", name: "Drive motor", does: `The electric motor that drives the compressor. It is the single biggest electricity user on this site (${cat.name.match(/\d+ kW/)?.[0] || "tens of kW"}).`,
      failures: ["Bearings wear", "Dust clogs the cooling fins"], why: ["Runs hotter", "Uses more power", "Trips and the plant loses air"],
      watch: ["kw"], at: [0.62, 0.36, 0.3], ex: [0.75, 0.15, 0.55],
      build(add, T) { add(new T.CylinderGeometry(0.2, 0.2, 0.55, 32), "dark", { r: [0, 0, Math.PI / 2] }); add(new T.BoxGeometry(0.14, 0.12, 0.14), "dark", { p: [0, 0.24, 0] });
        add(new T.CylinderGeometry(0.06, 0.06, 0.16, 16), "steel", { p: [-0.35, 0, 0], r: [0, 0, Math.PI / 2] }); } },
    { id: "airend", asm: "drive", name: "Compressor head (air end)", cut: true, does: () => ["Squeezes outside air to about 7 ", t_("bar", "bar"), " (seven times normal air pressure). Oil inside seals and cools it."],
      failures: ["Oil gets old or low, so it runs hot", "Inlet filter clogs"], why: ["Oil temperature rises", "Compressor trips on high temperature", "No air: every machine stops"],
      watch: ["temp"], at: [-0.12, 0.42, 0.3], ex: [0, 0.45, 0.75],
      build(add, T) { add(new T.BoxGeometry(0.5, 0.48, 0.42), "paint"); add(new T.CylinderGeometry(0.12, 0.12, 0.12, 24), "dark", { p: [0, 0.3, 0] }); } },
    { id: "rotors", asm: "drive", name: "Screw rotors", does: "Two interlocking screws inside the head. Air is trapped between them and squeezed smaller as they turn.",
      failures: ["Rotor coating wears", "Rotor bearings wear"], why: ["Less air for the same power", "Higher cost per cubic metre of air"], watch: ["temp"], at: [-0.12, 0.42, 0.3], ex: [0, 0.45, 1.3],
      build(add, T) { for (const z of [-0.07, 0.07]) { add(new T.CylinderGeometry(0.065, 0.065, 0.42, 20), "steel", { p: [0, 0, z], r: [0, 0, Math.PI / 2] });
        for (let i = 0; i < 6; i++) add(new T.TorusGeometry(0.066, 0.008, 6, 20), "dark", { p: [-0.18 + i * 0.072, 0, z], r: [0, Math.PI / 2, 0], edges: false }); } } },
    { id: "cooler", asm: "storage", name: "Aftercooler", does: "A radiator that cools the hot compressed air so the water in it turns to droplets and can be removed.",
      failures: ["Fins clog with dust and oil"], why: ["Air leaves hot and wet", "Water reaches the machines"], watch: [], at: [-0.88, 0.55, 0.3], ex: [-0.7, 0.25, 0.5],
      build(add, T) { add(new T.BoxGeometry(0.16, 0.7, 0.5), "dark"); for (let i = 0; i < 8; i++) add(new T.BoxGeometry(0.17, 0.012, 0.5), "steel", { p: [0, -0.3 + i * 0.085, 0], edges: false }); } },
    { id: "header", asm: "distribution", name: "Air header and pipes", does: "The main pipe that carries compressed air from here to every machine on the line.",
      failures: ["Joints loosen with vibration", "Old hoses crack"], why: ["Air escapes", "Pressure at the machines drops", "Air tools and clamps get weak"],
      watch: ["press"], at: [-0.12, 1.25, 0.3], ex: [0, 0.6, 0.3],
      build(add, T) { add(new T.CylinderGeometry(0.04, 0.04, 0.6, 16), "copper", { p: [0, -0.3, 0] }); add(new T.CylinderGeometry(0.04, 0.04, 1.6, 16), "copper", { p: [0.8, 0, 0], r: [0, 0, Math.PI / 2] });
        add(new T.CylinderGeometry(0.03, 0.03, 0.4, 12), "copper", { p: [0.12, -0.2, -0.58], r: [0, 0, 0] }); add(new T.CylinderGeometry(0.03, 0.03, 0.6, 12), "copper", { p: [0.12, 0, -0.29], r: [Math.PI / 2, 0, 0] }); } },
    { id: "coupling", asm: "distribution", name: "Quick coupling (leak point)", short: "Air leak", does: () => ["A push-fit joint where a hose connects to the pipe. Worn seals here leak with a hiss: the most common ", t_("air_leak", "air leak"), " in a plant."],
      failures: ["The rubber seal wears or splits", "Someone leaves a hose half connected"],
      why: ["Air leaks out day and night", "The compressor runs longer to hold 7 bar", "A 3 mm hole wastes about 1 kW, all the time", "Higher electricity bill and more CO2"],
      watch: ["press", "kw"], at: [1.32, 1.25, 0.3], ex: [0.5, 0.6, 0.3],
      build(add, T) { add(new T.CylinderGeometry(0.06, 0.06, 0.1, 20), "steel", { r: [0, 0, Math.PI / 2] }); add(new T.CylinderGeometry(0.025, 0.025, 0.5, 12), "dark", { p: [0.08, -0.28, 0] }); } },
  ];
  const keys = new Set(cat.sensors.map((s) => s.key));
  const sensors = [
    keys.has("press") && { id: "s-press", key: "press", name: "Pressure transmitter", mount: "header", at: [0.5, 0.06, 0], kind: "probe",
      does: () => ["Measures the air pressure in the main pipe, in ", t_("bar", "bar"), "."], means: "Pressure should sit near 7 bar. If it sags while the compressor works harder, air is escaping somewhere." },
    keys.has("temp") && { id: "s-temp", key: "temp", name: "Oil temperature sensor", mount: "airend", at: [0.26, 0.1, 0.1], kind: "probe",
      does: "Measures the oil leaving the compressor head.", means: "Hot oil means the compressor is working too hard or its cooler is blocked." },
    { id: "s-kw", key: "kw", name: "Power meter", mount: "motor", at: [0, 0.32, 0], kind: "clamp",
      does: "Measures the electricity the motor uses, in kilowatts.", means: "If power goes up but the plant is not using more air, the extra air is leaking away." },
  ].filter(Boolean);
  const dims = [{ a: [-1.2, 0, 0.8], b: [1.2, 0, 0.8], text: "2 400 mm" }, { a: [1.55, 0, 0.3], b: [1.55, 1.25, 0.3], text: "header 1 250 mm" }];
  return { asm, parts, sensors, dims, target: [0, 0.55, 0], size: 2.6, primaryKey: "coupling", leak: "coupling",
    cutHint: "Turn on Cut away to slice the tank and the compressor head open: see the water that collects and the screw rotors." };
}

const SIZE = { LATHE: [3.4, 1.8, 1.8], GRINDER: [3.0, 2.0, 2.0], BALANCER: [1.8, 1.4, 1.6], HOBBER: [2.2, 2.6, 2.0], SHAPER: [2.0, 2.2, 1.8],
  FURNACE: [3.4, 3.0, 3.0], DEBURR: [1.8, 1.6, 1.6], CHILLER: [2.6, 1.8, 1.6], PRESS: [2.8, 4.0, 2.4], WELDER: [2.4, 2.2, 2.4],
  CASTING: [3.6, 3.2, 3.0], CMM: [2.2, 2.4, 2.0], WASHER: [2.6, 1.8, 1.8], LEAKTEST: [1.6, 1.6, 1.6] };
function genericModel(cat) {
  const [w, hh, dp] = SIZE[cat.kind] || [2.2, 2.0, 1.8];
  const bodyH = hh * 0.62;
  const asm = [{ id: "structure", name: "Structure", does: "The frame and guards." }, { id: "process", name: "Process", does: `Where the ${cat.name.toLowerCase()} does its work.` },
    { id: "drive", name: "Drive and controls", does: "The motor that moves it and the cabinet that tells it what to do." }];
  const parts = [
    { id: "base", asm: "structure", name: "Base", does: "The heavy frame everything stands on.", failures: ["Loose anchor bolts"], why: ["Shaking", "Lost accuracy"], watch: [], at: [0, 0.12, 0], ex: [0, 0, 0],
      build(add, T) { add(new T.BoxGeometry(w, 0.24, dp), "casting"); } },
    { id: "body", asm: "process", name: "Machine body", cut: true, does: `The main housing of the ${cat.name.toLowerCase()}.`, failures: ["Worn guides or seals", "Heat damage"], why: ["Readings drift", "Quality drops"],
      watch: cat.sensors.filter((s) => ["temp", "press", "leak"].includes(s.key)).map((s) => s.key), at: [-w * 0.08, 0.24 + bodyH / 2, -dp * 0.05], ex: [0, 0.4, 0.4],
      build(add, T) { add(new T.BoxGeometry(w * 0.72, bodyH, dp * 0.72), "paint"); add(new T.BoxGeometry(w * 0.45, bodyH * 0.45, 0.02), "glass", { p: [0, 0.05, dp * 0.36 + 0.01] }); } },
    { id: "core", asm: "process", name: "Working zone", does: "Where the part is cut, heated, measured or washed.", failures: ["Tooling wears", "Dirt builds up"], why: ["Bad parts", "Scrap"],
      watch: cat.sensors.filter((s) => s.key === "vib").map((s) => s.key), at: [-w * 0.08, 0.24 + bodyH * 0.45, -dp * 0.05], ex: [0, 0.4, 1.2],
      build(add, T) { add(new T.CylinderGeometry(Math.min(w, dp) * 0.16, Math.min(w, dp) * 0.16, bodyH * 0.5, 28), "steel"); } },
    { id: "motor", asm: "drive", name: "Drive motor", does: "The electric motor that powers the moving parts.", failures: ["Bearings wear", "Overheating"], why: ["More current", "Trip", "Stoppage"],
      watch: [...cat.sensors.filter((s) => s.key === "amps").map((s) => s.key), "kw"], at: [-w * 0.08, 0.24 + bodyH + 0.18, -dp * 0.2], ex: [0, 0.8, 0],
      build(add, T) { add(new T.CylinderGeometry(0.17, 0.17, 0.5, 28), "dark", { r: [0, 0, Math.PI / 2] }); } },
    { id: "cabinet", asm: "drive", name: "Control cabinet", does: "The computer and switches that run the machine program.", failures: ["Cooling fan fails", "Loose wiring"], why: ["Random stops", "Lost hours"],
      watch: [], at: [w * 0.42, 0.24 + hh * 0.36, -dp * 0.2], ex: [0.7, 0, 0],
      build(add, T) { add(new T.BoxGeometry(0.45, hh * 0.72, 0.4), "dark"); add(new T.BoxGeometry(0.2, 0.14, 0.01), "screen", { p: [0, hh * 0.2, 0.205], edges: false }); } },
  ];
  const mountFor = { vib: ["core", [Math.min(w, dp) * 0.17, 0, 0]], temp: ["body", [w * 0.36, bodyH * 0.2, 0]], amps: ["motor", [0, 0.2, 0]], press: ["body", [-w * 0.36, 0, 0.1]], leak: ["body", [0, bodyH * 0.5, 0.1]], rpm: ["motor", [0.27, 0, 0]] };
  const sensors = cat.sensors.map((s) => { const [mount, at] = mountFor[s.key] || ["body", [0, bodyH * 0.5, 0]];
    return { id: `s-${s.key}`, key: s.key, name: `${s.label} sensor`, mount, at, kind: "puck", does: `Measures ${s.label.toLowerCase()} in ${s.unit}.`,
      means: `Normal is about ${s.nominal} ${s.unit}; the alarm level is ${s.alarm}.` }; });
  const dims = [{ a: [-w / 2, 0, dp / 2 + 0.25], b: [w / 2, 0, dp / 2 + 0.25], text: `${num(w * 1000)} mm` }];
  return { asm, parts, sensors, dims, target: [0, hh * 0.45, 0], size: Math.max(w, hh, dp) * 1.1, generic: true };
}

// Which parts are failing right now, read from the live machine state.
function diagnose(model, st) {
  const fail = new Map();   // partId -> "alarm" | "watch"
  const sensorFault = new Set(st.faults?.map((f) => f.key) || []);
  const vib = st.readings?.vib, temp = st.readings?.temp, amps = st.readings?.amps, press = st.readings?.press;
  const lvl = st.status === "alarm" ? "alarm" : "watch";
  if (model.primaryKey === "bearingF") {
    if (!sensorFault.has("vib") && st.running && (st.ttf || (vib && band(vib) !== "ok"))) { fail.set("bearingF", lvl); fail.set("bearingR", "watch"); }
    if (!sensorFault.has("temp") && temp && band(temp) !== "ok") fail.set("bearingF", BAND_STATUS[band(temp)] === "alarm" ? "alarm" : fail.get("bearingF") || "watch");
    if (!sensorFault.has("amps") && st.running && amps && band(amps) !== "ok") fail.set("motor", BAND_STATUS[band(amps)]);
  } else if (model.leak) {
    if (["watch", "alarm"].includes(st.status) || (press && band(press) !== "ok")) fail.set("coupling", lvl);
    if (temp && band(temp) !== "ok") fail.set("airend", BAND_STATUS[band(temp)]);
  } else if (["watch", "alarm"].includes(st.status) && !sensorFault.size) {
    const worst = [...(st.health_breakdown || [])].filter((b) => b.key !== "anomaly").sort((a, b) => b.penalty - a.penalty)[0];
    const map = { vib: "core", temp: "body", amps: "motor", press: "body", leak: "body" };
    if (worst && worst.penalty > 5) fail.set(map[worst.key] || "body", lvl);
  }
  const primary = fail.size ? [...fail.entries()].sort((a, b) => (b[1] === "alarm") - (a[1] === "alarm"))[0][0] : null;
  return { fail, sensorFault, primary };
}

// ------------------------------------------------------------------ the 3D viewer
const PAINT = {
  casting: [0x5d6677, 0.25, 0.75], paint: [0xb6bdc9, 0.15, 0.55], steelpaint: [0xa9b3c1, 0.35, 0.4], steel: [0xd3d9e2, 0.45, 0.3], ball: [0xe6eaf0, 0.5, 0.2],
  dark: [0x353b47, 0.3, 0.6], glass: [0x9cc4ff, 0, 0.1, 0.13], coolant: [0x2f8fb0, 0.1, 0.5], alu: [0xc9ccd3, 0.4, 0.35], accent: [0xe0b42a, 0.2, 0.5],
  water: [0x3aa0ff, 0, 0.2, 0.75], copper: [0xb8743f, 0.45, 0.35], paintblue: [0x5a7fa8, 0.2, 0.5], screen: [0x2a9d8f, 0, 0.3],
};

async function createViewer(stage, model, hooks) {
  const T = await import("three");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  const { CSS2DRenderer, CSS2DObject } = await import("three/addons/renderers/CSS2DRenderer.js");
  const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
  if (!gl) throw new Error("WebGL is not available in this browser");
  const W = () => Math.max(stage.clientWidth, 10), H = () => Math.max(stage.clientHeight, 10);
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W(), H());
  renderer.localClippingEnabled = true;
  renderer.domElement.className = "cad-canvas";
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "3D model of the machine. Drag to turn, pinch or scroll to zoom, tap a part to drill down. The part list below does the same.");
  stage.append(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(W(), H());
  labels.domElement.className = "cad-labels";
  stage.append(labels.domElement);

  const scene = new T.Scene();
  const persp = new T.PerspectiveCamera(38, W() / H(), 0.05, 200);
  const ortho = new T.OrthographicCamera(-1, 1, 1, -1, -50, 200);
  let cam = persp, orthoHalf = 2;
  const target0 = new T.Vector3(...model.target);
  const home = () => target0.clone().add(new T.Vector3(1.0, 0.55, 1.35).multiplyScalar(model.size * 1.25));
  persp.position.copy(home());
  const controls = new OrbitControls(cam, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.09, minDistance: 0.4, maxDistance: model.size * 6, maxPolarAngle: Math.PI * 0.53, screenSpacePanning: true });
  controls.target.copy(target0);
  controls.update();

  scene.add(new T.HemisphereLight(0xffffff, 0x404a5c, 1.5));
  const key = new T.DirectionalLight(0xffffff, 1.7); key.position.set(4, 7, 5); scene.add(key);
  const fill = new T.DirectionalLight(0xffffff, 0.6); fill.position.set(-5, 3, -4); scene.add(fill);
  const gridSize = Math.ceil(model.size * 3);
  let grid = null;
  const axes = new T.AxesHelper(0.5); axes.position.set(-model.size * 0.55, 0.002, model.size * 0.45); scene.add(axes);

  const root = new T.Group(); scene.add(root);
  const parts = new Map(), sensors = new Map(), pickables = [];
  const edgeMats = [];
  const C = {};
  function colors() {
    for (const [k, v] of [["sel", "--link"], ["alarm", "--alarm"], ["watch", "--watch"], ["sensor", "--sensor"], ["edge", "--text-faint"], ["g1", "--border-2"], ["g2", "--border"], ["dim", "--text-dim"]]) C[k] = new T.Color(tok(v));
  }
  colors();
  function makeGrid() {
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    grid = new T.GridHelper(gridSize, gridSize * 4, C.g1, C.g2);
    grid.material.transparent = true; grid.material.opacity = 0.75; scene.add(grid);
  }
  makeGrid();

  const material = (kind, def) => {
    const [c, m, r, o] = PAINT[kind] || PAINT.paint;
    const mat = new T.MeshStandardMaterial({ color: c, metalness: m, roughness: r, transparent: true, opacity: o ?? 1, depthWrite: o == null,
      side: def.cut || o != null ? T.DoubleSide : T.FrontSide, emissive: kind === "screen" ? 0x1a6d63 : 0x000000 });
    mat.userData.base = o ?? 1; mat.userData.kind = kind;
    return mat;
  };
  for (const def of model.parts) {
    const g = new T.Group(); g.position.fromArray(def.at); g.userData.base = g.position.clone(); g.userData.ex = new T.Vector3(...def.ex);
    const rec = { def, g, mats: [], edges: [], plane: def.cut ? new T.Plane(new T.Vector3(0, 0, -1), 0) : null };
    const edgeMat = new T.LineBasicMaterial({ color: C.edge, transparent: true, opacity: def.ghost ? 0.35 : 0.5 });
    edgeMats.push(edgeMat); rec.edgeMat = edgeMat;
    const add = (geo, kind, o = {}) => {
      const mat = material(kind, def); rec.mats.push(mat);
      const mesh = new T.Mesh(geo, mat);
      if (o.p) mesh.position.set(...o.p); if (o.r) mesh.rotation.set(...o.r);
      mesh.userData.pick = { type: "part", id: def.id };
      if (o.edges !== false) mesh.add(new T.LineSegments(new T.EdgesGeometry(geo, 30), edgeMat));
      g.add(mesh); pickables.push(mesh);
      return mesh;
    };
    def.build(add, T);
    root.add(g); parts.set(def.id, rec);
  }
  // sensors: small blue pucks/probes/clamps with a larger invisible touch target and a clickable label
  const hitMat = new T.MeshBasicMaterial({ visible: false });
  for (const s of model.sensors) {
    const mount = parts.get(s.mount); if (!mount) continue;
    const g = new T.Group(); g.position.fromArray(s.at);
    const mat = new T.MeshStandardMaterial({ color: C.sensor, emissive: C.sensor, emissiveIntensity: 0.45, roughness: 0.4, transparent: true });
    mat.userData.base = 1;
    const geo = s.kind === "clamp" ? new T.TorusGeometry(0.035, 0.012, 8, 20) : s.kind === "probe" ? new T.CylinderGeometry(0.014, 0.014, 0.09, 12) : new T.CylinderGeometry(0.03, 0.03, 0.045, 18);
    const m = new T.Mesh(geo, mat);
    if (s.kind === "puck") m.rotation.z = Math.abs(s.at[0]) > Math.abs(s.at[2]) ? Math.PI / 2 : 0;
    if (s.kind === "clamp") m.rotation.x = Math.PI / 2;
    if (s.kind === "probe") m.rotation.z = Math.PI / 2;
    const hit = new T.Mesh(new T.SphereGeometry(0.085, 10, 8), hitMat);
    m.userData.pick = hit.userData.pick = { type: "sensor", id: s.id };
    g.add(m, hit); pickables.push(hit, m);
    const tagEl = h("button", { class: "cad-tag sensor", type: "button", onclick: (e) => { e.stopPropagation(); hooks.onPick({ type: "sensor", id: s.id }); } }, "");
    const tag = new CSS2DObject(tagEl);
    const [tp, tc] = s.tag || [[0, 0.06, 0], [0.5, 1.1]];
    tag.position.set(...tp); if (tag.center) tag.center.set(...tc); g.add(tag);
    mount.g.add(g);
    sensors.set(s.id, { def: s, g, mat, tagEl, tag });
  }
  // dimension lines (assembled view only)
  const dimGroup = new T.Group(), dimLabels = []; scene.add(dimGroup);
  const dimMat = new T.LineBasicMaterial({ color: C.dim, transparent: true, opacity: 0.8 });
  for (const d of model.dims || []) {
    const a = new T.Vector3(...d.a), b = new T.Vector3(...d.b), dir = b.clone().sub(a).normalize();
    const perp = Math.abs(dir.y) > 0.9 ? new T.Vector3(0.06, 0, 0) : new T.Vector3(0, 0.06, 0);
    const pts = [a, b, a.clone().add(perp), a.clone().sub(perp), b.clone().add(perp), b.clone().sub(perp)];
    const geo = new T.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[3], pts[4], pts[5]]);
    dimGroup.add(new T.LineSegments(geo, dimMat));
    const lab = new CSS2DObject(h("span", { class: "cad-dim" }, d.text)); lab.position.copy(a.clone().add(b).multiplyScalar(0.5)); dimGroup.add(lab); dimLabels.push(lab);
  }
  // part tags (failing part + spec labels)
  const partTags = new Map();
  const partTag = (id, cls, text) => {
    let t = partTags.get(id);
    if (!t) {
      const rec = parts.get(id); if (!rec) return null;
      const el = h("button", { class: "cad-tag", type: "button", onclick: (e) => { e.stopPropagation(); hooks.onPick({ type: "part", id }); } });
      const o = new CSS2DObject(el); o.position.set(...(model.tagAt?.[id] || [0.2, -0.06, 0])); if (o.center) o.center.set(-0.04, 0);
      rec.g.add(o); t = { el, o }; partTags.set(id, t);
    }
    t.el.className = `cad-tag ${cls}`; t.el.textContent = text; t.o.visible = true;
    return t;
  };
  // leak marker: a pulsing translucent bubble at the coupling
  let leak = null;
  if (model.leak && parts.get(model.leak)) {
    const mat = new T.MeshBasicMaterial({ color: C.watch, transparent: true, opacity: 0.35, depthWrite: false });
    leak = new T.Mesh(new T.SphereGeometry(0.11, 20, 14), mat); leak.visible = false; leak.position.set(0.03, -0.02, 0.06);
    parts.get(model.leak).g.add(leak);
  }

  // ---------------------------------------------------------------- state + interaction
  const S = { explode: 0, explodeTo: 0, cut: false, wire: false, labels: true, fade: true, sel: { type: "machine" }, hl: new Set(), hlSensor: null, fail: new Map(), sensorFault: new Set(), primary: null };
  const ray = new T.Raycaster(), ndc = new T.Vector2(), tmp = new T.Vector3();
  function hitAt(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hits = ray.intersectObjects(pickables, false);
    let ghost = null;
    for (const hit of hits) {
      const p = hit.object.userData.pick;
      if (p.type === "part") {
        const rec = parts.get(p.id);
        if (S.cut && rec.plane && rec.plane.distanceToPoint(hit.point) < 0) continue;
        if (rec.def.ghost) { ghost = ghost || p; continue; }
        if (S.fade && S.hl.size && !S.hl.has(p.id) && S.sel.type !== "machine") { ghost = ghost || p; continue; }
      }
      return p;
    }
    return ghost;
  }
  let down = null;
  const el = renderer.domElement;
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
  const onUp = (e) => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 7) hooks.onPick(hitAt(e) || { type: "machine" }); down = null; };
  let hoverPending = false, lastMove = null;
  const tip = h("div", { class: "cad-tip", hidden: true }); stage.append(tip);
  const onMove = (e) => {
    if (e.pointerType === "touch") return;
    lastMove = e; if (hoverPending) return; hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false; if (!lastMove || disposed) return;
      const p = hitAt(lastMove); el.style.cursor = p ? "pointer" : "grab";
      if (!p) { tip.hidden = true; return; }
      tip.textContent = p.type === "sensor" ? sensors.get(p.id).def.name : parts.get(p.id).def.name;
      const r = stage.getBoundingClientRect();
      tip.style.left = `${lastMove.clientX - r.left + 14}px`; tip.style.top = `${lastMove.clientY - r.top + 12}px`; tip.hidden = false;
    });
  };
  const onLeave = () => { tip.hidden = true; };
  el.addEventListener("pointerdown", onDown); el.addEventListener("pointerup", onUp); el.addEventListener("pointermove", onMove); el.addEventListener("pointerleave", onLeave);

  function applyLook() {
    const focus = S.fade && S.sel.type !== "machine";
    for (const [id, rec] of parts) {
      const on = S.hl.has(id);
      for (const m of rec.mats) {
        const o = m.userData.base * (focus && !on ? (rec.def.ghost ? 0.4 : 0.14) : 1);
        m.opacity = o; m.depthWrite = o >= 0.99; m.wireframe = S.wire && m.userData.kind !== "glass";
        if (m.userData.kind !== "screen") { m.emissive.copy(on ? C.sel : new T.Color(0)); m.emissiveIntensity = on ? 0.3 : 1; }
        const planes = S.cut && rec.plane ? [rec.plane] : null;
        if ((m.clippingPlanes?.length || 0) !== (planes?.length || 0)) { m.clippingPlanes = planes; m.needsUpdate = true; }
      }
      rec.edgeMat.opacity = (rec.def.ghost ? 0.35 : 0.5) * (focus && !on ? 0.25 : 1);
      rec.edgeMat.color.copy(on ? C.sel : C.edge);
      const planes = S.cut && rec.plane ? [rec.plane] : null;
      if ((rec.edgeMat.clippingPlanes?.length || 0) !== (planes?.length || 0)) { rec.edgeMat.clippingPlanes = planes; rec.edgeMat.needsUpdate = true; }
    }
    for (const [id, s] of sensors) {
      const on = S.hlSensor === id, faded = focus && !on && !S.hl.has(s.def.mount);
      s.mat.opacity = faded ? 0.35 : 1;
      const col = S.sensorFault.has(s.def.key) ? C.watch : C.sensor;
      s.mat.color.copy(col); s.mat.emissive.copy(on ? C.sel : col); s.mat.emissiveIntensity = on ? 0.9 : 0.45;
      s.g.scale.setScalar(on ? 1.5 : 1);
      s.tagEl.classList.toggle("on", on); s.tagEl.classList.toggle("fault", S.sensorFault.has(s.def.key));
    }
  }
  function boxOf(sel) {
    const box = new T.Box3();
    if (sel.type === "sensor") { const s = sensors.get(sel.id); s.g.getWorldPosition(tmp); return box.setFromCenterAndSize(tmp.clone(), new T.Vector3(0.7, 0.7, 0.7)); }
    const ids = sel.type === "part" ? [sel.id] : sel.type === "assembly" ? model.parts.filter((p) => p.asm === sel.id).map((p) => p.id) : model.parts.filter((p) => !p.ghost).map((p) => p.id);
    // measure where the parts will be once the explode animation settles, not where they are mid-flight
    const keep = [...parts.values()].map((rec) => rec.g.position.clone());
    for (const rec of parts.values()) rec.g.position.copy(rec.g.userData.base).addScaledVector(rec.g.userData.ex, S.explodeTo);
    root.updateMatrixWorld(true);
    for (const id of ids) box.expandByObject(parts.get(id).g);
    [...parts.values()].forEach((rec, i) => rec.g.position.copy(keep[i]));
    root.updateMatrixWorld(true);
    const size = box.getSize(new T.Vector3());
    if (size.length() < 0.5) box.expandByScalar(0.25);
    return box;
  }
  let tween = null;
  function frame(sel, ms = 650, dirOverride = null) {
    const box = boxOf(sel), c = box.getCenter(new T.Vector3()), rad = Math.max(box.getSize(new T.Vector3()).length() / 2, 0.3);
    const dir = dirOverride || cam.position.clone().sub(controls.target).normalize();
    const dist = rad / Math.sin(T.MathUtils.degToRad(persp.fov / 2)) * (sel.type === "machine" ? 1.05 : 1.25);
    tween = { t0: performance.now(), ms, fT: controls.target.clone(), tT: c, fP: cam.position.clone(), tP: c.clone().add(dir.multiplyScalar(dist)),
      fZ: cam.zoom, tZ: cam.isOrthographicCamera ? orthoHalf / (rad * 1.2) : 1 };
  }
  function setOrthoFrustum() {
    const a = W() / H();
    Object.assign(ortho, { left: -orthoHalf * a, right: orthoHalf * a, top: orthoHalf, bottom: -orthoHalf }); ortho.updateProjectionMatrix();
  }
  function setOrtho(on) {
    const next = on ? ortho : persp; if (next === cam) return;
    const dist = cam.position.distanceTo(controls.target);
    if (on) { orthoHalf = dist * Math.tan(T.MathUtils.degToRad(persp.fov / 2)) / (cam.zoom || 1); ortho.zoom = 1; setOrthoFrustum(); }
    else { const d = orthoHalf / ortho.zoom / Math.tan(T.MathUtils.degToRad(persp.fov / 2)); persp.position.copy(controls.target).add(cam.position.clone().sub(controls.target).normalize().multiplyScalar(d)); }
    if (on) ortho.position.copy(cam.position);
    next.quaternion.copy(cam.quaternion); cam = next; controls.object = cam; tween = null; controls.update();
  }

  // axes gizmo (SVG), updated every frame from the camera orientation
  const NS = "http://www.w3.org/2000/svg";
  const giz = document.createElementNS(NS, "svg"); giz.setAttribute("viewBox", "-44 -44 88 88"); giz.setAttribute("class", "cad-gizmo"); giz.setAttribute("aria-hidden", "true");
  const AX = [["X", new T.Vector3(1, 0, 0), "gx"], ["Y", new T.Vector3(0, 1, 0), "gy"], ["Z", new T.Vector3(0, 0, 1), "gz"]].map(([n, v, cls]) => {
    const g = document.createElementNS(NS, "g"); g.setAttribute("class", cls);
    const ln = document.createElementNS(NS, "line"); ln.setAttribute("x1", "0"); ln.setAttribute("y1", "0");
    const tx = document.createElementNS(NS, "text"); tx.textContent = n; tx.setAttribute("text-anchor", "middle"); tx.setAttribute("dominant-baseline", "central");
    g.append(ln, tx); giz.append(g); return { v, g, ln, tx };
  });
  stage.append(giz);
  const qInv = new T.Quaternion();
  function drawGizmo() {
    qInv.copy(cam.quaternion).invert();
    for (const a of AX) {
      const v = a.v.clone().applyQuaternion(qInv);
      a.ln.setAttribute("x2", (v.x * 26).toFixed(1)); a.ln.setAttribute("y2", (-v.y * 26).toFixed(1));
      a.tx.setAttribute("x", (v.x * 35).toFixed(1)); a.tx.setAttribute("y", (-v.y * 35).toFixed(1));
      a.g.style.opacity = (0.55 + 0.45 * Math.max(v.z, 0)).toFixed(2);
    }
  }

  // ---------------------------------------------------------------- loop
  const clock = new T.Clock();
  let raf = 0, disposed = false, onScreen = true;
  function tick() {
    raf = 0; if (disposed) return;
    const t = clock.getElapsedTime();
    S.explode += (S.explodeTo - S.explode) * 0.14;
    if (Math.abs(S.explodeTo - S.explode) < 0.001) S.explode = S.explodeTo;
    for (const rec of parts.values()) {
      rec.g.position.copy(rec.g.userData.base).addScaledVector(rec.g.userData.ex, S.explode);
      if (rec.plane) { rec.g.getWorldPosition(tmp); rec.plane.constant = tmp.z + 0.001; }
    }
    const showDims = S.labels && S.explode < 0.06;   // CSS2D labels ignore a hidden parent, so hide each one too
    if (dimGroup.visible !== showDims) { dimGroup.visible = showDims; dimLabels.forEach((l) => { l.visible = showDims; }); }
    for (const [id, lvl] of S.fail) {
      const rec = parts.get(id); if (!rec) continue;
      const k = 0.5 + 0.5 * Math.sin(t * (lvl === "alarm" ? 5 : 3));
      const col = lvl === "alarm" ? C.alarm : C.watch;
      for (const m of rec.mats) { if (m.userData.kind === "screen") continue; m.emissive.copy(col); m.emissiveIntensity = 0.15 + 0.75 * k; }
      rec.edgeMat.color.copy(col);
    }
    if (leak) { leak.visible = S.fail.has(model.leak); if (leak.visible) { const k = (t * 0.9) % 1; leak.scale.setScalar(0.5 + k * 1.6); leak.material.opacity = 0.45 * (1 - k); } }
    for (const [id, s] of sensors) if (S.sensorFault.has(s.def.key)) s.mat.emissiveIntensity = 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(t * 4));
    if (tween) {
      const k = Math.min((performance.now() - tween.t0) / tween.ms, 1), e = 1 - Math.pow(1 - k, 3);
      controls.target.lerpVectors(tween.fT, tween.tT, e); cam.position.lerpVectors(tween.fP, tween.tP, e);
      if (cam.isOrthographicCamera) { cam.zoom = tween.fZ + (tween.tZ - tween.fZ) * e; cam.updateProjectionMatrix(); }
      if (k >= 1) tween = null;
    }
    controls.update();
    renderer.render(scene, cam);
    labels.render(scene, cam);
    drawGizmo();
    schedule();
  }
  const schedule = () => { if (!raf && !disposed && onScreen && !document.hidden) raf = requestAnimationFrame(tick); };
  const onVis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else schedule(); };
  document.addEventListener("visibilitychange", onVis);
  const io = new IntersectionObserver(([en]) => { onScreen = en.isIntersecting; if (onScreen) schedule(); else { cancelAnimationFrame(raf); raf = 0; } });
  io.observe(stage);
  const ro = new ResizeObserver(() => {
    renderer.setSize(W(), H()); labels.setSize(W(), H());
    persp.aspect = W() / H(); persp.updateProjectionMatrix(); setOrthoFrustum();
  });
  ro.observe(stage);
  frame({ type: "machine" }, 1);
  schedule();

  return {
    select(sel) {
      S.sel = sel; S.hl = new Set(); S.hlSensor = null;
      if (sel.type === "part") S.hl.add(sel.id);
      if (sel.type === "assembly") model.parts.filter((p) => p.asm === sel.id).forEach((p) => S.hl.add(p.id));
      if (sel.type === "sensor") { S.hlSensor = sel.id; const s = sensors.get(sel.id); if (s) S.hl.add(s.def.mount); }
      applyLook(); frame(sel);
    },
    setExplode(v, animate = true) {
      S.explodeTo = v; if (!animate) S.explode = v;
      clearTimeout(S.reframe); S.reframe = setTimeout(() => { if (!disposed) frame(S.sel, 500); }, 260);
    },
    get explode() { return S.explodeTo; },
    setCut(on) { S.cut = on; applyLook(); },
    setWire(on) { S.wire = on; applyLook(); },
    setFade(on) { S.fade = on; applyLook(); },
    setLabels(on) { S.labels = on; labels.domElement.hidden = !on; },
    setOrtho(on) { setOrtho(on); frame(S.sel, 300); },
    reset() { frame({ type: "machine" }, 650, home().sub(target0).normalize()); },
    live(st, diag, tagText) {
      S.fail = diag.fail; S.sensorFault = diag.sensorFault; S.primary = diag.primary;
      for (const s of sensors.values()) {
        const r = readingOf(st, s.def.key);
        s.tagEl.textContent = `${S.sensorFault.has(s.def.key) ? "⚠ frozen · " : ""}${r ? `${fmt(r.value)} ${r.unit}` : s.def.name}`;
        s.tagEl.title = s.def.name;
      }
      for (const t of partTags.values()) t.o.visible = false;
      for (const [id, text] of Object.entries(tagText)) partTag(id, text.cls, text.text);
      applyLook();
    },
    theme() { colors(); makeGrid(); dimMat.color.copy(C.dim); if (leak) leak.material.color.copy(C.watch); applyLook(); },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); clearTimeout(S.reframe);
      document.removeEventListener("visibilitychange", onVis); io.disconnect(); ro.disconnect(); controls.dispose();
      el.removeEventListener("pointerdown", onDown); el.removeEventListener("pointerup", onUp); el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerleave", onLeave);
      scene.traverse((o) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => x.dispose()); });
      hitMat.dispose(); renderer.dispose(); renderer.forceContextLoss?.();
      renderer.domElement.remove(); labels.domElement.remove(); giz.remove(); tip.remove();
    },
  };
}

// ------------------------------------------------------------------ the page
export async function render(main, params) {
  const id = params?.[0] || "VMC-204";
  const page = h("div", { class: "page cad-page" }, h("div", { class: "skeleton", style: "height:420px" }));
  main.append(page);
  const cat = store.machine(id);
  let d;
  try { if (!cat) throw new Error(`There is no machine called ${id}.`); d = await api.get(`/api/machines/${encodeURIComponent(id)}`); }
  catch (e) {
    page.innerHTML = "";
    page.append(h("div", { class: "panel pad" }, h("h2", {}, "Machine not found"), h("p", { class: "dim" }, e.message), h("a", { class: "btn", href: "#/" }, "Back to the floor")));
    return;
  }
  if (!page.isConnected) return;
  let st = d.state;
  const model = cat.kind === "VMC" ? vmcModel(cat) : cat.kind === "COMPRESSOR" ? compressorModel(cat) : genericModel(cat);
  const partDef = (pid) => model.parts.find((p) => p.id === pid);
  const sensorDef = (sid) => model.sensors.find((s) => s.id === sid);
  const asmDef = (aid) => model.asm.find((a) => a.id === aid);
  const plant = store.plantInfo(cat.plant), line = store.catalog.lines.find((l) => l.id === cat.line);
  let diag = diagnose(model, st);
  let sel = { type: "machine" };
  let viewer = null;

  // ---- layout
  page.innerHTML = "";
  const crumbs = h("ol", { class: "cad-crumbs" });
  const head = h("div", { class: "page-head cad-head" },
    h("div", { class: "grow" },
      h("nav", { "aria-label": "Drill-down path" }, crumbs),
      h("div", { class: "row gap wrap", style: "margin-top:6px" }, h("h1", {}, `${cat.id} in 3D`), h("span", { class: "dim" }, cat.name), statusChip(st.status)),
      h("p", { class: "cad-lede" }, "A ", t_("cad", "CAD"), "-style model built from the machine's parts list. Pull it apart, cut it open and tap any part: Gemba knows what it does, how it is doing right now, which sensor watches it and what happens to the customer order if it fails.")),
    h("a", { class: "btn", href: `#/machine/${encodeURIComponent(cat.id)}` }, "Machine charts and history"));
  const stage = h("div", { class: "cad-stage" });
  const hint = h("div", { class: "cad-hint tiny" }, "Drag to turn · pinch or scroll to zoom · tap a part");
  stage.append(hint);
  const slider = h("input", { type: "range", min: "0", max: "100", value: "0", id: "cad-explode", "aria-label": "Assembled to exploded", class: "cad-slider" });
  const tgl = (label, title, fn, on = false) => {
    const b = h("button", { class: "btn small cad-toggle", type: "button", "aria-pressed": String(on), title }, label);
    b.onclick = () => { const v = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(v)); fn(v); };
    return b;
  };
  const cutBtn = tgl("Cut away", "Slice the housings open with a section plane to see inside", (v) => viewer?.setCut(v));
  const projBtn = tgl("Orthographic", "Engineering drawing view: no perspective, parallel lines stay parallel", (v) => viewer?.setOrtho(v));
  const tools = h("div", { class: "cad-tools" },
    h("label", { class: "cad-explode", for: "cad-explode" }, h("span", { class: "small" }, "Assembled"), slider, h("span", { class: "small" }, "Exploded")),
    h("div", { class: "row wrap gap cad-toggles" },
      cutBtn,
      tgl("Wireframe", "Show the model as lines only", (v) => viewer?.setWire(v)),
      projBtn,
      tgl("Labels", "Show sensor values and dimensions", (v) => viewer?.setLabels(v), true),
      tgl("Fade the rest", "When you pick a part, make everything else see-through", (v) => viewer?.setFade(v), true),
      h("button", { class: "btn small ghost", type: "button", onclick: () => { select({ type: "machine" }); viewer?.reset(); } }, "Reset view")));
  slider.addEventListener("input", () => viewer?.setExplode(slider.value / 100, true));
  const side = h("aside", { class: "cad-side panel", "aria-live": "polite" });
  const tree = h("section", { class: "cad-tree panel" });
  page.append(head, h("div", { class: "cad-layout" }, h("div", { class: "cad-main" }, h("div", { class: "panel cad-viewport" }, stage, tools), tree), side));

  // ---- breadcrumbs: Company > Plant > Line > Machine > Assembly > Component > Sensor
  function renderCrumbs() {
    crumbs.innerHTML = "";
    const goPlant = () => { document.querySelector(`.plants button[data-plant="${cat.plant}"]`)?.click(); location.hash = "#/"; };
    const items = [
      { label: COMPANY, level: "Company", href: "#/" }, { label: plant?.name || cat.plant, level: "Plant", onclick: goPlant },
      { label: line?.name || cat.line, level: "Line", onclick: goPlant }, { label: cat.id, level: "Machine", onclick: () => select({ type: "machine" }) },
    ];
    const partId = sel.type === "part" ? sel.id : sel.type === "sensor" ? sensorDef(sel.id)?.mount : null;
    const asmId = sel.type === "assembly" ? sel.id : partId ? partDef(partId)?.asm : null;
    if (asmId) items.push({ label: asmDef(asmId)?.name, level: "Assembly", onclick: () => select({ type: "assembly", id: asmId }) });
    if (partId) items.push({ label: partDef(partId)?.name, level: "Component", onclick: () => select({ type: "part", id: partId }) });
    if (sel.type === "sensor") items.push({ label: sensorDef(sel.id)?.name, level: "Sensor" });
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      const inner = [h("span", { class: "lvl" }, it.level), h("span", { class: "nm" }, it.label)];
      crumbs.append(h("li", {}, last ? h("span", { class: "crumb cur", "aria-current": "location" }, ...inner)
        : it.href ? h("a", { class: "crumb", href: it.href }, ...inner) : h("button", { class: "crumb", type: "button", onclick: it.onclick }, ...inner)));
    });
  }

  // ---- part list (the same drill-down without the 3D view; also the keyboard path)
  const dots = new Map();
  function statusOfPart(p) {
    if (diag.fail.has(p.id)) return diag.fail.get(p.id);
    if (!st.running && st.status === "idle") return "idle";
    let worst = "ok";
    for (const k of p.watch) { if (diag.sensorFault.has(k)) continue; const r = readingOf(st, k); if (!r || (MOVING.has(k) && !st.running)) continue; const b = BAND_STATUS[band(r)]; if (b === "alarm" || (b === "watch" && worst === "ok")) worst = b; }
    return worst;
  }
  const statusOfSensor = (s) => diag.sensorFault.has(s.key) ? "sensor" : (() => { const r = readingOf(st, s.key); return r && !(MOVING.has(s.key) && !st.running) ? BAND_STATUS[band(r)] : st.running ? "ok" : "idle"; })();
  function renderTree() {
    tree.innerHTML = ""; dots.clear();
    const btn = (kind, pid, label, stt, sub) => {
      const dot = h("i", { class: `cad-dot st-${stt}`, "aria-hidden": "true" });
      dots.set(`${kind}:${pid}`, dot);
      return h("button", { type: "button", class: "cad-item", "data-k": `${kind}:${pid}`, onclick: () => select({ type: kind, id: pid }) }, dot, h("span", { class: "grow" }, label), sub ? h("span", { class: "tiny dim" }, sub) : null);
    };
    tree.append(h("div", { class: "panel-head" }, h("h3", {}, "Parts list"), h("span", { class: "right tiny dim" }, `${model.asm.length} assemblies · ${model.parts.length} parts · ${model.sensors.length} sensors`)));
    const body = h("div", { class: "cad-tree-body" });
    for (const a of model.asm) {
      const kids = model.parts.filter((p) => p.asm === a.id);
      body.append(h("div", { class: "cad-asm" }, btn("assembly", a.id, a.name, kids.some((p) => diag.fail.get(p.id) === "alarm") ? "alarm" : kids.some((p) => diag.fail.has(p.id)) ? "watch" : "ok"),
        h("div", { class: "cad-asm-kids" }, ...kids.map((p) => btn("part", p.id, p.name, statusOfPart(p), p.partNo)))));
    }
    body.append(h("div", { class: "cad-asm" }, h("div", { class: "cad-asm-title small dim" }, "Sensors"), h("div", { class: "cad-asm-kids" },
      ...model.sensors.map((s) => { const r = readingOf(st, s.key); return btn("sensor", s.id, s.name, statusOfSensor(s), r ? `${fmt(r.value)} ${r.unit}` : ""); }))));
    tree.append(body);
    markTree();
  }
  function markTree() {
    tree.querySelectorAll(".cad-item").forEach((b) => b.setAttribute("aria-current", String(b.dataset.k === `${sel.type}:${sel.id}`)));
  }

  // ---- side panel
  const sec = (title, ...kids) => h("section", { class: "cad-sec" }, h("h3", {}, title), ...kids);
  function liveBlock(keys) {
    const box = h("div", { class: "cad-live" });
    const shown = keys.filter((k) => k === "scrap" ? st.scrap_24h_pct != null : readingOf(st, k));
    if (!shown.length) { box.append(h("p", { class: "small dim" }, "No sensor looks at this part directly. Trouble here shows up first as vibration or bad parts further down the chain.")); return box; }
    for (const k of shown) {
      if (k === "scrap") { box.append(h("div", { class: "cad-read" }, h("div", { class: "row gap" }, h("b", {}, "Scrap, last 24 h"), h("span", { class: "right num" }, `${num(st.scrap_24h_pct, 2)} %`)),
        h("p", { class: "small dim" }, `${num(st.good_24h)} good parts in 24 h. A healthy line scraps under 1 %; every scrapped head is metal, machine time and energy lost.`))); continue; }
      const r = readingOf(st, k), frozen = diag.sensorFault.has(k);
      const f = frozen ? st.faults.find((x) => x.key === k) : null;
      box.append(h("div", { class: "cad-read" },
        h("div", { class: "row gap" }, h("b", {}, r.label), h("span", { class: "right num" }, `${fmt(r.value)} ${r.unit}`)),
        frozen ? h("p", { class: "small cad-warn" }, `This sensor has been frozen at ${f.value} for ${f.hours} h. Real signals always wiggle a little, so this is the sensor, not the machine. Send an instrument technician, not a repair crew.`)
          : h("p", { class: "small dim" }, readingSentence(r, k, st)),
        frozen ? null : gauge(r)));
    }
    return box;
  }
  function machineFacts() {
    const facts = h("div", { class: "cad-facts" });
    facts.append(h("div", { class: "kpi" }, h("div", { class: "label" }, t_("health_index", "Health score")), h("div", { class: "value num" }, `${st.health}/100`),
      h("div", { class: "sub" }, st.health >= 80 ? "Like new. 100 means no warning signs." : st.health >= 50 ? "Some warning signs: keep an eye on it." : "Many warning signs: plan a repair.")));
    if (st.zone) facts.append(h("div", { class: "kpi" }, h("div", { class: "label" }, t_("iso_zones", "Vibration zone")), h("div", { class: "value" }, st.zone.zone), h("div", { class: "sub" }, `${st.zone.meaning}. Zones run A (new) to D (damage likely).`)));
    if (st.ttf) facts.append(h("div", { class: "kpi" }, h("div", { class: "label" }, t_("time_to_trip", "Time to trip")), h("div", { class: "value num" }, `${hours(st.ttf.to_trip_h.p10)}–${hours(st.ttf.to_trip_h.p90)}`),
      h("div", { class: "sub" }, `At today's rate (+${st.ttf.rise_mm_s_per_day} mm/s a day) the machine reaches its trip limit and stops itself in this window.`)));
    return facts;
  }
  function sentence() {
    if (st.status === "sensor" && st.faults[0]) return `${st.faults[0].label} has been frozen for ${st.faults[0].hours} h. The machine is probably fine; the sensor is not.`;
    if (diag.primary) { const p = partDef(diag.primary); return `The ${p.name.toLowerCase()} is the likely problem. It is pulsing ${diag.fail.get(diag.primary) === "alarm" ? "red" : "amber"} in the model.`; }
    return st.status === "idle" ? "Not scheduled to run right now." : "Running normally. Every part reads inside its normal range.";
  }
  let liveHost = null, liveFn = null;
  function renderSide() {
    side.innerHTML = ""; liveHost = null; liveFn = null;
    const top = (kind, name, ...extra) => h("div", { class: "cad-side-head" }, h("div", { class: "row gap wrap" }, h("span", { class: "chip" }, kind), ...extra), h("h2", {}, name));
    const back = h("div", { class: "cad-side-foot row wrap gap" },
      sel.type !== "machine" ? h("button", { class: "btn small", type: "button", onclick: () => select({ type: "machine" }) }, "← Whole machine") : null,
      h("a", { class: "btn small ghost", href: `#/machine/${encodeURIComponent(cat.id)}` }, `${cat.id} charts and history`));
    if (sel.type === "machine") {
      side.append(top("Machine", `${cat.id} · ${cat.name}`, statusChip(st.status)), h("p", { class: "cad-say" }, sentence()));
      liveHost = h("div"); liveFn = () => machineFacts(); side.append(liveHost);
      if (diag.primary) side.append(h("button", { class: "btn primary cad-cta", type: "button", onclick: showProblem }, "Show me the problem"));
      side.append(sec("How to explore", h("ol", { class: "cad-steps small" },
        h("li", {}, "Tap the part that is pulsing. Red means act now, amber means watch."),
        h("li", {}, "Slide to Exploded to pull the machine apart like an assembly drawing."),
        h("li", {}, model.cutHint || "Turn on Cut away to slice the housings open and see what is inside."),
        h("li", {}, "Tap a blue sensor dot to see what it measures and what the number means."))));
      side.append(sec("What to talk about", h("p", { class: "small" }, `Most dashboards stop at "${cat.id} is red". Gemba goes down seven levels, from the company to one ${model.primaryKey === "bearingF" ? "bearing" : "part"} and the sensor that saw it, and then back up to the money: the spare part number, where one is in stock and which customer order is at risk.`)));
    } else if (sel.type === "assembly") {
      const a = asmDef(sel.id), kids = model.parts.filter((p) => p.asm === a.id);
      side.append(top("Assembly", a.name), h("p", { class: "cad-say" }, ...[].concat(txt(a.does))),
        sec("Parts in it", h("div", { class: "cad-list" }, ...kids.map((p) => h("button", { type: "button", class: "cad-item", onclick: () => select({ type: "part", id: p.id }) },
          h("i", { class: `cad-dot st-${statusOfPart(p)}`, "aria-hidden": "true" }), h("span", { class: "grow" }, p.name), p.partNo ? h("span", { class: "tiny dim" }, p.partNo) : null)))));
    } else if (sel.type === "part") {
      const p = partDef(sel.id); const s0 = statusOfPart(p);
      side.append(top("Component", p.name, h("span", { class: "tiny dim" }, asmDef(p.asm)?.name), p.partNo ? h("span", { class: "chip mono" }, p.partNo) : null));
      side.append(sec("What it does", h("p", {}, ...[].concat(txt(p.does)))));
      if (p.inside) side.append(sec("Inside it", h("p", { class: "small" }, p.inside)));
      liveHost = h("div"); liveFn = () => h("div", {}, h("div", { class: "row gap" }, statusChip(statusOfPart(p)), diag.fail.has(p.id) ? h("span", { class: "small" }, "Gemba thinks this is where the trouble is.") : null), liveBlock(p.watch));
      side.append(sec("Right now", liveHost));
      const watchers = model.sensors.filter((s) => s.mount === p.id || p.watch.includes(s.key));
      side.append(sec("Watched by", watchers.length ? h("div", { class: "cad-list" }, ...watchers.map((s) => h("button", { type: "button", class: "cad-item", onclick: () => select({ type: "sensor", id: s.id }) },
        h("i", { class: `cad-dot st-${statusOfSensor(s)}`, "aria-hidden": "true" }), h("span", { class: "grow" }, s.name)))) : h("p", { class: "small dim" }, "No sensor on this part. People check it on the routine inspection.")));
      side.append(sec("How it usually fails", h("ul", { class: "cad-ul small" }, ...p.failures.map((f) => h("li", {}, f)))));
      side.append(sec("Why it matters", h("ol", { class: "cad-chain" }, ...p.why.map((w) => h("li", {}, w)))));
      if (p.partNo && d.spares) side.append(sec(`Spare part ${d.spares.part_no}`, h("p", { class: "small" }, `${d.spares.name}. `,
        d.spares.stock.map((r) => `${store.plantInfo(r.plant)?.name.replace(" Plant", "") || r.plant}: ${r.on_hand} on hand${r.transfer_h_to_pune ? ` (${r.transfer_h_to_pune} h away)` : ""}`).join(" · "), ".")));
      void s0;
      side.append(h("div", { class: "cad-explain" }, explain(`${p.name} on a ${cat.name.toLowerCase()}`, `${cat.id}: ${p.watch.map((k) => { const r = readingOf(st, k); return r ? `${r.label} ${fmt(r.value)} ${r.unit}` : ""; }).filter(Boolean).join(", ")}. Machine status ${st.status}, health ${st.health}/100.`,
        { key: p.id.startsWith("bearing") ? "bearing" : p.asm === "spindle" ? "spindle" : p.id === "coupling" ? "air_leak" : p.id === "workpiece" ? "scrap" : "" })));
    } else if (sel.type === "sensor") {
      const s = sensorDef(sel.id), mount = partDef(s.mount);
      side.append(top("Sensor", s.name, statusChip(statusOfSensor(s))));
      side.append(sec("What it measures", h("p", {}, ...[].concat(txt(s.does)))));
      liveHost = h("div"); liveFn = () => liveBlock([s.key]); side.append(sec("Reading now", liveHost));
      side.append(sec("What a change means", h("p", { class: "small" }, s.means)));
      side.append(sec("Mounted on", h("button", { type: "button", class: "cad-item", onclick: () => select({ type: "part", id: mount.id }) },
        h("i", { class: `cad-dot st-${statusOfPart(mount)}`, "aria-hidden": "true" }), h("span", { class: "grow" }, mount.name))));
      side.append(h("div", { class: "cad-explain" }, explain(`what a ${s.name.toLowerCase()} tells you`, `${cat.id} ${cat.name}`, { key: s.key === "vib" ? "vibration" : s.key === "press" || s.key === "kw" ? "air_leak" : "" })));
    }
    side.append(back);
    refreshLive();
  }
  function refreshLive() { if (liveHost && liveFn) { liveHost.innerHTML = ""; liveHost.append(liveFn()); } }

  function tagTexts() {
    const out = {};
    if (diag.primary) {
      const p = partDef(diag.primary), lvl = diag.fail.get(diag.primary), r = readingOf(st, p.watch[0]);
      out[diag.primary] = { cls: lvl, text: `${lvl === "alarm" ? "⚠" : "!"} ${p.short || p.name.replace(/ \(.*\)/, "")}${r ? ` · ${fmt(r.value)} ${r.unit}` : ""}` };
    }
    if (model.tags && (sel.type === "part" && model.tags[sel.id])) out[sel.id] = { cls: "spec", text: model.tags[sel.id] };
    return out;
  }
  function select(next, fromCanvas = false) {
    sel = next.type === "machine" ? { type: "machine" } : next;
    if (!fromCanvas && viewer) {   // picked from the list or the panel: bring the model back into sight
      const r = stage.getBoundingClientRect(), mid = (r.top + r.bottom) / 2;
      if (mid < 60 || mid > innerHeight - 60) stage.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    viewer?.select(sel);
    viewer?.live(st, diag, tagTexts());
    renderCrumbs(); renderSide(); markTree();
  }
  function showProblem() {
    if (!diag.primary) return;
    if (model.parts.find((p) => p.id === diag.primary)?.asm === "spindle" || model.leak) {
      cutBtn.setAttribute("aria-pressed", "true"); viewer?.setCut(true);
    }
    slider.value = "35"; viewer?.setExplode(0.35);
    select({ type: "part", id: diag.primary });
  }

  renderCrumbs(); renderTree(); renderSide();

  // ---- 3D
  try {
    viewer = await createViewer(stage, model, { onPick: (p) => select(p, true) });
    if (!page.isConnected) { viewer.dispose(); return; }
    viewer.live(st, diag, tagTexts());
    stage.classList.add("ready");
  } catch (e) {
    console.warn("CAD view unavailable", e);
    stage.classList.add("no3d");
    stage.append(h("div", { class: "cad-fallback" }, h("b", {}, "The 3D model could not start in this browser."), h("p", { class: "small dim" }, "Use the parts list below: it drills down the same way.")));
    tools.hidden = true;
  }

  // ---- live updates
  let busy = false;
  async function refresh() {
    if (busy || document.hidden) return; busy = true;
    try {
      const nd = await api.get(`/api/machines/${encodeURIComponent(id)}`);
      if (!page.isConnected) return;
      d = nd; st = nd.state; diag = diagnose(model, st);
      viewer?.live(st, diag, tagTexts());
      head.querySelector(".status")?.replaceWith(statusChip(st.status));
      renderTree();
      if (sel.type === "machine") renderSide(); else refreshLive();
    } catch (e) { /* keep the last good reading */ } finally { busy = false; }
  }
  let tickN = 0;
  const offStore = store.on((kind) => {
    if (kind === "tick" && ++tickN % 4 === 0) refresh();
    if (kind === "changed") refresh();
    if (kind === "theme") viewer?.theme();
  });
  return () => { offStore(); viewer?.dispose(); viewer = null; };
}
