"""The results assemble into what T30 has to send.

T29 claims its types are compatible with `liveness_score`, `liveness_status`,
`face_match_score`, `ocr_status` and `model_versions`. That claim is only worth
something if somebody builds the payload, so these tests do — healthy and
degraded — and check the result against `05-api-contract.md` §23 and
`06-database-schema.md` §19.

Assembling the payload is T30's job and no production code here does it. This
is the compatibility check, not the implementation.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.providers import (
    FaceMatchResult,
    FaceMatchStatus,
    LivenessStatus,
    OcrStatus,
    ProviderSet,
    ReferenceUnavailable,
    build_providers,
)
from tests.helpers import frame, frames, run

SESSION = "11111111-2222-3333-4444-555555555555"

CONTRACT_FIELDS = {
    "session_id",
    "liveness_score",
    "liveness_status",
    "face_match_score",
    "ocr_status",
}


def ai_result(providers: ProviderSet, session_id: str) -> dict[str, object]:
    """Run the three checks and shape them the way T30 will."""
    liveness = run(providers.liveness.analyze(session_id=session_id, frames=frames()))

    try:
        reference = run(providers.references.load(session_id=session_id))
    except ReferenceUnavailable as exc:
        face_match = FaceMatchResult.unavailable(providers.face_match.model_version, exc.reason)
    else:
        face_match = run(
            providers.face_match.compare(session_id=session_id, frame=frame(), reference=reference)
        )

    ocr = run(providers.ocr.extract(session_id=session_id, frame=frame()))

    return {
        "session_id": session_id,
        "liveness_score": liveness.score,
        "liveness_status": liveness.status,
        "face_match_score": face_match.score,
        "ocr_status": ocr.status,
    }


class TestHealthyPayload:
    def test_carries_exactly_the_contract_fields(self) -> None:
        assert set(ai_result(build_providers({}), SESSION)) == CONTRACT_FIELDS

    def test_survives_json_encoding_with_plain_values(self) -> None:
        """The statuses are `StrEnum`, so they serialise as the bare strings."""
        encoded = json.loads(json.dumps(ai_result(build_providers({}), SESSION)))

        assert encoded["liveness_status"] == "LIVE"
        assert encoded["ocr_status"] == "PASS"
        assert encoded["liveness_score"] == 96
        assert encoded["face_match_score"] == 86

    def test_scores_are_integers_the_summary_column_can_hold(self) -> None:
        payload = ai_result(build_providers({}), SESSION)

        for key in ("liveness_score", "face_match_score"):
            assert isinstance(payload[key], int)
            assert 0 <= payload[key] <= 100  # type: ignore[operator]

    def test_model_versions_are_the_shape_the_summary_stores(self) -> None:
        """`06-database-schema.md` §19: {"liveness": "demo-v1", ...}."""
        versions = build_providers({}).model_versions()

        assert json.loads(json.dumps(versions)) == {
            "liveness": "demo-v1",
            "face_match": "demo-v1",
            "ocr": "demo-v1",
        }


class TestDegradedPayload:
    def test_is_still_a_well_formed_payload(self) -> None:
        """AI unavailability degrades the HUD; it does not stop the report (D6)."""
        payload = ai_result(build_providers({"AI_PROVIDER_MODE": "unavailable"}), SESSION)

        assert set(payload) == CONTRACT_FIELDS
        assert json.loads(json.dumps(payload))["liveness_status"] == "UNAVAILABLE"

    def test_missing_scores_are_null_rather_than_zero(self) -> None:
        """A zero would render on the HUD as a confident failed check."""
        payload = ai_result(build_providers({"AI_PROVIDER_MODE": "unavailable"}), SESSION)

        assert payload["liveness_score"] is None
        assert payload["face_match_score"] is None

    def test_a_missing_reference_alone_degrades_only_face_match(self, tmp_path: Path) -> None:
        """The other two checks have no reference to miss and must still report."""
        providers = build_providers({"AI_REFERENCE_DIR": str(tmp_path)})

        payload = ai_result(providers, SESSION)

        assert payload["face_match_score"] is None
        assert payload["liveness_status"] is LivenessStatus.LIVE
        assert payload["ocr_status"] is OcrStatus.PASS

    def test_face_match_unavailability_names_the_missing_reference(self, tmp_path: Path) -> None:
        providers = build_providers({"AI_REFERENCE_DIR": str(tmp_path)})

        with pytest.raises(ReferenceUnavailable) as caught:
            run(providers.references.load(session_id=SESSION))
        result = FaceMatchResult.unavailable(
            providers.face_match.model_version, caught.value.reason
        )

        assert result.status is FaceMatchStatus.UNAVAILABLE
        assert "no reference" in str(result.reason)
        assert result.model_version == "demo-v1"
