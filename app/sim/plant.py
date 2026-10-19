"""The plant simulator: every signal is a pure function of time plus the session's interventions.

Why a pure function: the same code answers "what is VMC-204's vibration now", "what was it three days ago" (history,
charts, the Failure Time Machine) and "what will it be on Friday if we wait" (what-if), and every visitor gets the same
story from the same seed. Interventions (repair, slow down, fix a leak, quarantine a lot) only change the future after
the moment they are applied.

Time is UTC epoch seconds. ANCHOR is the process start rounded down to 15 minutes; scenarios are placed relative to it.
"""
import math
import time
import zlib
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np

from .catalog import LINES, MACHINES, PLANTS, PRODUCTS

H = 3600.0
TZ_OFFSET = {"Asia/Kolkata": 5.5 * H, "Asia/Bangkok": 7 * H}
ANCHOR = math.floor(time.time() / 900) * 900
NOISE_T0 = ANCHOR - 15 * 24 * H          # noise tables cover [ANCHOR-15 d, ANCHOR+8 d] at 1-minute resolution
NOISE_N = 23 * 24 * 60
SEED = 2026


# ----------------------------------------------------------------------------------------------- deterministic noise

def _stable_hash(*parts) -> int:
    return zlib.crc32("|".join(map(str, parts)).encode())


_NOISE_CACHE: dict = {}


def noise(machine_id: str, key: str) -> np.ndarray:
    """Smooth, repeatable noise for one signal: white noise through an exponential kernel (an AR(1)-like wander)."""
    k = (machine_id, key)
    if k not in _NOISE_CACHE:
        rng = np.random.default_rng(SEED + _stable_hash(machine_id, key))
        white = rng.standard_normal(NOISE_N + 40).astype(np.float32)
        kernel = np.exp(-np.arange(40) / 8.0).astype(np.float32)
        kernel /= np.sqrt((kernel ** 2).sum())
        _NOISE_CACHE[k] = np.convolve(white, kernel, mode="valid")[:NOISE_N]
    return _NOISE_CACHE[k]


def _noise_at(machine_id: str, key: str, t: np.ndarray) -> np.ndarray:
    idx = np.clip(((t - NOISE_T0) // 60).astype(np.int64), 0, NOISE_N - 1)
    return noise(machine_id, key)[idx]


# ----------------------------------------------------------------------------------------------- scenarios

@dataclass(frozen=True)
class Scenario:
    id: str
    kind: str           # bearing_wear | air_leak | lot_porosity | sensor_stuck | tool_wear
    target: str         # machine id (or line id)
    start_h: float      # hours relative to ANCHOR
    params: tuple = ()  # (name, value) pairs

    def p(self, name, default=None):
        return dict(self.params).get(name, default)

    @property
    def ref(self) -> float:
        """Reference time the scenario is placed against: ANCHOR, or the moment it was injected."""
        return self.p("ref", ANCHOR)

    @property
    def start(self) -> float:
        return self.ref + self.start_h * H

    def injected(self, at: float) -> "Scenario":
        return Scenario(self.id, self.kind, self.target, self.start_h, self.params + (("ref", at),))


@lru_cache(maxsize=64)
def _bearing_curve(base: float, onset_h: float, trip_at_h: float, trip: float, now_val: float):
    """Exponential wear curve v(h) = base + A (e^{k (h - onset)} - 1) through (0 h, now_val) and (trip_at_h, trip).
    Hours are relative to the scenario's reference time (ANCHOR, or the moment a presenter injected it)."""
    lo, hi = 1e-4, 0.2
    for _ in range(80):     # bisection on k so the curve passes both points
        k = (lo + hi) / 2
        a = (now_val - base) / (math.exp(k * (0 - onset_h)) - 1)
        val = base + a * (math.exp(k * (trip_at_h - onset_h)) - 1)
        if val > trip:
            hi = k
        else:
            lo = k
    return k, a


# Default story. VMC-204's spindle bearing started wearing 72 h ago; it is at ~3.9 mm/s now and would trip around +60 h.
HERO = "VMC-204"
DEFAULT_SCENARIOS = (
    Scenario("S-BRG-204", "bearing_wear", HERO, -72.0, (("now_val", 3.9), ("trip_at_h", 60.0))),
    Scenario("S-LEAK-901", "air_leak", "CMP-901", -120.0, (("extra_kw", 11.5),)),
    Scenario("S-LOT-2210", "lot_porosity", "RAY-L1", -30.0, (("lot", "AL-2210"), ("rate", 0.034), ("supplier", "Chao Metals (fictional)"))),
    Scenario("S-STUCK-102", "sensor_stuck", "GRD-102", -6.0, (("key", "temp"), ("value", 41.0))),
    Scenario("S-TOOL-102", "tool_wear", "LTH-102", -400.0, (("period_h", 7.5),)),
)
# Faults a presenter can inject; their clock starts at the moment of injection (start_h is relative to that moment).
INJECTABLE = {
    "bearing_wear_vmc202": Scenario("S-BRG-202", "bearing_wear", "VMC-202", -30.0, (("now_val", 2.5), ("trip_at_h", 40.0))),
    # The leak and the frozen sensor started an hour before anyone noticed, so Gemba Watch can see them straight away.
    "air_leak_chk": Scenario("S-LEAK-951", "air_leak", "CMP-951", -1.0, (("extra_kw", 8.0),)),
    "sensor_stuck_hob301": Scenario("S-STUCK-301", "sensor_stuck", "HOB-301", -1.0, (("key", "vib"), ("value", 2.0))),
}


@dataclass
class Intervention:
    kind: str           # repair | slow | fix_leak | quarantine_lot | recalibrate | inspect100
    target: str
    at: float           # epoch seconds when it takes effect
    value: float = 0.0
    by: str = ""
    note: str = ""


@dataclass
class World:
    """One visitor's plant: the shared physics plus their own clock offset, injected scenarios and interventions."""
    offset_s: float = 0.0
    extra_scenarios: list = field(default_factory=list)
    interventions: list = field(default_factory=list)
    version: int = 0
    speed: float = 1.0              # simulation speed: 1 = real time, 10 = ten simulated minutes per real minute
    speed_since: float = field(default_factory=time.time)

    def now(self) -> float:
        return time.time() + self.offset_s + (time.time() - self.speed_since) * (self.speed - 1.0)

    def set_speed(self, speed: float):
        """Change the clock speed without a jump: fold the time gained so far into the offset."""
        t = time.time()
        self.offset_s += (t - self.speed_since) * (self.speed - 1.0)
        self.speed_since, self.speed = t, max(1.0, min(float(speed), 120.0))

    @property
    def scenarios(self):
        return list(DEFAULT_SCENARIOS) + self.extra_scenarios

    def touch(self):
        self.version += 1

    def last(self, kind: str, target: str, before: float):
        """Latest intervention of a kind on a target that took effect before `before`."""
        best = None
        for iv in self.interventions:
            if iv.kind == kind and iv.target == target and iv.at <= before and (best is None or iv.at > best.at):
                best = iv
        return best


REPAIR_HOURS = 4.0


# ----------------------------------------------------------------------------------------------- shift calendar

def local_hour(plant_id: str, t: np.ndarray) -> np.ndarray:
    return ((t + TZ_OFFSET[PLANTS[plant_id].tz]) % 86400) / H


def planned(machine, t: np.ndarray) -> np.ndarray:
    """1 where the machine is scheduled to work. Pune runs shift C (22-06) only on the Cylinder Head line."""
    if machine.kind in ("COMPRESSOR", "CHILLER", "FURNACE", "CMM"):
        return np.ones_like(t)
    h = local_hour(machine.plant, t)
    night = (h >= 22) | (h < 6)
    if machine.plant == "PUN" and machine.line != "PUN-L1":
        return np.where(night, 0.0, 1.0)
    return np.ones_like(t)


def running_fraction(machine, t: np.ndarray) -> np.ndarray:
    """Share of time actually cutting while planned: breaks, changeovers and small stops take the rest."""
    plan = planned(machine, t)
    if machine.cycle_s == 0:
        return plan
    h = local_hour(machine.plant, t)
    brk = ((np.abs(h - 10) < 0.25) | (np.abs(h - 18) < 0.25) | (np.abs(h - 2) < 0.25)).astype(float)
    day = np.floor((t + TZ_OFFSET[PLANTS[machine.plant].tz]) / 86400)
    co_a = (_stable_hash(machine.id) % 7 + 7 + day * 5) % 24       # two changeovers a day, placed by machine and day
    co_b = (co_a + 11) % 24
    changeover = ((np.floor(h) == co_a) | (np.floor(h) == co_b)).astype(float) * 0.55
    small_stops = 0.09 + 0.04 * _noise_at(machine.id, "stops", t).clip(-1, 1)
    return plan * np.clip(1 - brk - changeover - small_stops, 0, 1)


# ----------------------------------------------------------------------------------------------- degradation

def bearing_level(world: World, machine_id: str, t: np.ndarray) -> np.ndarray:
    """Extra vibration (mm/s above nominal) from bearing wear, honouring slow-downs and repairs."""
    m = MACHINES[machine_id]
    spec = next((s for s in m.sensors if s.key == "vib"), None)
    t = np.asarray(t, dtype=float)
    extra = np.zeros_like(t)
    if spec is None:
        return extra
    tmax = float(t.max()) if t.size else 0.0
    for sc in world.scenarios:
        if sc.kind != "bearing_wear" or sc.target != machine_id:
            continue
        k, a = _bearing_curve(spec.nominal, sc.start_h, sc.p("trip_at_h"), spec.trip, sc.p("now_val"))
        rel = (t - sc.ref) / H
        eff = rel
        slow = world.last("slow", machine_id, tmax)
        if slow is not None:      # a slower spindle wears more slowly from that moment on
            s_rel = (slow.at - sc.ref) / H
            eff = np.where(rel > s_rel, s_rel + (rel - s_rel) * (0.55 + 0.45 * slow.value), rel)
        wear = np.where(rel > sc.start_h, a * (np.exp(k * (eff - sc.start_h)) - 1), 0.0)
        rep = world.last("repair", machine_id, tmax)
        if rep is not None:
            wear = np.where(t >= rep.at + REPAIR_HOURS * H, 0.0, wear)
        extra += np.clip(wear, 0, None)
    return extra


def leak_kw(world: World, machine_id: str, t: np.ndarray) -> np.ndarray:
    kw = np.zeros_like(t)
    for sc in world.scenarios:
        if sc.kind == "air_leak" and sc.target == machine_id:
            on = t >= sc.start
            fix = world.last("fix_leak", machine_id, float(t.max()))
            if fix is not None:
                on &= t < fix.at
            kw += np.where(on, sc.p("extra_kw"), 0.0)
    return kw


def stuck(world: World, machine_id: str, key: str, t: np.ndarray):
    """(mask, value) for a frozen sensor, or (None, None)."""
    for sc in world.scenarios:
        if sc.kind == "sensor_stuck" and sc.target == machine_id and sc.p("key") == key:
            mask = t >= sc.start
            fix = world.last("recalibrate", machine_id, float(t.max()))
            if fix is not None:
                mask &= t < fix.at
            return mask, sc.p("value")
    return None, None


def is_down(world: World, machine_id: str, t: np.ndarray) -> np.ndarray:
    """Machine stopped: during a planned repair, or tripped because vibration crossed the trip limit."""
    m = MACHINES[machine_id]
    down = np.zeros_like(t, dtype=bool)
    rep = world.last("repair", machine_id, float(t.max()))
    if rep is not None:
        down |= (t >= rep.at) & (t < rep.at + REPAIR_HOURS * H)
    spec = next((s for s in m.sensors if s.key == "vib"), None)
    if spec is not None:
        down |= (spec.nominal + bearing_level(world, machine_id, t)) >= spec.trip
    return down


# ----------------------------------------------------------------------------------------------- signals

def sensor(world: World, machine_id: str, key: str, t: np.ndarray) -> np.ndarray:
    """Measured value of one sensor at times t (vectorized)."""
    m = MACHINES[machine_id]
    spec = next(s for s in m.sensors if s.key == key)
    t = np.asarray(t, dtype=float)
    run = running_fraction(m, t)
    down = is_down(world, machine_id, t)
    active = np.where(down, 0.0, (run > 0.2).astype(float))
    n = _noise_at(machine_id, key, t) * spec.noise
    wear = bearing_level(world, machine_id, t) if m.kind in ("VMC",) else np.zeros_like(t)
    if key == "vib":
        val = np.where(active > 0, spec.nominal + wear, 0.25) + n * np.where(active > 0, 1 + wear / 3, 0.3)
    elif key == "temp":
        ambient = 21.0 if spec.nominal > 30 and spec.nominal < 100 else spec.nominal
        lagged = bearing_level(world, machine_id, t - 4 * H) if m.kind == "VMC" else 0.0
        hot = spec.nominal + 6.5 * lagged
        if spec.nominal >= 100 or m.kind in ("CMM", "CHILLER", "WASHER"):
            val = spec.nominal + n
        else:
            val = np.where(active > 0, hot, ambient + (hot - ambient) * 0.35) + n
    elif key == "amps":
        val = np.where(active > 0, spec.nominal * (1 + 0.05 * wear), spec.nominal * 0.12) + n
    elif key == "rpm":
        slow = world.last("slow", machine_id, float(t.max()))
        factor = np.where((slow is not None) & (t >= (slow.at if slow else 0)), slow.value if slow else 1.0, 1.0)
        val = np.where(active > 0, spec.nominal * factor, 0.0) + n * active
    elif key == "press":
        drop = 0.0
        if m.kind == "COMPRESSOR":
            drop = 0.004 * leak_kw(world, machine_id, t)
        val = spec.nominal - drop + n
    else:
        val = spec.nominal + n
    mask, frozen = stuck(world, machine_id, key, t)
    if mask is not None:
        val = np.where(mask, frozen, val)
    return val.astype(float)


def scrap_rates(world: World, machine_id: str, t: np.ndarray) -> dict:
    """Probability that a part made at time t is scrap, split by defect class."""
    m = MACHINES[machine_id]
    base = 0.006 + 0.002 * (_stable_hash(machine_id) % 5) / 5
    out = {"other": np.full_like(t, base, dtype=float)}
    if m.kind == "VMC":
        vib = MACHINES[machine_id].sensors[0].nominal + bearing_level(world, machine_id, t)
        p = 0.065 * np.clip((vib - 2.2) / 2.6, 0, 1) ** 1.25
        slow = world.last("slow", machine_id, float(t.max()))
        if slow is not None:
            p = np.where(t >= slow.at, p * (1 - 0.6 * min(1.0, max(0.0, (1 - slow.value) / 0.15))), p)
        out["chatter_marks"] = p
    if m.kind == "LATHE" and machine_id == "LTH-102":
        period = 7.5 * H
        phase = ((t - ANCHOR) % period) / period
        out["dimension_oos"] = 0.002 + 0.012 * phase ** 3
    for sc in world.scenarios:
        if sc.kind == "lot_porosity" and sc.target == m.line and m.kind == "CASTING":
            on = t >= sc.start
            q = world.last("quarantine_lot", sc.p("lot"), float(t.max()))
            if q is not None:
                on &= t < q.at
            out["porosity"] = np.where(on, sc.p("rate"), 0.004)
    return out


def power_kw(world: World, machine_id: str, t: np.ndarray) -> np.ndarray:
    m = MACHINES[machine_id]
    run = running_fraction(m, t)
    down = is_down(world, machine_id, t)
    plan = planned(m, t)
    if m.kind == "COMPRESSOR":
        plant_load = np.mean([running_fraction(MACHINES[x], t) for x in MACHINES
                              if MACHINES[x].plant == m.plant and MACHINES[x].cycle_s > 0], axis=0)
        kw = m.kw_idle + (m.kw_run - m.kw_idle) * plant_load * 0.85 + leak_kw(world, machine_id, t)
    elif m.kind == "FURNACE":
        kw = m.kw_run * (0.82 + 0.05 * _noise_at(machine_id, "kw", t))
    else:
        wear = bearing_level(world, machine_id, t) if m.kind == "VMC" else 0.0
        kw = np.where(plan > 0, m.kw_idle + (m.kw_run - m.kw_idle) * run * (1 + 0.04 * wear), m.kw_idle * 0.15)
    return np.where(down, m.kw_idle * 0.3, kw).astype(float)


def parts_rate(world: World, machine_id: str, t: np.ndarray) -> np.ndarray:
    """Parts per hour at time t (0 for non-producing machines)."""
    m = MACHINES[machine_id]
    if m.cycle_s == 0:
        return np.zeros_like(t, dtype=float)
    run = running_fraction(m, t)
    speed = np.ones_like(t, dtype=float)
    slow = world.last("slow", machine_id, float(t.max()))
    if slow is not None:
        speed = np.where(t >= slow.at, slow.value, 1.0)
    if m.kind == "VMC":       # a worn spindle cuts slower (operator feed override) and stops more often to be checked
        wear = np.clip(bearing_level(world, machine_id, t) / 3, 0, 1)
        speed = speed * (1 - 0.13 * wear) * (1 - 0.10 * wear)
    down = is_down(world, machine_id, t)
    # 0.88: everyday speed losses (minor stops, cautious feeds) that keep performance below the ideal cycle
    return np.where(down, 0.0, 3600.0 / m.cycle_s * run * speed * (0.88 + 0.02 * _noise_at(machine_id, "perf", t))).astype(float)


# ----------------------------------------------------------------------------------------------- hourly ledger

def hourly(world: World, machine_id: str, t0: float, t1: float) -> dict:
    """Per-hour production, quality, energy and availability for [t0, t1). Integrates at 5-minute steps."""
    hours = np.arange(math.floor(t0 / H) * H, t1, H)
    sub = (hours[:, None] + np.arange(0, H, 300)[None, :]).ravel()
    m = MACHINES[machine_id]
    rate = parts_rate(world, machine_id, sub).reshape(len(hours), -1)
    parts = rate.mean(axis=1)
    scrap = scrap_rates(world, machine_id, sub)
    total_p = np.clip(sum(v for v in scrap.values()), 0, 0.9).reshape(len(hours), -1)
    scrap_parts = (rate * total_p).mean(axis=1)
    by_defect = {k: (rate * v.reshape(len(hours), -1)).mean(axis=1) for k, v in scrap.items()}
    kwh = power_kw(world, machine_id, sub).reshape(len(hours), -1).mean(axis=1)
    plan = planned(m, sub).reshape(len(hours), -1).mean(axis=1)
    run = (running_fraction(m, sub) * (~is_down(world, machine_id, sub))).reshape(len(hours), -1).mean(axis=1)
    ideal = (3600.0 / m.cycle_s) if m.cycle_s else 0.0
    return {"hour": hours, "parts": parts, "scrap": scrap_parts, "good": parts - scrap_parts, "kwh": kwh,
            "planned_h": plan, "run_h": run, "ideal_rate": ideal, "by_defect": by_defect}


def oee(world: World, line_id: str, t0: float, t1: float) -> dict:
    """OEE = availability × performance × quality for the producing machines of a line over [t0, t1)."""
    ms = [m for m in MACHINES.values() if m.line == line_id and m.cycle_s > 0]
    if not ms:
        return {}
    plan = run = parts = good = ideal_parts = 0.0
    for m in ms:
        hrs = hourly(world, m.id, t0, t1)
        plan += hrs["planned_h"].sum()
        run += hrs["run_h"].sum()
        parts += hrs["parts"].sum()
        good += hrs["good"].sum()
        ideal_parts += (hrs["run_h"] * hrs["ideal_rate"]).sum()
    a = run / plan if plan else 0
    p = parts / ideal_parts if ideal_parts else 0
    q = good / parts if parts else 0
    return {"line": line_id, "availability": a, "performance": p, "quality": q, "oee": a * p * q,
            "parts": parts, "good": good, "planned_h": plan, "run_h": run}


def grid(t0: float, t1: float, step: float) -> np.ndarray:
    return np.arange(math.floor(t0 / step) * step, t1 + 1e-6, step, dtype=float)


def line_of(product: str) -> str:
    return PRODUCTS[product]["line"]


def plant_lines(plant_id: str):
    return [l for l in LINES.values() if l.plant == plant_id]
