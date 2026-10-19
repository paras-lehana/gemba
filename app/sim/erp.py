"""ERP and CMMS side of the fictional company: demand history, open sales orders, stock and maintenance records.

All records are generated from the seed and placed relative to ANCHOR, so every visitor sees the same business story.
The hero order (SO-24117) is due about 82 hours from the anchor and was enlarged 10 hours ago by the customer.
"""
import math

import numpy as np

from .catalog import CUSTOMERS, MACHINES, PRODUCTS, SPARES
from .plant import ANCHOR, H, SEED, World, _stable_hash, hourly

DAY = 86400.0

# Finished-goods stock on hand at the anchor (parts).
FG_STOCK = {"CH-15": 420, "CRK-T4": 900, "GR-6": 1600, "BRK-22": 5200, "GH-7": 800}

# Open sales orders: (id, customer, product, qty, due hours from anchor, note)
OPEN_ORDERS = [
    ("SO-24117", "DDM", "CH-15", 4100, 82.0, "quantity raised from 3,500 to 4,100 by the customer 10 h ago"),
    ("SO-24121", "AEV", "CH-15", 1200, 150.0, ""),
    ("SO-24098", "NTR", "CRK-T4", 2400, 70.0, ""),
    ("SO-24130", "DDM", "GR-6", 5200, 120.0, ""),
    ("SO-24105", "MKM", "GH-7", 3000, 96.0, "export, sea freight cut-off"),
    ("SO-24133", "AEV", "BRK-22", 18000, 60.0, ""),
]


def open_orders():
    out = []
    for so, cust, prod, qty, due_h, note in OPEN_ORDERS:
        out.append({"so": so, "customer": CUSTOMERS[cust], "customer_code": cust, "product": prod,
                    "product_name": PRODUCTS[prod]["name"], "qty": qty, "due": ANCHOR + due_h * H,
                    "value": qty * PRODUCTS[prod]["price"], "line": PRODUCTS[prod]["line"], "note": note})
    return out


def demand_history(days: int = 56):
    """Daily order intake per product for the last `days` days: trend + weekly rhythm + noise (+ a CH-15 surge)."""
    rows = []
    rng = np.random.default_rng(SEED + 7)
    base = {"CH-15": 1050, "CRK-T4": 820, "GR-6": 1500, "BRK-22": 5600, "GH-7": 950}
    for prod, b in base.items():
        for d in range(days, 0, -1):
            day0 = math.floor((ANCHOR - d * DAY) / DAY) * DAY
            dow = int(((day0 / DAY) + 3) % 7)                       # 0 = Monday
            weekly = (1.0, 1.05, 1.08, 1.1, 1.12, 0.85, 0.4)[dow]
            trend = 1 + 0.002 * (days - d)
            surge = 1 + (0.18 if prod == "CH-15" and d <= 10 else 0.0)  # EV-hybrid programme ramp at the customer
            qty = b * weekly * trend * surge * (1 + 0.07 * rng.standard_normal())
            rows.append({"product": prod, "day": day0, "qty": max(0, round(qty))})
    return rows


def forecast(history, product: str, horizon: int = 14):
    """Holt's linear exponential smoothing on daily intake, with weekly seasonal factors from the history."""
    ys = np.array([r["qty"] for r in history if r["product"] == product], dtype=float)
    days = np.array([r["day"] for r in history if r["product"] == product])
    dows = (((days / DAY) + 3) % 7).astype(int)
    season = np.array([ys[dows == k].mean() for k in range(7)]) / ys.mean()
    z = ys / season[dows]
    alpha, beta = 0.35, 0.08
    level, trend = z[0], 0.0
    for v in z[1:]:
        prev = level
        level = alpha * v + (1 - alpha) * (level + trend)
        trend = beta * (level - prev) + (1 - beta) * trend
    resid = np.std(z - np.convolve(z, np.ones(7) / 7, mode="same"))
    out = []
    last_day = days[-1]
    for i in range(1, horizon + 1):
        d = last_day + i * DAY
        dow = int(((d / DAY) + 3) % 7)
        mean = (level + i * trend) * season[dow]
        out.append({"day": d, "mean": mean, "low": max(0.0, mean - 1.3 * resid * season[dow]),
                    "high": mean + 1.3 * resid * season[dow]})
    return out


def projected_good(world: World, line_id: str, t0: float, t1: float, exclude: tuple = ()) -> float:
    """Good parts the line is expected to make between t0 and t1 under the current plan (simulated forward)."""
    total = 0.0
    for m in MACHINES.values():
        if m.line == line_id and m.cycle_s > 0 and m.id not in exclude:
            total += float(hourly(world, m.id, t0, t1)["good"].sum())
    return total


def order_risk(world: World, now: float):
    """For each open order: can the line make enough good parts (plus stock) before the due time?"""
    res = []
    for o in sorted(open_orders(), key=lambda x: x["due"]):
        if o["due"] <= now:
            continue
        made = projected_good(world, o["line"], now, o["due"])
        avail = FG_STOCK.get(o["product"], 0) + made
        # Orders for the same product due earlier consume capacity first.
        earlier = sum(x["qty"] for x in res if x["product"] == o["product"])
        cover = (avail - earlier) / o["qty"]
        res.append({**o, "projected": round(made), "stock": FG_STOCK.get(o["product"], 0), "cover": round(cover, 3),
                    "status": "at risk" if cover < 1.0 else ("tight" if cover < 1.08 else "on track")})
    return res


def maintenance_history():
    """Past work orders (CMMS). VMC-204: preventive job 12 days overdue, two earlier breakdowns of a different kind."""
    rows = []
    for m in MACHINES.values():
        h = _stable_hash(m.id)
        last_pm_days = 18 + h % 20
        if m.id == "VMC-204":
            last_pm_days = 42      # PM interval 30 days → 12 days overdue
        rows.append({"wo": f"WO-PM-{h % 9000 + 1000}", "machine_id": m.id, "type": "PM", "opened": ANCHOR - last_pm_days * DAY,
                     "closed": ANCHOR - last_pm_days * DAY + 3 * H, "failure_code": "", "note": "Routine preventive maintenance"})
    rows += [
        {"wo": "WO-CM-3105", "machine_id": "VMC-204", "type": "CM", "opened": ANCHOR - 37 * DAY, "closed": ANCHOR - 37 * DAY + 5 * H,
         "failure_code": "TOOL-CHANGER", "note": "Tool changer arm misaligned; re-taught positions"},
        {"wo": "WO-CM-3188", "machine_id": "VMC-204", "type": "CM", "opened": ANCHOR - 16 * DAY, "closed": ANCHOR - 16 * DAY + 3 * H,
         "failure_code": "COOLANT", "note": "Coolant pump seal leak; seal replaced"},
        {"wo": "WO-CM-3150", "machine_id": "LTH-102", "type": "CM", "opened": ANCHOR - 22 * DAY, "closed": ANCHOR - 22 * DAY + 2 * H,
         "failure_code": "TOOL-WEAR", "note": "Insert breakage at 9 h tool life; life reduced to 7.5 h"},
        {"wo": "WO-CM-3201", "machine_id": "CMP-901", "type": "CM", "opened": ANCHOR - 64 * DAY, "closed": ANCHOR - 64 * DAY + 2 * H,
         "failure_code": "AIR-LEAK", "note": "Leak at quick coupling, Line 3 header; fixed"},
        {"wo": "WO-CM-3222", "machine_id": "GRD-102", "type": "CM", "opened": ANCHOR - 9 * DAY, "closed": ANCHOR - 9 * DAY + 1 * H,
         "failure_code": "SENSOR", "note": "Bearing RTD connector loose; re-terminated"},
    ]
    return rows


def spares():
    rows = []
    for pn, s in SPARES.items():
        for plant, qty in s["stock"].items():
            rows.append({"part_no": pn, "name": s["name"], "fits": s["fits"], "plant": plant, "qty": qty,
                         "price": s["price"], "transfer_h_to_pun": s["transfer_h"].get(plant, 0 if plant == "PUN" else None)})
    return rows
