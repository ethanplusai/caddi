# Architecture

Caddi is an Electron app written in plain ES modules. There is no build step and no runtime npm dependency other than Electron itself. All application code lives under `src/caddi` (the directory keeps an earlier internal name).

This document describes the processes, what each one is trusted to do, the state model, and where data is stored.

## Processes and trust boundaries

```
 coding agent (Claude Code, Codex, Cursor, ...)
        |  MCP over stdio
        v
 +---------------------------+
 | MCP client process        |   scripts/caddi-desktop-client.mjs
 | (started by the agent)    |   no authority until the owner approves it
 +---------------------------+
        |  Unix sockets in a private 0700 directory
        v
 +-------------------------------------------------------------+
 | Main process (trusted)                 src/caddi/desktop     |
 |  state store . access policy . control leases . page engine |
 |  enrollment + broker sockets . services . feedback store    |
 +-------------------------------------------------------------+
        |  IPC (validated actions)        |  IPC (nonce + sync authorize)
        v                                 v
 +---------------------------+   +-------------------------------+
 | Chrome UI renderer        |   | Page renderers (untrusted)    |
 | sidebar, toolbar, dialogs |   | one per tab, sandboxed,       |
 | sandboxed, strict CSP     |   | per-workspace storage         |
 +---------------------------+   | + isolated page preload       |
                                 +-------------------------------+
```

### Main process

`src/caddi/desktop/main.mjs` is the entry point. It sets up private data directories, takes the single-instance lock, and calls `createDesktopApp` in `app.mjs`. The main process owns every decision that matters:

- the workspace and tab metadata (`state/`)
- the page engine that creates and destroys web pages (`desktop/engine.mjs`)
- the access policy, control leases and privacy state (`access/`)
- the local sockets that agents connect to (`access/socket.mjs`, `desktop/enrollment.mjs`)
- site permission prompts, downloads, history, link review

Nothing outside the main process can grant access, change scopes or read credentials.

### Chrome UI renderer

The browser's own interface (sidebar, toolbar, dialogs) is a web page loaded from a custom `caddi://app/` scheme with a strict content security policy: scripts and styles only from itself, no remote connections, no frames. It runs sandboxed with context isolation and no Node integration.

It talks to main through a small bridge in `desktop/preload.cjs`: read a state snapshot, subscribe to state changes, and send an action. Every action is a plain object with a `type`. Main checks the sender, checks the exact set of fields allowed for that type (the `shapes` table near the top of `app.mjs`), and then validates the values. The renderer is treated as a view. It holds no authority of its own.

### Page renderers

Each tab is an Electron `WebContentsView` with `sandbox: true`, `contextIsolation: true` and no Node integration. Web content is untrusted.

Every page gets `desktop/page-preload.cjs`, which runs in an isolated world. It exposes nothing to the page: no `contextBridge`, nothing on `window`. It only acts in the main frame. It does three things on request from main:

- **observe**: list headings, links, buttons, fields, checkboxes, selects and ARIA widgets with labels, positions and state, in the main frame, open shadow roots and same-origin frames, filtered and paged (80 at a time by default), skipping sensitive fields and never including text field values
- **act**: click, fill, select, scroll or scroll into view a previously observed element, after re-checking that it is still there, unchanged, enabled and not covered. For hover, keys, typing, drags and point clicks it arms a capture-phase guard and the main process then sends real input with `webContents.sendInputEvent`; the guard refuses any of that input that would land on a different or sensitive element, and reports what arrived
- **show the agent**: draw the agent cursor in a closed shadow root before each action, and report the boxes to blank before a screenshot
- **read**: turn the visible page, its main content or one observed element into Markdown, or extract links, tables, headings, metadata or form fields, for an agent (`caddi_read_page`, `caddi_extract`) or for the owner's Copy page as Markdown. The extractor is a pure function in `desktop/page-extract.mjs` over a small view of the tree; the preload carries a literal copy (compared by a test) and supplies the view: the real DOM with the sensitive-field rules, computed visibility, open shadow roots and same-origin frames. The fixture engine runs the same function over plain object trees.
- **pick**: let the human click an element or drag a region for a page note

Before any observe or act command touches the DOM, the preload makes a synchronous call back to main to confirm the request is still authorized. Main re-checks the agent's grant, lease and the workspace's privacy state at that moment.

### The local broker and the MCP client

Agents do not connect to the app over the network. The main process listens on two Unix sockets inside a per-run directory that only the current user can read:

- an **enrollment socket**, where a new client asks to connect and waits for the owner's decision
- a **broker socket**, where an approved client sends requests using a one-time credential it received on approval

The MCP client (`scripts/caddi-desktop-client.mjs`) is a small Node program that the coding agent starts. It speaks MCP over stdio to the agent and the local socket protocol to Caddi. It translates each MCP tool call into one broker request (`clients/mcp.mjs`). The client never stores a credential on disk.

So the agent can find the app after a restart, main writes a small descriptor file (`mcp/runtime.json` in the data directory) that points at the current enrollment socket. The descriptor contains an address only. It carries no credential and restores no access.

## State model

Workspace organization is plain metadata, defined and validated in `state/model.mjs`:

| Record | Meaning |
| --- | --- |
| workspace | A named space with its own site storage. Kind is `project` or `personal`. |
| identity | The storage identity behind a workspace. Maps to one Electron session partition. |
| group | A named, coloured set of tabs inside a workspace. |
| folder | A nestable folder of tabs inside a group. |
| tab | A saved page: URL, title, optional label, pinned and favourite flags. |
| layout | A two-pane split of tabs. |
| project, worktree, logical task, session | Bookkeeping that ties agent-created workspaces to a task. |

All changes go through `applyProductCommand`, which takes a command such as `tab.create` or `folder.move`, validates it, and returns the next state. Unknown fields are rejected everywhere. Collections have fixed upper limits (for example 128 workspaces and 4096 tabs).

Agent authority is deliberately not part of this model. Every workspace is stored with `agentPolicy: 'human-only'`. Grants, leases and agent sessions exist only in memory and are gone when the app quits.

`state/store.mjs` saves the state as a canonical JSON snapshot with a SHA-256 checksum, plus a backup of the previous snapshot. If the primary file is damaged at startup, the app does not reset it. It asks the owner whether to restore the verified backup and keeps the damaged bytes in a separate file.

## Workspace isolation

Each workspace identity maps to its own persistent Electron session partition (`desktop/profile-paths.mjs`). Cookies, local storage, IndexedDB, service workers and cache are separate per workspace. Being signed in to a site in one workspace does not sign you in to it in another.

- **Project workspaces** can be shared with agents, one approval at a time.
- **Personal workspaces** are human-only. The access layer refuses to grant them to an agent. Camera and microphone requests from sites are only available here.
- **Private windows** use a fresh in-memory session with no disk cache. Their tabs are not written to metadata or history and are never visible to agents. The session is destroyed when the window closes.

History and download records are also kept per workspace.

## Agent access

See [CONNECTING-AGENTS.md](CONNECTING-AGENTS.md) for the user-facing steps. In the code the flow is:

1. **Enroll.** The MCP client connects to the enrollment socket with a display name. Main creates a pending request with a short comparison code and sends the code back to the client, which prints it. A request stays open for ten minutes.
2. **Approve.** The owner sees the request in the app with the same code and approves it with one click. The defaults are the current project workspace, observe and control, the sites already open there, and no screenshots or saved logins. **Change access** lets the owner pick another workspace, change the origin list (which may be empty), choose observe only, or allow the agent to create one new isolated workspace for itself.
3. **Grant.** Main creates an in-memory grant in `access/policy.mjs` bound to that agent session, workspace, set of operations and origins. The session lasts at most eight hours. The client receives a one-time credential and must connect to the broker within 30 seconds.
4. **Dispatch.** Each request is checked against the grant: right session, right workspace, operation allowed, page origin in the list. A navigation to an origin outside the list is refused. For a control session in an existing workspace it returns `SITE_APPROVAL_PENDING` and the owner is asked about that site (`desktop/attention.mjs`); allowing adds the origin to the grant for the rest of the session, and declining returns `SITE_NOT_ALLOWED` from then on.
5. **Lease.** Reading (`page:observe`, `page:wait`, `page:screenshot`, `page:read`, `page:extract`) needs no lease. Anything that changes a page also needs the workspace's exclusive input lease (`access/control.mjs`). A lease lasts at most 30 seconds at a time; each successful action renews it for its own length again, up to five minutes after it was acquired. Only one controller can hold a workspace at a time. Agent argument rules (allowed keys, typed text, the shape of each operation's payload) live in `desktop/agent-input.mjs` and are checked in the client, the dispatcher and the engine.
6. **Revoke.** The owner can revoke an agent at any time. Grants also end on expiry, on client disconnect, when the workspace is archived, and when the app quits. Revoking a grant aborts the lease and any request in flight.

Two more mechanisms can stop an agent immediately:

- **Pause agents** (the `privacy.enter` action) blocks observation and control in one workspace, revokes its lease, and waits for any active capture to confirm it has stopped before showing the page to the human. Resuming bumps a privacy counter, so every target an agent held from before is stale.
- **System pause.** When the Mac locks or sleeps, authority is paused across all windows. After unlock the owner must choose Continue, and agents need fresh leases.

## Vault

The Vault (the feature; one entry in it is a login) is split across three layers, so a password is only ever in the main process, the keychain and the one page being filled. Internal names still say "logins" (`logins.mjs`, `logins.*` actions, `caddi_logins`).

- **Secrets: `platform/login-secrets.mjs` and `platform/keychain-addon.m`.** `createKeychainLoginSecrets` wraps the hash-pinned in-process addon (`loginItem`: set, get, exists, delete; `userPresence`). One generic-password item per login in the user's login keychain: service `build.caddi.logins.release`, `.development` or `.source` (chosen in `desktop/main.mjs` from the build), account = login ID. The addon accepts exactly those three services, has no enumeration and no authentication UI, and refuses a locked keychain. `createFakeLoginSecrets` is the in-memory stand-in with the same interface; every automated test and smoke uses it (`build.caddi.test.*` names exist only there).
- **Metadata and owner operations: `desktop/logins.mjs`.** `createLoginStore` keeps `logins/logins.json` (versioned, atomic, `0600`): site origin, username, label, workspaces, times and the agent switch. It adds, edits, deletes, shares and unshares, answers exact-origin matches for the toolbar, lists what an agent may use (`forAgent`), and reads a password only inside `withSecret`, which wipes the buffer afterwards. `desktop/app.mjs` turns the `logins.*` chrome actions into these calls and puts metadata (never a password) in each window's state as `logins`.
- **Owner fill.** `logins.fill` in `app.mjs` checks the tab's exact origin, takes the page back from any agent, reads the secret and calls `engine.ownerFillLogin`, which sends `login:owner-fill` to that page's isolated preload (`page-preload.cjs`). The preload checks the origin again and fills the top document's one visible password field and the username field before it.
- **Agent fill.** `caddi_fill_login` becomes `page:fill-login {loginId}` in the broker. `access/dispatcher.mjs` treats it as a page action (lease, current target, admission, final fence) and calls the `loginGuard` from `desktop/access.mjs` at each full check: approval option, the login's switch, exact origin inside the grant, and the owner's confirmation from `desktop/attention.mjs` (`signIn` / `decideSignIn`; Allow once is used at the final fence). The access layer's adapter then reads the secret and calls `engine.execute` with `page:fill-login`, which sends `login:fill` to the preload. `caddi_logins` (`login:list`) is answered in `access.mjs` from `forAgent`.
- **Access log: `desktop/vault-activity.mjs`.** One file per workspace, `logins/activity/<workspaceId>.json` (versioned, atomic, `0600`, validated on read, at most 1,000 entries, oldest dropped; a repeat of the same attempt within a minute counts on the last entry). Owner fill, copy and show are recorded by `app.mjs` (`ownerLoginUse`); every agent `page:fill-login` is reported by `access.mjs` (`noteLoginAttempt`, through `onLoginAttempt`) with its final code, which `activityOutcome` turns into an outcome and a plain reason. Only a login that exists in that workspace is recorded. A damaged file is left alone until the owner clears it. `retain` deletes logs of workspaces that no longer exist. The log is read only by the `vault.activity.list` chrome action; there is no agent operation for it, and export never includes it.
- **Offer to save: `desktop/vault-offer.mjs`, the preload and `engine.mjs`.** The preload notes password fields that received real (`isTrusted`) input while no agent input was armed and no agent command ran. On a form `submit` it applies `submitOfferable` (a literal copy of the function in `vault-offer.mjs`; a unit test compares them) and, inside the submit, sends `caddi-page:login-offer` with the site, the username and the password. It keeps nothing. `engine.mjs` (`loginOffer`) drops reports from private or preview pages, turns the password into a Buffer (`validOfferReport`) and adds its own facts: the owner's last key press or click as the browser process saw it (`page.activation`, never set by agent input) and when an agent last acted on that page (`page.lastAgentAt`). `app.mjs` (`handleLoginOffer`) applies `offerDecision`: not a private window, a project or personal workspace, no agent lease, no agent activity in the workspace in the last 5 seconds, owner input in the last 4 seconds, the tab's real origin, not on the never-save list, and Update only when the username matches and the typed password differs from the saved one (`samePassword`). An accepted offer goes to `createOfferHolder`: memory only, one per tab, 32 at most, two minutes each, bound to the tab rather than the document so it survives the page load. Every way out wipes the Buffer. **Save** (`vault.offer.save`, with `scope` `workspace` or `all`) takes it, writes the keychain item, wipes it, and for `all` shares the login with every other workspace that can hold logins. **Not now** and **Never for this site** drop it. The never-save list is `logins/never-save.json`.
- **Import: `desktop/vault-import.mjs`.** `vault.import.choose` opens the native open panel, `readImportFile` reads the file once (regular file, not a link, at most 5 MB, UTF-8), `parseCsv` parses it strictly in memory, `detectImportFormat` names the format from the header row, and `reviewImport` marks each row ready or skipped (no https site, no password, duplicate, already saved, over the 500-login limit, malformed). Passwords are Buffers held in the main process for at most 15 minutes and wiped on import, cancel, window close or expiry. The shell gets the review (sites and usernames only). `vault.import.confirm` stores the ready rows through the same `createLoginStore().add`, so each login starts with agents off.
- **Who could use a login: `desktop/vault.mjs`.** `agentAccessForLogin` states, per connected agent and in the order the access layer enforces it, whether it could fill the login now and why. `app.mjs` adds it to each login in the window's state, with the last three uses from the log. The shell (`ui/logins-controls.mjs`) imports the same file for search, grouping by site and activity sentences.
- **After a fill**, the preload marks the field in a `WeakSet` that `sensitive()` checks, empties an agent-filled field that turns into plain text, and refuses agent reads (and makes Live and Annotate private) if the password shows up elsewhere on the page.

## Service connections

`src/caddi/services` contains fixed, read-only adapters for GitHub (repository metadata, issue lists), Vercel (project and deployment lists) and Resend (domain list). The owner fixes the target (for example one repository) when creating a connection. An agent can only call a connection through a separate, expiring service grant, and cannot supply URLs, account names or project IDs.

In the current build these adapters run only against synthetic test backends. Creating a connection with a real credential is disabled until protected credential storage is finished. See [ROADMAP.md](ROADMAP.md).

## Where data lives

A source checkout (`npm start`) keeps its data in `.caddi-development/` at the repository root. A packaged development bundle uses `~/Library/Application Support/Caddi Development/`, and a release build uses `~/Library/Application Support/Caddi/`. Every directory is created with mode `0700` and checked for symlinks and ownership before use.

| Path under the data directory | Contents |
| --- | --- |
| `metadata/` | Workspace, group, folder and tab state, with checksum and backup |
| `electron-session/Partitions/` | One site-storage directory per workspace identity |
| `history/` | Per-workspace visit history |
| `downloads/` | Download records (the files stay where you saved them) |
| `window-session/` | Which workspaces were open in which windows |
| `preferences/` | Appearance and keyboard shortcut settings |
| `mcp/runtime.json` | Address of the current enrollment socket |
| `logins/logins.json` | Vault login metadata. Passwords are in the login keychain, never here |
| `logins/activity/<workspace>.json` | The Vault's access log for that workspace. Never a password; not exported |
| `logins/never-save.json` | Sites where Caddi never offers to save a login, per workspace |
| `boards/<workspace>/` | The workspace's Board: `board.json` and an `images/` folder |
| `electron/` | Electron's own user data |

Sockets and other per-run files live in a temporary run directory that is deleted on quit. Agent sessions, grants, leases and page notes are held in memory only in the current build.

## Source layout

| Directory | Purpose |
| --- | --- |
| `src/caddi/desktop` | Electron main process, page engine, preloads, and the chrome UI (`ui/`) |
| `src/caddi/access` | Policy, leases, sockets, pairing, request dispatch |
| `src/caddi/clients` | Broker client and MCP session used by the MCP client script |
| `src/caddi/state` | Metadata model, store, import and export |
| `src/caddi/feedback` | Page notes: drafts, revisions, deliveries |
| `src/caddi/services` | Read-only GitHub, Vercel and Resend adapters |
| `src/caddi/history`, `downloads` | Per-workspace history and download records |
| `src/caddi/scheduler` | Bounded queue that limits how much page work runs at once. Of macOS memory pressure, only the critical level stops new agent page work (`desktop/resources.mjs`). |
| `src/caddi/platform` | Native keychain addon. Saved login passwords use it in ordinary runs; workspace and service keys through it are still groundwork. |
| `src/caddi/persistence`, `updates` | Groundwork for encrypted storage and updates. Not active in ordinary runs. |
| `src/caddi/contracts.mjs` | Shared error type and input validation helpers |
