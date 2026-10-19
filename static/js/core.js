// Shared helpers: API calls, live store, formatting, toasts, small DOM utilities.

// API origin: empty when the page and the API share a host; set window.GEMBA_API_BASE (static/config.js) when the
// front end is hosted elsewhere, e.g. Firebase Hosting in front of the plant server.
export const API = (window.GEMBA_API_BASE || "").replace(/\/$/, "");
const CRED = API ? "omit" : "same-origin";
// Cross-site hosting cannot rely on cookies (Safari/Firefox block third-party cookies): carry the session id instead.
let SID = (() => { try { return localStorage.getItem("gemba-sid") || ""; } catch (e) { return ""; } })();
function keepSid(r) {
  const s = r.headers.get("X-Gemba-Session");
  if (API && s && s !== SID) { SID = s; try { localStorage.setItem("gemba-sid", s); } catch (e) {} }
}
const hdrs = (extra = {}) => (API && SID ? { ...extra, "X-Gemba-Session": SID } : extra);
export const apiUrl = (path) => API + path;
export const stream = (path) => new EventSource(API + path + (API && SID ? `${path.includes("?") ? "&" : "?"}sid=${SID}` : ""));

export const api = {
  async get(path) {
    const r = await fetch(API + path, { credentials: CRED, headers: hdrs() });
    keepSid(r);
    if (!r.ok) throw await errorOf(r);
    return r.json();
  },
  async post(path, body, opts = {}) {
    const init = { method: "POST", credentials: CRED };
    if (body instanceof FormData) { init.body = body; init.headers = hdrs(); }
    else { init.headers = hdrs({ "Content-Type": "application/json" }); init.body = JSON.stringify(body || {}); }
    const r = await fetch(API + path, init);
    keepSid(r);
    if (!r.ok) throw await errorOf(r);
    return r.json();
  },
};
async function errorOf(r) {
  let msg = `${r.status} ${r.statusText}`;
  try { const d = await r.json(); msg = d.detail || d.answer || msg; } catch (e) {}
  const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  err.status = r.status;
  return err;
}

// ------------------------------------------------------------------ live store (catalog + ticks)
export const store = {
  catalog: null, tick: null, plant: "PUN", subs: new Set(),
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); },
  emit(kind) { for (const fn of this.subs) { try { fn(kind, this); } catch (e) { console.error(e); } } },
  machine(id) { return this.catalog?.machines.find((m) => m.id === id); },
  live(id) { return this.tick?.machines.find((m) => m.id === id); },
  plantInfo(id = this.plant) { return this.catalog?.plants.find((p) => p.id === id); },
};
try { const p = localStorage.getItem("gemba-plant"); if (p) store.plant = p; } catch (e) {}

// ------------------------------------------------------------------ DOM
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------ formatting
const TZ = { PUN: "Asia/Kolkata", CHK: "Asia/Kolkata", RAY: "Asia/Bangkok" };
export function localTime(epoch, plant = store.plant, withDay = false) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ[plant] || "Asia/Kolkata", hour: "2-digit", minute: "2-digit",
    ...(withDay ? { weekday: "short" } : {}) }).format(new Date(epoch * 1000));
}
export const num = (v, d = 0) => v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
export const pct = (v, d = 0) => v == null ? "–" : `${(v * 100).toFixed(d)} %`;
// All money is in US dollars (the simulated plants' rupee and baht values are converted at ₹88 and ฿33 per dollar).
export const FX_NOTE = "US dollars (converted at ₹88 and ฿33 per US$)";
export function money(v) {
  if (v == null || Number.isNaN(+v)) return "–";
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}k`;
  return `${sign}$${a.toLocaleString("en-US", { maximumFractionDigits: a < 10 ? 2 : 0 })}`;
}
export const hours = (hh) => hh == null ? "–" : hh < 1 ? `${Math.round(hh * 60)} min` : hh < 48 ? `${hh.toFixed(hh < 10 ? 1 : 0)} h` : `${(hh / 24).toFixed(1)} days`;
export const STATUS = { ok: "Running fine", watch: "Watch", alarm: "Act now", down: "Stopped", sensor: "Sensor fault", idle: "Not scheduled", repair: "Planned repair" };
export const statusChip = (st) => h("span", { class: `status st-${st}` }, STATUS[st] || st);
export const AGENTS = {
  reliability: { name: "Reliability", word: "reliability", ico: "⚙" }, quality: { name: "Quality", word: "quality", ico: "◎" },
  supply: { name: "Supply", word: "supply & demand", ico: "⇄" }, energy: { name: "Energy", word: "sustainability", ico: "ϟ" },
  flow: { name: "Flow", word: "efficiency", ico: "≋" }, lead: { name: "Gemba Lead", word: "orchestrator", ico: "✦" },
};
export const agentChip = (a) => h("span", { class: `chip agent-chip ag-${a}` }, `${AGENTS[a]?.ico || ""} ${AGENTS[a]?.name || a}`);

// ------------------------------------------------------------------ toasts + name memory
export function toast(msg, kind = "ok", ms = 4200, action = null) {
  const t = h("div", { class: `toast ${kind === "ok" ? "" : kind}` }, msg,
    action ? h("a", { href: action.href, class: "toast-action", onclick: () => t.remove() }, action.label) : null);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}
export function rememberedName() { try { return localStorage.getItem("gemba-name") || ""; } catch (e) { return ""; } }
export function rememberName(n) { try { localStorage.setItem("gemba-name", n); } catch (e) {} }
export function glow(el) { if (!el) return; el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.remove("glow"); void el.offsetWidth; el.classList.add("glow"); el.focus?.(); }
