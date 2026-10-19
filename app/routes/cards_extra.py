"""Card detail: one Gemba card with the evidence behind it, its work orders and related cards for the same machine."""
import json

from fastapi import APIRouter, HTTPException, Request

from ..agents import tools as T

router = APIRouter()


@router.get("/api/cards/{card_id}")
async def card_detail(request: Request, card_id: str):
    s = request.state.session
    c = s.cards.get(card_id)
    if not c:
        raise HTTPException(404, "unknown card (cards belong to your own demo session; run a Gemba walk first)")
    walk = s.walks.get(c.get("walk"))
    plan = None
    findings = {}
    if walk is not None:
        if walk.plan:
            plan = {k: walk.plan.get(k) for k in ("id", "headline", "story", "links", "tradeoffs", "model", "recorded")}
        findings = walk.findings or {}
    wos = [s.work_orders[w] for w in c.get("work_orders", []) if w in s.work_orders]
    related = [x for x in s.cards.values() if x["id"] != card_id and c.get("machine_id") and x.get("machine_id") == c.get("machine_id")]
    return json.loads(T.dumps({"card": c, "plan": plan, "findings": findings, "work_orders": wos, "related": related}))
