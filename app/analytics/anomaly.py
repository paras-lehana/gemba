"""Multivariate anomaly score per machine-hour (IsolationForest).

Trained once at start-up on healthy history (12 to 4 days before the anchor, before any scripted fault began) across all
machines, on features scaled by each sensor's nominal value so one model covers every machine type. The score says "this
combination of readings is unusual for a running machine"; the signals module says which reading and how far.
"""
import numpy as np
from sklearn.ensemble import IsolationForest

from ..sim.catalog import MACHINES
from ..sim.plant import ANCHOR, H, World, grid, is_down, running_fraction, sensor

FEATURES = ("vib", "temp", "amps")
_MODEL = {}


def _features(world: World, machine_id: str, t0: float, t1: float):
    """Hourly feature rows while running: value/nominal for vib, temp, amps (1.0 when the sensor is absent) and the
    6-hour vibration slope."""
    m = MACHINES[machine_id]
    keys = {s.key: s for s in m.sensors}
    if "vib" not in keys:
        return np.empty((0, 4)), np.empty(0)
    ts = grid(t0, t1, 300)
    run = (running_fraction(m, ts) > 0.2) & ~is_down(world, machine_id, ts)
    cols = []
    for k in FEATURES:
        cols.append(sensor(world, machine_id, k, ts) / keys[k].nominal if k in keys else np.ones_like(ts))
    hours = np.floor(ts / H)
    rows, times = [], []
    prev = []
    for h in np.unique(hours):
        sel = (hours == h) & run
        if sel.sum() < 4:
            continue
        vals = [float(c[sel].mean()) for c in cols]
        prev.append(vals[0])
        slope = (prev[-1] - prev[-7]) / 6 if len(prev) >= 7 else 0.0
        rows.append(vals + [slope])
        times.append(h * H + H / 2)
    return np.array(rows), np.array(times)


def train(world: World | None = None):
    world = world or World()
    xs = []
    for mid, m in MACHINES.items():
        if any(s.key == "vib" for s in m.sensors):
            x, _ = _features(world, mid, ANCHOR - 12 * 24 * H, ANCHOR - 4 * 24 * H)
            if len(x):
                xs.append(x)
    x = np.vstack(xs)
    model = IsolationForest(n_estimators=150, contamination=0.01, random_state=2026).fit(x)
    ref = -model.score_samples(x)
    _MODEL.update(model=model, ref=np.sort(ref), n=len(x))
    return _MODEL


def score(world: World, machine_id: str, now: float) -> float | None:
    """Anomaly score 0..1 for the last 3 running hours: the share of healthy training hours that look more normal."""
    if not _MODEL:
        train()
    x, _ = _features(world, machine_id, now - 9 * H, now)
    if len(x) == 0:
        return None
    raw = float((-_MODEL["model"].score_samples(x[-3:])).mean())
    return round(float(np.searchsorted(_MODEL["ref"], raw) / len(_MODEL["ref"])), 3)


def info() -> dict:
    if not _MODEL:
        train()
    return {"model": "IsolationForest", "trees": 150, "training_rows": int(_MODEL["n"]),
            "features": ["vibration / nominal", "temperature / nominal", "current / nominal", "6 h vibration slope"],
            "trained_on": "healthy running hours, 12 to 4 days before today, all machines with vibration sensors"}
