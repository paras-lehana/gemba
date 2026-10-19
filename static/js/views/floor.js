// Floor: the control room. 3D twin of the selected plant with live value labels and a ticker, time travel (3 days back,
// 3 days ahead with or without the approved plan) with a "What changes" comparison, plant KPIs, what needs attention,
// Gemba Watch activity, presenter speed and drills, and the walk button.
import { api, store, h, num, pct, statusChip, STATUS, money, localTime, hours, toast } from "../core.js";
import { createTwin, primaryReading, readingLevel } from "../twin.js";
import { term, explain } from "../learn.js";

const JUMPS = [[-24, "−24 h"], [0, "Now"], [24, "+24 h"], [48, "+48 h"], [72, "+72 h"]];
const DRILLS = {
  bearing_wear_vmc202: { label: "Bearing failure on VMC-202", target: "VMC-202",
    look: "VMC-202's vibration label (mm/s) starts to climb and its light turns from green to amber, then red.",
    why: "A worn spindle bearing makes the machine shake a little more every hour until it trips and stops." },
  air_leak_chk: { label: "Air leak at Chakan", target: "CMP-951",
    look: "Compressor CMP-951 at Chakan draws more power (kW) even when the lines are quiet.",
    why: "Compressed air escaping from the pipes is electricity paid for and blown away, and extra CO2e." },
  sensor_stuck_hob301: { label: "Frozen sensor on HOB-301", target: "HOB-301",
    look: "One HOB-301 reading stops moving completely while the machine keeps working.",
    why: "A stuck sensor is not a broken machine: the right answer is a sensor check, never a repair crew." },
};
const DRILL_STEPS = ["pending", "injected", "detected", "planned"];
const DRILL_WORD = { pending: "Countdown", injected: "Fault started", detected: "Gemba Watch noticed", planned: "Plan card ready" };
const FIX = { repair: ["Repair in progress", "Repaired"], fix_leak: ["Fixing air leaks", "Leak fixed"], recalibrate: ["Checking sensor", "Sensor checked"] };

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const clock = (epoch) => new Intl.DateTimeFormat("en-GB", { timeZone: store.plantInfo()?.tz || "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(epoch * 1000));
const plantOf = (t) => t?.plants?.find((x) => x.id === store.plant);
const msOf = (t) => (t?.machines || []).filter((m) => store.machine(m.id)?.plant === store.plant);
const why = (r) => (r || "").replace(/^stopped:\s*/i, "");

export async function render(main) {
  const page = h("div", { class: "page floor-page" });
  const headline = h("p", { class: "dim" }, "Loading the plant…");
  // ---------------------------------------------------------------- top strip: Google Cloud Run copy and the demo video
  const HOST = window.GEMBA_HOSTING || {};
  page.append(h("div", { class: "cloud-strip", role: "note", "aria-label": "Where Gemba runs" },
    HOST.on_cloud_run
      ? h("span", {}, "☁ ", h("b", {}, "Live on Google Cloud Run"), h("span", { class: "dim" }, " · Gemini on Google Cloud Agent Platform"))
      : HOST.cloud_run_url
        ? h("a", { href: HOST.cloud_run_url, target: "_blank", rel: "noopener" }, "☁ ", h("b", {}, "See us on Google Cloud Run"), h("span", { "aria-hidden": "true" }, " →"))
        : null,
    h("a", { href: "/demo" }, "▶ ", h("b", {}, "Watch the demo video"))));
  page.append(h("div", { class: "page-head" },
    h("div", { class: "grow" }, h("h1", {}, "Plant floor"), headline),
    h("a", { class: "btn walk", href: "#/walk?start=1" }, "✦ Start a Gemba walk")));

  // ---------------------------------------------------------------- "What am I looking at?"
  const intro = h("details", { class: "panel fl-intro" },
    h("summary", {}, h("b", {}, "What am I looking at?"), h("span", { class: "dim small" }, " A 1-minute guide for people new to factories")),
    h("div", { class: "panel-body fl-intro-body" },
      h("p", {}, "This is a live 3D copy of one factory, called a ", term("digital_twin", "digital twin"), ". Each block is a machine. The light on its pole is its state: green running fine, amber watch, red act now, blue sensor fault, grey not scheduled. A very dark machine with a red STOPPED tag has tripped and makes nothing; the parts on its line stand still."),
      h("p", {}, "The number above each machine is its most telling reading right now: ", term("vibration", "vibration"), " in mm/s for machines that cut or spin (healthy is about 1.5, the alarm is at 4.5), air pressure in bar for compressors (it should stay near 7), otherwise the power it draws in ", term("kw", "kW"), ". Like a stock ticker, it flashes green when the reading goes up and red when it goes down. Whether that is good depends on the reading: for vibration, up is bad."),
      h("p", {}, h("b", {}, "Time travel: "), "the plant is simulated, so you can slide back 3 days or forward 3 days. Forward, compare ", h("i", {}, "If we do nothing"), " with ", h("i", {}, "With approved plan"), ". The plan only changes the future after a person approves a card on the ", h("a", { href: "#/walk" }, "Gemba walk"), "."),
      h("p", {}, h("b", {}, "What to judge: "), "do the agents spot the right problem before it stops a machine, does the approved plan really change the future (fewer stops, more good parts, less ", term("co2e", "CO2e"), "), and is a named person always the one who decides?"),
      explain("the plant floor control room", "3D digital twin of a machining plant with live readings, time travel and a plan to approve")));
  intro.open = lsGet("gemba-floor-intro", "closed") === "open";
  intro.addEventListener("toggle", () => lsSet("gemba-floor-intro", intro.open ? "open" : "closed"));
  page.append(intro);

  // ---------------------------------------------------------------- twin + overlay
  const twinBox = h("div", { class: "twin-wrap" });
  const lens = h("div", { class: "lens", role: "group", "aria-label": "Colour machines by" },
    ...[["health", "Health"], ["energy", "Energy"], ["quality", "Quality"]].map(([k, l]) =>
      h("button", { "aria-pressed": String(k === "health"), "data-lens": k }, l)));
  const timeTag = h("span", { class: "chip fl-timetag", hidden: true }, "");
  const liveDot = h("i", { class: "fl-live-dot" }), liveText = h("span", {}, "LIVE");
  const liveInd = h("span", { class: "fl-live", role: "status", "aria-live": "off" }, liveDot, liveText);
  twinBox.append(h("div", { class: "twin-overlay fl-overlay" }, lens, timeTag, liveInd));
  twinBox.append(h("div", { class: "twin-legend", "aria-hidden": "true" },
    ...["ok", "watch", "alarm", "down", "sensor", "repair", "idle"].map((k) => h("span", {}, h("i", { class: "dot", style: `background:var(--${k === "repair" ? "link" : k})` }), STATUS[k]))));

  // ticker strip
  let showValues = lsGet("gemba-live-values", matchMedia("(max-width: 760px)").matches ? "0" : "1") === "1";   // phones start uncluttered
  const valuesBtn = h("button", { class: "btn small ghost fl-values", "aria-pressed": String(showValues), title: "Show the live reading above every machine" },
    h("span", { class: "hide-phone" }, "Show live values"), h("span", { class: "show-phone" }, "Values"));
  const track = h("div", { class: "fl-track" });
  const ticker = h("div", { class: "fl-ticker", "aria-label": "Live readings of every machine in this plant" },
    h("span", { class: "fl-ticker-label tiny" }, "Live readings"), h("div", { class: "fl-viewport" }, track), valuesBtn);

  // ---------------------------------------------------------------- time travel
  const slider = h("input", { type: "range", min: "-72", max: "72", step: "1", value: "0", "aria-label": "Time travel: hours from now", class: "fl-slider" });
  const readout = h("b", { class: "num fl-readout" }, "Live");
  const modeBox = h("div", { class: "lens fl-mode", role: "group", "aria-label": "Future view", hidden: true },
    h("button", { "aria-pressed": "true", "data-mode": "plan" }, "With approved plan"), h("button", { "aria-pressed": "false", "data-mode": "nothing" }, "If we do nothing"));
  const play = h("button", { class: "btn small", title: "Play the next three days" }, "▶ Play 72 h");
  const jumps = h("div", { class: "fl-jumps", role: "group", "aria-label": "Jump in time" },
    ...JUMPS.map(([v, l]) => h("button", { class: "btn small ghost", "data-jump": String(v), "aria-pressed": String(v === 0) }, l)), play);
  const sameNote = h("div", { class: "banner fl-same", hidden: true });
  const travel = h("section", { class: "panel fl-travel" }, h("div", { class: "panel-body grid", style: "gap:10px" },
    h("div", { class: "row gap wrap" }, h("h2", { class: "fl-h" }, "Time travel"), readout, modeBox),
    h("div", { class: "row gap" }, h("span", { class: "tiny dim" }, "−3 days"), slider, h("span", { class: "tiny dim" }, "+3 days")),
    jumps, sameNote,
    h("p", { class: "tiny faint" }, "The twin is a simulation, so it can show the past and the likely future. Ahead of now, choose the approved plan or doing nothing, and read “What changes” below.")));
  const changes = h("section", { class: "panel fl-changes", hidden: true });

  // ---------------------------------------------------------------- presenter demo: speed + drills
  const speedBox = h("div", { class: "lens fl-speed", role: "group", "aria-label": "Simulation speed" },
    ...[1, 10, 60].map((v) => h("button", { "data-speed": String(v), "aria-pressed": String(v === 1) }, `${v}×`)));
  const speedNote = h("span", { class: "tiny dim" }, "1× = real time: the plant moves 2 seconds every 2 seconds.");
  const drillSel = h("select", { class: "fl-select", "aria-label": "Drill to run" },
    ...Object.entries(DRILLS).map(([k, d]) => h("option", { value: k }, d.label)));
  const drillBtn = h("button", { class: "btn primary small" }, "Run a drill (starts in 30 s)");
  const drillList = h("div", { class: "grid fl-drills", style: "gap:10px" });
  const demo = h("section", { class: "panel fl-demo" },
    h("div", { class: "panel-head" }, h("h2", {}, "Live demo: speed and drills"), h("span", { class: "right tiny dim hide-phone" }, "for presenters")),
    h("div", { class: "panel-body grid", style: "gap:10px" },
      h("div", { class: "row gap wrap" }, h("span", { class: "small" }, "Simulation speed"), speedBox, speedNote),
      h("div", { class: "row gap wrap" }, drillSel, drillBtn),
      h("p", { class: "tiny dim" }, "A drill plants a real fault in the simulated plant after a 30-second countdown. Gemba Watch should notice it by itself and call the agents. Tip: switch to 10× or 60× so the fault grows fast enough to see within a minute."),
      drillList));

  const kpis = h("div", { class: "kpis", style: "margin-top:12px" });
  const attention = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Needs attention")), h("div", { class: "skeleton", style: "margin:16px;height:60px" }));
  const planBox = h("div", { class: "panel" });
  const watchBox = h("div", { class: "panel" });
  const linesBox = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Lines today (", term("oee", "OEE"), ")")), h("div", { class: "panel-body" }));
  page.append(h("div", { class: "floor" },
    h("div", { class: "fl-main" }, twinBox, ticker, travel, changes, kpis, demo),
    h("div", { class: "side-stack" }, planBox, attention, watchBox, linesBox)));
  main.append(page);

  let scrap = {};
  const twin = await createTwin(twinBox, { onPick: (id) => (location.hash = `#/machine/${id}`), scrap, showValues });
  lens.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    lens.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (b.dataset.lens === "quality" && !Object.keys(scrap).length) {
      try {
        const q = await api.get("/api/quality");
        for (const r of q.scrap.machines) scrap[r.machine_id] = r.scrap_24h_pct;
        twin.opts.scrap = scrap;
      } catch (err) { console.warn(err); }
    }
    twin.setLens(b.dataset.lens);
  });
  valuesBtn.onclick = () => {
    showValues = !showValues;
    valuesBtn.setAttribute("aria-pressed", String(showValues));
    lsSet("gemba-live-values", showValues ? "1" : "0");
    twin.setShowValues?.(showValues);
  };

  // ---------------------------------------------------------------- ticker
  let tickerIds = [], tickerEls = new Map(), prevVals = new Map();
  function buildTicker() {
    tickerIds = store.catalog.machines.filter((m) => m.plant === store.plant).map((m) => m.id);
    tickerEls = new Map(); prevVals = new Map();
    track.innerHTML = "";
    for (let copy = 0; copy < 2; copy++) {
      for (const id of tickerIds) {
        const v = h("b", { class: "num" }, "–"), a = h("i", { class: "num" }, "");
        const el = h("a", { class: "fl-tk", href: `#/machine/${id}`, tabindex: copy ? "-1" : null, "aria-hidden": copy ? "true" : null },
          h("span", { class: "dot" }), h("span", { class: "fl-tk-id" }, id), v, a);
        track.append(el);
        if (!tickerEls.has(id)) tickerEls.set(id, []);
        tickerEls.get(id).push({ el, v, a });
      }
    }
    track.style.animationDuration = `${Math.max(20, tickerIds.length * 3.2)}s`;
  }
  function updateTicker(t) {
    for (const row of msOf(t)) {
      const pr = primaryReading(store.machine(row.id), row);
      const els = tickerEls.get(row.id);
      if (!els || !pr) continue;
      const prev = prevVals.get(row.id);
      const d = prev == null ? 0 : pr.value - prev;
      prevVals.set(row.id, pr.value);
      const dir = d > 1e-9 ? "up" : d < -1e-9 ? "down" : "flat";
      for (const { el, v, a } of els) {
        el.className = `fl-tk fl-${dir} st-${row.status}`;
        el.dataset.level = readingLevel(pr);
        el.title = `${row.id} · ${pr.label} · ${STATUS[row.status] || row.status}`;
        v.textContent = `${num(pr.value, pr.d)} ${pr.unit}`;
        a.textContent = dir === "up" ? `▲ ${num(Math.abs(d), pr.d)}` : dir === "down" ? `▼ ${num(Math.abs(d), pr.d)}` : "■";
      }
    }
  }
  function blinkLive(t) {
    if (travelData) {
      liveInd.className = "fl-live travel";
      liveText.replaceChildren(offsetH < 0 ? "PAST" : "FORECAST", h("span", { class: "hide-phone" }, offsetH > 0 ? (mode === "plan" ? " with plan" : " if nothing done") : ""), ` · ${localTime(travelData.at, store.plant, true)}`);
      return;
    }
    liveInd.className = "fl-live";
    liveText.replaceChildren("LIVE", h("span", { class: "hide-phone" }, " · updated"), ` ${clock(t.now)}`);
    liveDot.classList.remove("blink"); void liveDot.offsetWidth; liveDot.classList.add("blink");
  }

  // ---------------------------------------------------------------- work orders → marks (Repaired / Repair in progress)
  let wos = [];
  async function loadWos() { try { wos = await api.get("/api/workorders"); } catch (e) { wos = []; } }
  function marksFor(at, md) {
    const marks = {}, now = store.tick?.now || at;
    for (const w of wos) {
      const id = w.machine_id || w.target, f = FIX[w.kind];
      if (!id || !f || w.status === "Cancelled") continue;
      if (md === "nothing" && w.start > now) continue;
      if (at >= w.start && at <= w.end) marks[id] = { cls: "repair", text: f[0] };
      else if (at > w.end && at - w.end < 72 * 3600) marks[id] = { cls: "ok", text: f[1] };
    }
    return marks;
  }

  // ---------------------------------------------------------------- time travel state
  let offsetH = 0, mode = "plan", travelData = null, both = null, seq = 0, timer = null, playing = null;
  async function travelTo(hh) {
    offsetH = hh;
    slider.value = String(hh);
    jumps.querySelectorAll("[data-jump]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.jump === hh)));
    modeBox.hidden = hh <= 0;
    if (hh === 0) { travelData = null; both = null; timeTag.hidden = true; readout.textContent = "Live"; renderChanges(); renderTick(); if (store.tick) blinkLive(store.tick); return; }
    const at = store.tick.now + hh * 3600;
    readout.textContent = `${localTime(at, store.plant, true)} (${hh > 0 ? "+" : "−"}${hours(Math.abs(hh))})`;
    const my = ++seq;
    try {
      const [plan, nothing] = await Promise.all([api.get(`/api/twin?at=${at}&mode=plan`), hh > 0 ? api.get(`/api/twin?at=${at}&mode=nothing`) : null]);
      if (my !== seq) return;
      both = { plan, nothing };
      travelData = hh > 0 && mode === "nothing" ? nothing : plan;
      timeTag.hidden = false;
      timeTag.textContent = hh < 0 ? `Past: ${localTime(at, store.plant, true)}` : mode === "plan" ? "Forecast with the approved plan" : "Forecast if we do nothing";
      timeTag.className = `chip fl-timetag ${hh > 0 ? `mode-${mode}` : "past"}`;
      renderChanges();
      renderTick();
      blinkLive(store.tick);
    } catch (e) { console.warn(e); }
  }
  slider.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => travelTo(+slider.value), 180); });
  jumps.addEventListener("click", (e) => {
    const b = e.target.closest("[data-jump]"); if (!b) return;
    stopPlay(); travelTo(+b.dataset.jump);
  });
  modeBox.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.mode;
    modeBox.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    travelTo(offsetH);
  });
  function stopPlay() { clearInterval(playing); playing = null; play.textContent = "▶ Play 72 h"; }
  play.onclick = () => {
    if (playing) { stopPlay(); return; }
    let hh = offsetH >= 72 ? 0 : Math.max(0, offsetH);
    play.textContent = "❚❚ Pause";
    playing = setInterval(() => { hh += 3; if (hh > 72) { stopPlay(); return; } travelTo(hh); }, 900);
  };

  // ---------------------------------------------------------------- What changes
  function chipFor(row, mark) {
    if (!row) return h("span", { class: "dim" }, "–");
    if (mark) return h("span", { class: `status st-${mark.cls}` }, mark.text);
    return statusChip(row.status);
  }
  function renderChanges() {
    sameNote.hidden = true;
    changes.hidden = !offsetH || !both;
    if (changes.hidden) return;
    const nowT = store.tick, fut = offsetH > 0, at = both.plan.at;
    const when = localTime(at, store.plant, true);
    const cols = fut ? [["Now", nowT], ["With plan", both.plan], ["Do nothing", both.nothing]] : [[`Then (${when})`, both.plan], ["Now", nowT]];
    const pNow = plantOf(nowT);
    const KP = [
      [h("span", {}, term("oee", "OEE"), " (24 h)"), (p) => p.oee, (v) => pct(v, 1), (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)} pts`, 1],
      ["Good parts (24 h)", (p) => p.good_24h, (v) => num(v), (d) => `${d >= 0 ? "+" : "−"}${num(Math.abs(d))}`, 1],
      [h("span", {}, "Power (", term("kw", "kW"), ")"), (p) => p.kw_now, (v) => num(v), (d) => `${d >= 0 ? "+" : "−"}${num(Math.abs(d))}`, 0],
      [h("span", {}, term("co2e", "CO2e"), " kg per hour"), (p) => p.co2e_kg_h, (v) => num(v), (d) => `${d >= 0 ? "+" : "−"}${num(Math.abs(d))}`, 0],
      ["Machines needing action", (p) => p.alerts, (v) => num(v), (d) => `${d >= 0 ? "+" : "−"}${num(Math.abs(d))}`, -1],
    ];
    const tbl = h("table", { class: "data fl-cmp" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), ...cols.map(([l]) => h("th", { class: "n" }, l)))),
      h("tbody", {}, ...KP.map(([label, get, fmt, fd, good]) => h("tr", {}, h("td", {}, label), ...cols.map(([l, t]) => {
        const p = plantOf(t); if (!p) return h("td", { class: "n" }, "–");
        const v = get(p), base = get(pNow), d = v - base;
        const isNow = t === nowT;
        const cls = isNow || Math.abs(d) < 1e-9 || !good ? "dim" : (d * good > 0 ? "fl-good" : "fl-bad");
        return h("td", { class: "n" }, fmt(v), isNow ? null : h("div", { class: `tiny ${cls}` }, Math.abs(d) < 1e-9 ? "same" : fd(d), Math.abs(d) < 1e-9 ? null : h("span", { class: "hide-phone" }, " vs now")));
      })))));

    // machine status changes
    const nowRows = new Map(msOf(nowT).map((m) => [m.id, m]));
    const planRows = new Map(msOf(both.plan).map((m) => [m.id, m]));
    const nothRows = fut ? new Map(msOf(both.nothing).map((m) => [m.id, m])) : null;
    const chosen = fut && mode === "nothing" ? nothRows : planRows;
    const mPlan = marksFor(at, "plan"), mNoth = fut ? marksFor(at, "nothing") : {};
    const mChosen = fut && mode === "nothing" ? mNoth : mPlan;
    const list = h("div", { class: "fl-mlist" });
    let planDiff = 0;
    for (const id of nowRows.keys()) {
      const a = nowRows.get(id), b = chosen.get(id);
      if (!b) continue;
      const markB = mChosen[id];
      const other = fut ? (mode === "nothing" ? planRows.get(id) : nothRows.get(id)) : null;
      const markO = fut ? (mode === "nothing" ? mPlan[id] : mNoth[id]) : null;
      const differs = fut && other && (other.status !== b.status || (markO?.text || "") !== (markB?.text || ""));
      if (differs) planDiff++;
      if (a.status === b.status && !markB && !differs) continue;
      const reason = b.status !== "ok" ? why((b.reasons || [])[0]) : "";
      const [from, to] = fut ? [a, b] : [b, a];
      const [mFrom, mTo] = fut ? [null, markB] : [markB, null];
      list.append(h("a", { class: "fl-mrow", href: `#/machine/${id}` },
        h("b", { class: "num" }, id), h("span", { class: "dim small" }, fut ? "now" : "then"), chipFor(from, mFrom), h("span", { class: "fl-arrow" }, "→"),
        h("span", { class: "dim small" }, fut ? "then" : "now"), chipFor(to, mTo),
        reason && fut ? h("span", { class: "small dim" }, `(${reason})`) : null,
        differs ? h("span", { class: "small fl-other" }, `${mode === "nothing" ? "With the plan" : "If we do nothing"}: `, chipFor(other, markO)) : null));
    }
    if (!list.children.length) list.append(h("p", { class: "small dim" }, "No machine changes state between now and then. Readings drift a little, but nothing crosses a limit."));
    const kpiSame = fut && ["oee", "good_24h", "kw_now", "co2e_kg_h"].every((k) => plantOf(both.plan)?.[k] === plantOf(both.nothing)?.[k]);
    if (fut && !planDiff && kpiSame) {
      sameNote.hidden = false;
      sameNote.innerHTML = "";
      sameNote.append(wos.length
        ? h("span", {}, "At this moment both futures look the same: the approved actions do not change this plant at this time. Try a later time or another plant.")
        : h("span", {}, h("b", {}, "No plan card has been approved yet, "), "so “With approved plan” and “If we do nothing” show the same future. Approve a card on the ", h("a", { href: "#/walk" }, "Gemba walk"), ", then come back: the plan line changes."));
    }
    changes.innerHTML = "";
    changes.append(
      h("div", { class: "panel-head" }, h("h2", {}, "What changes"), h("span", { class: "right dim small" }, fut ? `now → ${when}` : `${when} → now`)),
      h("div", { class: "panel-body grid", style: "gap:12px" },
        h("p", { class: "small dim" }, fut
          ? `The simulator runs the plant ${hours(offsetH)} ahead. “With plan” includes every approved card; “Do nothing” leaves out anything not started yet.`
          : `How the plant looked ${hours(-offsetH)} ago compared with now.`),
        h("div", { class: "table-wrap" }, tbl),
        h("h3", {}, "Machines that change state"), list));
  }

  // ---------------------------------------------------------------- speed + drills
  async function setSpeed(v) {
    try {
      const r = await api.post("/api/presenter/speed", { speed: v });
      const sp = r?.speed ?? v;
      markSpeed(sp);
      toast(sp === 1 ? "Back to real time." : `The plant now runs ${sp}× faster: every second on screen is ${sp} seconds in the factory.`);
    } catch (e) { toast(`Could not change the speed: ${e.message}`, "err"); }
  }
  function markSpeed(sp) {
    speedBox.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.speed === sp)));
    speedNote.textContent = sp === 1 ? "1× = real time: the plant moves 2 seconds every 2 seconds." : `${sp}× = each 2-second update moves the plant ${num(2 * sp)} seconds (${sp === 60 ? "one minute = one hour" : "one minute = ten minutes"}).`;
  }
  speedBox.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSpeed(+b.dataset.speed); });
  const localDue = {};
  drillBtn.onclick = async () => {
    const sc = drillSel.value;
    drillBtn.disabled = true;
    try {
      const r = await api.post("/api/presenter/drill", { scenario: sc, delay_s: 30 });
      localDue[sc] = Date.now() / 1000 + (r?.due_in_s ?? 30);
      toast(`Drill armed: ${r?.label || DRILLS[sc].label}. It starts in ${r?.due_in_s ?? 30} s. Watch ${DRILLS[sc].target}.`);
      const plant = store.machine(DRILLS[sc].target)?.plant;
      if (plant && plant !== store.plant) document.querySelector(`.plants button[data-plant="${plant}"]`)?.click();
      if (offsetH) { stopPlay(); travelTo(0); }
    } catch (e) { toast(`Could not start the drill: ${e.message}`, "err"); }
    finally { setTimeout(() => (drillBtn.disabled = false), 1500); renderDrills(); }
  };
  let drillTargets = [], planIds = [];
  function applyHighlight() { twin.setHighlight([...new Set([...planIds, ...drillTargets])]); }
  function renderDrills() {
    const drills = (store.tick?.session?.drills || []).slice().reverse().slice(0, 3);
    const targets = drills.filter((d) => d.status !== "planned").map((d) => DRILLS[d.scenario]?.target).filter(Boolean);
    if (targets.join() !== drillTargets.join()) { drillTargets = targets; applyHighlight(); }
    drillList.innerHTML = "";
    for (const d of drills) {
      const info = DRILLS[d.scenario] || { label: d.label || d.scenario, target: "", look: "", why: "" };
      const step = Math.max(0, DRILL_STEPS.indexOf(d.status));
      const nowWall = Date.now() / 1000;
      const ref = localDue[d.scenario] ? null : Math.abs(d.due_at - nowWall) < Math.abs(d.due_at - (store.tick?.now || 0)) ? nowWall : store.tick?.now;
      const left = Math.max(0, Math.round(localDue[d.scenario] ? localDue[d.scenario] - nowWall : d.due_at - ref));
      const plant = store.machine(info.target)?.plant, pName = store.plantInfo(plant)?.name;
      const text = {
        pending: `In ${left} s the fault starts inside the simulated ${info.target}. Nothing looks wrong yet, and that is the point: watch ${info.target} on the twin and in the ticker.`,
        injected: `The fault has started. ${info.look} Gemba Watch checks every reading on each update and should notice it by itself.`,
        detected: "Gemba Watch noticed the change and called only the agents that can help. They are reading the data and writing a card now.",
        planned: "The agents posted a plan card. A person now decides: open the Gemba walk to read it and approve or reject it.",
      }[d.status] || "";
      drillList.append(h("div", { class: `fl-drill s-${d.status}` },
        h("div", { class: "row gap wrap" }, h("b", {}, d.label || info.label),
          h("span", { class: `right status ${d.status === "planned" ? "st-ok" : d.status === "pending" ? "st-idle" : "st-watch"}` },
            d.status === "pending" ? `Starts in ${left} s` : DRILL_WORD[d.status] || d.status)),
        h("ol", { class: "fl-steps" }, ...DRILL_STEPS.map((s, i) => h("li", { class: i < step ? "done" : i === step ? "on" : "" }, DRILL_WORD[s]))),
        h("div", { class: "bar" }, h("i", { style: `width:${d.status === "pending" ? Math.max(4, (1 - left / 30) * 25) : ((step + 1) / 4) * 100}%;background:${d.status === "planned" ? "var(--ok)" : "var(--watch)"}` })),
        h("p", { class: "small" }, text),
        info.why ? h("p", { class: "tiny dim" }, `Why it matters: ${info.why}`) : null,
        h("div", { class: "row gap wrap" },
          d.status === "planned" ? h("a", { class: "btn small primary", href: "#/walk" }, "Open the Gemba walk") : null,
          info.target ? h("a", { class: "btn small ghost", href: `#/machine/${info.target}` }, `See ${info.target}`) : null,
          plant && plant !== store.plant ? h("button", { class: "btn small ghost", onclick: () => document.querySelector(`.plants button[data-plant="${plant}"]`)?.click() }, `Show ${pName || plant}`) : null)));
    }
    if (!drills.length) drillList.append(h("p", { class: "tiny faint" }, "No drill running."));
  }

  // ---------------------------------------------------------------- side panels
  let lines = [];
  async function loadSlow() {
    try {
      const [ln, latest] = await Promise.all([api.get("/api/lines"), api.get("/api/walk/latest")]);
      lines = ln;
      renderLines();
      renderPlan(latest.walk);
    } catch (e) { console.warn(e); }
  }

  function renderPlan(walk) {
    planBox.innerHTML = "";
    const plan = walk?.plan;
    if (!plan) {
      planBox.append(h("div", { class: "hero-call" },
        h("h2", {}, "Send the agents on a walk"),
        h("p", {}, "Five Gemini agents (Reliability, Quality, Supply, Energy, Flow) look at every machine, order and kilowatt, find the problems that cross departments, and hand you one plan to approve."),
        h("div", { class: "row gap wrap" }, ...["reliability", "quality", "supply", "energy", "flow"].map((a) => h("span", { class: `chip agent-chip ag-${a}` }, a))),
        h("a", { class: "btn primary", href: "#/walk?start=1" }, "Start the walk (about 45 s)")));
      planIds = []; applyHighlight();
      return;
    }
    const open = plan.cards.filter((c) => c.status === "proposed").length;
    planBox.append(h("div", { class: "panel-head" }, h("h2", {}, "Latest plan"), h("span", { class: "right dim small" }, `${plan.cards.length} cards · ${open} waiting`)),
      h("div", { class: "panel-body grid", style: "gap:10px" },
        h("p", {}, plan.headline),
        plan.impact ? h("p", { class: "small dim" }, `If approved: ${money(plan.impact.delta.money)} over 4 days, ${num(-plan.impact.delta.down_h, 0)} fewer machine-hours down, ${num(-plan.impact.delta.co2e_kg, 0)} kg CO2e less.`) : null,
        h("a", { class: "btn", href: "#/walk" }, open ? `Review ${open} card${open > 1 ? "s" : ""}` : "Open the plan")));
    planIds = plan.cards.map((c) => c.machine_id).filter(Boolean); applyHighlight();
  }

  function renderWatch() {
    const evs = (store.watch || []).slice().reverse();
    watchBox.innerHTML = "";
    watchBox.append(h("div", { class: "panel-head" }, h("h2", {}, "Gemba Watch"), h("span", { class: "right dim small" }, "agents act on new signals")));
    const body = h("div", { class: "panel-body grid", style: "gap:8px" });
    if (!evs.length) body.append(h("p", { class: "small dim" }, "Quiet. When a new problem appears (a machine starts to wear, a sensor freezes, a compressor starts to leak), the right agents start by themselves and post new cards. Try it: “Run a drill” under the twin."));
    for (const ev of evs.slice(0, 5)) body.append(h("a", { href: "#/walk", class: "small", style: "text-decoration:none;color:inherit" },
      h("span", { class: `status ${ev.kind === "plan" ? "st-ok" : "st-repair"}` }, ev.kind === "plan" ? "cards ready" : "investigating"), " ",
      h("span", { class: "dim" }, localTime(ev.t, store.plant)), " · ", ev.text));
    watchBox.append(body);
  }

  function renderLines() {
    const body = linesBox.querySelector(".panel-body");
    body.innerHTML = "";
    for (const l of lines.filter((x) => x.plant === store.plant)) {
      const d = l.oee - (l.oee_week_ago ?? l.oee);
      body.append(h("div", { style: "margin-bottom:10px" },
        h("div", { class: "row", style: "justify-content:space-between;font-size:14px" }, h("span", {}, l.name),
          h("span", { class: "num" }, pct(l.oee), h("span", { class: `small ${d < -0.01 ? "delta-bad-down" : "dim"}` }, ` ${d >= 0 ? "▲" : "▼"} ${Math.abs(d * 100).toFixed(1)}`))),
        h("div", { class: "bar" }, h("i", { style: `width:${(l.oee * 100).toFixed(1)}%;background:${l.oee < 0.65 ? "var(--alarm)" : l.oee < 0.7 ? "var(--watch)" : "var(--ok)"}` })),
        h("div", { class: "tiny dim" }, `A ${pct(l.availability)} · P ${pct(l.performance)} · Q ${pct(l.quality, 1)} · biggest loss: ${l.biggest_loss}`)));
    }
    if (body.children.length) body.append(h("p", { class: "tiny faint" }, "OEE = availability (was it running?) × performance (at full speed?) × quality (were the parts good?). 85 % is world class; ▲▼ compares with a week ago."));
    else body.append(h("p", { class: "dim small" }, "No production lines at this plant."));
  }

  function renderTick() {
    const t = travelData || store.tick;
    if (!t) return;
    const at = travelData ? travelData.at : store.tick.now;
    twin.update(t, { marks: marksFor(at, travelData && offsetH > 0 ? mode : "plan"), live: !travelData });
    const p = plantOf(t);
    if (!p) return;
    const ms = msOf(t);
    const bad = ms.filter((m) => ["alarm", "down", "sensor"].includes(m.status)), watch = ms.filter((m) => m.status === "watch");
    const stopped = ms.filter((m) => m.status === "down");
    const when = travelData ? (offsetH < 0 ? `On ${localTime(travelData.at, store.plant, true)}` : `Forecast for ${localTime(travelData.at, store.plant, true)} ${mode === "plan" ? "with the approved plan" : "if nothing is done"}`) : p.name;
    headline.textContent = bad.length || watch.length
      ? `${when}: ${stopped.length ? `${stopped.map((m) => m.id).join(", ")} stopped, ` : ""}${bad.length ? `${bad.length} machine${bad.length > 1 ? "s need" : " needs"} action` : "no machine needs action"}${watch.length ? `, ${watch.length} on watch` : ""}. Click a machine for details.`
      : `${when}: every machine is running normally.`;
    kpis.innerHTML = "";
    const items = [
      [h("span", {}, "Plant ", term("oee", "OEE"), " (24 h)"), pct(p.oee, 1), p.oee >= 0.85 ? "world class (85 % +)" : p.oee >= 0.7 ? "typical; 85 % is world class" : "low: time, speed or good parts are being lost"],
      ["Good parts (24 h)", num(p.good_24h), "parts that passed inspection, all lines"],
      [h("span", {}, "Power (", term("kw", "kW"), ")"), `${num(p.kw_now)} kW`, "electricity the whole plant draws right now"],
      [h("span", {}, term("co2e", "CO2e"), " per hour"), `${num(p.co2e_kg_h)} kg`, "greenhouse gas from that electricity"],
      ["Machines needing action", String(p.alerts), `${p.watch} on watch`],
    ];
    for (const [l, v, s] of items) kpis.append(h("div", { class: "kpi" }, h("div", { class: "label" }, l), h("div", { class: "value" }, v), h("div", { class: "sub" }, s)));
    attention.innerHTML = "";
    attention.append(h("div", { class: "panel-head" }, h("h2", {}, "Needs attention"), h("span", { class: "right dim small" }, travelData ? when : `${store.plantInfo()?.name}`)));
    const full = (id) => (travelData ? travelData.machines : store.state?.machines || []).find((x) => x.id === id);
    const rows = [...ms.filter((m) => m.status === "repair"), ...bad, ...watch];
    if (!rows.length) attention.append(h("p", { class: "empty" }, "Nothing needs attention here."));
    for (const m of rows) {
      const cat = store.machine(m.id);
      const reasons = full(m.id)?.reasons || [];
      attention.append(h("a", { class: "alert-row", href: `#/machine/${m.id}` },
        h("div", { class: "grow" }, h("div", { class: "row gap" }, h("b", {}, m.id), statusChip(m.status)),
          h("div", { class: "small dim" }, `${cat.name}${reasons.length ? ` · ${reasons.join(", ")}` : ""}`)),
        h("span", { class: "num small dim" }, `health ${m.health}`)));
    }
  }

  async function refreshState() {
    try { store.state = await api.get("/api/state"); } catch (e) {}
    renderTick();
  }

  function onLiveTick() {
    const t = store.tick;
    if (!t) return;
    updateTicker(t);
    blinkLive(t);
    if (t.session?.speed != null) markSpeed(t.session.speed);
    renderDrills();
    if (!travelData) renderTick();
    else if (!changes.hidden) renderChanges();
  }

  const off = store.on((kind) => {
    if (kind === "tick") onLiveTick();
    if (kind === "plant") { twin.setPlant(store.plant); buildTicker(); if (offsetH) travelTo(offsetH); renderTick(); renderLines(); }
    if (kind === "theme") twin.retheme();
    if (kind === "watch") renderWatch();
    if (kind === "changed") { refreshState(); loadSlow(); loadWos().then(() => { if (offsetH) travelTo(offsetH); else renderTick(); }); }
  });
  buildTicker();
  await Promise.all([refreshState(), loadWos()]);
  if (store.tick) { updateTicker(store.tick); blinkLive(store.tick); markSpeed(store.tick.session?.speed ?? 1); }
  renderDrills();
  renderWatch();
  loadSlow();
  const slow = setInterval(() => { refreshState(); loadWos(); }, 30000);
  const countdown = setInterval(() => { if ((store.tick?.session?.drills || []).some((d) => d.status === "pending")) renderDrills(); }, 1000);
  return () => { off(); clearInterval(slow); clearInterval(countdown); stopPlay(); twin.dispose(); };
}
