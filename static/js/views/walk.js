// Gemba walk: five agents look at the same plant at the same time (real tool calls), then the Lead links their findings
// into one plan of cards. The card renderer, impact table and decision bar are exported for the card detail view.
import { api, store, h, AGENTS, agentChip, money, num, hours, localTime, toast, rememberedName, rememberName, glow, stream, apiUrl } from "../core.js";
import { term } from "../learn.js";

export const SPECIALISTS = ["reliability", "quality", "supply", "energy", "flow"];
export const TOOL_LABEL = {
  plant_overview: "Plant overview", machine_condition: "Machine condition", maintenance_history: "Maintenance history",
  spare_parts: "Spare parts", technicians: "Technicians", scrap_overview: "Scrap by machine", scrap_control_chart: "Scrap control chart",
  inspect_part_photo: "Inspect part photo (Gemini vision)", material_lots: "Material lots", order_book: "Order book",
  demand_forecast: "Demand forecast", what_if: "What-if on the simulator", energy_ranking: "Energy per good part",
  night_base_load: "Night-time base load", tariff_windows: "Tariff windows", line_oee: "Line OEE", line_machines: "Line machines",
  query_sql: "SQL query", compressor_baseline: "Compressor energy baseline",
};
// What each lens asks, in plain words, and what it reads (shown in the lanes while they wait).
export const LENS = {
  reliability: { theme: "reliability", ask: "Is any machine wearing out or about to break down?", reads: "vibration, temperature, maintenance history and spare parts" },
  quality: { theme: "quality", ask: "Are we making bad parts, and why?", reads: "scrap counts, control charts, part photos and material lots" },
  supply: { theme: "supply & demand", ask: "Will every customer order ship complete and on time?", reads: "the order book, the demand forecast and stock in each plant" },
  energy: { theme: "sustainability", ask: "Where is electricity (and CO2) wasted?", reads: "energy per good part, night-time load and tariff hours" },
  flow: { theme: "efficiency", ask: "Are the production lines running at full speed?", reads: "line OEE (running time × speed × good parts) and slow machines" },
  lead: { theme: "one plan", ask: "How do the findings connect, and what is the one plan?", reads: "the five findings, then tests each choice on the plant simulator" },
};
const SIM_KINDS = ["slow", "repair", "fix_leak", "quarantine_lot", "recalibrate"];
// What each action means and who usually does it (cards may name their own owner).
export const ACTION_INFO = {
  transfer_part: { label: "Send the spare part", who: "Stores and logistics", means: "Move the spare part by truck from the plant that has it, so it is on the shelf when the repair starts." },
  repair: { label: "Planned repair", who: "Maintenance crew", means: "Stop the machine for about 4 hours and replace the worn part, at a chosen quiet time, instead of waiting for it to break down by itself." },
  slow: { label: "Run slower", who: "Line supervisor", means: "Lower the machine's speed: less vibration and fewer bad parts, but fewer parts per hour." },
  fix_leak: { label: "Fix the air leak", who: "Utilities engineer", means: "Find and seal leaks in the compressed-air pipes, so the compressor stops running to refill air that escapes." },
  quarantine_lot: { label: "Quarantine the lot", who: "Quality inspector", means: "Set aside a batch of raw material so nobody uses it, and switch to the next good batch." },
  recalibrate: { label: "Check the sensor", who: "Instrument technician", means: "Check the sensor and recalibrate it. The machine itself is fine, so no repair crew is sent." },
};
const STATUS_TXT = { proposed: "Waiting for a decision", approved: "Approved", rejected: "Rejected", superseded: "Older duplicate" };
const STATUS_CLS = { proposed: "watch", approved: "ok", rejected: "idle", superseded: "idle" };
const REPAIR_H = 4;

export const simNow = (c) => store.tick?.now || c?.created || Date.now() / 1000;
export const plantOf = (t) => store.machine(t)?.plant || (["PUN", "CHK", "RAY"].includes(t) ? t : store.plant);
const plantName = (p) => store.plantInfo(p)?.name || p;
const lineName = (id) => store.catalog?.lines?.find((l) => l.id === id)?.name || id;
const kindLabel = (k) => ACTION_INFO[k]?.label || k.replace(/_/g, " ");
export const statusBadge = (c) => h("span", { class: `status st-${STATUS_CLS[c.status] || "idle"}` }, STATUS_TXT[c.status] || c.status);

// "Starts Sun 22:30 · in 23 h" for an action `whenH` hours from now.
export function whenText(whenH, target, c) {
  if (!whenH) return "Starts now";
  return `Starts ${localTime(simNow(c) + whenH * 3600, plantOf(target), true)} · in ${hours(whenH)}`;
}

export function actText(a, c) {
  const when = a.when_h ? `${localTime(simNow(c) + a.when_h * 3600, plantOf(a.target), true)}, in ${hours(a.when_h)}` : "now";
  switch (a.kind) {
    case "transfer_part": return `Send spare part ${a.part_no || ""} from ${plantName(a.from_plant || "?")} to ${plantName(a.target)} · ${when}`;
    case "repair": return `Planned repair of ${a.target} (${REPAIR_H} h stop) · ${when}`;
    case "slow": return `Run ${a.target} at ${Math.round((a.value || 0.85) * 100)} % speed · ${when}`;
    case "fix_leak": return `Fix the compressed-air leaks on ${a.target} · ${when}`;
    case "quarantine_lot": return `Quarantine material lot ${a.target} · ${when}`;
    case "recalibrate": return `Check / recalibrate the sensor on ${a.target} · ${when}`;
    default: return `${a.kind.replace(/_/g, " ")}: ${a.target}${a.note ? ` (${a.note})` : ""} · ${when}`;
  }
}

// Plant · machine · line line shown at the top of every card.
export function metaLine(c) {
  const m = store.machine(c.machine_id);
  const bits = [];
  if (m) bits.push(plantName(m.plant), `${m.id} · ${m.name}`, lineName(m.line));
  else if (c.machine_id) bits.push(c.machine_id);
  return h("div", { class: "gc-meta" }, ...bits.map((b, i) => h("span", { class: i === 1 ? "gc-machine" : "" }, b)));
}

// ------------------------------------------------------------------ impact table (shared with the card view)
const METRICS = [
  { k: "good", label: "Good parts", term: "good_parts", fmt: (v) => num(v), up: true, info: "Parts that pass inspection and can be sold. Higher is better." },
  { k: "scrap", label: "Scrap parts", term: "scrap", fmt: (v) => num(v), up: false, info: "Parts thrown away because they failed inspection. Lower is better." },
  { k: "down_h", label: "Machine-hours down", term: "downtime", fmt: (v) => num(v, 0), up: false, info: "Hours machines stand still (planned repairs plus breakdowns), added up. Lower is better." },
  { k: "kwh_per_good", label: "kWh per good part", term: "kwh_per_good", fmt: (v) => num(v, 2), up: false, info: "Electricity used for each sellable part. Lower means less waste." },
  { k: "kwh", label: "Energy used (kWh)", term: "kwh", fmt: (v) => num(v), up: false, info: "Electricity in kilowatt-hours. Lower is better." },
  { k: "co2e_kg", label: "CO2e (kg)", term: "co2e", fmt: (v) => num(v), up: false, info: "Greenhouse gas from that electricity, in kg of CO2 equivalent. Lower is better." },
  { k: "money", label: "Net value", term: "net_value", fmt: (v) => money(v), up: true, info: "Margin on good parts minus the cost of scrap minus the energy bill. Higher is better." },
];
const differs = (a, b, k) => a != null && b != null && Math.abs(a - b) > (k === "kwh_per_good" ? 0.005 : 0.5);
const tm = (key, label) => { try { return term(key, label); } catch (e) { return h("span", {}, label); } };

// imp = {do_nothing, plan, orders, trip_h, assumptions, horizon_h}; prev = the impact before the last timing change.
export function impactTable(imp, prev = null, { colLabel = "With this card" } = {}) {
  const wrap = h("div", { class: "imp" });
  if (!imp) { wrap.append(h("p", { class: "tiny faint" }, "A logistics or communication step: the simulator has nothing to measure for it.")); return wrap; }
  const dn = imp.do_nothing, pl = imp.plan;
  const shown = METRICS.filter((m) => differs(dn[m.k], pl[m.k], m.k) || (prev && differs(dn[m.k], prev.plan?.[m.k], m.k)))
    .filter((m, _, arr) => !(m.k === "kwh" && arr.some((x) => x.k === "kwh_per_good")));
  if (!shown.length) {
    wrap.append(h("p", { class: "small dim" }, "No change in parts, downtime or energy over the next 4 days: this card fixes trust in the data, or its effect is outside what the simulator measures."));
  } else {
    const tbl = h("div", { class: "imp-table", role: "table", "aria-label": "Impact over the next 4 days" },
      h("div", { class: "imp-row imp-h", role: "row" }, h("span", { role: "columnheader" }, `Next ${Math.round((imp.horizon_h || 96) / 24)} days`),
        h("span", { class: "n", role: "columnheader" }, "Do nothing"), h("span", { class: "n", role: "columnheader" }, colLabel)));
    for (const m of shown) {
      const a = dn[m.k], b = pl[m.k], better = m.up ? b > a : b < a, worse = differs(a, b, m.k) && !better;
      const old = prev?.plan?.[m.k];
      const moved = prev && differs(old, b, m.k);
      const cell = h("span", { class: `n v ${differs(a, b, m.k) ? (better ? "better" : "worse") : ""} ${moved ? "moved" : ""}`, role: "cell" }, m.fmt(b));
      if (moved) cell.append(h("small", { class: (m.up ? b > old : b < old) ? "up-good" : "up-bad" }, `${b > old ? "↑" : "↓"} was ${m.fmt(old)}`));
      else if (differs(a, b, m.k)) cell.append(h("small", {}, `${b > a ? "+" : "−"}${m.fmt(Math.abs(b - a)).replace(/^[−-]/, "")}`));
      tbl.append(h("div", { class: `imp-row ${worse ? "is-worse" : ""}`, role: "row" },
        h("span", { class: "lbl", role: "rowheader" }, tm(m.term, m.label)), h("span", { class: "n", role: "cell" }, m.fmt(a)), cell,
        h("span", { class: "info", role: "note" }, m.k === "money" && imp.assumptions ? `${m.info} Assumes ${imp.assumptions}.` : m.info)));
    }
    wrap.append(tbl);
  }
  for (const o of imp.orders || []) if (o.cover_do_nothing !== o.cover_plan) {
    wrap.append(h("div", { class: "imp-note" }, h("b", {}, `Order ${o.so}`), ` (${o.customer}, ${num(o.qty)} parts): `,
      `${Math.round(o.cover_do_nothing * 100)} % → ${Math.round(o.cover_plan * 100)} % `, tm("cover", "covered"),
      h("span", { class: "tiny dim" }, ` · parts we will have ÷ parts ordered; 100 % or more means it ships complete`)));
  }
  for (const [mid, tr] of Object.entries(imp.trip_h || {})) if (tr.do_nothing != null) {
    wrap.append(h("div", { class: "imp-note" }, `If nothing is done, ${mid} is expected to `, tm("trip", "trip"), ` (stop by itself) in about ${hours(tr.do_nothing)}`,
      tr.plan == null ? "; this card prevents that." : `; with this timing it still trips in about ${hours(tr.plan)}.`));
  }
  return wrap;
}

// Plain sentence: what the card changes compared with doing nothing (built from the numbers, not by a model).
export function whyCard(imp, c) {
  if (!imp) return null;
  const d = (k) => (imp.plan[k] ?? 0) - (imp.do_nothing[k] ?? 0);
  const bits = [];
  if (Math.abs(d("good")) >= 1) bits.push(`${num(Math.abs(d("good")))} ${d("good") > 0 ? "more" : "fewer"} good parts`);
  if (Math.abs(d("scrap")) >= 1) bits.push(`${num(Math.abs(d("scrap")))} ${d("scrap") < 0 ? "fewer" : "more"} scrap parts`);
  if (Math.abs(d("down_h")) >= 0.5) bits.push(`${num(Math.abs(d("down_h")), 0)} ${d("down_h") < 0 ? "fewer" : "more"} machine-hours down`);
  if (Math.abs(d("kwh")) >= 1 && imp.plan.kwh_per_good == null) bits.push(`${num(Math.abs(d("kwh")))} kWh ${d("kwh") < 0 ? "less" : "more"} electricity`);
  if (!bits.length && Math.abs(d("money")) < 1) return h("p", { class: "imp-why" }, h("b", {}, "What this card changes: "), "nothing you can count in parts or energy; it keeps people from acting on a wrong reading.");
  let s = `Compared with doing nothing: ${bits.join(", ") || "the same output"}`;
  if (Math.abs(d("money")) >= 1) s += `, so net value is ${d("money") > 0 ? "higher" : "lower"} by ${money(Math.abs(d("money")))}`;
  s += ".";
  if (d("kwh") > 0 && d("kwh_per_good") < 0) s += " Total electricity and CO2e rise a little because the machine keeps making parts instead of standing broken; per good part they fall.";
  const trip = Object.entries(imp.trip_h || {}).find(([, t]) => t.do_nothing != null && t.plan == null);
  if (trip) s += ` Without it, ${trip[0]} breaks down by itself in about ${hours(trip[1].do_nothing)} and stands still until it is fixed.`;
  return h("p", { class: "imp-why" }, h("b", {}, "What this card changes: "), s);
}

// Plain sentence: why the numbers moved when a person changed the timing of action `a` from `oldW` to `newW` hours.
export function whyChange(a, oldW, newW, base, cur, c) {
  const p0 = base?.plan || {}, p1 = cur.plan || {};
  const ch = (k, fmt = (v) => num(v)) => differs(p0[k], p1[k], k) ? `${fmt(p0[k])} → ${fmt(p1[k])}` : null;
  const diffH = Math.abs(newW - oldW), earlier = newW < oldW;
  const moved = `Moving the ${kindLabel(a.kind).toLowerCase()} ${earlier ? "earlier" : "later"} by ${hours(diffH)} (to ${localTime(simNow(c) + newW * 3600, plantOf(a.target), true)})`;
  const parts = [];
  const tr = cur.trip_h?.[a.target];
  if (Math.abs(newW - oldW) < 0.25) return "Back at the proposed time: the numbers are the card's original answer.";
  if (a.kind === "repair") {
    if (tr?.plan != null && tr.plan < newW) {
      parts.push(`${moved}: the simulator expects ${a.target} to trip (break down by itself) in about ${hours(tr.plan)}, before the repair would start, so it stands still unplanned`);
      if (ch("down_h", (v) => num(v, 0))) parts.push(`machine-hours down go ${ch("down_h", (v) => num(v, 0))}`);
    } else {
      parts.push(`${moved}: the worn part runs ${hours(diffH)} ${earlier ? "less" : "longer"}, so it makes ${earlier ? "fewer" : "more"} bad parts`);
      if (ch("scrap")) parts.push(`scrap ${ch("scrap")}`);
      if (earlier) parts.push("and there is still no unplanned stop");
    }
  } else if (a.kind === "fix_leak") {
    parts.push(`${moved}: the leak wastes compressed air for ${hours(diffH)} ${earlier ? "less" : "more"}`);
    if (ch("kwh")) parts.push(`electricity ${ch("kwh")} kWh`);
  } else if (a.kind === "quarantine_lot") {
    parts.push(`${moved}: ${earlier ? "fewer" : "more"} parts are made from the bad material before it is set aside`);
    if (ch("scrap")) parts.push(`scrap ${ch("scrap")}`);
  } else if (a.kind === "slow") {
    parts.push(`${moved}: the machine runs at full speed for ${hours(diffH)} ${earlier ? "less" : "more"}`);
    if (ch("scrap")) parts.push(`scrap ${ch("scrap")}`);
    if (ch("good")) parts.push(`good parts ${ch("good")}`);
  } else if (a.kind === "recalibrate") {
    return `${moved}: a sensor check does not change how many parts are made, so the numbers stay the same; it only makes the reading trustworthy sooner or later.`;
  } else parts.push(moved);
  if (ch("good") && a.kind !== "slow") parts.push(`good parts ${ch("good")}`);
  if (ch("money", money)) parts.push(`net value ${ch("money", money)}`);
  if (parts.length === 1) parts.push("the simulator sees no change in the totals at this timing");
  return `${parts.join("; ")}.`;
}

// Impact table + "what this changes" + timing sliders. Calls c._when for the approval.
export function impactBlock(c, { retime = true, why = true } = {}) {
  const box = h("div", { class: "imp-block" });
  const tableBox = h("div");
  const whyBox = h("div");
  const draw = (imp, prev) => {
    const mine = Object.entries(c._when || {}).some(([i, v]) => Math.abs(v - (c.actions[i]?.when_h || 0)) >= 0.5);
    tableBox.replaceChildren(impactTable(imp, prev, { colLabel: mine ? "With your timing" : "With this card" }));
    if (why) whyBox.replaceChildren(whyCard(imp, c) || "");
  };
  draw(c.impact);
  box.append(tableBox, whyBox);
  c._when = c._when || {};
  const timed = c.actions.map((a, i) => [a, i]).filter(([a]) => SIM_KINDS.includes(a.kind));
  if (!(retime && c.status === "proposed" && timed.length && c.impact)) return box;
  const det = h("details", { class: "retime" }, h("summary", {}, "Adjust timing and see the effect"));
  det.append(h("p", { class: "tiny dim" }, "Drag a step to another time. The plant simulator re-runs the next 4 days and the table above updates (changed numbers show ↑/↓ and the old value)."));
  const status = h("div", { class: "rt-why", "aria-live": "polite" });
  let last = c.impact, seq = 0;
  for (const [a, i] of timed) {
    const id = `rt-${c.id}-${i}`;
    const orig = a.when_h || 0;
    const out = h("div", { class: "rt-out" });
    const showOut = (v) => out.replaceChildren(...[h("b", {}, whenText(v, a.target, c)),
      Math.abs(v - orig) >= 0.5 ? h("span", { class: "tiny dim" }, ` · proposed ${whenText(orig, a.target, c).replace("Starts ", "").replace(/ · .*/, "")}`) : null].filter(Boolean));
    showOut(orig);
    const r = h("input", { type: "range", id, min: "0", max: "72", step: "1", value: String(Math.round(orig)), "aria-label": `Start of ${kindLabel(a.kind)} on ${a.target}, hours from now` });
    const reset = h("button", { class: "btn small ghost", type: "button", hidden: true }, "Back to the proposed time");
    let tmrR = null;
    const run = () => {
      clearTimeout(tmrR);
      showOut(+r.value);
      reset.hidden = Math.abs(+r.value - orig) < 0.5;
      status.replaceChildren(h("span", { class: "dim" }, "Re-running the simulator…"));
      tmrR = setTimeout(async () => {
        const my = ++seq;
        c._when[i] = +r.value;
        const acts = c.actions.map((x, j) => ({ ...x, when_h: c._when[j] ?? x.when_h })).filter((x) => SIM_KINDS.includes(x.kind));
        try {
          const res = await api.post("/api/whatif", { actions: acts, horizon_h: c.impact.horizon_h || 96 });
          if (my !== seq) return;
          const tp = c.actions.find((x) => x.kind === "transfer_part");
          const eta = tp ? 9 + (c._when[c.actions.indexOf(tp)] ?? tp.when_h ?? 0) : 0;
          const tr = res.trip_h?.[a.target];
          let warn = null;
          if (a.kind === "repair" && tp && +r.value < eta) warn = `The spare part arrives in about ${eta} h; approval will be refused for an earlier start.`;
          else if (tr && tr.plan != null && tr.plan < +r.value) warn = "The machine is likely to break down before this repair starts.";
          draw(res, last);
          last = res;
          status.replaceChildren(...[h("p", {}, h("b", {}, "Why this changes: "), whyChange(a, orig, +r.value, c.impact, res, c)),
            warn ? h("div", { class: "guard warn" }, "⚠ ", warn) : null].filter(Boolean));
        } catch (e) { toast(e.message, "err"); status.replaceChildren(); }
      }, 280);
    };
    r.addEventListener("input", run);
    reset.onclick = () => { r.value = String(Math.round(orig)); run(); };
    det.append(h("div", { class: "rt-row" },
      h("label", { for: id }, h("b", {}, kindLabel(a.kind)), ` · ${a.target}`), r,
      h("div", { class: "rt-scale tiny faint", "aria-hidden": "true" }, h("span", {}, "now"), h("span", {}, "+1 day"), h("span", {}, "+2 days"), h("span", {}, "+3 days")),
      out, reset));
  }
  det.append(status);
  box.append(det);
  return box;
}

// Name + Approve / Reject (or the decision stamp). onChange(card, result) runs after a decision.
export function decisionBar(c, onChange) {
  const foot = h("div", { class: "gcard-foot" });
  if (c.status === "approved") {
    foot.append(h("span", { class: "stamp", style: "color:var(--ok)" }, `✓ Approved by ${c.approved_by} at ${localTime(c.approved_at, plantOf(c.machine_id), true)}`),
      h("a", { class: "btn small right", href: "#/work" }, "Work orders"));
    return foot;
  }
  if (c.status === "rejected") { foot.append(h("span", { class: "stamp dim" }, `Rejected by ${c.rejected_by}: ${c.reject_reason}`)); return foot; }
  if (c.status === "superseded") {
    foot.append(h("span", { class: "stamp dim" }, "A newer walk proposed the same fix."),
      c.superseded_by ? h("a", { class: "btn small right", href: `#/card/${encodeURIComponent(c.superseded_by)}` }, `See ${c.superseded_by}`) : null);
    return foot;
  }
  const name = h("input", { type: "text", placeholder: "Your name", value: rememberedName(), "aria-label": `Your name to approve ${c.title}` });
  const ok = h("button", { class: "btn ok", type: "button" }, "Approve");
  const no = h("button", { class: "btn ghost small", type: "button" }, "Reject");
  foot.append(h("span", { class: "tiny dim", style: "width:100%" }, `Owner: ${c.owner}${c.confidence != null ? ` · agent confidence ${Math.round(c.confidence * 100)} %` : ""} · nothing happens in the plant until a named person approves.`),
    name, ok, no);
  ok.onclick = async () => {
    if (name.value.trim().length < 2) { toast("Type your name: every approval is recorded with a person's name.", "err"); glow(name); return; }
    ok.disabled = true;
    try {
      const r = await api.post(`/api/cards/${encodeURIComponent(c.id)}/approve`, { name: name.value.trim(), when_h: c._when || {} });
      rememberName(name.value.trim());
      Object.assign(c, r.card);
      onChange?.(c, r);
      toast(`Approved${r.card.edits?.length ? " with your timing changes" : ""}. ${r.work_orders.length} work order${r.work_orders.length > 1 ? "s" : ""} created; the twin now follows the plan.`, "ok", 6000, { href: "#/", label: "See it on the twin" });
      store.emit("changed");
      import("../focas.js").then((m) => m.dispatch && m.dispatch(c)).catch(() => {});
    } catch (e) { toast(e.message, "err"); ok.disabled = false; }
  };
  no.onclick = async () => {
    if (name.value.trim().length < 2) { toast("Type your name first.", "err"); glow(name); return; }
    const reason = prompt("Why do you reject this card? (helps the agents next time)");
    if (!reason) return;
    try { const r = await api.post(`/api/cards/${encodeURIComponent(c.id)}/reject`, { name: name.value.trim(), note: reason }); Object.assign(c, r.card); onChange?.(c, r); }
    catch (e) { toast(e.message, "err"); }
  };
  return foot;
}

// One Gemba card as shown on the walk page.
export function cardEl(c) {
  const el = h("article", { class: `gcard ${c.status}`, id: `card-${c.id}`, "data-card": c.id });
  el.append(h("div", { class: "gcard-strip", "aria-hidden": "true" }, ...c.pillars.map((p) => h("i", { class: `ag-${p}` }))));
  const info = h("div", { class: "gc-info" },
    metaLine(c),
    h("div", { class: "row gap wrap gc-depts" }, h("span", { class: "tiny dim" }, "Departments:"), ...c.pillars.map(agentChip), h("span", { class: "chip right" }, c.urgency)),
    h("h3", {}, h("a", { href: `#/card/${encodeURIComponent(c.id)}`, class: "gc-title" }, c.title)),
    h("p", { class: "why" }, c.why),
    h("ul", { class: "acts" }, ...c.actions.map((a) => h("li", {}, h("span", {}, actText(a, c), h("span", { class: "tiny faint" }, ` · ${ACTION_INFO[a.kind]?.who || c.owner}`))))),
    ...(c.guardrails || []).map((g) => h("div", { class: "guard" }, "⛨ ", g)),
    h("a", { class: "tiny gc-more", href: `#/card/${encodeURIComponent(c.id)}` }, "Evidence, timeline and work orders →"));
  const body = h("div", { class: "gcard-body" }, info, impactBlock(c));
  el.append(body, decisionBar(c, (cc) => el.replaceWith(cardEl(cc))));
  return el;
}

// Which cards belong to the main problem: the card whose departments carry the most Lead links (then the most departments).
export function mainGroup(plan) {
  const cards = plan.cards || [];
  if (!cards.length) return { main: [], other: [] };
  const score = (c) => (plan.links || []).filter((l) => c.pillars.includes(l.from) || c.pillars.includes(l.to)).length * 10 + c.pillars.length;
  const lead = cards.find((c) => c.machine_id === "VMC-204" && /VMC-204/.test(plan.headline + plan.story)) ||
    [...cards].sort((a, b) => score(b) - score(a))[0] || cards[0];
  const m = store.machine(lead.machine_id);
  // A card with no machine is never "the same" as another (it used to put every card in the main group).
  const same = (c) => c === lead || (!!c.machine_id && (c.machine_id === lead.machine_id || (m && store.machine(c.machine_id)?.line === m.line)));
  return { lead, main: cards.filter(same), other: cards.filter((c) => !same(c)) };
}

// ------------------------------------------------------------------ the page
export async function render(main, params, query) {
  const focusId = query?.get("card") || null;
  const page = h("div", { class: "page walk-page" });
  const startBtn = h("button", { class: "btn walk" }, "✦ Start a Gemba walk");
  const progress = h("div", { class: "walk-progress", "aria-hidden": "true" }, h("i"));
  const timer = h("span", { class: "num dim small" }, "");
  const stats = h("span", { class: "dim small" }, "");
  page.append(h("div", { class: "page-head" },
    h("div", { class: "grow" }, h("h1", {}, "Gemba walk"),
      h("p", {}, "In lean manufacturing, managers \"go to the gemba\" (the real place) to see problems first-hand. Here Gemini agents walk every plant using real tools, and a Lead agent writes one plan. Nothing changes until a person approves a card.")),
    startBtn));
  page.append(lensIntro());
  const notice = h("div");
  page.append(notice, h("div", { class: "row gap2 wrap walk-meter" }, progress, timer, stats));
  const lanes = h("div", { class: "lanes walk-lanes" });
  const laneEls = {};
  const laneOf = (a, extra = "") => {
    const st = h("span", { class: "lane-state" }, "waiting");
    const body = h("div", { class: "lane-body" });
    // Lanes have a capped height (so five columns end level); keep the newest tool call in view unless the reader scrolled up.
    let pinned = true;
    body.addEventListener("scroll", () => { pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 40; }, { passive: true });
    new MutationObserver(() => { if (pinned) body.scrollTop = body.scrollHeight; }).observe(body, { childList: true });
    const lane = h("section", { class: `lane ag-${a} ${extra}`, "aria-label": `${AGENTS[a].name} agent` },
      h("div", { class: "lane-head" }, h("span", { "aria-hidden": "true", class: "lane-ico" }, AGENTS[a].ico), h("h3", {}, AGENTS[a].name), st),
      h("p", { class: "lane-ask" }, h("b", {}, LENS[a].ask), h("span", {}, ` It reads ${LENS[a].reads}.`)), body);
    laneEls[a] = { lane, body, st, calls: {} };
    return lane;
  };
  for (const a of SPECIALISTS) lanes.append(laneOf(a));
  const lead = laneOf("lead", "lead-band");
  const planBox = h("div", { class: "plan-box" });
  page.append(lanes, lead, planBox);
  main.append(page);

  let es = null, tmr = null, t0 = 0, done = 0, nAgents = 5, focused = false;

  function reset() {
    for (const a of [...SPECIALISTS, "lead"]) { laneEls[a].body.innerHTML = ""; laneEls[a].st.textContent = "waiting"; laneEls[a].calls = {}; laneEls[a].lane.classList.remove("is-done", "is-off"); }
    for (const a of SPECIALISTS) laneEls[a].lane.querySelector(".finding")?.remove();
    planBox.innerHTML = ""; done = 0; setProgress(0); notice.innerHTML = "";
  }
  const setProgress = (f) => (progress.firstElementChild.style.width = `${Math.round(f * 100)}%`);
  const thinking = () => h("span", { class: "thinking", "aria-label": "working" }, h("i"), h("i"), h("i"));

  function onEvent(ev) {
    const a = ev.agent;
    const L = laneEls[a];
    switch (ev.kind) {
      case "walk_start":
        stats.textContent = ev.recorded ? `Recorded run · ${ev.recorded.model || "Gemini"}` : `${ev.provider?.label || ""} · ${ev.provider?.models?.agent || ""}`;
        nAgents = (ev.agents || SPECIALISTS).length;
        for (const x of SPECIALISTS) {
          const off = !(ev.agents || SPECIALISTS).includes(x);
          laneEls[x].lane.classList.toggle("is-off", off);
          if (off) { laneEls[x].st.textContent = "not needed"; laneEls[x].body.replaceChildren(h("p", { class: "tiny dim" }, "Not needed for this signal.")); }
        }
        if (ev.focus) notice.replaceChildren(h("div", { class: "banner info" }, h("b", {}, "Gemba Watch"),
          h("span", {}, `noticed a new signal and called only the agents it needs: ${ev.focus.signal}`)));
        if (ev.recorded) notice.replaceChildren(h("div", { class: "banner info" }, h("b", {}, "Replay"),
          h("span", {}, `This is a recorded live Gemini walk from ${new Date(ev.recorded.saved_at * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}, replayed because the model is not reachable right now. The cards' numbers are recomputed on your plant now, and you can approve them.`)));
        break;
      case "agent_start":
        L?.st.replaceChildren(thinking());
        break;
      case "tool_call": {
        if (!L) break;
        const res = h("div", { class: "res" }, thinking());
        const args = Object.entries(ev.args || {}).filter(([k]) => k !== "sql").map(([k, v]) => typeof v === "object" ? `${k}: …` : `${v}`).join(", ");
        const el = h("div", { class: "ev" }, h("span", { class: "i" }, "→"),
          h("div", {}, h("code", {}, TOOL_LABEL[ev.name] || ev.name), args ? h("span", { class: "dim" }, ` ${args}`) : null,
            ev.name === "query_sql" ? h("div", { class: "tiny faint mono ev-sql" }, ev.args.sql) : null, res));
        L.body.append(el);
        L.calls[ev.call_id] = { el, res };
        break;
      }
      case "tool_result": {
        const c = L?.calls[ev.call_id];
        if (c) { c.res.textContent = `✓ ${ev.summary}`; if (ev.error) c.el.classList.add("err"); }
        break;
      }
      case "image": {
        const c = L?.calls[ev.call_id];
        if (!c) break;
        const wrap = h("div", { class: "inspect-view", style: "margin-top:6px" }, h("img", { src: apiUrl(ev.url), alt: `Part photo, ${ev.label || ""}`, loading: "lazy" }));
        for (const b of ev.boxes || []) {
          const [y0, x0, y1, x1] = b.box_2d;
          wrap.append(h("div", { class: "box", style: `top:${y0 / 10}%;left:${x0 / 10}%;width:${(x1 - x0) / 10}%;height:${(y1 - y0) / 10}%` }, h("span", {}, b.label)));
        }
        c.el.lastElementChild.append(wrap);
        break;
      }
      case "note":
        if (L && ev.text) L.body.append(h("div", { class: "ev" }, h("span", { class: "i" }, "“"), h("div", { class: "res" }, ev.text.slice(0, 220))));
        break;
      case "agent_error":
        if (L) L.body.append(h("div", { class: "ev err" }, h("span", { class: "i" }, "!"), h("div", { class: "res" }, `Model problem: ${ev.error}. Using the rules engine for this agent.`)));
        break;
      case "finding": {
        const f = ev.finding;
        if (!L) break;
        L.st.textContent = f.fallback ? "rules fallback" : `done · ${(f.took_ms / 1000).toFixed(0)} s`;
        L.lane.classList.add("is-done");
        L.lane.append(findingEl(f));
        done += 1; setProgress(done / (nAgents + 2));
        break;
      }
      case "linking":
        laneEls.lead.st.replaceChildren(thinking());
        laneEls.lead.body.append(h("div", { class: "ev" }, h("span", { class: "i" }, "✦"), h("div", {}, "Linking findings across departments…")));
        setProgress((nAgents + 1) / (nAgents + 2));
        break;
      case "plan":
        laneEls.lead.st.textContent = ev.plan.fallback ? "rules fallback" : `done · ${(ev.plan.took_ms / 1000).toFixed(0)} s`;
        laneEls.lead.lane.classList.add("is-done");
        renderPlan(ev.plan);
        setProgress(1);
        break;
      case "walk_error":
        toast(`The walk stopped: ${ev.error}`, "err");
        break;
      case "walk_end":
        clearInterval(tmr);
        timer.textContent = `${(ev.took_ms / 1000).toFixed(0)} s`;
        if (ev.stats) stats.textContent += ` · ${ev.stats.llm_calls} model calls · ${ev.stats.tool_calls} tool calls${ev.stats.fallbacks ? ` · ${ev.stats.fallbacks} fallbacks` : ""}`;
        startBtn.disabled = false; startBtn.textContent = "✦ Walk again";
        healthBanner();
        break;
    }
  }

  function follow(id) {
    es?.close();
    reset();
    t0 = Date.now();
    clearInterval(tmr);
    tmr = setInterval(() => (timer.textContent = `${Math.round((Date.now() - t0) / 1000)} s`), 500);
    startBtn.disabled = true; startBtn.textContent = "Walking…";
    es = stream(`/api/walk/${id}/events`);
    es.addEventListener("walk", (e) => onEvent(JSON.parse(e.data)));
    es.addEventListener("done", () => { es.close(); startBtn.disabled = false; startBtn.textContent = "✦ Walk again"; clearInterval(tmr); store.emit("changed"); });
    es.onerror = () => { /* the browser reconnects; the server replays from the start */ };
  }

  async function start() {
    try { const r = await api.post("/api/walk"); follow(r.walk_id); }
    catch (e) { toast(`Could not start the walk: ${e.message}`, "err"); }
  }
  startBtn.onclick = start;

  // ---------------------------------------------------------------- plan
  async function renderPlan(plan) {
    planBox.innerHTML = "";
    const imp = plan.impact;
    const head = h("div", { class: "panel" }, h("div", { class: "plan-head" },
      h("div", { class: "row gap wrap" }, agentChip("lead"), h("span", { class: "chip" }, plan.fallback ? "rules fallback" : plan.model)),
      h("h2", {}, plan.headline), h("p", { class: "dim" }, plan.story),
      plan.links?.length ? linkSection(plan.links) : null,
      imp ? h("div", { class: "plan-imp" }, h("h3", { class: "small" }, "The whole plan, compared with doing nothing (next 4 days)"), impactStrip(imp),
        h("p", { class: "tiny dim" }, "Net value = margin on good parts minus the cost of scrap minus the energy bill. Green means better than doing nothing.")) : null,
      plan.tradeoffs ? h("p", { class: "small dim" }, h("b", {}, "Trade-off: "), plan.tradeoffs) : null,
      h("p", { class: "tiny faint" }, `Impact is computed by the plant simulator over ${imp?.horizon_h || 96} h, not by the language model${imp?.assumptions ? ` (${imp.assumptions})` : ""}.`)));
    planBox.append(head);
    const live = (plan.cards || []).filter((c) => c.status !== "superseded");
    const { lead: leadCard, main: mainCards, other } = mainGroup({ ...plan, cards: live });
    if (mainCards.length) {
      const m = store.machine(leadCard.machine_id);
      planBox.append(h("section", { class: "card-group" },
        h("div", { class: "group-head" }, h("h2", {}, "Main problem"),
          h("p", { class: "small dim" }, `${m ? `${m.id} on the ${lineName(m.line)}, ${plantName(m.plant)}: t` : leadCard.machine_id ? `${leadCard.machine_id}: t` : "T"}he problem most of the agents' findings point to. Approve these cards to fix the root cause.`)),
        h("div", { class: `cards ${mainCards.length === 1 ? "solo" : ""}` }, ...mainCards.map(cardEl))));
    }
    if (other.length) {
      planBox.append(h("section", { class: "card-group" },
        h("div", { class: "group-head" }, h("h2", {}, `Also found on this walk (${other.length})`),
          h("p", { class: "small dim" }, "These are separate problems in other areas that the agents spotted on the same walk. They are not part of the main problem; each card can be approved or rejected on its own.")),
        h("div", { class: "cards" }, ...other.map(cardEl))));
    }
    await laterCards(plan);
    if (focusId && !focused) focusCard(focusId);
  }

  async function laterCards(plan) {
    const ids = new Set((plan?.cards || []).map((c) => c.id));
    const all = await api.get("/api/cards").catch(() => []);
    const waiting = all.filter((c) => c.status === "proposed" && !ids.has(c.id));
    const dups = all.filter((c) => c.status === "superseded");
    if (waiting.length) planBox.append(h("section", { class: "card-group" },
      h("div", { class: "group-head" }, h("h2", {}, `Still waiting from earlier walks (${waiting.length})`),
        h("p", { class: "small dim" }, "Cards from an earlier walk that nobody has decided on yet.")),
      h("div", { class: "cards" }, ...waiting.map(cardEl))));
    if (dups.length) planBox.append(h("details", { class: "dups" },
      h("summary", {}, `Older duplicates (${dups.length})`),
      h("p", { class: "tiny dim" }, "A newer walk proposed the same fix again, so these older copies were replaced and cannot be approved."),
      h("div", { class: "cards" }, ...dups.map(cardEl))));
  }

  function focusCard(id) {
    const el = planBox.querySelector(`[data-card="${CSS.escape(id)}"]`);
    if (!el) return;
    focused = true;
    const d = el.closest("details"); if (d) d.open = true;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("is-focus");
    setTimeout(() => el.classList.remove("is-focus"), 4000);
  }

  function healthBanner() {
    const hl = store.health;
    if (!hl || hl.llm.available || startBtn.disabled) return;
    const kids = [h("b", {}, "Gemini is not reachable right now."),
      h("span", { class: "small" }, "The agents will run on Gemba's rules engine (clearly labelled)."),
      h("button", { class: "btn small", onclick: start }, "Run with the rules engine")];
    if (hl.recording) kids.splice(2, 0, h("button", { class: "btn small primary", onclick: async () => {
      try { const r = await api.post("/api/walk/replay"); follow(r.walk_id); } catch (e) { toast(e.message, "err"); }
    } }, "Watch a recorded Gemini walk"));
    notice.replaceChildren(h("div", { class: "banner" }, ...kids));
  }
  const offH = store.on((k) => { if (k === "health") healthBanner(); });

  // ---------------------------------------------------------------- initial state
  const latest = await api.get("/api/walk/latest").catch(() => ({ walk: null }));
  if (query?.get("start")) {
    history.replaceState(null, "", "#/walk");
    if (latest.walk?.status === "running") follow(latest.walk.id);
    else if (store.health && !store.health.llm.available && store.health.recording) healthBanner();
    else start();
  } else if (latest.walk) {
    if (latest.walk.status === "running") follow(latest.walk.id);
    else {
      const evs = latest.walk.events || [];
      for (const ev of evs) if (ev.kind !== "plan") onEvent(ev);
      // cards may have been approved or replaced since: refresh their status
      const cards = await api.get("/api/cards").catch(() => []);
      if (latest.walk.plan) {
        const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
        latest.walk.plan.cards = latest.walk.plan.cards.map((c) => byId[c.id] || c);
        laneEls.lead.st.textContent = latest.walk.plan.fallback ? "rules fallback" : "done";
        laneEls.lead.lane.classList.add("is-done");
        setProgress(1);
        await renderPlan(latest.walk.plan);
      }
    }
  } else {
    await laterCards(null);
    if (focusId) focusCard(focusId);
  }
  healthBanner();
  return () => { es?.close(); clearInterval(tmr); offH(); };
}

// "Five lenses, not five steps" explainer at the top of the page.
function lensIntro() {
  return h("section", { class: "panel lens-intro", "aria-label": "How to read this page" },
    h("div", { class: "lens-text" },
      h("h2", {}, "Five lenses on one plant, not five steps"),
      h("p", { class: "small" }, "The five agents look at the same plant at the same time, each through one lens: the five words of the competition theme. They do not wait for each other."),
      h("p", { class: "small" }, h("b", {}, "Why this order? "), "It follows how one problem spreads on a real shop floor, like falling dominoes: a worn machine part (", h("b", {}, "Reliability"), ", the cause) makes bad parts (", h("b", {}, "Quality"), "), fewer good parts put a customer order at risk (", h("b", {}, "Supply"), "), the struggling machine wastes electricity (", h("b", {}, "Energy"), "), and the whole line produces less (", h("b", {}, "Flow"), ", the final effect). Reading left to right tells that story; the agents still work in parallel."),
      h("ol", { class: "lens-steps small" },
        h("li", {}, h("b", {}, "Look. "), "Five agents check the plant at once, each asking its own question."),
        h("li", {}, h("b", {}, "Link. "), "The Gemba Lead connects findings that share a cause (for example, scrap in Quality caused by a worn bearing in Reliability)."),
        h("li", {}, h("b", {}, "Decide. "), "The Lead writes one plan of cards; a person approves or rejects each card."))),
    h("div", { class: "lens-chips", "aria-label": "The five lenses" },
      h("div", { class: "tiny dim lens-cap" }, "Theme word → the agent that looks through it"),
      ...SPECIALISTS.map((a) => h("div", { class: `lens ag-${a}` }, h("span", { class: "lens-ico", "aria-hidden": "true" }, AGENTS[a].ico),
        h("span", { class: "lens-w" }, h("b", {}, LENS[a].theme), h("span", { class: "tiny dim" }, `${AGENTS[a].name} agent`))))));
}

function findingEl(f) {
  const sev = f.severity === "critical" || f.severity === "high" ? "alarm" : f.severity === "medium" ? "watch" : "ok";
  return h("div", { class: "finding" }, h("b", {}, f.headline),
    h("span", { class: `status st-${sev}` }, f.severity),
    h("ul", {}, ...(f.observations || []).slice(0, 4).map((o) => h("li", {}, o.fact, h("span", { class: "faint" }, ` · ${TOOL_LABEL[o.source] || o.source}`)))),
    f.suspected_links?.length ? h("div", { class: "tiny dim", style: "margin-top:6px" }, "Suspects a link with: ", ...f.suspected_links.map((l) => agentChip(l.agent))) : null);
}

function linkSection(links) {
  return h("div", { class: "link-sec" },
    h("div", { class: "link-graph" }, linkGraph(links)),
    h("div", { class: "link-text" },
      h("h3", { class: "small" }, "How the findings connect"),
      h("p", { class: "small dim" }, h("b", {}, "An arrow from A to B"), " means: a problem that A found is caused by, or affects, what B found. The grey dotted lines show every agent reporting to the Gemba Lead in the centre."),
      h("ul", { class: "link-list" }, ...links.map((l) => h("li", {}, agentChip(l.from), h("span", { "aria-label": "links to" }, "→"), agentChip(l.to), h("span", { class: "small" }, l.why))))));
}

export function linkGraph(links) {
  const NS = "http://www.w3.org/2000/svg", W = 360, H = 230, R = 88, cx = W / 2, cy = H / 2 + 6;
  const pos = {};
  SPECIALISTS.forEach((a, i) => { const ang = -Math.PI / 2 + i * 2 * Math.PI / 5; pos[a] = [cx + R * 1.35 * Math.cos(ang), cy + R * Math.sin(ang)]; });
  const el = (t, at) => { const e = document.createElementNS(NS, t); for (const [k, v] of Object.entries(at)) e.setAttribute(k, v); return e; };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": "Graph: arrows show which agents' findings are linked" });
  const defs = el("defs", {});
  const mk = el("marker", { id: "walk-arr", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
  mk.append(el("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--lead)" })); defs.append(mk); svg.append(defs);
  for (const a of SPECIALISTS) svg.append(el("line", { x1: cx, y1: cy, x2: pos[a][0], y2: pos[a][1], stroke: "var(--border-2)", "stroke-dasharray": "3 4" }));
  for (const l of links) {
    if (!pos[l.from] || !pos[l.to]) continue;
    const [x1, y1] = pos[l.from], [x2, y2] = pos[l.to];
    const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1, k = 24 / d;
    const line = el("path", { d: `M${x1 + dx * k},${y1 + dy * k} Q${cx},${cy} ${x2 - dx * k},${y2 - dy * k}`, fill: "none", stroke: "var(--lead)", "stroke-width": "2", "marker-end": "url(#walk-arr)" });
    const title = el("title", {}); title.textContent = `${AGENTS[l.from]?.name} → ${AGENTS[l.to]?.name}: ${l.why}`; line.append(title); svg.append(line);
  }
  svg.append(el("circle", { cx, cy, r: 20, fill: "var(--panel-3)", stroke: "var(--lead)" }));
  const lt = el("text", { x: cx, y: cy + 5, "text-anchor": "middle", fill: "var(--lead)", "font-size": "16" }); lt.textContent = "✦"; svg.append(lt);
  const ll = el("text", { x: cx, y: cy + 34, "text-anchor": "middle", fill: "var(--lead)", "font-size": "10" }); ll.textContent = "Lead"; svg.append(ll);
  const colors = { reliability: "var(--rel)", quality: "var(--qual)", supply: "var(--sup)", energy: "var(--ene)", flow: "var(--flow)" };
  for (const a of SPECIALISTS) {
    const used = links.some((l) => l.from === a || l.to === a);
    svg.append(el("circle", { cx: pos[a][0], cy: pos[a][1], r: 20, fill: "var(--panel)", stroke: colors[a], "stroke-width": used ? 3 : 1, opacity: used ? 1 : 0.5 }));
    const t = el("text", { x: pos[a][0], y: pos[a][1] + 34, "text-anchor": "middle", fill: colors[a], "font-size": "12", "font-weight": "600" }); t.textContent = AGENTS[a].name; svg.append(t);
    const ic = el("text", { x: pos[a][0], y: pos[a][1] + 5, "text-anchor": "middle", fill: colors[a], "font-size": "15" }); ic.textContent = AGENTS[a].ico; svg.append(ic);
  }
  return svg;
}

export function impactStrip(imp) {
  const d = imp.delta, cell = (label, value, good, info) => h("div", { class: "impact" }, h("div", { class: "label" }, label), h("div", { class: `value ${good ? "delta-good-up" : ""}` }, value),
    info ? h("div", { class: "tiny faint" }, info) : null);
  const o = imp.orders?.find((x) => x.status_do_nothing !== "on track") || imp.orders?.[0];
  return h("div", { class: "impact-strip" },
    cell("Net value", `${d.money >= 0 ? "+" : ""}${money(d.money)}`, d.money > 0, "money gained"),
    cell("Good parts", `${d.good >= 0 ? "+" : ""}${num(d.good)}`, d.good > 0, "sellable parts"),
    cell("Scrap parts", `${d.scrap > 0 ? "+" : ""}${num(d.scrap)}`, d.scrap < 0, "thrown away"),
    cell("Machine-hours down", `${d.down_h > 0 ? "+" : ""}${num(d.down_h, 0)}`, d.down_h < 0, "standing still"),
    cell("Energy", `${d.kwh > 0 ? "+" : ""}${num(d.kwh)} kWh`, d.kwh < 0, "electricity"),
    cell("CO2e", `${d.co2e_kg > 0 ? "+" : ""}${num(d.co2e_kg)} kg`, d.co2e_kg < 0, "greenhouse gas"),
    o ? cell(`Order ${o.so}`, `${Math.round(o.cover_do_nothing * 100)} → ${Math.round(o.cover_plan * 100)} %`, o.cover_plan >= 1 && o.cover_do_nothing < 1, "share of the order we can ship") : null);
}
