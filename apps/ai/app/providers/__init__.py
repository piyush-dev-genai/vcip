"""The AI provider layer.

Three checks — liveness, face match, OCR — behind interfaces, plus the
reference seam they compare against and the configuration that selects an
implementation. This is the whole vocabulary T30 needs; nothing below imports
LiveKit, Redis, PostgreSQL, or an HTTP client, and nothing here decides a
verdict (I7).
"""

from .degraded import (
    UNAVAILABLE_VERSION,
    UnavailableDocumentReader,
    UnavailableDocumentVerifier,
    UnavailableFaceMatchProvider,
    UnavailableLivenessProvider,
    UnavailableOCRProvider,
)
from .document import (
    MOCK_DOCUMENT_OCR_VERSION,
    MOCK_DOCUMENT_VERIFIER_VERSION,
    OCR_VERSION_KEY,
    VERIFIER_VERSION_KEY,
    DocumentCheck,
    DocumentCheckStatus,
    DocumentFields,
    DocumentReader,
    DocumentType,
    DocumentVerifier,
    MockDocumentReader,
    MockDocumentVerifier,
)
from .errors import ProviderUnavailable, ReferenceUnavailable
from .face_match import MOCK_FACE_MATCH_VERSION, FaceMatchProvider, MockFaceMatchProvider
from .frame import RGB24_BYTES_PER_PIXEL, Frame, require_frame, require_frames
from .liveness import (
    MIN_LIVENESS_FRAMES,
    MOCK_LIVENESS_VERSION,
    LivenessProvider,
    MockLivenessProvider,
)
from .ocr import MOCK_OCR_VERSION, MockOCRProvider, OCRProvider
from .reference import (
    REFERENCE_EXTENSIONS,
    EmptyReferenceStore,
    LocalReferenceStore,
    Reference,
    ReferenceStore,
)
from .registry import (
    DEFAULT_REFERENCE_DIR,
    MODE_ENV_VAR,
    REFERENCE_DIR_ENV_VAR,
    ProviderMode,
    ProviderSet,
    build_providers,
    resolve_mode,
)
from .results import (
    SCORE_MAX,
    SCORE_MIN,
    FaceMatchResult,
    FaceMatchStatus,
    LivenessResult,
    LivenessStatus,
    OcrResult,
    OcrStatus,
    validate_score,
)
from .scripting import Script

__all__ = [
    "build_providers",
    "DEFAULT_REFERENCE_DIR",
    "DocumentCheck",
    "DocumentCheckStatus",
    "DocumentFields",
    "DocumentReader",
    "DocumentType",
    "DocumentVerifier",
    "EmptyReferenceStore",
    "FaceMatchProvider",
    "FaceMatchResult",
    "FaceMatchStatus",
    "Frame",
    "LivenessProvider",
    "LivenessResult",
    "LivenessStatus",
    "LocalReferenceStore",
    "MIN_LIVENESS_FRAMES",
    "MOCK_DOCUMENT_OCR_VERSION",
    "MOCK_DOCUMENT_VERIFIER_VERSION",
    "MOCK_FACE_MATCH_VERSION",
    "MOCK_LIVENESS_VERSION",
    "MOCK_OCR_VERSION",
    "MockDocumentReader",
    "MockDocumentVerifier",
    "MockFaceMatchProvider",
    "MockLivenessProvider",
    "MockOCRProvider",
    "MODE_ENV_VAR",
    "OCR_VERSION_KEY",
    "OCRProvider",
    "OcrResult",
    "OcrStatus",
    "ProviderMode",
    "ProviderSet",
    "ProviderUnavailable",
    "REFERENCE_DIR_ENV_VAR",
    "REFERENCE_EXTENSIONS",
    "Reference",
    "ReferenceStore",
    "ReferenceUnavailable",
    "require_frame",
    "require_frames",
    "resolve_mode",
    "RGB24_BYTES_PER_PIXEL",
    "SCORE_MAX",
    "SCORE_MIN",
    "Script",
    "UNAVAILABLE_VERSION",
    "UnavailableDocumentReader",
    "UnavailableDocumentVerifier",
    "UnavailableFaceMatchProvider",
    "UnavailableLivenessProvider",
    "UnavailableOCRProvider",
    "validate_score",
    "VERIFIER_VERSION_KEY",
]
