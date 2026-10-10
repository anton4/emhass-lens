"""A live solve that stops at its time limit is retried once with a looser MIP gap (services/mpc.py send)."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import run_job
from tests.test_phase2 import LEGACY_SWITCH, live_client
from tests.world import TZ, World

AT_11 = datetime(2026, 10, 9, 11, 11, 0, tzinfo=UTC)  # 14:11 local: the publish at 14:15:02 is 242 s away
EMHASS = "http://emhass.test:5000"


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    return w


def client(tmp_path: Path, world: World, **mpc) -> TestClient:
    emhass = {"base_url": EMHASS, "mode": "live", "mpc": {"auto": True, **mpc}}
    return live_client(tmp_path, world, FakeClock(AT_11), emhass=emhass)


def sent(world: World) -> list[dict]:
    return [p for name, p in world.emhass_actions if name == "naive-mpc-optim"]


def test_a_solve_that_hits_its_limit_is_retried_with_a_looser_gap(tmp_path: Path, world: World) -> None:
    world.emhass_solve_s = {"profit": 80}  # longer than the 63 s the first attempt gets
    c = client(tmp_path, world)
    try:
        run = run_job(c, "emhass.mpc")
        assert run["outcome"] == "ok", run
        first, retry = sent(world)
        assert first["lp_solver_timeout"] == 63 and "lp_solver_mip_rel_gap" not in first
        assert retry["lp_solver_timeout"] == 105 and retry["lp_solver_mip_rel_gap"] == 0.05
        assert run["summary"].endswith("after a retry with a 5 % MIP gap (the first solve hit its 63 s limit)")
        kinds = {a["kind"] for a in run["artifacts"]}
        assert {"response", "emhass_last_run", "request_retry", "response_retry", "emhass_last_run_retry"} <= kinds
        assert c.get("/api/plan").json()["current"]["driver"] == "app"
    finally:
        c.__exit__(None, None, None)


def test_a_retry_that_fails_too_says_why(tmp_path: Path, world: World) -> None:
    world.emhass_solve_s = {"profit": 500}
    world.emhass_solver_stuck = True
    c = client(tmp_path, world)
    try:
        run = run_job(c, "emhass.mpc")
        assert run["outcome"] == "error"
        assert run["error"] == (
            "EMHASS's solver stopped at its time limit (63 s) and its relaxed retry found no plan either (126 s in "
            "all); the retry with a 5 % MIP gap failed too: EMHASS's solver stopped at its time limit (105 s) and its "
            "relaxed retry found no plan either (210 s in all)"
        )
    finally:
        c.__exit__(None, None, None)


def test_emhass_s_own_limit_and_an_explicit_one_are_respected(tmp_path: Path, world: World) -> None:
    world.emhass_solve_s = {"profit": 80}
    c = client(tmp_path / "own", world, solver_budget="emhass")
    try:
        assert run_job(c, "emhass.mpc")["outcome"] == "ok"  # the fake only times out when a limit is sent
        assert "lp_solver_timeout" not in sent(world)[-1]
    finally:
        c.__exit__(None, None, None)
    emhass = {
        "base_url": EMHASS,
        "mode": "live",
        "mpc": {"auto": True},
        "extra_runtime_params": {"lp_solver_timeout": 200},
    }
    c = live_client(tmp_path / "extra", world, FakeClock(AT_11), emhass=emhass)
    try:
        assert run_job(c, "emhass.mpc")["outcome"] == "ok"
        assert sent(world)[-1]["lp_solver_timeout"] == 200
    finally:
        c.__exit__(None, None, None)


def test_comparison_steps_get_short_limits_and_a_retried_live_plan_clears_the_leftover(
    tmp_path: Path, world: World
) -> None:
    world.emhass_solve_s = {"profit": 80}
    c = client(tmp_path, world, compare_costfuns=True)
    try:
        run = run_job(c, "emhass.mpc")
        assert run["outcome"] == "ok", run
        payloads = sent(world)
        assert [p.get("costfun") for p in payloads] == ["cost", "self-consumption", None, None]
        assert [p["lp_solver_timeout"] for p in payloads] == [15, 15, 63, 105]
        assert c.app.state.container.extras["costfun"].leftover is None  # type: ignore[attr-defined]
    finally:
        c.__exit__(None, None, None)
