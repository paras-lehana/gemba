// Learn: "Manufacturing in 5 minutes" for people who have never worked in a factory. Six short sections, each with a
// tiny thing to try, then three drills that run on the live simulated plant with a self-check quiz, then how Gemba
// compares with the tool types plants already use. Every dotted word opens a plain-language meaning.
import { api, h, store, money, num, toast, statusChip, AGENTS } from "../core.js";
import { term, explain, askTutor, answerBox, lookup } from "../learn.js";

// In running prose a term reads in lower case ("the spindle"), unless it is an acronym ("OEE", "CMM").
const T = (key, label) => {
  if (label) return term(key, label);
  const l = lookup(key)?.label || key;
  return term(key, /^[A-Z][a-z]/.test(l) ? l[0].toLowerCase() + l.slice(1) : l);
};
const ZONES = [
  { z: "A", max: 1.4, cls: "ok", title: "Zone A: like new", what: "The machine is as smooth as a new one. Nothing to do.", feel: "Like a new car idling: you barely feel it." },
  { z: "B", max: 2.8, cls: "ok", title: "Zone B: fine for long running", what: "Normal wear. Keep running and keep watching.", feel: "Like a car with 50,000 km: a little hum, all fine." },
  { z: "C", max: 4.5, cls: "watch", title: "Zone C: plan a repair", what: "Something is wearing out. Order the part, pick a good hour and repair before it gets worse.", feel: "Like a new rattle in your car: book the garage this week." },
  { z: "D", max: 99, cls: "alarm", title: "Zone D: damage likely", what: "Past the alarm limit. Repair now; at 7.1 mm/s the machine trips (stops itself).", feel: "Like the steering wheel shaking at speed: pull over soon." },
];
const SCEN = {
  bearing_wear_vmc202: { title: "Bearing failure on VMC-202", where: "Pune · Cylinder Head Line", ag: "reliability" },
  air_leak_chk: { title: "Air leak at Chakan", where: "Chakan · compressor CMP-951", ag: "energy" },
  sensor_stuck_hob301: { title: "Frozen sensor on HOB-301", where: "Pune · Gear Line", ag: "quality" },
};
const DRILL_STATE = { pending: ["watch", "Starting soon"], injected: ["alarm", "Running now"], detected: ["sensor", "Gemba noticed"], planned: ["ok", "Plan ready"] };

export async function render(main, params, query) {
  const page = h("div", { class: "page learn" });
  const cleanups = [];
  const sections = [
    ["plant", "The plant and its machines", plantSection],
    ["wear", "How machines wear out", wearSection],
    ["quality", "How quality is measured", qualitySection],
    ["energy", "Energy and carbon", energySection],
    ["orders", "Orders and supply", ordersSection],
    ["agents", "What Gemba's five agents do", agentsSection],
    ["drills", "Drills: practise on the live plant", null],
    ["compare", "How Gemba compares", null],
  ];
  const go = (id) => page.querySelector(`#learn-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  page.append(
    h("div", { class: "learn-hero" },
      h("p", { class: "learn-kicker" }, "Learn · no factory experience needed"),
      h("h1", {}, "Manufacturing in 5 minutes"),
      h("p", { class: "learn-lede" }, "Gemba watches a pretend company, Meridian Precision Components, that makes car engine and gearbox parts in three plants. ",
        "Read these six short sections, try the little calculators, then run a drill on the live plant and check yourself with a quiz. ",
        "Any word with a dotted line, like ", T("spindle"), " or ", T("oee", "OEE"), ", opens a plain-language meaning. Tap it."),
      h("nav", { class: "learn-toc", "aria-label": "Sections on this page" },
        ...sections.map(([id, title], i) => h("button", { type: "button", onclick: () => go(id) }, h("b", {}, i < 6 ? String(i + 1) : i === 6 ? "▶" : "≈"), title)))));
  for (const [id, title, fn] of sections.slice(0, 6)) {
    const i = sections.findIndex((s) => s[0] === id);
    const sec = h("section", { class: "panel learn-sec", id: `learn-${id}`, "aria-labelledby": `learn-h-${id}` },
      h("div", { class: "learn-sec-head" }, h("span", { class: "learn-num", "aria-hidden": "true" }, String(i + 1)), h("h2", { id: `learn-h-${id}` }, title)));
    const body = h("div", { class: "learn-sec-body" });
    const c = fn(body);
    if (typeof c === "function") cleanups.push(c);
    sec.append(body);
    page.append(sec);
  }
  page.append(drillsSection(cleanups), compareSection(), tutorBox());
  main.append(page);
  const jump = query?.get("s");
  if (jump) setTimeout(() => go(jump), 50);
  return () => cleanups.forEach((f) => { try { f(); } catch (e) {} });
}

// ------------------------------------------------------------------ helpers
function oneLine(text) { return h("p", { class: "learn-one" }, h("span", { class: "learn-one-k" }, "In one line: "), text); }
function para(...kids) { return h("p", { class: "learn-p" }, ...kids); }
function tryIt(title, ...kids) { return h("div", { class: "learn-try" }, h("div", { class: "learn-try-head" }, h("span", { class: "chip" }, "Try it"), h("h3", {}, title)), ...kids); }
function slider({ label, min, max, step, value, unit = "", fmt = (v) => num(v, step < 1 ? 1 : 0) }, on) {
  const out = h("output", { class: "num" }, `${fmt(value)}${unit}`);
  const inp = h("input", { type: "range", min, max, step, value, "aria-label": label });
  inp.addEventListener("input", () => { out.textContent = `${fmt(Number(inp.value))}${unit}`; on(); });
  const el = h("label", { class: "learn-slider" }, h("span", { class: "learn-slider-top" }, h("span", {}, label), out), inp);
  el.value = () => Number(inp.value);
  return el;
}
function stat(label, valueEl, sub) { return h("div", { class: "kpi" }, h("div", { class: "label" }, label), h("div", { class: "value" }, valueEl), sub ? h("div", { class: "sub" }, sub) : null); }

// ------------------------------------------------------------------ 1. plant
function plantSection(body) {
  const live = h("div", { class: "learn-live" }, h("p", { class: "dim small" }, "Waiting for the live plant…"));
  const MACHINES = [
    ["vmc", "VMC", "cuts metal blocks into cylinder heads"], [null, "Lathe", "spins a bar and turns it round, for crankshafts"],
    [null, "Grinder", "polishes surfaces to a mirror finish"], ["hob", "Hobbing machine", "cuts the teeth of gears"],
    [null, "Press", "stamps steel sheet into brackets"], ["die_casting", "Die casting", "pours aluminium into moulds (Rayong)"],
    ["cmm", "CMM", "measures finished parts to check them"], ["air_leak", "Air compressor", "makes the compressed air tools run on"],
  ];
  body.append(
    oneLine("A factory is a chain of machines, each doing one step, fed by material and drained by customer orders."),
    para("Pune makes cylinder heads, crankshafts and gears on three lines; Chakan stamps suspension brackets; Rayong in Thailand casts and machines gear housings. ",
      "A line is a row of machines a part travels through. The slowest machine on a line is its ", T("bottleneck"), "."),
    h("div", { class: "learn-mgrid" }, ...MACHINES.map(([k, name, what]) => h("div", { class: "learn-m" }, h("b", {}, k ? T(k, name) : name), h("span", { class: "dim small" }, what)))),
    tryIt("Right now on the simulated plant", live, h("a", { class: "btn small", href: "#/" }, "See it on the floor →")),
    explain("How a car-parts factory is organised", "Three plants: Pune (cylinder heads, crankshafts, gears), Chakan (stamped brackets), Rayong (cast and machined gear housings). Machines: VMCs, lathes, grinders, hobbing machines, presses, die casting, CMM, compressors."));
  const paint = () => {
    const ms = store.tick?.machines;
    if (!ms?.length) return;
    const by = {};
    for (const m of ms) by[m.status] = (by[m.status] || 0) + 1;
    const order = ["ok", "watch", "alarm", "down", "sensor", "repair", "idle"];
    const MEAN = { ok: "doing their job", watch: "drifting, worth a look", alarm: "need action now", down: "stopped", sensor: "sensor broken, machine fine", repair: "in a planned repair", idle: "not scheduled to run" };
    live.replaceChildren(h("p", { class: "small" }, `${ms.length} machines are streaming live readings every few seconds.`),
      h("ul", { class: "learn-counts" }, ...order.filter((s) => by[s]).map((s) => h("li", {}, statusChip(s), h("span", { class: "num" }, ` ${by[s]} `), h("span", { class: "dim small" }, MEAN[s])))));
  };
  paint();
  return store.on((k) => { if (k === "tick") paint(); });
}

// ------------------------------------------------------------------ 2. wear
function wearSection(body) {
  const gaugeMarker = h("i", { class: "learn-gauge-mark" });
  const gauge = h("div", { class: "learn-gauge", "aria-hidden": "true" },
    h("span", { class: "gz gz-a", style: "flex-basis:17.5%" }, "A"), h("span", { class: "gz gz-b", style: "flex-basis:17.5%" }, "B"),
    h("span", { class: "gz gz-c", style: "flex-basis:21.25%" }, "C"), h("span", { class: "gz gz-d", style: "flex-basis:43.75%" }, "D"),
    h("i", { class: "learn-gauge-line", style: "left:56.25%", title: "alarm 4.5" }), h("i", { class: "learn-gauge-line trip", style: "left:88.75%", title: "trip 7.1" }), gaugeMarker);
  const verdict = h("div", { class: "learn-verdict", "aria-live": "polite" });
  const s = slider({ label: "Vibration on the spindle", min: 0.5, max: 8, step: 0.1, value: 2.1, unit: " mm/s", fmt: (v) => v.toFixed(1) }, () => paint());
  const paint = () => {
    const v = s.value();
    const z = ZONES.find((x) => v <= x.max);
    gaugeMarker.style.left = `${Math.min(100, (v / 8) * 100)}%`;
    const tripped = v >= 7.1;
    verdict.className = `learn-verdict v-${tripped ? "alarm" : z.cls}`;
    verdict.replaceChildren(h("b", {}, tripped ? "Tripped: the machine has stopped itself" : z.title),
      h("p", {}, tripped ? "Above the 7.1 mm/s trip limit the machine stops to protect itself and people. That is an unplanned stop: the line halts at a random hour and repairs cost more." : z.what),
      h("p", { class: "dim small" }, z.feel));
  };
  body.append(
    oneLine("Machines rarely break without warning: they shake and heat up for days first, and that warning is what Gemba listens for."),
    para("Inside every machine tool is a ", T("spindle"), " that spins on ", T("bearing", "bearings"), ". As a bearing wears, the spindle shakes more. Sensors measure that shaking as ",
      T("vibration", "vibration in mm/s"), ". A standard scale, the ", T("iso_zones", "ISO zones A to D"), ", says what each level means."),
    para("Past the ", T("alarm_limit"), " (4.5 mm/s here) people should act; at the ", T("trip_limit"), " (7.1 mm/s) the machine stops itself. Gemba estimates the ",
      T("time_to_trip"), " so a repair can be planned with the right part, people and hour, instead of an emergency. Planned servicing on a calendar is called ",
      T("pm", "preventive maintenance"), "."),
    tryIt("Drag the vibration and see what it means", s, gauge, h("div", { class: "learn-gauge-legend tiny dim" }, h("span", {}, "0"), h("span", {}, "alarm 4.5"), h("span", {}, "trip 7.1")), verdict),
    para(h("span", { class: "dim" }, "Shaking spindles also leave "), T("chatter", "chatter marks"), h("span", { class: "dim" }, " on parts, which is where maintenance and quality meet.")),
    explain("Why rising vibration warns of bearing failure", () => `The visitor set vibration to ${s.value().toFixed(1)} mm/s. Zones: A up to 1.4, B up to 2.8, C up to 4.5 (alarm), D above; trip at 7.1 mm/s.`, { key: "vibration" }));
  paint();
}

// ------------------------------------------------------------------ 3. quality
function qualitySection(body) {
  const a = slider({ label: "Availability (running share of planned time)", min: 40, max: 100, step: 1, value: 88, unit: " %" }, () => paintOee());
  const p = slider({ label: "Performance (speed vs ideal)", min: 40, max: 100, step: 1, value: 92, unit: " %" }, () => paintOee());
  const q = slider({ label: "Quality rate (good first time)", min: 70, max: 100, step: 0.5, value: 97, unit: " %", fmt: (v) => v.toFixed(1) }, () => paintOee());
  const oeeVal = h("span", {}), oeeSub = h("span", {}), parts = h("span", {});
  const oeeVerdict = h("p", { class: "learn-note", "aria-live": "polite" });
  const paintOee = () => {
    const o = (a.value() / 100) * (p.value() / 100) * (q.value() / 100);
    oeeVal.textContent = `${(o * 100).toFixed(1)} %`;
    oeeSub.textContent = `${a.value()} % × ${p.value()} % × ${q.value().toFixed(1)} %`;
    parts.textContent = num(Math.round(480 * o));
    oeeVerdict.textContent = o >= 0.85 ? "World-class: few plants run this well all the time."
      : o >= 0.6 ? "Typical for a real plant: there is room to win output without buying a machine."
      : "Low: the machine loses most of its potential. Look at the smallest of the three numbers first.";
  };
  const qty = slider({ label: "Cylinder heads made per day", min: 100, max: 1000, step: 10, value: 545 }, () => paintScrap());
  const sr = slider({ label: "Scrap rate", min: 0, max: 10, step: 0.1, value: 2.4, unit: " %", fmt: (v) => v.toFixed(1) }, () => paintScrap());
  const perDay = h("span", {}), perYear = h("span", {}), xNorm = h("span", {});
  const scrapNote = h("p", { class: "learn-note", "aria-live": "polite" });
  const PRICE = 70, SUNK = 0.55, NORMAL = 0.8;
  const paintScrap = () => {
    const bad = qty.value() * sr.value() / 100;
    const day = bad * PRICE * SUNK;
    perDay.textContent = money(day);
    perYear.textContent = money(day * 300);
    const x = sr.value() / NORMAL;
    xNorm.textContent = `${x.toFixed(1)}× normal`;
    scrapNote.textContent = `${num(bad, 1)} bad parts a day. Each one already used about ${money(PRICE * SUNK)} of metal, machine time and energy (55 % of its ${money(PRICE)} price). `
      + (x >= 2 ? "At 2× its own normal or more, Gemba's Quality agent looks for the cause." : "Close to this machine's normal: no alarm.");
  };
  body.append(
    oneLine("Quality means making parts that match the drawing, first time; every bad part is money already spent and thrown away."),
    para("A bad part that cannot be fixed is ", T("scrap"), ". Machined parts often fail because of ", T("chatter", "chatter marks"), "; cast parts because of ", T("porosity"),
      " that comes in with a bad ", T("casting_lot"), ". When a lot is suspect it goes into ", T("quarantine"), ", and quick ", T("containment"), " (such as checking every part) protects the customer while the ",
      T("root_cause"), " is fixed. Parts are checked on a ", T("cmm", "CMM"), "."),
    para("Scrap goes up and down a little every hour. A ", T("control_chart"), " (for scrap, a ", T("p_chart"), ") draws limits around each machine's own normal, so a point outside them is a real signal, not bad luck."),
    para("The best-known factory score is ", T("oee", "OEE"), ": ", T("availability"), " × ", T("performance"), " × ", T("quality_rate"), ". It tells you how much of a machine's potential you really get."),
    tryIt("OEE calculator", a, p, q,
      h("div", { class: "kpis learn-kpis" }, stat("OEE", oeeVal, oeeSub), stat("Good parts in an 8-hour shift", parts, "if the ideal is one part a minute (480)")), oeeVerdict),
    tryIt("What does scrap cost?", qty, sr,
      h("div", { class: "kpis learn-kpis" }, stat("Scrap cost per day", perDay, "material and work already spent"), stat("Per year (300 days)", perYear), stat("Against its normal", xNorm, `normal is ${NORMAL} %`)), scrapNote),
    explain("OEE and scrap for a beginner", () => `OEE calculator: availability ${a.value()} %, performance ${p.value()} %, quality ${q.value()} %. Scrap calculator: ${qty.value()} parts a day at ${sr.value()} % scrap, part price ${money(PRICE)}.`, { key: "oee" }));
  paintOee(); paintScrap();
}

// ------------------------------------------------------------------ 4. energy
function energySection(body) {
  const good = slider({ label: "Good parts made in one hour", min: 10, max: 60, step: 1, value: 50 }, () => paint());
  const leak = slider({ label: "Compressed-air leak", min: 0, max: 15, step: 0.5, value: 8, unit: " kW", fmt: (v) => v.toFixed(1) }, () => paint());
  const kpp = h("span", {}), kppSub = h("span", {}), leakDay = h("span", {}), leakMoney = h("span", {}), leakCo2 = h("span", {});
  const note = h("p", { class: "learn-note", "aria-live": "polite" });
  const KW = 18, AVG = 0.086, GRID = 0.71;
  const paint = () => {
    const v = KW / good.value();
    kpp.textContent = `${v.toFixed(2)} kWh`;
    kppSub.textContent = `${KW} kWh ÷ ${good.value()} good parts`;
    const kwh = leak.value() * 24;
    leakDay.textContent = `${num(kwh)} kWh`;
    leakMoney.textContent = `${money(kwh * AVG)} a day`;
    leakCo2.textContent = `${num(kwh * GRID)} kg`;
    note.textContent = `The machine draws the same power whether a part comes out good or bad, so fewer good parts means more energy per part (${(KW / 60).toFixed(2)} kWh at its best). `
      + (kwh ? `The leak alone wastes ${money(kwh * AVG * 365)} and ${num(kwh * GRID * 365 / 1000, 1)} tonnes of CO2e a year.` : "No leak: nothing wasted.");
  };
  body.append(
    oneLine("Machines run on electricity; the smart measure is energy per good part, and the hidden waste is power used when nothing useful is made."),
    para("A ", T("vmc", "VMC"), " draws about 18 kW while cutting: in one hour that is 18 kWh, the same unit as a home electricity bill. Dividing by the good parts made gives ",
      T("kwh_per_part"), ". Power is dearer at peak hours and cheaper at night: a ", T("tariff"), "."),
    para("Every kWh from the grid also means carbon: ", T("co2e", "CO2e"), ", worked out with a ", T("grid_factor"), " (about 0.71 kg per kWh in India, 0.40 in Thailand). A ",
      T("air_leak"), " is the classic hidden waste: the compressor runs all night to refill air that hisses away."),
    tryIt("kWh per good part, and what a leak costs", good, leak,
      h("div", { class: "kpis learn-kpis" }, stat("Energy per good part", kpp, kppSub), stat("Leak, per day", leakDay, leakMoney), stat("Leak carbon per day", leakCo2, "CO2e at India's grid factor")), note),
    explain("kWh per good part and carbon", () => `Example machine 18 kW, ${good.value()} good parts per hour. Air leak of ${leak.value()} kW running 24 h; average price ${money(AVG)} per kWh; grid factor 0.71 kg CO2e per kWh.`, { key: "kwh_per_part" }));
  paint();
}

// ------------------------------------------------------------------ 5. orders
function ordersSection(body) {
  const lost = slider({ label: "Hours lost to an unplanned breakdown", min: 0, max: 30, step: 1, value: 6, unit: " h" }, () => paint());
  const out = h("div", { class: "learn-verdict", "aria-live": "polite" });
  const ORDER = 1800, STOCK = 600, RATE = 30, HOURS = 48;
  const paint = () => {
    const can = STOCK + RATE * Math.max(0, HOURS - lost.value());
    const ok = can >= ORDER;
    out.className = `learn-verdict v-${ok ? (can - ORDER < 150 ? "watch" : "ok") : "alarm"}`;
    out.replaceChildren(h("b", {}, ok ? "Covered: the order ships on time" : `Short by ${num(ORDER - can)} parts: the order ships late`),
      h("p", {}, `${num(STOCK)} in stock + ${RATE} an hour × ${HOURS - lost.value()} working hours = ${num(can)} of ${num(ORDER)} parts by the due time.`),
      h("p", { class: "dim small" }, ok ? "A planned repair at a quiet hour would keep it that way." : "This is why Gemba checks orders before it suggests when to repair a machine."));
  };
  body.append(
    oneLine("Machines exist to fill customer orders; a breakdown matters most when it puts an order at risk."),
    para("Car makers order parts for a due date. ", T("order_cover"), " asks: will the ", T("fg_stock", "finished-goods stock"), " plus what we make in time be enough? Suppliers are judged on ",
      T("otif", "OTIF"), ". Supply also means spare parts: a bearing can come from a sister plant by ", T("spare_transfer"), " instead of a week-long wait."),
    tryIt("Will the Friday order ship?", h("p", { class: "small dim" }, `An order for ${num(ORDER)} parts is due in ${HOURS} hours. The line makes ${RATE} an hour and ${num(STOCK)} are already packed.`), lost, out),
    explain("Order cover and on-time delivery", () => `Order ${ORDER} parts due in ${HOURS} h, stock ${STOCK}, line rate ${RATE} per hour, ${lost.value()} h lost to a breakdown.`, { key: "order_cover" }));
  paint();
}

// ------------------------------------------------------------------ 6. agents
function agentsSection(body) {
  const LENS = [
    ["reliability", "machines", "Is any machine wearing out? How long until it trips? Are spares in stock?", "VMC-204's vibration is in zone C and rising: about 30 h to trip."],
    ["quality", "parts", "Is scrap above each machine's normal? Which defect, which lot?", "Chatter-mark scrap on VMC-204 is 3× its normal."],
    ["supply", "orders", "Which customer orders depend on that machine? Do we have cover?", "Friday's cylinder-head order needs VMC-204 running."],
    ["energy", "power and carbon", "Where is power wasted? When is power cheapest?", "The repair test run fits the cheap night tariff."],
    ["flow", "the line", "Is a machine the bottleneck? Who can absorb its work?", "VMC-203 can take extra work during the repair."],
  ];
  body.append(
    oneLine("Five AI agents look at the same plant through five different lenses, all at the same time; the Lead joins what they see into one plan a person approves."),
    para("Each ", T("ai_agent"), " is like a department head on a ", T("gemba_walk"), ": it uses tools (reads sensors, queries data, runs the ",
      T("digital_twin"), ") and reports what it found in its own area. They are not a relay race where one waits for the next: they all start together."),
    h("div", { class: "learn-lenses", role: "list" }, ...LENS.map(([ag, looks, asks, ex], i) => h("div", { class: `learn-lens ag-${ag}`, role: "listitem", style: `--i:${i}` },
      h("div", { class: "learn-lens-head" }, h("span", { class: "learn-lens-ico", "aria-hidden": "true" }, AGENTS[ag].ico), h("b", {}, AGENTS[ag].name), h("span", { class: "dim tiny" }, `looks at ${looks}`)),
      h("i", { class: "learn-lens-bar", "aria-hidden": "true" }),
      h("p", { class: "small" }, asks), h("p", { class: "tiny dim" }, h("b", {}, "Finds: "), ex)))),
    h("div", { class: "learn-lead" }, h("div", { class: "learn-lead-head" }, h("span", { "aria-hidden": "true" }, AGENTS.lead.ico), h("b", {}, "Gemba Lead links them")),
      h("p", { class: "small" }, "Findings that share a machine, a part or an order are one story: worn bearing → chatter scrap → Friday order at risk → repair in the cheap night hours → neighbour machine takes the work. ",
        "The Lead writes that as one card with one plan, checks it on the ", T("whatif", "what-if simulator"), ", and a named person approves it. Nothing happens on its own."),
      h("div", { class: "row gap wrap" }, h("a", { class: "btn small primary", href: "#/walk" }, "Watch a Gemba walk →"), h("a", { class: "btn small", href: "#/trust" }, "See the safety rules"))),
    explain("Why five agents work in parallel and a lead links them", "Gemba runs five agents (Reliability, Quality, Supply, Energy, Flow) at the same time over one simulated plant; the Lead links findings that share a machine, part or order into one plan that a person approves after a simulator check.", { key: "ai_agent" }));
}

// ------------------------------------------------------------------ drills
const DRILLS = [
  { id: "bearing_wear_vmc202",
    happen: "About 30 seconds after you press Start, the bearing in VMC-202's spindle begins to wear. Its vibration climbs from about 2.5 mm/s towards the 4.5 mm/s alarm limit and its temperature rises. Left alone, it would reach the trip limit and stop itself about 40 plant-hours later.",
    watch: ["The VMC-202 tile on the floor turns from green to amber", "On its machine page the vibration line climbs towards the alarm line", "A Gemba Watch message appears and only the agents that matter wake up", "A new card for VMC-202 lands in the walk"],
    good: ["Check the spare bearing: is one in Pune, or can a sister plant send it?", "Repair before the trip, in a quiet, cheap-power hour if the order allows", "Protect the cylinder-head orders that need this machine", "Lock-out / tag-out first, a release check after; a named person approves"],
    quiz: [
      { q: "VMC-202's vibration reads 3.6 mm/s. Which zone, and what should happen?", a: ["Zone A: nothing to do", "Zone C: plan a repair soon", "Zone D: stop the machine immediately"], c: 1, why: "3.6 is between 2.8 and 4.5 mm/s: zone C. There is time to plan, but not to ignore it." },
      { q: "Why repair before the trip limit instead of waiting for the machine to stop?", a: ["A planned stop lets you choose the hour and have the part and people ready", "A trip costs nothing", "Machines repair themselves after a trip"], c: 0, why: "A trip is an unplanned stop at a random hour; emergency repairs cost more and can make orders late." },
      { q: "What is the first step on any repair job?", a: ["Order a new machine", "Lock-out / tag-out the power", "Turn the spindle speed up"], c: 1, why: "Locking out the power stops the machine starting while someone's hands are inside." },
    ] },
  { id: "air_leak_chk",
    happen: "About 30 seconds after you press Start, a compressed-air leak opens at the Chakan plant. The compressor (CMP-951) has to work about 8 kW harder to keep the pressure up, all day and all night, even when nothing is being made.",
    watch: ["Chakan's compressor power stays high at night when the plant is quiet", "The Energy view shows the extra kWh, money and carbon", "The Energy agent flags the night-time load as waste"],
    good: ["Find the leak on the next shift: listen for the hiss or use a leak detector", "No need to stop production to fix it", "Report the kWh, money and CO2e saved so the fix is visible"],
    quiz: [
      { q: "Why is night time the best moment to spot an air leak?", a: ["Leaks only happen at night", "Production is stopped, so any compressor load left is mostly waste", "Electricity is free at night"], c: 1, why: "With the machines idle, air demand should be near zero; what the compressor still does is mostly feeding leaks." },
      { q: "An 8 kW leak runs 24 hours. About how much energy is that a day?", a: ["8 kWh", "192 kWh", "1,920 kWh"], c: 1, why: "kW × hours = kWh: 8 × 24 = 192 kWh, about what a family home uses in a week." },
      { q: "At 0.71 kg CO2e per kWh, those 192 kWh are about…", a: ["14 kg CO2e", "136 kg CO2e", "1.4 tonnes CO2e"], c: 1, why: "192 × 0.71 ≈ 136 kg of CO2e every day, roughly 50 tonnes a year from one leak." },
    ] },
  { id: "sensor_stuck_hob301",
    happen: "About 30 seconds after you press Start, the vibration sensor on the gear-cutting machine HOB-301 freezes: it keeps sending exactly 2.0 mm/s while the machine itself carries on normally.",
    watch: ["The tile shows Sensor fault (blue), not Act now", "A perfectly flat line on its machine page: real machines always wobble a little", "The card asks for a sensor check, and a safety rule stops anyone booking a repair crew"],
    good: ["Send an instrument technician to check the sensor and its cable", "Keep the machine running and watch its other signals and part quality", "Do not open a healthy machine"],
    quiz: [
      { q: "A sensor reads exactly 2.00 mm/s for hours. What is most likely?", a: ["The machine is perfectly healthy", "The sensor or its cable has failed", "The bearing is about to fail"], c: 1, why: "Real readings always wobble a little; a perfectly flat line is the sensor, not the machine." },
      { q: "What should Gemba recommend?", a: ["A full spindle repair", "A sensor check by an instrument technician", "Stop all gear production"], c: 1, why: "The fix is cheap and quick: check the sensor. Gemba's safety rules never send a repair crew for a sensor fault." },
      { q: "Why does getting this right matter for money?", a: ["A wrong repair wastes crew hours and stops a healthy machine", "It does not matter", "Sensors are the most expensive part of a machine"], c: 0, why: "Stopping a good machine for a needless repair loses output and wages, and can make an order late." },
    ] },
];

function drillsSection(cleanups) {
  const sec = h("section", { class: "learn-drills", id: "learn-drills", "aria-labelledby": "learn-h-drills" },
    h("div", { class: "learn-sec-head plain" }, h("span", { class: "learn-num", "aria-hidden": "true" }, "▶"), h("h2", { id: "learn-h-drills" }, "Drills: practise on the live plant")),
    h("p", { class: "learn-p" }, "Each drill starts a real problem on your own copy of the simulated plant (nobody else sees it). Press Start, open the floor and watch Gemba notice it. ",
      "Then come back and check yourself with three questions. Presenter controls (⏱) can speed up the clock or reset the demo."));
  const grid = h("div", { class: "learn-drill-grid" });
  const chips = {};
  for (const d of DRILLS) {
    const meta = SCEN[d.id];
    const chip = h("span", { class: "status st-idle" }, "Not started");
    chips[d.id] = chip;
    const start = h("button", { type: "button", class: "btn primary" }, "Start drill");
    start.addEventListener("click", async () => {
      start.disabled = true;
      try {
        let r;
        try { r = await api.post("/api/presenter/drill", { scenario: d.id, delay_s: 30 }); }
        catch (e) {
          if (e.status !== 404 && e.status !== 405) throw e;
          if (!/not found/i.test(e.message)) throw e;            // drill endpoint missing: inject straight away instead
          await api.post("/api/presenter/inject", { scenario: d.id });
          r = { due_in_s: 0, label: meta.title };
        }
        const s = Math.round(r.due_in_s ?? 30);
        chip.className = "status st-watch"; chip.textContent = s > 0 ? `Starts in ${s} s` : "Running now";
        toast(`${r.label || meta.title}: ${s > 0 ? `starts in ${s} s` : "started"}. Open the floor to watch Gemba notice it.`, "ok", 9000, { href: "#/", label: "Watch the floor →" });
      } catch (e) {
        toast(e.status === 409 ? "This drill is already running on your plant. Reset the demo (⏱) to run it again." : `Could not start the drill: ${e.message}`, e.status === 409 ? "info" : "err", 7000);
      } finally { setTimeout(() => { start.disabled = false; }, 1500); }
    });
    grid.append(h("article", { class: `panel learn-drill ag-${meta.ag}` },
      h("div", { class: "learn-drill-head" }, h("div", {}, h("h3", {}, meta.title), h("p", { class: "tiny dim" }, meta.where)), chip),
      h("div", { class: "learn-drill-body" },
        h("h4", {}, "What will happen"), h("p", { class: "small" }, d.happen),
        h("div", { class: "row gap wrap" }, start, h("a", { class: "btn small", href: "#/" }, "Open the floor")),
        h("h4", {}, "What to watch"), h("ul", { class: "small learn-list" }, ...d.watch.map((x) => h("li", {}, x))),
        h("h4", {}, "What a good response looks like"), h("ul", { class: "small learn-list good" }, ...d.good.map((x) => h("li", {}, x))),
        quiz(d))));
  }
  sec.append(grid);
  const paint = () => {
    for (const dr of store.tick?.session?.drills || []) {
      const chip = chips[dr.scenario];
      if (!chip || !DRILL_STATE[dr.status]) continue;
      const [cls, word] = DRILL_STATE[dr.status];
      const left = dr.status === "pending" && dr.due_at && store.tick?.now ? Math.max(0, Math.round(dr.due_at - store.tick.now)) : null;
      chip.className = `status st-${cls}`;
      chip.textContent = left != null && left < 600 ? `Starts in ${left} s` : word;
    }
  };
  paint();
  cleanups.push(store.on((k) => { if (k === "tick") paint(); }));
  return sec;
}

function quiz(d) {
  const score = h("p", { class: "learn-score small", "aria-live": "polite" });
  const answered = new Map();
  const box = h("div", { class: "learn-quiz" }, h("h4", {}, "Check yourself"));
  d.quiz.forEach((item, qi) => {
    const fb = h("p", { class: "learn-fb small", "aria-live": "polite" });
    const opts = item.a.map((txt, ai) => h("button", { type: "button", class: "learn-opt", onclick: () => pick(ai) }, txt));
    function pick(ai) {
      const right = ai === item.c;
      opts.forEach((b, i) => {
        b.classList.toggle("right", i === item.c);
        b.classList.toggle("wrong", i === ai && !right);
        b.setAttribute("aria-pressed", String(i === ai));
      });
      fb.className = `learn-fb small ${right ? "ok" : "no"}`;
      fb.replaceChildren(h("b", {}, right ? "✓ Right. " : "✗ Not quite. "), item.why);
      if (!answered.has(qi)) answered.set(qi, right);
      const got = [...answered.values()].filter(Boolean).length;
      score.textContent = answered.size === d.quiz.length ? `You got ${got} of ${d.quiz.length} right first time.${got === d.quiz.length ? " Ready to explain it to a judge." : " Read the hints and try the drill."}` : "";
    }
    box.append(h("fieldset", { class: "learn-q" }, h("legend", {}, `${qi + 1}. ${item.q}`), h("div", { class: "learn-opts" }, ...opts), fb));
  });
  box.append(score);
  return box;
}

// ------------------------------------------------------------------ compare
function compareSection() {
  const ROWS = [
    ["Maintenance software (CMMS)", "Work orders, maintenance schedules, spare-part records", "Deciding which job matters most today, and linking it to scrap, orders and energy"],
    ["Condition monitoring", "Sensor trends and alarms for each machine", "What an alarm means for quality, delivery and cost; who should act and when"],
    ["MES and OEE dashboards", "Counting output, stops and OEE by line and shift", "Explaining why a number moved and what to do next"],
    ["Industrial AI assistants (chat)", "Answering questions over manuals and plant data", "Checking a proposed action on a simulator before a person approves it"],
  ];
  return h("section", { class: "panel learn-sec", id: "learn-compare", "aria-labelledby": "learn-h-compare" },
    h("div", { class: "learn-sec-head" }, h("span", { class: "learn-num", "aria-hidden": "true" }, "≈"), h("h2", { id: "learn-h-compare" }, "How Gemba compares")),
    h("div", { class: "learn-sec-body" },
      oneLine("Plants already use tools that are each good at one department; Gemba is meant to sit on top of them and join the dots."),
      h("div", { class: "table-wrap" }, h("table", { class: "data learn-compare" },
        h("thead", {}, h("tr", {}, h("th", {}, "Tool type"), h("th", {}, "Typically good at"), h("th", {}, "Often left to people"))),
        h("tbody", {}, ...ROWS.map((r) => h("tr", {}, h("td", {}, h("b", {}, r[0])), h("td", { class: "small" }, r[1]), h("td", { class: "small dim" }, r[2])))))),
      h("h3", { class: "learn-h3" }, "What Gemba adds"),
      h("div", { class: "learn-adds" },
        add("⇄", "Links departments", "One card joins a worn bearing, the scrap it causes, the order at risk and the cheapest hour to repair, instead of four separate alerts."),
        add("◈", "A tutor for beginners", "Every number says what it means, and the tutor explains any word in plain English, so new staff and students learn on the real screen."),
        add("⧗", "Plans checked on a simulator", "Before anyone approves, the plan is run forward on the digital twin: scrap, cost and delivery with and without it."),
        add("✓", "People approve", "Agents only propose. A named person approves; sensor faults never send a repair crew; every step is logged.")),
      h("p", { class: "tiny faint" }, "Gemba is a prototype on a simulated plant. The table describes common tool categories in general terms, not any particular product.")));
}
function add(ico, title, text) { return h("div", { class: "learn-add" }, h("span", { class: "learn-add-ico", "aria-hidden": "true" }, ico), h("div", {}, h("b", {}, title), h("p", { class: "small dim" }, text))); }

// ------------------------------------------------------------------ free question
function tutorBox() {
  const input = h("input", { type: "text", maxlength: 120, placeholder: "e.g. What is a hobbing machine?", "aria-label": "A word or question for the tutor" });
  const out = h("div", { class: "tutor-out", "aria-live": "polite" });
  const send = h("button", { class: "btn primary", type: "submit" }, "Ask the tutor");
  const form = h("form", { class: "learn-ask", onsubmit: async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    send.disabled = true;
    out.replaceChildren(h("p", { class: "tutor-wait" }, h("span", { class: "thinking" }, h("i"), h("i"), h("i")), " The tutor is writing a plain-language answer…"));
    try { out.replaceChildren(answerBox(await askTutor(q, ""))); }
    catch (err) { out.replaceChildren(h("p", { class: "small" }, err.message)); }
    finally { send.disabled = false; }
  } }, input, send);
  return h("section", { class: "panel learn-sec learn-tutor" },
    h("div", { class: "learn-sec-head" }, h("span", { class: "learn-num", "aria-hidden": "true" }, "?"), h("h2", {}, "Still stuck? Ask the tutor")),
    h("div", { class: "learn-sec-body" }, h("p", { class: "small dim" }, "Type any word you saw in Gemba. The tutor answers like a patient teacher: short, with an everyday example and why it matters."), form, out));
}
