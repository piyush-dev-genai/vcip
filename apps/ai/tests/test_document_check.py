"""The triggered document check (§19).

Three groups, and the middle one is the reason this file matters more than its
size suggests.

`TestOutcomes` pins the four statuses to the four things that can happen, and
in particular keeps `UNREADABLE` and `UNAVAILABLE` apart: the agent is told to
do different things by each, so collapsing them would be a real regression that
no type would catch.

`TestNothingLeaks` is the feature's central promise. The document number, the
name and the date of birth are read, used, and dropped — nothing returns them,
nothing publishes them, and nothing can log them by accident. Each of those is
asserted rather than trusted, because "we were careful" is not a property and
the next person to touch this will not have read the design.

`TestTriggering` covers reaching a live analysis, and the ordinary case of
there not being one.
"""

from __future__ import annotations

import logging
from dataclasses import replace

import pytest

from app.analysis import AnalysisManager, AnalysisRequest, Cadence, NoAnalysisRunning
from app.analysis.document import check_document
from app.providers import (
    DocumentCheckStatus,
    DocumentFields,
    DocumentType,
    MockDocumentReader,
    MockDocumentVerifier,
    ProviderUnavailable,
    UnavailableDocumentReader,
    UnavailableDocumentVerifier,
    build_providers,
)
from tests.fakes import RecordingPublisher, handles
from tests.helpers import run

SESSION = "11111111-2222-3333-4444-555555555555"
OTHER = "22222222-3333-4444-5555-666666666666"

CADENCE = Cadence(
    sample_interval_us=250_000, check_interval_us=2_000_000, ocr_interval_us=5_000_000
)

#: The synthetic values the mock reader produces. Named here so the leak tests
#: can look for them without reproducing the reader's formatting rules.
SECRETS = ("DEMO", "0000", "DEMO CUSTOMER", "1990-01-01")


def frames(count: int = 4):
    return tuple(handle.decode() for handle in handles(count))


class StubReader:
    """A reader whose answer the test chooses."""

    model_version = "stub-v1"

    def __init__(self, answer: DocumentFields | None | BaseException) -> None:
        self.answer = answer
        self.calls = 0

    async def read(self, *, session_id, document_type, frames):  # noqa: ANN001, ANN201
        self.calls += 1
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


class StubVerifier:
    """A verifier whose answer the test chooses, recording what it was given."""

    model_version = "stub-v1"

    def __init__(self, answer: bool | BaseException) -> None:
        self.answer = answer
        self.seen: list[DocumentFields] = []

    async def verify(self, *, session_id, fields):  # noqa: ANN001, ANN201
        self.seen.append(fields)
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


PAN = DocumentFields(document_type=DocumentType.PAN, number="ABCDE1234F", name="A Customer")


def check(reader: object, verifier: object):  # noqa: ANN201
    return run(
        check_document(
            session_id=SESSION,
            document_type=DocumentType.PAN,
            frames=frames(),
            reader=reader,  # type: ignore[arg-type]
            verifier=verifier,  # type: ignore[arg-type]
        )
    )


class TestOutcomes:
    def test_a_recognised_document_is_verified(self) -> None:
        result = check(StubReader(PAN), StubVerifier(True))

        assert result.status is DocumentCheckStatus.VERIFIED
        assert result.reason is None

    def test_a_document_the_registry_rejects_is_not_verified(self) -> None:
        result = check(StubReader(PAN), StubVerifier(False))

        assert result.status is DocumentCheckStatus.NOT_VERIFIED
        assert result.reason == "registry_did_not_recognise"

    def test_nothing_readable_is_unreadable_not_a_failure(self) -> None:
        """The customer held up nothing usable. Their next move is to try again."""
        verifier = StubVerifier(True)

        result = check(StubReader(None), verifier)

        assert result.status is DocumentCheckStatus.UNREADABLE
        assert result.reason == "no_document_in_frame"
        # And the registry was never asked about a document nobody read.
        assert verifier.seen == []

    def test_a_reader_that_cannot_run_is_unavailable(self) -> None:
        result = check(StubReader(ProviderUnavailable("engine down")), StubVerifier(True))

        assert result.status is DocumentCheckStatus.UNAVAILABLE
        assert result.reason == "reader_unavailable"

    def test_a_registry_that_cannot_be_asked_is_unavailable(self) -> None:
        """Distinct from NOT_VERIFIED: nobody said this document was bad."""
        result = check(StubReader(PAN), StubVerifier(ProviderUnavailable("timeout")))

        assert result.status is DocumentCheckStatus.UNAVAILABLE

    def test_unreadable_and_unavailable_are_different_statuses(self) -> None:
        # The distinction the agent acts on: hold the card still, against give
        # up on the panel. A single failure value would lose the instruction.
        unreadable = check(StubReader(None), StubVerifier(True))
        unavailable = check(StubReader(ProviderUnavailable("down")), StubVerifier(True))

        assert unreadable.status is not unavailable.status

    def test_the_check_names_the_models_that_produced_it(self) -> None:
        result = check(StubReader(PAN), StubVerifier(True))

        assert result.model_versions == {
            "document_ocr": "stub-v1",
            "document_verifier": "stub-v1",
        }

    def test_the_document_type_is_echoed_back(self) -> None:
        result = check(StubReader(PAN), StubVerifier(True))

        assert result.document_type is DocumentType.PAN


class TestNothingLeaks:
    """The promise the whole design rests on."""

    def test_the_result_has_no_field_for_document_contents(self) -> None:
        result = check(StubReader(PAN), StubVerifier(True))

        fields = set(result.__dataclass_fields__)
        assert fields == {
            "document_type",
            "status",
            "reason",
            "ocr_version",
            "verifier_version",
        }

    def test_the_published_payload_carries_nothing_from_the_card(self) -> None:
        from app.analysis import document_payload

        payload = document_payload(SESSION, check(StubReader(PAN), StubVerifier(True)))

        body = repr(payload)
        for secret in ("ABCDE1234F", "A Customer"):
            assert secret not in body

    def test_the_fields_reach_the_verifier_and_go_no_further(self) -> None:
        """They exist -- the check would be useless otherwise -- and then stop."""
        verifier = StubVerifier(True)

        result = check(StubReader(PAN), verifier)

        assert verifier.seen == [PAN]
        assert "ABCDE1234F" not in repr(result)

    def test_a_field_bundle_cannot_be_printed(self) -> None:
        # The usual way a value leaks into a log: `logger.info("%s", fields)`,
        # an f-string, or an exception rendering its arguments. A redacted repr
        # means all three produce a placeholder.
        assert "ABCDE1234F" not in repr(PAN)
        assert "ABCDE1234F" not in str(PAN)
        assert "ABCDE1234F" not in f"{PAN}"
        assert "A Customer" not in repr(PAN)

    def test_the_document_type_still_shows_so_the_repr_is_useful(self) -> None:
        # Redacted, not useless: an operator reading a log needs to know which
        # document was being read, and that is not sensitive.
        assert "PAN" in repr(PAN)

    def test_no_log_line_from_a_check_mentions_the_document(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Every branch, at the level a running service would emit."""
        with caplog.at_level(logging.DEBUG):
            check(StubReader(PAN), StubVerifier(True))
            check(StubReader(PAN), StubVerifier(False))
            check(StubReader(None), StubVerifier(True))
            check(StubReader(ProviderUnavailable("down")), StubVerifier(True))
            check(StubReader(PAN), StubVerifier(ProviderUnavailable("down")))

        logged = "\n".join(record.getMessage() for record in caplog.records)
        for secret in ("ABCDE1234F", "A Customer"):
            assert secret not in logged

    def test_the_mock_reader_output_never_reaches_a_payload(self) -> None:
        """The mock produces realistic values; they must be as contained."""
        from app.analysis import document_payload

        result = run(
            check_document(
                session_id=SESSION,
                document_type=DocumentType.PAN,
                frames=frames(),
                reader=MockDocumentReader(unreadable_rate=0),
                verifier=MockDocumentVerifier(verified_rate=100),
            )
        )
        body = repr(document_payload(SESSION, result))

        assert result.status is DocumentCheckStatus.VERIFIED
        for secret in SECRETS:
            assert secret not in body


class TestReasons:
    def test_a_provider_message_never_reaches_the_reason(self) -> None:
        """The obvious place for a number to leak back in under another name.

        A real reader or registry client is third-party code, and its error text
        routinely quotes the request that failed. Forwarding it -- or slugifying
        it -- would put a document number on the wire inside a diagnostic.
        """
        leaky = ProviderUnavailable("rejected PAN ABCDE1234F: upstream 502")

        result = check(StubReader(leaky), StubVerifier(True))

        assert result.reason == "reader_unavailable"
        assert "ABCDE1234F" not in repr(result)

    def test_a_leaky_verifier_message_is_dropped_too(self) -> None:
        leaky = ProviderUnavailable("no match for ABCDE1234F")

        result = check(StubReader(PAN), StubVerifier(leaky))

        assert result.reason == "verifier_unavailable"
        assert "ABCDE1234F" not in repr(result)

    def test_every_reason_satisfies_the_wire_schema(self) -> None:
        # The Control API's zod schema accepts a short lower-case token and
        # nothing else. These four are the complete vocabulary this path emits.
        import re

        from app.analysis.document import (
            NO_DOCUMENT,
            NOT_RECOGNISED,
            READER_UNAVAILABLE,
            VERIFIER_UNAVAILABLE,
        )

        for reason in (NO_DOCUMENT, NOT_RECOGNISED, READER_UNAVAILABLE, VERIFIER_UNAVAILABLE):
            assert re.fullmatch(r"[a-z][a-z0-9_]{0,63}", reason)


class StallingFrameSource:
    """Emits a burst, then holds the track open forever.

    A call being analysed is the state a document check actually happens in, and
    `FakeFrameSource` cannot express it: it never awaits, so a whole analysis
    runs and finishes inside one scheduling slice, leaving nothing live to ask.
    This yields enough frames to fill the window and then stalls, which is what
    a real call looks like between frames.
    """

    def __init__(self, burst: int = 40) -> None:
        self.burst = burst
        self.closed = 0

    async def frames(self):  # noqa: ANN201
        for handle in handles(self.burst):
            yield handle
        while True:  # pragma: no branch - ends by cancellation
            await _yield()

    async def aclose(self) -> None:
        self.closed += 1


class TestTriggering:
    """Reaching a live analysis, and the ordinary case of there being none."""

    def build(self, providers=None, publisher=None):  # noqa: ANN001, ANN201
        sink = publisher or RecordingPublisher()
        manager = AnalysisManager(
            providers=providers or build_providers({}),
            publisher=sink,
            source_factory=lambda _req: StallingFrameSource(),  # type: ignore[arg-type,return-value]
            cadence=CADENCE,
            max_analysis_s=30.0,
        )
        return manager, sink

    def request(self, session_id: str = SESSION) -> AnalysisRequest:
        return AnalysisRequest(
            session_id=session_id,
            room_name=f"vcip_{session_id}",
            token="a.livekit.jwt",
            livekit_url="ws://localhost:7880",
        )

    def test_a_session_with_no_analysis_is_told_so(self) -> None:
        async def scenario() -> None:
            manager, _ = self.build()

            with pytest.raises(NoAnalysisRunning):
                await manager.read_document(SESSION, DocumentType.PAN)

        run(scenario())

    def test_a_running_analysis_answers_a_check(self) -> None:
        async def scenario() -> None:
            manager, publisher = self.build()
            manager.start(self.request())
            # Let the loop take enough frames to fill its window.
            for _ in range(200):
                await _yield()

            result = await manager.read_document(SESSION, DocumentType.PAN)

            assert result.document_type is DocumentType.PAN
            assert len(publisher.documents) == 1
            assert publisher.documents[0]["session_id"] == SESSION
            await manager.shutdown()

        run(scenario())

    def test_the_document_result_goes_to_its_own_route(self) -> None:
        """It must never arrive as a sampled result, which would overwrite one."""

        async def scenario() -> None:
            manager, publisher = self.build()
            manager.start(self.request())
            for _ in range(200):
                await _yield()

            await manager.read_document(SESSION, DocumentType.PAN)

            assert all("document_type" not in payload for payload in publisher.published)
            assert all("liveness_status" not in payload for payload in publisher.documents)
            await manager.shutdown()

        run(scenario())

    def test_a_failed_publish_does_not_fail_the_check(self) -> None:
        """The agent is waiting; a delivery problem is logged, not raised."""

        async def scenario() -> None:
            manager, _ = self.build(publisher=RecordingPublisher(document_fail_times=1))
            manager.start(self.request())
            for _ in range(200):
                await _yield()

            result = await manager.read_document(SESSION, DocumentType.PAN)

            assert result.status in set(DocumentCheckStatus)
            await manager.shutdown()

        run(scenario())

    def test_an_unavailable_provider_set_still_answers(self) -> None:
        """T32's property, for this path: degraded AI never blocks the agent."""

        async def scenario() -> None:
            providers = replace(
                build_providers({}),
                document_reader=UnavailableDocumentReader(),
                document_verifier=UnavailableDocumentVerifier(),
            )
            manager, publisher = self.build(providers=providers)
            manager.start(self.request())
            for _ in range(200):
                await _yield()

            result = await manager.read_document(SESSION, DocumentType.PAN)

            assert result.status is DocumentCheckStatus.UNAVAILABLE
            assert publisher.documents[0]["status"] == "UNAVAILABLE"
            await manager.shutdown()

        run(scenario())

    def test_a_stopped_analysis_is_no_longer_reachable(self) -> None:
        async def scenario() -> None:
            manager, _ = self.build()
            manager.start(self.request())
            await manager.stop(SESSION)

            with pytest.raises(NoAnalysisRunning):
                await manager.read_document(SESSION, DocumentType.PAN)

        run(scenario())


async def _yield() -> None:
    import asyncio

    await asyncio.sleep(0)
