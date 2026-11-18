import { issueSyntheticOwnerCredentialAcquisition } from './owner-credential-acquisition.mjs';

/** Owned synthetic proof only: the callback transfers an exclusively owned
 * Buffer (or null for cancellation), never a renderer string or IPC payload. */
export const createSyntheticOwnerCredentialAcquisition = options => issueSyntheticOwnerCredentialAcquisition(options);
