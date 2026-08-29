/**
 * The success envelope.
 *
 * `docs/05-api-contract.md` puts every successful payload under a `data` key,
 * mirroring the `error` key the failure envelope uses. Having both means a
 * client can tell the two apart structurally rather than by reading the status
 * code, and that a response can gain a sibling field later without becoming a
 * breaking change.
 */

export interface ApiData<T> {
  readonly data: T;
}

/** Wrap a payload in the documented envelope. */
export const data = <T>(payload: T): ApiData<T> => ({ data: payload });
