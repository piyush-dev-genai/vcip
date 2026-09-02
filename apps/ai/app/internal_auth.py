"""Internal service authentication on the AI side (D10).

    X-Internal-Token: <shared-secret>

The same credential and the same header the Control API's `InternalTokenGuard`
enforces, in the other direction. `/internal/*` is not routed publicly, but
"not routed publicly" is a deployment property and this is the check that does
not depend on one: the analyze endpoint hands a LiveKit join token to whoever
calls it, and an unauthenticated caller could point the analyzer at a room of
their choosing.

`compare_digest` rather than `==`, so a wrong token cannot be found one
character at a time.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, Request, status

INTERNAL_TOKEN_HEADER = "X-Internal-Token"


def verify_internal_token(
    request: Request,
    x_internal_token: str | None = Header(default=None),
) -> None:
    """FastAPI dependency: reject anything without the shared credential.

    The expected value is read from app state, where the lifespan put it, so a
    process that started without a token cannot serve this route at all — it
    fails at boot instead.
    """
    expected: str = request.app.state.config.internal_token

    if x_internal_token is None or not hmac.compare_digest(x_internal_token, expected):
        # No detail. Which half was wrong is not information a caller who
        # failed this check has any use for.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal credentials.",
        )
