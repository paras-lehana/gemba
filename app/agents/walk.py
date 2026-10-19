"""The Gemba Walk: five specialist Gemini agents look at the plant in parallel, then a Lead agent links their findings,
tests candidate plans on the simulator and writes one plan of approvable cards.

Everything the agents do is streamed as events (tool calls, results, findings, the plan) so people can watch the walk.
Numbers on the cards are recomputed by the simulator (what-if), not taken from the model. If a model call fails, that
agent's finding comes from the rules engine and is labelled "rules fallback".
"""
import asyncio
import re
import json
import os
import pathlib
import time
import uuid

from ..analytics import whatif
from ..analytics.snapshot import plant_snapshot
from ..sim.catalog import MACHINES, PLANTS, SPARES
from ..sim.plant import H
from . import llm
from . import tools as T
from . import vision

MAX_ROUNDS = 5
RUNNING: list = []          # recent walks across all sessions (for the global concurrency cap)

AGENTS = {
    "reliability": {
        "name": "Reliability", "pillar": "reliability",
        "tools": ["machine_condition", "maintenance_history", "spare_parts", "query_sql"],
        "mission": "Find the machines whose condition threatens production. Separate real wear from sensor faults. For a "
                   "wearing machine give the time-to-trip range, the likely failure mode, whether preventive maintenance "
                   "was overdue, and whether the spare part is on hand.",
    },
    "quality": {
        "name": "Quality", "pillar": "quality",
        "tools": ["scrap_overview", "scrap_control_chart", "inspect_part_photo", "material_lots", "query_sql"],
        "mission": "Find every machine whose scrap is clearly above its own normal (scrap_overview lists them), which "
                   "defect it is and the most likely cause (machine condition, material lot or tool). Inspect a part photo "
                   "for each of the top two to confirm the defect. Report all of them; say what containment is needed and "
                   "which other department probably owns the cause.",
    },
    "supply": {
        "name": "Supply", "pillar": "supply & demand",
        "tools": ["order_book", "demand_forecast", "spare_parts", "what_if"],
        "mission": "Find customer orders that will be short or late and why (capacity, scrap, a machine at risk). Check "
                   "demand trends for the affected product and whether critical spare parts are where they are needed.",
    },
    "energy": {
        "name": "Energy", "pillar": "sustainability",
        "tools": ["energy_ranking", "compressor_baseline", "night_base_load", "tariff_windows", "query_sql"],
        "mission": "Find energy waste: machines using more kWh per good part than their baseline and utilities drawing "
                   "power when production is stopped. Give kWh, money and kg CO2e per day, and the cheapest windows for "
                   "heavy or planned work.",
    },
    "flow": {
        "name": "Flow", "pillar": "efficiency",
        "tools": ["line_oee", "line_machines", "what_if", "query_sql"],
        "mission": "Find the line whose OEE dropped most and explain the loss (availability, speed or quality) and which "
                   "machine drives it. Say what stopping that machine for a repair would cost and when it hurts least.",
    },
}

FINDING_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "One sentence, plain words, the most important problem you found"},
        "severity": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
        "machines": {"type": "array", "items": {"type": "string"}},
        "observations": {"type": "array", "items": {"type": "object", "properties": {
            "fact": {"type": "string", "description": "A fact with its number, e.g. 'Scrap 3.3 % vs 0.8 % baseline'"},
            "source": {"type": "string", "description": "Tool name the fact came from"}}, "required": ["fact", "source"]}},
        "likely_cause": {"type": "string"},
        "recommendations": {"type": "array", "items": {"type": "string"}},
        "suspected_links": {"type": "array", "items": {"type": "object", "properties": {
            "agent": {"type": "string", "enum": list(AGENTS)}, "why": {"type": "string"}}, "required": ["agent", "why"]},
            "description": "Other departments whose problem may share a cause with yours"},
        "confidence": {"type": "number", "description": "0 to 1"},
    },
    "required": ["headline", "severity", "observations", "likely_cause", "recommendations", "confidence"],
}

ACTION_KINDS = ["slow", "repair", "fix_leak", "quarantine_lot", "recalibrate", "transfer_part", "inspect100", "adjust_tool_life",
                "notify_customer", "reschedule"]
PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "The whole situation in one sentence"},
        "story": {"type": "string", "description": "3-5 plain sentences: how the departments' problems connect and what the plan does"},
        "links": {"type": "array", "items": {"type": "object", "properties": {
            "from": {"type": "string", "enum": list(AGENTS)}, "to": {"type": "string", "enum": list(AGENTS)},
            "why": {"type": "string"}}, "required": ["from", "to", "why"]}},
        "cards": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string", "description": "Imperative, e.g. 'Replace VMC-204 spindle bearing tonight 22:00'"},
            "pillars": {"type": "array", "items": {"type": "string", "enum": list(AGENTS)}},
            "machine_id": {"type": "string"},
            "why": {"type": "string", "description": "Two sentences with the key numbers"},
            "actions": {"type": "array", "items": {"type": "object", "properties": {
                "kind": {"type": "string", "enum": ACTION_KINDS}, "target": {"type": "string"},
                "when_h": {"type": "number", "description": "Hours from now"}, "value": {"type": "number"},
                "part_no": {"type": "string"}, "from_plant": {"type": "string"}, "note": {"type": "string"}},
                "required": ["kind", "target"]}},
            "owner": {"type": "string", "description": "Role who approves, e.g. Maintenance planner"},
            "urgency": {"type": "string", "enum": ["now", "today", "this week"]},
            "confidence": {"type": "number"}},
            "required": ["title", "pillars", "why", "actions", "owner", "urgency"]}},
        "tradeoffs": {"type": "string", "description": "What the plan gives up and why it is still the best option"},
    },
    "required": ["headline", "story", "cards"],
}

PREAMBLE = """You are the {name} agent of Gemba, an AI operations team for Meridian Precision Components, a fictional
auto-components maker with plants in Pune and Chakan (India) and Rayong (Thailand). All data is simulated.
You are on a Gemba walk: look at the live plant through your tools and report the most important problem in your area.

Your area: {pillar}. Mission: {mission}

Rules:
- Use only numbers that appear in tool results, and name the tool as the source. Never invent numbers or machines.
- Money is in US dollars ($) for every plant.
- Be efficient: at most {max_calls} tool calls in total; you may call several tools at once.
- A frozen (flat-lined) sensor is an instrument problem: recommend checking the sensor, never a repair crew.
- You propose; people decide. Write for a plant manager: short, plain, concrete.
- When you have enough evidence, call submit_finding exactly once. That ends your turn."""

LEAD_PROMPT = """You are the Gemba Lead, the orchestrator of an AI operations team for Meridian Precision Components (fictional;
plants Pune and Chakan in India, Rayong in Thailand; all data simulated). Five specialist agents (reliability, quality,
supply, energy, flow) just walked the plant. Your job:
1. Link their findings: which problems share ONE root cause across departments? Typical chain: a worn machine
   (reliability) causes scrap (quality) and more energy per good part (energy), lowers line OEE (flow) and puts a
   customer order at risk (supply). Only link findings that really share a cause; never link unrelated problems.
2. Build ONE plan of 3 to 6 cards a plant team can approve. Each card has concrete actions with a target and timing
   (when_h = hours from now). Use action kinds: slow (value = speed 0.7-1.0), repair (4 h planned stop), fix_leak,
   quarantine_lot (target = lot id), recalibrate (sensor), transfer_part (part_no, from_plant, target = destination plant),
   inspect100, adjust_tool_life, notify_customer, reschedule.
3. Test the important choices with what_if before deciding (1 to 3 calls), e.g. repair now vs at the off-peak window, or
   with vs without slowing a machine. Prefer the option the simulator says is better; mention the trade-off.
4. Check spare_parts before scheduling a repair. If the part is not at the plant, add a transfer and schedule the repair
   after it arrives, and still before the predicted trip (use the low end of the time-to-trip range as the deadline).
5. Timing words must match the data: call a time "off-peak" only if tariff_windows says so for that hour.
6. Guardrails: a frozen sensor gets "recalibrate", never "repair". Every card needs a person to approve it.
Then call submit_plan exactly once. Use only numbers from findings or tool results."""


# ----------------------------------------------------------------------------------------------- walk state

class Walk:
    def __init__(self, session, focus: dict | None = None, recorded: dict | None = None):
        self.id = "W" + uuid.uuid4().hex[:8]
        self.session = session
        self.focus = focus          # Gemba Watch: {"machines": [...], "signal": "...", "agents": [...], "trigger": "..."}
        self.agents = list(focus["agents"]) if focus else list(AGENTS)
        self.recorded = recorded    # replay of a saved live Gemini walk: {"saved_at", "model", ...}
        self.now = session.world.now()
        self.events: list = []
        self.queues: list = []
        self.status = "running"
        self.started = time.time()
        self.findings: dict = {}
        self.plan = None
        self.stats = {"llm_calls": 0, "tool_calls": 0, "tokens_in": 0, "tokens_out": 0, "fallbacks": 0}

    def emit(self, kind: str, **data):
        ev = {"seq": len(self.events), "kind": kind, "ms": int(1000 * (time.time() - self.started)), **data}
        self.events.append(ev)
        for q in list(self.queues):
            q.put_nowait(ev)

    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue()
        for ev in self.events:
            q.put_nowait(ev)
        if self.status != "running":
            q.put_nowait(None)
        self.queues.append(q)
        return q

    def close(self):
        for q in self.queues:
            q.put_nowait(None)


async def _run_tool(walk: Walk, agent: str, call: dict):
    name, args = call["name"], call.get("args") or {}
    walk.stats["tool_calls"] += 1
    walk.emit("tool_call", agent=agent, call_id=call["id"], name=name, args=args)
    if name == "inspect_part_photo":
        res, summ, ms = await vision.inspect_for_agent(walk.session, walk.now, args.get("machine_id", ""))
        if res.get("image_url"):
            walk.emit("image", agent=agent, call_id=call["id"], url=res["image_url"], boxes=res.get("boxes", []),
                      label=res.get("defect"))
    else:
        res, summ, ms = await asyncio.to_thread(T.run, name, walk.session, walk.now, args)
    walk.emit("tool_result", agent=agent, call_id=call["id"], name=name, summary=summ, took_ms=ms, error=bool(res.get("error")))
    return res


def _note_usage(walk: Walk, r: llm.LLMResult):
    walk.stats["llm_calls"] += 1
    walk.stats["tokens_in"] += int(r.usage.get("in") or r.usage.get("prompt_tokens") or 0)
    walk.stats["tokens_out"] += int(r.usage.get("out") or r.usage.get("completion_tokens") or 0)


async def _agent_loop(walk: Walk, agent: str, system: str, user: str, tool_names: list, submit: dict, role: str = "agent",
                      max_calls: int = 6) -> tuple[dict | None, str]:
    """Generic tool loop. Returns (submitted args, model) or (None, reason)."""
    tools = T.spec(tool_names) + [submit]
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    model = ""
    used = 0
    for rnd in range(MAX_ROUNDS + 1):
        last = rnd >= MAX_ROUNDS - 1 or used >= max_calls
        if last:
            msgs.append({"role": "user", "content": f"Time is up. Call {submit['name']} now with what you have."})
        r = await llm.chat(msgs, [submit] if last else tools, role=role, temperature=0.2)
        _note_usage(walk, r)
        model = r.model
        if r.content.strip():
            walk.emit("note", agent=agent, text=r.content.strip()[:400])
        if not r.tool_calls:
            msgs.append({"role": "assistant", "content": r.content})
            msgs.append({"role": "user", "content": f"Please use your tools, then call {submit['name']}."})
            continue
        msgs.append({"role": "assistant", "content": r.content, "tool_calls": r.tool_calls, "raw": r.raw})
        done = next((c["args"] for c in r.tool_calls if c["name"] == submit["name"]), None)
        work = [c for c in r.tool_calls if c["name"] != submit["name"]]
        used += len(work)
        results = await asyncio.gather(*(_run_tool(walk, agent, c) for c in work))   # parallel tool calls in one round
        res_by_id = {c["id"]: res for c, res in zip(work, results)}
        for c in r.tool_calls:
            content = '{"ok":true}' if c["name"] == submit["name"] else T.dumps(res_by_id[c["id"]])[:12000]
            msgs.append({"role": "tool", "tool_call_id": c["id"], "name": c["name"], "content": content})
        if done is not None:
            return done, model
    return None, "no submission"


# ----------------------------------------------------------------------------------------------- specialists

def _overview_text(ov: dict) -> str:
    return T.dumps(ov)


async def run_specialist(walk: Walk, agent: str, overview: dict):
    a = AGENTS[agent]
    walk.emit("agent_start", agent=agent, title=a["name"], tools=a["tools"])
    t = time.time()
    system = PREAMBLE.format(name=a["name"], pillar=a["pillar"], mission=a["mission"], max_calls=6)
    user = ("Plant overview right now (from plant_overview):\n" + _overview_text(overview) +
            "\nStart your walk in your area.")
    if walk.focus:
        user = ("Gemba Watch spotted a NEW signal: " + walk.focus["signal"] + "\nPlant overview (from plant_overview):\n" +
                _overview_text(overview) + "\nInvestigate only this new signal from your area's point of view (at most 3 tool "
                "calls), then submit your finding. Problems already covered by earlier plans are out of scope.")
    submit = {"name": "submit_finding", "description": "Submit your finding and end your turn.", "parameters": FINDING_SCHEMA}
    finding, model, fallback, err = None, "", False, ""
    if llm.provider() != "mock" and llm.available():
        try:
            finding, model = await _agent_loop(walk, agent, system, user, a["tools"], submit)
            if finding is None:
                err = model
        except llm.LLMError as e:
            err = str(e)
    if not _valid_finding(finding):
        if err or finding is not None:
            walk.emit("agent_error", agent=agent, error=(err or "finding did not match the schema")[:200])
        finding = await asyncio.to_thread(rules_finding, walk, agent)
        fallback = True
        walk.stats["fallbacks"] += 1
    finding = _clean_finding(finding)
    walk.findings[agent] = {**finding, "agent": agent, "fallback": fallback, "model": model or "rules engine",
                            "took_ms": int(1000 * (time.time() - t))}
    walk.emit("finding", agent=agent, finding=walk.findings[agent])


def _valid_finding(f) -> bool:
    return isinstance(f, dict) and bool(f.get("headline")) and isinstance(f.get("observations", []), list)


def _clean_finding(f: dict) -> dict:
    out = {k: f.get(k) for k in ("headline", "severity", "machines", "observations", "likely_cause", "recommendations",
                                 "suspected_links", "confidence")}
    out["severity"] = out["severity"] if out["severity"] in ("low", "medium", "high", "critical") else "medium"
    out["machines"] = [m.upper() for m in (out["machines"] or []) if isinstance(m, str) and m.upper() in MACHINES]
    out["observations"] = [o for o in (out["observations"] or []) if isinstance(o, dict) and o.get("fact")][:6]
    out["recommendations"] = [r if isinstance(r, str) else str(r) for r in (out["recommendations"] or [])][:5]
    out["suspected_links"] = [l for l in (out["suspected_links"] or []) if isinstance(l, dict) and l.get("agent") in AGENTS][:4]
    try:
        out["confidence"] = max(0.0, min(1.0, float(out["confidence"] or 0.6)))
    except (TypeError, ValueError):
        out["confidence"] = 0.6
    return out


# ----------------------------------------------------------------------------------------------- lead

async def run_lead(walk: Walk):
    walk.emit("agent_start", agent="lead", title="Gemba Lead", tools=["what_if", "spare_parts", "tariff_windows", "technicians"])
    t = time.time()
    findings = {k: {x: v.get(x) for x in ("headline", "severity", "machines", "observations", "likely_cause", "recommendations",
                                          "suspected_links", "confidence")} for k, v in walk.findings.items()}
    user = ("Findings from the agents:\n" + T.dumps(findings) +
            "\nLocal time now: " + ", ".join(f"{p} {T.local(p, walk.now)}" for p in PLANTS) +
            ". Link the findings, test the key choices with what_if, then call submit_plan.")
    if walk.focus:
        user += ("\nThis is a Gemba Watch check of one NEW signal (" + walk.focus["signal"] + "). Write 1 or 2 cards for it "
                 "only; do not repeat cards for problems that already have a plan.")
    memory = decisions_text(walk.session)
    if memory:
        user += "\nDecisions people at this plant made before (respect them; do not re-propose what they rejected without a new reason):\n" + memory
    submit = {"name": "submit_plan", "description": "Submit the plan of cards and end your turn.", "parameters": PLAN_SCHEMA}
    plan, model, fallback, err = None, "", False, ""
    if llm.provider() != "mock" and llm.available():
        try:
            plan, model = await _agent_loop(walk, "lead", LEAD_PROMPT, user, ["what_if", "spare_parts", "tariff_windows", "technicians"],
                                            submit, role="lead", max_calls=5)
            if plan is None:
                err = model
        except llm.LLMError as e:
            err = str(e)
    if not (isinstance(plan, dict) and plan.get("cards")):
        if err or plan is not None:
            walk.emit("agent_error", agent="lead", error=(err or "plan did not match the schema")[:200])
        plan = await asyncio.to_thread(rules_focus_plan if walk.focus else rules_plan, walk)
        fallback = True
        walk.stats["fallbacks"] += 1
    plan = await asyncio.to_thread(finalize_plan, walk, plan)
    plan.update(fallback=fallback, model=model or "rules engine", took_ms=int(1000 * (time.time() - t)))
    return plan


_MID_RE = re.compile(r"\b([A-Z]{2,4}-\d{3})\b")


def _card_machine(c: dict) -> str:
    """The machine a card is about. The model sometimes leaves machine_id empty, which made every card look like the
    same machine (all of them under "Main problem", none on the machine page). Fall back to the first action aimed at
    a machine, then to the first machine named in the title, then in the reason."""
    mid = str(c.get("machine_id") or "").upper().strip()
    if mid in MACHINES:
        return mid
    for a in c.get("actions") or []:
        tgt = str((a or {}).get("target") or "").upper().strip() if isinstance(a, dict) else ""
        if tgt in MACHINES:
            return tgt
    for text in (c.get("title"), c.get("why")):
        for m in _MID_RE.findall(str(text or "").upper()):
            if m in MACHINES:
                return m
    return ""


def finalize_plan(walk: Walk, plan: dict) -> dict:
    """Validate cards, apply guardrails and attach simulator-computed impact (do nothing vs this card)."""
    s, now = walk.session, walk.now
    cards = []
    for i, c in enumerate(plan.get("cards") or []):
        if not isinstance(c, dict) or not c.get("title"):
            continue
        mid = _card_machine(c)
        guard = []
        acts = []
        for a in c.get("actions") or []:
            if not isinstance(a, dict) or a.get("kind") not in ACTION_KINDS:
                continue
            a = {k: a.get(k) for k in ("kind", "target", "when_h", "value", "part_no", "from_plant", "note") if a.get(k) not in (None, "")}
            tgt = str(a.get("target", "")).upper()
            a["target"] = tgt if tgt else mid
            try:
                a["when_h"] = max(0.0, min(120.0, float(a.get("when_h", 0) or 0)))
            except (TypeError, ValueError):
                a["when_h"] = 0.0
            if a["kind"] == "repair" and a["target"] in MACHINES:
                from ..analytics import signals
                if signals.sensor_faults(s.world, a["target"], now):
                    a["kind"] = "recalibrate"
                    guard.append(f"{a['target']} has a frozen sensor: changed 'repair' to 'recalibrate' (no repair crew for an instrument fault)")
            if a["kind"] == "slow":
                try:
                    a["value"] = max(0.6, min(1.0, float(a.get("value") or 0.85)))
                except (TypeError, ValueError):
                    a["value"] = 0.85
            acts.append(a)
        # Spare part check for VMC spindle repairs at Pune.
        for a in acts:
            if a["kind"] == "repair" and a["target"] in MACHINES and MACHINES[a["target"]].kind == "VMC":
                plant = MACHINES[a["target"]].plant
                if s.stock("SPB-7014", plant) < 1 and not s.in_transit("SPB-7014", plant):
                    tr = next((x for x in plan.get("cards", []) for y in (x.get("actions") or []) if isinstance(x, dict)
                               and isinstance(y, dict) and y.get("kind") == "transfer_part"), None)
                    src = next((p for p in ("CHK", "RAY") if s.stock("SPB-7014", p) > 0), None)
                    eta = SPARES["SPB-7014"]["transfer_h"].get(src, 0) if src else None
                    if not tr and src and not any(x["kind"] == "transfer_part" for x in acts):
                        acts.insert(0, {"kind": "transfer_part", "target": plant, "part_no": "SPB-7014", "from_plant": src, "when_h": 0.0})
                        guard.append(f"No spindle bearing at {plant}: added a transfer from {src} ({eta} h)")
                    if eta is not None and a["when_h"] < eta:
                        guard.append(f"Repair moved from +{a['when_h']:.0f} h to +{eta} h: the bearing arrives in {eta} h")
                        a["when_h"] = float(eta)
        sim_acts = [a for a in acts if a["kind"] in whatif.ACTION_KINDS]
        impact = None
        if sim_acts:
            r = whatif.compare(s.world, sim_acts, now, 96.0, watch=[mid] if mid else [])
            impact = {k: r[k] for k in ("do_nothing", "plan", "delta", "orders", "trip_h", "assumptions", "horizon_h")}
        cards.append({"id": s.next_id("GC"), "walk": walk.id, "title": str(c["title"])[:140],
                      "pillars": [p for p in (c.get("pillars") or []) if p in AGENTS] or ["reliability"],
                      "machine_id": mid, "why": str(c.get("why") or "")[:600], "actions": acts,
                      "owner": str(c.get("owner") or "Plant manager")[:60],
                      "urgency": c.get("urgency") if c.get("urgency") in ("now", "today", "this week") else "today",
                      "confidence": c.get("confidence"), "guardrails": guard, "impact": impact, "status": "proposed",
                      "created": now})
    all_sim = [a for c in cards for a in c["actions"] if a["kind"] in whatif.ACTION_KINDS]
    total = None
    if all_sim:
        r = whatif.compare(s.world, all_sim, now, 96.0)
        total = {k: r[k] for k in ("do_nothing", "plan", "delta", "orders", "trip_h", "assumptions", "horizon_h")}
    links = [l for l in (plan.get("links") or []) if isinstance(l, dict) and l.get("from") in AGENTS and l.get("to") in AGENTS]
    return {"id": "P" + walk.id[1:], "headline": str(plan.get("headline") or "")[:220], "story": str(plan.get("story") or "")[:1200],
            "links": links[:8], "cards": cards, "tradeoffs": str(plan.get("tradeoffs") or "")[:600], "impact": total}


# ----------------------------------------------------------------------------------------------- rules engine (fallback)

def rules_finding(walk: Walk, agent: str) -> dict:
    """Deterministic finding from the same tools, used when a model is unavailable. Labelled in the UI."""
    s, now = walk.session, walk.now
    run = lambda n, **a: T.run(n, s, now, a)[0]
    if agent == "reliability":
        ov = run("plant_overview")
        alarm = [m for m in ov["flagged_machines"] if m["status"] == "alarm"]
        sens = [m for m in ov["flagged_machines"] if m["status"] == "sensor"]
        obs, machines = [], []
        if alarm:
            mc = run("machine_condition", machine_id=alarm[0]["id"])
            mh = run("maintenance_history", machine_id=alarm[0]["id"])
            machines.append(mc["machine_id"])
            v = mc["readings"]["vib"]
            obs.append({"fact": f"{mc['machine_id']} vibration {v['value']} mm/s (normal {v['nominal']}, alarm {v['alarm']}, trip {v['trip']})", "source": "machine_condition"})
            if mc.get("time_to_trip_h"):
                tt = mc["time_to_trip_h"]
                obs.append({"fact": f"Trip limit expected in {tt['p10']:.0f}-{tt['p90']:.0f} h (median {tt['p50']:.0f} h)", "source": "machine_condition"})
            if mh.get("preventive_overdue_days"):
                obs.append({"fact": f"Preventive maintenance {mh['preventive_overdue_days']:.0f} days overdue", "source": "maintenance_history"})
        for m in sens[:1]:
            obs.append({"fact": f"{m['id']}: {m['reasons'][0]} (sensor problem, not the machine)", "source": "plant_overview"})
        return {"headline": (f"{alarm[0]['id']} spindle bearing is wearing and will reach the trip limit" if alarm else "No machine at risk"),
                "severity": "high" if alarm else "low", "machines": machines + [m["id"] for m in sens[:1]], "observations": obs,
                "likely_cause": "Bearing wear: vibration rising at steady speed with bearing temperature following",
                "recommendations": ["Plan a bearing replacement before the trip", "Send an instrument technician to the frozen sensor"],
                "suspected_links": [{"agent": "quality", "why": "worn spindles cause chatter marks"}], "confidence": 0.7}
    if agent == "quality":
        so = run("scrap_overview")
        top = so["machines"][:2]
        obs = [{"fact": f"{r['machine_id']} scrap {r['scrap_24h_pct']} % vs {r['baseline_pct']} % baseline ({', '.join(k for k in r['by_defect_parts'] if k != 'other')})", "source": "scrap_overview"} for r in top]
        vmc = next((r for r in so["machines"] if r["machine_id"].startswith("VMC") and r["scrap_24h_pct"] > 2 * r["baseline_pct"]), None)
        if vmc:
            obs.append({"fact": f"{vmc['machine_id']} chatter-mark scrap {vmc['scrap_24h_pct']} % vs {vmc['baseline_pct']} %", "source": "scrap_overview"})
        return {"headline": "Scrap is above normal on the Rayong casting cells (porosity) and on VMC-204 (chatter marks)",
                "severity": "high", "machines": [r["machine_id"] for r in top] + ([vmc["machine_id"]] if vmc else []), "observations": obs,
                "likely_cause": "Porosity follows material lot AL-2210; chatter marks follow a machine condition problem",
                "recommendations": ["Quarantine lot AL-2210", "100 % inspection of VMC-204 output until repaired"],
                "suspected_links": [{"agent": "reliability", "why": "chatter marks come from spindle vibration"}], "confidence": 0.65}
    if agent == "supply":
        ob = run("order_book")
        risky = [o for o in ob["orders"] if o["status"] != "on track"]
        sp = run("spare_parts", part_no="SPB-7014")
        obs = [{"fact": f"{o['so']} {o['customer']}: {o['qty']} {o['product']} due in {o['due_in_h']:.0f} h, cover {o['cover']}", "source": "order_book"} for o in risky[:2]]
        obs.append({"fact": "Spindle bearing SPB-7014 stock: " + ", ".join(f"{r['plant']} {r['on_hand']}" for r in sp["stock"]), "source": "spare_parts"})
        return {"headline": (f"Order {risky[0]['so']} for {risky[0]['customer']} is {risky[0]['status']}" if risky else "All orders on track"),
                "severity": "high" if risky and risky[0]["cover"] < 1 else "medium", "machines": [], "observations": obs,
                "likely_cause": "Lower output and higher scrap on the Cylinder Head Line while the customer raised the quantity",
                "recommendations": ["Protect Cylinder Head Line output", "Move a spindle bearing from Chakan to Pune"],
                "suspected_links": [{"agent": "flow", "why": "line output decides the order"}], "confidence": 0.7}
    if agent == "energy":
        nb = run("night_base_load")["compressors"][0]
        er = run("energy_ranking")["machines"][0]
        return {"headline": f"{nb['machine_id']} draws {nb['extra_kw']} kW extra at night: likely an air leak",
                "severity": "medium", "machines": [nb["machine_id"], er["machine_id"]],
                "observations": [{"fact": f"{nb['machine_id']} quiet-hours load {nb['quiet_hours_kw']} kW vs {nb['baseline_kw']} kW a week ago: {nb['extra_kwh_per_day']} kWh, ${nb['extra_cost_per_day']:,} and {nb['co2e_kg_per_day']} kg CO2e a day", "source": "night_base_load"},
                                 {"fact": f"{er['machine_id']} uses {er['kwh_per_good_change_pct']:+.0f} % kWh per good part vs baseline", "source": "energy_ranking"}],
                "likely_cause": "Compressed-air leak; worn spindle wasting energy per part",
                "recommendations": ["Leak survey and fix tonight", "Do heavy maintenance in the 22:00-06:00 off-peak window"],
                "suspected_links": [{"agent": "reliability", "why": "a worn spindle uses more energy per good part"}], "confidence": 0.7}
    lo = run("line_oee")
    worst = min(lo["lines"], key=lambda r: r["oee"] - (r["oee_week_ago"] or r["oee"]))
    return {"headline": f"{worst['name']} OEE fell from {worst['oee_week_ago']:.0%} to {worst['oee']:.0%}",
            "severity": "medium", "machines": [], "observations": [{"fact": f"{worst['line']} availability {worst['availability']:.0%}, performance {worst['performance']:.0%}, quality {worst['quality']:.0%}", "source": "line_oee"}],
            "likely_cause": "One machine running slower with more scrap", "recommendations": ["Repair in the lowest-impact window"],
            "suspected_links": [{"agent": "reliability", "why": "the drop follows one machine"}], "confidence": 0.6}


def rules_plan(walk: Walk) -> dict:
    s, now = walk.session, walk.now
    tw = T.run("tariff_windows", s, now, {"plant": "PUN"})[0]["windows"]
    off = next((b for b in tw if b["band"] == "offpeak" and b["starts_in_h"] >= 9), None)
    when = off["starts_in_h"] if off else 10.0
    cards = [{"title": f"Replace VMC-204 spindle bearing at {T.local('PUN', now + when * H)} (off-peak)",
              "pillars": ["reliability", "quality", "supply", "energy"], "machine_id": "VMC-204",
              "why": "Bearing wear drives chatter-mark scrap and will trip the machine before Friday's order; Chakan has the part.",
              "actions": [{"kind": "transfer_part", "target": "PUN", "part_no": "SPB-7014", "from_plant": "CHK", "when_h": 0},
                          {"kind": "repair", "target": "VMC-204", "when_h": when}], "owner": "Maintenance planner", "urgency": "today"},
             {"title": "Fix the compressed-air leak on CMP-901 tonight", "pillars": ["energy"], "machine_id": "CMP-901",
              "why": "Night-time load is 11 kW above last week with lines stopped.", "actions": [{"kind": "fix_leak", "target": "CMP-901", "when_h": 2}],
              "owner": "Utilities engineer", "urgency": "today"},
             {"title": "Quarantine casting lot AL-2210, switch to AL-2214", "pillars": ["quality", "supply"], "machine_id": "DIE-501",
              "why": "Porosity scrap on both die-casting cells started with this lot.", "actions": [{"kind": "quarantine_lot", "target": "AL-2210", "when_h": 0}],
              "owner": "Quality manager", "urgency": "now"},
             {"title": "Check the frozen temperature sensor on GRD-102", "pillars": ["reliability"], "machine_id": "GRD-102",
              "why": "The reading has not moved for hours: an instrument fault, not a machine fault.", "actions": [{"kind": "recalibrate", "target": "GRD-102", "when_h": 1}],
              "owner": "Instrument technician", "urgency": "today"}]
    return {"headline": "One worn spindle bearing is behind the scrap, the order risk and part of the energy waste",
            "story": "VMC-204's bearing is wearing; it causes chatter marks, slows the Cylinder Head Line and threatens order SO-24117. "
                     "A bearing from Chakan allows a repair in the off-peak window before the predicted trip. Separately, an air leak "
                     "wastes energy at night and a casting lot causes porosity in Rayong.",
            "links": [{"from": "quality", "to": "reliability", "why": "chatter marks come from the worn spindle"},
                      {"from": "supply", "to": "flow", "why": "the order depends on the Cylinder Head Line output"}],
            "cards": cards, "tradeoffs": "The repair stops one of four machines for 4 h at night instead of risking an unplanned trip."}


# ----------------------------------------------------------------------------------------------- orchestration

async def run_walk(walk: Walk):
    s = walk.session
    try:
        walk.emit("walk_start", walk_id=walk.id, provider=llm.describe(), agents=walk.agents, local_time=T.local("PUN", walk.now),
                  focus=walk.focus)
        walk.emit("tool_call", agent="lead", call_id="ov", name="plant_overview", args={})
        ov, summ, ms = await asyncio.to_thread(T.run, "plant_overview", s, walk.now, {})
        walk.emit("tool_result", agent="lead", call_id="ov", name="plant_overview", summary=summ, took_ms=ms, error=False)
        await asyncio.gather(*(run_specialist(walk, a, ov) for a in walk.agents))
        walk.emit("linking", agent="lead", text="Linking findings across departments")
        plan = await run_lead(walk)
        walk.plan = plan
        supersede(s, plan["cards"])
        for c in plan["cards"]:
            s.cards[c["id"]] = c
        s.log("Gemba Lead" if not walk.focus else "Gemba Watch", f"Proposed plan {plan['id']} with {len(plan['cards'])} cards",
              plan["headline"], kind="agent", ref=walk.id)
        if walk.focus:
            s.watch_events.append({"id": len(s.watch_events) + 1, "t": walk.now, "kind": "plan", "walk_id": walk.id,
                                   "text": f"{len(plan['cards'])} new card{'s' if len(plan['cards']) != 1 else ''} for {', '.join(walk.focus['machines'])}: {plan['headline'][:120]}"})
        walk.emit("plan", plan=plan)
        walk.status = "done"
        if not walk.focus and walk.stats["fallbacks"] == 0:
            await asyncio.to_thread(save_recording, walk)
    except Exception as e:  # never leave the UI hanging
        walk.status = "error"
        walk.emit("walk_error", error=str(e)[:300])
    finally:
        walk.emit("walk_end", status=walk.status, stats=walk.stats, took_ms=int(1000 * (time.time() - walk.started)))
        walk.close()


def start(session, focus: dict | None = None) -> Walk:
    running = [w for w in session.walks.values() if w.status == "running"]
    if running:
        return running[-1]
    w = Walk(session, focus)
    session.walks[w.id] = w
    RUNNING[:] = [x for x in RUNNING if x.status == "running"] + [w]
    while len(session.walks) > 5:
        session.walks.popitem(last=False)
    if focus:
        session.log("Gemba Watch", "Noticed a new signal and called the agents", focus["signal"], kind="agent", ref=w.id)
    else:
        session.log("Gemba Lead", "Started a Gemba walk", f"provider: {llm.describe()['label']}", kind="agent", ref=w.id)
    asyncio.get_running_loop().create_task(run_walk(w))
    return w


# ----------------------------------------------------------------------------------------------- memory + watch helpers

def decisions_text(session) -> str:
    """The last decisions people made on cards, as plain lines for the Lead's prompt."""
    lines = []
    for d in session.decisions[-8:]:
        if d["kind"] == "rejected":
            lines.append(f"- Rejected '{d['title']}' — reason: {d['reason']} ({d['by']})")
        elif d["kind"] == "edited":
            lines.append(f"- Approved '{d['title']}' but changed it: {d['reason']} ({d['by']})")
        else:
            lines.append(f"- Approved '{d['title']}' ({d['by']})")
    return "\n".join(lines)


def rules_focus_plan(walk: Walk) -> dict:
    """Rules fallback for a Gemba Watch check: one card per new machine signal."""
    s, now = walk.session, walk.now
    cards = []
    for mid in walk.focus["machines"]:
        m = MACHINES[mid]
        from ..analytics.snapshot import machine_state
        st = machine_state(s.world, mid, now)
        if st["status"] == "sensor":
            cards.append({"title": f"Check the frozen sensor on {mid}", "pillars": ["reliability"], "machine_id": mid,
                          "why": f"{st['reasons'][0]}: an instrument fault, not a machine fault.",
                          "actions": [{"kind": "recalibrate", "target": mid, "when_h": 1}], "owner": "Instrument technician", "urgency": "today"})
        elif m.kind == "COMPRESSOR":
            cards.append({"title": f"Find and fix the air leak on {mid}", "pillars": ["energy"], "machine_id": mid,
                          "why": st["reasons"][0] if st["reasons"] else "Extra load without extra production.",
                          "actions": [{"kind": "fix_leak", "target": mid, "when_h": 2}], "owner": "Utilities engineer", "urgency": "today"})
        elif st.get("ttf"):
            when = max(1.0, min(st["ttf"]["to_trip_h"]["p10"] * 0.5, 24.0))
            cards.append({"title": f"Plan a bearing repair on {mid}", "pillars": ["reliability", "flow"], "machine_id": mid,
                          "why": f"Vibration is rising; trip expected in {st['ttf']['to_trip_h']['p10']:.0f}-{st['ttf']['to_trip_h']['p90']:.0f} h.",
                          "actions": [{"kind": "repair", "target": mid, "when_h": round(when, 1)}], "owner": "Maintenance planner", "urgency": "today"})
        else:
            cards.append({"title": f"Inspect {mid}", "pillars": ["quality"], "machine_id": mid, "why": "; ".join(st["reasons"]) or "New signal.",
                          "actions": [{"kind": "inspect100", "target": mid, "when_h": 0}], "owner": "Shift supervisor", "urgency": "today"})
    return {"headline": f"New signal on {', '.join(walk.focus['machines'])}", "story": walk.focus["signal"], "links": [],
            "cards": cards, "tradeoffs": ""}


def agents_for(machine_state: dict) -> list:
    """Which specialists a new signal needs."""
    kind = MACHINES[machine_state["id"]].kind
    if machine_state["status"] == "sensor":
        return ["reliability"]
    if kind == "COMPRESSOR":
        return ["energy"]
    if machine_state["status"] == "watch" and not machine_state.get("ttf"):
        return ["quality", "supply"]
    return ["reliability", "quality", "flow", "supply"]


# ----------------------------------------------------------------------------------------------- recorded walks

DATA_DIR = pathlib.Path(os.environ.get("GEMBA_DATA_DIR", "/tmp/gemba"))
SHIPPED = pathlib.Path(__file__).resolve().parent.parent.parent / "static" / "recordings" / "hero-walk.json"


def save_recording(walk: Walk):
    """Keep the latest complete live Gemini walk (no fallbacks) so it can be replayed when the model is unreachable."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        plan = walk.plan
        rec = {"saved_at": time.time(), "sim_now": walk.now, "stats": walk.stats, "model": plan.get("model"),
               "provider": llm.describe()["label"],
               "events": [e for e in walk.events if e["kind"] not in ("plan", "walk_end")],
               "plan": {k: plan.get(k) for k in ("headline", "story", "links", "tradeoffs", "model", "took_ms")} |
                       {"cards": [{k: c.get(k) for k in ("title", "pillars", "machine_id", "why", "actions", "owner", "urgency",
                                                         "confidence")} for c in plan["cards"]]}}
        (DATA_DIR / "last-walk.json").write_text(json.dumps(rec))
    except OSError:
        pass


def load_recording() -> dict | None:
    for p in (DATA_DIR / "last-walk.json", SHIPPED):
        try:
            return json.loads(p.read_text())
        except (OSError, ValueError):
            continue
    return None


async def run_replay(walk: Walk, rec: dict, speed: float = 1.6):
    s = walk.session
    try:
        meta = {"saved_at": rec["saved_at"], "model": rec.get("model"), "provider": rec.get("provider")}
        walk.emit("walk_start", walk_id=walk.id, provider=llm.describe(), agents=list(AGENTS), recorded=meta,
                  local_time=T.local("PUN", walk.now))
        prev = 0
        for ev in rec["events"]:
            if ev["kind"] == "walk_start":
                continue
            await asyncio.sleep(max(0.0, (ev["ms"] - prev) / 1000 / speed))
            prev = ev["ms"]
            data = {k: v for k, v in ev.items() if k not in ("seq", "kind", "ms")}
            walk.emit(ev["kind"], **data)
            if ev["kind"] == "finding":
                walk.findings[ev["agent"]] = ev["finding"]
        plan = await asyncio.to_thread(finalize_plan, walk, rec["plan"])
        plan.update(fallback=False, model=rec["plan"].get("model"), took_ms=rec["plan"].get("took_ms"), recorded=meta)
        walk.plan = plan
        supersede(s, plan["cards"])
        for c in plan["cards"]:
            s.cards[c["id"]] = c
        s.log("Gemba Lead", f"Replayed a recorded Gemini walk ({len(plan['cards'])} cards)",
              "numbers recomputed on the current plant", kind="agent", ref=walk.id)
        walk.emit("plan", plan=plan)
        walk.status = "done"
    except Exception as e:
        walk.status = "error"
        walk.emit("walk_error", error=str(e)[:300])
    finally:
        walk.emit("walk_end", status=walk.status, stats=rec.get("stats", walk.stats), recorded=True,
                  took_ms=int(1000 * (time.time() - walk.started)))
        walk.close()


def replay(session) -> Walk | None:
    rec = load_recording()
    if not rec:
        return None
    running = [w for w in session.walks.values() if w.status == "running"]
    if running:
        return running[-1]
    w = Walk(session, recorded={"saved_at": rec["saved_at"]})
    session.walks[w.id] = w
    while len(session.walks) > 5:
        session.walks.popitem(last=False)
    asyncio.get_running_loop().create_task(run_replay(w, rec))
    return w


MAIN_KINDS = {"repair", "transfer_part", "fix_leak", "quarantine_lot", "recalibrate", "slow", "inspect100", "adjust_tool_life"}


def supersede(session, new_cards: list):
    """A newer walk that proposes the same kind of action for the same machine replaces the older, still-open card,
    so people never see two live 'transfer the bearing' cards."""
    for old in session.cards.values():
        if old.get("status") != "proposed":
            continue
        old_kinds = {a["kind"] for a in old.get("actions", [])} & MAIN_KINDS
        for new in new_cards:
            same_target = (old.get("machine_id") and old.get("machine_id") == new.get("machine_id")) or \
                {a.get("target") for a in old.get("actions", [])} & {a.get("target") for a in new.get("actions", [])}
            if same_target and old_kinds & ({a["kind"] for a in new.get("actions", [])} & MAIN_KINDS):
                old["status"], old["superseded_by"] = "superseded", new["id"]
                session.log("Gemba Lead", f"Card {old['id']} replaced by {new['id']}", old["title"], kind="agent", ref=new["id"])
                break
