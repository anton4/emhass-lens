"""Run by the Supervisor after a backup (config.yaml: backup_post): removes the marker backup_pre left."""

import os
import sys
from pathlib import Path

from emhass_lens.backup_pre import MARKER


def main() -> int:
    marker = Path(os.environ.get("EMHASS_LENS_DATA_DIR", "/data")) / MARKER
    try:
        marker.unlink(missing_ok=True)
    except OSError as exc:
        print(f"backup_post: could not remove the marker: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
