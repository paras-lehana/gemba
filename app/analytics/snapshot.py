"""One call that answers "how is the company right now": every machine's condition plus line and plant KPIs.

Used by the control room, the live stream and the agents' `plant_overview` tool. Results are cached per world version
and minute, because a dozen browser tabs and six agents ask the same question within seconds.
"""
import time
import numpy as np

from ..sim.catalog import LINES, MACHINES, PLANTS
from ..sim.plant import H, World, hourly, is_down, planned, power_kw, running_fraction, sensor
from . import anomaly, ops, signals

_CACHE: dict = {}


def machine_state(world: World, machine_id: str, now: float, detail: bool = False) -> dict:
    m = MACHINES[machine_id]
    t = np.array([now])
    read = signals.readings(world, machine_id, now)
    faults = signals.sensor_faults(world, machine_id, now)
    has_vib = "vib" in read
    an = anomaly.score(world, machine_id, now) if has_vib else None
    hl = signals.health(world, machine_id, now, an or 0.0)
    ttf = signals.time_to_trip(world, machine_id, now) if has_vib else None
    down = bool(is_down(world, machine_id, t)[0])
    is_planned = bool(planned(m, t)[0] > 0)
    running = bool(running_fraction(m, t)[0] > 0.2) and not down
    zone = signals.zone(read["vib"]["value"]) if has_vib and running else None
    hrs = hourly(world, machine_id, now - 24 * H, now) if m.cycle_s else None
    scrap_pct = float(100 * hrs["scrap"].sum() / hrs["parts"].sum()) if hrs is not None and hrs["parts"].sum() > 1 else None
    over_alarm = [k for k, r in read.items() if r["value"] >= r["alarm"] and r["alarm"] > r["nominal"]]
    leak = ops.compressor_residual(world, machine_id, now) if m.kind == "COMPRESSOR" else None
    reasons = []
    if faults:
        status = "sensor"
        reasons.append(f"{faults[0]['label']} frozen at {faults[0]['value']} for {faults[0]['hours']} h")
    elif down and (rep := world.last("repair", machine_id, now)) is not None and now < rep.at + 4 * H:
        status = "repair"
        reasons.append(f"planned repair, approved by {rep.by}")
    elif down:
        status = "down"
        reasons.append("stopped: tripped on vibration")
        hl = {"score": 0, "breakdown": [{"key": "tripped", "penalty": 100}]}
    elif over_alarm or (ttf and ttf["to_trip_h"]["p50"] < 96):
        status = "alarm"
        if ttf:
            reasons.append(f"about {round(ttf['to_trip_h']['p50'])} h to trip")
        reasons += [f"{read[k]['label']} above alarm" for k in over_alarm]
    elif (zone and zone["zone"] in ("C", "D")) or (an or 0) > 0.985 or (scrap_pct or 0) > 2.0 or (leak and leak["extra_kw"] > 3):
        status = "watch"
        if leak and leak["extra_kw"] > 3:
            reasons.append(f"draws {leak['extra_kw']} kW more than the load explains (possible air leak)")
        if zone and zone["zone"] in ("C", "D"):
            reasons.append(f"vibration zone {zone['zone']}")
        if (scrap_pct or 0) > 2.0:
            reasons.append(f"scrap {scrap_pct:.1f} %")
        if (an or 0) > 0.985:
            reasons.append("unusual sensor pattern")
    elif not is_planned:
        status = "idle"
    else:
        status = "ok"
    out = {"id": machine_id, "name": m.name, "kind": m.kind, "plant": m.plant, "line": m.line, "criticality": m.criticality,
           "pos": m.pos, "status": status, "reasons": reasons, "running": running, "planned": is_planned,
           "health": hl["score"], "anomaly": an, "zone": zone, "faults": faults,
           "ttf": ({k: v for k, v in ttf.items() if k != "curve"} if ttf else None),
           "readings": {k: {"value": r["value"], "unit": r["unit"]} for k, r in read.items()},
           "kw": round(float(power_kw(world, machine_id, t)[0]), 1),
           "scrap_24h_pct": round(scrap_pct, 2) if scrap_pct is not None else None,
           "good_24h": round(float(hrs["good"].sum())) if hrs is not None else None}
    if detail:
        out["readings"] = read
        out["health_breakdown"] = hl["breakdown"]
        out["ttf_full"] = ttf
    return out


def plant_snapshot(world: World, now: float | None = None, key: str = "") -> dict:
    now = now if now is not None else world.now()
    ck = (key, id(world), world.version, int(now // 30))
    if ck in _CACHE:
        return _CACHE[ck]
    t0 = time.time()
    machines = [machine_state(world, mid, now) for mid in MACHINES]
    lines = [ops.line_oee(world, lid, now) for lid in LINES if LINES[lid].product]
    plants = []
    for pid, p in PLANTS.items():
        ms = [m for m in machines if m["plant"] == pid]
        kw = sum(m["kw"] for m in ms)
        pl = [l for l in lines if l["plant"] == pid]
        good = sum(l["good_24h"] for l in pl)
        oee_w = sum(l["oee"] * l["parts_24h"] for l in pl) / max(1, sum(l["parts_24h"] for l in pl))
        plants.append({"id": pid, "name": p.name, "country": p.country, "tz": p.tz, "currency": p.currency, "kw_now": round(kw),
                       "co2e_kg_h": round(kw * p.grid_kg_co2_per_kwh), "good_24h": good, "oee": round(oee_w, 3),
                       "alerts": sum(1 for m in ms if m["status"] in ("alarm", "down", "sensor")),
                       "watch": sum(1 for m in ms if m["status"] == "watch")})
    snap = {"now": now, "machines": machines, "lines": lines, "plants": plants,
            "counts": {s: sum(1 for m in machines if m["status"] == s) for s in ("ok", "watch", "alarm", "down", "sensor", "idle", "repair")},
            "compute_ms": round(1000 * (time.time() - t0))}
    if len(_CACHE) > 200:
        _CACHE.clear()
    _CACHE[ck] = snap
    return snap


def series(world: World, machine_id: str, key: str, now: float, hours: float = 24, step: float = 300) -> list:
    """Sensor history for charts, [{t, v}]."""
    ts = np.arange(now - hours * H, now + 1, step)
    vals = sensor(world, machine_id, key, ts)
    return [{"t": float(a), "v": round(float(b), 3)} for a, b in zip(ts, vals)]
