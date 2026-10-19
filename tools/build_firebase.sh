#!/usr/bin/env bash
# Build a Firebase Hosting bundle: the web app is served by Firebase, the API stays on the plant server.
# Usage:  tools/build_firebase.sh https://gemba.lehana.in <firebase-project-id>
#         cd dist/firebase && firebase deploy --only hosting --project <firebase-project-id>
# On the server, allow the Firebase origins: GEMBA_CORS_ORIGINS=https://<id>.web.app,https://<id>.firebaseapp.com
set -euo pipefail
API="${1:?API base URL, e.g. https://gemba.lehana.in}"
PROJECT="${2:-gemba}"
cd "$(dirname "$0")/.."
OUT=dist/firebase
rm -rf "$OUT" && mkdir -p "$OUT/public"
cp -r static "$OUT/public/static"
cp static/index.html "$OUT/public/index.html"
printf 'window.GEMBA_API_BASE = "%s";\n' "$API" > "$OUT/public/static/config.js"
cat > "$OUT/firebase.json" <<JSON
{"hosting": {"public": "public", "ignore": ["**/.*"],
  "headers": [{"source": "**/*.@(js|css|html)", "headers": [{"key": "Cache-Control", "value": "no-cache"}]}]}}
JSON
printf '{"projects": {"default": "%s"}}\n' "$PROJECT" > "$OUT/.firebaserc"
echo "Built $OUT (API $API). Next: cd $OUT && firebase deploy --only hosting"
