## What this changes

<!-- What a person using Caddi will notice. One topic per pull request. -->

## Why

<!-- What made the current behaviour wrong or not enough. Link the issue if there is one. -->

## How it was tested

<!-- Paste the commands you ran and their results, and say what you could not test. -->

```
npm test
npm run test:desktop:workspaces
```

## Checklist

- [ ] One topic, and the diff is as small as that topic allows.
- [ ] Tests added or updated when behaviour changed.
- [ ] `npm test` and `npm run test:desktop:workspaces` pass.
- [ ] If this touches the page engine, agent access, the page preload or the interface: `npm run test:desktop` and `npm run test:ui` pass.
- [ ] No protection was weakened to make a test pass (sandbox, content security policy, sensitive-field rules, permission prompts, file permission checks).
- [ ] Fixtures are synthetic and served from `127.0.0.1`. No real accounts, credentials or browsing data.
- [ ] Anything reused from elsewhere is compatibly licensed and recorded in `THIRD_PARTY_NOTICES.md`. Nothing comes from another browser or a closed-source product.
- [ ] No tokens, cookies, profile folders, `.env` files or build output are committed.
