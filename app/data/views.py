"""DuckDB views over one visitor's plant, for "Ask Gemba" (NL-to-SQL) and the agents' `query_sql` tool.

Safety model (defence in depth): tables are copied into a private in-memory database; external access and configuration
changes are switched off before any user SQL runs; the text must be a single SELECT/WITH statement with no
file/network/pragma keywords; results are capped at 200 rows; queries are interrupted after 3 seconds.
"""
import datetime as dt
import re
import threading
import time

import duckdb
import numpy as np

from ..sim import erp
from ..sim.catalog import LINES, MACHINES, PLANTS, PRODUCTS, tariff_band
from ..sim.plant import H, TZ_OFFSET, hourly, sensor
from ..analytics.snapshot import plant_snapshot

DAYS = 7
MAX_ROWS = 200
TIMEOUT_S = 3.0

SCHEMA_DOC = """Tables (DuckDB SQL; timestamps are TIMESTAMP in UTC unless the name says local; money in US dollars):
- plants(plant_id, name, country, currency, grid_kg_co2_per_kwh)
- lines(line_id, plant_id, name, product, downtime_cost_per_h)
- machines(machine_id, name, kind, plant_id, line_id, criticality, ideal_cycle_s, kw_run)
- machine_hourly(machine_id, plant_id, line_id, hour_utc, hour_local, local_hour, shift, vib_mm_s, temp_c, amps, rpm,
  kwh, parts, good, scrap, planned_h, run_h, tariff_band, energy_cost, co2e_kg)  -- last 7 days, one row per machine-hour
- scrap_by_defect(machine_id, line_id, hour_utc, defect, parts)  -- defects: chatter_marks, porosity, dimension_oos, other
- machine_status(machine_id, status, health, anomaly, vib_zone, hours_to_trip_p50, scrap_24h_pct, reasons)  -- right now
- products(product, name, price, line_id)
- orders(so, customer, product, qty, due_utc, order_value, line_id, cover, risk_status, note)  -- open sales orders
- demand_daily(product, day, qty)  -- order intake, last 56 days
- spares(part_no, name, fits, plant_id, qty, price, transfer_h_to_pune)
- maintenance(wo, machine_id, type, opened_utc, closed_utc, failure_code, note)  -- CMMS history (PM = preventive)
- work_orders(wo, machine_id, title, kind, status, approved_by, created_utc)  -- created in this demo session
Shifts: A 06-14, B 14-22, C 22-06 local time. OEE = availability x performance x quality; availability = run_h/planned_h."""

_FORBIDDEN = re.compile(r"\b(attach|detach|copy|export|import|install|load|pragma|set|reset|call|create|insert|update|delete|"
                        r"drop|alter|replace|checkpoint|vacuum|read_csv\w*|read_parquet|read_json\w*|read_text|read_blob|"
                        r"glob|httpfs|sniff_csv|parquet_\w+|duckdb_\w+|getenv|current_setting|query_table|query)\b", re.I)
_CACHE: dict = {}
_BUILD_LOCK = threading.Lock()


class SqlRejected(ValueError):
    pass


def _ts(epoch: float) -> dt.datetime:
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).replace(tzinfo=None)


def _shift(lh: int) -> str:
    return "A" if 6 <= lh < 14 else ("B" if 14 <= lh < 22 else "C")


def _table(c, name: str, cols: list):
    """Create a table from columns [(name, type, values)]. Values are loaded as numpy arrays (fast, no per-row Python);
    times are epoch seconds turned into UTC TIMESTAMPs; None/NaN become NULL."""
    data, exprs = {}, []
    for col, typ, vals in cols:
        if typ == "VARCHAR":
            data[col] = np.array(["" if v is None else str(v) for v in vals], dtype=str)
            exprs.append(f"NULLIF({col}::VARCHAR, '') AS {col}")
        else:
            data[col] = np.array([np.nan if v is None else float(v) for v in vals], dtype=float)
            if typ == "TIMESTAMP":
                exprs.append(f"make_timestamp(({col} * 1000000)::BIGINT) AS {col}")
            elif typ == "DATE":
                exprs.append(f"make_timestamp(({col} * 1000000)::BIGINT)::DATE AS {col}")
            elif typ == "INTEGER":
                exprs.append(f"IF(isnan({col}), NULL, round({col}))::INTEGER AS {col}")
            else:
                exprs.append(f"IF(isnan({col}), NULL, {col}) AS {col}")
    if not cols or len(next(iter(data.values()))) == 0:
        c.execute(f"CREATE TABLE {name} ({', '.join(f'{n} {t}' for n, t, _ in cols)})")
        return
    tmp = f"_load_{name}"
    c.register(tmp, data)
    c.execute(f"CREATE TABLE {name} AS SELECT {', '.join(exprs)} FROM {tmp}")
    c.unregister(tmp)


def _cols(spec: str, rows: list) -> list:
    """'a VARCHAR, b DOUBLE' + row tuples -> column list for _table."""
    names = [x.strip().split() for x in spec.split(",")]
    return [(n, t, [r[i] for r in rows]) for i, (n, t) in enumerate(names)]


def build(session) -> duckdb.DuckDBPyConnection:
    """Fresh in-memory database for this session state (cached per world version and 15 minutes)."""
    world = session.world
    now = world.now()
    key = (session.id, world.version, int(now // 900), len(session.work_orders))
    with _BUILD_LOCK:
        if key in _CACHE:
            return _CACHE[key]
    con = duckdb.connect(":memory:")
    c = con.cursor()
    _table(c, "plants", _cols("plant_id VARCHAR, name VARCHAR, country VARCHAR, currency VARCHAR, grid_kg_co2_per_kwh DOUBLE",
                              [(p.id, p.name, p.country, p.currency, p.grid_kg_co2_per_kwh) for p in PLANTS.values()]))
    _table(c, "lines", _cols("line_id VARCHAR, plant_id VARCHAR, name VARCHAR, product VARCHAR, downtime_cost_per_h DOUBLE",
                             [(l.id, l.plant, l.name, l.product or None, l.downtime_cost_per_h) for l in LINES.values()]))
    _table(c, "machines", _cols("machine_id VARCHAR, name VARCHAR, kind VARCHAR, plant_id VARCHAR, line_id VARCHAR, criticality VARCHAR, ideal_cycle_s DOUBLE, kw_run DOUBLE",
                                [(m.id, m.name, m.kind, m.plant, m.line, m.criticality, m.cycle_s or None, m.kw_run) for m in MACHINES.values()]))
    _table(c, "products", _cols("product VARCHAR, name VARCHAR, price DOUBLE, line_id VARCHAR",
                                [(k, v["name"], v["price"], v["line"]) for k, v in PRODUCTS.items()]))
    rows, defects = [], []
    t1 = (now // H) * H
    t0 = t1 - DAYS * 24 * H
    for m in MACHINES.values():
        h = hourly(world, m.id, t0, t1)
        mids = h["hour"] + H / 2
        sens = {s.key: sensor(world, m.id, s.key, mids) for s in m.sensors}
        p = PLANTS[m.plant]
        for i, hr in enumerate(h["hour"]):
            lh = int(((hr + TZ_OFFSET[p.tz]) % 86400) // H)
            band = tariff_band(lh)
            kwh = float(h["kwh"][i])
            rows.append((m.id, m.plant, m.line, hr, hr + TZ_OFFSET[p.tz], lh, _shift(lh),
                         *(round(float(sens[k][i]), 3) if k in sens else None for k in ("vib", "temp", "amps", "rpm")),
                         round(kwh, 3), round(float(h["parts"][i]), 2), round(float(h["good"][i]), 2), round(float(h["scrap"][i]), 3),
                         round(float(h["planned_h"][i]), 3), round(float(h["run_h"][i]), 3), band, round(kwh * p.tariff[band], 2),
                         round(kwh * p.grid_kg_co2_per_kwh, 3)))
            for d, arr in h["by_defect"].items():
                if arr[i] > 0.001:
                    defects.append((m.id, m.line, hr, d, round(float(arr[i]), 3)))
    _table(c, "machine_hourly", _cols("machine_id VARCHAR, plant_id VARCHAR, line_id VARCHAR, hour_utc TIMESTAMP, hour_local TIMESTAMP, "
                                      "local_hour INTEGER, shift VARCHAR, vib_mm_s DOUBLE, temp_c DOUBLE, amps DOUBLE, rpm DOUBLE, kwh DOUBLE, "
                                      "parts DOUBLE, good DOUBLE, scrap DOUBLE, planned_h DOUBLE, run_h DOUBLE, tariff_band VARCHAR, "
                                      "energy_cost DOUBLE, co2e_kg DOUBLE", rows))
    _table(c, "scrap_by_defect", _cols("machine_id VARCHAR, line_id VARCHAR, hour_utc TIMESTAMP, defect VARCHAR, parts DOUBLE", defects))
    snap = plant_snapshot(world, now, key=session.id)
    _table(c, "machine_status", _cols("machine_id VARCHAR, status VARCHAR, health INTEGER, anomaly DOUBLE, vib_zone VARCHAR, hours_to_trip_p50 DOUBLE, scrap_24h_pct DOUBLE, reasons VARCHAR", [
        (m["id"], m["status"], m["health"], m["anomaly"], m["zone"]["zone"] if m["zone"] else None,
         m["ttf"]["to_trip_h"]["p50"] if m["ttf"] else None, m["scrap_24h_pct"], "; ".join(m["reasons"])) for m in snap["machines"]]))
    _table(c, "orders", _cols("so VARCHAR, customer VARCHAR, product VARCHAR, qty INTEGER, due_utc TIMESTAMP, order_value DOUBLE, line_id VARCHAR, cover DOUBLE, risk_status VARCHAR, note VARCHAR", [
        (o["so"], o["customer"], o["product"], o["qty"], o["due"], o["value"], o["line"], o["cover"], o["status"], o["note"] or None)
        for o in erp.order_risk(world, now)]))
    _table(c, "demand_daily", _cols("product VARCHAR, day DATE, qty INTEGER", [(r["product"], r["day"], r["qty"]) for r in erp.demand_history()]))
    _table(c, "spares", _cols("part_no VARCHAR, name VARCHAR, fits VARCHAR, plant_id VARCHAR, qty INTEGER, price DOUBLE, transfer_h_to_pune DOUBLE", [
        (r["part_no"], r["name"], r["fits"], r["plant"], session.stock(r["part_no"], r["plant"]), r["price"], r["transfer_h_to_pun"]) for r in erp.spares()]))
    _table(c, "maintenance", _cols("wo VARCHAR, machine_id VARCHAR, type VARCHAR, opened_utc TIMESTAMP, closed_utc TIMESTAMP, failure_code VARCHAR, note VARCHAR", [
        (r["wo"], r["machine_id"], r["type"], r["opened"], r["closed"], r["failure_code"] or None, r["note"]) for r in erp.maintenance_history()]))
    _table(c, "work_orders", _cols("wo VARCHAR, machine_id VARCHAR, title VARCHAR, kind VARCHAR, status VARCHAR, approved_by VARCHAR, created_utc TIMESTAMP", [
        (w["id"], w.get("machine_id"), w["title"], w["kind"], w["status"], w.get("approved_by"), w["created"]) for w in session.work_orders.values()]))
    c.execute("SET enable_external_access = false")
    c.execute("SET lock_configuration = true")
    with _BUILD_LOCK:
        if len(_CACHE) > 60:
            _CACHE.clear()
        _CACHE[key] = con
    return con


def check(sql: str) -> str:
    """Return the cleaned statement or raise SqlRejected with a reason a person (or a model) can act on."""
    s = sql.strip().rstrip(";").strip()
    s = re.sub(r"^```(?:sql)?|```$", "", s, flags=re.I).strip()
    if not s:
        raise SqlRejected("empty query")
    if ";" in s:
        raise SqlRejected("only one statement is allowed")
    if not re.match(r"^(select|with)\b", s, re.I):
        raise SqlRejected("only SELECT (or WITH ... SELECT) queries are allowed")
    bad = _FORBIDDEN.search(re.sub(r"'[^']*'", "''", s))
    if bad:
        raise SqlRejected(f"keyword not allowed: {bad.group(0)}")
    return s


def run(session, sql: str) -> dict:
    """Run a checked read-only query. Returns columns, rows (≤ 200), elapsed ms and the SQL actually executed."""
    s = check(sql)
    con = build(session).cursor()
    timer = threading.Timer(TIMEOUT_S, con.interrupt)
    t = time.time()
    timer.start()
    try:
        res = con.execute(f"SELECT * FROM ({s}) AS q LIMIT {MAX_ROWS + 1}")
        cols = [d[0] for d in res.description]
        rows = res.fetchall()
    except duckdb.InterruptException:
        raise SqlRejected(f"query took longer than {TIMEOUT_S:.0f} s")
    except duckdb.Error as e:
        raise SqlRejected(str(e).split("\n")[0][:300])
    finally:
        timer.cancel()
    out = []
    for r in rows[:MAX_ROWS]:
        out.append([v.isoformat() if isinstance(v, (dt.datetime, dt.date)) else (round(v, 4) if isinstance(v, float) else v) for v in r])
    return {"sql": s, "columns": cols, "rows": out, "truncated": len(rows) > MAX_ROWS, "ms": round(1000 * (time.time() - t))}
