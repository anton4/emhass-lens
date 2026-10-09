"""Bootstrap options: the few values needed before the settings database can be read.

As a Home Assistant App they come from /data/options.json (the App's Configuration tab) and from the
Supervisor's environment. Standalone (docker compose, local dev) they come from environment variables.
Read once at startup in __main__, never at import time.
"""

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

OPTIONS_FILE = Path("/data/options.json")


@dataclass(frozen=True)
class Bootstrap:
    version: str
    data_dir: Path
    static_dir: Path | None
    log_level: str = "info"
    safe_mode: bool = False
    port: int = 8099
    tz: str = "UTC"
    supervisor_token: str | None = None
    supervisor_url: str = "http://supervisor"
    ha_url: str = "http://supervisor/core"
    ha_token: str | None = None
    ingress_ip: str = "172.30.32.2"
    standalone_read_only: bool = False

    @property
    def under_supervisor(self) -> bool:
        return bool(self.supervisor_token)


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def load_bootstrap(env: Mapping[str, str] | None = None, options_file: Path = OPTIONS_FILE) -> Bootstrap:
    env = os.environ if env is None else env
    options: dict[str, object] = {}
    if options_file.is_file():
        options = json.loads(options_file.read_text(encoding="utf-8"))

    supervisor_token = env.get("SUPERVISOR_TOKEN") or None
    default_data = "/data" if supervisor_token or Path("/data").is_dir() else "./data"
    data_dir = Path(env.get("EMHASS_LENS_DATA_DIR", default_data))

    static = env.get("EMHASS_LENS_STATIC_DIR")
    static_dir = Path(static) if static else Path(__file__).resolve().parent.parent / "static"

    log_level = str(options.get("log_level") or env.get("EMHASS_LENS_LOG_LEVEL") or "info").lower()
    safe_mode = bool(options.get("safe_mode")) or _truthy(env.get("EMHASS_LENS_SAFE_MODE"))

    if supervisor_token:
        ha_url = "http://supervisor/core"
        ha_token: str | None = supervisor_token
    else:
        ha_url = env.get("HA_URL", "").rstrip("/") or "http://homeassistant.local:8123"
        ha_token = env.get("HA_TOKEN") or None

    return Bootstrap(
        version=env.get("EMHASS_LENS_VERSION", "dev"),
        data_dir=data_dir,
        static_dir=static_dir if static_dir.is_dir() else None,
        log_level=log_level if log_level in {"debug", "info", "warning", "error"} else "info",
        safe_mode=safe_mode,
        port=int(env.get("EMHASS_LENS_PORT", "8099")),
        tz=env.get("TZ") or "UTC",
        supervisor_token=supervisor_token,
        ha_url=ha_url,
        ha_token=ha_token,
        ingress_ip=env.get("EMHASS_LENS_INGRESS_IP", "172.30.32.2"),
        standalone_read_only=_truthy(env.get("EMHASS_LENS_READ_ONLY")),
    )
