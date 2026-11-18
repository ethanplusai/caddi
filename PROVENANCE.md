# Provenance

This document describes where Caddi's code came from. It is a statement of fact from the project's own records. It is not legal advice and makes no legal conclusion.

## How Caddi started

Caddi began as an experiment after The Browser Company, the maker of the Arc browser, announced that it would stop developing Arc.

During that early phase, a copy of the Arc application's package contents was examined and the application was run to observe how it behaved. A prototype browser was then built, informed by what had been examined and observed.

## What was removed before release

That prototype, its tests, and all of the research records from that phase were removed from this codebase before it was released.

No Arc source code, assets, strings or data formats are included in this repository.

## The current app

The app in this repository was written after that prototype, by the same project. Its interface was redesigned from scratch, and its annotation tool was written independently.

Some of its tab organisation behaviour (pinned and favourite tabs, and how inactive tabs are archived) carries over from the prototype's design, which was informed by the observations described above. This is behaviour only; it shares no code or assets with Arc.

The third-party software that Caddi uses is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Affiliation and trademarks

Caddi is not affiliated with or endorsed by The Browser Company. Arc is a trademark of The Browser Company.

## Reporting a concern

If you believe something in this repository should not be here, or that this document is inaccurate, please open an issue on the repository and describe what you found and where. We will look into it.

## Future contributions

Contributions must be the contributor's own original work, or compatibly licensed work recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Material taken from other browsers or closed-source products is not accepted. See [CONTRIBUTING.md](CONTRIBUTING.md).
