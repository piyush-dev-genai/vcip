"""V-CIP AI service.

AI is assistive and sits off the video critical path. This service never
decides a verdict and holds no PostgreSQL or Redis credentials: results are
published to the Control API via /internal/ai/result, which owns the Redis HUD.

See docs/00-decisions.md D6 and D10.
"""

import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI

from .providers import ProviderSet, build_providers

SERVICE_NAME = "ai"
VERSION = "0.0.0"
_STARTED_AT = time.monotonic()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Select the providers once, at startup.

    Here rather than per call for two reasons. A misconfigured
    AI_PROVIDER_MODE should stop the process at boot, while somebody is
    watching, instead of surfacing as a failed check during a live call. And
    the reference store caches what it reads, which is worth nothing if the
    set is rebuilt for every frame.
    """
    app.state.providers = build_providers()
    yield


app = FastAPI(title="V-CIP AI Service", version=VERSION, lifespan=lifespan)


def providers(app: FastAPI) -> ProviderSet:
    """The provider set chosen at startup."""
    return app.state.providers


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
