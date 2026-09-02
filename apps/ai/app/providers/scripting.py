"""Scripted overrides, so a test can state the outcome it needs.

A deterministic mock is reproducible but not steerable: to test what happens on
`NOT_LIVE` you would have to go hunting for a session id that hashes to it, and
the test would then be pinned to the hash rather than to the behaviour it is
about. A script says it directly.

The same mechanism covers failure, because an entry may be an exception
instead of a result. Scripting `ProviderUnavailable` proves the provider turns
an expected failure into an `UNAVAILABLE` result; scripting a `RuntimeError`
proves it lets a programming error through instead of dressing it up as one.

Scripts are a test seam. Nothing in the running service writes one.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Generic, TypeVar

_ResultT = TypeVar("_ResultT")


class Script(Generic[_ResultT]):
    """Per-session outcomes that pre-empt a provider's derived result."""

    def __init__(self, overrides: Mapping[str, _ResultT | BaseException] | None = None) -> None:
        self._overrides: dict[str, _ResultT | BaseException] = {}
        for session_id, outcome in (overrides or {}).items():
            self.set(session_id, outcome)

    def set(self, session_id: str, outcome: _ResultT | BaseException) -> None:
        """Script `session_id`. A `BaseException` is raised, anything else returned."""
        if isinstance(outcome, type) and issubclass(outcome, BaseException):
            # `overrides={id: ProviderUnavailable}` instead of
            # `ProviderUnavailable("...")` would otherwise be returned as
            # though the class were a result, and a test asserting on
            # UNAVAILABLE would fail somewhere far from its cause.
            raise TypeError(
                f"script {outcome.__name__} as an instance, not the class:"
                f" {outcome.__name__}('why')"
            )
        self._overrides[session_id] = outcome

    def clear(self) -> None:
        self._overrides.clear()

    def resolve(self, session_id: str) -> _ResultT | None:
        """Return the scripted result, raise a scripted exception, or return `None`.

        `None` means nothing is scripted for this session and the provider
        should derive its own answer.
        """
        outcome = self._overrides.get(session_id)
        if outcome is None:
            return None
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome
