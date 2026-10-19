"""Machine 360 extras: what waiting costs (cost of delay) for one machine, and live readings every 2 s.

GET /api/machines/{machine_id}/delay-cost?hours=H compares three futures over the next 96 h with the simulator
(app.analytics.whatif.compare, never the language model): fix it now, fix it in H hours, or do nothing. It turns the
difference into good parts lost, scrap, machine-hours stopped, energy, labour and money (USD), and explains each number
in plain sentences for people who have never worked in a factory.
"""
import asyncio
import math

import numpy as np
from fastapi import APIRouter, HTTPException, Request

from ..analytics import whatif
from ..sim.catalog import LINES, MACHINES, PLANTS, PRODUCTS
from ..sim.plant import H, REPAIR_HOURS, TZ_OFFSET, bearing_level, leak_kw, parts_rate, power_kw, sensor, stuck

router = APIRouter()

HORIZON_H = 96.0
# Labour assumptions shown to the visitor (fictional plant, plausible Indian shop-floor rates in USD).
TECH_RATE = 9.0          # technician, normal shift, per hour
OVERTIME_RATE = 13.5     # technician outside 06:00-22:00 local or called out after a trip, per hour
OPERATOR_IDLE = 6.0      # machine operator waiting, per hour
DAY_START, DAY_END = 6, 22
JOB = {   # action kind -> (technicians, hours, who, what a person reads)
    "repair": (1, REPAIR_HOURS, "maintenance technician", "replace the worn spindle bearing"),
    "fix_leak": (1, 2.0, "maintenance technician", "find and fix the compressed-air leak"),
    "recalibrate": (1, 1.0, "instrument technician", "replace or recalibrate the frozen sensor"),
}
PLURAL = {"CH-15": "cylinder heads", "CRK-T4": "crankshafts", "GR-6": "gear sets", "BRK-22": "brackets", "GH-7": "gear housings"}
TRIP_CREW, TRIP_CREW_H, TRIP_WAIT_H, TRIP_OPERATORS = 2, 6.0, 4.0, 3


def _local_hour(plant: str, t: float) -> float:
    return ((t + TZ_OFFSET[PLANTS[plant].tz]) % 86400) / H


def _fmt_local(plant: str, t: float) -> str:
    lt = t + TZ_OFFSET[PLANTS[plant].tz]
    days = ("Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed")      # 1970-01-01 was a Thursday
    return f"{days[int(lt // 86400) % 7]} {int(lt % 86400 // 3600):02d}:{int(lt % 3600 // 60):02d}"


def _fault(world, mid: str, now: float):
    """Which fix applies to this machine right now: repair (wear trend), fix_leak, recalibrate, or None."""
    m = MACHINES[mid]
    t = np.array([now])
    if any(s.key == "vib" for s in m.sensors) and any(sc.kind == "bearing_wear" and sc.target == mid for sc in world.scenarios):
        if float(bearing_level(world, mid, t)[0]) > 0.05 or whatif.trip_time(world, mid, now, HORIZON_H) is not None:
            return "repair", None
    if m.kind == "COMPRESSOR" and float(leak_kw(world, mid, t)[0]) > 0:
        return "fix_leak", None
    for s in m.sensors:
        mask, val = stuck(world, mid, s.key, t)
        if mask is not None and bool(mask[0]):
            return "recalibrate", s
    return None, None


def _labour(kind: str, plant: str, start: float, tripped: bool) -> dict:
    """Labour for the fix itself, plus an emergency callout and idle operators when the machine trips first."""
    crew, hrs, who, _ = JOB[kind]
    night = not (DAY_START <= _local_hour(plant, start) < DAY_END)
    rate = OVERTIME_RATE if (night or tripped) else TECH_RATE
    if tripped:
        cost = TRIP_CREW * TRIP_CREW_H * OVERTIME_RATE + TRIP_OPERATORS * TRIP_WAIT_H * OPERATOR_IDLE
        note = (f"emergency callout: {TRIP_CREW} technicians x {TRIP_CREW_H:g} h at ${OVERTIME_RATE:g}/h overtime, "
                f"plus {TRIP_OPERATORS} operators waiting {TRIP_WAIT_H:g} h at ${OPERATOR_IDLE:g}/h")
        return {"usd": round(cost, 2), "person_h": TRIP_CREW * TRIP_CREW_H + TRIP_OPERATORS * TRIP_WAIT_H, "overtime": True, "note": note}
    return {"usd": round(crew * hrs * rate, 2), "person_h": crew * hrs, "overtime": rate == OVERTIME_RATE,
            "note": f"{crew} {who} x {hrs:g} h at ${rate:g}/h{' (overtime: outside 06:00-22:00)' if rate == OVERTIME_RATE else ''}"}


def _clean_world(world, mid: str, kind: str, now: float):
    """The visitor's world without fixes already planned for later on this machine, so 'do nothing' means nothing."""
    w = whatif._clone(world)
    w.interventions = [iv for iv in w.interventions if not (iv.target == mid and iv.kind == kind and iv.at > now)]
    return w


def delay_cost(world, mid: str, now: float, hours: float) -> dict:
    m = MACHINES[mid]
    plant = m.plant
    kind, sensor_spec = _fault(world, mid, now)
    line = LINES[m.line]
    base = {"machine_id": mid, "name": m.name, "plant": plant, "currency": "USD", "hours": hours, "horizon_h": HORIZON_H,
            "now_local": _fmt_local(plant, now)}
    if kind is None:
        return {**base, "action": None, "fault": None, "rows": [],
                "explanations": [f"{mid} has no open problem that a repair would fix, so waiting costs nothing today.",
                                 "This panel lights up when Gemba sees a wear trend, an air leak or a frozen sensor on this machine."],
                "assumptions": []}
    upcoming = [iv for iv in world.interventions if iv.target == mid and iv.kind == kind and iv.at > now]
    w = _clean_world(world, mid, kind, now)
    act = lambda h: [{"kind": kind, "target": mid, "when_h": h}]
    r_now = whatif.compare(w, act(0.0), now, HORIZON_H, watch=[mid])
    r_wait = r_now if hours <= 0 else whatif.compare(w, act(hours), now, HORIZON_H, watch=[mid])
    trip_nothing = (r_now["trip_h"].get(mid) or {}).get("do_nothing")
    trip_wait = (r_wait["trip_h"].get(mid) or {}).get("plan")
    tripped_before = trip_wait is not None and trip_wait < hours
    tripped_nothing = trip_nothing is not None

    price = PRODUCTS[m.product]["price"] if m.product else 0.0
    lab_now = _labour(kind, plant, now, False)
    lab_wait = _labour(kind, plant, now + hours * H, tripped_before)
    lab_nothing = ({"usd": round(TRIP_CREW * TRIP_CREW_H * OVERTIME_RATE + TRIP_OPERATORS * TRIP_WAIT_H * OPERATOR_IDLE, 2),
                    "person_h": TRIP_CREW * TRIP_CREW_H + TRIP_OPERATORS * TRIP_WAIT_H, "overtime": True,
                    "note": "emergency callout after the trip; the repair itself is still owed"} if tripped_nothing
                   else {"usd": 0.0, "person_h": 0, "overtime": False, "note": "no work done; the problem stays"})

    def row(key, label, ledger, lab, trip):
        return {"key": key, "label": label, "good": ledger["good"], "scrap": ledger["scrap"], "down_h": ledger["down_h"],
                "kwh": ledger["kwh"], "co2e_kg": ledger["co2e_kg"], "business_usd": ledger["money"], "labour_usd": lab["usd"],
                "labour_note": lab["note"], "person_h": lab["person_h"], "trip_h": trip}

    rows = [row("now", "Fix now", r_now["plan"], lab_now, (r_now["trip_h"].get(mid) or {}).get("plan"))]
    if hours > 0:
        rows.append(row("wait", f"Fix in {hours:g} h", r_wait["plan"], lab_wait, trip_wait))
    rows.append(row("nothing", "Do nothing", r_now["do_nothing"], lab_nothing, trip_nothing))
    ref = rows[0]
    for r in rows:   # cost of each choice compared with fixing now (positive = worse than acting now)
        r["vs_now"] = {"good_lost": round(ref["good"] - r["good"]), "extra_scrap": round(r["scrap"] - ref["scrap"]),
                       "extra_down_h": round(r["down_h"] - ref["down_h"], 1), "extra_kwh": round(r["kwh"] - ref["kwh"]),
                       "extra_co2e_kg": round(r["co2e_kg"] - ref["co2e_kg"]),
                       "production_usd": round((ref["good"] - r["good"]) * price * whatif.MARGIN),
                       "scrap_usd": round((r["scrap"] - ref["scrap"]) * price * whatif.SCRAP_SUNK),
                       "labour_usd": round(r["labour_usd"] - ref["labour_usd"], 2)}
        biz = ref["business_usd"] - r["business_usd"]
        r["vs_now"]["energy_usd"] = round(biz - r["vs_now"]["production_usd"] - r["vs_now"]["scrap_usd"])
        r["vs_now"]["total_usd"] = round(biz + r["vs_now"]["labour_usd"])

    wait = rows[1] if hours > 0 else rows[0]
    v = wait["vs_now"]
    prod = PLURAL.get(m.product, "parts")
    start_local = _fmt_local(plant, now + hours * H)
    ex = []
    if kind == "repair":
        ex.append(f"The spindle bearing is wearing out. Each hour it shakes a little more, which leaves chatter marks on the "
                  f"{prod} (scrap) and slows the cut. A planned repair stops {mid} for {REPAIR_HOURS:g} h.")
        if hours > 0:
            ex.append(f"Waiting {hours:g} h (repair at {start_local} plant time) makes about {max(0, v['extra_scrap'])} more scrapped "
                      f"and {max(0, v['good_lost'])} fewer good {prod} than repairing now, worth about ${max(0, v['production_usd'] + v['scrap_usd']):,}.")
        if tripped_before:
            ex.append(f"The machine is expected to reach its trip limit after about {trip_wait:g} h, before the repair starts. It then "
                      f"stops itself without warning, stays stopped until the crew arrives, and the job becomes an emergency callout.")
        elif trip_nothing is not None:
            ex.append(f"If nobody acts, it trips in about {trip_nothing:g} h and stays stopped: that is the 'do nothing' row.")
    elif kind == "fix_leak":
        ex.append(f"Compressed air is leaking from the pipes. The compressor runs harder to keep the pressure up, even at night "
                  f"when the lines are stopped, so every hour of waiting is electricity paid for nothing.")
        if hours > 0:
            ex.append(f"Waiting {hours:g} h wastes about {max(0, v['extra_kwh'])} kWh (${max(0, v['energy_usd']):,}) and "
                      f"{max(0, v['extra_co2e_kg'])} kg of CO2e. No parts are lost: the leak costs energy, not production.")
    else:
        lbl = sensor_spec.label.lower() if sensor_spec else "a sensor"
        ex.append(f"The {lbl} sensor is frozen: it shows the same number for hours. The machine itself is fine, so this needs "
                  f"an instrument technician for about an hour, not a repair crew, and no production is lost by waiting.")
        ex.append(f"The real cost is risk: while the sensor is frozen nobody would see the {lbl} really rise. If that ended in "
                  f"a surprise stop, the {line.name} loses about ${line.downtime_cost_per_h:,.0f} for every hour it is stopped.")
    if hours > 0 and lab_wait["overtime"] and not tripped_before:
        ex.append(f"{start_local} is outside the day shift (06:00-22:00), so the technician is paid overtime.")
    if hours > 0:
        total = v["total_usd"]
        if total > 0:
            ex.append(f"In total, waiting {hours:g} h costs about ${total:,} more than acting now.")
        elif total < 0:
            why = ("the job moves into the day shift, so nobody is paid overtime" if lab_now["overtime"] and not lab_wait["overtime"]
                   else "the stop moves out of busy hours")
            ex.append(f"Waiting {hours:g} h is about ${-total:,} cheaper than acting now: {why}."
                      + (" The saving is small next to the risk above." if kind == "recalibrate" else ""))
        else:
            ex.append(f"Waiting {hours:g} h costs about the same as acting now: nothing gets worse in that time.")
    if upcoming:
        ex.append(f"Note: a fix is already approved for {_fmt_local(plant, upcoming[0].at)} plant time; this comparison ignores it "
                  f"so you can see what the timing itself is worth.")
    return {**base, "action": kind, "fault": {"repair": "wear trend", "fix_leak": "air leak", "recalibrate": "frozen sensor"}[kind],
            "job": JOB[kind][3], "repair_at_local": start_local, "trip_expected_before_repair": tripped_before,
            "trip_h_if_nothing": trip_nothing, "trip_h_if_wait": trip_wait, "rows": rows, "explanations": ex,
            "already_planned_local": _fmt_local(plant, upcoming[0].at) if upcoming else None,
            "line_downtime_usd_per_h": line.downtime_cost_per_h if line.product else None,
            "orders": [{"so": o["so"], "customer": o["customer"], "status_if_now": o["status_plan"],
                        "status_if_wait": next((x["status_plan"] for x in r_wait["orders"] if x["so"] == o["so"]), None),
                        "status_if_nothing": o["status_do_nothing"]} for o in r_now["orders"]][:4],
            "assumptions": [
                f"Planned job: {JOB[kind][0]} {JOB[kind][2]} x {JOB[kind][1]:g} h at ${TECH_RATE:g}/h in the day shift.",
                f"Outside {DAY_START:02d}:00-{DAY_END:02d}:00 plant time, or after a trip: overtime ${OVERTIME_RATE:g}/h.",
                f"Unplanned trip: emergency callout {TRIP_CREW} technicians x {TRIP_CREW_H:g} h, plus {TRIP_WAIT_H:g} h of the line "
                f"waiting with {TRIP_OPERATORS} operators idle at ${OPERATOR_IDLE:g}/h.",
                f"Money: {int(whatif.MARGIN * 100)} % profit on each good part, {int(whatif.SCRAP_SUNK * 100)} % of the price lost "
                f"on each scrapped part, electricity at the time-of-day tariff, over the next {HORIZON_H:g} h, in US dollars."]}


@router.get("/api/machines/{machine_id}/delay-cost")
async def machine_delay_cost(request: Request, machine_id: str, hours: float = 0.0):
    s = request.state.session
    mid = machine_id.upper()
    if mid not in MACHINES:
        raise HTTPException(404, "unknown machine")
    hours = round(max(0.0, min(float(hours), 72.0)), 2)
    now = s.world.now()
    return await asyncio.to_thread(delay_cost, s.world, mid, now, hours)


# ----------------------------------------------------------------------------------------------- live readings
def _jitter(mid: str, key: str, t: float, sigma: float) -> float:
    """Repeatable measurement jitter for one 2-second sample (real sensors flicker a little between readings)."""
    import zlib
    rng = np.random.default_rng(zlib.crc32(f"{mid}|{key}|{int(t // 2)}".encode()))
    return float(rng.standard_normal()) * sigma


def live_readings(world, mid: str, now: float) -> dict:
    """Readings at this exact second: the simulated signal interpolated between its one-minute samples, plus a small
    measurement jitter, so the page moves every 2 s like a real sensor feed instead of once a minute."""
    m = MACHINES[mid]
    t0 = math.floor(now / 60) * 60
    f = (now - t0) / 60
    ts = np.array([t0, t0 + 60], dtype=float)
    out = {"id": mid, "now": now}
    lerp = lambda a: float(a[0] * (1 - f) + a[1] * f)
    for s in m.sensors[:2]:
        v = lerp(sensor(world, mid, s.key, ts))
        mask, frozen = stuck(world, mid, s.key, np.array([now]))
        if mask is not None and bool(mask[0]):
            out[s.key] = round(float(frozen), 3)          # a frozen sensor does not flicker: that is the tell-tale
            continue
        out[s.key] = round(v + _jitter(mid, s.key, now, s.noise * 0.25), 3)
    kw = lerp(power_kw(world, mid, ts))
    out["kw"] = round(max(0.0, kw * (1 + _jitter(mid, "kw", now, 0.006))), 2)
    if m.cycle_s:
        r = lerp(parts_rate(world, mid, ts))
        out["rate"] = round(max(0.0, r * (1 + _jitter(mid, "rate", now, 0.006))) if r > 0.5 else 0.0, 1)
    else:
        out["rate"] = None
    return out


@router.get("/api/machines/{machine_id}/live")
async def machine_live(request: Request, machine_id: str):
    s = request.state.session
    mid = machine_id.upper()
    if mid not in MACHINES:
        raise HTTPException(404, "unknown machine")
    return await asyncio.to_thread(live_readings, s.world, mid, s.world.now())
