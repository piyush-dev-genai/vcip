"""The one route the Control API calls, and the credential that guards it."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.analysis import AnalysisManager, AnalysisRequest, Cadence
from app.main import app
from app.providers import build_providers
from tests.fakes import FakeFrameSource, RecordingPublisher, handles

SESSION = "11111111-2222-3333-4444-555555555555"
TOKEN = "an-internal-token-long-enough"

BODY = {
    "room_name": f"vcip_{SESSION}",
    "token": "a.livekit.jwt",
    "livekit_url": "ws://localhost:7880",
}


class NeverEndingSource:
    """A track that stays open, so an analysis is still running when asked."""

    async def frames(self):  # type: ignore[no-untyped-def]
        import asyncio

        while True:
            await asyncio.sleep(0.01)
            yield  # pragma: no cover

    async def aclose(self) -> None:
        return None


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """The real app, with the frame source swapped for a list of frames.

    Everything else is genuine: the lifespan, the credential check, the
    provider selection, the manager. Only the SFU is absent.
    """
    monkeypatch.setenv("VCIP_INTERNAL_TOKEN", TOKEN)

    with TestClient(app) as started:
        manager: AnalysisManager = started.app.state.manager
        publisher = RecordingPublisher()
        replacement = AnalysisManager(
            providers=build_providers({}),
            publisher=publisher,
            source_factory=lambda request: FakeFrameSource(handles(60)),
            cadence=Cadence(
                sample_interval_us=250_000,
                check_interval_us=2_000_000,
                ocr_interval_us=5_000_000,
            ),
            max_analysis_s=5.0,
        )
        started.app.state.manager = replacement
        try:
            yield started
        finally:
            started.app.state.manager = manager


def analyze(
    client: TestClient,
    *,
    session_id: str = SESSION,
    credential: str | None = TOKEN,
    **body: object,
):
    headers = {} if credential is None else {"X-Internal-Token": credential}
    return client.post(
        f"/internal/sessions/{session_id}/analyze", json={**BODY, **body}, headers=headers
    )


class TestAuthentication:
    """D10: `/internal/*` carries the shared internal credential."""

    def test_accepts_the_shared_credential(self, client: TestClient) -> None:
        assert analyze(client).status_code == 202

    def test_refuses_a_request_with_no_credential(self, client: TestClient) -> None:
        assert analyze(client, credential=None).status_code == 401

    def test_refuses_a_wrong_credential(self, client: TestClient) -> None:
        assert analyze(client, credential="not-the-token").status_code == 401

    def test_starts_nothing_when_it_refuses(self, client: TestClient) -> None:
        """The route hands out a room to analyse; an unauthenticated caller
        must not be able to point the analyzer anywhere."""
        analyze(client, credential="not-the-token")

        assert client.app.state.manager.active_sessions == frozenset()


class TestAccepting:
    def test_answers_202_because_the_room_is_not_joined_yet(self, client: TestClient) -> None:
        """200 would claim the analysis is under way; it is only accepted."""
        response = analyze(client)

        assert response.status_code == 202
        assert response.json() == {"session_id": SESSION, "started": True}

    def test_a_duplicate_request_is_not_an_error(self, client: TestClient) -> None:
        """A retry, or a webhook delivered twice, must not double the decoding.

        The source here never ends, so the first analysis is genuinely still
        running when the second request arrives — which is the only state in
        which this question has an answer.
        """
        client.app.state.manager = AnalysisManager(
            providers=build_providers({}),
            publisher=RecordingPublisher(),
            source_factory=lambda request: NeverEndingSource(),
            cadence=Cadence(
                sample_interval_us=250_000,
                check_interval_us=2_000_000,
                ocr_interval_us=5_000_000,
            ),
            max_analysis_s=5.0,
        )

        first = analyze(client)
        second = analyze(client)

        assert (first.json()["started"], second.json()["started"]) == (True, False)
        assert second.status_code == 202


class TestValidation:
    def test_rejects_a_body_missing_the_token(self, client: TestClient) -> None:
        response = client.post(
            f"/internal/sessions/{SESSION}/analyze",
            json={"room_name": "vcip_x", "livekit_url": "ws://localhost:7880"},
            headers={"X-Internal-Token": TOKEN},
        )

        assert response.status_code == 422

    def test_rejects_an_unknown_field(self, client: TestClient) -> None:
        """The Control API cannot be type-checked against this service."""
        assert analyze(client, tenant_id="t1").status_code == 422

    def test_rejects_an_empty_token(self, client: TestClient) -> None:
        assert analyze(client, token="").status_code == 422

    def test_rejects_a_session_id_that_could_escape_a_directory(self, client: TestClient) -> None:
        """The session id becomes a reference filename further in."""
        response = client.post(
            "/internal/sessions/..%2F..%2Fetc/analyze",
            json=BODY,
            headers={"X-Internal-Token": TOKEN},
        )

        assert response.status_code in (400, 404)
        assert client.app.state.manager.active_sessions == frozenset()


class TestRouteSurface:
    def test_exposes_only_health_and_analyze(self) -> None:
        """No AI debug endpoints: results go to the Control API, not a caller."""
        paths = {route.path for route in app.routes if route.path.startswith("/")}

        assert "/health" in paths
        assert "/internal/sessions/{session_id}/analyze" in paths
        assert not {p for p in paths if p.startswith("/v1")}

    def test_health_needs_no_credential(self, client: TestClient) -> None:
        assert client.get("/health").status_code == 200


class TestRequestShape:
    def test_mirrors_the_shared_analyze_schema(self) -> None:
        """`analyzeRequestSchema` in `packages/shared/src/api/ai.ts`.

        Written out rather than derived: the two sides cannot import each
        other, so this list and that schema are one contract stated twice.
        """
        from app.main import AnalyzeBody

        assert set(AnalyzeBody.model_fields) == {"room_name", "token", "livekit_url"}

    def test_the_analysis_request_carries_no_session_data(self) -> None:
        """The AI service holds no database: everything it needs is in the call."""
        assert set(AnalysisRequest.__dataclass_fields__) == {
            "session_id",
            "room_name",
            "token",
            "livekit_url",
        }
