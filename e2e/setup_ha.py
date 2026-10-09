"""Onboard a fresh HA container, create a long-lived token, add the legacy integration and MQTT."""

import asyncio
import json
import sys
from pathlib import Path

import httpx
import websockets

BASE = "http://localhost:18123"
CLIENT_ID = f"{BASE}/"


async def main(out_path: str) -> None:
    async with httpx.AsyncClient(base_url=BASE, timeout=30) as http:
        for _ in range(120):
            try:
                r = await http.get("/api/onboarding")
                if r.status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            await asyncio.sleep(2)
        r = await http.post(
            "/api/onboarding/users",
            json={
                "client_id": CLIENT_ID,
                "name": "Tester",
                "username": "tester",
                "password": "tester-pass-123",
                "language": "en",
            },
        )
        r.raise_for_status()
        code = r.json()["auth_code"]
        tok = await http.post(
            "/auth/token", data={"grant_type": "authorization_code", "code": code, "client_id": CLIENT_ID}
        )
        tok.raise_for_status()
        access = tok.json()["access_token"]
        headers = {"Authorization": f"Bearer {access}"}
        for step, body in (
            ("core_config", {}),
            ("analytics", {}),
            ("integration", {"client_id": CLIENT_ID, "redirect_uri": CLIENT_ID}),
        ):
            await http.post(f"/api/onboarding/{step}", json=body, headers=headers)
        async with websockets.connect("ws://localhost:18123/api/websocket") as ws:
            await ws.recv()
            await ws.send(json.dumps({"type": "auth", "access_token": access}))
            await ws.recv()
            await ws.send(
                json.dumps(
                    {"id": 1, "type": "auth/long_lived_access_token", "client_name": "emhass-lens-e2e", "lifespan": 365}
                )
            )
            llat = json.loads(await ws.recv())["result"]
        headers = {"Authorization": f"Bearer {llat}"}
        results = {"token": llat}
        mqtt = {
            "broker": "el-mqtt",
            "port": 1883,
            "protocol": "5",
            "other_settings": {
                "set_client_cert": False,
                "set_ca_cert": "off",
                "client_id": "ha-e2e",
                "keepalive": 60,
                "transport": "tcp",
            },
        }
        for handler, user_input in (("nordpool_ee_scraper", None), ("mqtt", mqtt)):
            flow = await http.post("/api/config/config_entries/flow", json={"handler": handler}, headers=headers)
            data = flow.json()
            if data.get("type") == "form":
                if user_input is None:
                    user_input = {f["name"]: f.get("default") for f in data["data_schema"] if "default" in f}
                done = await http.post(
                    f"/api/config/config_entries/flow/{data['flow_id']}", json=user_input, headers=headers
                )
                results[handler] = done.json().get("type") or done.json()
            else:
                results[handler] = data.get("reason") or data
        await asyncio.to_thread(Path(out_path).write_text, json.dumps(results))
        print(json.dumps({k: (v if k != "token" else "***") for k, v in results.items()}))


asyncio.run(main(sys.argv[1]))
