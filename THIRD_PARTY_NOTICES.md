# Third-party notices

Caddi's own source code is licensed under the MIT License. See [LICENSE](LICENSE).

Caddi depends on, and local builds bundle, software from other projects. Those components keep their own licenses. This file lists them. If you add a dependency or reuse third-party code or assets, add it here in the same change.

## Electron and Chromium

| Component | Version | License |
| --- | --- | --- |
| Electron | 45.3.2 | MIT. Copyright (c) Electron contributors. Copyright (c) 2013-2020 GitHub Inc. |
| Chromium, Node.js, V8 and the other components inside the Electron runtime | as shipped with Electron 45.3.2 | Various open source licenses, mainly BSD-style, MIT and Apache-2.0 |

The Electron runtime is not stored in this repository. `npm ci` downloads it. The full license texts ship with it:

- `node_modules/electron/dist/LICENSE` (Electron)
- `node_modules/electron/dist/LICENSES.chromium.html` (Chromium and its bundled components)

A local app bundle made with `npm run package:caddi` is a copy of that runtime and includes both files.

## npm packages

These are all the packages in `package-lock.json`. Electron is the only direct dependency. The others are installed because Electron's installer needs them. All are development dependencies. None of their code is loaded by the running app except Electron itself.

| Package | Version | License |
| --- | --- | --- |
| `electron` | 45.3.2 | MIT |
| `@electron/get` | 5.1.0 | MIT |
| `@electron-internal/extract-zip` | 1.0.6 | MIT |
| `@types/node` | 24.19.2 | MIT |
| `debug` | 4.4.3 | MIT |
| `env-paths` | 3.0.0 | MIT |
| `graceful-fs` | 4.2.11 | ISC |
| `ms` | 2.1.3 | MIT |
| `progress` | 2.0.3 | MIT |
| `semver` | 7.8.5 | ISC |
| `sumchecker` | 3.0.1 | Apache-2.0 |
| `undici` | 7.30.1 | MIT |
| `undici-types` | 7.24.6 | MIT |

Each package's license text is in its directory under `node_modules/` after `npm ci`.

## Optional local speech feature

Caddi can turn a spoken note into text on your Mac using whisper.cpp and a small Whisper model. This is optional. The program and the model file are not stored in this repository. They are only present in a packaged bundle, or in a checkout where a developer has placed them at the paths pinned in `src/caddi/desktop/speech-pins.mjs`.

| Component | Source | License |
| --- | --- | --- |
| whisper.cpp (`whisper-cli`) | https://github.com/ggml-org/whisper.cpp at commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` | MIT. Copyright (c) The ggml authors. |
| Whisper `tiny.en` model in ggml format (`ggml-tiny.en.bin`) | Converted from OpenAI's Whisper model and published at https://huggingface.co/ggerganov/whisper.cpp | MIT. Copyright (c) 2022 OpenAI. |

Related files in this repository:

- `assets/caddi-speech/WHISPER-LICENSE`: the OpenAI Whisper license text
- `assets/caddi-speech/MODEL-CARD.md`: the upstream model card for the converted models

A packaged bundle also includes the whisper.cpp license text next to the program.

## Caddi name and logo

The MIT License covers the source code in this repository. It does not grant rights to the Caddi name, the Caddi logo, or the app icon in `assets/caddi-brand/` and `src/caddi/desktop/ui/brand/`. These are trademarks of the project owner.

You are free to use, change and redistribute the code under the MIT License. If you distribute a modified version, please give it a different name and icon so that people can tell it apart from this project.

## Other names

GitHub, Vercel, Resend, Claude Code, Codex, Cursor, macOS and other product names mentioned in this repository belong to their owners. They are used only to describe what Caddi works with. No endorsement is implied.

See [PROVENANCE.md](PROVENANCE.md) for how this codebase came about.
