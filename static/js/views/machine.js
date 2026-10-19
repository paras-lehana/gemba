// Machine 360: a live strip (readings every 2 s, like a stock ticker), sensors against alarm and trip limits, health,
// time-to-trip range with the forecast, what waiting to fix it costs, energy, scrap control chart, maintenance history,
// spares and everything Gemba proposed or did for this machine. Written for people who have never seen a factory.
import { api, store, h, num, hours, money, statusChip, localTime } from "../core.js";
import { lineChart, sparkline } from "../charts.js";
import { term, explain } from "../learn.js";

const TZ = { PUN: "Asia/Kolkata", CHK: "Asia/Kolkata", RAY: "Asia/Bangkok" };
const SPARK_N = 60;          // live points kept per reading
const REDRAW_EVERY = 5;      // ticks between chart redraws (every ~10 s)

// What each kind of reading means, in plain words.
const MEANING = {
  vib: "How hard the machine shakes. A worn bearing shakes more, which leaves marks on parts and can stop the machine.",
  temp: "How warm it runs. Friction, a blocked filter or poor cooling make it hotter.",
  amps: "Electric current the motor draws. More current means the motor is working harder.",
  rpm: "How fast the spindle turns, in turns per minute.",
  press: "Air pressure in the pipes. If it drops too low, air tools and clamps across the plant stop working properly.",
  leak: "How much air escapes from a tested part. Higher means the part may leak in the car.",
  kw: "Electricity the machine uses right now, in kilowatts.",
  rate: "Parts finished per hour at this moment.",
};

function clockWithSeconds(epoch, plant) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ[plant] || "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .format(new Date(epoch * 1000));
}
const localHour = (epoch, plant) => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ[plant] || "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(epoch * 1000));
  return +p.find((x) => x.type === "hour").value + +p.find((x) => x.type === "minute").value / 60;
};
/** Hours until tonight's off-peak window (22:00 plant time); 0 when it is already off-peak (22:00-06:00). */
export function hoursToOffPeak(now, plant) {
  const lh = localHour(now, plant);
  if (lh >= 22 || lh < 6) return 0;
  return Math.round((22 - lh) * 4) / 4;
}

const CARD_STATUS = {
  proposed: ["st-watch", "Waiting for a person"], approved: ["st-ok", "Approved"], rejected: ["st-idle", "Rejected"],
  superseded: ["st-idle", "Older duplicate"],
};
const ACTION_WORDS = { repair: "repair", slow: "run slower", fix_leak: "fix the air leak", quarantine_lot: "stop using a material lot",
  recalibrate: "check the sensor", transfer_part: "move a spare part", inspect100: "check every part" };

function cardLine(c) {
  const acts = (c.actions || []).map((a) => `${ACTION_WORDS[a.kind] || a.kind.replace(/_/g, " ")}${a.when_h ? ` in ${hours(a.when_h)}` : " now"}`);
  const why = String(c.why || "").split(/(?<=\.)\s/)[0];
  const s = acts.length ? `Plan: ${acts.join(", then ")}.` : "";
  return `${s} ${why}`.trim().slice(0, 200);
}

export async function render(main, [id]) {
  const page = h("div", { class: "page mx-page" }, h("div", { class: "skeleton", style: "height:300px" }));
  main.append(page);
  let d;
  try { d = await api.get(`/api/machines/${encodeURIComponent(id)}`); }
  catch (e) { page.innerHTML = ""; page.append(h("div", { class: "panel pad" }, h("h2", {}, "Machine not found"), h("p", { class: "dim" }, e.message))); return; }
  const st = d.state, cat = store.machine(st.id), plant = st.plant;
  page.innerHTML = "";
  const sentence = st.status === "sensor" ? `${st.faults[0].label} has been frozen at ${st.faults[0].value} for ${st.faults[0].hours} h. This is the sensor, not the machine: send an instrument technician, not a repair crew.`
    : st.ttf ? `Vibration is rising at a steady speed (+${st.ttf.rise_mm_s_per_day} mm/s per day). At this rate it reaches the trip limit, where the machine stops itself, in ${hours(st.ttf.to_trip_h.p10)} to ${hours(st.ttf.to_trip_h.p90)}.`
    : st.status === "watch" ? `On watch: ${st.reasons.join(", ")}.` : st.status === "idle" ? "Not scheduled to run right now." : "Running normally.";
  const chipBox = h("span", { class: "mx-chip" }, statusChip(st.status));
  page.append(h("div", { class: "page-head" },
    h("div", { class: "grow" }, h("div", { class: "row gap wrap" }, h("a", { href: "#/", class: "small" }, "← Floor"), h("span", { class: "dim small" }, `${cat.plant} · ${store.catalog.lines.find((l) => l.id === cat.line)?.name}`)),
      h("div", { class: "row gap wrap", style: "margin-top:4px" }, h("h1", {}, `${st.id}`), h("span", { class: "dim" }, st.name), chipBox),
      h("p", { style: "margin-top:6px" }, sentence)),
    h("div", { class: "row gap wrap mx-head-actions" },
      h("a", { class: "btn", href: `#/cad/${encodeURIComponent(st.id)}` }, "Open 3D drill-down"),
      h("a", { class: "btn", href: `#/ask?q=${encodeURIComponent(`Why is ${st.id} ${st.status === "ok" ? "running fine" : "flagged"} and what should we do?`)}` }, "Ask Gemba about it"))));

  // ---------------------------------------------------------------- live strip (A)
  const live = liveStrip(st, cat, d, plant);
  page.append(live.el);

  const g = h("div", { class: "gauge-row" });
  const kpi = (l, v, s) => h("div", { class: "kpi" }, h("div", { class: "label" }, l), h("div", { class: "value" }, v), s ? h("div", { class: "sub" }, s) : null);
  const healthVal = h("span", {}, `${st.health}/100`);
  g.append(kpi(term("health_index", "Health"), healthVal,
    `100 = like new, below 60 needs attention. ${st.health_breakdown.map((b) => `${b.key} −${b.penalty}`).join(" · ") || "No deductions."}`));
  for (const [k, r] of Object.entries(st.readings)) g.append(kpi(k === "vib" ? term("vibration", r.label) : r.label, `${num(r.value, r.value < 20 ? 2 : 1)} ${r.unit}`, `normal ${num(r.nominal, r.nominal < 20 ? 1 : 0)} · alarm ${num(r.alarm, r.alarm < 20 ? 1 : 0)} · trip ${num(r.trip, r.trip < 20 ? 1 : 0)}`));
  if (st.zone) g.append(kpi(term("iso_zone", "Vibration zone"), st.zone.zone, `${st.zone.meaning}. A is best, D is damaging.`));
  if (st.anomaly != null) g.append(kpi(term("anomaly_score", "Anomaly score"), num(st.anomaly, 2), st.anomaly > 0.98 ? "Unusual pattern: the readings do not look like this machine's normal days." : "0 to 1. Within this machine's normal patterns."));
  page.append(h("p", { class: "small dim mx-intro" }, "Snapshot when you opened the page: each box is one measurement with its normal value, the alarm level (someone should look) and the trip level (the machine stops itself)."), g);

  const left = h("div", { class: "grid" });
  const right = h("div", { class: "grid", style: "align-content:start" });
  page.append(h("div", { class: "m360", style: "margin-top:16px" }, left, right));

  // ---------------------------------------------------------------- sensor charts (redrawn live)
  const charts = [];
  for (const sp of cat.sensors) {
    const pts = d.series[sp.key] || [];
    const tt = d.state.ttf;
    const lim = (v) => num(v, Math.abs(v) < 20 ? 1 : 0);
    const limits = sp.alarm !== sp.nominal ? [{ v: sp.alarm, cls: "limit-alarm", label: `alarm ${lim(sp.alarm)}` }, { v: sp.trip, cls: "limit-trip", label: `trip ${lim(sp.trip)}` }] : [];
    const body = h("div", { class: "panel-body" });
    const draw = () => {
      const series = [{ pts }];
      if (sp.key === "vib" && d.forecast) series.push({ pts: d.forecast, cls: "forecast" });
      const band = sp.key === "vib" && tt ? { t0: store.tick.now + tt.to_trip_h.p10 * 3600, t1: store.tick.now + tt.to_trip_h.p90 * 3600 } : null;
      body.replaceChildren(lineChart({ series, limits, now: tt ? store.tick.now : null, band, plant, label: `${sp.label} history` }),
        h("p", { class: "small dim mx-intro" }, MEANING[sp.key] || "", sp.alarm < sp.nominal ? " Here lower is worse: the alarm line sits below normal." : ""));
    };
    draw();
    charts.push({ key: sp.key, pts, draw });
    left.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, sp.key === "vib" ? term("vibration", `${sp.label} (${sp.unit})`) : `${sp.label} (${sp.unit})`),
      sp.key === "vib" && d.forecast ? h("span", { class: "right small dim" }, "dashed red: forecast · shaded: likely trip window") : h("span", { class: "right small dim" }, "last 48 h + live")), body));
  }
  const powerBody = h("div", { class: "panel-body" });
  const drawPower = () => powerBody.replaceChildren(lineChart({ series: [{ pts: d.power, color: "var(--ene)" }], plant, ymin: 0, height: 160, label: "power history" }),
    h("p", { class: "small dim mx-intro" }, "Electricity the machine draws. It drops when the machine is stopped or not scheduled, and a worn spindle needs a little more."));
  drawPower();
  charts.push({ key: "kw", pts: d.power, draw: drawPower });
  left.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, "Power (kW)"), h("span", { class: "right small dim" }, `${num(d.energy.kwh_24h)} kWh and ${num(d.energy.co2e_kg_24h)} kg CO2e in 24 h`)), powerBody));
  if (d.spc) {
    const pts = d.spc.points.map((p) => ({ t: p.t, v: p.p * 100 }));
    left.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, "Scrap per hour (%) — ", term("control_chart", "control chart")),
      h("span", { class: "right small" }, d.spc.signal ? h("span", { class: "status st-watch" }, d.spc.signal) : h("span", { class: "status st-ok" }, "in control"))),
      h("div", { class: "panel-body" },
        h("p", { class: "small dim mx-intro" }, "Share of parts thrown away each hour. Points above the dashed upper line are more scrap than normal luck explains: something has changed on the machine."),
        lineChart({ series: [{ pts, color: "var(--qual)" }, { pts: d.spc.points.map((p) => ({ t: p.t, v: p.ucl * 100 })), cls: "limit-alarm" }],
          limits: [{ v: d.spc.centre * 100, cls: "now-line", label: `normal ${num(d.spc.centre * 100, 2)} %` }], plant, ymin: 0, height: 170, label: "scrap control chart" }),
        h("p", { class: "small dim" }, `Last 24 h: ${d.spc.scrap_24h_pct} % scrap · ${Object.entries(d.spc.by_defect_24h).map(([k, v]) => `${k.replace(/_/g, " ")} ${num(v, 0)}`).join(" · ")}`),
        explain("control chart", `${st.id} scrap control chart: ${d.spc.scrap_24h_pct} % scrap in 24 h, signal ${d.spc.signal || "none"}`))));
  }

  // ---------------------------------------------------------------- right column
  if (d.state.ttf) {
    const tt = d.state.ttf.to_trip_h, max = Math.max(tt.p90 * 1.25, 100);
    right.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, term("time_to_trip", "Time to trip limit"))),
      h("div", { class: "panel-body ttf" },
        h("p", { class: "small dim mx-intro" }, "How long until the shaking gets so strong that the machine stops itself to avoid damage. A range, because wear never moves in a perfectly straight line."),
        h("div", { class: "value num", style: "font-size:22px;font-weight:600" }, `${hours(tt.p10)} – ${hours(tt.p90)}`),
        h("div", { class: "ttf-bar", role: "img", "aria-label": `likely between ${hours(tt.p10)} and ${hours(tt.p90)}` },
          h("div", { class: "range", style: `left:${tt.p10 / max * 100}%;width:${(tt.p90 - tt.p10) / max * 100}%` }),
          h("div", { class: "p50", style: `left:${tt.p50 / max * 100}%` })),
        h("p", { class: "small dim" }, `Most likely ${hours(tt.p50)} (${localTime(store.tick.now + tt.p50 * 3600, plant, true)}). Alarm limit in about ${hours(d.state.ttf.to_alarm_h)}. ${d.state.ttf.method}.`),
        explain("time to trip", `${st.id}: trip in ${hours(tt.p10)} to ${hours(tt.p90)}, most likely ${hours(tt.p50)}`))));
  }
  const delay = delayPanel(st, plant);
  right.append(delay.el);
  actionsPanel(right, d);
  const mh = d.maintenance;
  right.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, "Maintenance history"),
    mh.preventive_overdue_days ? h("span", { class: "right status st-watch" }, `PM ${num(mh.preventive_overdue_days)} d overdue`) : null),
    h("p", { class: "small dim mx-intro pad-x" }, "Past jobs on this machine. PM = planned check-up done on a calendar; CM = repair after something broke."),
    h("div", { class: "table-wrap" }, h("table", { class: "data" }, h("thead", {}, h("tr", {}, h("th", {}, "Work order"), h("th", {}, "Type"), h("th", { class: "n" }, "Days ago"), h("th", {}, "Note"))),
      h("tbody", {}, ...mh.work_orders.map((w) => h("tr", {}, h("td", { class: "mono small" }, w.wo), h("td", {}, w.type), h("td", { class: "n" }, num(w.days_ago)), h("td", { class: "small" }, w.note))))))));
  if (d.spares) right.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, `Spare: ${d.spares.name}`)),
    h("div", { class: "panel-body" }, h("p", { class: "small dim mx-intro" }, "The replacement part for this machine, by plant. If the home plant has none, Gemba moves one from another plant."),
      h("dl", { class: "kv" }, ...d.spares.stock.flatMap((r) => [h("dt", {}, r.plant), h("dd", {}, `${r.on_hand} on hand${r.in_transit ? ` + ${r.in_transit} in transit` : ""}${r.transfer_h_to_pune ? ` · ${r.transfer_h_to_pune} h to Pune` : ""}`)])))));
  right.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, "Energy")),
    h("div", { class: "panel-body" }, h("p", { class: "small dim mx-intro" }, "Electricity per good part is the fairest energy number: a machine that makes scrap or runs slowly uses more for each part you can sell."),
      h("dl", { class: "kv" },
        h("dt", {}, "kWh per good part"), h("dd", {}, d.energy.kwh_per_good != null ? `${d.energy.kwh_per_good} (normal ${d.energy.kwh_per_good_baseline})` : "–"),
        h("dt", {}, "Change"), h("dd", {}, d.energy.kwh_per_good_change_pct != null ? `${d.energy.kwh_per_good_change_pct > 0 ? "+" : ""}${d.energy.kwh_per_good_change_pct} %` : "–"),
        h("dt", {}, "Cost, 24 h"), h("dd", {}, money(d.energy.cost_24h))))));
  if (d.inspections.length) right.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, "Recent inspections")),
    h("div", { class: "panel-body grid", style: "gap:6px" }, ...d.inspections.map((i) => h("div", { class: "small" }, `${localTime(i.t, plant)} · ${i.by}: ${i.defect.replace(/_/g, " ")} (${Math.round(i.confidence * 100)} %)`)))));

  // ---------------------------------------------------------------- live updates
  // Each 2-second tick: status and health from the plant stream, readings at this exact second from
  // /api/machines/<id>/live (the stream's sensor values move only once a simulated minute).
  let n = 0, busy = false, gone = false;
  const off = store.on(async (kind) => {
    if (kind !== "tick" || !store.tick || busy || gone) return;
    const tickRow = store.tick.machines.find((m) => m.id === st.id);
    if (!tickRow) return;
    healthVal.textContent = `${tickRow.health}/100`;
    if (tickRow.status !== chipBox.dataset.st) { chipBox.dataset.st = tickRow.status; chipBox.replaceChildren(statusChip(tickRow.status)); }
    let row = tickRow, t = store.tick.now;
    busy = true;
    try { const lv = await api.get(`/api/machines/${encodeURIComponent(st.id)}/live`); row = { ...tickRow, ...lv }; t = lv.now; } catch (e) {}
    busy = false;
    if (gone) return;
    live.update(row, t);
    for (const c of charts) {
      const v = c.key === "kw" ? row.kw : row[c.key];
      if (v == null) continue;
      const last = c.pts[c.pts.length - 1];
      if (!last || t > last.t) c.pts.push({ t, v });
      if (c.pts.length > 2000) c.pts.splice(0, c.pts.length - 2000);
    }
    if (++n % REDRAW_EVERY === 0) for (const c of charts) c.draw();
  });
  chipBox.dataset.st = st.status;
  return () => { gone = true; off(); live.stop(); };
}

// ------------------------------------------------------------------ live strip: one tile per reading, like a stock ticker
function liveStrip(st, cat, d, plant) {
  const specs = [];
  const sensors = cat.sensors.slice(0, 2);
  for (const sp of sensors) specs.push({ key: sp.key, label: sp.label, unit: sp.unit, nominal: sp.nominal, alarm: sp.alarm, trip: sp.trip, d: sp.nominal < 20 ? 2 : 1 });
  specs.push({ key: "kw", label: "Power", unit: "kW", d: 1, higherWorse: true });
  if (cat.cycle_s) specs.push({ key: "rate", label: "Parts per hour", unit: "/h", d: 1, higherBetter: true });
  const tiles = {};
  const row0 = store.live?.(st.id) || {};
  const grid = h("div", { class: "mx-live-grid" });
  for (const s of specs) {
    const hist = (s.key === "kw" ? d.power : d.series[s.key] || []).slice(-SPARK_N).map((p) => ({ t: p.t, v: p.v }));
    const val = h("span", { class: "mx-val num" }, "–");
    const arrow = h("span", { class: "mx-arrow", "aria-hidden": "true" }, "");
    const delta = h("span", { class: "mx-delta num" }, "");
    const spark = h("span", { class: "mx-spark" });
    const note = h("div", { class: "mx-note tiny" }, "");
    const tile = h("div", { class: "mx-tile", title: MEANING[s.key] || "" },
      h("div", { class: "mx-label" }, s.key === "vib" ? term("vibration", s.label) : s.label),
      h("div", { class: "mx-line" }, val, h("span", { class: "mx-unit" }, s.unit), arrow, delta), spark, note);
    tiles[s.key] = { s, hist, val, arrow, delta, spark, note, tile, prev: null };
    grid.append(tile);
  }
  const updated = h("span", { class: "small dim num" }, "waiting for the next reading…");
  const el = h("section", { class: "panel mx-live", "aria-live": "off" },
    h("div", { class: "panel-head" }, h("h3", {}, "Live now"), h("span", { class: "mx-badge" }, h("i", {}), "LIVE"), h("span", { class: "right" }, updated)),
    h("div", { class: "panel-body" },
      h("p", { class: "small dim mx-intro" }, "Fresh readings every 2 seconds, with the small flicker every real sensor has. The arrow shows the direction since the last reading; red means moving towards the alarm limit, green means moving away. The small line is the recent trend."),
      grid));

  function judge(s, v) {
    if (s.alarm == null) return "";
    const low = s.alarm < s.nominal;
    const past = (lim) => (low ? v <= lim : v >= lim);
    if (past(s.trip)) return ["bad", "at the trip limit: the machine stops itself"];
    if (past(s.alarm)) return ["bad", "above the alarm limit: someone should look"];
    const frac = (v - s.nominal) / (s.alarm - s.nominal);
    if (frac > 0.5) return ["warn", `well ${low ? "below" : "above"} normal (${num(s.nominal, s.d > 1 ? 1 : 0)})`];
    return ["ok", `normal range (normal ${num(s.nominal, s.d > 1 ? 1 : 0)}, alarm ${num(s.alarm, s.d > 1 ? 1 : 0)})`];
  }
  function paint(k, v) {
    const T = tiles[k];
    const s = T.s;
    T.val.textContent = num(v, s.d);
    const j = judge(s, v);
    if (j) { T.note.textContent = j[1]; T.note.className = `mx-note tiny mx-${j[0]}`; }
    else if (k === "kw") T.note.textContent = v < 1 ? "switched off or stopped" : "using power";
    else if (k === "rate") T.note.textContent = v < 1 ? "not making parts right now" : `about one part every ${num(3600 / v, 0)} s`;
    T.spark.replaceChildren(T.hist.length > 1 ? sparkline(T.hist, "var(--link)", 140, 28) : "");
  }
  for (const k of Object.keys(tiles)) {
    const v = row0[k] ?? tiles[k].hist[tiles[k].hist.length - 1]?.v;
    if (v != null) { paint(k, v); tiles[k].prev = v; }
  }
  const timers = new Set();
  return {
    el,
    update(row, now) {
      updated.textContent = `updated ${clockWithSeconds(now, plant)} plant time`;
      for (const [k, T] of Object.entries(tiles)) {
        const v = row[k];
        if (v == null) continue;
        T.hist.push({ t: now, v });
        if (T.hist.length > SPARK_N) T.hist.shift();
        paint(k, v);
        const prev = T.prev;
        T.prev = v;
        if (prev == null) continue;
        const dv = v - prev;
        const eps = Math.pow(10, -T.s.d) / 2;
        if (Math.abs(dv) < eps) { T.arrow.textContent = "•"; T.arrow.className = "mx-arrow flat"; T.delta.textContent = "no change"; T.delta.className = "mx-delta tiny dim"; continue; }
        const up = dv > 0;
        const worse = T.s.higherBetter ? !up : T.s.alarm != null && T.s.alarm < T.s.nominal ? !up : up;
        T.arrow.textContent = up ? "▲" : "▼";
        T.arrow.className = `mx-arrow ${worse ? "bad" : "good"}`;
        T.delta.textContent = `${up ? "+" : "−"}${num(Math.abs(dv), T.s.d)}`;
        T.delta.className = `mx-delta num ${worse ? "bad" : "good"}`;
        T.tile.classList.remove("flash-bad", "flash-good");
        void T.tile.offsetWidth;
        T.tile.classList.add(worse ? "flash-bad" : "flash-good");
        const tm = setTimeout(() => { T.tile.classList.remove("flash-bad", "flash-good"); timers.delete(tm); }, 900);
        timers.add(tm);
      }
    },
    stop() { for (const t of timers) clearTimeout(t); },
  };
}

// ------------------------------------------------------------------ cost of delay (B)
function delayPanel(st, plant) {
  const body = h("div", { class: "panel-body" }, h("div", { class: "skeleton", style: "height:120px" }));
  const btns = h("div", { class: "mx-delay-btns", role: "group", "aria-label": "When to fix it" });
  const opts = [["Now", 0], ["+4 h", 4], ["+12 h", 12], ["+24 h", 24], ["+48 h", 48], ["Tonight's off-peak window", "offpeak"]];
  let current = 12, seq = 0;
  const hoursOf = (o) => o === "offpeak" ? hoursToOffPeak(store.tick?.now || Date.now() / 1000, plant) : o;
  for (const [label, o] of opts) {
    const b = h("button", { class: "btn small", type: "button", "data-h": String(o), onclick: () => load(o) }, label);
    btns.append(b);
  }
  const el = h("section", { class: "panel mx-delay" },
    h("div", { class: "panel-head" }, h("h3", {}, "What does waiting cost?")),
    h("div", { class: "panel-body", style: "padding-bottom:0" },
      h("p", { class: "small dim mx-intro" }, "Every fix has a best moment. Fixing now stops the machine during working hours; waiting lets the problem grow. Pick when the fix happens to see what it costs in parts, people and money compared with fixing it now."),
      btns), body);

  async function load(o) {
    current = o;
    for (const b of btns.children) b.classList.toggle("primary", b.dataset.h === String(o));
    const hh = hoursOf(o);
    const my = ++seq;
    body.replaceChildren(h("div", { class: "skeleton", style: "height:120px" }));
    let r;
    try { r = await api.get(`/api/machines/${encodeURIComponent(st.id)}/delay-cost?hours=${hh}`); }
    catch (e) { if (my === seq) body.replaceChildren(h("p", { class: "small dim" }, `Could not work this out right now: ${e.message}`)); return; }
    if (my !== seq) return;
    body.replaceChildren(...view(r, o));
  }

  function view(r, o) {
    if (!r.action) return [h("ul", { class: "mx-ex small" }, ...r.explanations.map((x) => h("li", {}, x)))];
    const wait = r.rows.find((x) => x.key === "wait") || r.rows[0];
    const v = wait.vs_now;
    const when = o === "offpeak" ? (r.hours === 0 ? "It is off-peak now (22:00–06:00), so tonight's window is now." : `Tonight's off-peak window starts at 22:00 plant time, in ${hours(r.hours)}.`) : null;
    const head = h("div", { class: "mx-delay-head" },
      h("div", {}, h("div", { class: "tiny dim" }, r.hours ? `Fix in ${hours(r.hours)} (${r.repair_at_local} plant time) instead of now` : "Fix now"),
        h("div", { class: `mx-big num ${v.total_usd > 0 ? "bad" : "good"}` }, r.hours ? `${v.total_usd > 0 ? "+" : ""}${money(Math.abs(v.total_usd))}` : money(0)),
        h("div", { class: "tiny dim" }, !r.hours ? "the reference: every other choice is compared with this"
          : v.total_usd > 0 ? "extra cost compared with fixing now" : v.total_usd < 0 ? "cheaper than fixing now" : "same as fixing now")),
      h("div", { class: "mx-delay-facts small" },
        h("div", {}, h("b", { class: "num" }, num(Math.max(0, v.good_lost))), " fewer good parts"),
        h("div", {}, h("b", { class: "num" }, num(Math.max(0, v.extra_scrap))), " more scrapped parts"),
        h("div", {}, h("b", { class: "num" }, num(v.extra_kwh)), " kWh extra electricity"),
        h("div", {}, h("b", { class: "num" }, `${num(wait.person_h)} h`), " of people's time")));
    const out = [];
    if (when) out.push(h("p", { class: "small" }, when));
    out.push(head);
    if (r.trip_expected_before_repair) out.push(h("div", { class: "mx-trip small" }, `⚠ Expected to trip after about ${hours(r.trip_h_if_wait)}, before this repair starts. The machine would stop itself without warning and the job becomes an emergency callout.`));
    const cols = ["Choice", "Good parts", "Scrap", "Stopped", "Cost vs now"];
    out.push(h("div", { class: "table-wrap mx-delay-table" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, ...cols.map((c, i) => h("th", { class: i ? "n" : "" }, c)))),
      h("tbody", {}, ...r.rows.map((x) => h("tr", { class: x.key === "wait" ? "mx-sel" : "" },
        h("td", {}, x.label, h("div", { class: "tiny dim", title: x.labour_note }, `labour ${money(x.labour_usd)}`),
          x.trip_h != null && x.key !== "now" ? h("div", { class: "tiny mx-bad" }, `trips at +${hours(x.trip_h)}`) : null),
        h("td", { class: "n" }, num(x.good)), h("td", { class: "n" }, num(x.scrap)), h("td", { class: "n" }, `${num(x.down_h, 1)} h`),
        h("td", { class: `n ${x.vs_now.total_usd > 0 ? "mx-bad" : ""}` }, x.key === "now" ? "–" : `${x.vs_now.total_usd > 0 ? "+" : ""}${money(x.vs_now.total_usd)}`)))))));
    out.push(h("p", { class: "tiny dim" }, `"Do nothing" means no fix at all for the next ${hours(r.horizon_h)}. Next ${r.horizon_h} h for this machine${r.action === "repair" ? " and its line" : ""}. Labour: ${wait.labour_note}.`));
    out.push(h("ul", { class: "mx-ex small" }, ...r.explanations.map((x) => h("li", {}, x))));
    if (r.orders?.length) out.push(h("div", { class: "small" }, h("b", {}, "Customer orders: "),
      ...r.orders.map((x) => h("div", { class: "tiny" }, `${x.so} ${x.customer}: fix now ${x.status_if_now} · ${r.hours ? `wait ${x.status_if_wait} · ` : ""}do nothing ${x.status_if_nothing}`))));
    out.push(h("details", { class: "tiny dim" }, h("summary", {}, "How these numbers are worked out"),
      h("ul", {}, ...r.assumptions.map((x) => h("li", {}, x)), h("li", {}, "The plant simulator runs the next days with and without the fix; the AI does not make these numbers up."))));
    out.push(explain("cost of delay", `${st.id}: ${r.fault}; waiting ${r.hours} h costs ${v.total_usd} USD more than fixing now; trip before repair: ${r.trip_expected_before_repair}`));
    return out;
  }
  load(current);
  return { el };
}

// ------------------------------------------------------------------ Gemba actions (C)
function actionsPanel(right, d) {
  if (!d.cards.length && !d.work_orders.length) return;
  const cards = [...d.cards].sort((a, b) => (b.created || 0) - (a.created || 0));
  const seen = new Map();
  const items = cards.map((c) => {
    const key = `${(c.title || "").toLowerCase().replace(/[^a-z]+/g, " ").trim()}|${(c.actions || []).map((a) => a.kind).join(",")}`;
    const dup = c.status === "superseded" || (seen.has(key) && c.status === "proposed");
    const newer = c.superseded_by || seen.get(key);
    if (!seen.has(key)) seen.set(key, c.id);
    const [cls, word] = dup ? CARD_STATUS.superseded : CARD_STATUS[c.status] || ["st-idle", c.status];
    return h("a", { href: `#/card/${encodeURIComponent(c.id)}`, class: `mx-act${dup ? " mx-dup" : ""}` },
      h("div", { class: "row gap wrap" }, h("span", { class: "mono tiny" }, c.id), h("span", { class: `status ${cls}` }, dup ? "older duplicate" : word),
        dup && newer ? h("span", { class: "tiny dim" }, `newer: ${newer}`) : null),
      h("div", { class: "mx-act-title" }, c.title),
      h("div", { class: "tiny dim" }, dup ? "Gemba proposed the same thing again later; use the newer card." : cardLine(c)));
  });
  const wos = d.work_orders.map((w) => h("a", { href: `#/job/${encodeURIComponent(w.id)}`, class: "mx-act" },
    h("div", { class: "row gap wrap" }, h("span", { class: "mono tiny" }, w.id), h("span", { class: `status ${w.status === "done" || w.status === "Done" ? "st-ok" : "st-repair"}` }, w.status)),
    h("div", { class: "mx-act-title" }, w.title),
    h("div", { class: "tiny dim" }, "A job for the shop floor, created when a person approved the card. Open it to see the steps.")));
  right.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, "Gemba actions")),
    h("div", { class: "panel-body grid", style: "gap:8px" },
      h("p", { class: "small dim mx-intro" }, "What Gemba's AI agents proposed for this machine. Nothing happens until a named person approves a card; an approved card becomes a work order."),
      ...items, wos.length ? h("div", { class: "tiny dim", style: "margin-top:4px" }, "Work orders") : null, ...wos)));
}
