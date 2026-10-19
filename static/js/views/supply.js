// Supply and demand: open orders and whether the plant can cover them, demand trend with forecast, spares across plants.
import { api, store, h, num, money, localTime } from "../core.js";
import { lineChart } from "../charts.js";

export async function render(main) {
  const page = h("div", { class: "page" });
  page.append(h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Supply and demand"),
    h("p", {}, "Cover = finished stock plus the good parts the line will make before the due time, divided by the order. Below 100 % the order will be short."))));
  main.append(page);
  const d = await api.get("/api/orders");
  page.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Open orders")),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "Order"), h("th", {}, "Customer"), h("th", {}, "Product"), h("th", { class: "n" }, "Qty"), h("th", {}, "Due"), h("th", { class: "n" }, "Cover"), h("th", {}, "Status"), h("th", { class: "hide-phone" }, "Note"))),
      h("tbody", {}, ...d.orders.map((o) => h("tr", {},
        h("td", { class: "mono" }, o.so), h("td", {}, o.customer), h("td", {}, o.product), h("td", { class: "n" }, num(o.qty)),
        h("td", { class: "small" }, `${o.due_local} (${num(o.due_in_h)} h)`),
        h("td", { class: "n" }, h("div", {}, `${Math.round(o.cover * 100)} %`), h("div", { class: "bar", style: "width:90px;margin-left:auto" }, h("i", { style: `width:${Math.min(100, o.cover * 100 / 1.5)}%;background:${o.cover < 1 ? "var(--alarm)" : o.cover < 1.08 ? "var(--watch)" : "var(--ok)"}` }))),
        h("td", {}, h("span", { class: `status st-${o.status === "at risk" ? "alarm" : o.status === "tight" ? "watch" : "ok"}` }, o.status)),
        h("td", { class: "small dim hide-phone" }, o.note || "")))))))) ;
  const grid = h("div", { class: "grid", style: "grid-template-columns:repeat(auto-fit,minmax(340px,1fr));margin-top:16px" });
  page.append(grid);
  for (const [p, dd] of Object.entries(d.demand)) {
    if (!["CH-15", "GH-7", "BRK-22"].includes(p)) continue;
    const hist = dd.history.map((r) => ({ t: r.day, v: r.qty })), fc = dd.forecast.map((r) => ({ t: r.day, v: r.mean }));
    grid.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, `Daily orders: ${store.catalog.products[p].name}`)),
      h("div", { class: "panel-body" }, lineChart({ series: [{ pts: hist, color: "var(--sup)" }, { pts: [hist[hist.length - 1], ...fc], cls: "forecast" }], ymin: 0, height: 170, label: `demand ${p}` }),
        h("p", { class: "tiny dim" }, "Dashed: 14-day forecast (Holt exponential smoothing with weekly pattern)."))));
  }
  grid.append(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, "Critical spares by plant")),
    h("div", { class: "panel-body grid", style: "gap:10px" }, ...d.spares.map((s) => h("div", {}, h("b", {}, `${s.part_no} `), h("span", { class: "dim small" }, s.name),
      h("div", { class: "small num" }, s.stock.map((r) => `${r.plant} ${r.on_hand}${r.in_transit ? ` (+${r.in_transit} coming)` : ""}`).join(" · ")))))));
}
