"""Problems: things that need attention, when they started and ended.

Rules (services/health_rules.py) call sync() every minute with the full set of problems they
currently see; problems that disappear are closed. Each open/close is stored in app.db and pushed
to the UI.
"""

import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.problems")

SEVERITY_ORDER = {"info": 0, "warning": 1, "error": 2}


@dataclass
class Problem:
    key: str
    severity: str  # warning | error
    title: str
    detail: str | None = None
    hint: str | None = None
    link: str | None = None  # UI route, e.g. "#/inputs"
    since: datetime | None = None
    event_id: int | None = None

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["since"] = iso(self.since)
        return data


NOTIFICATION_ID = "emhass_lens_problems"


class ProblemService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.problems: dict[str, Problem] = {}
        self._notified: frozenset[str] = frozenset()

    def load(self) -> None:
        """Problems still open from before a restart are closed; the rules re-raise what still applies."""
        self.c.app_db.execute(
            "UPDATE problem_event SET ended_at = ? WHERE ended_at IS NULL", (iso(self.c.clock.now()),)
        )

    def active(self) -> list[dict[str, Any]]:
        ordered = sorted(
            self.problems.values(), key=lambda p: (-SEVERITY_ORDER.get(p.severity, 0), p.since or self.c.clock.now())
        )
        return [p.as_dict() for p in ordered]

    async def sync(self, current: list[Problem]) -> None:
        now = self.c.clock.now()
        seen = {p.key for p in current}
        for problem in current:
            existing = self.problems.get(problem.key)
            if existing is None:
                problem.since = now
                problem.event_id = await self.c.app_db.aexecute(
                    "INSERT INTO problem_event (key, severity, title, detail, hint, started_at) VALUES (?,?,?,?,?,?)",
                    (problem.key, problem.severity, problem.title, problem.detail, problem.hint, iso(now)),
                )
                self.problems[problem.key] = problem
                log.log(
                    30 if problem.severity != "error" else 40,
                    "Problem: %s%s",
                    problem.title,
                    f" ({problem.detail})" if problem.detail else "",
                )
                self.c.bus.publish("problem.opened", problem.as_dict())
            elif (existing.severity, existing.title, existing.detail) != (
                problem.severity,
                problem.title,
                problem.detail,
            ):
                if problem.detail and problem.detail != existing.detail:
                    log.log(  # the reason often arrives a check later (e.g. MQTT's first connection attempt)
                        30 if problem.severity != "error" else 40, "Problem: %s (%s)", problem.title, problem.detail
                    )
                existing.severity, existing.title, existing.detail = problem.severity, problem.title, problem.detail
                existing.hint, existing.link = problem.hint, problem.link
                await self.c.app_db.aexecute(
                    "UPDATE problem_event SET severity = ?, title = ?, detail = ? WHERE id = ?",
                    (existing.severity, existing.title, existing.detail, existing.event_id),
                )
                self.c.bus.publish("problem.updated", existing.as_dict())
        for key in list(self.problems):
            if key not in seen:
                gone = self.problems.pop(key)
                await self.c.app_db.aexecute(
                    "UPDATE problem_event SET ended_at = ? WHERE id = ?", (iso(now), gone.event_id)
                )
                log.info("Resolved: %s", gone.title)
                self.c.bus.publish("problem.resolved", gone.as_dict())

        await self._notify(now)

    async def _notify(self, now: datetime) -> None:
        """Keep one Home Assistant persistent notification listing errors older than the grace time."""
        if not self.c.settings.current.notifications.persistent:
            return
        grace = timedelta(minutes=self.c.settings.current.health.problem_grace_min)
        due = [p for p in self.problems.values() if p.severity == "error" and p.since and now - p.since >= grace]
        keys = frozenset(p.key for p in due)
        if keys == self._notified:
            return
        ha = self.c.extras.get("ha")
        if ha is None or not ha.connected:
            return
        try:
            if due:
                lines = "\n".join(f"- **{p.title}**" + (f": {p.detail}" if p.detail else "") for p in due)
                await ha.call_service(
                    "persistent_notification",
                    "create",
                    {
                        "notification_id": NOTIFICATION_ID,
                        "title": "EMHASS Lens needs attention",
                        "message": f"{lines}\n\nOpen EMHASS Lens → Health for details.",
                    },
                )
            else:
                await ha.call_service("persistent_notification", "dismiss", {"notification_id": NOTIFICATION_ID})
            self._notified = keys
        except Exception as exc:
            log.warning("Updating the Home Assistant notification failed: %s", exc)

    async def history(self, limit: int = 100) -> list[dict[str, Any]]:
        return await self.c.app_db.aquery(
            "SELECT id, key, severity, title, detail, hint, started_at, ended_at FROM problem_event "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        )
