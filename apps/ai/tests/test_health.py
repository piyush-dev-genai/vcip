from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_reports_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200

    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai"
    assert isinstance(body["uptime_s"], int)
    assert body["timestamp"].endswith("Z")
