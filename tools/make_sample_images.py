"""Generate the sample part photos for the Quality station with a Gemini image model (our own assets, rule R5).

Run once during development: `python tools/make_sample_images.py`. Needs LLM_INTERNAL_KEY and LLM_API_KEY in the
environment (development gateway). Writes static/img/parts/<name>.jpg and keeps the ground-truth labels in
static/img/parts/labels.json so the rules fallback and tests know what each photo shows.
"""
import base64
import io
import json
import os
import pathlib
import sys

import httpx
from PIL import Image

OUT = pathlib.Path(__file__).resolve().parent.parent / "static" / "img" / "parts"
STYLE = ("Photorealistic industrial quality-inspection photo, top-down, neutral grey background, even diffuse ring-light, "
         "sharp focus, 4:3, no text, no logos, no people, no watermark.")
SHOTS = {
    "vmc204-chatter": ("VMC-204", "chatter_marks",
                       "Close-up of the face-milled deck surface of an aluminium car-engine cylinder head. Across the right half "
                       "of the machined face there are clear chatter marks: regular, closely spaced wavy ripple bands that "
                       "interrupt the normal circular tool-mark pattern. The left half looks normal."),
    "vmc201-good": ("VMC-201", "none",
                    "Close-up of the face-milled deck surface of an aluminium car-engine cylinder head with a clean, uniform, "
                    "fine circular face-milling pattern, no defects, bright satin finish."),
    "die501-porosity": ("DIE-501", "porosity",
                        "Close-up of the machined sealing face of an aluminium die-cast gearbox housing. Near one bolt hole "
                        "there is a cluster of small round gas-porosity pinholes (dark voids, 0.3 to 1 mm). The rest of the "
                        "face is clean."),
    "die502-good": ("DIE-502", "none",
                    "Close-up of the machined sealing face of an aluminium die-cast gearbox housing, clean and uniform, "
                    "no pores, no scratches."),
    "lth102-good": ("LTH-102", "none",
                    "Close-up of a polished steel crankshaft main journal after turning and grinding, smooth mirror-like "
                    "bands, no defects."),
}


def main():
    hdr = {"X-Internal-Key": os.environ["LLM_INTERNAL_KEY"]}
    labels = {}
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (machine, truth, prompt) in SHOTS.items():
        if (OUT / f"{name}.jpg").exists() and "--force" not in sys.argv:
            labels[name] = {"machine_id": machine, "truth": truth}
            continue
        body = {"messages": [{"role": "user", "content": prompt + " " + STYLE}], "api_key": os.environ["LLM_API_KEY"],
                "provider": os.environ["LLM_PROVIDER"], "model": "gemini-3.1-flash-image", "ref": "gemba-dev"}
        r = httpx.post(os.environ["LLM_GATEWAY_URL"] + "/image", headers=hdr, json=body, timeout=180)
        d = r.json()
        imgs = d.get("images") or []
        if r.status_code != 200 or not imgs or "gemini" not in str(d.get("model", "")).lower():
            print(name, "failed", r.status_code, str(d)[:200])
            continue
        b64 = next((v for k, v in imgs[0].items() if isinstance(v, str) and len(v) > 1000), "")
        if b64.startswith("data:"):
            b64 = b64.split(",", 1)[1]
        raw = base64.b64decode(b64)
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        im.thumbnail((1024, 1024))
        im.save(OUT / f"{name}.jpg", quality=82, optimize=True)
        labels[name] = {"machine_id": machine, "truth": truth}
        print(name, im.size, d.get("model"))
    (OUT / "labels.json").write_text(json.dumps(labels, indent=1))


if __name__ == "__main__":
    main()
