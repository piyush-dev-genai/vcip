"""Deriving stable pseudo-results from a session id.

The mock providers must be reproducible: the same session analysed twice gives
the same answer, so a demo can be re-run and a failing test re-read. They must
also vary: two sessions in the same demo that both score 91 look like a stub,
not like a model.

Both come from hashing the session id. Nothing here consults the frames — a
mock that reacted to pixels would be pretending to be a model, and the moment
its output moved for an unrelated reason the reproducibility guarantee would be
gone. Frames are still validated by the providers; they simply do not steer the
outcome.

The digest is `blake2b`, which is stdlib, fast, and fixed across releases. The
domain string keeps the three checks independent: one session may be `LIVE` and
`NO_MATCH`, which is exactly the case an agent needs to be shown.
"""

from __future__ import annotations

import hashlib
import re

_DIGEST_BYTES = 8
_BUCKET_MASK = 0xFFFFFFFF
_SESSION_ID = re.compile(r"[0-9A-Za-z_-]{1,64}")


def validate_session_id(session_id: str) -> str:
    """Return `session_id` if it is a plausible identifier, else raise.

    Sessions are UUIDs. The check is deliberately strict rather than
    cosmetic: `LocalReferenceStore` builds a filename out of this value, and a
    session id containing a path separator would read a file of the caller's
    choosing.
    """
    if not isinstance(session_id, str):
        raise TypeError(f"session_id must be a str, got {type(session_id).__name__}")
    if not _SESSION_ID.fullmatch(session_id):
        raise ValueError(f"session_id must be 1-64 of [0-9A-Za-z_-], got {session_id!r}")
    return session_id


def _digest(domain: str, session_id: str) -> int:
    payload = f"{domain}:{session_id}".encode()
    return int.from_bytes(hashlib.blake2b(payload, digest_size=_DIGEST_BYTES).digest(), "big")


def bucket(domain: str, session_id: str, *, modulo: int = 100) -> int:
    """A stable value in `[0, modulo)` for this session and check.

    Providers use it to pick which outcome a session gets, so the split
    between outcomes is expressed as plain percentages at the call site.
    """
    if modulo <= 0:
        raise ValueError(f"modulo must be positive, got {modulo}")
    return (_digest(domain, session_id) & _BUCKET_MASK) % modulo


def score_in(domain: str, session_id: str, low: int, high: int) -> int:
    """A stable score in `[low, high]` for this session and check.

    Drawn from the half of the digest that `bucket` does not use, so a session
    near the bottom of its outcome band is not also pinned near the bottom of
    its score range.
    """
    if low > high:
        raise ValueError(f"low must not exceed high, got {low}-{high}")
    span = high - low + 1
    return low + ((_digest(domain, session_id) >> 32) % span)
