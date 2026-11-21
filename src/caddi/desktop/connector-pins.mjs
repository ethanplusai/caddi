// The Node.js runtime that starts the agent connector in a packaged app. Shared by the fetch
// script, the offline packager and the packaged main process.
//
// Caddi's own executable cannot run scripts as plain Node: its Electron fuses switch that off
// (see scripts/package-caddi.mjs), so nothing else on the Mac can run code as Caddi. The
// connector runs on this separate, pinned runtime instead.
export const CONNECTOR_RESOURCE_DIRECTORY = 'caddi-connector';
export const CONNECTOR_NODE = Object.freeze({
  version: '26.13.1',
  archive: Object.freeze({
    url: 'https://nodejs.org/dist/v26.13.1/node-v26.13.1-darwin-arm64.tar.gz',
    file: '.test-artifacts/caddi-node/node-v26.13.1-darwin-arm64.tar.gz',
    sha256: 'aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735',
  }),
  program: Object.freeze({
    member: 'node-v26.13.1-darwin-arm64/bin/node',
    development: '.test-artifacts/caddi-node/node-v26.13.1-darwin-arm64/bin/node',
    bundled: 'node', bytes: 147_366_176,
    sha256: '266dec4dce3a6cdcf5cdc38722a00cf5ae6a12cc51068d2a227655bbb75751ec',
  }),
  license: Object.freeze({
    member: 'node-v26.13.1-darwin-arm64/LICENSE',
    development: '.test-artifacts/caddi-node/node-v26.13.1-darwin-arm64/LICENSE',
    bundled: 'NODE-LICENSE', maximum: 262_144,
    sha256: '8e603aa87c70d36e497004f0dec63111511cb61b7d65ace12e10ea791599286c',
  }),
});
// The signature Caddi gives the runtime. It is not Caddi's identifier, so the keychain items
// Caddi creates do not trust it, and it gets only what V8 needs under the hardened runtime.
export const CONNECTOR_SIGNING_IDENTIFIER = 'build.caddi.connector';
export const CONNECTOR_ENTITLEMENTS = Object.freeze({
  'com.apple.security.cs.allow-jit': true,
  'com.apple.security.cs.allow-unsigned-executable-memory': true,
});
