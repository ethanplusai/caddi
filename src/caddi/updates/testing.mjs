import { issueSyntheticConfiguration, createOfflineUpdateService } from './service.mjs';

/** Synthetic offline fixtures only. Public KeyObjects may be passed here;
 * generate/sign with private KeyObjects in the test's memory, never export keys.
 * The staging directory must already be a disposable 0700 temp directory.
 * 64 MiB is a bounded proof limit, not support for the current full Caddi app. */
export function createSyntheticUpdateService(options) {
  return createOfflineUpdateService(issueSyntheticConfiguration(options));
}
