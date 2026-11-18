# Security policy

Caddi is an early development preview and has not had an independent security review. We still want to hear about problems.

## Reporting a vulnerability

Please report security issues privately using **GitHub private vulnerability reporting** on this repository: open the **Security** tab and choose **Report a vulnerability**.

Do not open a public issue or pull request for a suspected vulnerability.

A useful report includes:

- what an attacker can do, and what they need in order to do it
- steps to reproduce, ideally with a small local test page
- the commit you tested and your macOS and Node.js versions
- any logs or screenshots, with real credentials and personal data removed

We will acknowledge the report, keep you informed while we investigate, and credit you in the fix if you would like. Caddi is maintained by a small team, so we cannot promise fixed response times.

## Supported versions

Caddi is pre-1.0. Only the latest commit on the `main` branch is supported. Fixes are not backported to older commits or tags.

## Scope

In scope:

- a web page reading or changing data in another workspace
- an agent seeing or doing something outside what the owner approved: another workspace, another origin, a personal workspace or a private window
- an agent acting without a valid approval, after revocation, after expiry, or during a privacy pause
- an agent reading or filling a field the sensitive-field rules are meant to protect
- a web page reaching the page preload, the browser interface, or the main process
- another local user reading Caddi's data or connecting to its sockets
- links from other apps opening without review
- a site getting a permission without the owner approving it

Out of scope:

- vulnerabilities in Electron or Chromium themselves. Please report those upstream. Do tell us if Caddi's pinned version is affected by a published fix.
- anything that needs code already running as the same macOS user, or physical access to an unlocked Mac
- the limits already listed in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md), such as builds you make yourself being unsigned and the sensitive-field rules being heuristics. Concrete bypasses of those rules are welcome.
- an agent being misled by page content into doing something that is inside its approved scope
- social engineering, and denial of service against your own machine

## More information

[docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) describes the threat model, the protections in the code, and known limits.
