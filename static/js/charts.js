// Small SVG charts (no library): time series with limits and forecast, bars, sparklines, p-charts.
import { localTime } from "./core.js";

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const nice = (v) => { const m = Math.pow(10, Math.floor(Math.log10(Math.abs(v) || 1))); return Math.ceil(v / m * 2) / 2 * m; };

/** Time-series line chart. opts: {series:[{pts:[{t,v}], cls}], limits:[{v,cls,label}], now, band:{t0,t1}, height, unit, plant, ymin} */
export function lineChart(opts) {
  const W = 760, H = opts.height || 220, L = 44, R = 12, T = 12, B = 26;
  const all = opts.series.flatMap((x) => x.pts);
  const lim = (opts.limits || []).map((l) => l.v);
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t));
  let y0 = opts.ymin ?? Math.min(0, ...all.map((p) => p.v)), y1 = nice(Math.max(...all.map((p) => p.v), ...lim) * 1.08 || 1);
  if (opts.ymin == null && Math.min(...all.map((p) => p.v)) > y1 * 0.4) y0 = Math.floor(Math.min(...all.map((p) => p.v)) * 0.95);
  const X = (t) => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / Math.max(1e-9, y1 - y0)) * (H - T - B);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": opts.label || "chart" });
  const g = s("g", { class: "grid" });
  for (let i = 0; i <= 4; i++) {
    const v = y0 + (y1 - y0) * i / 4;
    g.append(s("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
    const tx = s("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" }); tx.textContent = +v.toFixed(v < 10 ? 1 : 0); g.append(tx);
  }
  const span = t1 - t0, stepH = span > 4 * 86400 ? 24 : span > 36 * 3600 ? 12 : 6;
  for (let t = Math.ceil(t0 / (stepH * 3600)) * stepH * 3600; t <= t1; t += stepH * 3600) {
    const tx = s("text", { x: X(t), y: H - 8, "text-anchor": "middle" }); tx.textContent = localTime(t, opts.plant, span > 36 * 3600); g.append(tx);
  }
  svg.append(g);
  if (opts.band) svg.append(s("rect", { class: "band", x: X(opts.band.t0), width: Math.max(2, X(opts.band.t1) - X(opts.band.t0)), y: T, height: H - T - B }));
  for (const l of opts.limits || []) {
    svg.append(s("line", { class: l.cls, x1: L, x2: W - R, y1: Y(l.v), y2: Y(l.v) }));
    const tx = s("text", { x: W - R - 4, y: Y(l.v) - 4, "text-anchor": "end" }); tx.textContent = l.label; svg.append(tx);
  }
  for (const ser of opts.series) {
    if (!ser.pts.length) continue;
    const d = ser.pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
    const path = s("path", { d, class: ser.cls || "series" });
    if (ser.color) path.style.stroke = ser.color;
    svg.append(path);
  }
  if (opts.now) svg.append(s("line", { class: "now-line", x1: X(opts.now), x2: X(opts.now), y1: T, y2: H - B }));
  return svg;
}

/** Horizontal bar list. rows:[{label, value, color, note}] */
export function barList(rows, fmt = (v) => v) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  const wrap = document.createElement("div");
  wrap.className = "grid";
  wrap.style.gap = "8px";
  for (const r of rows) {
    const row = document.createElement("div");
    row.innerHTML = `<div class="row" style="justify-content:space-between;font-size:13px"><span>${r.label}</span><span class="num">${fmt(r.value)}</span></div>
      <div class="bar"><i style="width:${(Math.abs(r.value) / max * 100).toFixed(1)}%;background:${r.color || "var(--rel)"}"></i></div>
      ${r.note ? `<div class="tiny dim">${r.note}</div>` : ""}`;
    wrap.append(row);
  }
  return wrap;
}

/** Vertical bar chart for ask answers: x labels and one or more numeric columns. */
export function barChart(labels, columns, opts = {}) {
  const W = 760, H = opts.height || 240, L = 54, R = 10, T = 10, B = 48;
  const vals = columns.flatMap((c) => c.values.map(Number).filter((v) => !Number.isNaN(v)));
  const y1 = nice(Math.max(...vals, 0) * 1.1 || 1), y0 = Math.min(0, ...vals);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": opts.label || "bar chart" });
  const g = s("g", { class: "grid" });
  for (let i = 0; i <= 4; i++) { const v = y0 + (y1 - y0) * i / 4; g.append(s("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
    const tx = s("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" }); tx.textContent = +v.toPrecision(3); g.append(tx); }
  svg.append(g);
  const n = labels.length, slot = (W - L - R) / Math.max(1, n), bw = Math.min(40, slot * 0.7 / columns.length);
  const colors = ["var(--rel)", "var(--qual)", "var(--sup)", "var(--ene)", "var(--flow)"];
  labels.forEach((lab, i) => {
    columns.forEach((c, j) => {
      const v = Number(c.values[i]); if (Number.isNaN(v)) return;
      const x = L + i * slot + slot / 2 - (columns.length * bw) / 2 + j * bw;
      svg.append(s("rect", { x, width: bw - 2, y: Math.min(Y(v), Y(0)), height: Math.abs(Y(v) - Y(0)), rx: 3, fill: colors[j % 5] }));
    });
    const tx = s("text", { x: L + i * slot + slot / 2, y: H - B + 16, "text-anchor": "middle" });
    tx.textContent = String(lab).slice(0, 12); svg.append(tx);
  });
  return svg;
}

export function sparkline(pts, color = "var(--rel)", w = 120, hgt = 30) {
  if (!pts.length) return s("svg");
  const vs = pts.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const svg = s("svg", { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, "aria-hidden": "true" });
  const d = pts.map((p, i) => `${i ? "L" : "M"}${(i / (pts.length - 1) * w).toFixed(1)},${(hgt - 2 - (p.v - lo) / Math.max(1e-9, hi - lo) * (hgt - 4)).toFixed(1)}`).join("");
  const path = s("path", { d, fill: "none", "stroke-width": 1.6 }); path.style.stroke = color; svg.append(path);
  return svg;
}
