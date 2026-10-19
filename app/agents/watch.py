"""Gemba Watch: agents that act on events, not only on request.

Every live tick compares the machines that need attention with the ones Gemba has already seen. A new signal (a machine
starts wearing, a sensor freezes, a compressor starts leaking, scrap jumps) starts a focused walk with only the agents that
signal needs; the result arrives as new cards and a notification. Limits keep it calm: one check at a time, at least
90 s apart, at most 8 per visitor session.
"""
from ..analytics.snapshot import plant_snapshot
from ..sim.plant import H
from . import walk as walk_mod

TRIGGER = ("alarm", "sensor", "down", "watch")
COOLDOWN_S = 90
MAX_RUNS = 8


def detect(session):
    """Run on each tick (worker thread). Returns a focus dict when a new signal should start a check, else None."""
    w = session.world
    now = w.now()
    snap = plant_snapshot(w, now, key=session.id)
    flagged = {(m["id"], m["status"]): m for m in snap["machines"] if m["status"] in TRIGGER}
    if session.watch_known is None:            # first look: today's known problems are for the Gemba walk
        session.watch_known = set(flagged)
        return None
    new = [m for key, m in flagged.items() if key not in session.watch_known]
    if not new:
        return None
    running = any(x.status == "running" for x in session.walks.values())
    if running or now - session.watch_last < COOLDOWN_S or session.watch_runs >= MAX_RUNS:
        return None                            # try again on a later tick; keys stay unseen
    for m in new:
        session.watch_known.add((m["id"], m["status"]))
    agents = []
    for m in new:
        for a in walk_mod.agents_for(m):
            if a not in agents:
                agents.append(a)
    signal = "; ".join(f"{m['id']} ({m['name']}): {', '.join(m['reasons']) or m['status']}" for m in new)
    session.watch_last = now
    session.watch_runs += 1
    return {"machines": [m["id"] for m in new], "signal": signal, "agents": agents, "trigger": "watch"}


def launch(session, focus: dict):
    """Start the focused walk (must run on the event loop) and record the notification."""
    wk = walk_mod.start(session, focus=focus)
    session.watch_events.append({"id": len(session.watch_events) + 1, "t": session.world.now(), "kind": "start", "walk_id": wk.id,
                                 "agents": focus["agents"], "text": f"Gemba Watch noticed {focus['signal']}. Calling the "
                                 f"{', '.join(focus['agents'])} agent{'s' if len(focus['agents']) > 1 else ''}."})
    return wk
