// Technician job view (phone first). The whole step row is the tick control ("Tap when done"), a progress bar counts
// done steps, the next open step is highlighted "Do this now", and for a repair every step after lock-out stays locked
// until lock-out is ticked. Each step has a plain "Why?" explanation. The voice assistant follows the job: quick
// questions in Hindi / Marathi / Thai / English, and after a tick the next step is read aloud (unless muted).
// Release only with a vibration reading at or below the limit, explained on the page.
import { api, store, h, toast, rememberedName, rememberName, glow, localTime, hours } from "../core.js";
import { term, explain } from "../learn.js";

const LANGS = [["hi", "हिन्दी", "hi-IN"], ["mr", "मराठी", "mr-IN"], ["th", "ไทย", "th-TH"], ["en", "English", "en-IN"]];
const UI = {
  hi: { ask: "माइक दबाएँ और सवाल पूछें", listening: "सुन रहा हूँ…", type: "या यहाँ लिखें", tap: "काम पूरा होने पर दबाएँ", now: "अभी यह करें",
    undo: "वापस लेने के लिए दबाएँ", locked: "बंद: पहले लॉक-आउट (कदम 1) पूरा करें", prog: (d, n) => `${n} में से ${d} पूरे`,
    stepDone: (n) => `कदम ${n} पूरा।`, next: (n) => `अगला कदम ${n}:`, allDone: "सभी कदम पूरे। अब नीचे काम बंद करें।",
    q: ["मेरा अगला कदम क्या है?", "यह कदम क्यों?", "सुरक्षा जाँच", "सभी बाकी कदम पढ़ें"], on: "आवाज़ चालू", off: "आवाज़ बंद" },
  mr: { ask: "माइक दाबा आणि प्रश्न विचारा", listening: "ऐकत आहे…", type: "किंवा इथे लिहा", tap: "काम झाल्यावर दाबा", now: "आता हे करा",
    undo: "परत घेण्यासाठी दाबा", locked: "बंद: आधी लॉक-आउट (पायरी 1) पूर्ण करा", prog: (d, n) => `${n} पैकी ${d} पूर्ण`,
    stepDone: (n) => `पायरी ${n} पूर्ण.`, next: (n) => `पुढची पायरी ${n}:`, allDone: "सर्व पायऱ्या पूर्ण. आता खाली काम बंद करा.",
    q: ["माझी पुढची पायरी कोणती?", "ही पायरी का करायची?", "सुरक्षा तपासणी", "सर्व उरलेल्या पायऱ्या वाचा"], on: "आवाज चालू", off: "आवाज बंद" },
  th: { ask: "แตะไมค์แล้วถามคำถาม", listening: "กำลังฟัง…", type: "หรือพิมพ์ที่นี่", tap: "แตะเมื่อทำเสร็จ", now: "ทำขั้นตอนนี้ตอนนี้",
    undo: "แตะเพื่อยกเลิก", locked: "ล็อกอยู่: ต้องล็อกเอาต์ (ขั้นตอนที่ 1) ก่อน", prog: (d, n) => `เสร็จ ${d} จาก ${n}`,
    stepDone: (n) => `ขั้นตอนที่ ${n} เสร็จแล้ว`, next: (n) => `ถัดไป ขั้นตอนที่ ${n}:`, allDone: "ทำครบทุกขั้นตอนแล้ว ปิดงานที่ด้านล่าง",
    q: ["ขั้นตอนถัดไปของฉันคืออะไร", "ทำไมต้องทำขั้นตอนนี้", "ตรวจความปลอดภัย", "อ่านขั้นตอนที่เหลือทั้งหมด"], on: "เปิดเสียง", off: "ปิดเสียง" },
  en: { ask: "Tap the mic and ask a question", listening: "Listening…", type: "or type here", tap: "Tap when done", now: "Do this now",
    undo: "Tap to undo", locked: "Locked: confirm lock-out (step 1) first", prog: (d, n) => `${d} of ${n} done`,
    stepDone: (n) => `Step ${n} done.`, next: (n) => `Next, step ${n}:`, allDone: "All steps done. Finish the job at the bottom.",
    q: ["What is my next step?", "Why this step?", "Safety check", "Read all open steps"], on: "Voice on", off: "Voice off" },
};

// Plain-language reason for each step, matched by keywords in the step text (the voice assistant has a short copy).
const WHY = [
  [["lock-out", "tag-out"], "Before anyone puts a hand inside, switch off power, compressed air and coolant and put your own padlock and tag on each switch. Then press Start: if nothing moves, the machine is truly off. Most serious factory injuries happen when a machine starts during a repair, so every other step stays locked until this one is ticked."],
  [["spindle cover", "drawbar"], "The spindle is the part that spins the cutting tool, up to 12,000 turns a minute; its bearings sit under this cover. The drawbar holds the tool. Marking how each part sat means it goes back exactly the same way, so the spindle stays balanced."],
  [["press out"], "A bearing is a ring of small steel balls that lets the spindle turn smoothly. The worn one is pushed out evenly with a press. Scratches (\"scoring\") inside the housing would damage the new bearing within days, so look before fitting it."],
  [["heat to", "preload"], "Warming the new bearing to 80 °C makes it grow slightly, so it slides on without force. Hammering dents the balls and it fails early. \"Preload\" is how tightly the bearing is squeezed: too loose and it rattles, too tight and it overheats."],
  [["run-in"], "A new bearing needs to settle. Low, then medium, then full speed spreads the grease evenly. If the bearing temperature keeps climbing instead of levelling off, stop: something is fitted wrong."],
  [["release check"], "Vibration is how hard the spindle shakes, in millimetres per second (mm/s). A healthy spindle shakes at about 1.6 mm/s; the alarm is at 4.5 and the machine stops itself at 7.1. At or below 2.3 mm/s proves the new bearing is seated right. Only then are the locks removed."],
  [["leak detector"], "Compressed air is one of the most expensive kinds of energy in a factory. Small leaks cannot be heard over running machines, so walk the main air pipe (the \"header\") while lines are stopped, with an ultrasonic detector that picks up the hiss."],
  [["tag every leak"], "A tag on each leak lets the crew find it again. The size (hiss, audible, large) tells them which leak wastes the most and should be fixed first."],
  [["isolate the branch", "couplings"], "Closing the valve for that pipe branch first means no air blows out while you work. Most leaks are at joints, quick couplings and old hoses."],
  [["quiet-hours", "baseline"], "At night no machine uses air, so the compressor should be almost idle. If its night-time electricity use is back to normal, the leaks are really fixed."],
  [["quarantine", "hold"], "A \"lot\" is one batch of raw aluminium from the supplier. This lot makes castings with tiny gas holes (porosity). A HOLD tag and a separate area stop anyone using it by mistake."],
  [["next good lot"], "Switching both casting cells to a lot that passed testing keeps them making good parts while the bad lot is sorted out."],
  [["dye-penetrant", "x-ray"], "Parts already cast from the bad lot may hide holes you cannot see. A dye-penetrant test (a coloured liquid that seeps into cracks) or an X-ray finds them, so faulty parts never reach the customer."],
  [["supplier quality complaint"], "Sending the supplier the test results gets the cost back and makes them fix their process, so the next delivery is good."],
  [["do not stop"], "The machine itself is fine: its temperature reading has stopped changing (\"frozen\"), which means the sensor is faulty, not the machine. Stopping production for a repair would waste hours for nothing."],
  [["connector", "cable"], "Most frozen sensors are a loose plug or a damaged cable. Re-seating the connector is a five-minute fix."],
  [["handheld"], "A handheld meter is an independent check. If it disagrees with the fixed sensor, or the sensor still does not move, replace the sensor."],
  [["live value"], "The digital twin is the live 3D copy of the factory in this app. When the number moves again there, the sensor works and the alert clears."],
  [["spindle override"], "Running a little slower reduces chatter (shaking that leaves rough marks on parts) and scrap until the real repair."],
  [["shift log"], "The next shift needs to know why the machine runs slower, so nobody turns the speed back up."],
  [["watch scrap"], "Scrap means parts that must be thrown away. Checking it at the next inspection shows whether the slower speed helps."],
  [["inspect every part"], "Until the cause is fixed, every part is checked, not just a sample, so no bad part slips through."],
  [["red tag"], "A red tag marks a rejected part so it cannot be mixed back with good ones."],
  [["record counts"], "Counts per hour show whether the problem is getting better or worse."],
  [["pick the part"], "The spare part is taken from the store of the plant that has one in stock."],
  [["dispatch"], "The transfer note travels with the part, so the receiving plant knows what it is and which job it is for."],
  [["book", "stock"], "Booking the part in tells the system it has arrived, so the repair can start on time."],
];
export function whyOf(text) {
  const low = (text || "").toLowerCase();
  const hit = WHY.find(([keys]) => keys.some((k) => low.includes(k)));
  return hit ? hit[1] : "This step keeps the job safe and on record, so the next person knows exactly what was done.";
}

// One plain sentence per job type (also used by the work-order list).
export function jobExplain(wo) {
  const t = wo.target || wo.machine_id || "";
  return ({
    repair: `Replace the worn spindle bearing on ${t}. The bearing lets the cutting spindle spin smoothly; a worn one shakes, spoils parts and can stop the machine, so it is changed in a planned stop.`,
    fix_leak: `Find and fix compressed-air leaks around ${t}. Leaks make the compressor run all night and waste electricity and money.`,
    quarantine_lot: `Stop using metal batch ${t} and check parts already made from it, so no castings with hidden holes reach the customer.`,
    recalibrate: `The temperature reading on ${t} is frozen. Check the sensor, not the machine: the machine itself is fine and keeps running.`,
    slow: `Run ${t} a little slower until the repair, so it makes fewer bad parts.`,
    inspect100: `Check every part from ${t} until the problem is fixed.`,
    transfer_part: "Ship the spare bearing to the plant that needs it, so the repair can start on time.",
  })[wo.kind] || "A task from an approved Gemba plan.";
}

const stepsOpen = (wo) => wo.steps.map((s, i) => (s.done ? -1 : i)).filter((i) => i >= 0);
const lotoOpen = (wo) => wo.kind === "repair" && wo.steps.length && !wo.steps[0].done;
function nextIdx(wo) { if (lotoOpen(wo)) return 0; const o = stepsOpen(wo); return o.length ? o[0] : -1; }

export async function render(main, [id]) {
  const page = h("div", { class: "page" });
  main.append(page);
  let wo;
  try { wo = (await api.get("/api/workorders")).find((w) => w.id === id); } catch (e) {}
  if (!wo) { page.append(h("div", { class: "panel pad" }, h("h2", {}, "Job not found"), h("a", { href: "#/work" }, "Back to work orders"))); return; }
  let lang = (() => { try { return localStorage.getItem("gemba-lang") || "en"; } catch (e) { return "en"; } })();
  let muted = (() => { try { return localStorage.getItem("gemba-voice-mute") === "1"; } catch (e) { return false; } })();
  const plant = store.machine(wo.machine_id)?.plant || "PUN";
  const job = h("div", { class: "job jobv" });
  page.append(job);
  const head = h("div", { class: "grid", style: "gap:6px" });
  const name = h("input", { type: "text", value: rememberedName(), placeholder: "Your name", "aria-label": "Your name for the job record", autocomplete: "name" });
  const progBox = h("div", { class: "jprog", "aria-live": "polite" });
  const stepsBox = h("ol", { class: "jsteps", "aria-label": "Job steps" });
  const finBox = h("div");
  const voiceBox = h("section", { class: "panel pad grid jvoice", style: "gap:12px", "aria-label": "Voice assistant" });
  const convo = h("div", { class: "grid", style: "gap:8px", "aria-live": "polite" });
  const follow = h("p", { class: "small dim" });
  let sig = "";
  const setWo = (w) => { wo = w; sig = JSON.stringify([w.status, w.steps.map((s) => s.done)]); };
  job.append(h("a", { href: "#/work", class: "small jback" }, "← Work orders"), head,
    h("label", { class: "field" }, "Technician (your name goes on every tick)", name), progBox, stepsBox, finBox, voiceBox);

  function drawHead() {
    head.innerHTML = "";
    const now = store.tick?.now || 0;
    head.append(h("div", { class: "row gap wrap" }, h("h1", {}, wo.title), h("span", { class: `status st-${wo.status === "Done" ? "ok" : wo.status === "Blocked" ? "alarm" : wo.status === "In progress" ? "watch" : "idle"}` }, wo.status)),
      h("p", { class: "jexplain" }, jobExplain(wo)),
      h("p", { class: "dim small" }, `${wo.id} · approved by ${wo.approved_by} · ${wo.start > now ? `starts ${localTime(wo.start, plant, true)} (in ${hours((wo.start - now) / 3600)})` : `started ${localTime(wo.start, plant, true)}`}`));
  }

  function drawSteps(focusIdx = null) {
    const t = UI[lang];
    const done = wo.steps.filter((s) => s.done).length;
    const total = wo.steps.length;
    const nx = nextIdx(wo);
    progBox.innerHTML = "";
    progBox.append(h("div", { class: "row gap" }, h("strong", { lang }, t.prog(done, total)), h("span", { class: "grow" }),
      h("span", { class: "tiny dim" }, wo.kind === "repair" ? "Lock-out first, then in order" : "Work top to bottom")),
      h("div", { class: "jbar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done), "aria-label": `${done} of ${total} steps done` },
        h("i", { style: `width:${total ? (100 * done) / total : 0}%` })));
    stepsBox.innerHTML = "";
    const locked = lotoOpen(wo);
    wo.steps.forEach((s, i) => {
      const loto = i === 0 && wo.kind === "repair";
      const isLocked = locked && i > 0 && !s.done;
      const isNext = i === nx && !s.done;
      const cls = ["jstep", s.done ? "done" : "", isNext ? "next" : "", isLocked ? "locked" : "", loto ? "loto" : ""].join(" ");
      const hint = s.done ? h("span", { class: "jhint", lang: "en" }, `✓ ${s.by} · ${localTime(s.at, plant)} · `, h("span", { lang }, t.undo))
        : isLocked ? h("span", { class: "jhint lock", lang }, "🔒 ", t.locked)
        : h("span", { class: "jhint tap", lang }, t.tap);
      const btn = h("button", { type: "button", class: "jstep-main", role: "checkbox", "aria-checked": String(!!s.done),
        "aria-disabled": isLocked ? "true" : null, "data-step": String(i),
        "aria-label": `Step ${i + 1}: ${s.text}. ${s.done ? `Done by ${s.by}. Tap to undo.` : isLocked ? "Locked until lock-out is confirmed." : "Tap when done."}` },
        h("span", { class: "jbox", "aria-hidden": "true" }, s.done ? "✓" : isLocked ? "🔒" : ""),
        h("span", { class: "jbody" },
          h("span", { class: "row gap wrap" }, h("span", { class: "jnum" }, `Step ${i + 1}`),
            loto ? h("span", { class: "status st-watch" }, "Safety first") : null,
            isNext ? h("span", { class: "jnow", lang }, t.now) : null),
          h("span", { class: "jtext" }, s.text), hint));
      btn.onclick = () => tick(i, isLocked);
      stepsBox.append(h("li", { class: cls }, btn,
        h("details", { class: "jwhy" }, h("summary", {}, "Why this step?"), h("p", {}, whyOf(s.text)))));
    });
    if (focusIdx != null) {
      const b = stepsBox.querySelector(`[data-step="${focusIdx}"]`);
      if (b) { b.focus({ preventScroll: true }); b.scrollIntoView({ block: "center", behavior: "smooth" }); }
    }
    follow.textContent = nx >= 0 ? `Gemba follows your job: it knows step ${nx + 1} is next and answers about it first.` : "All steps are done; ask anything about closing the job.";
    drawFinish();
  }

  async function tick(i, isLocked) {
    const t = UI[lang];
    if (isLocked) {
      toast("Locked for your safety: tick lock-out (step 1) first. Nobody may work inside until the power, air and coolant are locked off.", "err", 5200);
      glow(stepsBox.querySelector('[data-step="0"]'));
      say(t.locked);
      return;
    }
    if (name.value.trim().length < 2) { toast("Type your name first: every tick is recorded with who did it.", "err"); glow(name); return; }
    const was = wo.steps[i].done;
    try {
      setWo(await api.post(`/api/workorders/${wo.id}/step`, { step: i, done: !was, name: name.value.trim() }));
      rememberName(name.value.trim());
    } catch (e) { toast(e.message, "err"); return; }
    const nx = nextIdx(wo);
    drawSteps(was ? i : nx >= 0 ? nx : i);
    if (!was) {
      const msg = nx >= 0 ? `${t.stepDone(i + 1)} ${t.next(nx + 1)} ${wo.steps[nx].text}` : `${t.stepDone(i + 1)} ${t.allDone}`;
      say(msg);
      if (nx < 0) glow(finBox.querySelector("input, button"));
    }
  }

  function drawFinish() {
    finBox.innerHTML = "";
    if (wo.status === "Done") {
      finBox.append(h("p", { class: "status st-ok" }, `Done${wo.release_reading != null ? ` · release reading ${wo.release_reading} mm/s` : ""}${wo.done_by ? ` · closed by ${wo.done_by}` : ""}`));
      return;
    }
    const fin = h("button", { class: "btn ok jfin", type: "button" }, wo.kind === "repair" ? "Release machine" : "Mark job done");
    let reading = null;
    const panel = h("section", { class: "panel pad grid jrelease", style: "gap:10px" });
    if (wo.kind === "repair") {
      const live = store.live(wo.machine_id)?.vib;
      const verdict = h("p", { class: "small", "aria-live": "polite" });
      reading = h("input", { type: "number", inputmode: "decimal", step: "0.1", min: "0", placeholder: "e.g. 1.9", "aria-label": "Release vibration reading in mm/s" });
      reading.oninput = () => {
        const v = parseFloat(reading.value);
        verdict.className = "small";
        if (Number.isNaN(v)) { verdict.textContent = ""; return; }
        if (v <= 2.3) { verdict.classList.add("jok"); verdict.textContent = `${v} mm/s is at or below 2.3: the new bearing runs smoothly. Safe to release.`; }
        else { verdict.classList.add("jbad"); verdict.textContent = `${v} mm/s is above 2.3: do not release. The bearing is not seated right; check the fit and ask the supervisor.`; }
      };
      const mark = (v, label, cls) => h("span", { class: `jmark ${cls}`, style: `left:${Math.min(100, (v / 8) * 100)}%` }, h("b", {}, label));
      panel.append(h("h2", {}, "Release check: what 2.3 mm/s means"),
        h("p", { class: "small" }, term("vibration", "Vibration"), " is how hard the spindle shakes, measured in millimetres per second (mm/s). Measure it at 12,000 rpm after the run-in."),
        h("div", { class: "jscale", "aria-hidden": "true" }, h("i", {}), mark(1.6, "healthy 1.6", "ok"), mark(2.3, "release ≤ 2.3", "rel"), mark(4.5, "alarm 4.5", "watch"), mark(7.1, "stops 7.1", "alarm"),
          live != null ? h("span", { class: "jlive", style: `left:${Math.min(100, (live / 8) * 100)}%` }, h("b", {}, `now ${live.toFixed(1)}`)) : null),
        h("ul", { class: "small jlegend" },
          h("li", {}, "About 1.6 mm/s: a healthy spindle."),
          h("li", {}, "At or below 2.3 mm/s: the new bearing is seated right. Release the machine and remove the locks."),
          h("li", {}, "4.5 mm/s: alarm. 7.1 mm/s: the machine stops itself to avoid damage."),
          live != null ? h("li", {}, `Right now ${wo.machine_id} reads ${live.toFixed(1)} mm/s${live > 2.3 ? ", which is why it needs this repair." : "."}`) : null),
        h("label", { class: "field" }, "Your reading (mm/s)", reading), verdict, explain("Release vibration limit 2.3 mm/s", `Spindle bearing repair on ${wo.machine_id}`));
    } else {
      panel.append(h("p", { class: "small dim" }, "When every step is done, close the job. Your name and the time go into the audit log so the next shift knows it is finished."));
    }
    fin.onclick = async () => {
      if (name.value.trim().length < 2) { toast("Type your name first.", "err"); glow(name); return; }
      try {
        setWo(await api.post(`/api/workorders/${wo.id}/complete`, { name: name.value.trim(), reading: wo.kind === "repair" ? parseFloat(reading.value) || null : null }));
        toast("Job closed and recorded in the audit log."); drawHead(); drawSteps(); store.emit("changed");
      } catch (e) { toast(e.message, "err"); glow(wo.kind === "repair" ? reading : fin); }
    };
    panel.append(fin);
    finBox.append(panel);
  }

  function voicePanel() {
    const t = UI[lang];
    voiceBox.innerHTML = "";
    const langBar = h("div", { class: "plants", role: "group", "aria-label": "Language" }, ...LANGS.map(([k, label]) =>
      h("button", { type: "button", "aria-pressed": String(k === lang), lang: k, onclick: () => { lang = k; try { localStorage.setItem("gemba-lang", k); } catch (e) {} drawSteps(); voicePanel(); } }, label)));
    const muteBtn = h("button", { type: "button", class: "btn small jmute", "aria-pressed": String(!muted), lang },
      muted ? `🔇 ${t.off}` : `🔊 ${t.on}`);
    muteBtn.onclick = () => { muted = !muted; try { localStorage.setItem("gemba-voice-mute", muted ? "1" : "0"); } catch (e) {} if (muted) stopSpeech(); voicePanel(); };
    const mic = h("button", { type: "button", class: "mic", "aria-label": t.ask }, "🎙");
    const text = h("input", { type: "text", placeholder: t.type, lang, "aria-label": "Type your question" });
    const status = h("p", { class: "small dim center", lang }, t.ask);
    const quick = h("div", { class: "jquick", role: "group", "aria-label": "Quick questions" },
      ...t.q.map((q) => h("button", { type: "button", class: "btn small", lang, onclick: () => ask(q) }, q)));
    voiceBox.append(h("div", { class: "row gap wrap" }, h("h2", { class: "grow" }, "Ask Gemba (voice)"), muteBtn),
      follow, langBar, quick, h("div", { class: "center" }, mic), status,
      h("form", { onsubmit: (e) => { e.preventDefault(); ask(text.value); text.value = ""; } }, text), convo);
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    mic.onclick = () => {
      if (!SR) { toast("Voice input is not supported in this browser; type the question instead.", "info"); text.focus(); return; }
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = LANGS.find((l) => l[0] === lang)[2];
      rec.interimResults = false;
      rec.onstart = () => { mic.classList.add("on"); status.textContent = t.listening; };
      rec.onend = () => { mic.classList.remove("on"); status.textContent = t.ask; rec = null; };
      rec.onerror = (e) => toast(`Voice: ${e.error}`, "err");
      rec.onresult = (e) => ask(e.results[0][0].transcript);
      rec.start();
    };
  }

  async function ask(q) {
    q = (q || "").trim(); if (!q) return;
    const l = lang;
    convo.append(h("div", { class: "bubble me", lang: l }, q));
    const wait = h("div", { class: "bubble" }, h("span", { class: "thinking" }, h("i"), h("i"), h("i")));
    convo.append(wait);
    wait.scrollIntoView({ block: "nearest", behavior: "smooth" });
    try {
      const r = await api.post("/api/voice", { text: q, lang: l, wo_id: wo.id });
      wait.replaceWith(h("div", { class: "bubble", lang: l }, r.answer,
        h("div", { class: "tiny faint", lang: "en" }, r.fallback ? `Answered from the job steps · ${r.model || "no model"}` : `${r.model || ""} · ${((r.ms || 0) / 1000).toFixed(1)} s`)));
      say(r.answer, l);
    } catch (e) { wait.replaceWith(h("div", { class: "bubble" }, e.message)); }
  }

  function stopSpeech() { try { speechSynthesis.cancel(); } catch (e) {} }
  function say(textToSay, l = lang) {
    if (muted || !("speechSynthesis" in window) || !textToSay) return;
    try {
      const code = LANGS.find((x) => x[0] === l)[2];
      const u = new SpeechSynthesisUtterance(textToSay);
      u.lang = code;
      const voices = speechSynthesis.getVoices();
      const v = voices.find((x) => x.lang === code) || voices.find((x) => x.lang?.toLowerCase().startsWith(l));
      if (v) u.voice = v;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  }

  // Keep the job current when someone else ticks a step on another phone (and when the status moves with time).
  setWo(wo);
  async function refresh() {
    try {
      const fresh = (await api.get("/api/workorders")).find((w) => w.id === wo.id);
      if (!fresh) return;
      const s2 = JSON.stringify([fresh.status, fresh.steps.map((s) => s.done)]);
      if (s2 !== sig) { setWo(fresh); drawHead(); if (!finBox.contains(document.activeElement)) drawSteps(); }
    } catch (e) {}
  }
  drawHead(); drawSteps(); voicePanel();
  const timer = setInterval(refresh, 12000);
  const off = store.on((k) => { if (k === "changed") refresh(); });
  return () => { clearInterval(timer); off(); stopSpeech(); };
}
