# How Gemba works

## The Gemba walk

*Gemba* (現場) is the lean-manufacturing word for "the real place": the shop floor. Managers "go to the gemba" to see
problems with their own eyes. Gemba sends five Gemini agents on that walk **at the same time**, one per word of the theme:

| Agent | Looks at | Example finding |
|---|---|---|
| Reliability | vibration, temperature, current, maintenance history, spares | "VMC-204 spindle bearing is wearing; trip expected in about 2–3 days; preventive maintenance 12 days overdue" |
| Quality | scrap by machine vs its own normal, control charts, part photos (Gemini vision), material lots | "Chatter marks on VMC-204 at 4.4× normal, confirmed on a photo; porosity in Rayong follows lot AL-2210" |
| Supply & demand | order book, demand forecast, spares across plants | "Order SO-24117 is short (97 % cover); the bearing is in Chakan, 9 h away" |
| Energy (sustainability) | energy per good part, compressor baseline model, tariffs | "VMC-204 uses 25 % more energy per good part; CMP-901 draws 11.5 kW the load cannot explain: an air leak" |
| Flow (efficiency) | OEE by line, machine contribution, what-if | "Cylinder Head Line OEE fell 72 % → 69 %" |

They are five lenses on the same plant, not a sequence. The **Gemba Lead** then links findings that share a cause
(the scrap *is* the worn bearing), tests options on the simulator with `what_if`, checks spare parts and tariff windows,
and writes **plan cards**. Each card shows do-nothing vs with-this-card, computed by the simulator.

## People stay in charge

- A card changes nothing until a named person approves it; people can retime actions first and see the effect.
- Approvals, edits and rejections are remembered and passed to the Lead on the next walk.
- Work orders carry lock-out-first steps; the technician phone view answers questions by voice in Hindi, Marathi,
  Thai or English and follows the next open step; a machine is released only with a vibration reading ≤ 2.3 mm/s.

## Gemba Watch, drills and time travel

- **Gemba Watch** compares every live tick with what it has already seen. A new signal (wear, a frozen sensor, a leak,
  a scrap jump) starts a focused walk with only the agents that signal needs.
- **Drills**: start a realistic fault in 30 seconds, speed the plant up to 10× or 60×, and watch detection → agents →
  cards. A phone can act as a vibration/sound sensor (`/probe`).
- **Time travel**: scrub the digital twin three days back or three days ahead, with the approved plan or if nothing is done.

## Guardrails

Numbers come from tools, not the model · a frozen sensor never sends a repair crew · repairs wait for the spare part ·
read-only SQL · non-Gemini model replies are rejected · every agent step and human decision is in the audit log.

## Analytics (classical maths where it beats language)

Offset-exponential wear-curve fit with a 200-sample bootstrap for the time-to-trip range · IsolationForest anomaly
score trained on healthy history · p-chart scrap control with Western Electric style signals · compressor energy
baseline regression (kW vs plant load) · OEE (availability × performance × quality) · Holt forecasting with weekly
seasonality.
