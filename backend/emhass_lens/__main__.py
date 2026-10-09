"""Entry point: python -m emhass_lens"""

import logging

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
    uvicorn.run(app, host="0.0.0.0", port=boot.port, log_config=None, access_log=False, timeout_graceful_shutdown=5)


if __name__ == "__main__":
    main()
