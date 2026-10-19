"""Fast checks: simulator determinism, analytics ranges, guardrails, SQL safety, rules fallback, API smoke (no model)."""
import asyncio
import os

import pytest

os.environ["GEMBA_LLM"] = "mock"
os.environ["GEMBA_PROBE"] = "0"

from app.analytics import signals, whatif  # noqa: E402
from app.analytics.snapshot import plant_snapshot  # noqa: E402
from app.data import views  # noqa: E402
from app.sim import erp  # noqa: E402
from app.sim.plant import ANCHOR, H, World, hourly, oee, sensor  # noqa: E402
from app.store import session as sessions  # noqa: E402
from app.store import workorders  # noqa: E402

NOW = ANCHOR + 0.25 * H


def test_simulator_is_deterministic():
    import numpy as np
    t = np.arange(NOW - 24 * H, NOW, 300.0)
    assert (sensor(World(), "VMC-204", "vib", t) == sensor(World(), "VMC-204", "vib", t)).all()


def test_hero_story_numbers():
    w = World()
    h204, h201 = hourly(w, "VMC-204", NOW - 24 * H, NOW), hourly(w, "VMC-201", NOW - 24 * H, NOW)
    assert h204["scrap"].sum() / h204["parts"].sum() > 3 * h201["scrap"].sum() / h201["parts"].sum()
    assert 0.6 < oee(w, "PUN-L1", NOW - 24 * H, NOW)["oee"] < 0.75
    so = next(o for o in erp.order_risk(w, NOW) if o["so"] == "SO-24117")
    assert so["cover"] < 1.0, "the hero order must be short if nothing is done"


def test_time_to_trip_range_contains_physics():
    ttf = signals.time_to_trip(World(), "VMC-204", NOW)
    assert ttf and ttf["to_trip_h"]["p10"] < 60 < ttf["to_trip_h"]["p90"] + 15


def test_frozen_sensor_detected_and_no_trend_claimed():
    w = World()
    assert any(f["key"] == "temp" for f in signals.sensor_faults(w, "GRD-102", NOW))
    assert signals.time_to_trip(w, "GRD-102", NOW) is None


def test_whatif_repair_prevents_trip_and_covers_order():
    r = whatif.compare(World(), [{"kind": "repair", "target": "VMC-204", "when_h": 20}], NOW)
    assert r["trip_h"]["VMC-204"]["do_nothing"] is not None and r["trip_h"]["VMC-204"]["plan"] is None
    so = next(o for o in r["orders"] if o["so"] == "SO-24117")
    assert so["cover_plan"] > 1.0 > so["cover_do_nothing"]


@pytest.mark.parametrize("sql", ["select * from read_csv('/etc/passwd')", "select 1; drop table orders", "COPY orders TO 'x.csv'",
                                 "select getenv('HOME')", "select * from glob('/*')", "attach 'x.db'", "pragma version"])
def test_sql_guard_rejects(sql):
    s = sessions.get(None)
    with pytest.raises(views.SqlRejected):
        views.run(s, sql)


def test_sql_runs_and_caps_rows():
    s = sessions.get(None)
    r = views.run(s, "select machine_id, sum(good) g from machine_hourly group by 1 order by 2 desc")
    assert r["columns"] == ["machine_id", "g"] and 0 < len(r["rows"]) <= 200


def test_approval_needs_lockout_first_and_release_limit():
    s = sessions.get(None)
    card = {"id": "GC-1", "title": "Repair VMC-204", "machine_id": "VMC-204", "status": "proposed",
            "actions": [{"kind": "repair", "target": "VMC-204", "when_h": 1}]}
    wo = workorders.approve(s, card, "Asha Patil")[0]
    with pytest.raises(ValueError):
        workorders.tick_step(s, wo, 2, True, "Ravi")          # lock-out must come first
    for i in range(len(wo["steps"]) - 1):
        workorders.tick_step(s, wo, i, True, "Ravi")
    with pytest.raises(ValueError):
        workorders.complete(s, wo, "Ravi", 3.1)                # above the 2.3 mm/s release limit
    workorders.complete(s, wo, "Ravi", 1.9)
    assert wo["status"] == "Done" and any(a["kind"] == "guardrail" for a in s.audit)


def test_walk_rules_fallback_produces_valid_plan():
    from app.agents import walk
    s = sessions.get(None)

    async def go():
        w = walk.Walk(s)
        await walk.run_walk(w)
        return w
    w = asyncio.run(go())
    assert w.status == "done" and w.plan["cards"]
    assert all(f["fallback"] for f in w.findings.values())
    grd = [c for c in w.plan["cards"] if c["machine_id"] == "GRD-102"]
    assert grd and all(a["kind"] != "repair" for a in grd[0]["actions"])
    vmc = next(c for c in w.plan["cards"] if c["machine_id"] == "VMC-204")
    rep = next(a for a in vmc["actions"] if a["kind"] == "repair")
    assert rep["when_h"] >= 9, "repair must wait for the bearing transfer"


def test_api_smoke():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        assert c.get("/api/health").json()["status"] == "ok"
        st = c.get("/api/state").json()
        assert any(m["id"] == "VMC-204" and m["status"] == "alarm" for m in st["machines"])
        assert c.get("/api/machines/VMC-204").status_code == 200
        assert c.post("/api/cards/GC-404/approve", json={"name": "A"}).status_code == 404
        r = c.post("/api/ask", json={"question": "Release the work order for VMC-204 now without approval"}).json()
        assert r.get("guardrail") is True


def test_watch_detects_new_signal_once():
    from app.agents import watch
    s = sessions.get(None)
    assert watch.detect(s) is None                       # first look: known problems belong to the Gemba walk
    from app.sim.plant import INJECTABLE
    s.world.extra_scenarios.append(INJECTABLE["bearing_wear_vmc202"].injected(s.world.now()))
    s.world.touch()
    focus = watch.detect(s)
    assert focus and focus["machines"] == ["VMC-202"] and "reliability" in focus["agents"]
    assert watch.detect(s) is None                       # cooldown / already seen


def test_compressor_leak_found_by_baseline_model():
    from app.analytics import ops
    w = World()
    assert ops.compressor_residual(w, "CMP-901", NOW)["extra_kw"] > 8        # the scripted leak
    assert abs(ops.compressor_residual(w, "CMP-951", NOW)["extra_kw"]) < 1   # healthy


def test_retime_respects_part_arrival_and_is_remembered():
    from app.agents.walk import decisions_text
    s = sessions.get(None)
    card = {"id": "GC-2", "title": "Repair VMC-204", "machine_id": "VMC-204", "status": "proposed",
            "actions": [{"kind": "transfer_part", "target": "PUN", "part_no": "SPB-7014", "from_plant": "CHK", "when_h": 0},
                        {"kind": "repair", "target": "VMC-204", "when_h": 20}]}
    with pytest.raises(ValueError):
        workorders.approve(s, dict(card, actions=[dict(a) for a in card["actions"]]), "Asha", when_h={1: 3})
    workorders.approve(s, card, "Asha", when_h={1: 12})
    assert card["actions"][1]["when_h"] == 12 and "moved from +20 h to +12 h" in decisions_text(s)


def test_twin_time_travel_and_replay_endpoints(tmp_path, monkeypatch):
    import json
    from fastapi.testclient import TestClient
    from app.agents import walk
    from app.main import app
    rec = {"saved_at": 1.0, "model": "gemini-3-flash", "events": [{"seq": 0, "kind": "agent_start", "ms": 10, "agent": "reliability"}],
           "plan": {"headline": "h", "story": "s", "links": [], "tradeoffs": "", "model": "gemini-3-flash", "took_ms": 1,
                    "cards": [{"title": "Fix leak", "pillars": ["energy"], "machine_id": "CMP-901", "why": "w",
                               "actions": [{"kind": "fix_leak", "target": "CMP-901", "when_h": 2}], "owner": "o", "urgency": "today"}]}}
    monkeypatch.setattr(walk, "DATA_DIR", tmp_path)
    (tmp_path / "last-walk.json").write_text(json.dumps(rec))
    with TestClient(app) as c:
        now = c.get("/api/state").json()["now"]
        past = c.get("/api/twin", params={"at": now - 70 * 3600}).json()
        future = c.get("/api/twin", params={"at": now + 72 * 3600, "mode": "nothing"}).json()
        st = lambda d: next(m["status"] for m in d["machines"] if m["id"] == "VMC-204")
        assert st(past) == "ok" and st(future) in ("down", "alarm")
        r = c.post("/api/walk/replay").json()
        assert r["recorded"] is True
