// Energy and carbon: kWh per good part against each machine's normal, compressors drawing power at night, tariff windows.
import { api, store, h, num, money, localTime } from "../core.js";
import { barList } from "../charts.js";

export async function render(main) {
  const page = h("div", { class: "page" });
  page.append(h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Energy and carbon"),
    h("p", {}, "Energy per good part tells you more than total kWh: a worn machine or an air leak shows up as energy that makes nothing. Carbon uses each country's grid factor."))));
  const top = h("div", { class: "kpis" });
  const grid = h("div", { class: "grid", style: "grid-template-columns:repeat(auto-fit,minmax(340px,1fr));margin-top:16px" });
  page.append(top, grid);
  main.append(page);
  const d = await api.get("/api/energy");
  for (const p of d.plants) top.append(h("div", { class: "kpi" }, h("div", { class: "label" }, p.name), h("div", { class: "value" }, `${num(p.kw_now)} kW`), h("div", { class: "sub" }, `${num(p.co2e_kg_h)} kg CO2e per hour now`)));
  const ranked = d.machines.filter((m) => m.kwh_per_good_change_pct != null).slice(0, 10);
  grid.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "kWh per good part vs normal")),
    h("div", { class: "panel-body" }, barList(ranked.map((m) => ({ label: `${m.machine_id} · ${m.kwh_per_good} kWh/part`, value: m.kwh_per_good_change_pct,
      color: m.kwh_per_good_change_pct > 10 ? "var(--alarm)" : m.kwh_per_good_change_pct > 4 ? "var(--watch)" : "var(--ene)",
      note: `normal ${m.kwh_per_good_baseline} · ${money(m.cost_24h, m.currency)} and ${num(m.co2e_kg_24h)} kg CO2e in 24 h` })), (v) => `${v > 0 ? "+" : ""}${num(v, 1)} %`))));
  grid.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Compressed air at night")),
    h("div", { class: "panel-body grid", style: "gap:12px" },
      h("p", { class: "small dim" }, "Power drawn between 01:00 and 05:00 compared with a week ago. Extra load while the lines are stopped is usually a leak."),
      ...d.compressors.map((c) => h("div", {}, h("div", { class: "row gap" }, h("b", {}, c.machine_id), c.extra_kw > 3 ? h("span", { class: "status st-watch" }, `+${c.extra_kw} kW`) : h("span", { class: "status st-ok" }, "normal")),
        h("div", { class: "small dim" }, `${c.quiet_hours_kw} kW now vs ${c.baseline_kw} kW a week ago${c.extra_kw > 3 ? ` · ${num(c.extra_kwh_per_day)} kWh, ${money(c.extra_cost_per_day, c.currency)} and ${num(c.co2e_kg_per_day)} kg CO2e a day (${money(c.extra_cost_per_year, c.currency)} a year)` : ""}`))))));
  const tz = d.tariffs[store.plant] || d.tariffs.PUN;
  const colors = { offpeak: "var(--ene)", normal: "var(--panel-3)", peak: "var(--alarm)" };
  grid.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, `Electricity price, next 36 h (${store.plantInfo()?.name})`)),
    h("div", { class: "panel-body" },
      h("div", { style: "display:grid;grid-template-columns:repeat(36,1fr);gap:2px;height:44px", role: "img", "aria-label": "tariff bands for the next 36 hours" },
        ...tz.map((t) => h("div", { title: `${localTime(t.t)} ${t.band} ${t.price}`, style: `background:${colors[t.band]};border-radius:3px` }))),
      h("div", { class: "row", style: "justify-content:space-between;margin-top:4px" }, ...[0, 12, 24, 35].map((i) => h("span", { class: "tiny dim num" }, localTime(tz[i].t, store.plant, true)))),
      h("div", { class: "row gap wrap small dim", style: "margin-top:8px" }, h("span", {}, "■ off-peak"), h("span", { style: "color:var(--alarm)" }, "■ peak"), h("span", {}, "■ normal"),
        h("span", {}, `Prices: ${Object.entries(store.plantInfo()?.tariff || {}).map(([k, v]) => `${k} ${v}`).join(" · ")} per kWh`)))));
}
