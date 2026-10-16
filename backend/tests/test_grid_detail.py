"""The measured grid power finer than the quarter-hour means, beside the market's commands (services/grid_detail.py)."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock, iso
from tests.test_market_service import MODE, POWER, SOURCE, START
from tests.test_market_service import world as market_world  # noqa: F401  (fixture)
from tests.test_phase1 import run_job
from tests.test_phase2 import live_client
from tests.world import World

METER = "sensor.grid_meter_power"  # + export, the way many meters count it
GRID = {"grid": {"entity": METER, "invert": True}}


def client_for(tmp_path: Path, world: World, clock: FakeClock, **changes) -> TestClient:
    return live_client(tmp_path, world, clock, market={"mode": "off"}, **changes)


def at(h: int, m: int, s: int = 0) -> datetime:
    return datetime(2026, 10, 9, h, m, s, tzinfo=UTC)


def history(world: World) -> None:
    """The meter every 10 s from 08:00 to now: 490/510 W import, and 9300 W export while the sell command runs
    (08:45:12–09:04:00)."""
    sell_from, sell_to = at(8, 45, 12), at(9, 4)
    meter: list[tuple[datetime, str]] = []
    t = at(8, 0)
    k = 0
    while t < START:
        exporting = sell_from <= t < sell_to
        meter.append((t, "9300" if exporting else str(-490 if k % 2 else -510)))
        if t < sell_from <= t + timedelta(seconds=10):
            meter.append((sell_from, "9300"))
        t += timedelta(seconds=10)
        k += 1
    world.ha_history = {
        METER: meter,
        SOURCE: [(at(6, 0), "kratt")],
        MODE: [(at(6, 0), "none"), (sell_from, "mfrrup"), (sell_to, "none")],
        POWER: [(at(6, 0), "0"), (sell_from, "9420"), (at(9, 5), "0")],
    }


def meter_reads(world: World) -> list[tuple[datetime, datetime]]:
    return [(a, b) for a, b, ids in world.history_calls if METER in ids]


def test_the_line_breaks_where_the_commands_do_and_each_hour_is_read_once(tmp_path: Path, market_world: World) -> None:  # noqa: F811
    world = market_world
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, measurements=GRID)
    history(world)
    try:
        params = {"since": "2026-10-09T08:00:00Z", "until": "2026-10-09T10:00:00Z", "max_points": 500}
        got = client.get("/api/measurements/grid", params=params)
        assert got.status_code == 200, got.text
        body = got.json()
        assert body["entity"] == METER and body["error"] is None
        assert body["step_s"] == 30  # 720 changes don't fit 500 points
        assert len(body["points"]) <= 500
        by_t = {p["t"]: p["w"] for p in body["points"]}
        assert by_t["2026-10-09T08:00:00.000+00:00"] == 503  # 510, 490 and 510 W import over the first 30 s
        first = body["points"][0]
        assert (first["lo"], first["hi"]) == (490, 510)  # and the readings it is the mean of
        assert by_t["2026-10-09T08:45:12.000+00:00"] == -9300  # the command's start is a point of its own
        assert "2026-10-09T08:45:30.000+00:00" not in by_t  # merged: still the same export
        assert 490 <= by_t["2026-10-09T09:04:00.000+00:00"] <= 510  # import again from the end

        # (the measurement jobs read the meter too: count only reads of these hours)
        def ours() -> list[tuple[datetime, datetime]]:
            return [r for r in meter_reads(world) if at(8, 0) <= r[0] and r[1] <= at(10, 0)]

        assert ours() == [(at(8, 0), at(10, 0))]  # two hours in one request
        assert client.get("/api/measurements/grid", params=params).json() == body
        assert ours() == [(at(8, 0), at(10, 0))]  # settled hours aren't read again

        commands = client.get("/api/market/commands", params={"since": "2026-10-09T08:00:00Z"}).json()
        [span] = commands["spans"]
        assert span["start"] == "2026-10-09T08:45:12.000+00:00"
        assert span["measured_w"] == -9300 and span["measured_coverage"] == 1.0
        assert commands["measured_error"] is None
        assert ours() == [(at(8, 0), at(10, 0))]  # from memory too
    finally:
        client.__exit__(None, None, None)


def test_a_short_window_gets_every_change_and_the_live_hour_is_read_again(tmp_path: Path, market_world: World) -> None:  # noqa: F811
    world = market_world
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, measurements=GRID)
    history(world)
    try:
        short = client.get(
            "/api/measurements/grid", params={"since": "2026-10-09T09:30:00Z", "until": "2026-10-09T09:40:00Z"}
        ).json()
        assert short["step_s"] is None and len(short["points"]) == 60
        assert [p["w"] for p in short["points"][:2]] == [510, 490]
        assert short["points"][0]["lo"] is None and short["points"][0]["hi"] is None  # raw changes need no bounds

        def live_read() -> list[tuple[datetime, datetime]]:
            """The meter reads ending at now that the request made (the measurement jobs read it too)."""
            before = len(meter_reads(world))
            live = client.get("/api/measurements/grid", params={"since": "2026-10-09T10:30:00Z"}).json()
            assert live["end"] == iso(clock.now())
            return [r for r in meter_reads(world)[before:] if r[1] == clock.now()]

        assert live_read() == [(at(10, 0), START)]  # the hours not read yet, up to now
        clock.advance(10)
        assert live_read() == []  # not again within 30 s
        clock.advance(60)
        assert live_read() == [(at(11, 0), START + timedelta(seconds=70))]  # only the hour still going
    finally:
        client.__exit__(None, None, None)


def test_without_a_sensor_or_the_recorder_the_line_says_why(tmp_path: Path, market_world: World) -> None:  # noqa: F811
    world = market_world
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock)
    history(world)
    try:
        bare = client.get("/api/measurements/grid", params={"since": "2026-10-09T08:00:00Z"}).json()
        assert bare["points"] == [] and "No grid power sensor" in bare["error"]
        commands = client.get("/api/market/commands", params={"since": "2026-10-09T08:00:00Z"}).json()
        assert commands["spans"][0]["measured_w"] is None and commands["measured_error"] is None

        rev = client.get("/api/settings").json()["revision"]
        client.patch("/api/settings", json={"base_revision": rev, "changes": {"measurements": GRID}})
        assert client.get("/api/measurements/grid", params={"since": "2026-10-09T09:00:00Z"}).json()["points"]

        # the window: never past now, at most 8 days, and it has to start before it ends
        ahead = client.get(
            "/api/measurements/grid", params={"since": "2026-10-09T11:00:00Z", "until": "2026-10-09T13:00:00Z"}
        ).json()
        assert ahead["end"] == "2026-10-09T11:13:00.000+00:00"
        long = client.get("/api/measurements/grid", params={"since": "2026-10-01T00:00:00Z"}).json()
        assert long["start"] == "2026-10-01T11:13:00.000+00:00"
        assert client.get("/api/measurements/grid", params={"since": "2026-10-09T12:00:00Z"}).status_code == 400

        world.ha_history_status = 404
        clock.advance(3600)  # past what's in memory
        broken = client.get("/api/measurements/grid", params={"since": "2026-10-09T11:30:00Z"}).json()
        assert broken["points"] == [] and "history integration" in broken["error"]
    finally:
        client.__exit__(None, None, None)


def test_the_delivered_power_covers_the_week_and_skips_older_commands(tmp_path: Path, market_world: World) -> None:  # noqa: F811
    world = market_world
    clock = FakeClock(START + timedelta(hours=49))
    client = client_for(tmp_path, world, clock, measurements=GRID)
    history(world)
    try:
        commands = client.get("/api/market/commands", params={"since": "2026-10-09T08:00:00Z"}).json()
        assert commands["spans"][0]["measured_w"] == -9300  # two days back: still measured
        clock.set(START + timedelta(days=8, hours=1))
        commands = client.get(
            "/api/market/commands", params={"since": "2026-10-09T08:00:00Z", "until": "2026-10-09T10:00:00Z"}
        ).json()
        assert commands["spans"][0]["measured_w"] is None  # over 8 days ago
    finally:
        client.__exit__(None, None, None)


def test_a_long_window_reads_the_newest_hours_first_and_the_warm_up_job_the_rest(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, measurements=GRID)
    history(world)
    try:
        params = {"since": "2026-10-07T11:00:00Z", "max_points": 2000}

        def reads_of(window_start: datetime) -> list[tuple[datetime, datetime]]:
            return [r for r in meter_reads(world) if r[0] >= window_start]

        before = len(meter_reads(world))
        body = client.get("/api/measurements/grid", params=params).json()
        assert body["pending"] is True  # the older hours are still to read
        # newest first, at most 12 settled hours per request: 06:00 to now, then the six hours before
        assert meter_reads(world)[before:] == [(at(6, 0), START), (at(0, 0), at(6, 0))]
        assert body["points"]  # what is there is drawn

        run: dict = {}
        for _ in range(12):
            run = run_job(client, "measure.grid_warm")
            if "are in memory" in (run["summary"] or ""):
                break
        assert run["summary"] == "The grid's readings for the last 8 days are in memory"
        again = client.get("/api/measurements/grid", params=params).json()
        assert again["pending"] is False
    finally:
        client.__exit__(None, None, None)


def test_a_session_gets_the_grid_mean_before_it_as_its_baseline(tmp_path: Path, market_world: World) -> None:  # noqa: F811
    world = market_world
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, measurements=GRID)
    history(world)
    try:
        commands = client.get("/api/market/commands", params={"since": "2026-10-09T08:00:00Z"}).json()
        [span] = commands["spans"]
        assert span["baseline_w"] == 500  # 490 and 510 W import, the minute before 08:45:12
        # no baseline when it is set to 0 s
        rev = client.get("/api/settings").json()["revision"]
        saved = client.patch(
            "/api/settings", json={"base_revision": rev, "changes": {"market": {"thresholds": {"baseline_s": 0}}}}
        )
        assert saved.status_code == 200, saved.text
        commands = client.get("/api/market/commands", params={"since": "2026-10-09T08:00:00Z"}).json()
        assert commands["spans"][0]["baseline_w"] is None
    finally:
        client.__exit__(None, None, None)
