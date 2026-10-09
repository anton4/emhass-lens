"""In-process event bus that feeds the UI's live stream (logs, runs, jobs, settings changes).

publish() is safe to call from any thread: the logging handlers run in whatever thread logs.
Slow subscribers lose events instead of blocking the publisher.
"""

import asyncio
import contextlib
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class Event:
    topic: str
    data: Any


class _Subscriber:
    def __init__(self, topics: frozenset[str] | None, maxsize: int) -> None:
        self.topics = topics
        self.queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=maxsize)
        self.dropped = 0

    def wants(self, topic: str) -> bool:
        if self.topics is None:
            return True
        prefix = topic.split(".", 1)[0]
        return topic in self.topics or prefix in self.topics

    def offer(self, event: Event) -> None:
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            self.dropped += 1


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[_Subscriber] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the event loop, so other threads can hand events over to it."""
        self._loop = loop

    def publish(self, topic: str, data: Any = None) -> None:
        event = Event(topic, data)
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._deliver(event)
        else:
            with contextlib.suppress(RuntimeError):  # loop shutting down
                loop.call_soon_threadsafe(self._deliver, event)

    def _deliver(self, event: Event) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for sub in subscribers:
            if sub.wants(event.topic):
                sub.offer(event)

    @asynccontextmanager
    async def subscribe(
        self, topics: set[str] | None = None, maxsize: int = 1000
    ) -> AsyncIterator[asyncio.Queue[Event]]:
        """Subscribe to topics (exact names or prefixes like "run"); None means everything."""
        sub = _Subscriber(frozenset(topics) if topics else None, maxsize)
        with self._lock:
            self._subscribers.add(sub)
        try:
            yield sub.queue
        finally:
            with self._lock:
                self._subscribers.discard(sub)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
