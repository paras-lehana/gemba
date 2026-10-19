"""Ask Gemba: plain-language questions over the plant, answered by Gemini with SQL and tools, shown with a chart.

The model writes the SQL; the server checks and runs it read-only and returns the real rows next to the answer, so a
person can see exactly where each number came from. Requests to approve, release or start work are refused: only a
named person can approve, in the approval flow.
"""
import re
import time

from . import llm
from . import tools as T
from .walk import MAX_ROUNDS

ASK_TOOLS = ["query_sql", "machine_condition", "order_book", "line_oee", "energy_ranking", "scrap_overview", "spare_parts",
             "what_if", "night_base_load", "maintenance_history"]
SUBMIT = {"name": "submit_answer", "description": "Give the final answer and end your turn.", "parameters": {
    "type": "object", "properties": {
        "answer": {"type": "string", "description": "2-5 plain sentences with the key numbers, for a plant manager"},
        "chart": {"type": "object", "description": "How to chart the last query_sql result (or type none)", "properties": {
            "type": {"type": "string", "enum": ["bar", "line", "none"]}, "x": {"type": "string"},
            "y": {"type": "array", "items": {"type": "string"}}, "title": {"type": "string"}}, "required": ["type"]},
        "follow_ups": {"type": "array", "items": {"type": "string"}, "description": "Up to 3 short next questions"}},
    "required": ["answer"]}}
SYSTEM = """You are Gemba, the operations analyst for Meridian Precision Components (fictional; plants Pune and Chakan in
India, Rayong in Thailand; all data simulated). Answer the user's question with data:
- Prefer one good query_sql call (DuckDB); use the other tools when they answer more directly.
- Use only numbers from tool results. Name the machine, line or order. Money is in US dollars for every plant.
- "Waste" or "worse than normal" means compared with the machine's own baseline (energy_ranking and scrap_overview give
  the change vs baseline); casting cells naturally use more energy per part than machining cells.
- If a query fails, read the error, fix the SQL and try again (at most 2 retries).
- You cannot approve, release, start or close work orders or change the plant; say that a named person approves cards in
  the Gemba plan, and point them there.
Finish with submit_answer. If the answer is a comparison or a trend, set a chart over the columns of your last query."""
GUARD = re.compile(r"\b(approve|release|sign off|close|start|execute|dispatch|bypass|skip)\b.{0,40}\b(work ?order|wo-|card|repair|job|approval|lock-?out)", re.I)


async def ask(session, question: str, history: list | None = None) -> dict:
    t = time.time()
    q = (question or "").strip()[:600]
    now = session.world.now()
    if GUARD.search(q):
        session.log("Ask Gemba", "Blocked by guardrail", q, kind="guardrail")
        return {"answer": "I can't do that. Gemba's agents only propose; a named person approves each card in the Gemba plan, "
                          "and a technician releases a machine only after the lock-out steps and the release reading. "
                          "Open the plan to review and approve it.", "guardrail": True, "tools": [], "ms": 0}
    trail, last_sql = [], None
    if llm.provider() == "mock":
        return {"answer": "No model is configured, so free-text questions are off. The plant views still show every number.",
                "fallback": True, "tools": [], "ms": 0}
    msgs = [{"role": "system", "content": SYSTEM + "\nLocal time: " + ", ".join(f"{p} {T.local(p, now)}" for p in ("PUN", "RAY"))}]
    for h in (history or [])[-4:]:
        if h.get("role") in ("user", "assistant") and h.get("content"):
            msgs.append({"role": h["role"], "content": str(h["content"])[:1500]})
    msgs.append({"role": "user", "content": q})
    tools = T.spec(ASK_TOOLS) + [SUBMIT]
    final, model = None, ""
    for rnd in range(MAX_ROUNDS + 1):
        last = rnd == MAX_ROUNDS
        if last:
            msgs.append({"role": "user", "content": "Call submit_answer now with what you have."})
        r = await llm.chat(msgs, [SUBMIT] if last else tools, role="agent", temperature=0.1)
        model = r.model
        if not r.tool_calls:
            final = {"answer": r.content.strip() or "I could not find an answer."}
            break
        msgs.append({"role": "assistant", "content": r.content, "tool_calls": r.tool_calls, "raw": r.raw})
        for c in r.tool_calls:
            if c["name"] == "submit_answer":
                final = c["args"]
                msgs.append({"role": "tool", "tool_call_id": c["id"], "name": c["name"], "content": '{"ok":true}'})
                continue
            res, summ, ms = T.run(c["name"], session, now, c.get("args") or {})
            trail.append({"name": c["name"], "args": c.get("args"), "summary": summ, "ms": ms, "error": bool(res.get("error"))})
            if c["name"] == "query_sql" and not res.get("error"):
                last_sql = res
            msgs.append({"role": "tool", "tool_call_id": c["id"], "name": c["name"], "content": T.dumps(res)[:12000]})
        if final is not None:
            break
    final = final or {"answer": "I could not finish the analysis in time."}
    chart = final.get("chart") or {}
    if last_sql and chart.get("type") in ("bar", "line"):
        cols = last_sql["columns"]
        if chart.get("x") not in cols:
            chart["x"] = cols[0]
        chart["y"] = [y for y in (chart.get("y") or []) if y in cols] or [c for c in cols[1:2]]
    else:
        chart = {"type": "none"}
    session.log("Ask Gemba", "Answered a question", q[:200], kind="agent", evidence=[f"{x['name']}: {x['summary']}" for x in trail])
    return {"answer": final.get("answer", ""), "chart": chart, "table": last_sql, "follow_ups": (final.get("follow_ups") or [])[:3],
            "tools": trail, "model": model, "ms": int(1000 * (time.time() - t))}
