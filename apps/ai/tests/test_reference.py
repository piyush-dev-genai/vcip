"""The face-match reference seam (R6)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.providers import (
    DEFAULT_REFERENCE_DIR,
    EmptyReferenceStore,
    LocalReferenceStore,
    Reference,
    ReferenceStore,
    ReferenceUnavailable,
)
from tests.helpers import run

SESSION = "11111111-2222-3333-4444-555555555555"


def test_local_store_satisfies_the_interface() -> None:
    assert isinstance(LocalReferenceStore(DEFAULT_REFERENCE_DIR), ReferenceStore)
    assert isinstance(EmptyReferenceStore(), ReferenceStore)


class TestBundledReference:
    """R6: the service ships its own demo reference, and no intake API."""

    def test_the_shipped_default_loads(self) -> None:
        reference = run(LocalReferenceStore(DEFAULT_REFERENCE_DIR).load(session_id=SESSION))

        assert reference.source == "default.ppm"
        assert reference.data.startswith(b"P3")

    def test_it_is_not_a_photograph_of_a_person(self) -> None:
        """A committed face would be a privacy problem the MVP does not need."""
        text = (DEFAULT_REFERENCE_DIR / "default.ppm").read_text(encoding="ascii")

        assert "synthetic" in text


class TestLocalReferenceStore:
    def test_falls_back_to_the_default_for_any_session(self, tmp_path: Path) -> None:
        (tmp_path / "default.ppm").write_bytes(b"P3 default")

        reference = run(LocalReferenceStore(tmp_path).load(session_id=SESSION))

        assert reference.data == b"P3 default"

    def test_a_session_specific_reference_wins(self, tmp_path: Path) -> None:
        (tmp_path / "default.ppm").write_bytes(b"P3 default")
        (tmp_path / f"{SESSION}.ppm").write_bytes(b"P3 pinned")

        reference = run(LocalReferenceStore(tmp_path).load(session_id=SESSION))

        assert reference.data == b"P3 pinned"
        assert reference.source == f"{SESSION}.ppm"

    def test_nothing_on_disk_is_unavailable_not_a_crash(self, tmp_path: Path) -> None:
        with pytest.raises(ReferenceUnavailable) as caught:
            run(LocalReferenceStore(tmp_path).load(session_id=SESSION))

        assert "no reference" in str(caught.value)

    def test_an_empty_file_is_unavailable(self, tmp_path: Path) -> None:
        (tmp_path / "default.ppm").write_bytes(b"")

        with pytest.raises(ReferenceUnavailable, match="is empty"):
            run(LocalReferenceStore(tmp_path).load(session_id=SESSION))

    def test_reads_a_file_once_and_serves_the_bytes_from_memory(self, tmp_path: Path) -> None:
        """Face match runs several times a call; re-reading would block the loop."""
        path = tmp_path / "default.ppm"
        path.write_bytes(b"P3 default")
        store = LocalReferenceStore(tmp_path)

        first = run(store.load(session_id=SESSION))
        path.write_bytes(b"P3 rewritten underneath us")
        second = run(store.load(session_id=SESSION))

        assert first is second

    def test_the_cache_is_shared_between_sessions(self, tmp_path: Path) -> None:
        """Keyed by filename, so it is bounded by the references on disk rather
        than by how many sessions the service has ever handled."""
        path = tmp_path / "default.ppm"
        path.write_bytes(b"P3 default")
        store = LocalReferenceStore(tmp_path)

        first = run(store.load(session_id=SESSION))
        path.write_bytes(b"P3 rewritten underneath us")
        second = run(store.load(session_id="22222222-3333-4444-5555-666666666666"))

        assert first is second

    def test_a_reference_pinned_mid_run_is_picked_up(self, tmp_path: Path) -> None:
        """What the per-call existence check buys: a demo pins a face without a restart."""
        (tmp_path / "default.ppm").write_bytes(b"P3 default")
        store = LocalReferenceStore(tmp_path)
        assert run(store.load(session_id=SESSION)).source == "default.ppm"

        (tmp_path / f"{SESSION}.ppm").write_bytes(b"P3 pinned")

        assert run(store.load(session_id=SESSION)).source == f"{SESSION}.ppm"

    def test_refuses_a_session_id_that_escapes_the_directory(self, tmp_path: Path) -> None:
        """The session id becomes a filename; traversal is a file-read primitive."""
        with pytest.raises(ValueError, match="session_id must be"):
            run(LocalReferenceStore(tmp_path).load(session_id="../../../etc/passwd"))

    def test_refuses_an_empty_session_id(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="session_id must be"):
            run(LocalReferenceStore(tmp_path).load(session_id=""))


class TestEmptyReferenceStore:
    def test_always_reports_unavailable(self) -> None:
        with pytest.raises(ReferenceUnavailable, match="disabled"):
            run(EmptyReferenceStore().load(session_id=SESSION))


class TestReference:
    def test_rejects_empty_data(self) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            Reference(data=b"", source="default.ppm")

    def test_rejects_a_nameless_source(self) -> None:
        with pytest.raises(ValueError, match="source"):
            Reference(data=b"P3", source="  ")
