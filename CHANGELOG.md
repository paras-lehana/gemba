# Changelog

## 0.4.3 — 2026-10-19
- Fix (tester points 9 and 14): when Gemini leaves a card's machine empty, the server takes it from the first action
  aimed at a machine, then from the title or reason. Cards are split into "Main problem" and "Also found" again, and
  the machine page lists its cards. A card without a machine is never grouped with others.
- Floor (tester 2, real time): the twin and ticker use the same live feed as the machine page (interpolated between
  one-minute samples plus a 2-second measurement flicker), so values move every tick at 1×; frozen sensors stay frozen.
- Walk lanes have a capped height and scroll inside, keeping the newest tool call in view, so the five columns end level.
- `/demo`: 16 px side margins on phones.

## 0.4.2 — 2026-10-19
- `/demo`: a demo page in the app's theme with the product video (plays on click, privacy-enhanced YouTube), the
  four-department story, measured numbers, trust points and the Google services used. Replaces the plain redirect.
- Home page: a top strip "See us on Google Cloud Run" (`GEMBA_CLOUD_RUN_URL`) and a link to the demo video; on Cloud
  Run itself it says so. Hosting facts are injected into the page by the server (`window.GEMBA_HOSTING`).
- Cloud Run deploy script `ops/deploy_cloudrun.sh` (Artifact Registry image, Gemini through Agent Platform with the
  service account).

## 0.4.1 — 2026-10-18
- Fix: browsers could get an old cached copy of the app's scripts from the CDN (old ₹ formatting, missing time
  travel and drill panels). The page now loads its scripts from a versioned path (`/a/<version>/`) and every static
  file is sent with `Cache-Control: no-cache`.

## 0.4.0 — 2026-10-18
- Tester review: plain-language explanations everywhere, Learn mode with a Gemini tutor and interactive lessons, drills
  (fault in 30 s, 10×/60× speed, progress), presenter faults marked when used, browser alerts before agents start.
- Money in US dollars everywhere.
- Gemba walk: compact lanes, "five lenses, not a sequence" explainer, main problem vs also-found cards, retime box
  rebuilt with explained metrics and "why this changes", older duplicate cards superseded; card detail page.
- Machine 360: live ticker readings, "What does waiting cost?" (production, labour, money), links to card pages,
  3D CAD-style drill-down with exploded and cut-away views.
- Floor: unmistakable time travel (what changes panel, stopped machines look stopped), live values on the twin and a
  ticker strip, speed and drill controls.
- Technician job: whole-row tick targets, progress, next step highlighted, voice follows the next open step.
- Ask: SQL and data behind "How Gemba got this answer"; Quality headings explained.

## 0.3.0 — 2026-10-16
- Gemba Watch: agents start by themselves when a new signal appears (machine wear, frozen sensor, air leak, scrap jump),
  calling only the specialists that signal needs; notifications with a link to the walk.
- Time travel on the twin: 3 days back to 3 days ahead, with the approved plan or "if we do nothing"; play the next 72 h.
- Retime a card before approving: sliders recompute the impact on the simulator; approval refuses a repair before the
  spare part can arrive; edits and rejections are remembered and passed to the Lead on the next walk ("What Gemba learned").
- Link graph of how the departments' findings connect; earlier waiting cards on the walk page.
- Compressor energy baseline model (kW vs plant load) for leak detection; new `compressor_baseline` tool.
- Planned-repair status on the twin; welcome dialog and seven-step guided tour.
- Resilience: Gemini provider chain (gateway → AI Studio key when present), model health badge with a 5-minute probe,
  labelled rules fallback, and replay of the last recorded live Gemini walk when the model is unreachable.
- 20 tests.

## 0.2.0 — 2026-10-15 (night)
- Web app: control room with a live 3D digital twin (Three.js, health / energy / quality lenses, 2D fallback),
  Gemba walk with streamed agent lanes and approvable plan cards, Machine 360, Ask Gemba with SQL and charts,
  Quality station with Gemini vision boxes, Energy and carbon, Supply and demand, Work orders, technician job view
  with voice in Hindi / Marathi / Thai / English, Trust and audit. Phone layout at 390 px, light and dark themes.
- Backend: analytics (health, ISO-style zones, time-to-trip range, anomaly model, scrap control charts, energy per good
  part, night base load, OEE losses), what-if simulator, read-only DuckDB views with a SQL guard, Gemini client with
  four providers, Gemba walk (5 specialists + Lead), Ask, vision, voice, work orders with lock-out and release checks,
  presenter controls, rate limits for model-backed endpoints.
- Tests: 16 (simulator, analytics, SQL guard, guardrails, rules fallback, API smoke); browser sweep script.
- Sample part photos generated with a Gemini image model by the team.

## 0.1.0 — 2026-10-15
- Rules, research, concept, architecture, build plan; plant simulator and ERP layer.
