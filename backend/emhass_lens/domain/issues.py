"""Findings attached to runs and checks: errors stop an action, warnings are shown but don't."""

from dataclasses import asdict, dataclass
from typing import Any, Literal

Level = Literal["error", "warning", "info"]


@dataclass(frozen=True, slots=True)
class Issue:
    level: Level
    code: str
    message: str
    hint: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def errors(issues: list[Issue]) -> list[Issue]:
    return [i for i in issues if i.level == "error"]
