export { createOfflineUpdateService, issueMainConfiguration as createMainUpdateConfiguration } from './service.mjs';
export { UpdateError } from './manifest.mjs';

/** Main-process composition only. Pinned public keys and the restart checkpoint
 * come from trusted main configuration, never an update/renderer message.
 *
 * qualification is either null (verify-only) or a main-owned capability with
 * { assertQualified, signal }. Its synchronous assertion must cover platform
 * signing, installed identity and ownership of the supplied checkpoint/storage.
 * This module does not manufacture that qualification. No current development
 * build is admitted, even when a caller supplies an assertion.
 *
 * The qualified main callback is a trusted integration boundary, not proof
 * inferred from flags in a manifest. There is no production runtime wiring. */
