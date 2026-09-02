"""Test helpers for the provider layer."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any, TypeVar

from app.providers import Frame

_T = TypeVar("_T")


def run(coro: Coroutine[Any, Any, _T]) -> _T:
    """Drive one coroutine to completion.

    The provider interfaces are async because real implementations will do
    network I/O. The mocks do not, so the tests need a loop and nothing else —
    not an async test plugin.
    """
    return asyncio.run(coro)


def frame(*, width: int = 4, height: int = 4, ts_us: int = 0, fill: int = 0) -> Frame:
    """A well-formed RGB24 frame of a solid colour."""
    return Frame(
        width=width,
        height=height,
        data=bytes([fill % 256]) * (width * height * 3),
        ts_us=ts_us,
    )


def frames(count: int = 3, *, width: int = 4, height: int = 4) -> list[Frame]:
    """A short sequence, one frame every 50 ms, each a different shade."""
    return [
        frame(width=width, height=height, ts_us=index * 50_000, fill=index * 7)
        for index in range(count)
    ]
