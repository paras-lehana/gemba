// Learn: plain-language explanations for people new to manufacturing (contract used by every view).
// term(key, label?) -> inline element with a dotted underline; hover, focus or tap shows a short definition, why it
//   matters and an "Ask the tutor" button. Works on phones (tap), closes on an outside tap or Escape.
// explain(topic, context?, opts?) -> "Explain this" button that asks the Gemini tutor (POST /api/explain) and shows the
//   answer inline under the button. context may be a string or a function returning one (read at click time).
// GLOSSARY: { key: { label, short, why } }. Keep one term per line in this exact shape: the server's fallback reads it.
import { api, h } from "./core.js";

export const GLOSSARY = {
  spindle: { label: "Spindle", short: "The fast-spinning shaft of a machine tool that holds the cutting tool and turns it thousands of times a minute.", why: "If the spindle shakes or overheats, every part it cuts gets worse, and a spindle failure can stop a line for days." },
  bearing: { label: "Bearing", short: "A ring of small steel balls or rollers that lets a shaft spin smoothly, like the hub of a bicycle wheel.", why: "Bearings wear out slowly. A worn bearing shakes and heats up first, which gives days of warning before it fails." },
  vibration: { label: "Vibration (mm/s RMS)", short: "How hard a machine shakes, measured as the average speed of the shaking in millimetres per second (RMS is a kind of average).", why: "A healthy machine hums; a failing one shakes a little more each day. Rising vibration is the earliest sign of bearing trouble." },
  chatter: { label: "Chatter marks", short: "Wavy ripples left on a machined surface when the tool or the machine shakes while cutting.", why: "Parts with chatter marks fail inspection and become scrap. They often point back to a shaky spindle or a worn bearing." },
  scrap: { label: "Scrap", short: "A part that is bad and cannot be sold or fixed, so it is thrown away or melted down.", why: "Each scrapped part wastes the material, machine time and energy already spent on it." },
  porosity: { label: "Porosity", short: "Tiny gas bubbles or holes trapped inside a cast metal part, like the air holes in bread.", why: "Porous parts can leak or crack, so they are rejected. It usually comes from the metal batch or the casting, not the machine that cuts the part." },
  casting_lot: { label: "Casting lot", short: "A batch of cast parts made together from the same metal, tracked with one lot number.", why: "If one lot is bad, every part from it is suspect. The lot number lets you find and stop exactly those parts." },
  quarantine: { label: "Quarantine", short: "Setting suspect material or parts aside with a tag, so nobody uses them until they are checked.", why: "It stops one bad batch from turning into hundreds of scrap parts or a customer complaint." },
  containment: { label: "Containment", short: "The quick first action that stops a problem spreading, such as sorting suspect parts or checking every part, before the real cause is fixed.", why: "Customers expect the bleeding to stop within hours, even if the root-cause fix takes days." },
  good_parts: { label: "Good parts", short: "Parts that pass inspection and can be sold to the customer.", why: "Only good parts pay the bills and fill customer orders; every scrapped part is material, machine time and energy lost." },
  kwh_per_good: { label: "kWh per good part", short: "Electricity used for each sellable part: total kWh divided by good parts.", why: "It shows waste that total kWh hides: a worn machine or an air leak uses energy that makes nothing." },
  kwh: { label: "kWh (kilowatt-hour)", short: "A unit of electrical energy: one kilowatt used for one hour. Your electricity bill counts kWh.", why: "Less kWh for the same output means a lower bill and less CO2." },
  net_value: { label: "Net value", short: "Money earned on good parts (the margin) minus the cost of scrapped parts and the electricity bill.", why: "It lets you compare two plans in one number: higher is better for the business." },
  cover: { label: "Order cover", short: "Parts we will have by the due date (stock plus good parts still to be made) divided by the parts the customer ordered.", why: "Below 100 % the order ships short or late, which can cost the supplier its rating with the customer." },
  trip: { label: "Trip (machine stops itself)", short: "When a reading passes the trip limit, the machine shuts down by itself to protect itself.", why: "A trip is an unplanned stop: the line loses output until someone repairs it, usually at a worse time than a planned repair." },
  iso_zone: { label: "Vibration zone (A to D)", short: "A standard way to grade vibration: A is like new, B is fine for long running, C means plan a repair soon, D means damage is likely.", why: "It turns a raw number into a decision: zone C on VMC-204 is why Gemba plans a repair before the machine trips." },
  kw: { label: "kW (kilowatt)", short: "How much electrical power a machine is drawing right now. Power over time is energy, measured in kWh.", why: "A machine that draws more power for the same work is wasting money and adding CO2; a compressor drawing power at night with lines stopped usually has a leak." },
  oee: { label: "OEE (overall equipment effectiveness)", short: "One score for how well a machine is used: availability x performance x quality rate. 100 % means only good parts, at full speed, all the planned time.", why: "World-class plants reach about 85 %; many sit at 50 to 65 %. Each point of OEE is extra output without buying a machine." },
  availability: { label: "Availability", short: "The share of planned time the machine was actually running, not stopped for breakdowns, set-ups or waiting.", why: "A stopped machine earns nothing but still costs wages, rent and loan payments." },
  performance: { label: "Performance", short: "How fast the machine ran while it was running, compared with its ideal speed (its ideal cycle time).", why: "Running slower than ideal, for example to hide vibration, quietly loses output every hour." },
  quality_rate: { label: "Quality rate", short: "The share of parts that were good the first time: not scrap and not reworked.", why: "Bad parts take the same time and material as good ones, so they cost twice: lost output and wasted material." },
  cycle_time: { label: "Cycle time", short: "The seconds a machine needs to finish one part and start the next.", why: "Cycle time sets how many parts a shift can make, and so whether an order can ship on time." },
  alarm_limit: { label: "Alarm limit", short: "The sensor value where people are warned to plan action, for example 4.5 mm/s of vibration.", why: "It buys time to act calmly: order parts, pick a cheap hour for the repair and keep orders safe." },
  trip_limit: { label: "Trip limit", short: "The sensor value where the machine stops itself to prevent damage or injury, for example 7.1 mm/s of vibration.", why: "A trip is an unplanned stop at a random hour, and emergency repairs cost more. The aim is to act before the trip." },
  iso_zones: { label: "ISO vibration zones A to D", short: "A standard way to grade machine shaking: A is like new, B is fine for long running, C means plan a repair, D means damage is likely.", why: "It turns a number like 3.9 mm/s into a decision anyone can make. For a medium machine the borders are about 1.4, 2.8 and 4.5 mm/s." },
  health_index: { label: "Health index", short: "A 0 to 100 score that sums up how close a machine's sensors are to their limits; 100 is healthy, low numbers need attention.", why: "One number per machine lets a manager scan a whole plant in seconds." },
  anomaly_score: { label: "Anomaly score", short: "How unusual the current mix of sensor readings looks compared with the machine's own normal history (0 normal, near 1 very unusual).", why: "It can catch trouble that no single limit shows, such as heat rising while current falls." },
  time_to_trip: { label: "Time to trip", short: "An estimate of the hours left before a rising sensor reaches its trip limit, shown as a range because the future is uncertain.", why: "It tells the planner whether a repair can wait for tonight's cheap-power hours or must happen now." },
  pm: { label: "Preventive maintenance (PM)", short: "Planned servicing on a schedule, like a car's oil change every 10,000 km, done before anything breaks.", why: "Planned work is cheaper and safer than an emergency repair and does not surprise the production plan." },
  overdue_pm: { label: "Overdue PM", short: "A scheduled service that has passed its due date without being done.", why: "Overdue machines break down more often; it is a simple sign that a machine is running on luck." },
  spare_transfer: { label: "Spare part transfer", short: "Moving a spare part, such as a bearing set, from one plant's store to a sister plant that needs it.", why: "Borrowing from a sister plant can turn a week-long wait for a supplier into a few hours on a truck." },
  loto: { label: "Lock-out / tag-out (LOTO)", short: "A safety routine: switch off the machine's power and lock it with a personal padlock and tag before anyone works on it.", why: "It stops a machine from starting while someone's hands are inside. Gemba always lists it first on a repair job." },
  release_check: { label: "Release check", short: "The checks after a repair before the machine goes back to production, such as a test cut and a vibration reading.", why: "A repair is not finished until the first parts are good; skipping it can ship bad parts." },
  air_leak: { label: "Compressed-air leak", short: "Air escaping from the pipes and fittings of the compressed-air system that powers tools and clamps; you often hear it hiss.", why: "The compressor keeps running to replace the lost air, even at night, wasting electricity every hour." },
  kwh_per_part: { label: "kWh per good part", short: "The electricity used divided by the number of good parts made. A kWh is the same unit as on a home electricity bill.", why: "It shows waste fairly: a machine that idles or makes scrap uses more energy per good part even if its total looks normal." },
  co2e: { label: "CO2e (carbon)", short: "Climate impact counted as kilograms of carbon dioxide equivalent. Each kWh from the grid carries a share of the power stations' emissions.", why: "Car makers and laws increasingly ask suppliers to report and cut carbon, so wasted kWh are also a carbon cost." },
  grid_factor: { label: "Grid factor", short: "How many kilograms of CO2e the power grid emits for each kWh used: about 0.71 in India and 0.40 in Thailand.", why: "The same wasted kWh costs almost twice the carbon in India as in Thailand, because more of India's power comes from coal." },
  tariff: { label: "Peak and off-peak tariff", short: "Electricity prices that change with the time of day: dearest at peak hours, cheapest at night (off-peak).", why: "Moving energy-hungry work, such as a test run after a repair, to off-peak hours cuts the bill without making less." },
  control_chart: { label: "Control chart", short: "A chart of a measure over time with limits drawn from the process's own normal wobble; a point outside the limits is a real signal, not noise.", why: "It separates a real change from everyday randomness, so people react only to real problems." },
  p_chart: { label: "p-chart", short: "A control chart for the share of bad parts (p for proportion) in each hour or batch.", why: "When the scrap share jumps above its upper limit, something in the process has changed and needs a look." },
  frozen_sensor: { label: "Frozen sensor", short: "A sensor that keeps sending exactly the same value; the sensor or its cable has failed, not the machine.", why: "Sending a repair crew for a sensor fault wastes hours and stops a healthy machine. Gemba asks for a sensor check instead." },
  order_cover: { label: "Order cover", short: "Whether the stock we have plus what we will make in time is enough to ship a customer order by its due date.", why: "If a breakdown cuts production, cover drops and the order ships late." },
  otif: { label: "OTIF (on time, in full)", short: "The share of orders delivered on the promised day with the full quantity.", why: "Car makers rate suppliers on OTIF; a low score can mean penalties or losing the next contract." },
  fg_stock: { label: "Finished-goods stock", short: "Completed parts packed in the warehouse, waiting to be shipped.", why: "It is a safety cushion: enough stock lets a plant repair a machine without missing a delivery." },
  vmc: { label: "VMC (vertical machining centre)", short: "A computer-controlled milling machine whose spindle points down; it cuts metal blocks into precise parts such as cylinder heads.", why: "VMCs do the high-value cutting, so a sick VMC quickly hits scrap, output and orders." },
  cmm: { label: "CMM (coordinate measuring machine)", short: "A very precise measuring machine that touches a part with a probe to check its size against the drawing, to a thousandth of a millimetre.", why: "It is the final judge of whether a part is good, so its results drive quality decisions." },
  die_casting: { label: "Die casting", short: "Making metal parts by forcing molten aluminium into a steel mould (the die) under high pressure.", why: "It is fast, but trapped gas can cause porosity, so castings are tracked by lot." },
  hob: { label: "Hobbing machine (HOB)", short: "A machine that cuts the teeth of gears with a rotating toothed cutter called a hob.", why: "Gears must be very precise; a hobbing problem can stop a whole gear line." },
  digital_twin: { label: "Digital twin", short: "A live software copy of the plant that mirrors each machine's state and can be run forward to test ideas.", why: "You can try a decision on the twin first, so mistakes cost nothing." },
  whatif: { label: "What-if simulation", short: "Running the digital twin forward under a chosen action, such as repair tonight versus do nothing, and comparing the results.", why: "It shows the cost, scrap and delivery effect of a plan before anyone touches a real machine." },
  gemba_walk: { label: "Gemba walk", short: "Gemba is Japanese for the real place. A Gemba walk is when managers walk the shop floor to see problems with their own eyes.", why: "Gemba sends AI agents on this walk across every plant at once, then shows people what they found." },
  ai_agent: { label: "AI agent", short: "An AI model that uses tools by itself (reads sensors, queries data, runs the simulator) to reach a goal, then reports back.", why: "Each Gemba agent checks one area of the plant; a named person always approves what they propose." },
  root_cause: { label: "Root cause", short: "The real reason a problem happened, not just the symptom; for example a worn bearing behind chatter-mark scrap.", why: "Fix only the symptom and the problem returns; fix the root cause and it stops for good." },
  work_order: { label: "Work order", short: "A written job for the maintenance team: what to fix, on which machine, when, with which parts and safety steps.", why: "It turns a decision into work that can be staffed, tracked and audited." },
  bottleneck: { label: "Bottleneck", short: "The slowest step in a line; it limits how many parts the whole line can make.", why: "An hour lost at the bottleneck is an hour lost for the whole line; elsewhere it may not matter." },
  downtime: { label: "Downtime", short: "Time a machine is stopped when it was planned to run.", why: "Unplanned downtime is the most expensive kind, because nobody prepared for it." },
};

// Other views may guess a key: accept common spellings and synonyms.
const ALIAS = {
  vibration_rms: "vibration", vib: "vibration", rms: "vibration", chatter_marks: "chatter", lot: "casting_lot", lots: "casting_lot",
  preventive_maintenance: "pm", preventive: "pm", lockout: "loto", lock_out: "loto", lockout_tagout: "loto", lock_out_tag_out: "loto",
  kwh_per_good_part: "kwh_per_part", kwh_per_good: "kwh_per_part", kwh: "kwh_per_part", co2: "co2e", carbon: "co2e", co2e_grid: "co2e",
  tariff_band: "tariff", peak: "tariff", off_peak: "tariff", offpeak: "tariff", tod: "tariff", spc: "control_chart",
  pchart: "p_chart", sensor_stuck: "frozen_sensor", stuck_sensor: "frozen_sensor", sensor_fault: "frozen_sensor",
  iso_zone: "iso_zones", zone: "iso_zones", zones: "iso_zones", vibration_zone: "iso_zones", health: "health_index",
  anomaly: "anomaly_score", ttf: "time_to_trip", time_to_failure: "time_to_trip", rul: "time_to_trip", trip: "trip_limit",
  alarm: "alarm_limit", spares: "spare_transfer", spare: "spare_transfer", spare_part: "spare_transfer", finished_goods: "fg_stock",
  stock: "fg_stock", twin: "digital_twin", what_if: "whatif", walk: "gemba_walk", agent: "ai_agent", agents: "ai_agent",
  compressed_air_leak: "air_leak", leak: "air_leak", die_cast: "die_casting", casting: "die_casting", hobbing: "hob",
  hobber: "hob", quality: "quality_rate", yield: "quality_rate", rca: "root_cause", wo: "work_order", cover: "order_cover",
  pm_overdue: "overdue_pm", on_time_in_full: "otif", cycle: "cycle_time", baseline: "control_chart",
};

/** Glossary entry for a key, a synonym or a label; null when unknown. */
export function lookup(key) {
  if (!key) return null;
  if (GLOSSARY[key]) return { key, ...GLOSSARY[key] };
  const k = String(key).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const hit = GLOSSARY[k] ? k : ALIAS[k] || Object.keys(GLOSSARY).find((g) => GLOSSARY[g].label.toLowerCase().replace(/[^a-z0-9]+/g, "_").startsWith(k));
  return hit ? { key: hit, ...GLOSSARY[hit] } : null;
}

// ------------------------------------------------------------------ term popover (one shared element, fixed position)
let pop = null, popFor = null, openedBy = "", hideTimer = 0, popSeq = 0, refocus = false;
// Give focus back to the word without reopening its popover.
const focusBack = (el) => { if (!el?.focus) return; refocus = true; try { el.focus(); } finally { refocus = false; } };
const isIn = (node, el) => !!(el && node && el.contains(node));

function ensurePop() {
  if (pop) return pop;
  pop = h("div", { class: "term-pop", role: "dialog", "aria-modal": "false", hidden: true });
  pop.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  pop.addEventListener("tutor-grew", () => { if (popFor && !pop.hidden) place(popFor); });   // the answer made it taller
  pop.addEventListener("mouseleave", () => { if (openedBy === "hover") scheduleHide(); });
  pop.addEventListener("focusout", (e) => { if (openedBy === "focus" && !isIn(e.relatedTarget, pop) && e.relatedTarget !== popFor) hidePop(); });
  document.body.append(pop);
  document.addEventListener("pointerdown", (e) => { if (pop && !pop.hidden && !isIn(e.target, pop) && !isIn(e.target, popFor)) hidePop(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop && !pop.hidden) { const t = popFor; hidePop(); focusBack(t); } });
  // A fixed popover would drift away from its word when the page scrolls: close it instead (not for scrolls inside it).
  document.addEventListener("scroll", (e) => { if (pop && !pop.hidden && !isIn(e.target, pop)) hidePop(); }, true);
  let lastW = innerWidth;                              // phones fire resize when the address bar hides: only width counts
  addEventListener("resize", () => { if (innerWidth !== lastW) { lastW = innerWidth; hidePop(); } });
  addEventListener("hashchange", () => hidePop());
  return pop;
}

function place(anchor) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  // On phones the menu is a bar at the bottom: keep the popover above it.
  const rail = document.querySelector(".rail")?.getBoundingClientRect();
  const vh = rail && rail.top > innerHeight / 2 && rail.width > innerWidth / 2 ? rail.top : innerHeight;
  pop.style.maxWidth = `${Math.min(360, vw - 16)}px`;
  pop.style.left = "0px"; pop.style.top = "0px";
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - pw / 2, vw - pw - 8));
  const below = r.bottom + 8 + ph <= vh - 8 || r.top - 8 - ph < 8;
  const top = below ? Math.min(r.bottom + 8, vh - ph - 8) : r.top - 8 - ph;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.max(8, top))}px`;
  pop.dataset.side = below ? "below" : "above";
}

function showPop(anchor, g, how) {
  ensurePop();
  clearTimeout(hideTimer);
  if (popFor === anchor && !pop.hidden) {
    if (how === "click") openedBy = "click";          // a hover or focus preview becomes pinned on tap
    return;
  }
  if (popFor) popFor.setAttribute("aria-expanded", "false");
  popFor = anchor; openedBy = how;
  const id = `term-pop-${++popSeq}`;
  pop.id = id;
  pop.setAttribute("aria-label", g.label);
  pop.replaceChildren(
    h("div", { class: "term-pop-head" }, h("b", {}, g.label),
      h("button", { type: "button", class: "term-pop-x", "aria-label": "Close", onclick: () => { const t = popFor; hidePop(); focusBack(t); } }, "×")),
    h("p", {}, g.short),
    h("p", { class: "term-why" }, h("span", { class: "term-why-k" }, "Why it matters: "), g.why),
    explain(g.label, `${g.short} Why it matters: ${g.why}`, { label: "Ask the tutor", key: g.key, compact: true }));
  pop.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", id);
  place(anchor);
}

function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hidePop, 220); }
function hidePop() {
  clearTimeout(hideTimer);
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  popFor?.setAttribute("aria-expanded", "false");
  popFor = null; openedBy = "";
}

/** Inline jargon word with a plain-language popover. Unknown keys render as plain text. */
export function term(key, label) {
  const g = lookup(key);
  const text = label || (g ? g.label : String(key ?? ""));
  if (!g) return h("span", {}, text);
  const el = h("span", { class: "term", role: "button", tabindex: "0", "aria-expanded": "false", "aria-haspopup": "dialog",
    "data-term": g.key, title: "" }, text);
  el.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") showPop(el, g, "hover"); });
  el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && openedBy === "hover" && popFor === el) scheduleHide(); });
  el.addEventListener("focus", () => { if (!refocus && popFor !== el) showPop(el, g, "focus"); });
  el.addEventListener("blur", (e) => { if (popFor === el && openedBy === "focus" && !isIn(e.relatedTarget, pop)) scheduleHide(); });
  el.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();           // a term inside a clickable row must not open the row
    if (popFor === el && !pop.hidden && openedBy === "click") hidePop(); else showPop(el, g, "click");
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); showPop(el, g, "click"); pop.querySelector(".explain-btn")?.focus(); }
  });
  return el;
}

// ------------------------------------------------------------------ tutor
const ANSWERS = new Map();

/** Ask the tutor; resolves to {answer, fallback, model}. Shared by explain() and the Learn page's free question box. */
export async function askTutor(topic, context = "", key = "") {
  const ctx = String((typeof context === "function" ? context() : context) || "").slice(0, 1900);
  const ck = `${topic}\n${ctx}`;
  if (ANSWERS.has(ck)) return ANSWERS.get(ck);
  const r = await api.post("/api/explain", { topic: String(topic).slice(0, 160), context: ctx, key: key || lookup(topic)?.key || "" });
  ANSWERS.set(ck, r);
  return r;
}

export function answerBox(r) {
  return h("div", { class: "tutor-answer" + (r.fallback ? " fallback" : "") },
    h("p", {}, r.answer),
    h("p", { class: "tutor-meta" }, r.fallback ? "Tutor offline right now: glossary meaning shown" : "Gemba tutor (Gemini) · plain-language explanation"));
}

/** "Explain this" button; the answer appears inline under it. Click again to hide, again to show (no second call). */
export function explain(topic, context = "", opts = {}) {
  const btn = h("button", { class: "btn small ghost explain-btn", type: "button", "aria-expanded": "false" },
    h("span", { class: "explain-ico", "aria-hidden": "true" }, "✦"), opts.label || "Explain this");
  const out = h("div", { class: "tutor-out", "aria-live": "polite", hidden: true });
  const wrap = h("div", { class: "explain" + (opts.compact ? " compact" : "") }, btn, out);
  let state = "idle";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (state === "busy") return;
    if (state === "shown") { out.hidden = true; wrap.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); state = "hidden"; return; }
    if (state === "hidden") { out.hidden = false; wrap.classList.add("open"); btn.setAttribute("aria-expanded", "true"); state = "shown"; return; }
    state = "busy";
    wrap.classList.add("open");
    out.hidden = false;
    out.replaceChildren(h("p", { class: "tutor-wait" }, h("span", { class: "thinking" }, h("i"), h("i"), h("i")), " The tutor is writing a plain-language answer…"));
    btn.setAttribute("aria-busy", "true");
    const grew = () => wrap.dispatchEvent(new CustomEvent("tutor-grew", { bubbles: true }));
    grew();
    try {
      const r = await askTutor(topic, context, opts.key);
      // Inside a term popover the glossary text is already shown: say so instead of repeating it.
      out.replaceChildren(r.fallback && opts.compact
        ? h("p", { class: "tutor-meta" }, "The tutor is offline right now, so the meaning above (from the glossary) is the best answer. Try again in a minute.")
        : answerBox(r));
      state = "shown";
      btn.setAttribute("aria-expanded", "true");
      grew();
    } catch (err) {
      const g = lookup(opts.key || topic);
      out.replaceChildren(h("div", { class: "tutor-answer fallback" },
        h("p", {}, err.status === 429 ? err.message : g ? `${g.short} Why it matters: ${g.why}` : "The tutor could not answer just now. Please try again in a minute."),
        h("p", { class: "tutor-meta" }, err.status === 429 ? "Too many questions for this demo" : "Tutor unreachable: glossary meaning shown")));
      state = err.status === 429 ? "idle" : "shown";
      grew();
    } finally { btn.removeAttribute("aria-busy"); }
  });
  return wrap;
}
