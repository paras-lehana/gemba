"""Gemini tutor: plain-language explanations for people new to manufacturing.

POST /api/explain {topic, context?, key?} -> {answer, topic, fallback, model, ms}
- The tutor explains one idea to a complete beginner in 3-5 short sentences with one everyday analogy and why it matters
  for money, safety or delivery, using only the context the page sends (numbers the visitor is looking at).
- When no model answers, it falls back to the glossary text (fallback: true), so a button never ends in an error.
- Rate limited like Ask (same bucket) and cached per (topic, context) so repeat clicks cost nothing.
"""
import pathlib
import re
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..agents import llm
from ..store import limits

router = APIRouter()

SYSTEM = (
    "You are the Gemba tutor. You explain factory ideas to complete beginners: students, judges and new staff who have "
    "never worked in a factory. Answer in 3 to 5 short sentences of plain English. Use exactly one everyday analogy "
    "(a car, a kitchen, a phone, a bicycle, a household bill). Say why the idea matters for money, safety or on-time "
    "delivery. If the context gives numbers, say what they mean and whether they are high or low. Use only the context "
    "given and general knowledge; never invent plant numbers, names or prices. No jargon without explaining it, no "
    "headings, no bullet lists, no markdown."
)

# The glossary lives in the web app (static/js/learn.js, one term per line); read it once so the fallback text is the same.
_GLOSSARY_LINE = re.compile(r'^\s*([a-z_0-9]+): \{ label: "([^"]*)", short: "([^"]*)", why: "([^"]*)" \},?\s*$')


def _load_glossary() -> dict:
    out = {}
    try:
        path = pathlib.Path(__file__).resolve().parents[2] / "static" / "js" / "learn.js"
        for line in path.read_text(encoding="utf-8").splitlines():
            m = _GLOSSARY_LINE.match(line)
            if m:
                out[m.group(1)] = {"label": m.group(2), "short": m.group(3), "why": m.group(4)}
    except OSError:
        pass
    return out


GLOSSARY = _load_glossary()
_CACHE: dict = {}
_CACHE_MAX = 300


class ExplainIn(BaseModel):
    topic: str = Field(..., min_length=1, max_length=160)
    context: str = Field("", max_length=2000)
    key: str = Field("", max_length=40)


def _core(label: str) -> str:
    """'Hobbing machine (HOB)' -> 'hobbing machine'; 'Peak and off-peak tariff' stays whole."""
    return re.sub(r"\s*\(.*?\)", "", label).strip().lower()


def _lookup(body: ExplainIn) -> dict | None:
    if body.key and body.key in GLOSSARY:
        return GLOSSARY[body.key]
    t = body.topic.strip().lower()
    for g in GLOSSARY.values():
        if t in (g["label"].lower(), _core(g["label"])):
            return g
    # A question that names a glossary word ("What is a hobbing machine?"): the longest match wins.
    hits = sorted((g for g in GLOSSARY.values() if len(_core(g["label"])) > 2 and re.search(rf"\b{re.escape(_core(g['label']))}", t)),
                  key=lambda g: -len(_core(g["label"])))
    return hits[0] if hits else None


def _fallback(body: ExplainIn) -> str:
    g = _lookup(body)
    if g:
        return f"{g['short']} Why it matters: {g['why']}"
    ctx = body.context.strip()
    if ctx and len(ctx) <= 400:
        return f"The tutor cannot answer right now, so here is what this screen says about {body.topic}: {ctx}"
    return (f"The tutor cannot answer right now. Open the Learn page for a five-minute introduction that covers "
            f"{body.topic} and the other ideas on this screen.")


@router.post("/api/explain")
async def explain(body: ExplainIn, request: Request):
    topic = body.topic.strip()
    context = body.context.strip()
    if not topic:
        raise HTTPException(422, "Please name the topic to explain.")
    ck = (topic.lower(), context)
    hit = _CACHE.get(ck)
    if hit:
        return {**hit, "cached": True}
    msg = limits.check(request, "ask")
    if msg:
        raise HTTPException(429, msg)
    g = _lookup(body)
    user = f"Explain this to a complete beginner: {topic}"
    if g:
        user += f"\nGlossary meaning: {g['short']} Why it matters: {g['why']}"
    if context:
        user += f"\nWhat the visitor is looking at right now:\n{context}"
    t0 = time.time()
    try:
        r = await llm.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
                           role="agent", temperature=0.3, retries=0)
        answer = (r.content or "").strip().replace("**", "")
        if not answer:
            raise llm.LLMError("empty answer")
        out = {"topic": topic, "answer": answer[:1500], "fallback": False, "model": r.model,
               "ms": int((time.time() - t0) * 1000)}
        if len(_CACHE) >= _CACHE_MAX:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[ck] = out
        return out
    except llm.LLMError:
        return {"topic": topic, "answer": _fallback(body), "fallback": True, "model": "",
                "ms": int((time.time() - t0) * 1000)}
