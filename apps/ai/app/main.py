"""V-CIP AI service.

AI is assistive and sits off the video critical path. This service never
decides a verdict and holds no PostgreSQL or Redis credentials: results are
published to the Control API via /internal/ai/result, which owns the Redis HUD.

See docs/00-decisions.md D6 and D10.
"""

import os
import time
from datetime import UTC, datetime

from fastapi import FastAPI

SERVICE_NAME = "ai"
VERSION = "0.0.0"
_STARTED_AT = time.monotonic()

app = FastAPI(title="V-CIP AI Service", version=VERSION)


@app.get("/health")
def health() -> dict[str, object]:
    """Liveness probe.

    Reports that the process is up. It performs no dependency checks: the
    provider implementations arrive in a later task.
    """
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": os.environ.get("AI_VERSION", VERSION),
        "uptime_s": round(time.monotonic() - _STARTED_AT),
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
