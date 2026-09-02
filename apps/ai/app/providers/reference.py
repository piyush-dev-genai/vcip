"""The face-match reference seam (R6).

R6 settles the MVP: the AI service holds a local demo reference, there is no
reference-intake API, and no face image is ever written to PostgreSQL. That is
a decision about *this* implementation, not about the shape of the problem — a
real deployment fetches the reference the enterprise already holds. So loading
is an interface, and `LocalReferenceStore` is one implementation of it.

The store is separate from `FaceMatchProvider` on purpose. Fetching a reference
and comparing two faces fail for unrelated reasons and will, later, be operated
by unrelated systems. Keeping them apart means "we have no reference for this
customer" and "the model is down" stay distinguishable all the way to the HUD.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from .determinism import validate_session_id
from .errors import ReferenceUnavailable

DEFAULT_REFERENCE_NAME = "default"
REFERENCE_EXTENSIONS = (".ppm", ".png", ".jpg", ".jpeg")


@dataclass(frozen=True, slots=True)
class Reference:
    """The image a live face is compared against.

    `data` is opaque here: this layer does not decode it, and a provider that
    needs pixels is the one that knows the format it wants. `source` names
    where it came from, so a demo that matched against the wrong face can be
    traced from a log line.
    """

    data: bytes
    source: str

    def __post_init__(self) -> None:
        if not isinstance(self.data, bytes):
            raise TypeError(f"data must be bytes, got {type(self.data).__name__}")
        if not self.data:
            raise ValueError("reference data must not be empty")
        if not isinstance(self.source, str) or not self.source.strip():
            raise ValueError("reference source must be a non-empty string")


@runtime_checkable
class ReferenceStore(Protocol):
    """Where a session's face-match reference comes from."""

    async def load(self, *, session_id: str) -> Reference:
        """Return the reference for this session.

        Raises:
            ReferenceUnavailable: No reference exists or it could not be read.
                The caller turns this into an `UNAVAILABLE` face-match result.
        """
        ...


class LocalReferenceStore:
    """Reads references from a directory on disk.

    Looks for `{session_id}.{ext}` first so a demo can pin a specific face to a
    specific session, then falls back to `default.{ext}` — which is what the
    MVP actually uses, since R6 gives every session the same demo reference.

    File contents are cached, keyed by filename. Face match runs several times
    a call and the demo reference does not change between them; reading it
    again would be blocking I/O on the event loop for the same bytes. The cache
    is keyed by filename rather than by session so it stays bounded by the
    number of reference files, not by how many sessions the service has ever
    handled.

    Existence is still probed each time, which costs a stat and buys something:
    a reference dropped into the directory mid-run is picked up, and that is
    how a demo pins a face without a restart.
    """

    def __init__(self, directory: Path | str) -> None:
        self._directory = Path(directory)
        self._cache: dict[str, Reference] = {}

    @property
    def directory(self) -> Path:
        return self._directory

    async def load(self, *, session_id: str) -> Reference:
        validate_session_id(session_id)

        for name in (session_id, DEFAULT_REFERENCE_NAME):
            reference = self._read(name)
            if reference is not None:
                return reference

        raise ReferenceUnavailable(
            f"no reference for session {session_id} and no {DEFAULT_REFERENCE_NAME}"
            f"{REFERENCE_EXTENSIONS[0]} in {self._directory}"
        )

    def _read(self, name: str) -> Reference | None:
        for extension in REFERENCE_EXTENSIONS:
            path = self._directory / f"{name}{extension}"
            if not path.is_file():
                continue
            cached = self._cache.get(path.name)
            if cached is not None:
                return cached
            try:
                data = path.read_bytes()
            except OSError as exc:
                # An unreadable file is an operational fault, not a bug here:
                # the reference is unavailable and the call carries on (D6).
                raise ReferenceUnavailable(f"cannot read {path.name}: {exc.strerror}") from exc
            if not data:
                raise ReferenceUnavailable(f"{path.name} is empty")
            reference = Reference(data=data, source=path.name)
            self._cache[path.name] = reference
            return reference
        return None


class EmptyReferenceStore:
    """A store that holds nothing.

    Used by the `unavailable` provider mode, so a degraded AI service reports
    a missing reference the same way a broken one would.
    """

    async def load(self, *, session_id: str) -> Reference:
        validate_session_id(session_id)
        raise ReferenceUnavailable("reference store is disabled")
