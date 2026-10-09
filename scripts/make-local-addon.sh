#!/bin/sh
# Assemble a self-contained local App folder that Home Assistant builds itself (no registry).
# Copy the result into the HA /addons share (Samba or SSH App), then in the App store:
# ⋮ → Check for updates → "Local apps" → EMHASS Lens.
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-build/local-addon}/emhass_lens"

rm -rf "$OUT"
mkdir -p "$OUT"
cp Dockerfile .dockerignore "$OUT/"
cp emhass_lens/DOCS.md emhass_lens/README.md emhass_lens/CHANGELOG.md "$OUT/"
cp -R emhass_lens/translations "$OUT/"
for img in icon.png logo.png; do
    [ -f "emhass_lens/$img" ] && cp "emhass_lens/$img" "$OUT/"
done
# Without "image:" the Supervisor builds the Dockerfile in this folder
grep -v -e '^image:' -e '^# Prebuilt by' emhass_lens/config.yaml > "$OUT/config.yaml"
rsync -a --exclude node_modules --exclude dist frontend "$OUT/"
rsync -a --exclude .venv --exclude data --exclude __pycache__ --exclude '.*_cache' --exclude '*.db*' backend "$OUT/"

echo "Local App written to $OUT"
echo "Copy it to /addons/emhass_lens on Home Assistant, e.g.: scp -r $OUT root@homeassistant.local:/addons/"
