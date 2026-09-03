"""The HTTP implementation of `ResultPublisher` (T30).

Separated from `publisher.py` so that `httpx` is imported by exactly one module
in this package, and every other part of the analysis path can be tested — and
reasoned about — without a network stack. The isolation test asserts that.

D10: `/internal/*` carries the shared internal credential. This is the only
place the AI service presents one.
"""

from __future__ import annotations

import httpx

from .publisher import PublishError

RESULT_PATH = "/internal/ai/result"
DOCUMENT_RESULT_PATH = "/internal/ai/document-result"
INTERNAL_TOKEN_HEADER = "X-Internal-Token"


class HttpResultPublisher:
    """Posts results to the Control API over one reused connection pool."""

    def __init__(self, base_url: str, internal_token: str, timeout_s: float) -> None:
        self._url = base_url.rstrip("/") + RESULT_PATH
        self._document_url = base_url.rstrip("/") + DOCUMENT_RESULT_PATH
        self._client = httpx.AsyncClient(
            timeout=timeout_s,
            headers={INTERNAL_TOKEN_HEADER: internal_token},
        )

    async def publish(self, payload: dict[str, object]) -> None:
        await self._post(self._url, payload)

    async def publish_document(self, payload: dict[str, object]) -> None:
        await self._post(self._document_url, payload)

    async def _post(self, url: str, payload: dict[str, object]) -> None:
        """One POST, with the two failures that must never quote the request.

        Shared by both routes because the discipline below matters more on the
        document route than on the sampled one, and a second copy is a second
        place for it to be forgotten.
        """
        try:
            response = await self._client.post(url, json=payload)
        except httpx.HTTPError as exc:
            # The message, not the exception: an httpx error stringifies with
            # the request it failed on, and this request carries the internal
            # credential in a header.
            raise PublishError(f"could not reach the Control API: {type(exc).__name__}") from None

        if response.status_code >= 400:
            # No body. A 4xx from a strict schema quotes the payload back, and
            # the payload is about a customer's verification.
            raise PublishError(f"the Control API answered {response.status_code}")

    async def aclose(self) -> None:
        await self._client.aclose()
