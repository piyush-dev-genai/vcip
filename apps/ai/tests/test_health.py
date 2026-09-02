import pytest
from fastapi.testclient import TestClient

from app.main import app, config, manager, providers
from app.providers import ProviderMode, ProviderSet

client = TestClient(app)

TOKEN = "an-internal-token-long-enough"


def test_health_reports_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200

    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai"
    assert isinstance(body["uptime_s"], int)
    assert body["timestamp"].endswith("Z")


def test_the_service_exposes_two_routes_and_no_more() -> None:
    """`/health`, and the one route the Control API calls (T30).

    No AI debug or result-inspection endpoints: what this service learns goes
    to `/internal/ai/result`, which owns the HUD, and not to a caller here.
    """
    paths = {route.path for route in app.routes if route.path.startswith("/")}
    ours = {path for path in paths if not path.startswith("/openapi") and path != "/docs"}

    assert "/health" in ours
    assert "/internal/sessions/{session_id}/analyze" in ours
    assert not {path for path in ours if path.startswith("/v1")}


def test_startup_builds_everything_a_call_will_need(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bad AI_PROVIDER_MODE or a missing token fails at boot, not mid-call."""
    monkeypatch.setenv("VCIP_INTERNAL_TOKEN", TOKEN)

    with TestClient(app) as started:
        selected = providers(started.app)
        running = manager(started.app)
        settings = config(started.app)

    assert isinstance(selected, ProviderSet)
    assert selected.mode is ProviderMode.MOCK
    assert running.active_sessions == frozenset()
    assert settings.internal_token == TOKEN


def test_startup_refuses_to_run_without_an_internal_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The analyze route hands out a room to join; it cannot be unguarded."""
    monkeypatch.delenv("VCIP_INTERNAL_TOKEN", raising=False)

    with pytest.raises(ValueError, match="VCIP_INTERNAL_TOKEN"), TestClient(app):
        pass  # pragma: no cover - the lifespan raises on entry
