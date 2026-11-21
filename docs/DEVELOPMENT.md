# Development

## Requirements

- macOS. Caddi is only developed and tested on macOS. Agent connections use Unix sockets, and packaging and several tests assume a Mac.
- Node.js 22.12 or newer, with npm.
- Packaging additionally needs an Apple Silicon Mac, the Xcode command line tools, and Node headers from Homebrew. See [Packaging](#packaging).

Electron 45.3.2 is the only npm dependency, pinned exactly. There is no build step, bundler or TypeScript compile. The app runs straight from the `.mjs` sources.

## Install and run

```sh
git clone https://github.com/ethanplusai/caddi.git
cd caddi
npm ci
npm start
```

`npm ci` downloads the Electron runtime (a few hundred megabytes). `npm start` opens the app as "Caddi Development". `npm run dev` and `npm run caddi:dev` do the same thing.

A source run stores its data in `.caddi-development/` at the repository root and puts temporary files in `.test-artifacts/`. Both are git-ignored. Delete `.caddi-development/` to start from a clean profile. Only one instance runs at a time. Starting a second one focuses the first.

On start the main process prints an `CADDI_DESKTOP_READY` line with the local socket path. That is expected.

## Tests

### Unit and integration tests

```sh
npm test
```

Runs every `test/*.test.mjs` file with the built-in Node test runner. Most tests are plain Node and need nothing else. A few start short-lived Electron processes with throwaway profiles, so run `npm ci` first. A handful of tests are skipped unless you opt in with an environment variable, because they need a native Keychain build or local speech assets.

`npm run test:caddi` runs the same suite without the two `caddi-*` test files.

### Electron smoke tests

Each of these starts the real app with a fresh temporary profile, drives it against pages served from `127.0.0.1`, prints a result for each check, and exits. They never touch your `.caddi-development/` data or any other browser profile. Run them one at a time.

| Script | What it covers | What it needs |
| --- | --- | --- |
| `npm run test:desktop` | The full desktop flow: tabs, navigation, agent approval, page control, privacy pause, page notes | An unlocked Mac with a visible display. It shows a window and checks real focus and input. Do not use the Mac while it runs. |
| `npm run test:desktop:workspaces` | Workspace create, select, retire and reopen, including agent-created workspaces | Hidden window. No display interaction. |
| `npm run test:desktop:scale` | 160 saved tabs across 20 project workspaces, with brief concurrent agent operations | Hidden window. Takes longer. |
| `npm run test:desktop:capacity` | The limit on loaded pages and what happens when it is reached | Hidden window. Enough free memory to load about 32 pages. |
| `npm run test:desktop:annotate` | Annotate mode: picking elements, notes, Markdown copy, sending | Uses a local fixture page. Runs with the screen locked, with reduced coverage. |
| `npm run test:desktop:live` | Live mode: pointer tracking, the typed fallback, delivery to a real MCP client, stop conditions, and one synthetic spoken sentence through the pinned transcriber when the speech files are present | Uses a local fixture page. No microphone. |
| `npm run test:desktop:browser-use` | Agents driving a page: the page layer, agent cursor, real input, masked screenshots, the driving indicator, Take over, release and Pause, the screenshot option at approval, then the same actions through a real MCP client | Uses a local fixture page and shows a window. The MCP part needs page admission, so it stops with `BROWSER_USE_SMOKE_BLOCKED` while macOS reports critical memory pressure. |
| `npm run test:desktop:extraction` | Reading pages: the owner's Copy page as Markdown first, then `page:read` and `page:extract` on the real DOM (main content, tables, links, forms, hidden text, typed values, frames, shadow roots, a Caddi-filled login, a very large page), then `caddi_read_page` and `caddi_extract` through a real MCP client with the reading indicator. Saves the Markdown of two fixtures in `.test-artifacts/caddi-extraction/` | Uses local fixture pages and shows a window. The MCP part needs page admission, so it stops with `EXTRACTION_SMOKE_BLOCKED` while macOS reports critical memory pressure; the owner and engine checks have run by then. |
| `npm run test:desktop:logins` | The Vault: the owner adds logins, searches, fills from the toolbar key, sees Activity, and gets the save offer after typing a login by hand (Save, then Update for a changed password), while an agent's click on Sign in gives no offer; a filled password stays away from agent paths; an agent fills through MCP after the owner confirms. Screenshots in `.test-artifacts/caddi-logins/` | Uses the in-memory keychain stand-in, a local fixture page, and shows a window. Import is covered by unit tests only, because it starts from the native open panel. |
| `npm run test:desktop:everyday` | Ordinary browsing as the owner: typing addresses and searches, failed loads, links and new tabs, downloads, forms and editing, uploads, media and permissions, tabs and windows, find and zoom, storage, shell dialogs, heavy pages and page dialogs. Known gaps are printed as `KNOWN`, not failed | Shows a window and takes keyboard focus; do not use the Mac while it runs. Every host name other than loopback is mapped to not-found. Leaves one page alert sheet open until it exits |
| `npm run test:ui` | Renders the interface in a set of fixed states for visual review, including dark appearance | Hidden window. |
| `npm run test:desktop:extension` | An isolated check of loading one bundled test extension | Hidden window. Does not use the main app entry. |

Each smoke run has a watchdog and exits with an error after about two minutes if it hangs. `main.mjs` accepts more `--caddi-*-smoke` flags than have npm scripts (private windows, previews, downloads, import and export, media, recovery and others). Run one with `npx electron src/caddi/desktop/main.mjs --caddi-<name>-smoke`.

### Checking a packaged bundle

A packaged app can check itself. Each command starts the bundle with a fresh temporary profile, loads a local page, sends real input, saves a PDF and exits.

```sh
dist/Caddi.app/Contents/MacOS/Caddi --caddi-packaged-smoke
dist/Caddi.app/Contents/MacOS/Caddi --caddi-packaged-print-smoke
```

They need an unlocked Mac with a visible display and `pdftotext` (from Poppler) on the path. A bundle built with `--without-speech` skips the local speech checks and says so in its result line.

### Other scripts

- `npm run caddi:demo` runs two simulated agents against a simulated page engine over a real Unix socket. It does not open a browser.
- `npm run caddi:fixtures -- --serve` serves the synthetic test pages on `127.0.0.1` so you can open them by hand.
- `npm run caddi:mcp` is a lower-level MCP entry that takes a credential on an inherited file descriptor. Coding agents should use the configuration from the Agents dialog instead. See [CONNECTING-AGENTS.md](CONNECTING-AGENTS.md).

## Packaging

```sh
npm run package:caddi
```

This builds an unsigned local app bundle at `dist/Caddi-Development.app`. If that name is taken it writes a timestamped name next to it and never overwrites an existing bundle. The script works offline. It copies the installed Electron runtime, adds an allowlisted set of source files, writes a manifest of file hashes, and verifies the result. It does not sign, notarize, install or launch anything.

It needs more than a source run does:

- an Apple Silicon Mac
- Xcode command line tools (`xcrun clang`), to compile a small native addon from `src/caddi/platform/keychain-addon.m`
- Node headers at `/opt/homebrew/include/node`, which is where Homebrew's Node puts them
- the pinned local speech files (a `whisper-cli` build and the `ggml-tiny.en.bin` model) at the paths and hashes listed in `src/caddi/desktop/speech-pins.mjs`. These are not in the repository, and the script stops if they are missing or different.
- the pinned Node.js runtime for the agent connector. Run `node scripts/fetch-caddi-node.mjs` once; it downloads the official archive and checks it against `src/caddi/desktop/connector-pins.mjs`.

Every bundle has Electron's run-as-Node, `NODE_OPTIONS` and `--inspect` fuses switched off, and the script refuses to finish if they are on. So `dist/Caddi.app/Contents/MacOS/Caddi` cannot run scripts; agents use the bundled `Contents/Resources/caddi-connector/node`.

Pass `--without-speech` to build without the local speech files. Voice notes and spoken Live instructions are then unavailable in that bundle (typed Live instructions still work); everything else works.

Because this bundle is unsigned, macOS Gatekeeper will warn when you open it. The packaged app keeps its data in `~/Library/Application Support/Caddi Development/`.

### Signed and notarized builds

A build that opens without a Gatekeeper warning needs two things from Apple: a Developer ID signature and notarization. Both need a paid Apple Developer account.

```sh
npm run package:caddi:signed -- "<Developer ID name, hash or team ID>"
npm run notarize:caddi -- --profile <notarytool profile>
```

**Signing** needs a "Developer ID Application" certificate in your login keychain. `security find-identity -v -p codesigning` lists what you have. The script signs every nested binary, framework and helper app from the inside out with the hardened runtime and a secure timestamp, writes the bundle manifest, then signs the outer app so the signature also seals the manifest. It signs the pinned speech program too and records its signed size and SHA-256 in the bundled speech manifest, so the app checks the signed program at launch.

The entitlements are the minimum Electron needs under the hardened runtime (`allow-jit`, `allow-unsigned-executable-memory`) plus microphone and camera for sites you allow. Library validation stays on.

**Notarizing** uploads the signed bundle to Apple, waits for the verdict, staples the ticket to the app, checks that Gatekeeper accepts it, and writes `dist/Caddi-<version>-arm64.zip` with a `.sha256` file beside it. Credentials never pass through the script. Create a notarytool profile once and name it:

```sh
xcrun notarytool store-credentials <profile> --apple-id <your Apple ID> --team-id <team ID>
```

That command asks for an app-specific password and stores it in your keychain.

### The release build and its installer

The steps above sign the local development bundle. The build people download is made with a release identity instead: the app is named `Caddi`, its bundle identifier is `build.caddi.browser`, and it keeps its data in `~/Library/Application Support/Caddi/`, apart from any development build on the same Mac. A release build must be signed.

```sh
npm run package:caddi:release -- "<Developer ID name, hash or team ID>"   # dist/Caddi.app
npm run notarize:caddi -- dist/Caddi.app --profile <notarytool profile>   # staples the app
npm run dmg:caddi -- dist/Caddi.app                                       # dist/Caddi-<version>-arm64.dmg
npm run notarize:caddi -- dist/Caddi-<version>-arm64.dmg --profile <notarytool profile>
```

`dmg:caddi` builds the installer disk image with `hdiutil`: the app beside an Applications shortcut on a branded background, so installing is one drag. It asks Finder to arrange the window, which macOS may ask you to allow the first time. The image is signed with the same identity as the app inside it. Notarizing the image staples a ticket to it, checks it the way Gatekeeper does when a downloaded image is opened, and writes a `.sha256` file beside it.

The background is `assets/caddi-brand/dmg-background.svg`. After changing it, render both sizes again:

```sh
sips -s format png -z 420 660 assets/caddi-brand/dmg-background.svg --out assets/caddi-brand/dmg-background.png
sips -s format png -z 840 1320 assets/caddi-brand/dmg-background.svg --out "assets/caddi-brand/dmg-background@2x.png"
```

Finder draws icon names in black over a background picture, whatever the appearance, which is why the icons sit on a light tray.

A signed manifest lists every file except the three a signature owns (the main executable, `_CodeSignature/CodeResources` and the stapled `CodeResources` ticket). Those are covered by `codesign --verify --deep --strict`, which the verify step runs.

Most contributors do not need to package. `npm start` runs Caddi from source.

## Repository layout

```
src/caddi/            application code (see ARCHITECTURE.md for each subdirectory)
  desktop/            Electron main process, page engine, preloads
  desktop/ui/         the browser interface: index.html, styles.css, renderer.mjs
scripts/              MCP client entry points, packager, demo and fixture servers
test/                 *.test.mjs unit tests, *-smoke.mjs Electron smoke helpers, fixtures/
assets/caddi-brand/   app icon
assets/caddi-speech/  licence and model card for the optional speech model
docs/                 this documentation
```

The `caddi` directory name, the `caddi_` tool prefix and the `caddi:` npm script prefix come from an earlier internal name. They may be renamed later, so avoid adding new uses outside that tree.

## Conventions

These are what the existing code does. Please match them.

- **Plain ES modules.** `.mjs` everywhere. Preload scripts are `.cjs` because sandboxed preloads must be CommonJS. No TypeScript, no transpiler, no bundler.
- **No new runtime dependencies.** Use Node and Electron built-ins. If a dependency is truly needed, raise it in an issue first and record its licence in `THIRD_PARTY_NOTICES.md`.
- **Factory functions, not classes,** for most modules: `createThing({ ...dependencies })` returns a frozen object of methods. Dependencies such as clocks are passed in so tests can replace them.
- **Validate at every boundary.** Anything arriving from a renderer, a socket, a file or an agent is copied with `cloneData` (which enforces a size limit) and checked with `assertKeys`, `assertId`, `assertInteger` and `assertString` from `src/caddi/contracts.mjs`. Unknown fields are an error.
- **Bound everything.** Lists, strings, queues and timeouts have explicit maximums.
- **Errors carry codes.** Throw `CaddiError(code, message)` with an upper-case code. Messages sent across a trust boundary stay generic. Do not put page content, paths or secrets in them.
- **Fail closed.** If a check cannot be completed, deny. Never fall back to a wider permission.
- **Authority stays in main.** Renderers send requests. They do not decide. Agent grants and leases are in memory only.
- **Private files.** Create directories with mode `0700` through `ensurePrivateDirectory`, and do not follow symlinks.
- **Tests use `node:test` and `node:assert/strict`** with synthetic data and loopback servers only. No real accounts, no real credentials, no calls to live services.
- **Interface code** is hand-written HTML, CSS and DOM scripting. Every control needs an accessible name, and state changes go through `action({ type, ... })` to main.

## Before you open a pull request

```sh
npm test
npm run test:desktop:workspaces
```

If you changed the page engine, agent access, or the interface, also run `npm run test:desktop` on an unlocked Mac and `npm run test:ui`. Say in the pull request which of these you ran. See [CONTRIBUTING.md](../CONTRIBUTING.md).
