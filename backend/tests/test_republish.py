"""After a failed live run the publish posts the last good plan again (services/publish.py): live runs send
entity_save, a failed optimisation leaves EMHASS's saved entities alone, and publish_prefix "all" posts them. Runs
2405/2406: a timed-out solve, then a publish EMHASS refused."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import run_job
from tests.test_phase2 import LEGACY_SWITCH, live_client
from tests.world import TZ, World

AT_11 = datetime(2026, 10, 9, 11, 11, 0, tzinfo=UTC)  # 14:11 local
EMHASS = "http://emhass.test:5000"


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    return w


def client(tmp_path: Path, world: World, clock: FakeClock) -> TestClient:
    return live_client(tmp_path, world, clock, emhass={"base_url": EMHASS, "mode": "live", "mpc": {"auto": True}})


def publishes(world: World) -> list[dict]:
    return [p for name, p in world.emhass_actions if name == "publish-data"]


def fail_solves(world: World) -> None:
    world.emhass_solve_s = {"profit": 500}  # past every limit, and the retry's looser gap doesn't help either
    world.emhass_solver_stuck = True


def test_a_failed_live_run_is_followed_by_the_last_good_plan_until_it_is_too_old(tmp_path: Path, world: World) -> None:
    clock = FakeClock(AT_11)
    c = client(tmp_path, world, clock)
    try:
        good = run_job(c, "emhass.mpc")
        assert good["outcome"] == "ok", good
        published = run_job(c, "emhass.publish")
        assert published["outcome"] == "ok" and published["summary"].startswith("Published")
        assert publishes(world)[-1] == {}  # EMHASS holds the live plan: the normal publish

        fail_solves(world)
        clock.advance(minutes=25)  # 14:36: the scheduled 14:26 MPC and 14:30:02 publish are past their grace
        failed = run_job(c, "emhass.mpc")
        assert failed["outcome"] == "error"
        assert not world.emhass_result_ok  # a plain publish-data would be refused now (run 2406)
        republished = run_job(c, "emhass.publish")
        assert republished["outcome"] == "ok", republished
        assert publishes(world)[-1] == {"publish_prefix": "all"}
        assert republished["summary"].startswith(f"Republished 14:30 from the plan of 14:11 (#{good['id']}): ")
        assert f"EMHASS's last optimisation (#{failed['id']}) failed: EMHASS's solver stopped" in republished["summary"]
        why = c.get(f"/api/runs/{republished['id']}/artifacts/republish").json()
        assert why["saved_plan"]["run_id"] == good["id"]
        [(_, event)] = [e for e in world.ha_events if e[0] == "emhass_lens_plan_published"][-1:]
        assert event["run_id"] == good["id"] and event["republished_because"].startswith("EMHASS's last optimisation")

        clock.advance(minutes=8)  # 14:44, the good plan is 33 min old: the inverter wouldn't follow it either
        count = len(publishes(world))
        refused = run_job(c, "emhass.publish")
        assert refused["outcome"] == "refused"
        assert refused["summary"].startswith("Not publishing: EMHASS's last optimisation")
        assert refused["summary"].endswith(f"the last good plan (#{good['id']}, 14:11) is older than 30 min")
        assert len(publishes(world)) == count  # EMHASS isn't asked for a publish that can only fail

        world.emhass_solve_s, world.emhass_solver_stuck = {}, False
        clock.advance(minutes=10)
        assert run_job(c, "emhass.mpc")["outcome"] == "ok"
        assert run_job(c, "emhass.publish")["outcome"] == "ok"
        assert publishes(world)[-1] == {}
    finally:
        c.__exit__(None, None, None)


def test_nothing_is_published_while_no_good_plan_was_saved(tmp_path: Path, world: World) -> None:
    fail_solves(world)
    c = client(tmp_path, world, FakeClock(AT_11))
    try:
        assert run_job(c, "emhass.mpc")["outcome"] == "error"
        refused = run_job(c, "emhass.publish")
        assert refused["outcome"] == "refused"
        assert refused["summary"].endswith("there is no saved plan to publish again yet")
        assert publishes(world) == []
    finally:
        c.__exit__(None, None, None)


def test_extra_runtime_parameters_can_turn_entity_saving_off(tmp_path: Path, world: World) -> None:
    emhass = {"base_url": EMHASS, "mode": "live", "mpc": {"auto": True}, "extra_runtime_params": {"entity_save": False}}
    clock = FakeClock(AT_11)
    c = live_client(tmp_path, world, clock, emhass=emhass)
    try:
        assert run_job(c, "emhass.mpc")["outcome"] == "ok"
        [payload] = [p for name, p in world.emhass_actions if name == "naive-mpc-optim"]
        assert payload["entity_save"] is False
        fail_solves(world)
        clock.advance(minutes=15)
        assert run_job(c, "emhass.mpc")["outcome"] == "error"
        assert run_job(c, "emhass.publish")["summary"].endswith("there is no saved plan to publish again yet")
    finally:
        c.__exit__(None, None, None)
