"""Quality (scrap control charts), energy and carbon, and OEE losses: the numbers the Quality, Energy and Flow agents use."""
import math
from functools import lru_cache

import numpy as np

from ..sim.catalog import LINES, MACHINES, PLANTS, PRODUCTS, tariff_band
from ..sim.plant import ANCHOR, H, TZ_OFFSET, World, hourly, local_hour, oee, power_kw, running_fraction

DAY = 24 * H


# ----------------------------------------------------------------------------------------------- quality

def scrap_spc(world: World, machine_id: str, now: float, hours: int = 48) -> dict | None:
    """p-chart of hourly scrap fraction. Centre line and limits come from a healthy baseline week (10 to 4 days ago).
    Signals: a point above the upper limit, or 7 points in a row above the centre line (Western Electric style)."""
    m = MACHINES[machine_id]
    if m.cycle_s == 0:
        return None
    base = hourly(world, machine_id, ANCHOR - 10 * DAY, ANCHOR - 4 * DAY)
    sel = base["parts"] > 1
    pbar = float(base["scrap"][sel].sum() / base["parts"][sel].sum())
    cur = hourly(world, machine_id, now - hours * H, now)
    pts = []
    for i, h in enumerate(cur["hour"]):
        n = float(cur["parts"][i])
        if n < 1:
            continue
        p = float(cur["scrap"][i] / n)
        ucl = pbar + 3 * math.sqrt(pbar * (1 - pbar) / n)
        pts.append({"t": float(h), "p": round(p, 4), "ucl": round(ucl, 4), "n": round(n, 1)})
    above = [x["p"] > x["ucl"] for x in pts[-8:]]
    run = 0
    for x in reversed(pts):
        if x["p"] > pbar:
            run += 1
        else:
            break
    by_def = {k: float(v.sum()) for k, v in hourly(world, machine_id, now - 24 * H, now)["by_defect"].items()}
    parts24 = float(hourly(world, machine_id, now - 24 * H, now)["parts"].sum())
    return {"machine_id": machine_id, "centre": round(pbar, 4), "points": pts,
            "signal": "above control limit" if any(above) else ("run of 7 above centre" if run >= 7 else ""),
            "scrap_24h_pct": round(100 * sum(by_def.values()) / parts24, 2) if parts24 else 0.0,
            "by_defect_24h": {k: round(v, 1) for k, v in sorted(by_def.items(), key=lambda kv: -kv[1])},
            "parts_24h": round(parts24)}


def scrap_cost(machine_id: str, scrap_parts: float) -> float:
    m = MACHINES[machine_id]
    return scrap_parts * PRODUCTS[m.product]["price"] * 0.55 if m.product else 0.0   # material + machining sunk


# ----------------------------------------------------------------------------------------------- energy

def _tariff_cost(plant_id: str, hours: np.ndarray, kwh: np.ndarray) -> float:
    tariff = PLANTS[plant_id].tariff
    lh = local_hour(plant_id, hours).astype(int)
    return float(sum(k * tariff[tariff_band(int(h))] for h, k in zip(lh, kwh)))


def energy_machine(world: World, machine_id: str, now: float) -> dict:
    """kWh, cost and CO2e over 24 h, and kWh per good part against the same machine's baseline week."""
    m = MACHINES[machine_id]
    p = PLANTS[m.plant]
    cur = hourly(world, machine_id, now - 24 * H, now)
    kwh = float(cur["kwh"].sum())
    out = {"machine_id": machine_id, "kwh_24h": round(kwh, 1), "cost_24h": round(_tariff_cost(m.plant, cur["hour"], cur["kwh"])),
           "currency": p.currency, "co2e_kg_24h": round(kwh * p.grid_kg_co2_per_kwh, 1)}
    if m.cycle_s:
        base = hourly(world, machine_id, ANCHOR - 10 * DAY, ANCHOR - 4 * DAY)
        good_b = float(base["good"].sum())
        good = float(cur["good"].sum())
        out["kwh_per_good"] = round(kwh / good, 3) if good else None
        out["kwh_per_good_baseline"] = round(float(base["kwh"].sum()) / good_b, 3) if good_b else None
        if out["kwh_per_good"] and out["kwh_per_good_baseline"]:
            out["kwh_per_good_change_pct"] = round(100 * (out["kwh_per_good"] / out["kwh_per_good_baseline"] - 1), 1)
    return out


@lru_cache(maxsize=16)
def _compressor_baseline(machine_id: str):
    """Energy baseline for a compressor: kW = a + b × plant load, least squares on a healthy week (14 to 6 days ago,
    before any leak). The same idea as an IPMVP baseline: what the compressor should draw for the work being done."""
    m = MACHINES[machine_id]
    w = World()
    ts = np.arange(ANCHOR - 14 * DAY, ANCHOR - 6 * DAY, 900.0)
    load = _plant_load(m.plant, ts)
    kw = power_kw(w, machine_id, ts)
    b, a = np.polyfit(load, kw, 1)
    resid = kw - (a + b * load)
    return float(a), float(b), float(resid.std())


def _plant_load(plant: str, ts: np.ndarray) -> np.ndarray:
    return np.mean([running_fraction(x, ts) for x in MACHINES.values() if x.plant == plant and x.cycle_s > 0], axis=0)


def compressor_residual(world: World, machine_id: str, now: float, hours: float = 1.0) -> dict:
    """Extra kW the compressor draws over the last `hours` beyond what its baseline model expects for the plant's load.
    A positive, steady residual with normal production is the signature of a compressed-air leak."""
    m = MACHINES[machine_id]
    a, b, sd = _compressor_baseline(machine_id)
    ts = np.arange(now - hours * H, now, 300.0)
    load = _plant_load(m.plant, ts)
    extra = float((power_kw(world, machine_id, ts) - (a + b * load)).mean())
    p = PLANTS[m.plant]
    kwh_day = max(0.0, extra) * 24
    return {"machine_id": machine_id, "extra_kw": round(extra, 1), "baseline_sd_kw": round(sd, 2),
            "extra_kwh_per_day": round(kwh_day), "extra_cost_per_day": round(kwh_day * sum(p.tariff.values()) / 3),
            "co2e_kg_per_day": round(kwh_day * p.grid_kg_co2_per_kwh), "currency": p.currency,
            "model": "kW = a + b × plant load, fitted on a healthy week"}


def night_base_load(world: World, machine_id: str, now: float) -> dict:
    """Compressor load in the quietest hours (01:00-05:00 local) tonight vs the same hours a week earlier.
    An air leak shows up as power drawn when almost nothing is running."""
    m = MACHINES[machine_id]
    p = PLANTS[m.plant]

    def quiet_kw(t_end):
        ts = np.arange(t_end - DAY, t_end, 300.0)
        lh = local_hour(m.plant, ts)
        sel = (lh >= 1) & (lh < 5)
        return float(power_kw(world, machine_id, ts[sel]).mean())

    now_kw, base_kw = quiet_kw(now), quiet_kw(ANCHOR - 7 * DAY)
    extra = max(0.0, now_kw - base_kw)
    kwh_day = extra * 24
    tariff = sum(p.tariff.values()) / 3
    return {"machine_id": machine_id, "quiet_hours_kw": round(now_kw, 1), "baseline_kw": round(base_kw, 1),
            "extra_kw": round(extra, 1), "extra_kwh_per_day": round(kwh_day), "extra_cost_per_day": round(kwh_day * tariff),
            "extra_cost_per_year": round(kwh_day * tariff * 365), "co2e_kg_per_day": round(kwh_day * p.grid_kg_co2_per_kwh),
            "currency": p.currency}


def tariff_windows(plant_id: str, now: float, hours: int = 36) -> list:
    """Next `hours` hours with their tariff band (for picking a repair or a heavy job window)."""
    out = []
    t = math.floor(now / H) * H
    for i in range(hours):
        ts = t + i * H
        lh = int(((ts + TZ_OFFSET[PLANTS[plant_id].tz]) % DAY) / H)
        band = tariff_band(lh)
        out.append({"t": ts, "local_hour": lh, "band": band, "price": PLANTS[plant_id].tariff[band]})
    return out


# ----------------------------------------------------------------------------------------------- flow / OEE

def line_oee(world: World, line_id: str, now: float) -> dict:
    """OEE over the last 24 h and the same 24 h a week ago, with the loss split (availability / speed / quality)."""
    cur = oee(world, line_id, now - DAY, now)
    if not cur:
        return {}
    prev = oee(world, line_id, now - 8 * DAY, now - 7 * DAY)
    losses = {"availability": 1 - cur["availability"], "performance": 1 - cur["performance"], "quality": 1 - cur["quality"]}
    return {"line": line_id, "name": LINES[line_id].name, "plant": LINES[line_id].plant,
            "oee": round(cur["oee"], 3), "availability": round(cur["availability"], 3),
            "performance": round(cur["performance"], 3), "quality": round(cur["quality"], 3),
            "oee_week_ago": round(prev["oee"], 3) if prev else None,
            "good_24h": round(cur["good"]), "parts_24h": round(cur["parts"]),
            "biggest_loss": max(losses, key=losses.get), "losses": {k: round(v, 3) for k, v in losses.items()}}
