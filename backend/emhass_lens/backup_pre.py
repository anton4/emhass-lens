"""Run by the Supervisor inside the container right before a backup (config.yaml: backup_pre).

Makes the copied app.db complete and sane: checkpoints the write-ahead log into the main file, runs a quick
integrity check and leaves a small marker next to the database (it travels inside the backup, so a restored
copy can say when the backup was taken). Exits non-zero when the check fails, which makes the Supervisor
abort the backup instead of saving a broken file. Standard library only; the App keeps running meanwhile.
"""

import json
import os
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

MARKER = "backup-marker.json"


def prepare(data_dir: Path, *, version: str = "unknown") -> dict[str, object]:
    db = data_dir / "app.db"
    marker: dict[str, object] = {
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "app_version": version,
        "schema_version": None,
        "revision": None,
        "quick_check": "missing",
    }
    if not db.exists():
        return marker
    conn = sqlite3.connect(str(db), timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        marker["quick_check"] = str(conn.execute("PRAGMA quick_check").fetchone()[0])
        try:
            row = conn.execute("SELECT id, schema_version FROM settings_revision ORDER BY id DESC LIMIT 1").fetchone()
        except sqlite3.OperationalError:
            row = None
        if row is not None:
            marker["revision"], marker["schema_version"] = int(row[0]), int(row[1])
    except sqlite3.DatabaseError as exc:  # not a database, or damaged beyond reading
        marker["quick_check"] = f"error: {exc}"
    finally:
        conn.close()
    return marker


def main() -> int:
    data_dir = Path(os.environ.get("EMHASS_LENS_DATA_DIR", "/data"))
    marker = prepare(data_dir, version=os.environ.get("EMHASS_LENS_VERSION", "unknown"))
    try:
        (data_dir / MARKER).write_text(json.dumps(marker, indent=2))
    except OSError as exc:
        print(f"backup_pre: could not write the marker: {exc}", file=sys.stderr)
    print(f"backup_pre: app.db quick_check {marker['quick_check']}, revision {marker['revision']}")
    if marker["quick_check"] not in ("ok", "missing"):
        print("backup_pre: app.db failed its integrity check; refusing to back up a broken file", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
