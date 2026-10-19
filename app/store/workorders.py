"""Approving a Gemba card: a named person turns the agents' proposal into work orders, and the visitor's plant changes.

Nothing the agents propose touches the plant until this runs. Each action becomes a work order with steps (lock-out
first for any physical job); actions the simulator understands also become interventions, so the twin, OEE, scrap and
energy respond from the scheduled time onwards.
"""
from ..sim.catalog import MACHINES, SPARES
from ..sim.plant import H, REPAIR_HOURS, Intervention

STEPS = {
    "repair": [
        "Lock-out / tag-out: isolate main power, air and coolant; try the start button to prove zero energy",
        "Remove the spindle cover and drawbar; mark the orientation of every part",
        "Press out the old bearing set and check the housing for scoring",
        "Fit the new SPB-7014 bearing set: heat to 80 °C, never hammer; set preload per the maintenance manual",
        "Run-in: 10 min each at 2,000, 6,000 and 12,000 rpm while watching bearing temperature",
        "Release check: vibration at or below 2.3 mm/s at 12,000 rpm and temperature stable, then remove locks",
    ],
    "fix_leak": [
        "Walk the air header with the ultrasonic leak detector while the lines are stopped",
        "Tag every leak with its location and size (hiss / audible / large)",
        "Isolate the branch, replace couplings and hoses, re-make joints",
        "Check the compressor's quiet-hours load the next night is back to baseline",
    ],
    "quarantine_lot": [
        "Tag lot AL-2210 HOLD and move it to the quarantine area",
        "Load the next good lot (AL-2214) on both die-casting cells",
        "Sort parts cast from AL-2210 in the last 24 h with a dye-penetrant or X-ray check",
        "Raise a supplier quality complaint with the lot test results",
    ],
    "recalibrate": [
        "Do NOT stop the machine for repair: the machine is fine, the sensor is suspect",
        "Check the sensor connector and cable (the last fault was a loose connector)",
        "Compare against a handheld reading; replace the sensor if it still does not move",
        "Confirm the live value moves again on the twin",
    ],
    "slow": ["Set spindle override to the agreed speed", "Note the change in the shift log", "Watch scrap at the next inspection"],
    "inspect100": ["Inspect every part from the machine at the station", "Segregate rejects with a red tag",
                   "Record counts per hour in the quality log"],
    "transfer_part": ["Pick the part at the source store", "Pack and dispatch with the transfer note", "Receive and book into stock"],
}
TITLES = {"repair": "Repair", "fix_leak": "Fix air leaks", "quarantine_lot": "Quarantine lot", "recalibrate": "Check sensor",
          "slow": "Containment: reduce speed", "inspect100": "100 % inspection", "transfer_part": "Transfer spare part",
          "adjust_tool_life": "Adjust tool life", "notify_customer": "Inform customer", "reschedule": "Reschedule production"}
SIM_KINDS = ("repair", "fix_leak", "quarantine_lot", "recalibrate", "slow")


def approve(session, card: dict, name: str, note: str = "", when_h: dict | None = None) -> list:
    """Create work orders and interventions for every action of an approved card. `when_h` lets the approver retime
    actions ({action index: hours from now}); edits are logged and remembered for the next walk."""
    w = session.world
    now = w.now()
    wos = []
    edits = []
    for idx, val in (when_h or {}).items():
        i = int(idx)
        if 0 <= i < len(card["actions"]):
            old = float(card["actions"][i].get("when_h") or 0)
            new = max(0.0, min(120.0, float(val)))
            if abs(new - old) >= 0.25:
                card["actions"][i]["when_h"] = new
                edits.append(f"{card['actions'][i]['kind'].replace('_', ' ')} of {card['actions'][i].get('target')} moved from +{old:.0f} h to +{new:.0f} h")
    eta = max([float(SPARES.get((a.get("part_no") or "SPB-7014").upper(), {}).get("transfer_h", {}).get((a.get("from_plant") or "CHK").upper(), 0))
               + float(a.get("when_h") or 0) for a in card["actions"] if a["kind"] == "transfer_part"] or [0.0])
    for a in card["actions"]:
        if a["kind"] == "repair" and a.get("target") in MACHINES and MACHINES[a["target"]].kind == "VMC":
            plant = MACHINES[a["target"]].plant
            if session.stock("SPB-7014", plant) < 1 and float(a.get("when_h") or 0) < eta - 0.01:
                raise ValueError(f"The spindle bearing reaches {plant} in {eta:.0f} h; the repair cannot start before that.")
    for a in card["actions"]:
        kind = a["kind"]
        start = now + float(a.get("when_h") or 0) * H
        target = a.get("target") or card.get("machine_id") or ""
        wo = {"id": session.next_id("WO"), "card": card["id"], "kind": kind, "title": f"{TITLES.get(kind, kind)}: {target}",
              "machine_id": target if target in MACHINES else card.get("machine_id") or None, "target": target,
              "start": start, "end": start + (REPAIR_HOURS * H if kind == "repair" else H), "status": "Scheduled",
              "approved_by": name, "approved_at": now, "created": now, "note": a.get("note") or note,
              "steps": [{"text": t, "done": False, "by": None, "at": None} for t in STEPS.get(kind, ["Do the task", "Confirm done"])],
              "lang_hint": None, "release_reading": None}
        if kind == "transfer_part":
            pn = (a.get("part_no") or "SPB-7014").upper()
            src = (a.get("from_plant") or "CHK").upper()
            dest = target if target in ("PUN", "CHK", "RAY") else "PUN"
            eta = SPARES.get(pn, {}).get("transfer_h", {}).get(src, 9)
            if session.spares.get(pn, {}).get(src, 0) > 0:
                session.spares[pn][src] -= 1
                session.transfers.append({"part_no": pn, "qty": 1, "from": src, "to": dest, "depart": now, "arrive": now + eta * H, "wo": wo["id"]})
                wo.update(title=f"Transfer {pn}: {src} → {dest}", end=now + eta * H, status="In transit")
            else:
                wo.update(status="Blocked", note=f"No {pn} in stock at {src}")
        if kind in SIM_KINDS:
            iv_target = target
            w.interventions.append(Intervention(kind, iv_target, start, float(a.get("value") or (0.85 if kind == "slow" else 0)), name,
                                                card["title"]))
        if kind == "repair" and wo["machine_id"] and MACHINES[wo["machine_id"]].kind == "VMC":
            plant = MACHINES[wo["machine_id"]].plant
            if session.stock("SPB-7014", plant) > 0:
                session.spares["SPB-7014"][plant] -= 1        # reserved for this job
        session.work_orders[wo["id"]] = wo
        wos.append(wo)
    card.update(status="approved", approved_by=name, approved_at=now, work_orders=[x["id"] for x in wos], approval_note=note,
                edits=edits)
    session.decisions.append({"t": now, "kind": "edited" if edits else "approved", "title": card["title"], "by": name,
                              "reason": "; ".join(edits) or note, "card": card["id"]})
    w.touch()
    session.log(name, f"Approved card {card['id']}", card["title"], kind="human", ref=card["id"],
                evidence=[f"{x['id']} {x['title']}" for x in wos])
    return wos


def reject(session, card: dict, name: str, reason: str):
    card.update(status="rejected", rejected_by=name, reject_reason=reason)
    session.decisions.append({"t": session.world.now(), "kind": "rejected", "title": card["title"], "by": name, "reason": reason,
                              "card": card["id"]})
    session.log(name, f"Rejected card {card['id']}", f"{card['title']} — reason: {reason}", kind="human", ref=card["id"])


def refresh(session):
    """Time-driven status: scheduled → in progress → done (for jobs the simulator runs), transfers → arrived."""
    now = session.world.now()
    for wo in session.work_orders.values():
        if wo["status"] in ("Done", "Blocked", "Cancelled"):
            continue
        if wo["kind"] == "transfer_part":
            if now >= wo["end"]:
                wo["status"] = "Done"
                session.log("system", f"{wo['id']} part arrived", wo["title"], kind="system", ref=wo["id"])
        elif wo["kind"] in SIM_KINDS:
            if now >= wo["end"] and all(s["done"] for s in wo["steps"]):
                wo["status"] = "Done"
            elif now >= wo["start"]:
                wo["status"] = "In progress"


def tick_step(session, wo: dict, idx: int, done: bool, by: str):
    if not 0 <= idx < len(wo["steps"]):
        raise ValueError("no such step")
    if wo["kind"] == "repair" and idx > 0 and not wo["steps"][0]["done"] and done:
        raise ValueError("Lock-out / tag-out must be confirmed first")
    st = wo["steps"][idx]
    st.update(done=done, by=by if done else None, at=session.world.now() if done else None)
    session.log(by, f"{'Ticked' if done else 'Unticked'} step {idx + 1} on {wo['id']}", st["text"], kind="human", ref=wo["id"])


def complete(session, wo: dict, by: str, reading: float | None):
    if wo["kind"] == "repair":
        if reading is None:
            raise ValueError("Enter the release vibration reading (mm/s)")
        if reading > 2.3:
            session.log(by, f"Release refused on {wo['id']}", f"vibration {reading} mm/s is above 2.3 mm/s", kind="guardrail", ref=wo["id"])
            raise ValueError(f"{reading} mm/s is above the 2.3 mm/s release limit: do not release, check the bearing fit")
        if not all(s["done"] for s in wo["steps"][:-1]):
            raise ValueError("Tick every step before release")
    for s in wo["steps"]:
        if not s["done"]:
            s.update(done=True, by=by, at=session.world.now())
    wo.update(status="Done", release_reading=reading, done_by=by, done_at=session.world.now())
    session.log(by, f"Completed {wo['id']}", wo["title"] + (f" — release reading {reading} mm/s" if reading is not None else ""),
                kind="human", ref=wo["id"])
