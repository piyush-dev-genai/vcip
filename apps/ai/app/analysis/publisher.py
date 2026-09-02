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

from app.providers import FaceMatchResult, LivenessResult, OcrResult

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

    async def aclose(self) -> None:
        return None
