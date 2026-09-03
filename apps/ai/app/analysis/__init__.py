"""Frame ingestion and the per-call analysis loop (T30, D23).

`livekit_source` is the only module here that imports the LiveKit SDK, and
`http_publisher` the only one that speaks HTTP. Everything between them — the
loop, the schedule, the window, the payload — is plain Python over the T29
provider interfaces, which is what makes a call's worth of analysis testable
without an SFU, a Control API, or a network.
"""

from .document import check_document
from .frames import (
    FrameDecodeError,
    FrameHandle,
    FrameSource,
    FrameSourceError,
    FrameWindow,
)
from .http_publisher import HttpResultPublisher
from .manager import (
    AnalysisManager,
    AnalysisRequest,
    NoAnalysisRunning,
    SourceFactory,
    StartResult,
)
from .publisher import (
    NullResultPublisher,
    PublishError,
    ResultPublisher,
    document_payload,
    result_payload,
)
from .run import (
    ENDED_SOURCE_FAILED,
    ENDED_TRACK_CLOSED,
    AnalysisOutcome,
    AnalysisRun,
)
from .schedule import Cadence, Schedule

__all__ = [
    "ENDED_SOURCE_FAILED",
    "ENDED_TRACK_CLOSED",
    "AnalysisManager",
    "AnalysisOutcome",
    "AnalysisRequest",
    "AnalysisRun",
    "Cadence",
    "FrameDecodeError",
    "FrameHandle",
    "FrameSource",
    "FrameSourceError",
    "FrameWindow",
    "HttpResultPublisher",
    "NoAnalysisRunning",
    "NullResultPublisher",
    "PublishError",
    "ResultPublisher",
    "Schedule",
    "SourceFactory",
    "StartResult",
    "check_document",
    "document_payload",
    "result_payload",
]
