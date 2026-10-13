"""Downloading several runs at once: their bundles as a zip, or their log lines as one text file."""

import io
import json
import logging
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import make_client
from tests.world import World

T0 = datetime(2026, 10, 10, 11, 0, tzinfo=UTC)


def test_bundles_and_logs_of_several_runs(tmp_path: Path) -> None:
    with make_client(tmp_path, World(), FakeClock(T0)) as client:
        c = client.app.state.container  # type: ignore[attr-defined]
        log = logging.getLogger("emhass_lens.test")

        async def make(job: str) -> int:
            async with c.recorder.start(job) as run:
                if job != "test.quiet":
                    log.warning("hello from %s", job)
                run.artifact("request", {"job": job})
                run.summary = f"did {job}"
                run.outcome = "ok"
            return run.id

        a, b, quiet, other = (
            client.portal.call(make, job)  # type: ignore[union-attr]
            for job in ("test.a", "test.b", "test.quiet", "test.other")
        )
        missing = other + 1000

        resp = client.get("/api/runs/bundles", params={"id": [b, a, missing, a]})
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"] == "application/zip"
        assert resp.headers["content-disposition"] == f'attachment; filename="emhass-lens-runs-{a}-{b}.zip"'
        archive = zipfile.ZipFile(io.BytesIO(resp.content))
        assert archive.namelist() == [f"emhass-lens-run-{a}.json", f"emhass-lens-run-{b}.json"]
        for run_id in (a, b):
            single = client.get(f"/api/runs/{run_id}/bundle").json()
            assert json.loads(archive.read(f"emhass-lens-run-{run_id}.json")) == single
            assert single["artifacts"]["request"]["job"] in ("test.a", "test.b")

        resp = client.get("/api/runs/logs", params={"id": [b, a, missing]})
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("text/plain")
        assert resp.headers["content-disposition"] == f'attachment; filename="emhass-lens-runs-{a}-{b}.log"'
        text = resp.text
        assert text.index(f"# Run {a} · test.a · started ") < text.index("hello from test.a")
        assert text.index("hello from test.a") < text.index(f"# Run {b} · test.b · started ")
        assert text.index(f"# Run {b} · test.b") < text.index("hello from test.b")
        assert f"WARNING [test] run={a} hello from test.a" in text
        assert "test.other" not in text
        # Under the header: what the run did, its log lines, then its artifacts as JSON
        header_a = next(line for line in text.splitlines() if line.startswith(f"# Run {a} "))
        assert " · took " in header_a and header_a.endswith(" ms · ok")
        assert text.index(header_a) < text.index("# did test.a") < text.index("hello from test.a")
        artifact_a = '## request\n{\n  "job": "test.a"\n}'
        assert text.index("hello from test.a") < text.index(artifact_a) < text.index(f"# Run {b} ")

        # A run that wrote no log lines still says what it did and shows what it stored
        resp = client.get("/api/runs/logs", params={"id": [quiet]})
        assert resp.text.splitlines()[1:] == [
            "# did test.quiet",
            "(no log lines kept for this run)",
            "## request",
            "{",
            '  "job": "test.quiet"',
            "}",
        ]

        single = client.get("/api/runs/logs", params={"id": [other]})
        assert single.headers["content-disposition"] == f'attachment; filename="emhass-lens-run-{other}.log"'


def test_a_download_of_several_runs_needs_runs_that_exist_and_not_too_many(tmp_path: Path) -> None:
    with make_client(tmp_path, World(), FakeClock(T0)) as client:
        for path in ("/api/runs/bundles", "/api/runs/logs"):
            assert client.get(path, params={"id": [999_999]}).status_code == 404
            assert client.get(path, params={"id": list(range(1, 202))}).status_code == 400
            assert client.get(path).status_code == 422
