"""Typed tools the Gemba agents call. Each returns compact JSON the model can cite, plus a one-line summary for the UI.

Every number an agent states should come from one of these results. Tools read the visitor's own plant (session) at the
session's current time; none of them change anything. Changes happen only when a person approves a card.
"""
import datetime as dt
import json
import time

from ..analytics import anomaly, ops, signals, whatif
from ..analytics.snapshot import machine_state, plant_snapshot
from ..data import views
from ..sim import erp
from ..sim.catalog import LINES, MACHINES, PLANTS, SPARES, TECHNICIANS
from ..sim.plant import ANCHOR, H, TZ_OFFSET, World

TOOLS: dict = {}


def tool(name: str, description: str, params: dict | None = None, required: tuple = ()):
    def deco(fn):
        TOOLS[name] = {"name": name, "description": description, "fn": fn,
                       "parameters": {"type": "object", "properties": params or {}, "required": list(required)}}
        return fn
    return deco


def local(plant: str, t: float) -> str:
    return dt.datetime.fromtimestamp(t + TZ_OFFSET[PLANTS[plant].tz], dt.timezone.utc).strftime("%a %H:%M")


def _mid(machine_id: str) -> str:
    m = (machine_id or "").strip().upper()
    if m not in MACHINES:
        raise ValueError(f"unknown machine '{machine_id}'. Known: {', '.join(MACHINES)}")
    return m


# ----------------------------------------------------------------------------------------------- shared

@tool("plant_overview", "Status of every machine and line right now across all plants: alarms, sensor faults, watch items, "
      "OEE per line. Start here.")
def plant_overview(s, now):
    snap = plant_snapshot(s.world, now, key=s.id)
    flagged = [{"id": m["id"], "plant": m["plant"], "line": m["line"], "status": m["status"], "health": m["health"],
                "reasons": m["reasons"]} for m in snap["machines"] if m["status"] not in ("ok", "idle")]
    lines = [{"line": l["line"], "name": l["name"], "oee": l["oee"], "oee_week_ago": l["oee_week_ago"],
              "biggest_loss": l["biggest_loss"]} for l in snap["lines"]]
    return {"local_time": {p: local(p, now) for p in PLANTS}, "counts": snap["counts"], "flagged_machines": flagged,
            "lines": lines}, f"{len(flagged)} machines flagged, {snap['counts']['ok']} ok"


@tool("query_sql", "Run one read-only DuckDB SELECT over the plant database (max 200 rows). " + views.SCHEMA_DOC,
      {"sql": {"type": "string", "description": "A single SELECT or WITH query"}}, ("sql",))
def query_sql(s, now, sql):
    try:
        r = views.run(s, sql)
    except views.SqlRejected as e:
        return {"error": str(e)}, f"rejected: {e}"
    return {"columns": r["columns"], "rows": r["rows"][:60], "row_count": len(r["rows"]), "sql": r["sql"]}, f"{len(r['rows'])} rows"


# ----------------------------------------------------------------------------------------------- reliability

@tool("machine_condition", "Live condition of one machine: sensor readings vs alarm and trip limits, vibration zone, health "
      "index (0-100), anomaly score (0-1), frozen-sensor check, and the time-to-trip range if vibration is trending up.",
      {"machine_id": {"type": "string"}}, ("machine_id",))
def machine_condition(s, now, machine_id):
    mid = _mid(machine_id)
    st = machine_state(s.world, mid, now, detail=True)
    ttf = st.get("ttf_full")
    out = {"machine_id": mid, "name": st["name"], "line": st["line"], "status": st["status"], "running": st["running"],
           "health": st["health"], "health_breakdown": st["health_breakdown"], "anomaly": st["anomaly"], "vibration_zone": st["zone"],
           "readings": {k: {x: r[x] for x in ("value", "unit", "nominal", "alarm", "trip")} for k, r in st["readings"].items()},
           "sensor_faults": st["faults"], "scrap_24h_pct": st["scrap_24h_pct"]}
    if ttf:
        out["time_to_trip_h"] = ttf["to_trip_h"]
        out["time_to_alarm_h"] = ttf["to_alarm_h"]
        out["vibration_rise_mm_s_per_day"] = ttf["rise_mm_s_per_day"]
        out["method"] = ttf["method"]
    summ = f"{mid}: health {st['health']}, {st['status']}"
    if ttf:
        summ += f", trip in {ttf['to_trip_h']['p10']:.0f}-{ttf['to_trip_h']['p90']:.0f} h"
    if st["faults"]:
        summ += ", sensor frozen"
    return out, summ


@tool("maintenance_history", "Past work orders of a machine from the maintenance system (preventive and breakdowns), "
      "with days since the last preventive job.", {"machine_id": {"type": "string"}}, ("machine_id",))
def maintenance_history(s, now, machine_id):
    mid = _mid(machine_id)
    rows = [r for r in erp.maintenance_history() if r["machine_id"] == mid]
    out = [{"wo": r["wo"], "type": r["type"], "days_ago": round((now - r["opened"]) / 86400, 1), "failure_code": r["failure_code"],
            "note": r["note"]} for r in sorted(rows, key=lambda r: -r["opened"])]
    pm = [r for r in out if r["type"] == "PM"]
    days = pm[0]["days_ago"] if pm else None
    return {"machine_id": mid, "work_orders": out, "days_since_preventive": days, "preventive_interval_days": 30,
            "preventive_overdue_days": round(days - 30, 1) if days and days > 30 else 0}, f"{len(out)} records, last PM {days} d ago"


@tool("spare_parts", "Stock of a spare part at every plant (including parts in transit) and transfer time to Pune. "
      "Known parts: SPB-7014 spindle bearing set (VMC), INS-CNMG turning inserts, FLT-AIR compressor filter.",
      {"part_no": {"type": "string"}}, ("part_no",))
def spare_parts(s, now, part_no):
    pn = (part_no or "").strip().upper()
    if pn not in SPARES:
        return {"error": f"unknown part {part_no}; known: {', '.join(SPARES)}"}, "unknown part"
    sp = SPARES[pn]
    rows = [{"plant": p, "on_hand": s.stock(pn, p), "in_transit": sum(t["qty"] for t in s.in_transit(pn, p)),
             "transfer_h_to_pune": sp["transfer_h"].get(p, 0 if p == "PUN" else None)} for p in PLANTS]
    return {"part_no": pn, "name": sp["name"], "price_usd": sp["price"], "stock": rows}, \
        ", ".join(f"{r['plant']} {r['on_hand']}" for r in rows)


@tool("technicians", "Maintenance technicians with skills, shift (A 06-14, B 14-22, C 22-06) and language.",
      {"plant": {"type": "string", "description": "PUN, CHK or RAY (optional)"}})
def technicians(s, now, plant=""):
    rows = [t for t in TECHNICIANS if not plant or t["plant"] == plant.upper()]
    return {"technicians": rows}, f"{len(rows)} technicians"


# ----------------------------------------------------------------------------------------------- quality

@tool("scrap_overview", "Scrap of every producing machine over the last 24 h vs its own baseline week, split by defect "
      "class (chatter_marks, porosity, dimension_oos, other), with control-chart signals.")
def scrap_overview(s, now):
    rows = []
    for m in MACHINES.values():
        if not m.cycle_s:
            continue
        spc = ops.scrap_spc(s.world, m.id, now, hours=24)
        rows.append({"machine_id": m.id, "line": m.line, "scrap_24h_pct": spc["scrap_24h_pct"],
                     "baseline_pct": round(100 * spc["centre"], 2), "signal": spc["signal"], "by_defect_parts": spc["by_defect_24h"],
                     "scrap_cost_24h_usd": round(ops.scrap_cost(m.id, sum(spc["by_defect_24h"].values())))})
    for r in rows:
        r["times_baseline"] = round(r["scrap_24h_pct"] / r["baseline_pct"], 1) if r["baseline_pct"] else None
    rows.sort(key=lambda r: -(r["times_baseline"] or 0))
    above = [r for r in rows if r["signal"] or (r["times_baseline"] or 0) >= 2]
    return {"machines": rows, "above_normal": [r["machine_id"] for r in above]}, \
        "above normal: " + ", ".join(f"{r['machine_id']} {r['times_baseline']}×" for r in above[:4])


@tool("scrap_control_chart", "Hourly scrap p-chart for one machine over 48 h: centre line, upper limit, points, signal.",
      {"machine_id": {"type": "string"}}, ("machine_id",))
def scrap_control_chart(s, now, machine_id):
    mid = _mid(machine_id)
    spc = ops.scrap_spc(s.world, mid, now, hours=48)
    if not spc:
        return {"error": f"{mid} does not make parts"}, "not a producing machine"
    pts = spc["points"]
    first_out = next((p for p in pts if p["p"] > p["ucl"]), None)
    return {"machine_id": mid, "centre_pct": round(100 * spc["centre"], 2), "signal": spc["signal"],
            "last_12h_pct": [round(100 * p["p"], 2) for p in pts[-12:]], "points_above_limit_48h": sum(p["p"] > p["ucl"] for p in pts),
            "first_above_limit_hours_ago": round((now - first_out["t"]) / H, 1) if first_out else None,
            "by_defect_24h": spc["by_defect_24h"]}, f"{mid}: {spc['signal'] or 'in control'}"


@tool("inspect_part_photo", "Look at the latest camera photo of a part from a machine's output with Gemini vision and get "
      "the defect class, location and confidence. Use it to confirm what the scrap data suggests.",
      {"machine_id": {"type": "string"}}, ("machine_id",))
def inspect_part_photo(s, now, machine_id):
    # Implemented in vision.py (async, calls Gemini); the walk orchestrator routes this name there.
    raise NotImplementedError


@tool("material_lots", "Casting material lots in use at the Rayong gear-housing line with supplier and scrap by lot.")
def material_lots(s, now):
    sc = next((x for x in s.world.scenarios if x.kind == "lot_porosity"), None)
    rows = [{"lot": "AL-2207", "supplier": "Siam Alloys (fictional)", "in_use": False, "porosity_scrap_pct": 0.4},
            {"lot": "AL-2210", "supplier": sc.p("supplier") if sc else "Chao Metals (fictional)", "in_use": True,
             "since_hours": round((now - sc.start) / H, 1) if sc else None,
             "porosity_scrap_pct": round(100 * (sc.p("rate") if sc else 0.004), 1),
             "quarantined": bool(s.world.last("quarantine_lot", "AL-2210", now))},
            {"lot": "AL-2214", "supplier": "Siam Alloys (fictional)", "in_use": False, "in_stock": True, "porosity_scrap_pct": None}]
    return {"line": "RAY-L1", "lots": rows, "note": "AL-2214 is in the store and could replace AL-2210"}, "3 lots, AL-2210 in use"


# ----------------------------------------------------------------------------------------------- supply

@tool("order_book", "Open customer orders with due time, whether the line can make enough good parts in time under the "
      "current plan (cover = available / ordered; below 1.0 is short), and finished-goods stock.")
def order_book(s, now):
    rows = []
    for o in erp.order_risk(s.world, now):
        rows.append({"so": o["so"], "customer": o["customer"], "product": o["product_name"], "line": o["line"], "qty": o["qty"],
                     "due_in_h": round((o["due"] - now) / H, 1), "due_local": local(LINES[o["line"]].plant, o["due"]),
                     "stock": o["stock"], "projected_good": o["projected"], "cover": o["cover"], "status": o["status"],
                     "note": o["note"]})
    risky = [r["so"] for r in rows if r["status"] != "on track"]
    return {"orders": rows}, f"{len(rows)} orders, at risk/tight: {', '.join(risky) or 'none'}"


@tool("demand_forecast", "Daily order intake for a product (last 28 days) and a 14-day forecast with a range.",
      {"product": {"type": "string", "description": "CH-15, CRK-T4, GR-6, BRK-22 or GH-7"}}, ("product",))
def demand_forecast(s, now, product):
    hist = erp.demand_history()
    pr = product.strip().upper()
    h = [r for r in hist if r["product"] == pr]
    if not h:
        return {"error": f"unknown product {product}"}, "unknown product"
    fc = erp.forecast(hist, pr)
    last14, prev14 = sum(r["qty"] for r in h[-14:]), sum(r["qty"] for r in h[-28:-14])
    return {"product": pr, "last_14_days": last14, "previous_14_days": prev14, "change_pct": round(100 * (last14 / prev14 - 1), 1),
            "forecast_next_14_days": round(sum(f["mean"] for f in fc)), "forecast_range": [round(sum(f["low"] for f in fc)), round(sum(f["high"] for f in fc))],
            "method": "Holt exponential smoothing with weekly seasonality"}, f"{pr}: {round(100 * (last14 / prev14 - 1))} % vs prior fortnight"


@tool("what_if", "Simulate the plant forward (default 96 h) with and without actions and compare good parts, scrap, "
      "downtime, energy, CO2e, money and customer-order cover. Action kinds: slow (value = speed 0.7-1.0), repair (4 h planned "
      "stop), fix_leak, quarantine_lot (target = lot id), recalibrate. when_h = hours from now.",
      {"actions": {"type": "array", "items": {"type": "object", "properties": {
          "kind": {"type": "string", "enum": list(whatif.ACTION_KINDS)}, "target": {"type": "string"},
          "when_h": {"type": "number"}, "value": {"type": "number"}}, "required": ["kind", "target"]}},
       "horizon_h": {"type": "number"}}, ("actions",))
def what_if(s, now, actions, horizon_h=96):
    acts = [a for a in actions if a.get("kind") in whatif.ACTION_KINDS][:6]
    if not acts:
        return {"error": "no valid actions"}, "no valid actions"
    r = whatif.compare(s.world, acts, now, min(max(float(horizon_h or 96), 24), 120))
    summ = f"net value {'+' if r['delta']['money'] >= 0 else '-'}${abs(r['delta']['money']):,.0f}, down {r['delta']['down_h']:+.0f} h"
    for o in r["orders"][:1]:
        summ += f", {o['so']} cover {o['cover_do_nothing']}→{o['cover_plan']}"
    return {k: r[k] for k in ("horizon_h", "do_nothing", "plan", "delta", "orders", "trip_h", "assumptions")}, summ


# ----------------------------------------------------------------------------------------------- energy

@tool("energy_ranking", "Energy per good part for every producing machine (last 24 h) vs its own baseline week, with cost "
      "and CO2e; largest increases first.")
def energy_ranking(s, now):
    rows = []
    for m in MACHINES.values():
        if m.cycle_s:
            e = ops.energy_machine(s.world, m.id, now)
            rows.append({k: e.get(k) for k in ("machine_id", "kwh_24h", "cost_24h", "currency", "co2e_kg_24h", "kwh_per_good",
                                               "kwh_per_good_baseline", "kwh_per_good_change_pct")})
    rows.sort(key=lambda r: -(r.get("kwh_per_good_change_pct") or 0))
    return {"machines": rows}, f"worst: {rows[0]['machine_id']} {rows[0]['kwh_per_good_change_pct']:+.0f} % kWh/part"


@tool("night_base_load", "Compressed-air compressors: power drawn in the quietest hours (01:00-05:00) vs a week earlier. "
      "Extra night load with lines stopped usually means air leaks. Includes kWh, money and CO2e per day.")
def night_base_load(s, now):
    rows = [ops.night_base_load(s.world, m.id, now) for m in MACHINES.values() if m.kind == "COMPRESSOR"]
    rows.sort(key=lambda r: -r["extra_kw"])
    return {"compressors": rows}, f"{rows[0]['machine_id']} +{rows[0]['extra_kw']} kW at night"


@tool("compressor_baseline", "Compressors now: power drawn vs what the plant's production load explains (a baseline model "
      "fitted on a healthy week). A steady excess with normal production is the signature of an air leak; kWh, money, CO2e per day.")
def compressor_baseline(s, now):
    rows = [ops.compressor_residual(s.world, m.id, now) for m in MACHINES.values() if m.kind == "COMPRESSOR"]
    rows.sort(key=lambda r: -r["extra_kw"])
    return {"compressors": rows}, f"{rows[0]['machine_id']} {rows[0]['extra_kw']:+} kW vs baseline"


@tool("tariff_windows", "Electricity price by hour for the next 36 h at a plant (off-peak 22-06, peak 09-12 and 18-22).",
      {"plant": {"type": "string", "description": "PUN, CHK or RAY"}}, ("plant",))
def tariff_windows(s, now, plant):
    p = plant.strip().upper()
    if p not in PLANTS:
        return {"error": "plant must be PUN, CHK or RAY"}, "unknown plant"
    rows = ops.tariff_windows(p, now)
    blocks, cur = [], None
    for r in rows:
        if cur and cur["band"] == r["band"]:
            cur["hours"] += 1
        else:
            cur = {"band": r["band"], "price": r["price"], "starts_in_h": round((r["t"] - now) / H, 1),
                   "local_start": local(p, r["t"]), "hours": 1}
            blocks.append(cur)
    first = blocks[0]
    summ = (f"off-peak now until {local(p, now + (first['starts_in_h'] + first['hours']) * H)}" if first["band"] == "offpeak"
            else f"next off-peak in {next((b['starts_in_h'] for b in blocks if b['band'] == 'offpeak'), '?')} h")
    return {"plant": p, "currency": PLANTS[p].currency, "windows": blocks}, summ


# ----------------------------------------------------------------------------------------------- flow

@tool("line_oee", "OEE of every production line (24 h) vs a week ago with availability, performance and quality and the "
      "biggest loss.")
def line_oee(s, now):
    rows = [ops.line_oee(s.world, lid, now) for lid in LINES if LINES[lid].product]
    rows = [{k: r[k] for k in ("line", "name", "oee", "oee_week_ago", "availability", "performance", "quality", "biggest_loss",
                               "good_24h")} for r in rows]
    worst = min(rows, key=lambda r: r["oee"] - (r["oee_week_ago"] or r["oee"]))
    return {"lines": rows, "definition": "OEE = availability x performance x quality"}, \
        f"largest drop: {worst['line']} {worst['oee_week_ago']:.0%}→{worst['oee']:.0%}"


@tool("line_machines", "Machines of one line with their good parts (24 h), scrap, status and share of the line's output; "
      "use it to see which machine drags the line down and which could take extra load.",
      {"line_id": {"type": "string"}}, ("line_id",))
def line_machines(s, now, line_id):
    lid = line_id.strip().upper()
    if lid not in LINES:
        return {"error": f"unknown line; known: {', '.join(LINES)}"}, "unknown line"
    snap = plant_snapshot(s.world, now, key=s.id)
    ms = [m for m in snap["machines"] if m["line"] == lid and m["good_24h"] is not None]
    tot = sum(m["good_24h"] for m in ms) or 1
    rows = [{"machine_id": m["id"], "status": m["status"], "health": m["health"], "good_24h": m["good_24h"],
             "share_pct": round(100 * m["good_24h"] / tot, 1), "scrap_24h_pct": m["scrap_24h_pct"]} for m in ms]
    return {"line": lid, "machines": rows}, f"{len(rows)} machines"


# ----------------------------------------------------------------------------------------------- execution

def spec(names) -> list:
    return [{k: TOOLS[n][k] for k in ("name", "description", "parameters")} for n in names]


def run(name: str, session, now: float, args: dict):
    """Execute a tool. Returns (result_dict, summary, ms). Errors come back as data so the model can correct itself."""
    t = time.time()
    if name not in TOOLS:
        return {"error": f"unknown tool {name}"}, "unknown tool", 0
    try:
        res, summ = TOOLS[name]["fn"](session, now, **(args or {}))
    except TypeError as e:
        res, summ = {"error": f"bad arguments: {e}"}, "bad arguments"
    except ValueError as e:
        res, summ = {"error": str(e)}, str(e)[:80]
    return res, summ, int(1000 * (time.time() - t))


def dumps(obj) -> str:
    return json.dumps(obj, default=lambda o: float(o) if hasattr(o, "__float__") else str(o), separators=(",", ":"))
