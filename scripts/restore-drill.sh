#!/usr/bin/env bash
# Restore drill: prove that a Home Assistant backup brings EMHASS Lens back, without touching Home Assistant.
#
#   scripts/restore-drill.sh <supervisor-backup.tar> [slug]
#
# Pulls the App's archive out of a Supervisor backup (the kind the Google Drive Backup add-on uploads),
# unpacks its app.db into a scratch directory, starts EMHASS Lens there in safe mode (nothing is sent to
# EMHASS or Home Assistant) and prints what came back: settings revision, prices, forecast, plans,
# measurements, cost-function comparisons and the backup marker. Exit code 1 when the database fails its
# integrity check or the App doesn't come up. Encrypted (password-protected) backups must be downloaded
# decrypted from the Google Drive Backup add-on first; the script says so when it meets one.
set -euo pipefail

BACKUP="${1:-}"
SLUG="${2:-}"
if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
    echo "usage: $0 <supervisor-backup.tar> [addon slug]" >&2
    exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$ROOT/backend/.venv/bin/python" ]; then
    PY=("$ROOT/backend/.venv/bin/python")
elif command -v uv >/dev/null 2>&1; then
    PY=(uv run --project "$ROOT/backend" python)
else
    echo "need uv or backend/.venv (cd backend && uv sync)" >&2
    exit 2
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/emhass-lens-drill.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

tar -xf "$BACKUP" -C "$WORK" ./backup.json 2>/dev/null || tar -xf "$BACKUP" -C "$WORK" backup.json
META="$WORK/backup.json"
if [ -z "$SLUG" ]; then
    SLUG="$("${PY[@]}" - "$META" <<'PYEOF'
import json, sys
meta = json.load(open(sys.argv[1]))
addons = [a.get("slug", "") for a in meta.get("addons", [])]
ours = [s for s in addons if s.endswith("_emhass_lens")]
print(ours[0] if ours else "")
PYEOF
)"
fi
if [ -z "$SLUG" ]; then
    echo "this backup has no EMHASS Lens add-on in it (addons: $("${PY[@]}" -c "import json,sys;print(', '.join(a['slug'] for a in json.load(open(sys.argv[1]))['addons']))" "$META"))" >&2
    exit 1
fi
echo "backup: $("${PY[@]}" -c "import json,sys;m=json.load(open(sys.argv[1]));print(m.get('name'),'·',m.get('date'),'·',m.get('type'),'· protected' if m.get('protected') else '· not encrypted')" "$META")"
echo "add-on: $SLUG"
tar -xf "$BACKUP" -C "$WORK" "./$SLUG.tar.gz" 2>/dev/null || tar -xf "$BACKUP" -C "$WORK" "$SLUG.tar.gz"
INNER="$WORK/$SLUG.tar.gz"
if ! gzip -t "$INNER" 2>/dev/null; then
    echo "the add-on archive is encrypted: download this backup decrypted from the Google Drive Backup add-on (its backup page has a download without encryption) and run the drill on that file" >&2
    exit 1
fi
mkdir -p "$WORK/unpacked" "$WORK/data"
tar -xzf "$INNER" -C "$WORK/unpacked"
DB="$(find "$WORK/unpacked" -name app.db -maxdepth 3 | head -1)"
if [ -z "$DB" ]; then
    echo "no app.db in the add-on archive" >&2
    exit 1
fi
cp "$DB" "$WORK/data/app.db"
MARKER="$(dirname "$DB")/backup-marker.json"
[ -f "$MARKER" ] && cp "$MARKER" "$WORK/data/" && echo "marker: $(cat "$MARKER" | tr -d '\n' | cut -c1-200)"

CHECK="$("${PY[@]}" -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('pragma quick_check').fetchone()[0])" "$WORK/data/app.db")"
echo "app.db quick_check: $CHECK ($(du -h "$WORK/data/app.db" | cut -f1))"
[ "$CHECK" = "ok" ] || exit 1

PORT=18777
EMHASS_LENS_DATA_DIR="$WORK/data" EMHASS_LENS_PORT=$PORT EMHASS_LENS_SAFE_MODE=1 TZ="${TZ:-Europe/Tallinn}" \
    "${PY[@]}" -m emhass_lens > "$WORK/lens.log" 2>&1 &
APP=$!
trap 'kill $APP 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 60); do
    curl -fs "http://127.0.0.1:$PORT/api/health/live" >/dev/null 2>&1 && break
    sleep 0.5
done
if ! curl -fs "http://127.0.0.1:$PORT/api/health/live" >/dev/null 2>&1; then
    echo "EMHASS Lens did not start on the restored data; log:" >&2
    tail -30 "$WORK/lens.log" >&2
    exit 1
fi
"${PY[@]}" - "$PORT" <<'PYEOF'
import json, sys, urllib.request
port = sys.argv[1]
def get(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)
version = get("/api/version")
settings = get("/api/settings")
storage = get("/api/storage")
prices = get("/api/prices?days_back=7")
plan = get("/api/plan")
history = get("/api/plan/history?hours=168")
tables = {t["name"]: t for d in storage["databases"] if d["name"] == "app.db" for t in d["tables"]}
def rows(name): return tables.get(name, {}).get("rows", 0)
print(f"EMHASS Lens {version['version']} started in safe mode on the restored data")
print(f"settings: revision {settings['revision']}, mode {settings['settings']['emhass']['mode']}, forecast {settings['settings']['forecast']['source']}")
print(f"prices: {rows('price_slot')} slots over {rows('price_day')} days; {sum(1 for s in prices['slots'] if s['origin'] == 'actual')} actual slots in the last week")
print(f"forecasts: {rows('forecast_snapshot')} snapshots; plans: {rows('plan_snapshot')} (newest {plan['current']['generated_at'] if plan.get('current') else 'none'})")
print(f"measurements: {rows('measurement')} rows; cost-function plans: {rows('costfun_result')}; settings versions: {rows('settings_revision')}")
measured = sum(1 for s in history["slots"] if s["actual"]["load"] is not None)
print(f"plan history: {measured} of {len(history['slots'])} slots in the last week have a measured load")
restored = storage.get("restored")
print("restore marker:", restored if restored else "none (this copy has no run numbers to continue from)")
print("secrets: the eupowerprices API key and the MQTT password travel inside app.db; nothing to re-enter")
PYEOF
echo "drill ok"
