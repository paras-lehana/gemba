"""What-if: run the plant forward with and without a set of actions and compare.

This is how Gemba's numbers stay honest. Agents propose actions; the simulator (not the language model) computes what
they change: good parts, scrap, downtime, energy, CO2e, money and whether each customer order is covered.
"""
import copy

import numpy as np

from ..sim import erp
from ..sim.catalog import LINES, MACHINES, PLANTS, PRODUCTS
from ..sim.plant import H, Intervention, World, hourly, is_down, grid
from .ops import _tariff_cost

ACTION_KINDS = {
    "slow": "Run the machine slower (value = speed fraction, e.g. 0.85)",
    "repair": "Planned repair (4 h stop) starting at when_h",
    "fix_leak": "Fix a compressed-air leak at when_h",
    "quarantine_lot": "Stop using a material lot (target = lot id) at when_h",
    "recalibrate": "Replace or recalibrate a frozen sensor at when_h",
}
MARGIN = 0.30          # contribution margin on a good part (assumption, labelled in the UI)
SCRAP_SUNK = 0.55      # share of the price already spent when a part is scrapped (material + machining)


def _clone(world: World) -> World:
    w = World(offset_s=world.offset_s, extra_scenarios=list(world.extra_scenarios),
              interventions=[copy.copy(i) for i in world.interventions], version=world.version,
              speed=world.speed, speed_since=world.speed_since)
    return w


def apply_actions(world: World, actions: list, now: float) -> World:
    w = _clone(world)
    for a in actions:
        kind = a.get("kind")
        if kind not in ACTION_KINDS:
            continue
        at = now + float(a.get("when_h", 0) or 0) * H
        w.interventions.append(Intervention(kind, a.get("target", ""), at, float(a.get("value", 0) or 0), "what-if"))
    return w


def _machines_for(actions: list, extra: list) -> list:
    ids = set(extra)
    for a in actions:
        tgt = a.get("target", "")
        if tgt in MACHINES:
            ids.add(tgt)
            ids.update(m.id for m in MACHINES.values() if m.line == MACHINES[tgt].line and m.cycle_s)
        elif tgt.startswith("AL-") or tgt in LINES:
            ids.update(m.id for m in MACHINES.values() if m.line == "RAY-L1" and m.cycle_s)
    return sorted(ids)


def _ledger(world: World, ids: list, now: float, horizon_h: float) -> dict:
    tot = {"good": 0.0, "scrap": 0.0, "kwh": 0.0, "down_h": 0.0, "money_energy": 0.0, "money_scrap": 0.0, "money_good": 0.0,
           "co2e_kg": 0.0, "by_machine": {}}
    ts = grid(now, now + horizon_h * H, 300)
    for mid in ids:
        m = MACHINES[mid]
        h = hourly(world, mid, now, now + horizon_h * H)
        price = PRODUCTS[m.product]["price"] if m.product else 0
        good, scrap, kwh = float(h["good"].sum()), float(h["scrap"].sum()), float(h["kwh"].sum())
        down_h = float(is_down(world, mid, ts).mean() * horizon_h)
        tot["good"] += good
        tot["scrap"] += scrap
        tot["kwh"] += kwh
        tot["down_h"] += down_h
        tot["money_good"] += good * price * MARGIN
        tot["money_scrap"] += scrap * price * SCRAP_SUNK
        tot["money_energy"] += _tariff_cost(m.plant, h["hour"], h["kwh"])
        tot["co2e_kg"] += kwh * PLANTS[m.plant].grid_kg_co2_per_kwh
        tot["by_machine"][mid] = {"good": round(good), "scrap": round(scrap, 1), "kwh": round(kwh), "down_h": round(down_h, 1)}
    return tot


def trip_time(world: World, machine_id: str, now: float, horizon_h: float) -> float | None:
    """Hours until the machine trips on vibration (None if it does not within the horizon)."""
    if machine_id not in MACHINES or not any(s.key == "vib" for s in MACHINES[machine_id].sensors):
        return None
    from ..sim.plant import bearing_level
    ts = grid(now, now + horizon_h * H, 900)
    spec = next(s for s in MACHINES[machine_id].sensors if s.key == "vib")
    lv = spec.nominal + bearing_level(world, machine_id, ts)
    hit = np.nonzero(lv >= spec.trip)[0]
    return round(float((ts[hit[0]] - now) / H), 1) if len(hit) else None


def compare(world: World, actions: list, now: float, horizon_h: float = 96.0, watch: list = ()) -> dict:
    """Do nothing vs do the actions, over the horizon. Money in US dollars."""
    ids = _machines_for(actions, list(watch))
    after = apply_actions(world, actions, now)
    base_l, plan_l = _ledger(world, ids, now, horizon_h), _ledger(after, ids, now, horizon_h)
    money = lambda L: L["money_good"] - L["money_scrap"] - L["money_energy"]
    orders_base = {o["so"]: o for o in erp.order_risk(world, now)}
    orders_plan = {o["so"]: o for o in erp.order_risk(after, now)}
    order_rows = []
    lines = {MACHINES[i].line for i in ids}
    for so, o in orders_base.items():
        if o["line"] in lines:
            p = orders_plan[so]
            order_rows.append({"so": so, "customer": o["customer"], "qty": o["qty"], "due": o["due"],
                               "cover_do_nothing": o["cover"], "status_do_nothing": o["status"],
                               "cover_plan": p["cover"], "status_plan": p["status"]})
    trips = {}
    for mid in {a.get("target") for a in actions} | set(watch):
        if mid in MACHINES:
            trips[mid] = {"do_nothing": trip_time(world, mid, now, horizon_h), "plan": trip_time(after, mid, now, horizon_h)}

    def pick(L):
        return {"good": round(L["good"]), "scrap": round(L["scrap"]), "kwh": round(L["kwh"]), "down_h": round(L["down_h"], 1),
                "co2e_kg": round(L["co2e_kg"]), "money": round(money(L)),
                "kwh_per_good": round(L["kwh"] / L["good"], 3) if L["good"] > 1 else None}
    b, p = pick(base_l), pick(plan_l)
    return {"horizon_h": horizon_h, "machines": ids, "do_nothing": b, "plan": p,
            "delta": {k: round(p[k] - b[k], 3 if k == "kwh_per_good" else 1) for k in b if p[k] is not None and b[k] is not None}, "orders": order_rows, "trip_h": trips,
            "currency": "USD", "assumptions": f"margin {int(MARGIN * 100)} % on good parts; scrap loses {int(SCRAP_SUNK * 100)} % of price; time-of-day tariff",
            "actions": actions}
