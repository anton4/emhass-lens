"""EMHASS's solver time from the time left before the publish, and what a timed-out solve looks like."""

from datetime import UTC, datetime

from emhass_lens.domain.mpc import solver_budget as budget

AT_11 = datetime(2026, 10, 10, 14, 11, 0, tzinfo=UTC)
# run 985's last-run record: a 55 s limit, 91 s of solving with EMHASS's relaxed retry, no reason given
RUN_985 = {
    "status": "error",
    "action": "naive-mpc-optim",
    "stage_times": {"load_forecast": 2.96, "optim_solve.solve": 91.02},
    "infeasible": False,
    "error_message": None,
}


def test_the_budget_runs_to_the_next_publish() -> None:
    until = budget.deadline(AT_11, 2)
    assert until == datetime(2026, 10, 10, 14, 15, 2, tzinfo=UTC)
    assert budget.limit_for(AT_11, until, budget.LIVE_SHARE) == 63  # (242 − 10) × 0.6 / 2.2
    assert budget.limit_for(AT_11, until, 1.0) == 105
    assert budget.alternative_limit(AT_11, until) == 15
    at_13 = datetime(2026, 10, 10, 14, 13, 0, tzinfo=UTC)
    assert budget.limit_for(at_13, budget.deadline(at_13, 2), budget.LIVE_SHARE) == 30
    assert budget.alternative_limit(at_13, budget.deadline(at_13, 2)) is None  # too little to bother: no limit sent


def test_a_run_right_before_the_publish_plans_for_the_next_one() -> None:
    late = datetime(2026, 10, 10, 14, 14, 30, tzinfo=UTC)
    assert budget.deadline(late, 2) == datetime(2026, 10, 10, 14, 30, 2, tzinfo=UTC)
    assert budget.limit_for(late, budget.deadline(late, 2), budget.LIVE_SHARE) == 180  # capped at EMHASS's default


def test_a_timed_out_solve_is_recognised_and_explained() -> None:
    assert budget.timed_out(RUN_985, 55)
    assert not budget.timed_out(RUN_985, 120)  # stopped well before its limit: something else
    assert not budget.timed_out({**RUN_985, "error_message": "boom"}, 55)
    assert not budget.timed_out({**RUN_985, "status": "ok"}, 55)
    assert budget.explain_error(RUN_985, 55) == (
        "EMHASS's solver stopped at its time limit (55 s) and its relaxed retry found no plan either (91 s in all)"
    )
    assert budget.explain_error(RUN_985, 120) == "EMHASS reported an error after 91 s of solving; it gave no reason"
    assert budget.explain_error({"status": "error"}, None) == "EMHASS reported an error; it gave no reason"
    assert budget.explain_error({**RUN_985, "error_message": "boom"}, 55) == "boom"
    assert budget.http_timeout(63, 180) == 187.5
    assert budget.http_timeout(None, 180) == 180
