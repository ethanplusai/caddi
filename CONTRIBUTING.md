# Contributing

Thanks for your interest in Caddi. It is an early development preview, so small, focused changes are the easiest to review.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md). For questions, see [SUPPORT.md](SUPPORT.md).

## Setup

You need macOS and Node.js 22.12 or newer.

```sh
git clone https://github.com/ethanplusai/caddi.git
cd caddi
npm ci
npm start
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers the repository layout, test scripts and coding conventions. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together.

## Before you open a pull request

Run these and make sure they pass:

```sh
npm test
npm run test:desktop:workspaces
```

If your change touches the page engine, agent access, the page preload or the interface, also run:

```sh
npm run test:desktop    # needs an unlocked Mac; leave it alone while it runs
npm run test:ui
```

In the pull request, say what the change does for a user, which tests you ran, and anything you could not test. Add or update tests when you change behaviour, especially around isolation, agent access, stored state or untrusted input.

Keep pull requests to one topic. For larger changes or new dependencies, open an issue first so we can agree on the approach.

## Where your contribution comes from

- **Your own work, or compatibly licensed work.** Only submit code, text and assets that you wrote yourself, or that come from a source whose license is compatible with MIT.
- **Record anything you reuse.** If you include third-party code or assets, add the name, source URL, version or commit, and license to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) in the same pull request.
- **No proprietary material from other browsers.** Do not contribute code, assets, icons, strings, data formats or other material taken from another browser or any closed-source product. This includes decompiled, extracted or leaked material.
- **Tell us if you are unsure.** If you do not know where something came from, say so in the pull request and leave it out until that is settled.

By submitting a contribution you agree that it is licensed under the project's [MIT License](LICENSE). A DCO sign-off or `Signed-off-by` line is not required.

## Test data

- **Synthetic fixtures only.** Tests, screenshots, issues and logs must not contain real accounts, real credentials, or personal browsing data.
- Tests should use local pages served from `127.0.0.1` and must not call live third-party services.
- Never commit tokens, cookies, profile directories or `.env` files.

## Security-sensitive changes

Do not weaken a protection to make a test pass. That includes sandbox settings, the content security policy, the sensitive-field rules, permission prompts and file permission checks. If a protection is in the way, explain why in an issue.

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## Names

The Caddi name and logo are not licensed under MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Forks are welcome but should use a different name and icon for anything they distribute.
