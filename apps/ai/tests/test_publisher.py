"""The result payload, and delivering it to the Control API."""

from __future__ import annotations

import json

import httpx
import pytest

from app.analysis import PublishError, result_payload
from app.analysis.http_publisher import INTERNAL_TOKEN_HEADER, RESULT_PATH, HttpResultPublisher
from app.providers import (
    FaceMatchResult,
    FaceMatchStatus,
    LivenessResult,
    LivenessStatus,
    OcrResult,
    OcrStatus,
)
from tests.helpers import run

SESSION = "11111111-2222-3333-4444-555555555555"
TOKEN = "an-internal-token-long-enough"

LIVE = LivenessResult(status=LivenessStatus.LIVE, score=97, model_version="demo-v1")
MATCH = FaceMatchResult(status=FaceMatchStatus.MATCH, score=95, model_version="demo-v1")
READ = OcrResult(status=OcrStatus.PASS, model_version="demo-v1")


class TestPayload:
    def test_is_the_contract_body(self) -> None:
        """`05-api-contract.md` §23, plus the model versions §19 stores."""
        assert result_payload(SESSION, LIVE, MATCH, READ) == {
            "session_id": SESSION,
            "liveness_score": 97,
            "liveness_status": "LIVE",
            "face_match_score": 95,
            "ocr_status": "PASS",
            "model_versions": {"liveness": "demo-v1", "face_match": "demo-v1", "ocr": "demo-v1"},
        }

    def test_serialises_without_a_custom_encoder(self) -> None:
        encoded = json.dumps(result_payload(SESSION, LIVE, MATCH, READ))

        assert '"liveness_status": "LIVE"' in encoded

    def test_carries_no_face_match_status(self) -> None:
        """The wire gives face match a score and no status column."""
        assert "face_match_status" not in result_payload(SESSION, LIVE, MATCH, READ)

    def test_an_absent_score_is_null_not_zero(self) -> None:
        """Zero is a confident failure; null is no answer. The HUD shows both."""
        payload = result_payload(
            SESSION,
            LivenessResult.unavailable("demo-v1", "model down"),
            FaceMatchResult.unavailable("demo-v1", "no reference"),
            OcrResult.unavailable("demo-v1", "engine down"),
        )

        assert payload["liveness_score"] is None
        assert payload["face_match_score"] is None
        assert payload["liveness_status"] == "UNAVAILABLE"

    def test_carries_no_diagnostic_reason(self) -> None:
        """`reason` is for our logs. It is not a field the contract has."""
        payload = result_payload(
            SESSION, LivenessResult.unavailable("demo-v1", "model down"), MATCH, READ
        )

        assert "reason" not in payload
        assert "model down" not in json.dumps(payload)


class TestHttpPublisher:
    def publisher(self, handler: object) -> HttpResultPublisher:
        published = HttpResultPublisher(
            base_url="http://api.test", internal_token=TOKEN, timeout_s=1.0
        )
        published._client = httpx.AsyncClient(  # type: ignore[attr-defined]
            transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )
        return published

    def test_posts_to_the_internal_result_path(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200)

        publisher = self.publisher(handler)
        run(publisher.publish({"session_id": SESSION}))

        assert seen[0].url.path == RESULT_PATH
        assert seen[0].method == "POST"

    def test_presents_the_internal_credential(self) -> None:
        """D10: `/internal/*` is authenticated in both directions."""
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200)

        run(self.publisher(handler).publish({"session_id": SESSION}))

        assert seen[0].headers[INTERNAL_TOKEN_HEADER] == TOKEN

    def test_sends_the_payload_as_json(self) -> None:
        seen: list[bytes] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.content)
            return httpx.Response(200)

        run(self.publisher(handler).publish(result_payload(SESSION, LIVE, MATCH, READ)))

        assert json.loads(seen[0])["liveness_status"] == "LIVE"

    @pytest.mark.parametrize("status", [400, 401, 422, 500])
    def test_a_refusal_becomes_a_publish_error(self, status: int) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(status, json={"echoed": "the payload"})

        with pytest.raises(PublishError, match=str(status)):
            run(self.publisher(handler).publish({"session_id": SESSION}))

    def test_a_refusal_does_not_quote_the_response_body(self) -> None:
        """A strict schema quotes the payload back, and the payload is about
        a customer's verification."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(422, json={"detail": "liveness_score: 97"})

        with pytest.raises(PublishError) as caught:
            run(self.publisher(handler).publish({"session_id": SESSION}))

        assert "97" not in str(caught.value)

    def test_an_unreachable_api_becomes_a_publish_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        with pytest.raises(PublishError, match="could not reach"):
            run(self.publisher(handler).publish({"session_id": SESSION}))

    def test_a_transport_failure_does_not_leak_the_request(self) -> None:
        """An httpx error stringifies with the request, which carries the token."""

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        with pytest.raises(PublishError) as caught:
            run(self.publisher(handler).publish({"session_id": SESSION}))

        assert TOKEN not in str(caught.value)

    def test_builds_the_url_without_a_double_slash(self) -> None:
        publisher = HttpResultPublisher(
            base_url="http://api.test/", internal_token=TOKEN, timeout_s=1.0
        )

        assert publisher._url == f"http://api.test{RESULT_PATH}"  # type: ignore[attr-defined]
        run(publisher.aclose())
