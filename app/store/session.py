"""Per-visitor state: their own plant clock, injected faults, approved actions, work orders, Gemba cards and audit log.

Every visitor (cookie `gemba_sid`) gets a private copy of the story, so a judge's approvals never change another judge's
demo. State lives in memory; "Reset demo" or a cold start restores the seeded story.
"""
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

from ..sim.catalog import SPARES
from ..sim.plant import World

MAX_SESSIONS = 400
_LOCK = threading.Lock()
_SESSIONS: "OrderedDict[str, Session]" = OrderedDict()


@dataclass
class Session:
    id: str
    world: World = field(default_factory=World)
    spares: dict = field(default_factory=lambda: {pn: dict(s["stock"]) for pn, s in SPARES.items()})
    transfers: list = field(default_factory=list)       # {part_no, qty, from, to, depart, arrive}
    work_orders: "OrderedDict[str, dict]" = field(default_factory=OrderedDict)
    cards: "OrderedDict[str, dict]" = field(default_factory=OrderedDict)
    walks: "OrderedDict[str, dict]" = field(default_factory=OrderedDict)
    audit: list = field(default_factory=list)
    inspections: list = field(default_factory=list)
    decisions: list = field(default_factory=list)        # what people approved / rejected / edited (fed to the Lead)
    watch_known: set | None = None                       # machine signals Gemba Watch has already seen
    watch_events: list = field(default_factory=list)
    watch_last: float = 0.0
    watch_runs: int = 0
    drills: list = field(default_factory=list)           # presenter drills: a fault scheduled to start in N seconds
    edge: dict | None = None                             # phone edge probe state (routes/edge.py)
    created: float = field(default_factory=time.time)
    seq: int = 0

    def next_id(self, prefix: str) -> str:
        self.seq += 1
        return f"{prefix}-{26000 + self.seq}"

    def log(self, actor: str, action: str, detail: str = "", kind: str = "human", ref: str = "", evidence=None):
        """Append-only audit trail. kind: human | agent | system | guardrail."""
        self.audit.append({"t": self.world.now(), "wall": time.time(), "actor": actor, "kind": kind, "action": action,
                           "detail": detail, "ref": ref, "evidence": evidence or []})

    def stock(self, part_no: str, plant: str) -> int:
        """Stock on hand now, counting transfers that have arrived."""
        now = self.world.now()
        qty = self.spares.get(part_no, {}).get(plant, 0)
        for tr in self.transfers:
            if tr["part_no"] == part_no and tr["to"] == plant and tr["arrive"] <= now:
                qty += tr["qty"]
        return qty

    def in_transit(self, part_no: str, plant: str):
        now = self.world.now()
        return [tr for tr in self.transfers if tr["part_no"] == part_no and tr["to"] == plant and tr["arrive"] > now]


def get(sid: str | None) -> Session:
    with _LOCK:
        if sid and sid in _SESSIONS:
            _SESSIONS.move_to_end(sid)
            return _SESSIONS[sid]
        s = Session(id=sid if sid and len(sid) == 32 else secrets.token_hex(16))
        _SESSIONS[s.id] = s
        while len(_SESSIONS) > MAX_SESSIONS:
            _SESSIONS.popitem(last=False)
        s.log("system", "Demo started", "Seeded story: Meridian Precision Components, 3 plants", kind="system")
        return s


def reset(sid: str) -> Session:
    with _LOCK:
        _SESSIONS.pop(sid, None)
    return get(sid)


def count() -> int:
    return len(_SESSIONS)
