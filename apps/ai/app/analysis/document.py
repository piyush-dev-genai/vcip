"""Running one document check.

Read the card, ask the registry, report a status. Three steps, and the whole of
this module's job is making sure that every way each of them can fail turns into
one of four statuses rather than into an exception the agent never hears about.

The mapping, and why each is what it is:

```text
reader raised ProviderUnavailable   -> UNAVAILABLE   (it never ran)
reader returned None                -> UNREADABLE    (it ran; no usable card)
verifier raised ProviderUnavailable -> UNAVAILABLE   (registry not asked)
verifier said False                 -> NOT_VERIFIED  (registry said no)
verifier said True                  -> VERIFIED
```

`UNREADABLE` and `UNAVAILABLE` are kept apart because they tell the agent to do
different things: hold the card still and try again, against give up on the
panel and decide on what you can see. A single failure value would leave a red
mark carrying no instruction.

**Nothing here logs the fields.** The only value that names a document is bound
to `fields`, is passed straight to the verifier, and goes out of scope. The log
lines below carry a session id and a status. `DocumentFields.__repr__` is
redacted as a second line of defence, but the first is simply not writing it.
"""

from __future__ import annotations

import logging

from app.providers import (
    DocumentCheck,
    DocumentCheckStatus,
    DocumentFields,
    DocumentReader,
    DocumentType,
    DocumentVerifier,
    Frame,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)

#: The complete vocabulary of reasons this path can produce.
#:
#: Fixed strings rather than anything derived from a provider, because the only
#: text available to derive from is a third party's error message, and those
#: quote the request they failed on. Four tokens the Control API's schema will
#: accept and none of them can carry a document number.
READER_UNAVAILABLE = "reader_unavailable"
VERIFIER_UNAVAILABLE = "verifier_unavailable"
NO_DOCUMENT = "no_document_in_frame"
NOT_RECOGNISED = "registry_did_not_recognise"


async def check_document(
    *,
    session_id: str,
    document_type: DocumentType,
    frames: tuple[Frame, ...],
    reader: DocumentReader,
    verifier: DocumentVerifier,
) -> DocumentCheck:
    """Read one document from a frame burst and check it against its registry."""
    versions = {
        "ocr_version": reader.model_version,
        "verifier_version": verifier.model_version,
    }

    try:
        fields = await reader.read(
            session_id=session_id, document_type=document_type, frames=frames
        )
    except ProviderUnavailable:
        # The provider's own reason is deliberately dropped rather than
        # forwarded or slugified. `ProviderUnavailable` documents it as
        # diagnostic only, and on this path it is worse than that: a real
        # document reader or registry client is third-party code whose error
        # text routinely quotes the request that failed -- which here is a
        # document number. A fixed vocabulary cannot echo anything.
        logger.info("document read unavailable for session %s", session_id)
        return DocumentCheck.unavailable(document_type, READER_UNAVAILABLE, **versions)

    if fields is None:
        # The reader ran and found nothing it could use. An answer, not a fault:
        # a handheld card on a compressed stream is often unreadable, and the
        # agent's next move is to ask for it again.
        logger.info("no readable document for session %s", session_id)
        return DocumentCheck.unreadable(document_type, NO_DOCUMENT, **versions)

    return await _verify(
        session_id=session_id,
        document_type=document_type,
        fields=fields,
        verifier=verifier,
        versions=versions,
    )


async def _verify(
    *,
    session_id: str,
    document_type: DocumentType,
    fields: DocumentFields,
    verifier: DocumentVerifier,
    versions: dict[str, str],
) -> DocumentCheck:
    """Ask the registry, and let `fields` fall out of scope on every path."""
    try:
        recognised = await verifier.verify(session_id=session_id, fields=fields)
    except ProviderUnavailable:
        # Same reasoning as the reader above, and more pressing: this is the
        # call that actually goes to a third party.
        logger.info("document verifier unavailable for session %s", session_id)
        return DocumentCheck.unavailable(document_type, VERIFIER_UNAVAILABLE, **versions)

    status = DocumentCheckStatus.VERIFIED if recognised else DocumentCheckStatus.NOT_VERIFIED
    logger.info("document check for session %s: %s", session_id, status.value)

    return DocumentCheck(
        document_type=document_type,
        status=status,
        reason=None if recognised else NOT_RECOGNISED,
        **versions,
    )
