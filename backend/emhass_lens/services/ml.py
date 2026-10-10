"""EMHASS's ML load forecaster: fit, tune and predict, run on demand with the same lag settings MPC uses."""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.domain.ml_schedule import auto_fit_due
from emhass_lens.domain.mpc.payload import derive
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.ml")

FIT_KEY = "ml.last_fit"
STEPS_KEY = "ml.model_steps"  # {steps, wanted, seen_at}: EMHASS's load model forecasts fewer slots than the horizon
AUTO_KEY = "ml.auto_fit"  # {at, reason, fault, ok}: the last automatic fit attempt
STEPS_MAX_AGE = timedelta(hours=24)  # then the full horizon is tried again (a refit outside the App would go unseen)


class MlService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self._steps: dict[str, Any] | None = None
        self._steps_loaded = False
        self._auto: asyncio.Task[None] | None = None

    # --- automatic fit (domain/ml_schedule.py decides when) ----------------------------------------------
    def fault(self, now: datetime) -> str | None:
        """Why the model can't serve the runs, in words, or None."""
        short = self.short_info(now)
        if short:
            return f"it forecasts only {short['steps']} of {short['wanted']} slots (a tuned model)"
        mismatch = self.lags_mismatch()
        if mismatch:
            return mismatch[0].lower() + mismatch[1:]
        return None

    async def after_mpc_run(self) -> None:
        """Called when a live MPC run ends: start a fit right after it when one is due (nightly, weekly, or because
        the model can't serve the runs). Only while EMHASS Lens drives EMHASS."""
        mpc = self.c.extras["mpc"]
        replan = getattr(mpc, "_replan", None)
        if replan is not None and not replan.done():
            return  # the re-plan with the cut horizon runs first; it calls this again when it ends
        if self._auto is not None and not self._auto.done():
            return
        if self.c.boot.safe_mode or mpc.driver() != "app" or self.c.extras.get("ml_running"):
            return
        if self.c.extras["emhass"].reachable is not True:
            return
        ml = self.c.settings.current.emhass.ml
        now = self.c.clock.now()
        last_fit = await self.c.app_db.run(self.c.kv_get, FIT_KEY) or {}
        last_auto = await self.c.app_db.run(self.c.kv_get, AUTO_KEY)
        reason = auto_fit_due(
            now=now,
            tz=self.c.extras["prices"].tz,
            auto_fit=ml.auto_fit,
            hour=ml.auto_fit_hour,
            fit_on_fault=ml.fit_on_fault,
            last_fit_at=parse_iso(last_fit.get("at")),
            last_auto=last_auto,
            last_auto_at=parse_iso((last_auto or {}).get("at")),
            fault=self.fault(now),
        )
        if reason is None:
            return
        log.info("Fitting EMHASS's load model after this MPC run (%s)", reason)
        fault = reason not in ("nightly", "weekly")
        self._auto = asyncio.create_task(self._fit_after_run(reason, fault), name="ml:auto_fit")

    async def _fit_after_run(self, reason: str, fault: bool) -> None:
        async with self.c.scheduler.jobs["emhass.mpc"].lock:  # the MPC run that called us still holds the job
            pass
        self.c.scheduler.run_now("ml.fit", {"auto": reason, "fault": fault}, trigger="event")

    # --- how far the model forecasts (learnt from EMHASS's error, see domain/mpc/model_steps.py) ------------
    def _short(self) -> dict[str, Any] | None:
        if not self._steps_loaded:
            self._steps, self._steps_loaded = self.c.kv_get(STEPS_KEY), True
        return self._steps

    def model_steps(self, now: datetime) -> int | None:
        """The slots EMHASS's load model forecasts, while that is known to be fewer than the horizon."""
        known = self._short()
        if not known:
            return None
        seen = parse_iso(known.get("seen_at"))
        if seen is None or now - seen > STEPS_MAX_AGE:
            return None
        return int(known["steps"])

    def short_info(self, now: datetime) -> dict[str, Any] | None:
        known = self._short()
        return known if known and self.model_steps(now) is not None else None

    async def learn_steps(self, steps: int, wanted: int) -> None:
        value = {"steps": steps, "wanted": wanted, "seen_at": iso(self.c.clock.now())}
        self._steps, self._steps_loaded = value, True
        await self.c.app_db.run(self.c.kv_set, STEPS_KEY, value)
        log.warning(
            "EMHASS's load model forecasts only %d slots but the run asked for %d (a tuned model forecasts as far as "
            "the lag count it picked); planning %d slots until the model is fitted again",
            steps,
            wanted,
            steps,
        )

    async def forget_steps(self) -> None:
        if self._short() is None:
            return
        self._steps, self._steps_loaded = None, True
        await self.c.app_db.run(self.c.kv_set, STEPS_KEY, None)

    def _base(self) -> dict[str, Any]:
        settings = self.c.settings.current
        derived = derive(settings)
        return {
            "model_type": "load_forecast",
            "var_model": settings.emhass.ml.var_model,
            "num_lags": derived.num_lags,
        }

    def fit_payload(self, params: dict[str, Any]) -> dict[str, Any]:
        ml = self.c.settings.current.emhass.ml
        base = self._base()
        return {
            **base,
            "historic_days_to_retrieve": int(params.get("historic_days") or ml.historic_days),
            "sklearn_model": params.get("sklearn_model") or ml.sklearn_model,
            "split_date_delta": f"{int(base['num_lags'] / 4)}h",
        }

    async def _action(self, ctx: JobContext, action: str, payload: dict[str, Any], timeout: int) -> bool:
        assert ctx.run is not None
        emhass = self.c.extras["emhass"]
        if not emhass.url:
            raise RunRefused("No EMHASS address")
        ctx.run.artifact("request", payload)
        # a counter, not a flag: a second ML action finishing first mustn't unblock MPC while one still runs
        self.c.extras["ml_running"] = self.c.extras.get("ml_running", 0) + 1
        try:
            async with emhass.action_lock:
                result = await emhass.act(action, payload, timeout)
        finally:
            self.c.extras["ml_running"] = max(0, self.c.extras.get("ml_running", 1) - 1)
        ctx.run.artifact(
            "response",
            {
                "http_status": result.http_status,
                "duration_ms": result.duration_ms,
                "error": result.error,
                "error_lines": result.error_lines[-50:],
                "body": result.body[:20000],
            },
        )
        if result.error:
            ctx.run.outcome, ctx.run.error = "error", result.error
            return False
        return True

    async def fit(self, ctx: JobContext) -> None:
        payload = self.fit_payload(ctx.params)
        timeout = self.c.settings.current.emhass.timeouts.fit
        auto = ctx.params.get("auto")
        ok = await self._action(ctx, "forecast-model-fit", payload, timeout)
        if auto:
            attempt = {"at": iso(self.c.clock.now()), "reason": auto, "fault": bool(ctx.params.get("fault")), "ok": ok}
            await self.c.app_db.run(self.c.kv_set, AUTO_KEY, attempt)
        if ok:
            await self.c.app_db.run(
                self.c.kv_set,
                FIT_KEY,
                {
                    "num_lags": payload["num_lags"],
                    "at": self.c.clock.now().isoformat(),
                    "sklearn_model": payload["sklearn_model"],
                },
            )
            await self.forget_steps()  # a fitted model forecasts num_lags slots again
            assert ctx.run is not None
            ctx.run.summary = f"Fitted {payload['sklearn_model']} with {payload['num_lags']} lags" + (
                f" (automatic: {auto})" if auto else ""
            )

    async def tune(self, ctx: JobContext) -> None:
        payload = {
            **self.fit_payload(ctx.params),
            "n_trials": int(ctx.params.get("n_trials") or self.c.settings.current.emhass.ml.n_trials),
        }
        timeout = self.c.settings.current.emhass.timeouts.tune
        if await self._action(ctx, "forecast-model-tune", payload, timeout):
            await self.forget_steps()  # the next run learns how far the tuned model forecasts
            assert ctx.run is not None
            ctx.run.summary = f"Tuned {payload['sklearn_model']} ({payload['n_trials']} trials)"

    async def predict(self, ctx: JobContext) -> None:
        derived = derive(self.c.settings.current)
        payload = {
            **self._base(),
            "historic_days_to_retrieve": derived.historic_days_to_retrieve,
            "model_predict_publish": True,
            "model_predict_entity_id": "sensor.p_load_forecast_custom_model",
            "model_predict_unit_of_measurement": "W",
            "model_predict_friendly_name": "Load Power Forecast ML",
        }
        if await self._action(ctx, "forecast-model-predict", payload, self.c.settings.current.emhass.timeouts.predict):
            assert ctx.run is not None
            ctx.run.summary = "Published sensor.p_load_forecast_custom_model"

    def lags_mismatch(self) -> str | None:
        last = self.c.kv_get(FIT_KEY)
        if not last:
            return None
        now_lags = derive(self.c.settings.current).num_lags
        if last.get("num_lags") != now_lags:
            return f"The model was fitted with {last.get('num_lags')} lags; runs now use {now_lags}"
        return None
