// Explicit synthetic boundary for protocol tests, rejected by ordinary feedback
// and pairing providers. No native helper, Keychain entry, or key file is used.
import { constructKeychainProvider } from './keychain.mjs';
export function createNativeKeychainTestProvider(invoke) {
  return constructKeychainProvider({ invoke, testOnly: true });
}
