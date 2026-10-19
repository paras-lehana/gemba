"""Worker voice assistant: a technician asks about the job in Hindi, Marathi, Thai or English and hears the answer.

The browser turns speech into text (or sends audio when the model accepts it) and reads the reply aloud. Gemini answers
from the work order, its steps and the machine's live data, in the worker's language, and never advises skipping
lock-out or the release check.

The assistant follows the job: the prompt says which steps are done, which are open and which one is NEXT, so a plain
"what now?" is answered with the next open step, and any other question gets a short answer plus a reminder of that
step. Without a model (GEMBA_LLM=mock, or the model is unreachable) a deterministic, job-aware answer is built from the
same data in the worker's language, so the page still helps on the floor.
"""
import time

from ..analytics.snapshot import machine_state
from . import llm
from . import tools as T

LANGS = {"hi": "Hindi (Devanagari script)", "mr": "Marathi (Devanagari script)", "th": "Thai", "en": "English", "ta": "Tamil"}
SYSTEM = """You are Gemba's voice assistant for a maintenance technician on the shop floor. Hands are busy and gloves are on,
so answer in at most 3 short spoken sentences, in {lang}. Keep machine IDs, part numbers and numbers in Latin digits.
Answer only from the job card and live data below.

Follow the job. Progress: {progress}. The NEXT open step is: {next_step}
- If the worker asks what to do, what is next, or anything vague, answer about the next open step: say its number and
  what to do, in plain words.
- If the worker asks "why", explain the reason for the next open step (use the reason given below) in plain words.
- If the worker asks something else, answer it briefly, then end with one short sentence reminding them of the next
  open step by its number.
- If asked to read the open steps, read them in order with their numbers, shortly.
Safety first: never suggest skipping lock-out / tag-out, doing a step before lock-out is confirmed, removing guards,
or releasing the machine before the release check (vibration at or below 2.3 mm/s). If unsure, say to ask the supervisor.

Job card:
{job}

Why the next step matters: {why}

Live machine data:
{live}"""

# Plain reasons per step, matched by keywords in the step text (the job page shows a longer version of the same).
WHY = [
    (("lock-out", "tag-out"), "Your own lock on power, air and coolant means nobody can start the machine while your hands are inside; pressing start proves it is really off."),
    (("spindle cover", "drawbar"), "The cover hides the bearings; marking each part's position makes it go back the same way and stay balanced."),
    (("press out",), "A press pushes the worn bearing out without damage; scratches in the housing would ruin the new bearing."),
    (("heat to", "preload"), "Warming the bearing lets it slide on without force; hammering dents it. Correct preload stops rattling and overheating."),
    (("run-in",), "Stepping the speed up settles the new bearing and spreads its grease; rising temperature means something is fitted wrong."),
    (("release check",), "2.3 mm/s is close to a healthy spindle (about 1.6 mm/s); above it the bearing is not seated right and the machine must not go back to work."),
    (("leak detector",), "Leaks are easier to hear when the lines are stopped; the ultrasonic detector hears the hiss you cannot."),
    (("tag every leak",), "A tag lets the crew find each leak again, and its size says which to fix first."),
    (("isolate the branch", "couplings"), "Closing that branch first means no air blows out while you work; most leaks are at joints and old hoses."),
    (("quiet-hours", "baseline"), "At night nothing uses air, so the compressor should be nearly idle; if it is, the leaks are fixed."),
    (("quarantine", "hold"), "This metal batch makes castings with tiny holes; a HOLD tag stops anyone using it by mistake."),
    (("next good lot",), "A batch that passed testing keeps the casting cells making good parts."),
    (("dye-penetrant", "x-ray"), "Parts already made may hide holes you cannot see; the check stops bad parts reaching the customer."),
    (("supplier quality complaint",), "The test results get the cost back and stop the supplier sending more bad metal."),
    (("do not stop the machine",), "The machine is fine; only its sensor reading is frozen, so a repair stop would waste hours."),
    (("connector", "cable"), "Most frozen sensors are a loose plug or a damaged cable, a quick fix."),
    (("handheld",), "A handheld meter is an independent check; if it disagrees, the fixed sensor is wrong."),
    (("live value",), "When the number moves again on the screen, the sensor is working."),
    (("spindle override",), "Running slower reduces shaking and scrap until the repair."),
    (("shift log",), "The next shift needs to know why the machine runs slower."),
    (("scrap", "inspect", "reject", "quality log"), "Checking and recording parts keeps bad ones away from the customer and shows if the fix works."),
    (("pick the part", "dispatch", "book into stock"), "The repair can only start once the spare part has arrived and is booked in."),
]

# Localised words for the answer built without a model.
FB = {
    "en": {"next": "Next is step {n} of {m}: {t}", "done": "All {m} steps are done. Finish the job at the bottom of the page.",
           "why": "Why: {w}", "safety": "Safety: lock-out first, guards stay on, and release only at or below 2.3 mm/s.",
           "open": "Open steps: {s}", "remind": "Your next step is {n}: {t}", "loto": "Lock-out comes first. Do not start any other step."},
    "hi": {"next": "अगला कदम {n} / {m}: {t}", "done": "सभी {m} कदम पूरे हो गए। पेज के नीचे काम बंद करें।",
           "why": "क्यों: {w}", "safety": "सुरक्षा: पहले लॉक-आउट, गार्ड न हटाएँ, और 2.3 mm/s या उससे कम पर ही मशीन चालू करें।",
           "open": "बाकी कदम: {s}", "remind": "आपका अगला कदम {n}: {t}", "loto": "पहले लॉक-आउट करें। उससे पहले कोई और कदम नहीं।"},
    "mr": {"next": "पुढची पायरी {n} / {m}: {t}", "done": "सर्व {m} पायऱ्या पूर्ण झाल्या. पानाच्या खाली काम बंद करा.",
           "why": "का: {w}", "safety": "सुरक्षा: आधी लॉक-आउट, गार्ड काढू नका, आणि 2.3 mm/s किंवा कमी असेल तरच मशीन सुरू करा.",
           "open": "उरलेल्या पायऱ्या: {s}", "remind": "तुमची पुढची पायरी {n}: {t}", "loto": "आधी लॉक-आउट करा. त्याआधी दुसरी पायरी नाही."},
    "th": {"next": "ขั้นตอนถัดไป {n} จาก {m}: {t}", "done": "ทำครบทั้ง {m} ขั้นตอนแล้ว ปิดงานที่ด้านล่างของหน้า",
           "why": "เหตุผล: {w}", "safety": "ความปลอดภัย: ล็อกเอาต์ก่อน ห้ามถอดการ์ด และปล่อยเครื่องเมื่อการสั่นไม่เกิน 2.3 mm/s เท่านั้น",
           "open": "ขั้นตอนที่เหลือ: {s}", "remind": "ขั้นตอนถัดไปของคุณคือ {n}: {t}", "loto": "ต้องล็อกเอาต์ก่อน ห้ามทำขั้นตอนอื่น"},
}
# Words that mark the worker's intent in the fallback (the job page's quick-question buttons use these phrases).
INTENT = {
    "why": ("why", "क्यों", "का करा", "का?", "ทำไม", "เพราะอะไร"),
    "safety": ("safe", "सुरक्षा", "सुरक्षित", "ปลอดภัย"),
    "all": ("all open", "read all", "सभी", "सगळ्या", "सर्व", "ทั้งหมด"),
    "next": ("next", "अगला", "पुढ", "ถัดไป", "what now", "what do i do"),
}


def why_of(text: str) -> str:
    low = (text or "").lower()
    for keys, reason in WHY:
        if any(k in low for k in keys):
            return reason
    return "It keeps the job safe and on record."


def progress(wo: dict) -> dict:
    """Done/open steps and the next open step; for a repair, nothing but lock-out is next until lock-out is ticked."""
    steps = wo.get("steps") or []
    done = [i for i, s in enumerate(steps) if s.get("done")]
    open_ = [i for i, s in enumerate(steps) if not s.get("done")]
    nxt = open_[0] if open_ else None
    loto_open = wo.get("kind") == "repair" and steps and not steps[0].get("done")
    if loto_open:
        nxt = 0
    return {"done": done, "open": open_, "next": nxt, "total": len(steps), "loto_open": bool(loto_open)}


def _intent(text: str) -> str:
    low = (text or "").lower()
    for k in ("all", "why", "safety", "next"):
        if any(w in low for w in INTENT[k]):
            return k
    return "other"


def fallback_answer(wo: dict | None, text: str, lang: str) -> str:
    """A deterministic answer from the job itself, used without a model."""
    f = FB.get(lang, FB["en"])
    if not wo:
        return {"en": "Open a job to get step-by-step help.", "hi": "कदम-दर-कदम मदद के लिए कोई काम खोलें।",
                "mr": "पायरी-पायरीने मदतीसाठी एखादे काम उघडा.", "th": "เปิดงานเพื่อรับความช่วยเหลือทีละขั้นตอน"}.get(lang, "Open a job.")
    p = progress(wo)
    steps = wo["steps"]
    if p["next"] is None:
        return f["done"].format(m=p["total"])
    n, t = p["next"] + 1, steps[p["next"]]["text"]
    it = _intent(text)
    if it == "all":
        return f["open"].format(s="; ".join(f"{i + 1}. {steps[i]['text']}" for i in p["open"]))
    if it == "why":
        return f"{f['next'].format(n=n, m=p['total'], t=t)}. {f['why'].format(w=why_of(t))}"
    if it == "safety":
        return f"{f['safety']} {f['loto'] if p['loto_open'] else f['remind'].format(n=n, t=t)}"
    out = f["next"].format(n=n, m=p["total"], t=t)
    return f"{out}. {f['loto']}" if p["loto_open"] else out


async def answer(session, wo: dict | None, text: str, lang: str = "hi", audio: dict | None = None) -> dict:
    t = time.time()
    lang = lang if lang in LANGS else "en"
    now = session.world.now()
    job = "No job selected."
    live = "{}"
    prog_txt, next_txt, why = "no job", "none", "-"
    p = None
    if wo:
        p = progress(wo)
        job = T.dumps({k: wo.get(k) for k in ("id", "title", "kind", "machine_id", "status", "note")} |
                      {"steps": [f"{i + 1}. {s['text']} ({'DONE by ' + str(s.get('by')) if s['done'] else 'open'})"
                                 for i, s in enumerate(wo["steps"])]})
        prog_txt = (f"{len(p['done'])} of {p['total']} steps done; done: {[i + 1 for i in p['done']] or 'none'}; "
                    f"open: {[i + 1 for i in p['open']] or 'none'}")
        if p["loto_open"]:
            prog_txt += "; lock-out (step 1) is NOT confirmed, so every other step is locked"
        if p["next"] is not None:
            s = wo["steps"][p["next"]]["text"]
            next_txt, why = f"step {p['next'] + 1}: {s}", why_of(s)
        else:
            next_txt = "none, all steps are done; the worker should finish the job (release check / Mark job done)"
        if wo.get("machine_id"):
            st = machine_state(session.world, wo["machine_id"], now, detail=True)
            live = T.dumps({"status": st["status"], "readings": {k: {"value": r["value"], "unit": r["unit"], "alarm": r["alarm"]}
                                                                 for k, r in st["readings"].items()}, "health": st["health"]})
    extra = {"next_step": (p["next"] + 1) if p and p["next"] is not None else None,
             "done_steps": len(p["done"]) if p else 0, "total_steps": p["total"] if p else 0}
    if llm.provider() == "mock":
        return {"answer": fallback_answer(wo, text, lang), "lang": lang, "fallback": True, "model": "job steps (no model)",
                "ms": int(1000 * (time.time() - t))} | extra
    content = [{"type": "text", "text": text or "(spoken question attached)"}]
    if audio and audio.get("data"):
        content.append({"type": "audio", "mime": audio.get("mime", "audio/webm"), "data": audio["data"]})
    msgs = [{"role": "system", "content": SYSTEM.format(lang=LANGS[lang], job=job, live=live, progress=prog_txt,
                                                        next_step=next_txt, why=why)},
            {"role": "user", "content": content}]
    try:
        r = await llm.chat(msgs, role="voice", temperature=0.3)
    except llm.LLMError:
        # The floor still needs an answer: fall back to the job steps, clearly labelled.
        return {"answer": fallback_answer(wo, text, lang), "lang": lang, "fallback": True, "model": "job steps (model unreachable)",
                "ms": int(1000 * (time.time() - t))} | extra
    session.log("Voice assistant", f"Answered a worker question ({lang})", (text or "audio")[:160], kind="agent",
                ref=wo["id"] if wo else "")
    return {"answer": r.content.strip(), "lang": lang, "model": r.model, "ms": int(1000 * (time.time() - t))} | extra
