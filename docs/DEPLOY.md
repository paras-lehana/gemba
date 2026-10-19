# Run and deploy

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
GEMBA_LLM=mock .venv/bin/uvicorn app.main:app --port 8411          # no model: labelled rules engine
GEMINI_API_KEY=... .venv/bin/uvicorn app.main:app --port 8411      # Gemini API (Google AI Studio)
.venv/bin/python -m pytest -q
```

## Cloud Run

```bash
gcloud run deploy gemba --source . --region asia-south1 --allow-unauthenticated \
  --min-instances 1 --max-instances 1 --session-affinity --cpu 2 --memory 2Gi --timeout 300 \
  --set-env-vars GEMBA_LLM=vertex,GOOGLE_CLOUD_PROJECT=<PROJECT_ID>,GOOGLE_CLOUD_LOCATION=global
```
The runtime service account needs `roles/aiplatform.user` to call Gemini on the Gemini Enterprise Agent Platform.

## Firebase Hosting front end

```bash
tools/build_firebase.sh https://<your-api-host> <firebase-project-id>
cd dist/firebase && firebase deploy --only hosting
```
Set `GEMBA_CORS_ORIGINS=https://<id>.web.app,https://<id>.firebaseapp.com` on the API.

| Variable | Meaning |
|---|---|
| `GEMBA_LLM` | `vertex`, `aistudio` (needs `GEMINI_API_KEY`), `gateway` (an OpenAI-compatible Gemini gateway), `mock`; comma list = fallback chain |
| `GEMBA_MODEL_AGENT/LEAD/VISION/VOICE` | Gemini model IDs per role |
| `GEMBA_DATA_DIR` | Where the last recorded live walk is kept for replay |
