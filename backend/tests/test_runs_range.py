"""Runs and market sessions by time: a started_at range, oldest first, and paging both ways."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import make_client
from tests.world import World

T0 = datetime(2026, 10, 10, 11, 0, tzinfo=UTC)  # 14:00 in Tallinn


def test_runs_in_a_time_range_newest_or_oldest_first(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    with make_client(tmp_path, World(), clock) as client:
        c = client.app.state.container  # type: ignore[attr-defined]

        async def make(job: str) -> None:
            async with c.recorder.start(job) as run:
                run.outcome = "ok"

        for minute in range(0, 120, 15):  # 14:00 … 15:45 local, one test.a and one test.b each quarter
            clock.set(T0 + timedelta(minutes=minute))
            client.portal.call(make, "test.a")  # type: ignore[union-attr]
            client.portal.call(make, "test.b")  # type: ignore[union-attr]

        def get(**params: object) -> list[dict]:
            resp = client.get("/api/runs", params=params)
            assert resp.status_code == 200, resp.text
            return resp.json()

        hour = get(job="test.a", since="2026-10-10T14:00:00+03:00", until="2026-10-10T15:00:00+03:00")
        assert [r["started_at"][11:16] for r in hour] == ["11:45", "11:30", "11:15", "11:00"]
        oldest = get(job="test.a", since="2026-10-10T11:00:00Z", until="2026-10-10T12:00:00Z", order="asc", limit=2)
        assert [r["started_at"][11:16] for r in oldest] == ["11:00", "11:15"]
        more = get(
            job="test.a",
            since="2026-10-10T11:00:00Z",
            until="2026-10-10T12:00:00Z",
            order="asc",
            after=oldest[-1]["id"],
        )
        assert [r["started_at"][11:16] for r in more] == ["11:30", "11:45"]
        assert len(get(since="2026-10-10T12:30:00Z")) == 4  # both jobs at 12:30 and 12:45
        assert client.get("/api/runs", params={"since": "yesterday"}).status_code == 400


def test_market_sessions_in_a_time_range(tmp_path: Path) -> None:
    with make_client(tmp_path, World(), FakeClock(T0)) as client:
        c = client.app.state.container  # type: ignore[attr-defined]
        for hour in (9, 11, 13):
            stamp = f"2026-10-10T{hour:02d}:00:00.000+00:00"
            c.app_db.execute(
                "INSERT INTO market_session (direction, source, mode, power_w, started_at, updated_at) "
                "VALUES ('sell', 'kratt', 'mfrr', 5000, ?, ?)",
                (stamp, stamp),
            )
        got = client.get(
            "/api/market/sessions", params={"since": "2026-10-10T10:00:00Z", "until": "2026-10-10T12:00:00Z"}
        )
        assert [s["started_at"][11:13] for s in got.json()] == ["11"]
        assert len(client.get("/api/market/sessions").json()) == 3
