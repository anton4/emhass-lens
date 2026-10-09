"""End-to-end checks of EMHASS Lens against a real Home Assistant, Mosquitto and EMHASS (see up.sh).

Starts EMHASS Lens (port 18101, fresh data), then walks the whole chain and prints PASS/FAIL per step.
Exit code 0 when everything passed.
"""

import asyncio
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import websockets

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / ".runtime"
LENS = "http://localhost:18101"
HA = "http://localhost:18123"
EMHASS = "http://localhost:15000"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: Any = "") -> bool:
    results.append((name, ok, str(detail)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)
    return ok


def wait_for(fn: Callable[[], Any], timeout: float = 60, every: float = 1) -> Any:
    end = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:
            last = exc
        time.sleep(every)
    return last


def run_job(http: httpx.Client, job: str, timeout: float = 90) -> dict[str, Any]:
    run_id = None
    for _ in range(20):
        run_id = http.post(f"/api/jobs/{job}/run").json().get("run_id")
        if run_id:
            break
        time.sleep(1)
    return wait_for(lambda: (r := http.get(f"/api/runs/{run_id}").json())["outcome"] != "running" and r, timeout)


def patch(http: httpx.Client, changes: dict[str, Any], comment: str) -> dict[str, Any]:
    rev = http.get("/api/settings").json()["revision"]
    return http.patch("/api/settings", json={"base_revision": rev, "changes": changes, "comment": comment}).json()


async def ha_ws(token: str, commands: list[dict[str, Any]]) -> list[Any]:
    async with websockets.connect("ws://localhost:18123/api/websocket") as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "auth", "access_token": token}))
        await ws.recv()
        out = []
        for i, cmd in enumerate(commands, 1):
            await ws.send(json.dumps({"id": i, **cmd}))
            out.append(json.loads(await ws.recv()).get("result"))
        return out


async def publish_and_catch_event(token: str, http: httpx.Client) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    async with websockets.connect("ws://localhost:18123/api/websocket") as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "auth", "access_token": token}))
        await ws.recv()
        await ws.send(json.dumps({"id": 1, "type": "subscribe_events", "event_type": "emhass_lens_plan_published"}))
        await ws.recv()
        run = await asyncio.to_thread(run_job, http, "emhass.publish")
        try:
            async with asyncio.timeout(15):
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("type") == "event":
                        return msg["event"]["data"], run
        except TimeoutError:
            return None, run


def main() -> int:
    token = json.loads((RUNTIME / "ha_token.json").read_text())["token"]
    legacy = (RUNTIME / "ha" / "custom_components" / "nordpool_ee_scraper").is_dir()
    data = RUNTIME / "lens-data"
    env = {
        **os.environ,
        "HA_URL": HA,
        "HA_TOKEN": token,
        "EMHASS_LENS_DATA_DIR": str(data),
        "EMHASS_LENS_PORT": "18101",
        "TZ": "Europe/Tallinn",
    }
    log = open(RUNTIME / "lens.log", "w")  # noqa: SIM115
    proc = subprocess.Popen([sys.executable, "-m", "emhass_lens"], env=env, stdout=log, stderr=subprocess.STDOUT)
    ha_headers = {"Authorization": f"Bearer {token}"}
    try:
        with httpx.Client(base_url=LENS, timeout=30) as http, httpx.Client(base_url=HA, headers=ha_headers) as ha:
            wait_for(lambda: http.get("/api/health/live").status_code == 200, 30)
            status = wait_for(
                lambda: (s := http.get("/api/status").json())["components"]["home_assistant"]["status"] == "ok" and s,
                30,
            )
            check(
                "connects to Home Assistant over the WebSocket",
                bool(status),
                status and status["components"]["home_assistant"]["detail"],
            )

            inputs = http.get("/api/inputs").json()["snapshot"]
            check(
                "reads the battery SOC with provenance",
                inputs["soc_init"]["value"] == 0.62,
                inputs["soc_init"]["explain"],
            )

            prices = run_job(http, "nordpool.poll")
            slots = http.get("/api/prices", params={"days_back": 0}).json()["slots"]
            check(
                "fetches Nord Pool prices",
                prices["outcome"] in ("ok", "noop") and len(slots) >= 92,
                f"{prices['summary']}; {len(slots)} slots",
            )

            if legacy:
                wait_for(lambda: ha.get("/api/states/sensor.nordpool_ee_prices_import_cost").status_code == 200, 60)

                def legacy_has_pv() -> bool:  # the integration refreshes once a minute; wait for the seeded PV
                    state = ha.get("/api/states/sensor.nordpool_ee_prices_solcast_forecast_15min").json()
                    return any(v > 0 for v in (state.get("attributes") or {}).get("values", []))

                wait_for(legacy_has_pv, 90, every=3)
                parity = run_job(http, "parity.check")
                check("matches the HACS integration (parity)", parity["outcome"] == "ok", parity["summary"])
                preview = http.get("/api/legacy/preview").json()
                check("finds the HACS integration's settings", preview["found"], "; ".join(preview["notes"]))

            patch(http, {"emhass": {"base_url": EMHASS, "mode": "dry_run"}}, "e2e: EMHASS")
            check_run = run_job(http, "emhass.config_check")
            emhass = http.get("/api/emhass").json()
            bad = [c["title"] for c in emhass["checks"] if c["status"] == "error"]
            check(
                "reads EMHASS's configuration and checks it",
                emhass["reachable"] and not bad,
                f"EMHASS {emhass['version']}; {check_run['summary']}",
            )

            dry = run_job(http, "emhass.mpc")
            check("builds and validates the MPC payload (dry run)", dry["outcome"] == "dry_run", dry["summary"])

            patch(
                http,
                {
                    "emhass": {
                        "mode": "live",
                        "mpc": {"auto": False},
                        "extra_runtime_params": {"load_power_forecast": [1500] * 800},
                    }
                },
                "e2e: live",
            )
            live = run_job(http, "emhass.mpc")
            explain = http.get(f"/api/runs/{live['id']}/artifacts/explain").json()
            plan = http.get("/api/plan").json()
            first = plan["current"]["rows"][0]["timestamp"] if plan.get("current") else None
            anchored = first is not None and first.replace("Z", "+00:00")[:19] == explain["anchor"][:19]
            check(
                "runs EMHASS live and reads back a plan aligned to the anchor slot",
                live["outcome"] == "ok" and anchored,
                f"{live['summary']}; first row {first}, anchor {explain['anchor']}",
            )

            event, pub = asyncio.run(publish_and_catch_event(token, http))
            batt = ha.get("/api/states/sensor.p_batt_forecast").json().get("state")
            same = event is not None and abs(float(batt) - float(event["current"].get("p_batt_w", 0))) < 0.01
            check(
                "publishes the plan and fires the event with the sensor values",
                pub["outcome"] == "ok" and same,
                f"{pub['summary']}; sensor.p_batt_forecast={batt}",
            )

            patch(
                http, {"outputs": {"mqtt_enabled": True, "broker": {"host": "localhost", "port": 11883}}}, "e2e: MQTT"
            )
            entity = wait_for(
                lambda: (
                    (r := ha.get("/api/states/sensor.emhass_lens_import_price_now")).status_code == 200 and r.json()
                ),
                20,
            )
            check(
                "creates the MQTT entities in Home Assistant",
                isinstance(entity, dict),
                entity.get("state") if isinstance(entity, dict) else entity,
            )
            ha.post("/api/services/switch/turn_on", json={"entity_id": "switch.emhass_lens_auto_mpc"})
            flipped = wait_for(lambda: http.get("/api/settings").json()["settings"]["emhass"]["mpc"]["auto"], 10)
            check("the Auto MPC switch in Home Assistant changes the App's settings", flipped is True)

            patch(
                http,
                {
                    "notifications": {"persistent": True},
                    "health": {"problem_grace_min": 0},
                    "inputs": {"soc_init": {"entity": "sensor.does_not_exist"}},
                },
                "e2e: break SOC",
            )
            run_job(http, "health.evaluate")
            notes = wait_for(lambda: asyncio.run(ha_ws(token, [{"type": "persistent_notification/get"}]))[0], 10)
            check(
                "raises a Home Assistant notification for an error",
                bool(notes),
                notes[0]["message"].splitlines()[0] if notes else notes,
            )
            patch(http, {"inputs": {"soc_init": {"entity": "sensor.ev6_battery_soc"}}}, "e2e: fix SOC")
            cleared = wait_for(lambda: not asyncio.run(ha_ws(token, [{"type": "persistent_notification/get"}]))[0], 10)
            check("dismisses the notification when the problem is gone", cleared is True)
    finally:
        proc.terminate()
        proc.wait(10)
        log.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed; EMHASS Lens log: {RUNTIME / 'lens.log'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
