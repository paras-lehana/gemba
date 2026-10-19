"""Machine condition from sensor signals: ISO-style vibration zone, health index, time to the trip limit, sensor faults.

These are deliberately classical and explainable. The agents read their outputs as tool results and explain them; they
never invent a number that these functions did not produce.
"""
import math

import numpy as np

from ..sim.catalog import MACHINES
from ..sim.plant import H, World, grid, is_down, running_fraction, sensor

# Vibration severity zones (mm/s RMS), ISO 10816-3 style for a medium machine on a rigid foundation.
ZONES = ((1.4, "A", "new-machine condition"), (2.8, "B", "fine for long-term running"),
         (4.5, "C", "restricted: plan a repair"), (math.inf, "D", "damage likely: stop soon"))


def zone(vib: float) -> dict:
    for upper, z, meaning in ZONES:
        if vib <= upper:
            return {"zone": z, "meaning": meaning}
    return {"zone": "D", "meaning": ZONES[-1][2]}


def spec(machine_id: str, key: str):
    return next((s for s in MACHINES[machine_id].sensors if s.key == key), None)


def readings(world: World, machine_id: str, now: float) -> dict:
    """Latest value of every sensor, smoothed over the last 5 minutes (one reading per minute)."""
    ts = grid(now - 300, now, 60)
    out = {}
    for s in MACHINES[machine_id].sensors:
        v = sensor(world, machine_id, s.key, ts)
        out[s.key] = {"value": round(float(v[-3:].mean()), 2), "unit": s.unit, "label": s.label, "nominal": s.nominal,
                      "alarm": s.alarm, "trip": s.trip}
    return out


def sensor_faults(world: World, machine_id: str, now: float) -> list:
    """Frozen (flat-lined) sensors. A real signal always has noise; a value that does not move for 30 min while the machine
    is running is the sensor, not the machine. Stopped machines legitimately read 0 rpm, so they are not judged on speed,
    current or vibration. The guardrail: a sensor fault sends an instrument technician, never a repair crew."""
    faults = []
    ts = grid(now - 24 * H, now, 300)
    running_tail = _running_mask(world, machine_id, ts[-7:]).mean() > 0.5
    for s in MACHINES[machine_id].sensors:
        if s.key in ("rpm", "amps", "vib") and not running_tail:
            continue
        v = sensor(world, machine_id, s.key, ts)
        tail = v[-7:]
        if np.ptp(tail) < 1e-9:
            i = len(v) - 1
            while i > 0 and abs(v[i - 1] - v[-1]) < 1e-9:
                i -= 1
            faults.append({"key": s.key, "label": s.label, "kind": "frozen", "value": round(float(v[-1]), 2),
                           "since": float(ts[i]), "hours": round((now - ts[i]) / H, 1)})
    return faults


def _running_mask(world: World, machine_id: str, ts: np.ndarray) -> np.ndarray:
    m = MACHINES[machine_id]
    return (running_fraction(m, ts) > 0.2) & ~is_down(world, machine_id, ts)


def vib_hourly(world: World, machine_id: str, t0: float, t1: float):
    """Hourly mean vibration while the machine was cutting (idle readings would hide the trend)."""
    ts = grid(t0, t1, 300)
    v = sensor(world, machine_id, "vib", ts)
    run = _running_mask(world, machine_id, ts)
    hours = np.floor(ts / H) * H
    uniq = np.unique(hours)
    out_t, out_v = [], []
    for h in uniq:
        sel = (hours == h) & run
        if sel.sum() >= 4:
            out_t.append(h + H / 2)
            out_v.append(float(v[sel].mean()))
    return np.array(out_t), np.array(out_v)


_KS = np.geomspace(0.0015, 0.25, 120)


def _fit_offset_exp(x: np.ndarray, ys: np.ndarray):
    """Least-squares fit of y = c + A·e^{k x} (A > 0) for a batch of series ys (B, n): scan k, solve (c, A) in closed
    form for every k at once, keep the best k per series. Small k behaves like a straight line, large k like fast
    exponential wear, so one model covers both. Returns arrays (c, A, k) of shape (B,), NaN where no fit exists."""
    ys = np.atleast_2d(ys)
    e = np.exp(_KS[:, None] * x[None, :])                       # (K, n)
    n, s1, s2 = len(x), e.sum(1), (e * e).sum(1)                # (K,)
    t0 = ys.sum(1)[:, None]                                     # (B, 1)
    t1 = ys @ e.T                                               # (B, K)
    det = n * s2 - s1 * s1
    c = (s2 * t0 - s1 * t1) / det
    a = (n * t1 - s1 * t0) / det
    sse = ((c[:, :, None] + a[:, :, None] * e[None] - ys[:, None, :]) ** 2).sum(2)
    sse = np.where(a > 0, sse, np.inf)
    best = sse.argmin(1)
    rows = np.arange(len(ys))
    ok = np.isfinite(sse[rows, best])
    return (np.where(ok, c[rows, best], np.nan), np.where(ok, a[rows, best], np.nan), np.where(ok, _KS[best], np.nan))


def time_to_trip(world: World, machine_id: str, now: float, lookback_h: float = 36.0) -> dict | None:
    """Fit a wear curve (offset exponential) to the last `lookback_h` hours of running vibration and extrapolate to the
    alarm and trip limits. Returns a range (p10, p50, p90 in hours from now) from a seeded residual bootstrap, or None when
    the signal is not trending up or a sensor is frozen."""
    s = spec(machine_id, "vib")
    if s is None or sensor_faults(world, machine_id, now):
        return None
    t, v = vib_hourly(world, machine_id, now - lookback_h * H, now)
    if len(t) < 10 or (v[-4:].mean() - s.nominal) < 0.45:
        return None
    x = (t - now) / H
    c, a, k = (float(z[0]) for z in _fit_offset_exp(x, v))
    if not np.isfinite(k):
        return None
    slope_now = a * k
    if slope_now <= 0.004:          # mm/s per hour: flatter than this is not a wear trend
        return None
    fitted = c + a * np.exp(k * x)
    resid = v - fitted
    rng = np.random.default_rng(int(now // 900) % 100000)
    boot = fitted[None, :] + rng.choice(resid, size=(200, len(resid)), replace=True)
    cb, ab, kb = _fit_offset_exp(x, boot)
    ok = np.isfinite(kb)
    if ok.sum() < 50:
        return None
    cb, ab, kb = cb[ok], ab[ok], kb[ok]

    def cross(level):
        with np.errstate(divide="ignore", invalid="ignore"):
            h = np.log(np.maximum(level - cb, 1e-9) / ab) / kb
        return np.where(level <= cb, 0.0, np.maximum(h, 0.0))

    trips, alarms = cross(s.trip), cross(s.alarm)
    trips, alarms = np.clip(trips, 0, 24 * 30), np.clip(alarms, 0, 24 * 30)
    p10, p50, p90 = np.percentile(trips, [10, 50, 90])
    return {"to_trip_h": {"p10": round(float(p10), 1), "p50": round(float(p50), 1), "p90": round(float(p90), 1)},
            "to_alarm_h": round(float(np.median(alarms)), 1), "rise_mm_s_per_day": round(slope_now * 24, 2),
            "trip": s.trip, "alarm": s.alarm, "curve": {"c": c, "a": a, "k": k},
            "method": "offset-exponential trend on hourly running vibration, 200-sample bootstrap",
            "fit_hours": round(lookback_h)}


def forecast_curve(ttf: dict, now: float, horizon_h: float = 96.0):
    """The fitted median curve for charts: [{t, v}] from now to the horizon."""
    c, a, k = ttf["curve"]["c"], ttf["curve"]["a"], ttf["curve"]["k"]
    hs = np.arange(0, horizon_h + 1, 2.0)
    return [{"t": now + h * H, "v": round(float(min(c + a * math.exp(k * h), ttf["trip"] * 1.15)), 2)} for h in hs]


def health(world: World, machine_id: str, now: float, anomaly_score: float = 0.0) -> dict:
    """Health index 0-100: 100 minus weighted distance of each sensor from nominal towards its alarm limit.
    Weights: vibration 60, temperature 25, current 15, anomaly up to 10. Explainable by construction."""
    r = readings(world, machine_id, now)
    weights = {"vib": 60, "temp": 25, "amps": 15}
    parts, total = [], 0.0
    for key, w in weights.items():
        if key not in r:
            continue
        x = r[key]
        span = x["alarm"] - x["nominal"]
        ratio = max(0.0, (x["value"] - x["nominal"]) / span) if span > 0 else 0.0
        pen = w * min(ratio, 1.3)
        total += pen
        parts.append({"key": key, "penalty": round(pen, 1), "ratio_to_alarm": round(ratio, 2)})
    pen = 10 * max(0.0, (anomaly_score - 0.9) / 0.1)
    if pen > 0:
        parts.append({"key": "anomaly", "penalty": round(pen, 1)})
    total += pen
    return {"score": int(round(max(0.0, 100 - total))), "breakdown": parts}
