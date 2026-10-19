// First-visit welcome and a seven-step guided tour (judges have three minutes; every step says what to press).
import { h, $ } from "./core.js";

const STEPS = [
  { href: "#/", text: "This is the plant floor of a simulated auto-parts maker. VMC-204 glows red: its spindle bearing is wearing. Drag Time travel to +72 h and pick “If we do nothing” to see where it goes." },
  { href: "#/walk?start=1", text: "The Gemba walk: five Gemini agents investigate in parallel with real tools, then the Lead links what they found. It takes about 45 seconds; watch the lanes." },
  { href: "#/walk", text: "Each card compares doing nothing with acting, computed by the plant simulator. Adjust the timing if you like, type your name and approve the VMC-204 repair card." },
  { href: "#/work", text: "Approved cards become work orders. Open the repair job: lock-out comes first, and you can ask a question by voice in Hindi, Marathi, Thai or English." },
  { href: "#/quality", text: "Gemini vision inspects part photos. Pick the cylinder head from VMC-204 and see the chatter marks boxed." },
  { href: "#/ask", text: "Ask in plain words; Gemba shows the SQL behind every answer. Try the last suggestion: the guardrail refuses to release work without approval." },
  { href: "#/", text: "Back on the floor: time-travel ahead “With approved plan” to see VMC-204 repaired. Then ⏱ (top right) → inject a fault and watch Gemba Watch call the agents by itself." },
];
const KEY = "gemba-tour";
const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };

let bar = null;
function draw() {
  const i = +(get(KEY) ?? -1);
  bar?.remove(); bar = null;
  if (i < 0 || i >= STEPS.length) return;
  const st = STEPS[i];
  bar = h("aside", { class: "tour", role: "dialog", "aria-label": "Guided tour" },
    h("div", { class: "row gap" }, h("b", {}, `Tour · step ${i + 1} of ${STEPS.length}`),
      h("div", { class: "tour-dots", "aria-hidden": "true" }, ...STEPS.map((_, j) => h("i", { class: j <= i ? "on" : "" }))),
      h("button", { class: "icon-btn right", "aria-label": "Close the tour", onclick: () => { set(KEY, null); draw(); } }, "✕")),
    h("p", {}, st.text),
    h("div", { class: "row gap" },
      i > 0 ? h("button", { class: "btn small", onclick: () => go(i - 1) }, "← Back") : null,
      h("button", { class: "btn small primary right", onclick: () => (i + 1 < STEPS.length ? go(i + 1) : (set(KEY, null), draw())) }, i + 1 < STEPS.length ? "Next →" : "Finish")));
  document.body.append(bar);
}
function go(i) {
  set(KEY, String(i));
  const target = STEPS[i].href;
  if (location.hash !== target) location.hash = target;
  draw();
}
export function startTour() { go(0); }

export function welcome() {
  if (get("gemba-welcomed")) { draw(); return; }
  const dlg = h("dialog", { class: "sheet", "aria-labelledby": "welcome-title" },
    h("h2", { id: "welcome-title" }, "Gemba (現場): an AI operations floor"),
    h("ol", { class: "welcome-list" },
      h("li", {}, "A simulated auto-parts maker with plants in Pune, Chakan and Rayong. All data is synthetic."),
      h("li", {}, "Five Gemini agents walk the plant, link problems across departments (a worn machine → scrap → a late order → wasted energy) and propose one plan."),
      h("li", {}, "You decide: approve with your name, and the work orders and the digital twin follow.")),
    h("div", { class: "row gap wrap", style: "margin-top:14px" },
      h("button", { class: "btn primary", onclick: () => { set("gemba-welcomed", "1"); dlg.close(); startTour(); } }, "Start the 2-minute tour"),
      h("button", { class: "btn", onclick: () => { set("gemba-welcomed", "1"); dlg.close(); } }, "Explore on my own")));
  dlg.addEventListener("cancel", () => set("gemba-welcomed", "1"));
  document.body.append(dlg);
  dlg.showModal();
}
export function refreshTour() { draw(); }
