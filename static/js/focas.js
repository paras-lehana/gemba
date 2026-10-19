// Closed-loop CNC dispatch, simulated. After a person approves a card that slows or repairs a VMC, this shows how the
// change would reach a FANUC controller safely: read first, wait for the end of the part cycle and the Z retract, write
// only at the cycle boundary, then verify by telemetry. No real machine is connected; every value is labelled simulated.
//
//   import { dispatch } from "./focas.js";
//   dispatch(card);            // Promise<boolean>: false (and nothing shown) when the card has no slow/repair on a VMC

import { h, store, apiUrl, API, num } from "./core.js";

const STEP_MS = [0, 2000, 5000, 7000, 8000];

function vmcAction(card) {
  const acts = (card && (card.actions || card.card?.actions)) || [];
  const isVmc = (id) => typeof id === "string" && (store.machine?.(id)?.kind === "VMC" || /^VMC-/i.test(id));
  return acts.find((a) => a.kind === "slow" && isVmc(a.target)) || acts.find((a) => a.kind === "repair" && isVmc(a.target)) || null;
}

// Live readings through the MTConnect current document (falls back to the 2-second tick and catalog values).
async function readMachine(id) {
  const out = { rpm: 12000, load: null, vib: store.live?.(id)?.vib ?? null, exec: "ACTIVE" };
  try {
    const hdr = {};
    try { const sid = API && localStorage.getItem("gemba-sid"); if (sid) hdr["X-Gemba-Session"] = sid; } catch (e) {}
    const r = await fetch(apiUrl(`/api/mtconnect/current?machine=${encodeURIComponent(id)}`), { credentials: API ? "omit" : "same-origin", headers: hdr });
    if (r.ok) {
      const doc = new DOMParser().parseFromString(await r.text(), "application/xml");
      const val = (tag) => { const el = doc.getElementsByTagNameNS("*", tag)[0]; return el ? el.textContent.trim() : null; };
      const f = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
      out.rpm = f(val("RotaryVelocity")) ?? out.rpm;
      out.load = f(val("Load"));
      out.vib = f(val("VibrationVelocityRMS")) ?? out.vib;
      out.exec = val("Execution") || out.exec;
    }
  } catch (e) { /* the modal still runs on the fallback values */ }
  return out;
}

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h("style", { id: "focas-style" }, `
    dialog.focas { border: 1px solid var(--border-2); border-radius: 16px; background: var(--panel); color: var(--text); padding: 0;
      width: min(600px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: auto; box-shadow: var(--shadow); }
    dialog.focas::backdrop { background: rgba(5, 8, 15, .6); backdrop-filter: blur(2px); }
    .focas-in { padding: 16px 18px; display: grid; gap: 12px; }
    .focas-sim { font-size: 13px; font-weight: 600; color: var(--watch); background: var(--watch-bg); border: 1px solid var(--watch); border-radius: 10px; padding: 8px 10px; }
    .focas-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .focas-steps li { display: grid; grid-template-columns: 28px 1fr; gap: 8px; align-items: start; padding: 8px 10px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--panel-2); opacity: .55; transition: opacity .3s, border-color .3s; min-width: 0; }
    .focas-steps li.on { opacity: 1; border-color: var(--link); }
    .focas-steps li.hold { opacity: 1; border-color: var(--watch); background: var(--watch-bg); }
    .focas-steps li.done { opacity: 1; border-color: var(--ok); }
    .focas-steps .ix { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 13px; background: var(--panel-3); }
    .focas-steps li.done .ix { background: var(--ok-bg); color: var(--ok); }
    .focas-steps li.hold .ix { color: var(--watch); }
    .focas-steps b { display: block; font-size: 14px; }
    .focas-steps p { font-size: 13px; color: var(--text-dim); margin-top: 2px; overflow-wrap: anywhere; }
    .focas-steps code { font-family: var(--mono); font-size: 12px; color: var(--text); }
    .focas-log { font-family: var(--mono); font-size: 12px; line-height: 1.55; background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
      padding: 8px 10px; min-height: 96px; max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-dim); }
    .focas-z { height: 8px; border-radius: 4px; background: var(--panel-3); overflow: hidden; }
    .focas-z i { display: block; height: 100%; width: 0; background: var(--watch); transition: width .25s linear; }
    .focas-foot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .focas-foot .btn { min-height: 40px; }
    @media (prefers-reduced-motion: reduce) { .focas-steps li, .focas-z i { transition: none; } }
  `));
}

/** Show the simulated closed-loop dispatch for a card. Resolves true when shown (after it closes), false otherwise. */
export async function dispatch(card) {
  const act = vmcAction(card);
  if (!act || typeof document === "undefined" || !window.HTMLDialogElement) return false;
  style();
  const id = act.target;
  const slow = act.kind === "slow";
  const factor = slow ? Math.max(0.5, Math.min(1, Number(act.value) || 0.85)) : null;
  const ip = `10.24.1.${100 + (parseInt(id.replace(/\D/g, ""), 10) % 100)}`;
  const part = 3900 + Math.floor(Math.random() * 90);
  const z0 = -(30 + Math.random() * 20);

  const log = h("div", { class: "focas-log", role: "log", "aria-live": "polite" });
  const zbar = h("i");
  const steps = [
    ["Read the machine", h("span", {}, "Read spindle speed and tool position: ", h("code", {}, "cnc_rdspeed"), ", ", h("code", {}, "cnc_machine"), ".")],
    ["Safety interlock", h("span", {}, "The tool is cutting. Changing speed mid-cut leaves a step mark on the part or breaks the cutter, so the write is held until the part cycle ends (M30) and the Z axis retracts to home.")],
    [slow ? "Write at the cycle boundary" : "Book the planned stop", slow
      ? h("span", {}, `Set spindle override to ${Math.round(factor * 100)} % with `, h("code", {}, "cnc_wrparas"), " / PMC override signal, only between parts.")
      : h("span", {}, "Write a planned-stop request (", h("code", {}, "cnc_wrmacro"), ") so the machine stops only at a cycle boundary at the approved time.")],
    ["Verify by telemetry", h("span", {}, "Read the controller again and confirm the machine does what was approved; Gemba keeps watching the vibration.")],
  ];
  const lis = steps.map(([t, p], i) => h("li", {}, h("span", { class: "ix" }, String(i + 1)), h("div", {}, h("b", {}, t), h("p", {}, p))));
  const closeBtn = h("button", { class: "btn", type: "button" }, "Close");
  const status = h("span", { class: "small dim" }, "Running…");
  const dlg = h("dialog", { class: "focas", "aria-labelledby": "focas-title" },
    h("div", { class: "focas-in" },
      h("div", { class: "row gap" }, h("h2", { id: "focas-title", class: "grow" }, "Closed-loop CNC dispatch (simulated FANUC FOCAS)")),
      h("div", { class: "focas-sim" }, "Simulated controller: no real machine is connected. This shows the safe order of steps a real connection would follow."),
      h("p", { class: "small dim" }, `${card?.title || card?.card?.title || "Approved action"} → ${id}`),
      h("ol", { class: "focas-steps" }, lis),
      h("div", {}, h("div", { class: "tiny dim", style: { marginBottom: "4px" } }, "Tool retract (Z axis to home)"), h("div", { class: "focas-z" }, zbar)),
      log,
      h("div", { class: "focas-foot" }, status, h("span", { class: "grow" }), closeBtn)));
  document.body.append(dlg);

  const t0 = performance.now();
  const say = (msg) => { log.textContent += `[T+${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`; log.scrollTop = log.scrollHeight; };
  const mark = (i, cls) => lis.forEach((li, j) => { li.className = j < i ? "done" : j === i ? cls : ""; });
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  let finish;
  const closed = new Promise((res) => { finish = res; });
  const close = () => { timers.forEach(clearTimeout); try { dlg.close(); } catch (e) {} dlg.remove(); finish(true); };
  closeBtn.addEventListener("click", close);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.showModal();

  const m = await readMachine(id);
  const rpmNow = Math.round(m.rpm || 12000);
  mark(0, "on");
  say(`Connect ${id} (simulated) at ${ip}:8193 … ok`);
  say(`cnc_rdspeed → spindle ${num(rpmNow)} rpm, override 100 %${m.load != null ? `, load ${m.load} %` : ""}`);
  say(`cnc_machine → Z ${z0.toFixed(3)} mm · ${m.exec === "ACTIVE" ? `IN_CYCLE (part #${part})` : m.exec}`);
  if (m.vib != null) say(`MTConnect current → vibration ${m.vib} mm/s`);

  at(STEP_MS[1], () => {
    mark(1, "hold");
    say("SAFETY INTERLOCK: write held. The tool is in the part; waiting for M30 (end of part cycle) and Z retract to home.");
    const t1 = performance.now();
    const iv = setInterval(() => {
      const k = Math.min(1, (performance.now() - t1) / (STEP_MS[2] - STEP_MS[1]));
      zbar.style.width = `${k * 100}%`;
      if (k >= 1) clearInterval(iv);
    }, 200);
    timers.push(iv);
  });
  at(STEP_MS[2], () => {
    mark(2, "on");
    zbar.style.width = "100%";
    say(`Cycle boundary: part #${part} finished, Z 0.000 mm (home). Interlock released.`);
    if (slow) say(`cnc_wrparas / PMC spindle override → ${Math.round(factor * 100)} % (${num(Math.round(rpmNow * factor))} rpm); operator override dial locked.`);
    else say(`cnc_wrmacro #500 ← planned stop at +${num(act.when_h ?? 0, 1)} h; machine will stop only between parts for the repair crew (lock-out first).`);
  });
  at(STEP_MS[3], () => {
    mark(3, "on");
    if (slow) say(`Verify: cnc_rdspeed → ${num(Math.round(rpmNow * factor))} rpm, override ${Math.round(factor * 100)} %. Matches the approved action.`);
    else say(`Verify: planned-stop request read back from the controller. Matches the approved time.`);
  });
  at(STEP_MS[4], () => {
    mark(4, "done");
    say("Dispatch complete (simulated). Gemba keeps comparing live readings with the plan.");
    status.textContent = "Done (simulated)";
    closeBtn.classList.add("primary");
    closeBtn.focus();
  });
  return closed;
}
