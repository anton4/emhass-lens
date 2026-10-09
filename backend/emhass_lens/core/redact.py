"""Keeps secrets (API keys, tokens) out of logs, run artifacts and API responses."""

import threading
from typing import Any

MASK = "********"
_MIN_SECRET_LEN = 6  # shorter values would mask ordinary words


class Redactor:
    def __init__(self) -> None:
        self._secrets: frozenset[str] = frozenset()
        self._lock = threading.Lock()

    def set_secrets(self, *groups: object) -> None:
        values: set[str] = set()
        for group in groups:
            if isinstance(group, str):
                group = [group]
            if isinstance(group, (list, tuple, set, frozenset)):
                for value in group:
                    if isinstance(value, str) and len(value) >= _MIN_SECRET_LEN:
                        values.add(value)
        with self._lock:
            self._secrets = frozenset(values)

    def add(self, value: str | None) -> None:
        if value and len(value) >= _MIN_SECRET_LEN:
            with self._lock:
                self._secrets = self._secrets | {value}

    def text(self, value: str) -> str:
        for secret in self._secrets:
            if secret in value:
                value = value.replace(secret, MASK)
        return value

    def data(self, value: Any) -> Any:
        """Redact recursively inside JSON-like data."""
        if not self._secrets:
            return value
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            return {k: self.data(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.data(v) for v in value]
        return value


redactor = Redactor()
"""Process-wide instance: the logging filter and the HTTP clients share the same secrets."""
