// Work: every work order created from approved cards. Each row says in one plain sentence what the job is, what its
// status means, how far the technician has got (progress bar), and links to the technician's job page.
import { api, store, h, localTime, hours } from "../core.js";
import { jobExplain } from "./job.js";

const ST = { Scheduled: "idle", "In transit": "sensor", "In progress": "watch", Done: "ok", Blocked: "alarm" };
const ST_MEANS = {
  Scheduled: "Waiting for its planned start time.",
  "In transit": "The spare part is on its way between plants.",
  "In progress": "The planned time has started; the technician is working through the steps.",
  Done: "Finished and recorded with the technician's name.",
  Blocked: "Cannot start yet.",
};

export async function render(main) {
  const page = h("div", { class: "page" });
  page.append(h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Work orders"),
    h("p", {}, "A work order is the to-do list for one job on the floor. Gemba creates one only when a named person approves a Gemba card. The technician opens it on a phone, ticks each step (lock-out first for any repair) and can ask questions by voice."))));
  const box = h("div", { class: "grid" });
  page.append(box);
  main.append(page);
  async function load() {
    let wos;
    try { wos = await api.get("/api/workorders"); } catch (e) { return; }
    box.innerHTML = "";
    if (!wos.length) {
      box.append(h("div", { class: "panel empty" }, h("p", {}, "No work orders yet."), h("p", { class: "small" }, "Run a Gemba walk and approve a card to create them."), h("a", { class: "btn", href: "#/walk", style: "margin-top:10px" }, "Go to the Gemba walk")));
      return;
    }
    const now = store.tick?.now || 0;
    const open = wos.filter((w) => w.status !== "Done").length;
    box.append(h("p", { class: "small dim" }, `${wos.length} work order${wos.length === 1 ? "" : "s"}, ${open} still open. Tap a job to open the technician's step-by-step view.`));
    box.append(h("ul", { class: "wo-list", "aria-label": "Work orders" }, ...wos.slice().reverse().map((w) => {
      const done = w.steps.filter((s) => s.done).length;
      const total = w.steps.length;
      const plant = store.machine(w.machine_id)?.plant || store.plant;
      const when = w.start > now ? `Starts ${localTime(w.start, plant, true)} (in ${hours((w.start - now) / 3600)})` : `Started ${localTime(w.start, plant, true)}`;
      const nextStep = w.steps.find((s) => !s.done);
      return h("li", {}, h("a", { class: "wo-row", href: `#/job/${w.id}`, "aria-label": `${w.title}, ${w.status}, ${done} of ${total} steps done. Open job.` },
        h("span", { class: "row gap wrap" }, h("span", { class: "mono small dim" }, w.id), h("span", { class: `status st-${ST[w.status] || "idle"}` }, w.status),
          h("span", { class: "grow" }), h("span", { class: "tiny dim" }, when)),
        h("strong", { class: "wo-title" }, w.title),
        h("span", { class: "wo-explain small" }, jobExplain(w)),
        h("span", { class: "tiny dim" }, w.status === "Blocked" && w.note ? `Blocked: ${w.note}` : ST_MEANS[w.status] || ""),
        h("span", { class: "wo-prog" },
          h("span", { class: "jbar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done), "aria-label": `${done} of ${total} steps done` },
            h("i", { style: `width:${total ? (100 * done) / total : 0}%` })),
          h("span", { class: "tiny num" }, `${done} of ${total} steps`)),
        h("span", { class: "tiny dim" }, w.status === "Done" ? `Closed by ${w.done_by || w.approved_by}` : nextStep ? `Next: ${nextStep.text}` : "All steps ticked; ready to close."),
        h("span", { class: "tiny dim" }, `Approved by ${w.approved_by}`, h("span", { class: "wo-open", "aria-hidden": "true" }, "Open job →"))));
    })));
  }
  await load();
  const off = store.on((k) => { if (k === "changed") load(); });
  const t = setInterval(load, 15000);
  return () => { off(); clearInterval(t); };
}
