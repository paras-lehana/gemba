// Card detail (#/card/<id>): one Gemba card explained in plain words: what is wrong, why it matters, the evidence,
// what each action means and who does it, when it happens, the simulated impact, the decision and what followed.
import { api, store, h, AGENTS, agentChip, num, hours, localTime, toast } from "../core.js";
import { explain } from "../learn.js";
import { TOOL_LABEL, ACTION_INFO, SPECIALISTS, LENS, actText, metaLine, impactBlock, decisionBar, statusBadge, simNow, plantOf, whyCard } from "./walk.js";

const REPAIR_H = 4;

export async function render(main, params, query) {
  const id = params?.[0];
  const page = h("div", { class: "page card-page" });
  main.append(page);
  if (!id) { page.append(h("div", { class: "panel pad" }, h("h2", {}, "No card chosen"), h("a", { class: "btn", href: "#/walk" }, "Open the Gemba walk"))); return; }
  page.append(h("p", { class: "dim small" }, "Loading the card…"));
  let d;
  try { d = await loadCard(id); }
  catch (e) {
    page.replaceChildren(h("div", { class: "panel pad" }, h("h2", {}, `Card ${id} was not found`),
      h("p", { class: "dim" }, "Cards belong to your own demo session. Run a Gemba walk to get fresh cards, then open one from there or from a machine page."),
      h("a", { class: "btn primary", href: "#/walk" }, "Open the Gemba walk")));
    return;
  }
  if (!store.tick) await new Promise((res) => { const off = store.on((k) => { if (k === "tick") { off(); res(); } }); setTimeout(() => { off(); res(); }, 2500); });
  draw(page, d);
  const off = store.on((k) => { if (k === "changed") loadCard(id).then((nd) => { if (nd.card.status !== d.card.status) { d = nd; draw(page, d); } }).catch(() => {}); });
  return () => off();
}

// GET /api/cards/<id>; falls back to the card list + latest walk when the detail route is not there.
async function loadCard(id) {
  try { return await api.get(`/api/cards/${encodeURIComponent(id)}`); }
  catch (e) {
    if (e.status && e.status !== 404 && e.status !== 405) throw e;
    const cards = await api.get("/api/cards");
    const card = cards.find((c) => c.id === id);
    if (!card) throw e;
    const latest = await api.get("/api/walk/latest").catch(() => ({ walk: null }));
    const w = latest.walk?.id === card.walk ? latest.walk : null;
    const findings = {};
    for (const ev of w?.events || []) if (ev.kind === "finding") findings[ev.agent] = ev.finding;
    const wos = (await api.get("/api/workorders").catch(() => [])).filter((x) => x.card === id);
    return { card, plan: w?.plan || null, findings, work_orders: wos, related: cards.filter((x) => x.id !== id && x.machine_id && x.machine_id === card.machine_id) };
  }
}

function draw(page, d) {
  const c = d.card;
  const m = store.machine(c.machine_id);
  const panel = (title, ...kids) => h("section", { class: "panel cd-panel" }, h("div", { class: "panel-head" }, h("h2", {}, title)), h("div", { class: "panel-body" }, ...kids));
  const ctx = `Gemba card "${c.title}" for ${c.machine_id}${m ? ` (${m.name})` : ""}. Why: ${c.why}. Actions: ${c.actions.map((a) => actText(a, c)).join("; ")}.` +
    (c.impact ? ` Over 4 days doing nothing gives ${c.impact.do_nothing.good} good and ${c.impact.do_nothing.scrap} scrap parts, ${c.impact.do_nothing.down_h} machine-hours down; with the card ${c.impact.plan.good} good, ${c.impact.plan.scrap} scrap, ${c.impact.plan.down_h} h down.` : "");
  let ex = null;
  try { ex = explain(`gemba card ${c.title}`, ctx); const b = ex?.tagName === "BUTTON" ? ex : ex?.querySelector?.("button"); if (b) b.textContent = "Explain like I am new"; } catch (e) { ex = null; }

  const head = h("div", { class: "page-head cd-head" },
    h("div", { class: "grow" },
      h("a", { class: "small", href: `#/walk?card=${encodeURIComponent(c.id)}` }, "← Back to the Gemba walk"),
      metaLine(c),
      h("h1", {}, c.title),
      h("div", { class: "row gap wrap" }, statusBadge(c), h("span", { class: "chip" }, c.id), h("span", { class: "chip" }, `urgency: ${c.urgency}`),
        h("span", { class: "tiny dim" }, "Departments:"), ...c.pillars.map(agentChip))),
    ex);

  // what is wrong + why it matters
  const wrong = panel("What is wrong",
    h("p", { class: "cd-lead" }, c.why),
    d.plan?.headline ? h("p", { class: "small dim" }, h("b", {}, "The walk's headline: "), d.plan.headline) : null,
    m ? h("p", { class: "small dim" }, `${m.id} is a ${m.name.toLowerCase()} on the ${store.catalog?.lines?.find((l) => l.id === m.line)?.name || m.line} in ${store.plantInfo(m.plant)?.name || m.plant}. `,
      h("a", { href: `#/machine/${encodeURIComponent(m.id)}` }, `Open ${m.id}'s machine page →`)) : null);
  const matters = panel("Why it matters", whyCard(c.impact, c) || h("p", { class: "dim small" }, "A logistics or communication step: the simulator has nothing to measure for it."),
    ...(c.guardrails || []).map((g) => h("div", { class: "guard" }, "⛨ ", g)));

  // evidence: findings of this card's departments first
  const fs = d.findings || {};
  const mine = c.pillars.filter((a) => fs[a]);
  const others = SPECIALISTS.filter((a) => fs[a] && !c.pillars.includes(a));
  const links = (d.plan?.links || []).filter((l) => c.pillars.includes(l.from) || c.pillars.includes(l.to));
  const evidence = panel("Evidence",
    h("p", { class: "tiny dim" }, "What the agents measured with their tools on the walk that produced this card. Each line names the tool it came from."),
    mine.length ? h("div", { class: "cd-findings" }, ...mine.map((a) => findingCard(a, fs[a]))) : h("p", { class: "small dim" }, "The agents' notes for this walk are no longer in memory; the plan story below still explains the link."),
    d.plan?.story ? h("div", { class: "cd-story" }, h("b", {}, "How the Gemba Lead put it together: "), d.plan.story) : null,
    links.length ? h("ul", { class: "link-list" }, ...links.map((l) => h("li", {}, agentChip(l.from), h("span", { "aria-label": "links to" }, "→"), agentChip(l.to), h("span", { class: "small" }, l.why)))) : null,
    links.length ? h("p", { class: "tiny faint" }, "An arrow from A to B means: a problem A found is caused by, or affects, what B found.") : null,
    others.length ? h("details", { class: "cd-more" }, h("summary", {}, `What the other agents saw on the same walk (${others.length})`),
      h("div", { class: "cd-findings" }, ...others.map((a) => findingCard(a, fs[a])))) : null);

  // actions + timeline
  const actions = panel("What will be done, and by whom",
    h("ol", { class: "cd-acts" }, ...c.actions.map((a) => h("li", {},
      h("div", { class: "cd-act-t" }, h("b", {}, ACTION_INFO[a.kind]?.label || a.kind.replace(/_/g, " ")), h("span", { class: "chip" }, ACTION_INFO[a.kind]?.who || c.owner)),
      h("div", { class: "small" }, actText(a, c)),
      h("div", { class: "tiny dim" }, ACTION_INFO[a.kind]?.means || a.note || "")))),
    h("p", { class: "tiny dim" }, `Card owner: ${c.owner}. Times are local plant time.`),
    timeline(c));

  const impact = panel("Impact over the next 4 days", impactBlock(c, { why: false }),
    h("p", { class: "tiny faint" }, "Numbers come from the plant simulator, not from the language model."));
  const decision = panel("Decision",
    h("p", { class: "small" }, statusBadge(c), " ", c.status === "proposed" ? "Type your name and approve to create work orders. Rejecting asks for a reason so the agents learn." : ""),
    c.edits?.length ? h("p", { class: "tiny dim" }, `Timing changed on approval: ${c.edits.join("; ")}.`) : null,
    decisionBar(c, () => { api.get(`/api/cards/${encodeURIComponent(c.id)}`).then((nd) => draw(page, nd)).catch(() => draw(page, { ...d, card: c })); }));
  const wos = d.work_orders || [];
  const work = panel("Work orders",
    wos.length ? h("ul", { class: "cd-wos" }, ...wos.map((w) => h("li", {}, h("a", { href: `#/job/${encodeURIComponent(w.id)}` }, `${w.id} · ${w.title}`),
      h("span", { class: "tiny dim" }, ` · ${w.status} · starts ${localTime(w.start, plantOf(w.machine_id || w.target), true)}`))))
      : h("p", { class: "small dim" }, c.status === "approved" ? "No work orders were created." : "Work orders are created when someone approves this card."));
  const rel = d.related || [];
  const related = panel(`Other cards for ${c.machine_id || "this machine"}`,
    rel.length ? h("ul", { class: "cd-rel" }, ...rel.map((r) => h("li", { class: r.status === "superseded" ? "is-dup" : "" },
      h("a", { href: `#/card/${encodeURIComponent(r.id)}` }, r.title), " ", statusBadge(r),
      r.status === "superseded" ? h("span", { class: "tiny dim" }, ` · older duplicate${r.superseded_by ? ` of ${r.superseded_by}` : ""}`) : null)))
      : h("p", { class: "small dim" }, "No other cards for this machine."));

  page.replaceChildren(head, h("div", { class: "cd-grid" },
    h("div", { class: "cd-col" }, wrong, matters, evidence, actions),
    h("div", { class: "cd-col" }, impact, decision, work, related)));
}

function findingCard(a, f) {
  const sev = f.severity === "critical" || f.severity === "high" ? "alarm" : f.severity === "medium" ? "watch" : "ok";
  return h("div", { class: `cd-finding ag-${a}` },
    h("div", { class: "row gap wrap" }, agentChip(a), h("span", { class: `status st-${sev}` }, f.severity), h("span", { class: "tiny dim" }, LENS[a]?.ask || "")),
    h("b", {}, f.headline),
    h("ul", {}, ...(f.observations || []).map((o) => h("li", {}, o.fact, h("span", { class: "chip cd-src" }, TOOL_LABEL[o.source] || o.source)))),
    f.likely_cause ? h("div", { class: "small" }, h("span", { class: "dim" }, "Likely cause: "), f.likely_cause) : null,
    f.model ? h("div", { class: "tiny faint" }, f.fallback ? "Rules engine (model not used)" : `Model: ${f.model}`) : null);
}

// Horizontal timeline 0–96 h with each action, the repair window and the predicted breakdown if nothing is done.
function timeline(c) {
  const span = Math.max(96, ...c.actions.map((a) => (a.when_h || 0) + 8));
  const pos = (hh) => `${Math.min(100, Math.max(0, (hh / span) * 100))}%`;
  const now = simNow(c);
  const rows = [];
  const track = h("div", { class: "tl-track", "aria-hidden": "true" });
  for (const d of [0, 24, 48, 72, 96]) if (d <= span) track.append(h("span", { class: "tl-tick", style: `left:${pos(d)}` }, h("i", {}, d ? `+${d / 24} d` : "now")));
  c.actions.forEach((a, i) => {
    const w = a.when_h || 0;
    const len = a.kind === "repair" ? REPAIR_H : a.kind === "transfer_part" ? 9 : 1;
    track.append(h("span", { class: `tl-bar k-${a.kind}`, style: `left:${pos(w)};width:max(6px, ${(len / span) * 100}%);top:${8 + i * 10}px`, title: actText(a, c) }));
    rows.push(h("li", {}, h("span", { class: `tl-dot k-${a.kind}` }), h("b", {}, localTime(now + w * 3600, plantOf(a.target), true)),
      h("span", { class: "dim" }, ` (${w ? `in ${hours(w)}` : "now"}) · `), `${ACTION_INFO[a.kind]?.label || a.kind}${a.kind === "repair" ? ` (until ${localTime(now + (w + REPAIR_H) * 3600, plantOf(a.target))})` : a.kind === "transfer_part" ? " (about 9 h on the road)" : ""} · ${a.target}`));
  });
  for (const [mid, tr] of Object.entries(c.impact?.trip_h || {})) if (tr.do_nothing != null) {
    track.append(h("span", { class: "tl-trip", style: `left:${pos(tr.do_nothing)}`, title: `${mid} breaks down if nothing is done` }));
    rows.push(h("li", { class: "is-trip" }, h("span", { class: "tl-dot trip" }), h("b", {}, localTime(now + tr.do_nothing * 3600, plantOf(mid), true)),
      h("span", { class: "dim" }, ` (in ${hours(tr.do_nothing)}) · `), `${mid} is expected to break down by itself if nothing is done`));
  }
  track.style.height = `${24 + c.actions.length * 10}px`;
  return h("div", { class: "tl" }, h("h3", { class: "small" }, "Timeline"), track, h("ul", { class: "tl-list small" }, ...rows));
}
