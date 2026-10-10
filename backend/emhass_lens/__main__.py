"""Entry point: python -m emhass_lens"""

import logging
from typing import Any

import uvicorn

from emhass_lens.app import create_app
from emhass_lens.bootstrap import load_bootstrap
from emhass_lens.core.bus import EventBus
from emhass_lens.logs.setup import setup_logging


def main() -> None:
    boot = load_bootstrap()
    bus = EventBus()
    handles = setup_logging(bus, boot.log_level, boot.tz)
    log = logging.getLogger("emhass_lens")
    log.info(
        "EMHASS Lens %s starting (%s, data in %s%s)",
        boot.version,
        "Home Assistant App" if boot.under_supervisor else f"standalone, HA at {boot.ha_url}",
        boot.data_dir,
        ", SAFE MODE" if boot.safe_mode else "",
    )
    app = create_app(boot, bus=bus, logging_handles=handles)
    config = uvicorn.Config(
        app, host="0.0.0.0", port=boot.port, log_config=None, access_log=False, timeout_graceful_shutdown=5
    )
    _Server(config, bus).run()


class _Server(uvicorn.Server):
    """uvicorn drains open responses (the UI's event stream) before the application's shutdown hook runs, so
    the stop signal is announced on the bus first: the stream ends itself and the drain completes at once."""

    def __init__(self, config: uvicorn.Config, bus: EventBus) -> None:
        super().__init__(config)
        self._bus = bus

    def handle_exit(self, sig: int, frame: Any) -> None:
        self._bus.close()
        super().handle_exit(sig, frame)


if __name__ == "__main__":
    main()
