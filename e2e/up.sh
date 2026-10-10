#!/bin/sh
# Start a throwaway Home Assistant + Mosquitto + EMHASS for end-to-end tests of EMHASS Lens.
#   LEGACY_DIR=../../homeassistant-ee-nordpool/custom_components/homeassistant-ee-nordpool ./up.sh
# also installs the old HACS integration, so parity and the settings import can be tested.
set -eu
cd "$(dirname "$0")"
RUNTIME="$PWD/.runtime"
HA_IMAGE="${HA_IMAGE:-ghcr.io/home-assistant/home-assistant:stable}"
EMHASS_IMAGE="${EMHASS_IMAGE:-ghcr.io/davidusb-geek/emhass:v0.18.5}"

rm -rf "$RUNTIME" && mkdir -p "$RUNTIME/ha/custom_components" "$RUNTIME/emhass/data"
cp ha/configuration.yaml "$RUNTIME/ha/"
if [ -n "${LEGACY_DIR:-}" ]; then
    cp -R "$LEGACY_DIR" "$RUNTIME/ha/custom_components/nordpool_ee_scraper"
    rm -rf "$RUNTIME/ha/custom_components/nordpool_ee_scraper/__pycache__"
fi

docker network create el-net >/dev/null 2>&1 || true
docker rm -f el-ha el-mqtt el-emhass >/dev/null 2>&1 || true
docker run -d --name el-mqtt --network el-net -p 11883:1883 -v "$PWD/mosquitto.conf:/mosquitto/config/mosquitto.conf" eclipse-mosquitto:2 >/dev/null
docker run -d --name el-ha --network el-net -p 18123:8123 -e TZ=Europe/Tallinn -v "$RUNTIME/ha:/config" "$HA_IMAGE" >/dev/null

(cd ../backend && uv run python ../e2e/setup_ha.py "$RUNTIME/ha_token.json")
TOKEN=$(python3 -c "import json;print(json.load(open('$RUNTIME/ha_token.json'))['token'])")

cat > "$RUNTIME/emhass/secrets_emhass.yaml" <<YAML
server_ip: 0.0.0.0
hass_url: http://el-ha:8123/
long_lived_token: $TOKEN
time_zone: Europe/Tallinn
Latitude: 59.437
Longitude: 24.7536
Altitude: 30
YAML
docker run -d --name el-emhass --network el-net -p 15000:5000 -e TZ=Europe/Tallinn \
    -v "$PWD/../backend/tests/fixtures/emhass/emhass_get_config.json:/share/config.json" \
    -v "$RUNTIME/emhass/secrets_emhass.yaml:/app/secrets_emhass.yaml" \
    -v "$RUNTIME/emhass/data:/data" "$EMHASS_IMAGE" >/dev/null

# EMHASS installs itself on first start; wait until its web server answers so check.sh doesn't hit a closed port.
i=0
until curl -sf -o /dev/null --max-time 2 http://localhost:15000/; do
    i=$((i + 1))
    [ "$i" -ge 120 ] && { echo "EMHASS did not come up within 120 s" >&2; exit 1; }
    sleep 1
done

(cd ../backend && uv run python ../e2e/seed.py "$TOKEN")
echo "Home Assistant: http://localhost:18123 (tester / tester-pass-123)"
echo "EMHASS:         http://localhost:15000"
echo "MQTT:           localhost:11883"
echo "Token in $RUNTIME/ha_token.json. Next: ./check.sh"
