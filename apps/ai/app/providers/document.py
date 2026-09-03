"""Reading one identity document, and checking it against its registry.

This is the only module in the system that holds a document's contents, and it
is built so that they cannot leave it by accident.

**Why it is separate from `ocr.py`.** The continuous OCR check answers "is a
document visible at all" and carries no text, deliberately — its result type
says so and four documents depend on it. That contract is untouched. This is
the other half of `03-system-design.md` §19: the *triggered* read, which runs
when an agent says a document is being shown, and which by its nature has to
look at what the card says. Keeping the two apart means the promise made about
the continuous path stays literally true rather than becoming a caveat.

**The fields die here.** `DocumentFields` goes from the reader to the verifier
and is then dropped. Nothing returns it, nothing stores it, and nothing can log
it: its `__repr__` is redacted, so the usual ways a value leaks into a log line
— `logger.info("%s", fields)`, an f-string, an exception carrying an argument —
all produce a placeholder instead. That is a property of the type rather than a
rule contributors have to remember.

What leaves this module is `DocumentCheck`: a status, a machine-readable reason,
and the model versions. `03-system-design.md` §8.3 and §40, the webhook
contract and `06-database-schema.md` all forbid anything more, and none of them
is being amended to accommodate this feature.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

from .determinism import bucket, validate_session_id
from .errors import ProviderUnavailable
from .frame import Frame

MOCK_DOCUMENT_OCR_VERSION = "demo-v1"
MOCK_DOCUMENT_VERIFIER_VERSION = "mock-v1"

_READ_DOMAIN = "document_read"
_VERIFY_DOMAIN = "document_verify"

#: Model-version keys, mirrored by hand in `packages/shared/src/api/document.ts`.
OCR_VERSION_KEY = "document_ocr"
VERIFIER_VERSION_KEY = "document_verifier"


class DocumentType(StrEnum):
    """Which document was asked for. Mirrors `DocumentType` in `@vcip/shared`."""

    AADHAAR = "AADHAAR"
    PAN = "PAN"


class DocumentCheckStatus(StrEnum):
    """The outcome that reaches the agent.

    Mirrors `DocumentCheckStatus` in `@vcip/shared`. `UNREADABLE` means the
    frames were read and held no usable document, so no registry was ever
    asked; `UNAVAILABLE` means the check could not run. The agent is told to do
    different things by each, which is why they are not one value.
    """

    VERIFIED = "VERIFIED"
    NOT_VERIFIED = "NOT_VERIFIED"
    UNREADABLE = "UNREADABLE"
    UNAVAILABLE = "UNAVAILABLE"


#: A reason is a short machine token, never prose and never a verifier's error
#: body -- that is where a document number would leak back in under another
#: name. The Control API's schema applies the same pattern; this is the check on
#: the side that actually knows the sensitive values.
_REASON = re.compile(r"[a-z][a-z0-9_]{0,63}")


def validate_reason(reason: str | None) -> str | None:
    if reason is None:
        return None
    if not _REASON.fullmatch(reason):
        raise ValueError(f"reason must be a short lower-case token, got {reason!r}")
    return reason


@dataclass(frozen=True, slots=True)
class DocumentFields:
    """What was read off the card. Never leaves this module.

    Held just long enough to be handed to a verifier. There is no accessor that
    formats it, no `asdict` in the call path, and the representation is
    redacted, so the value cannot reach a log, an exception message, or a
    traceback frame that gets rendered.

    `number` is the only required field because it is the only one every
    registry needs. `name` and `date_of_birth` are carried when the reader could
    make them out, because some verifiers match on them too.
    """

    document_type: DocumentType
    number: str
    name: str | None = None
    date_of_birth: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.number, str) or not self.number.strip():
            raise ValueError("number must be a non-empty str")

    def __repr__(self) -> str:
        # Deliberately not the dataclass default, which would print every field.
        # A redacted repr is what makes `logger.warning("read %s", fields)` safe
        # to write by accident -- and somebody eventually will.
        return f"DocumentFields(document_type={self.document_type.value}, <redacted>)"

    __str__ = __repr__


@dataclass(frozen=True, slots=True)
class DocumentCheck:
    """The result, and the whole of what may leave this service."""

    document_type: DocumentType
    status: DocumentCheckStatus
    reason: str | None = None
    ocr_version: str = MOCK_DOCUMENT_OCR_VERSION
    verifier_version: str = MOCK_DOCUMENT_VERIFIER_VERSION

    def __post_init__(self) -> None:
        validate_reason(self.reason)

    @property
    def model_versions(self) -> dict[str, str]:
        return {
            OCR_VERSION_KEY: self.ocr_version,
            VERIFIER_VERSION_KEY: self.verifier_version,
        }

    @classmethod
    def unreadable(cls, document_type: DocumentType, reason: str, **versions: str) -> DocumentCheck:
        return cls(
            document_type=document_type,
            status=DocumentCheckStatus.UNREADABLE,
            reason=reason,
            **versions,
        )

    @classmethod
    def unavailable(
        cls, document_type: DocumentType, reason: str, **versions: str
    ) -> DocumentCheck:
        return cls(
            document_type=document_type,
            status=DocumentCheckStatus.UNAVAILABLE,
            reason=reason,
            **versions,
        )


@runtime_checkable
class DocumentReader(Protocol):
    """Reads the fields off a document, given a burst of frames."""

    model_version: str

    async def read(
        self,
        *,
        session_id: str,
        document_type: DocumentType,
        frames: tuple[Frame, ...],
    ) -> DocumentFields | None:
        """Return what the card says, or `None` if it could not be read.

        A burst rather than a single frame, per §19: a handheld card on a
        compressed video stream is blurred or glared on most frames, and the
        reader's job includes picking the one it can use.

        `None` is an answer -- "there was no readable document here" -- not an
        error. Failures that mean the reader itself could not run raise
        `ProviderUnavailable`, the same split the other three providers use.
        """
        ...


@runtime_checkable
class DocumentVerifier(Protocol):
    """Checks read fields against the document's registry."""

    model_version: str

    async def verify(
        self,
        *,
        session_id: str,
        fields: DocumentFields,
    ) -> bool:
        """Whether the registry recognises this document.

        A bool, not a rich response. Whatever a real vendor returns -- a match
        score, a name-comparison breakdown, the registry's own copy of the
        holder's details -- stops here, because carrying it further would put
        document contents on the wire under a different name.

        Raises `ProviderUnavailable` when the registry could not be asked. That
        is not the same as a document it did not recognise, and the agent is
        shown a different thing for each.
        """
        ...


class MockDocumentReader:
    """A deterministic stand-in for a real document OCR engine.

    Derives its answer from the session id, like the other mocks, so a demo
    replays identically. It validates the frames it is given -- a reader that
    ignored them would let a broken capture path pass unnoticed -- but does not
    look at the pixels.
    """

    model_version = MOCK_DOCUMENT_OCR_VERSION

    def __init__(self, *, unreadable_rate: int = 15) -> None:
        self._unreadable_rate = unreadable_rate

    async def read(
        self,
        *,
        session_id: str,
        document_type: DocumentType,
        frames: tuple[Frame, ...],
    ) -> DocumentFields | None:
        validate_session_id(session_id)
        if not frames:
            # No burst at all means the capture path failed, not that the
            # customer held up nothing. The caller turns this into UNAVAILABLE.
            raise ProviderUnavailable("no frames were captured")

        if bucket(_READ_DOMAIN, session_id) < self._unreadable_rate:
            return None

        return DocumentFields(
            document_type=document_type,
            number=_mock_number(document_type, session_id),
            name="DEMO CUSTOMER",
            date_of_birth="1990-01-01",
        )


class MockDocumentVerifier:
    """A deterministic stand-in for a registry lookup.

    The seam a real vendor drops into. `verify` is the whole surface, so
    swapping this for an HTTP client that calls a KYC provider changes this
    class and nothing above it.
    """

    model_version = MOCK_DOCUMENT_VERIFIER_VERSION

    def __init__(self, *, verified_rate: int = 80) -> None:
        self._verified_rate = verified_rate

    async def verify(self, *, session_id: str, fields: DocumentFields) -> bool:
        validate_session_id(session_id)
        # The fields are accepted and deliberately not inspected: a mock that
        # branched on the number would be pretending to be a registry.
        return bucket(_VERIFY_DOMAIN, session_id) < self._verified_rate


def _mock_number(document_type: DocumentType, session_id: str) -> str:
    """A well-formed but obviously fake identifier.

    Correct in shape so the reader's output exercises the same validation a real
    one would, and plainly synthetic so a demo value can never be mistaken for a
    real person's document.
    """
    digits = f"{bucket(_READ_DOMAIN + ':n', session_id):04d}"
    if document_type is DocumentType.PAN:
        return f"DEMO{digits[0]}{digits[1:]}D"
    return f"0000 0000 {digits}"
