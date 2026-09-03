"""Delivering a result to the Control API (T30).

```text
apps/ai --POST /internal/ai/result--> apps/api --T31--> Redis HUD --> WS
```

The payload mirrors `packages/shared/src/api/ai.ts` by hand. The Python service
is outside the TypeScript build graph (`05-development-plan.md` §4), so nothing
checks these two agree except a test on each side that writes the field names
out literally.

Publishing never raises into the analysis loop. A HUD update that could stop a
call from being analysed would put AI back on the video critical path, which is
the one thing D6 forbids.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.providers import DocumentCheck, FaceMatchResult, LivenessResult, OcrResult

#: The `model_versions` keys, from `06-database-schema.md` §19.
LIVENESS_KEY = "liveness"
FACE_MATCH_KEY = "face_match"
OCR_KEY = "ocr"


def result_payload(
    session_id: str,
    liveness: LivenessResult,
    face_match: FaceMatchResult,
    ocr: OcrResult,
) -> dict[str, object]:
    """Build the `/internal/ai/result` body.

    The face-match status does not travel. `05-api-contract.md` §23 and
    `06-database-schema.md` §19 both give face match a score and no status
    column, so the distinction between "the model said 43" and "the model never
    ran" is carried by the score being `null` — which is why a scoreless result
    must never be flattened to zero on the way out.
    """
    return {
        "session_id": session_id,
        "liveness_score": liveness.score,
        "liveness_status": liveness.status.value,
        "face_match_score": face_match.score,
        "ocr_status": ocr.status.value,
        "model_versions": {
            LIVENESS_KEY: liveness.model_version,
            FACE_MATCH_KEY: face_match.model_version,
            OCR_KEY: ocr.model_version,
        },
    }


def document_payload(session_id: str, check: DocumentCheck) -> dict[str, object]:
    """Build the `/internal/ai/document-result` body.

    Mirrors `packages/shared/src/api/document.ts` by hand, like `result_payload`
    above, and carries exactly what that strict schema accepts: the session, the
    document type, a status, a machine-readable reason and the model versions.

    There is no branch here that could add a field. What the check knows about
    the document's contents was dropped before this function was reachable —
    `DocumentCheck` has no field for it — so this cannot serialise a number even
    if somebody later asks it to.
    """
    return {
        "session_id": session_id,
        "document_type": check.document_type.value,
        "status": check.status.value,
        "reason": check.reason,
        "model_versions": check.model_versions,
    }


class PublishError(Exception):
    """The result did not reach the Control API.

    Expected: the API restarts, the network blips, the HUD misses one update
    and gets the next one two seconds later. The loop logs it and carries on.
    """


@runtime_checkable
class ResultPublisher(Protocol):
    """Where an analysis sends what it found."""

    async def publish(self, payload: dict[str, object]) -> None:
        """Deliver one result.

        Raises:
            PublishError: Delivery failed. The caller continues analysing.
        """
        ...

    async def publish_document(self, payload: dict[str, object]) -> None:
        """Deliver one document-check result.

        A separate route from `publish` rather than a flag on it, because the
        two update different parts of the HUD and one must never overwrite the
        other: the continuous result arrives every couple of seconds and would
        otherwise blank a document status the agent asked for once.

        Raises:
            PublishError: Delivery failed. Unlike a sampled result, there is no
                next one along in two seconds -- the agent pressed a button and
                is waiting -- so the caller reports the failure rather than
                letting it pass quietly.
        """
        ...

    async def aclose(self) -> None:
        """Release the connection pool."""
        ...


class NullResultPublisher:
    """Accepts results and drops them.

    For tests, and for running the analyzer against a room with no Control API
    to talk to.
    """

    async def publish(self, payload: dict[str, object]) -> None:
        return None

    async def publish_document(self, payload: dict[str, object]) -> None:
        return None

    async def aclose(self) -> None:
        return None
