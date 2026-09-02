from fastapi.testclient import TestClient

from app.main import app, providers
from app.providers import ProviderMode, ProviderSet

client = TestClient(app)


def test_health_reports_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200

    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai"
    assert isinstance(body["uptime_s"], int)
    assert body["timestamp"].endswith("Z")


def test_health_is_the_only_route() -> None:
    """T29 adds no AI endpoints; results reach the Control API, not a caller here."""
    paths = {route.path for route in app.routes if route.path.startswith("/")}

    assert "/health" in paths
    assert not {path for path in paths if path.startswith("/internal") or path.startswith("/v1")}


def test_providers_are_selected_at_startup() -> None:
    """A bad AI_PROVIDER_MODE fails at boot, not during someone's call."""
    with TestClient(app) as started:
        selected = providers(started.app)

    assert isinstance(selected, ProviderSet)
    assert selected.mode is ProviderMode.MOCK
