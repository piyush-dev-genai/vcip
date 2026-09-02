"""Provider failure vocabulary.

Two kinds of failure exist in this layer and they are not interchangeable.

`ProviderUnavailable` is the *expected* one: the model host is down, the
reference is missing, the request timed out. AI is assistive and off the video
critical path (D6), so an expected failure is data — the caller turns it into an
`UNAVAILABLE` result, the HUD says "AI unavailable", and the call carries on.

Everything else is a bug in this process. A `TypeError` from a mis-built frame
is not evidence that the model is down, and reporting it as `UNAVAILABLE` would
hide it behind a message the agent has been trained to ignore. Programming
errors therefore propagate untouched.
"""


class ProviderUnavailable(Exception):
    """An expected, transient inability to produce a result.

    Raised inside a provider and converted to an `UNAVAILABLE` result at the
    provider's public boundary. The reason is diagnostic only: it is for logs
    and never travels to `/internal/ai/result`.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ReferenceUnavailable(ProviderUnavailable):
    """No face-match reference could be loaded for this session.

    A subclass because it is an ordinary unavailability with one specific
    cause, and because the face-match path is the only one that cares which.
    """
