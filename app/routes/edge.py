"""Edge probe (phone sensors), MTConnect stream and a tag mapper for brownfield machines.

- GET /probe serves a phone page that turns the microphone and the accelerometer into a vibration sensor. Its frames
  arrive at POST /api/edge/ingest; four loud frames in a row inject the VMC-202 bearing-wear story into the visitor's
  session, so Gemba Watch picks it up like a real alarm. The phone is real; the machine it is "attached to" is simulated.
- GET /api/mtconnect/current and /api/mtconnect/probe speak MTConnect 2.0 (Streams and Devices documents), built from the
  simulator's live readings, so a reader can see what a standards-based CNC connection would deliver.
- POST /api/mtconnect/map asks Gemini to map cryptic PLC/CNC tag names to Gemba's canonical names (rules fallback).
"""
import asyncio
import pathlib
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from ..agents import llm
from ..analytics import signals
from ..analytics.snapshot import machine_state
from ..sim.catalog import MACHINES, PLANTS
from ..sim.plant import INJECTABLE
from ..store import limits

router = APIRouter()
ROOT = pathlib.Path(__file__).resolve().parent.parent.parent

# A phone frame counts as "hot" above these levels. Vibration is the RMS of acceleration without gravity (m/s^2): a phone
# lying on a desk reads about 0.05, one held against a running fan or shaken by hand reads 2-10. Sound is the RMS of the
# microphone signal (0..1 full scale): a quiet room is about 0.01, a loud machine or a phone speaker close by 0.2+.
VIB_LIMIT = 1.8
SOUND_LIMIT = 0.2
HOT_FRAMES = 4
EDGE_SCENARIO = {"VMC-202": "bearing_wear_vmc202"}      # machines whose simulated fault a phone can trigger


# ----------------------------------------------------------------------------------------------- phone edge probe

@router.get("/probe", include_in_schema=False)
async def probe_page():
    return FileResponse(ROOT / "static" / "probe.html", headers={"Cache-Control": "no-cache"})


class EdgeFrame(BaseModel):
    machine_id: str = Field("VMC-202", max_length=16)
    dominant_hz: float = Field(0, ge=0, le=24000)
    sound_rms: float = Field(0, ge=0, le=10)
    vibration_rms: float = Field(0, ge=0, le=500)
    source: str = Field("LIVE_MOBILE_EDGE", max_length=32)


def _edge(s) -> dict:
    e = getattr(s, "edge", None)
    if e is None:
        e = {"machine_id": "VMC-202", "last": None, "frames": 0, "last_at": None, "triggered": False, "hot": 0,
             "peak_vib": 0.0, "peak_sound": 0.0, "history": [], "triggered_at": None}
        s.edge = e
    return e


def _public(e: dict) -> dict:
    return {k: v for k, v in e.items() if k != "history"} | {"history": e["history"][-40:]}


@router.post("/api/edge/ingest")
async def edge_ingest(request: Request, b: EdgeFrame):
    s = request.state.session
    if b.machine_id not in MACHINES:
        raise HTTPException(404, "unknown machine")
    e = _edge(s)
    if e["machine_id"] != b.machine_id:          # re-attached to another machine: start counting again
        e.update(machine_id=b.machine_id, hot=0, triggered=False, triggered_at=None)
    payload = b.model_dump()
    e["last"] = payload
    e["frames"] += 1
    e["last_at"] = time.time()
    e["peak_vib"] = round(max(e["peak_vib"], b.vibration_rms), 3)
    e["peak_sound"] = round(max(e["peak_sound"], b.sound_rms), 3)
    e["history"] = (e["history"] + [[round(e["last_at"], 2), round(b.vibration_rms, 3), round(b.sound_rms, 4),
                                     round(b.dominant_hz, 1)]])[-120:]
    hot = b.vibration_rms > VIB_LIMIT or b.sound_rms > SOUND_LIMIT
    e["hot"] = e["hot"] + 1 if hot else 0
    note = ""
    if e["hot"] >= HOT_FRAMES and not e["triggered"]:
        key = EDGE_SCENARIO.get(b.machine_id)
        if key is None:
            note = f"{b.machine_id} has no simulated fault a phone can trigger; readings are recorded only."
        else:
            sc = INJECTABLE[key]
            if not any(x.id == sc.id for x in s.world.extra_scenarios):
                s.world.extra_scenarios.append(sc.injected(s.world.now()))
                s.world.touch()
            e["triggered"] = True
            e["triggered_at"] = time.time()
            s.log("Edge probe", f"Phone sensor crossed the limit on {b.machine_id}",
                  f"{HOT_FRAMES} frames in a row: vibration {b.vibration_rms:.2f} m/s² (limit {VIB_LIMIT}), sound "
                  f"{b.sound_rms:.3f} (limit {SOUND_LIMIT}), {b.dominant_hz:.0f} Hz. Simulated {sc.kind.replace('_', ' ')} "
                  f"started on {sc.target}.", kind="system", ref=b.machine_id)
            note = f"Limit crossed {HOT_FRAMES} times in a row: Gemba now treats {b.machine_id} as wearing its bearing."
    return {"ok": True, "frames": e["frames"], "triggered": e["triggered"], "hot": e["hot"], "hot_needed": HOT_FRAMES,
            "limits": {"vibration_rms": VIB_LIMIT, "sound_rms": SOUND_LIMIT}, "note": note, "session": s.id[:6]}


@router.get("/api/edge/status")
async def edge_status(request: Request, machine: str | None = None):
    """What the phone last sent, plus how Gemba currently sees the machine it is attached to (for the phone page)."""
    s = request.state.session
    e = getattr(s, "edge", None)
    out = _public(e) if e else {"machine_id": "VMC-202", "last": None, "frames": 0, "last_at": None, "triggered": False}
    out["connected"] = bool(e and e["last_at"] and time.time() - e["last_at"] < 5)
    out["limits"] = {"vibration_rms": VIB_LIMIT, "sound_rms": SOUND_LIMIT, "frames": HOT_FRAMES}
    mid = machine if machine in MACHINES else out["machine_id"]
    st = await asyncio.to_thread(machine_state, s.world, mid, s.world.now())
    out["machine"] = {"id": mid, "status": st["status"], "reasons": st["reasons"], "health": st["health"],
                      "can_trigger": mid in EDGE_SCENARIO}
    out["session"] = s.id[:6]
    return out


@router.get("/api/edge/link")
async def edge_link(request: Request, machine: str = "VMC-202"):
    """The link a phone opens to join this visitor's demo (the main app can show it as text or a QR code)."""
    s = request.state.session
    base = str(request.base_url).rstrip("/")
    proto = request.headers.get("x-forwarded-proto")
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if proto and host:
        base = f"{proto}://{host}"
    return {"sid": s.id, "path": f"/probe?sid={s.id}&machine={machine}", "url": f"{base}/probe?sid={s.id}&machine={machine}"}


# ----------------------------------------------------------------------------------------------- MTConnect

NS_STREAMS = "urn:mtconnect.org:MTConnectStreams:2.0"
NS_DEVICES = "urn:mtconnect.org:MTConnectDevices:2.0"
NS_X = "urn:aidhunik.com:gemba:2.0"          # extension namespace for data items MTConnect does not define (vibration RMS)
INSTANCE_ID = "1729000000"


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"


def _uuid(mid: str) -> str:
    return f"MER-{MACHINES[mid].plant}-{mid.replace('-', '')}"


def _xml(root) -> Response:
    ET.indent(root, "  ")
    body = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")
    return Response(body, media_type="application/xml", headers={"Cache-Control": "no-store"})


def _header(root, now: float, extra: dict | None = None):
    seq = int(now) % 10_000_000
    attrs = {"creationTime": _iso(time.time()), "sender": "GEMBA-SIMULATED-AGENT", "instanceId": INSTANCE_ID,
             "version": "2.0.0.1", "bufferSize": "131072", "assetBufferSize": "1024", "assetCount": "0"}
    if extra is not None:
        attrs |= {"firstSequence": str(max(1, seq - 131072)), "lastSequence": str(seq), "nextSequence": str(seq + 1)}
    ET.SubElement(root, "Header", attrs)
    return seq


CONDITION = {"ok": "Normal", "idle": "Normal", "watch": "Warning", "alarm": "Warning", "down": "Fault", "sensor": "Fault",
             "repair": "Normal"}
EXECUTION = {"ok": "ACTIVE", "watch": "ACTIVE", "alarm": "ACTIVE", "sensor": "ACTIVE", "idle": "READY", "down": "STOPPED",
             "repair": "INTERRUPTED"}


def _current_xml(world, mid: str, now: float):
    m = MACHINES[mid]
    st = machine_state(world, mid, now)
    read = signals.readings(world, mid, now)
    status = st["status"]
    ET.register_namespace("", NS_STREAMS)
    ET.register_namespace("x", NS_X)
    root = ET.Element(f"{{{NS_STREAMS}}}MTConnectStreams")
    seq = _header(root, now, extra={})
    ts = _iso(now)
    n = iter(range(seq - 40, seq + 1))

    def item(parent, tag, did, value, **attrs):
        el = ET.SubElement(parent, tag, {"dataItemId": did, "timestamp": ts, "sequence": str(next(n)), **attrs})
        el.text = str(value)
        return el

    streams = ET.SubElement(root, "Streams")
    ds = ET.SubElement(streams, "DeviceStream", {"name": mid, "uuid": _uuid(mid)})
    dev = ET.SubElement(ds, "ComponentStream", {"component": "Device", "name": mid, "componentId": f"{mid}_dev"})
    ev = ET.SubElement(dev, "Events")
    item(ev, "Availability", f"{mid}_avail", "UNAVAILABLE" if status == "repair" else "AVAILABLE")

    if "rpm" in read or "amps" in read:
        rot = ET.SubElement(ds, "ComponentStream", {"component": "Rotary", "name": "C", "componentId": f"{mid}_c"})
        smp = ET.SubElement(rot, "Samples")
        if "rpm" in read:
            item(smp, "RotaryVelocity", f"{mid}_sspeed", round(read["rpm"]["value"]), subType="ACTUAL")
        if "amps" in read:      # spindle load in percent, derived from motor current against its trip level
            load = 100 * read["amps"]["value"] / max(read["amps"]["trip"], 1e-6)
            item(smp, "Load", f"{mid}_sload", round(load, 1))
    sens_keys = [k for k in read if k not in ("rpm", "amps")]
    if sens_keys:
        sen = ET.SubElement(ds, "ComponentStream", {"component": "Sensor", "name": "sensor1", "componentId": f"{mid}_sensor"})
        smp = ET.SubElement(sen, "Samples")
        for k in sens_keys:
            v = read[k]["value"]
            if k == "temp":
                item(smp, "Temperature", f"{mid}_temp", v)
            elif k == "vib":
                item(smp, f"{{{NS_X}}}VibrationVelocityRMS", f"{mid}_vib", v)
            elif k == "press":
                item(smp, "Pressure", f"{mid}_press", round(v * 100000))
        cond = ET.SubElement(sen, "Condition")
        level = CONDITION.get(status, "Unavailable")
        attrs = {"type": "SYSTEM"}
        text = None
        if status == "sensor" and st["faults"]:
            f = st["faults"][0]
            attrs = {"type": "SYSTEM", "nativeCode": "SNS-FRZ"}
            text = f"{f['label']} frozen at {f['value']} for {f['hours']} h (instrument fault, not the machine)"
        elif level in ("Warning", "Fault"):
            hi = [kk for kk, r in read.items() if r["value"] >= r["alarm"] and r["alarm"] > r["nominal"]]
            trend = st.get("ttf") is not None and "vib" in read and any("trip" in r for r in st["reasons"])
            key = hi[0] if hi else ("vib" if trend else None)
            attrs = {"type": {"vib": "x:VIBRATION", "temp": "TEMPERATURE", "press": "PRESSURE"}.get(key, "SYSTEM"),
                     "nativeCode": {"vib": "ALM-7014", "temp": "ALM-7020", "press": "ALM-7030"}.get(key, "ALM-7000")}
            if hi:
                attrs["qualifier"] = "HIGH"
            text = "; ".join(st["reasons"]) or status
        el = ET.SubElement(cond, level, {"dataItemId": f"{mid}_cond", "timestamp": ts, "sequence": str(next(n)), **attrs})
        if text:
            el.text = text
    ctl = ET.SubElement(ds, "ComponentStream", {"component": "Controller", "name": "controller", "componentId": f"{mid}_ctl"})
    ev = ET.SubElement(ctl, "Events")
    item(ev, "Execution", f"{mid}_exec", EXECUTION.get(status, "READY"))
    item(ev, "ControllerMode", f"{mid}_mode", "MANUAL" if status in ("repair", "down") else "AUTOMATIC")
    if m.cycle_s:
        item(ev, "Program", f"{mid}_prog", f"O{1000 + int(mid[-3:]) % 1000:04d} ({m.product})")
    return root


@router.get("/api/mtconnect/current")
async def mtconnect_current(request: Request, machine: str = "VMC-204"):
    if machine not in MACHINES:
        raise HTTPException(404, "unknown machine")
    s = request.state.session
    root = await asyncio.to_thread(_current_xml, s.world, machine, s.world.now())
    return _xml(root)


def _di(parent, did, category, typ, units=None, sub=None, name=None):
    a = {"id": did, "category": category, "type": typ}
    if units:
        a["units"] = units
    if sub:
        a["subType"] = sub
    if name:
        a["name"] = name
    return ET.SubElement(parent, "DataItem", a)


@router.get("/api/mtconnect/probe")
async def mtconnect_probe(request: Request, plant: str = "PUN"):
    if plant not in PLANTS:
        raise HTTPException(404, "unknown plant")
    s = request.state.session
    ET.register_namespace("", NS_DEVICES)
    root = ET.Element(f"{{{NS_DEVICES}}}MTConnectDevices")
    _header(root, s.world.now())
    devs = ET.SubElement(root, "Devices")
    for mid, m in MACHINES.items():
        if m.plant != plant:
            continue
        keys = [sp.key for sp in m.sensors]
        d = ET.SubElement(devs, "Device", {"id": mid, "name": mid, "uuid": _uuid(mid)})
        desc = ET.SubElement(d, "Description", {"manufacturer": "Simulated (Gemba demo)", "model": m.kind})
        desc.text = f"{m.name}, {PLANTS[plant].name} (fictional plant, simulated data)"
        dis = ET.SubElement(d, "DataItems")
        _di(dis, f"{mid}_avail", "EVENT", "AVAILABILITY")
        comps = ET.SubElement(d, "Components")
        if "rpm" in keys or "amps" in keys:
            axes = ET.SubElement(comps, "Axes", {"id": f"{mid}_axes"})
            ac = ET.SubElement(axes, "Components")
            rot = ET.SubElement(ac, "Rotary", {"id": f"{mid}_c", "name": "C"})
            rd = ET.SubElement(rot, "DataItems")
            if "rpm" in keys:
                _di(rd, f"{mid}_sspeed", "SAMPLE", "ROTARY_VELOCITY", "REVOLUTION/MINUTE", "ACTUAL")
            if "amps" in keys:
                _di(rd, f"{mid}_sload", "SAMPLE", "LOAD", "PERCENT")
        other = [k for k in keys if k not in ("rpm", "amps")]
        if other:
            sen = ET.SubElement(comps, "Sensor", {"id": f"{mid}_sensor", "name": "sensor1"})
            sd = ET.SubElement(sen, "DataItems")
            for k in other:
                if k == "temp":
                    _di(sd, f"{mid}_temp", "SAMPLE", "TEMPERATURE", "CELSIUS")
                elif k == "vib":
                    _di(sd, f"{mid}_vib", "SAMPLE", "x:VIBRATION_VELOCITY_RMS", "MILLIMETER/SECOND")
                elif k == "press":
                    _di(sd, f"{mid}_press", "SAMPLE", "PRESSURE", "PASCAL")
            _di(sd, f"{mid}_cond", "CONDITION", "SYSTEM")
        ctl = ET.SubElement(comps, "Controller", {"id": f"{mid}_ctl", "name": "controller"})
        cd = ET.SubElement(ctl, "DataItems")
        _di(cd, f"{mid}_exec", "EVENT", "EXECUTION")
        _di(cd, f"{mid}_mode", "EVENT", "CONTROLLER_MODE")
        if m.cycle_s:
            _di(cd, f"{mid}_prog", "EVENT", "PROGRAM")
    return _xml(root)


# ----------------------------------------------------------------------------------------------- tag mapper

CANONICAL = {
    "spindle_rpm": "Spindle speed in revolutions per minute",
    "bearing_temp_c": "Spindle bearing temperature in °C",
    "vibration_rms": "Vibration level (RMS), mm/s or g",
    "motor_current_a": "Spindle motor current in amperes",
    "coolant_pressure_bar": "Coolant pump pressure in bar",
    "part_count": "Parts made counter",
}
_RULES = [
    ("spindle_rpm", r"rpm|rotaryvelocity|sp_?spd|spindle_?speed|s_?act|actspeed|speed|velocity|\bS1\b|rdspeed", 0.75),
    ("bearing_temp_c", r"temp|tmp|therm|brg_?t|_degc|\bTC\d", 0.7),
    ("vibration_rms", r"vib|accel|acc_|rms|chatter|displac|velocityrms", 0.7),
    ("motor_current_a", r"amp|current|curr|i_?mot|load|torque|amperage", 0.6),
    ("coolant_pressure_bar", r"cool|clnt|press|bar\b|pump", 0.6),
    ("part_count", r"count|cnt|parts?_|partcount|pcs|piece|m30", 0.65),
]


_ADDRESS = [
    (r"^DB\d+\.DB[DWXB]\d+", "a Siemens S7 address (data block, then the byte where the value sits); it holds a number but its "
     "name does not say which, so check the PLC's symbol table or watch it change during a short test"),
    (r"^(PMC_?)?[GFXYRDK]\d{3,4}(\.\d)?$", "a FANUC PMC address (G/F = signals to and from the CNC, X/Y = wiring, R/D = "
     "internal memory); look it up in the machine builder's ladder list"),
    (r"^[34]\d{4}$", "a Modbus register number; the device's register map says what it holds"),
]


def _rules_map(tags: list) -> list:
    out = []
    for t in tags:
        hit = next(((c, conf) for c, rx, conf in _RULES if re.search(rx, t, re.I)), None)
        if hit:
            d = CANONICAL[hit[0]]
            out.append({"tag": t, "canonical": hit[0], "confidence": hit[1],
                        "why": f"the name contains a common abbreviation for {d[0].lower() + d[1:]}"})
        else:
            addr = next((why for rx, why in _ADDRESS if re.search(rx, t, re.I)), None)
            out.append({"tag": t, "canonical": None, "confidence": 0.0,
                        "why": f"This is {addr}." if addr else "No recognisable words in the name; a short live test on the machine can tell."})
    return out


class MapReq(BaseModel):
    tags: list[str] = Field(..., min_length=1, max_length=20)


MAP_SCHEMA = {"type": "object", "properties": {"mapped": {"type": "array", "items": {"type": "object", "properties": {
    "tag": {"type": "string"}, "canonical": {"type": ["string", "null"]}, "confidence": {"type": "number"},
    "why": {"type": "string"}}, "required": ["tag", "canonical", "confidence", "why"]}}}, "required": ["mapped"]}


@router.post("/api/mtconnect/map")
async def mtconnect_map(request: Request, b: MapReq):
    msg = limits.check(request, "ask")
    if msg:
        raise HTTPException(429, msg)
    tags = [t.strip()[:64] for t in b.tags if t.strip()][:20]
    if not tags:
        raise HTTPException(400, "give at least one tag name")
    prompt = (
        "You onboard a brownfield machine tool (CNC machining centre with a PLC). Map each raw controller tag name to one "
        f"canonical signal: {', '.join(f'{k} ({v})' for k, v in CANONICAL.items())}. Use what you know about Siemens S7 "
        "addresses (DB10.DBD4 = data block 10, double word at byte 4), FANUC PMC addresses (G, F, X, Y, R, D areas), MTConnect "
        "data item names and common OEM abbreviations. If a tag cannot be identified from its name alone, set canonical to "
        "null and say what a technician should check. Confidence 0..1, honest: bare addresses are rarely above 0.5. "
        "Answer with JSON only: {\"mapped\": [{\"tag\", \"canonical\", \"confidence\", \"why\"}]}, one entry per tag in order, "
        "why in one short plain-English sentence a beginner understands.\n\nTags:\n" + "\n".join(tags))
    t0 = time.time()
    try:
        r = await llm.chat([{"role": "user", "content": prompt}], role="agent", temperature=0.1, json_schema=MAP_SCHEMA)
        data = llm.parse_json(r.content)
        rows = {str(x.get("tag")): x for x in data.get("mapped", []) if isinstance(x, dict)}
        mapped = []
        for t in tags:
            x = rows.get(t) or {}
            c = x.get("canonical")
            c = c if c in CANONICAL else None
            conf = float(x.get("confidence") or 0)
            mapped.append({"tag": t, "canonical": c, "confidence": round(max(0.0, min(1.0, conf if c else min(conf, 0.3))), 2),
                           "why": str(x.get("why") or "")[:240]})
        src, model = "gemini", r.model
    except (llm.LLMError, ValueError, TypeError, AttributeError):
        mapped, src, model = _rules_map(tags), "rules", None
    s = request.state.session
    s.log("Tag mapper", f"Mapped {len(tags)} controller tags", f"by {'Gemini' if src == 'gemini' else 'the rules fallback'}",
          kind="agent" if src == "gemini" else "system")
    return {"mapped": mapped, "source": src, "model": model, "ms": int((time.time() - t0) * 1000),
            "canonical": CANONICAL,
            "note": "A person confirms each mapping before it is used; low-confidence rows need a quick live test on the machine."}
