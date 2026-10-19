"""Gemba web service: the API, two live streams (plant ticks and Gemba-walk events) and the static web app.

Run locally:  .venv/bin/uvicorn app.main:app --port 8411
Cloud Run:    see Dockerfile (PORT is provided by the platform).
"""
import asyncio
import base64
from contextlib import asynccontextmanager
import json
import os
import pathlib
import time

import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .agents import ask as ask_agent
from .agents import llm, vision, voice, watch
from .agents import tools as T
from .agents import walk as walk_mod
from .analytics import anomaly, ops, signals, whatif
from .analytics.snapshot import machine_state, plant_snapshot, series
from .sim import erp
from .sim.catalog import CUSTOMERS, LINES, MACHINES, PLANTS, PRODUCTS, SPARES, TECHNICIANS
from .sim.plant import ANCHOR, H, INJECTABLE, power_kw, parts_rate, sensor
from .store import session as sessions
from .store import limits, workorders

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = (ROOT / "VERSION").read_text().strip()
STARTED = time.time()
COOKIE = "gemba_sid"



async def _probe_models():
    """Every 5 minutes, one tiny call so the UI can say honestly whether Gemini is reachable."""
    while True:
        if llm.provider() != "mock":
            try:
                await llm.chat([{"role": "user", "content": "Reply OK."}], role="agent", retries=0)
                if walk_mod.load_recording() is None:          # first healthy moment: record one real walk for replay
                    internal = sessions.get(None)
                    w = walk_mod.Walk(internal)
                    internal.walks[w.id] = w
                    await walk_mod.run_walk(w)
            except llm.LLMError:
                pass
        await asyncio.sleep(300)


@asynccontextmanager
async def lifespan(_app):
    await asyncio.to_thread(anomaly.train)
    probe = asyncio.create_task(_probe_models()) if os.environ.get("GEMBA_PROBE", "1") == "1" else None
    yield
    if probe:
        probe.cancel()


app = FastAPI(title="Gemba", version=VERSION, docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
# The page loads its scripts from a path that carries the version (/a/<version>/...), so a CDN or browser can never
# mix an old cached module with a new one after a release; /static stays for images and the Firebase bundle.
ASSETS = f"/a/{VERSION}"
app.mount(ASSETS, StaticFiles(directory=ROOT / "static"), name="assets")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
# Feature routers (one module per area).
from .routes import cards_extra, edge, machine_extra, tutor  # noqa: E402

for _r in (cards_extra, machine_extra, tutor, edge):
    app.include_router(_r.router)

# Optional: a front end hosted elsewhere (e.g. Firebase Hosting) calling this API with cookies.
CORS_ORIGINS = [o.strip() for o in os.environ.get("GEMBA_CORS_ORIGINS", "").split(",") if o.strip()]
if CORS_ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_credentials=False, allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type", "X-Gemba-Session"], expose_headers=["X-Gemba-Session"])


def _limit(request: Request, kind: str):
    msg = limits.check(request, kind)
    if msg:
        raise HTTPException(429, msg)


@app.middleware("http")
async def _session_cookie(request: Request, call_next):
    # Same-site pages use a cookie; a front end on another host (e.g. Firebase Hosting) sends the id in a header, or as
    # ?sid= on event streams, because browsers block third-party cookies.
    sid = request.headers.get("x-gemba-session") or request.query_params.get("sid") or request.cookies.get(COOKIE)
    s = sessions.get(sid)
    request.state.session = s
    resp = await call_next(request)
    resp.headers["X-Gemba-Session"] = s.id
    if sid != s.id:
        resp.set_cookie(COOKIE, s.id, max_age=7 * 86400, httponly=True, samesite="lax",
                        secure=request.headers.get("x-forwarded-proto", request.url.scheme) == "https")
    if request.url.path.startswith(("/static/", "/a/")):
        resp.headers["Cache-Control"] = "no-cache"   # always revalidate (ETag), never serve a stale copy
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


def S(request: Request):
    return request.state.session


def _json(obj):
    return json.loads(T.dumps(obj))


# ----------------------------------------------------------------------------------------------- pages and health

def _hosting() -> dict:
    """Where this copy runs, for the "See us on Google Cloud Run" strip and the demo page."""
    return {"cloud_run_url": os.environ.get("GEMBA_CLOUD_RUN_URL", "").strip().rstrip("/"),
            "on_cloud_run": bool(os.environ.get("K_SERVICE")),          # Cloud Run sets K_SERVICE
            "home_url": os.environ.get("GEMBA_HOME_URL", "https://gemba.lehana.in").strip().rstrip("/"),
            "video_id": os.environ.get("GEMBA_DEMO_VIDEO", "RKwNTZ16CIc").strip(),
            "github": "https://github.com/paras-lehana/gemba"}


def _page(name: str) -> HTMLResponse:
    """A static HTML page with versioned asset paths and the hosting facts injected before </head>."""
    html = (ROOT / "static" / name).read_text().replace('"/static/', f'"{ASSETS}/')
    tag = "<script>window.GEMBA_HOSTING = " + json.dumps(_hosting()).replace("</", "<\\/") + ";</script>\n</head>"
    return HTMLResponse(html.replace("</head>", tag, 1), headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
async def index():
    return _page("index.html")


@app.get("/demo", include_in_schema=False)
@app.get("/demo/", include_in_schema=False)
async def demo_page():
    return _page("demo.html")


@app.api_route("/health", methods=["GET", "HEAD"], include_in_schema=False)
@app.get("/api/health")
async def health():
    rec = walk_mod.load_recording()
    return {"status": "ok", "service": "gemba", "version": VERSION, "started": int(STARTED), "uptime_s": int(time.time() - STARTED),
            "recording": {"saved_at": rec["saved_at"], "model": rec.get("model")} if rec else None,
            "environment": os.environ.get("GEMBA_ENV", "local"),
            "llm": llm.describe(), "sessions": sessions.count()}


@app.get("/api/catalog")
async def catalog():
    return _json({
        "plants": [{"id": p.id, "name": p.name, "country": p.country, "tz": p.tz, "currency": p.currency,
                    "grid_kg_co2_per_kwh": p.grid_kg_co2_per_kwh, "tariff": p.tariff} for p in PLANTS.values()],
        "lines": [{"id": l.id, "plant": l.plant, "name": l.name, "product": l.product} for l in LINES.values()],
        "machines": [{"id": m.id, "name": m.name, "kind": m.kind, "plant": m.plant, "line": m.line, "criticality": m.criticality,
                      "pos": m.pos, "product": m.product, "cycle_s": m.cycle_s,
                      "sensors": [{"key": s.key, "label": s.label, "unit": s.unit, "nominal": s.nominal, "alarm": s.alarm, "trip": s.trip}
                                  for s in m.sensors]} for m in MACHINES.values()],
        "products": PRODUCTS, "customers": CUSTOMERS, "technicians": TECHNICIANS,
        "injectable": {k: {"target": v.target, "kind": v.kind} for k, v in INJECTABLE.items()},
        "llm": llm.describe(), "version": VERSION})


# ----------------------------------------------------------------------------------------------- live state

DRILL_LABELS = {"bearing_wear_vmc202": "Bearing failure on VMC-202", "air_leak_chk": "Air leak on compressor CMP-951 (Chakan)",
                "sensor_stuck_hob301": "Frozen vibration sensor on HOB-301"}


def _inject(s, name: str, by: str = "Presenter") -> bool:
    sc = INJECTABLE[name]
    if any(x.id == sc.id for x in s.world.extra_scenarios):
        return False
    s.world.extra_scenarios.append(sc.injected(s.world.now()))
    s.world.touch()
    s.log(by, f"Injected fault {name}", f"{sc.kind} on {sc.target}", kind="system")
    return True


def _drills(s) -> list:
    """Advance drills: pending → injected (when due) → detected (Gemba Watch started) → planned (cards ready)."""
    t = time.time()
    for d in s.drills:
        if d["status"] == "pending" and t >= d["due_at"]:
            _inject(s, d["scenario"], "Drill")
            d.update(status="injected", injected_sim=s.world.now())
        if d["status"] in ("injected", "detected"):
            for ev in s.watch_events:
                if ev["t"] + 1 < d.get("injected_sim", 0) or d["target"] not in ev["text"]:
                    continue
                if ev["kind"] == "start" and d["status"] == "injected":
                    d.update(status="detected", walk_id=ev["walk_id"])
                if ev["kind"] == "plan" and ev.get("walk_id") == d.get("walk_id"):
                    d["status"] = "planned"
    return [{k: v for k, v in d.items()} | {"due_in_s": max(0, round(d["due_at"] - t))} for d in s.drills[-6:]]


def _session_info(s):
    workorders.refresh(s)
    if s.world.speed > 1 and s.world.now() > ANCHOR + 6.5 * 24 * H:     # the simulated week ends: back to real time
        s.world.set_speed(1)
    return {"speed": s.world.speed, "drills": _drills(s), "edge": s.edge,"now": s.world.now(), "offset_h": round(s.world.offset_s / H, 2), "version": s.world.version,
            "cards_open": sum(1 for c in s.cards.values() if c["status"] == "proposed"),
            "work_orders_open": sum(1 for w in s.work_orders.values() if w["status"] not in ("Done", "Cancelled")),
            "transfers": [{**t, "eta_h": round((t["arrive"] - s.world.now()) / H, 1)} for t in s.transfers],
            "injected": [x.id for x in s.world.extra_scenarios],
            "walk": next((w.id for w in reversed(s.walks.values())), None)}


@app.get("/api/state")
async def state(request: Request):
    s = S(request)
    snap = await asyncio.to_thread(plant_snapshot, s.world, None, s.id)
    return _json({**snap, "session": _session_info(s)})


def _tick(s):
    now = s.world.now()
    snap = plant_snapshot(s.world, now, key=s.id)
    live = []
    for m in snap["machines"]:
        mid = m["id"]
        mm = MACHINES[mid]
        # Same feed as the machine page: interpolated between the simulator's one-minute samples plus a small 2-second
        # measurement flicker, so the twin and the ticker move every tick like real sensors (frozen sensors stay frozen).
        lv = machine_extra.live_readings(s.world, mid, now)
        row = {"id": mid, "status": m["status"], "health": m["health"], "kw": round(lv["kw"], 1),
               "rate": lv["rate"] if mm.cycle_s else None}
        for sp in mm.sensors[:2]:
            row[sp.key] = round(lv[sp.key], 2)
        live.append(row)
    try:
        focus = watch.detect(s)
    except Exception:  # the live view must never stop because of the watcher
        focus = None
    return {"now": now, "machines": live, "plants": snap["plants"], "counts": snap["counts"], "session": _session_info(s),
            "_focus": focus}


@app.get("/api/stream")
async def stream(request: Request):
    s = S(request)

    async def gen():
        yield "retry: 3000\n\n"
        while True:
            if await request.is_disconnected():
                break
            data = await asyncio.to_thread(_tick, s)
            focus = data.pop("_focus", None)
            if focus:
                watch.launch(s, focus)
            data["watch"] = s.watch_events[-8:]
            yield f"event: tick\ndata: {T.dumps(data)}\n\n"
            await asyncio.sleep(2.0)
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


_TWIN_CACHE: dict = {}


@app.get("/api/twin")
async def twin_at(request: Request, at: float, mode: str = "plan"):
    """The plant at any moment from 3 days back to 3 days ahead. Ahead: with the approved plan, or if nothing is done
    from now on (approved actions that have not started yet are left out)."""
    s = S(request)
    now = s.world.now()
    at = max(now - 72 * H, min(at, now + 72 * H))
    mode = "nothing" if mode == "nothing" and at > now else "plan"
    key = (s.id, s.world.version, int(at // 900), mode)
    if key in _TWIN_CACHE:
        return _TWIN_CACHE[key]
    w = s.world
    if mode == "nothing":
        w = whatif._clone(s.world)
        w.interventions = [iv for iv in w.interventions if iv.at <= now]

    def build():
        snap = plant_snapshot(w, at, key=f"{s.id}:{mode}")
        t = np.array([at])
        ms = []
        for m in snap["machines"]:
            mm = MACHINES[m["id"]]
            row = {"id": m["id"], "status": m["status"], "health": m["health"], "kw": m["kw"], "reasons": m["reasons"],
                   "rate": round(float(parts_rate(w, m["id"], t)[0]), 1) if mm.cycle_s else None}
            for sp in mm.sensors[:2]:
                row[sp.key] = m["readings"].get(sp.key, {}).get("value")
            ms.append(row)
        return {"at": at, "now": now, "mode": mode, "machines": ms, "plants": snap["plants"], "counts": snap["counts"]}
    out = _json(await asyncio.to_thread(build))
    if len(_TWIN_CACHE) > 400:
        _TWIN_CACHE.clear()
    _TWIN_CACHE[key] = out
    return out


@app.get("/api/decisions")
async def decisions(request: Request):
    return _json(list(reversed(S(request).decisions)))


@app.get("/api/machines/{machine_id}")
async def machine(request: Request, machine_id: str, hours: float = 48):
    s = S(request)
    mid = machine_id.upper()
    if mid not in MACHINES:
        raise HTTPException(404, "unknown machine")
    now = s.world.now()
    hours = max(6.0, min(hours, 168.0))

    def build():
        st = machine_state(s.world, mid, now, detail=True)
        m = MACHINES[mid]
        step = 300 if hours <= 48 else 900
        out = {"state": st, "series": {sp.key: series(s.world, mid, sp.key, now, hours, step) for sp in m.sensors},
               "power": [{"t": float(x), "v": round(float(v), 2)} for x, v in zip(np.arange(now - hours * H, now + 1, step),
                                                                                power_kw(s.world, mid, np.arange(now - hours * H, now + 1, step)))],
               "maintenance": T.run("maintenance_history", s, now, {"machine_id": mid})[0],
               "energy": ops.energy_machine(s.world, mid, now),
               "spc": ops.scrap_spc(s.world, mid, now, 48) if m.cycle_s else None,
               "inspections": [i for i in s.inspections if i["machine_id"] == mid][-5:],
               "cards": [c for c in s.cards.values() if c.get("machine_id") == mid][-5:],
               "work_orders": [w for w in s.work_orders.values() if w.get("machine_id") == mid][-5:]}
        if st.get("ttf_full"):
            out["forecast"] = signals.forecast_curve(st["ttf_full"], now, 96)
        if m.kind == "VMC":
            out["spares"] = T.run("spare_parts", s, now, {"part_no": "SPB-7014"})[0]
        return out
    return _json(await asyncio.to_thread(build))


@app.get("/api/orders")
async def orders(request: Request):
    s = S(request)
    now = s.world.now()

    def build():
        hist = erp.demand_history()
        return {"orders": T.run("order_book", s, now, {})[0]["orders"],
                "demand": {p: {"history": [r for r in hist if r["product"] == p][-28:], "forecast": erp.forecast(hist, p)} for p in PRODUCTS},
                "spares": [T.run("spare_parts", s, now, {"part_no": pn})[0] for pn in SPARES]}
    return _json(await asyncio.to_thread(build))


@app.get("/api/energy")
async def energy(request: Request):
    s = S(request)
    now = s.world.now()

    def build():
        return {"machines": T.run("energy_ranking", s, now, {})[0]["machines"],
                "compressors": T.run("night_base_load", s, now, {})[0]["compressors"],
                "tariffs": {p: ops.tariff_windows(p, now, 36) for p in PLANTS},
                "plants": plant_snapshot(s.world, now, key=s.id)["plants"]}
    return _json(await asyncio.to_thread(build))


@app.get("/api/quality")
async def quality(request: Request):
    s = S(request)
    now = s.world.now()

    def build():
        return {"scrap": T.run("scrap_overview", s, now, {})[0], "lots": T.run("material_lots", s, now, {})[0]["lots"],
                "inspections": s.inspections[-12:], "samples": [{"name": k, "label": v, "url": f"/static/img/parts/{k}.jpg"}
                                                                for k, v in vision.SAMPLES.items()]}
    return _json(await asyncio.to_thread(build))


@app.get("/api/lines")
async def lines(request: Request):
    s = S(request)
    now = s.world.now()
    return _json(await asyncio.to_thread(lambda: [ops.line_oee(s.world, lid, now) for lid in LINES if LINES[lid].product]))


# ----------------------------------------------------------------------------------------------- Gemba walk

@app.post("/api/walk")
async def start_walk(request: Request):
    s = S(request)
    running = [w for w in s.walks.values() if w.status == "running"]
    if not running:
        if sum(1 for x in walk_mod.RUNNING if x.status == "running") >= limits.MAX_CONCURRENT_WALKS:
            raise HTTPException(429, "Several walks are running right now. Please try again in a minute.")
        _limit(request, "walk")
    w = walk_mod.start(s)
    return {"walk_id": w.id, "status": w.status}


@app.post("/api/walk/replay")
async def replay_walk(request: Request):
    w = walk_mod.replay(S(request))
    if not w:
        raise HTTPException(404, "No recorded walk is available yet.")
    return {"walk_id": w.id, "status": w.status, "recorded": True}


@app.get("/api/walk/latest")
async def latest_walk(request: Request):
    s = S(request)
    if not s.walks:
        return {"walk": None}
    w = list(s.walks.values())[-1]
    return _json({"walk": {"id": w.id, "status": w.status, "events": w.events, "plan": w.plan, "stats": w.stats}})


@app.get("/api/walk/{walk_id}/events")
async def walk_events(request: Request, walk_id: str):
    s = S(request)
    w = s.walks.get(walk_id)
    if not w:
        raise HTTPException(404, "unknown walk")
    q = w.subscribe()

    async def gen():
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if ev is None:
                    yield "event: done\ndata: {}\n\n"
                    break
                yield f"event: walk\ndata: {T.dumps(ev)}\n\n"
        finally:
            if q in w.queues:
                w.queues.remove(q)
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class Decision(BaseModel):
    name: str = Field("", max_length=60)
    note: str = Field("", max_length=300)
    when_h: dict = {}


def _name(n: str) -> str:
    n = " ".join((n or "").split())
    if len(n) < 2:
        raise HTTPException(400, "Type your name: every approval is recorded with a person's name.")
    return n


@app.get("/api/cards")
async def cards(request: Request):
    return _json(list(S(request).cards.values()))


@app.post("/api/cards/{card_id}/approve")
async def approve(request: Request, card_id: str, d: Decision):
    s = S(request)
    c = s.cards.get(card_id)
    if not c:
        raise HTTPException(404, "unknown card")
    if c["status"] != "proposed":
        raise HTTPException(409, f"card is already {c['status']}")
    try:
        wos = workorders.approve(s, c, _name(d.name), d.note, d.when_h)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _json({"card": c, "work_orders": wos})


@app.post("/api/cards/{card_id}/reject")
async def reject(request: Request, card_id: str, d: Decision):
    s = S(request)
    c = s.cards.get(card_id)
    if not c:
        raise HTTPException(404, "unknown card")
    if c["status"] != "proposed":
        raise HTTPException(409, f"card is already {c['status']}")
    if len(d.note.strip()) < 3:
        raise HTTPException(400, "Say why you reject it, so the agents learn what matters here.")
    workorders.reject(s, c, _name(d.name), d.note.strip())
    return _json({"card": c})


@app.get("/api/workorders")
async def list_workorders(request: Request):
    s = S(request)
    workorders.refresh(s)
    return _json(list(s.work_orders.values()))


class StepTick(BaseModel):
    step: int
    done: bool = True
    name: str = Field("", max_length=60)


@app.post("/api/workorders/{wo_id}/step")
async def wo_step(request: Request, wo_id: str, b: StepTick):
    s = S(request)
    wo = s.work_orders.get(wo_id)
    if not wo:
        raise HTTPException(404, "unknown work order")
    try:
        workorders.tick_step(s, wo, b.step, b.done, _name(b.name))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _json(wo)


class Complete(BaseModel):
    name: str = Field("", max_length=60)
    reading: float | None = None


@app.post("/api/workorders/{wo_id}/complete")
async def wo_complete(request: Request, wo_id: str, b: Complete):
    s = S(request)
    wo = s.work_orders.get(wo_id)
    if not wo:
        raise HTTPException(404, "unknown work order")
    try:
        workorders.complete(s, wo, _name(b.name), b.reading)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _json(wo)


@app.get("/api/audit")
async def audit(request: Request):
    return _json(list(reversed(S(request).audit[-200:])))


class WhatIf(BaseModel):
    actions: list
    horizon_h: float = 96


@app.post("/api/whatif")
async def what_if(request: Request, b: WhatIf):
    s = S(request)
    acts = [a for a in b.actions if isinstance(a, dict) and a.get("kind") in whatif.ACTION_KINDS][:6]
    if not acts:
        raise HTTPException(400, "no valid actions")
    return _json(await asyncio.to_thread(whatif.compare, s.world, acts, s.world.now(), max(24, min(b.horizon_h, 120))))


# ----------------------------------------------------------------------------------------------- ask, inspect, voice

class Ask(BaseModel):
    question: str = Field(..., max_length=600)
    history: list = []


@app.post("/api/ask")
async def ask(request: Request, b: Ask):
    _limit(request, "ask")
    try:
        return _json(await ask_agent.ask(S(request), b.question, b.history))
    except llm.LLMError as e:
        return JSONResponse({"answer": f"The model is unavailable right now ({e}). Try again in a moment.", "error": True}, status_code=503)


@app.post("/api/inspect")
async def inspect(request: Request, file: UploadFile | None = File(None), sample: str = ""):
    s = S(request)
    _limit(request, "inspect")
    if sample:
        if sample not in vision.SAMPLES:
            raise HTTPException(404, "unknown sample")
        res = await vision.inspect_sample(sample)
        mid = sample.split("-")[0].upper().replace("VMC", "VMC-").replace("DIE", "DIE-")
    elif file is not None:
        data = await file.read()
        if len(data) > 6 * 1024 * 1024:
            raise HTTPException(413, "photo too large (max 6 MB)")
        mime = file.content_type or "image/jpeg"
        if mime not in ("image/jpeg", "image/png", "image/webp"):
            raise HTTPException(415, "use a JPEG, PNG or WebP photo")
        try:
            res = await vision.inspect_image(base64.b64encode(data).decode(), mime, "The photo was uploaded by a person at the quality station.")
        except (llm.LLMError, ValueError) as e:
            raise HTTPException(503, f"vision model unavailable: {e}")
        mid = ""
    else:
        raise HTTPException(400, "send a photo or choose a sample")
    s.inspections.append({"t": s.world.now(), "machine_id": mid, "by": "Quality station", **{k: res.get(k) for k in (
        "defect", "confidence", "severity", "image_url", "model", "fallback")}})
    s.log("Quality station", "Inspected a part photo", f"{res.get('defect')} ({res.get('confidence', 0):.0%})", kind="agent")
    return _json(res)


class Voice(BaseModel):
    text: str = Field("", max_length=500)
    lang: str = "hi"
    wo_id: str = ""
    audio: dict | None = None


@app.post("/api/voice")
async def voice_answer(request: Request, b: Voice):
    s = S(request)
    _limit(request, "voice")
    if not b.text and not (b.audio and b.audio.get("data")):
        raise HTTPException(400, "say or type a question")
    wo = s.work_orders.get(b.wo_id) if b.wo_id else None
    try:
        return _json(await voice.answer(s, wo, b.text, b.lang, b.audio))
    except llm.LLMError as e:
        raise HTTPException(503, f"model unavailable: {e}")


# ----------------------------------------------------------------------------------------------- presenter controls

class Jump(BaseModel):
    hours: float


@app.post("/api/presenter/jump")
async def jump(request: Request, b: Jump):
    s = S(request)
    h = max(0.25, min(b.hours, 48.0))
    if s.world.offset_s + h * H > 6 * 24 * H:
        raise HTTPException(400, "the demo covers six days ahead; reset to start again")
    s.world.offset_s += h * H
    s.world.touch()
    s.log("Presenter", f"Moved the clock forward {h:g} h", kind="system")
    return {"offset_h": round(s.world.offset_s / H, 2), "now": s.world.now()}


class Inject(BaseModel):
    scenario: str


@app.post("/api/presenter/inject")
async def inject(request: Request, b: Inject):
    s = S(request)
    if b.scenario not in INJECTABLE:
        raise HTTPException(404, "unknown scenario")
    if not _inject(s, b.scenario):
        raise HTTPException(409, "already injected")
    return {"injected": [x.id for x in s.world.extra_scenarios]}


class Speed(BaseModel):
    speed: float = 1


@app.post("/api/presenter/speed")
async def set_speed(request: Request, b: Speed):
    s = S(request)
    sp = 60 if b.speed >= 60 else 10 if b.speed >= 10 else 1
    s.world.set_speed(sp)
    s.world.touch()
    s.log("Presenter", f"Simulation speed set to {sp}×", kind="system")
    return {"speed": sp}


class Drill(BaseModel):
    scenario: str
    delay_s: float = 30


@app.post("/api/presenter/drill")
async def drill(request: Request, b: Drill):
    s = S(request)
    if b.scenario not in INJECTABLE:
        raise HTTPException(404, "unknown drill")
    if any(x.id == INJECTABLE[b.scenario].id for x in s.world.extra_scenarios) or any(
            d["scenario"] == b.scenario and d["status"] != "planned" for d in s.drills):
        raise HTTPException(409, "this drill is already running in your plant; reset the demo to run it again")
    delay = max(5.0, min(float(b.delay_s), 300.0))
    d = {"id": len(s.drills) + 1, "scenario": b.scenario, "label": DRILL_LABELS[b.scenario], "target": INJECTABLE[b.scenario].target,
         "due_at": time.time() + delay, "status": "pending"}
    s.drills.append(d)
    s.log("Presenter", f"Drill scheduled: {d['label']}", f"fault starts in {delay:.0f} s", kind="system")
    return {"due_in_s": round(delay), "label": d["label"], "id": d["id"]}


@app.post("/api/presenter/reset")
async def reset(request: Request):
    s = sessions.reset(S(request).id)
    return {"ok": True, "session": s.id}
