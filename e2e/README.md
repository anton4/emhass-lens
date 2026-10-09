# End-to-end tests

These scripts start a throwaway **Home Assistant**, **Mosquitto** and **EMHASS** (0.18.3) in Docker. They run EMHASS Lens against them and check the whole chain:
- the Home Assistant WebSocket and entity readings
- Nord Pool prices
- parity with the old HACS integration, if it is installed
- the EMHASS configuration checks
- dry run, then a live MPC run whose plan is aligned to the anchor slot
- publish plus the `emhass_lens_plan_published` event
- the MQTT entities and the Auto MPC switch
- Home Assistant notifications

```sh
cd e2e
LEGACY_DIR=../../homeassistant-ee-nordpool/custom_components/homeassistant-ee-nordpool ./up.sh   # LEGACY_DIR is optional
./check.sh      # prints PASS/FAIL per step, exit code 0 when all pass
./down.sh
```

- Home Assistant runs at http://localhost:18123 (user `tester`, password `tester-pass-123`). It has helper entities with the same ids as a real setup (`sensor.ev6_battery_soc`, `input_number.emhass_target_soc`, …) and seeded Solcast-like sensors.
- EMHASS uses the configuration from `backend/tests/fixtures/emhass/emhass_get_config.json`.
- A test HA has no load history, so the live run passes a flat `load_power_forecast` through *extra runtime parameters*.
- Everything the stack writes goes to `e2e/.runtime/` (git-ignored).
