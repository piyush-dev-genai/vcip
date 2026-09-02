"""V-CIP AI service.

AI is assistive and sits off the video critical path. This service never
decides a verdict and holds no PostgreSQL or Redis credentials: results are
published to the Control API via /internal/ai/result, which owns the Redis HUD.

Two routes, and both of them are the minimum:

    GET  /health
    POST /internal/sessions/{session_id}/analyze

The second is how a call reaches this service at all. The Control API calls it
when both participants are in the room — the `CALL_STARTED` moment that also
starts the evidence recording — handing over the room name and a subscribe-only
LiveKit token it minted. This service holds no LiveKit signing credentials and
chooses no sessions of its own.

See docs/00-decisions.md D6, D10, D23.
"""

import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, HTTPException, status
from pydantic import BaseModel, Field

from .analysis import AnalysisManager, AnalysisRequest, Cadence, HttpResultPublisher
from .analysis.livekit_source import LiveKitFrameSource
from .config import AnalyzerConfig, analyzer_config_from_env
from .internal_auth import verify_internal_token
from .providers import ProviderSet, build_providers
from .providers.determinism import validate_session_id

SERVICE_NAME = "ai"
VERSION = "0.0.0"
_STARTED_AT = time.monotonic()

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "info").upper())


class AnalyzeBody(BaseModel):
    """`POST /internal/sessions/{session_id}/analyze`.

    Mirrors `analyzeRequestSchema` in `packages/shared/src/api/ai.ts`. This
    service is outside the TypeScript build graph, so the two are one contract
    written twice; `test_analyze_endpoint.py` pins these field names against it.

    `extra='forbid'` for the same reason the zod schema is strict: a Control API
    that starts sending a field this service silently drops is a bug nobody
    would see until a demo.
    """

    model_config = {"extra": "forbid"}

    room_name: str = Field(min_length=1, max_length=128)
    token: str = Field(min_length=1)
    livekit_url: str = Field(min_length=1)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Build the provider set, the publisher and the manager once, at startup.

    Here rather than per call for three reasons. A misconfigured
    AI_PROVIDER_MODE or a missing internal token should stop the process at
    boot, while somebody is watching, instead of surfacing as a failed check
    during a live call. The reference store caches what it reads. And the
    publisher holds a connection pool that would be pointless to rebuild for
    every result.
    """
    config = analyzer_config_from_env()
    providers = build_providers()
    publisher = HttpResultPublisher(
        base_url=config.control_api_url,
        internal_token=config.internal_token,
        timeout_s=config.publish_timeout_s,
    )

    app.state.config = config
    app.state.providers = providers
    app.state.manager = AnalysisManager(
        providers=providers,
        publisher=publisher,
        source_factory=lambda request: LiveKitFrameSource(
            url=request.livekit_url,
            token=request.token,
            room_name=request.room_name,
            track_timeout_s=config.track_timeout_s,
        ),
        cadence=Cadence(
            sample_interval_us=config.sample_interval_us,
            check_interval_us=config.check_interval_us,
            ocr_interval_us=config.ocr_interval_us,
        ),
        max_analysis_s=config.max_analysis_s,
    )

    try:
        yield
    finally:
        # Every analysis is a room join and a decode loop. Leaving them running
        # past shutdown would hold connections to rooms nobody is watching.
        await app.state.manager.shutdown()


app = FastAPI(title="V-CIP AI Service", version=VERSION, lifespan=lifespan)


def providers(app: FastAPI) -> ProviderSet:
    """The provider set chosen at startup."""
    return app.state.providers


def manager(app: FastAPI) -> AnalysisManager:
    """The analysis manager built at startup."""
    return app.state.manager


def config(app: FastAPI) -> AnalyzerConfig:
    """The analyzer configuration read at startup."""
    return app.state.config


@app.get("/health")
def health() -> dict[str, object]:
    """Liveness probe.

    Reports that the process is up. It performs no dependency checks: the
    providers are in-process and a check that only proves a mock answers is
    not a check.
    """
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": os.environ.get("AI_VERSION", VERSION),
        "uptime_s": round(time.monotonic() - _STARTED_AT),
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }


@app.post(
    "/internal/sessions/{session_id}/analyze",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(verify_internal_token)],
)
async def analyze(session_id: str, body: AnalyzeBody) -> dict[str, object]:
    """Begin analysing one call.

    202, not 200: the room has not been joined when this returns. The caller is
    the Control API on the path that starts a call, and making it wait for a
    LiveKit round trip would put AI on the video critical path by the back door
    (D6). A duplicate request is not an error — it reports `started: false` and
    leaves the running analysis alone.
    """
    try:
        # The same rule the providers enforce, applied at the edge instead of
        # four layers in. `LocalReferenceStore` builds a filename from this
        # value, so a session id is validated before it is used, not after.
        validate_session_id(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None

    started = manager(app).start(
        AnalysisRequest(
            session_id=session_id,
            room_name=body.room_name,
            token=body.token,
            livekit_url=body.livekit_url,
        )
    )

    return {"session_id": started.session_id, "started": started.started}
