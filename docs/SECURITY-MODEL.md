# Security model

Caddi lets coding agents look at and operate web pages on your machine. This document explains what that is designed to protect, how the code does it, and where the protection stops.

Caddi is an early development preview. It has not had an independent security review. Do not rely on it to protect high-value accounts.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What we are protecting

- **Your sign-ins and site data** in each workspace.
- **Secrets on pages**: passwords, one-time codes, card numbers, API keys.
- **Vault passwords**, from agents in particular.
- **Your control of the browser**: an agent should only act where and when you allowed it.
- **Your other workspaces**: access to one project must not leak into another, or into personal browsing.

## Who we assume might misbehave

| Actor | Assumption |
| --- | --- |
| Web pages | Untrusted. A page may be hostile and may contain text written to mislead an agent. |
| A connected agent | Partly trusted. You approved it, but it may be confused, buggy or steered by page content. It must not exceed its grant. |
| Other local processes run by the same user | Not defended against in general. They can read the data directory. They cannot use an agent session without your approval in the app. |
| Other users on the same Mac | Kept out by file permissions on the data and socket directories. |
| The network | Out of scope beyond what Chromium provides. Agents connect over local Unix sockets, not the network. |

## Protections in the code

### Process sandboxing

Every page runs in a sandboxed renderer with context isolation and no Node integration (`desktop/engine.mjs`). The browser's own interface is also sandboxed, is served from a private `caddi://` scheme, and has a content security policy that blocks remote scripts, remote connections and frames (`desktop/app.mjs`). The interface window refuses to navigate or open new windows.

The page preload exposes nothing to page script. It does not use `contextBridge` and adds nothing to `window`. Each preload instance has a random nonce, and main ignores messages that do not carry it.

### Per-workspace storage partitions

Each workspace has its own persistent Electron session partition (`desktop/profile-paths.mjs`), so cookies, local storage, IndexedDB, service workers and cache are separate. The directory name is derived from an internal identity ID. No page, agent or imported file can choose it. Profile directories must be owned by the current user, have no group or other permissions, and contain no symlinks in their path, or the app refuses to open them.

Private windows use a throwaway in-memory session with no disk cache, and are never offered to agents.

### Approval, scopes and expiry

An agent has no access until the owner approves a specific request in the app, after comparing a code shown on both sides (`desktop/enrollment.mjs`, `desktop/access.mjs`). The code is shown, not typed: it confirms which request is being approved. The grant names one workspace, a list of origins (which may be empty), and observe-only or control. One click approves the defaults: the current project workspace, control, the sites already open there, and no screenshots or saved logins. A request expires after ten minutes. The grant lives in memory, lasts at most eight hours, and is not restored after a restart.

Every request is checked in `access/policy.mjs` against the session, workspace, operation, tab and origin. A navigation needs both the current page and the destination to be inside the granted origins. When an agent with control tries to open a site outside them, the navigation is refused and Caddi asks the owner about that one site; only **Allow** adds it to the grant, for the rest of the session. Personal workspaces and archived workspaces are always refused. Failures return a generic `ACCESS_DENIED` so that the reason does not leak information.

Agents can only navigate to `http` and `https` URLs without embedded credentials.

### Control leases

Changing a page needs the workspace's exclusive input lease (`access/control.mjs`). Only one controller can hold it. A lease lasts at most 30 seconds at a time, is tied to one connection and one grant, and has a number that increases every time it changes hands. An action carrying an old number is rejected. Leases are never written to disk.

A successful action renews the lease for its own length again, keeping its number, but never past five minutes after it was acquired and never past the grant's end. Renewal never revives an ended lease. The owner's input on the page, **Take over** in the toolbar, **Pause agents**, revoking the agent and the Mac locking all end it at once, whatever its renewal limit.

The last check happens as late as possible. Immediately before the page preload touches the DOM, it makes a synchronous call to main, which re-checks the grant, the lease, the deadline and the privacy state. There is no asynchronous gap between that check and the action.

### Sensitive-field rules in the page preload

`desktop/page-preload.cjs` decides what an agent can see and touch on a page. An element is treated as sensitive, and is skipped entirely, if it or any enclosing element or shadow host:

- is marked `data-caddi-private`, `data-private` or `autocomplete="off"`
- is an input of type `password`, `hidden` or `file`
- has a `name`, `id` or `autocomplete` value matching words such as password, secret, token, otp, one-time, credit, card-number, cvv, cvc, ssn, recovery or api key

Other rules:

- Observation never returns text field values. Labels come from `aria-label`, placeholder, `<label>` text or visible text, capped at 256 characters. It does report whether a checkbox, radio or switch is checked, the chosen option and the option labels of a select (at most 30), and the value of a slider: these are choices on the page, not typed text.
- Observation covers the main frame, open shadow roots and same-origin frames, and returns at most 150 elements per call (80 by default), with an offset to page further. A same-origin frame inherits the sensitive rules of the element that holds it. Frames from other sites are counted, never entered.
- `fill` only works on text areas and inputs of type text, search, email, tel, url or number.
- Before a click or fill, the element must still be connected, in the same place, with the same label, enabled, and the topmost element at its centre. Otherwise the action fails.
- The human element picker ignores sensitive elements too, and does not capture iframes, canvases or videos as elements.
- Deeply nested shadow DOM (more than 16 levels) is treated as sensitive.

There is no agent tool for running script in a page, reading cookies or storage, or using the DevTools protocol. A wait for text or an element takes plain text and a role, never a CSS selector, because attribute selectors could test the characters of a field's value.

### Agent input

`caddi_hover`, `caddi_press_key`, `caddi_type`, `caddi_drag` and point clicks send real input with `webContents.sendInputEvent`, so pages see trusted events. Element clicks, fill and select keep using the DOM, as before.

- **Validated three times.** Every argument is checked by exact shape in the MCP client, the dispatcher and the engine (`desktop/agent-input.mjs`): one element or one point, allowed keys only, bounded printable text without line breaks.
- **Allowed keys only.** Enter, Escape, Tab, Backspace, Delete, the arrows, Home, End, Page Up, Page Down, Space, the same with Shift for movement and selection, Alt with the left and right arrows and Backspace, and Meta+A. There is nothing with Control, and nothing else with Meta, so no clipboard, browser, app or system shortcut can be sent. Meta+A is carried out as the page's own select-all command, and only when the page did not handle the key itself and a text field has focus. Input goes to the page's own view, not to the window or Caddi's interface.
- **Checked before and after authorization.** The target is checked in the page layer, then the synchronous authorization runs, then it is checked again in the same task. A protected, moved, covered or missing element is a plain refusal.
- **Guarded while it arrives.** Real input reaches the page a moment after the check. Before it is sent, the page layer arms a capture-phase guard, registered before any page script: a mouse press, release or click that would land outside the intended element or on a sensitive one, and a key press or typed character while focus is on a sensitive field, on another field than the one being typed into, or inside a frame from another site, is stopped and not delivered. The action then reports an uncertain outcome. In a same-origin frame the guard is added when the action starts, so listeners that frame's own page registered earlier on its window see an event before the guard does.
- **Owner input still wins.** The owner's own key or mouse press on the page ends the agent's lease, as before. Agent input is recognised by being sent synchronously from the main process and does not end it.
- **Points need screenshots.** An x, y point instead of an element is accepted only for an agent the owner allowed screenshots. A point on a sensitive field, on Caddi's own layers or on a frame from another site is refused.
- **Drags never start a system drag.** Native drag and drop is cancelled while an agent drags, so no operating-system drag session starts from synthetic input.

### The agent cursor and who is driving

Before an action, the page layer draws a cursor with the agent's name in a closed shadow root and moves it to the target; the action runs after it arrives. The cursor takes no pointer input, never takes focus, has no size in the page's layout, fades a few seconds after the last action, and is removed when the lease ends for any reason. The toolbar names the agent that holds the workspace's lease, with **Take over**, which revokes the lease through the same path as the owner's own input. The name is the one the client sent and is not verified, like everywhere else.

### Screenshots for agents

`caddi_screenshot` is a separate permission. The owner ticks **Can see the page (screenshots)** when approving an agent; it is off by default, works in either mode, and a grant without it gets `SCREENSHOTS_NOT_ALLOWED`. It obeys every other rule: granted origins only, the exact current target, **Pause agents**, no private windows, and only the tab shown in a visible window.

Before capture the page layer lists the viewport boxes of every element the sensitive rules flag (including all of a `data-private` region and text that overflows a field) and of every embedded frame, using the same rules as Annotate screenshots. It lists them again after capture; if the page scrolled, resized or the boxes moved, nothing is returned. The boxes are painted over in opaque grey in the bitmap before it is encoded. The agent cursor is hidden for the capture.

### Reading page content

`caddi_read_page` and `caddi_extract` let an approved agent read what a page says. They are observation: they need only Observe access and no lease, and they pass every check `caddi_observe` passes, through the same dispatcher, at request time, at the page layer's final fence and again before the reply leaves Caddi: the grant and its expiry, granted origins only, the exact current target, **Pause agents** and the privacy counter, revocation, never a personal workspace and never a private window. There is no selector, no script and no URL argument: an agent reads the whole page, its main content or one element it already observed, in a tab it was granted, and Caddi never fetches anything on its behalf. Every read is shown to the owner for a few seconds in the toolbar ("… is reading this page") and in the sidebar's agent list.

What reading exposes: the visible text of the page, link addresses (with any user name and password removed; a link back into the same page drops the page's query string), image alt text and addresses, table cells, form field labels and select option labels, and head metadata. The page's own address is returned without its query string and fragment, as everywhere else.

What reading never returns, enforced in the page preload by one extractor (`desktop/page-extract.mjs`, copied literally into the preload and compared by a test):

- **No values.** Text inputs, text areas, selects and editable regions are never read: fields appear only as a label and a type (in `forms`), editable regions not at all. This is the same for the owner's own **Copy page as Markdown**.
- **Nothing sensitive.** Anything the sensitive-field rules cover is skipped whole, including fields Caddi filled from a saved login. If the page shows a saved password anywhere, reading is refused with `LOGIN_SECRET_EXPOSED` before authorization, under the same check as observation.
- **Visible content only.** Skipped whole: `display: none`, `visibility: hidden`, zero opacity, `aria-hidden`, the `hidden` attribute, screen-reader-only and clipped boxes, boxes moved off the page, closed `<details>`; text smaller than a pixel or fully transparent; `<script>`, `<style>`, `<noscript>`, `<template>`, comments, SVG and media fallbacks. This also limits prompt injection hidden in text a person cannot see.
- **No other sites.** Same-origin frames and open shadow roots are read and marked; frames from other sites and closed shadow roots are not entered and are only counted.
- **Bounded.** At most 40000 nodes, about one second of work and 200000 characters in the page, with a `truncated` flag rather than a hang; each reply carries at most 40000 characters.

**Page content is untrusted.** The tool descriptions say so, and every result leads with that line. Page text cannot change the structure of the result: control, bidi and zero-width characters are removed and whitespace is collapsed; Markdown punctuation in page text (including link brackets and table pipes) is escaped, and a line can never start a heading, list, quote or fence; code blocks use a fence longer than any run of backticks inside them; single texts, link texts and URLs are capped; links with any scheme other than `http`, `https` and `mailto` (so never `javascript:` or `data:`) are dropped and keep only their text. The MCP client puts the Markdown between markers with a fresh random tag, so text in the page cannot pretend to end it.

### Privacy pause

**Pause agents** in the toolbar blocks agents in one workspace. It revokes the current lease, tells every active observer to stop, and waits for each to acknowledge before the page is shown to you again (`beginPrivacyBarrier` in `access/control.mjs`). If an observer does not acknowledge in time, the workspace stays blocked. While it is blocked, observation, control and new history entries for that workspace are refused. Resuming changes the workspace's privacy counter, so targets and observations an agent held from before no longer work.

The same pause is applied to every workspace when the Mac locks, sleeps, or the login session becomes inactive (`desktop/system-lifecycle.mjs`). After unlock the owner must choose Continue.

Using the element picker for a page note also pauses agent input in that workspace while you are choosing.

### Link review

Links that arrive from other apps (when Caddi is the default browser or is passed a URL) are never opened automatically (`desktop/external-links.mjs`). They go into a short review queue of at most eight links, which expire after ten minutes. You choose the workspace each one opens in, or dismiss it. Only well-formed `http` and `https` URLs without embedded credentials or control characters are accepted. This stops another app from dropping a link into a workspace where you are signed in, or where an agent has access.

### Permission prompts

Site permission requests are denied unless you approve them in Caddi's own dialog (`desktop/site-permissions.mjs`):

- Notifications, camera and microphone can be requested. Everything else, including screen sharing and location, is denied. Links to other apps (`mailto:`, `tel:` and app schemes) are never opened; Caddi says so instead.
- Camera and microphone are only available in personal workspaces, and macOS consent is still required.
- An approval is bound to the exact page that asked. If the page navigates first, the approval is discarded.
- A link you just clicked with `target=_blank`, Command or the middle button, or a `window.open` without window features from that click, opens as an ordinary tab in the same workspace with no opener. One click opens at most one tab, and agent input never does.
- Other pop-ups are blocked by default, with a notice. You can allow one pop-up for 30 seconds. Pop-up windows are outside agent access, and giving an agent control cancels pending pop-up grants.

### Local sockets

Agent connections use Unix sockets in a directory with mode `0700` owned by the current user (`access/socket.mjs`). The app refuses to create a socket if any parent directory could be replaced by another user, and never reuses an existing socket path. The approved client receives a one-time credential over the enrollment connection. It is never written to disk, passed on a command line, or printed.

### Page notes

A note is only readable by an agent after you send it to that agent. The grant covers that one note at that one revision and its attachments. Drafts and notes for other agents or workspaces are not readable.

An agent can fetch a sent note two ways: by reference with `caddi_receive_feedback`, or pushed through `caddi_live_wait` while it is waiting. Both go through the same receive path (the feedback gateway, the delivery's own grant, the recipient session check and the workspace's privacy state), and both record the same receipt. The wait tool only offers notes this session has not fetched, and records the receipt as the very last check before its reply is written, so a note is marked received only when the reply leaves; a note already handed to a pending reply is held back from any other call. A wait in another workspace, by another session, while agents are paused, or after the session is revoked or expired gets nothing. Deleting a note before the agent has it cancels the delivery and revokes its grant; a received note cannot be deleted. Sending again creates a new delivery with its own grant.

### Live mode

Live sends what the owner says, and what the pointer is on, to one agent session while the owner keeps it on.

- **One recipient, same grant discipline.** Instructions go only to the agent session the owner chose, and only while that session's workspace grant is live. Every `caddi_live_wait` call, and the reply just before it leaves, re-checks the session, the grant and the workspace's privacy state. Revoking, pausing, expiry, disconnecting or the Mac locking ends Live at once; a waiting call is answered "ended" and gets nothing more. Another agent in the same workspace gets nothing.
- **The page cannot steer it.** The pointer layer runs in the isolated preload, takes no clicks or keys, and reports an element only by the same description Annotate uses: its name, a short path of ids, classes and test ids, and a source file when the page exposes one. Form values are never read. A sensitive field (the same rules as above) is reported only as "private", with nothing about it. Live stops if the page navigates to a site the agent was not granted.
- **Audio stays on the Mac.** Only the owner's Caddi window can use the microphone, and only while Live is on (or a voice note records). The chrome cuts speech into utterances of at most about 20 seconds and hands each to the main process, which writes it only to the private temporary directory used for voice notes, transcribes it with the pinned whisper.cpp program and model, and deletes it. Pausing agents stops the microphone and waits for the window to confirm it stopped.
- **Memory only.** Live sessions, the pointer trail and instructions are kept in memory and end with the session. When the owner presses Stop (or Live stops because the tab, workspace, window or site changed), instructions the agent has not collected are held in memory for that same session and grant for up to ten minutes; pausing agents, revoking or disconnecting drops them. For the Sent list, a summary of each session (the agent, the page title and address, times, and how many instructions were sent and received, never the words) stays in memory until Caddi quits.

### The Board

Each workspace's Board (notes, links and images the owner collects) is stored on this Mac under `boards/` in the data folder (`desktop/board.mjs`). An agent can read it only for the workspace it was granted, with that grant, and not while agents are paused there (`desktop/access.mjs`). Adding a note needs control, and the note is marked with the agent's name. Board access is not limited by the granted origins or the screenshot option: an agent of that workspace sees every card, including link addresses and snapped pictures of pages from any site. Keep private material off a board that agents can read.

### Vault

The owner can keep the logins a project needs in the Vault, per workspace, and fill them into a sign-in form. An agent the owner allowed can ask Caddi to fill one without seeing the password. Every use and every agent attempt is recorded for the owner.

**Where things are stored.**

- **The password** is one generic-password item in the user's **login keychain** (the file-based macOS keychain, not the iCloud Keychain), written by the hash-pinned native addon in the main process (`platform/keychain-addon.m`, `platform/login-secrets.mjs`). Service: `build.caddi.logins.release`, `build.caddi.logins.development` (the packaged development bundle) or `build.caddi.logins.source` (a source run), so builds never see each other's items. Account: the login's random ID. Label: "Caddi saved login". The addon accepts exactly these three service names (no test or other prefix, in any build), never enumerates, never touches another keychain, never asks macOS to unlock the keychain and runs with authentication UI disabled: a locked keychain is reported as locked, never prompted for. Items in the file-based login keychain do not sync through iCloud. Automated tests and smokes use an in-memory stand-in and never touch the real keychain.
- **The metadata** (ID, workspaces, exact site origin, username, label, created, updated and last-used times, and the "Agents may use this login" switch) is `logins/logins.json` in Caddi's data folder: versioned, written atomically, mode `0600` in a `0700` folder, and never containing a password (`desktop/logins.mjs`). A damaged file is left unchanged and saving is refused, never reset.
- **The shell** (the interface's web page) receives metadata only. The one password it ever holds is the one the owner is typing into the Add or Edit form; it is read once on submit, sent to the main process and cleared from the field. **Copy password** and **Show** first ask macOS for a fresh check that the owner is present (Touch ID or the account password, `LAPolicyDeviceOwnerAuthentication`); Copy writes the clipboard from the main process and clears it after a minute if nothing else was copied, and Show displays the password in a native sheet from the main process, never in the shell page.
- A keychain item whose metadata is gone is ignored, never searched for or cleaned up. Metadata whose keychain item is gone is shown as "Needs its password again" and never offered to agents.

**Filling.** A fill, by the owner from the toolbar key or by an agent, goes from the main process to that page's isolated preload only, and only after the main process has checked that the page's origin is the login's exact origin (scheme, host and port; no subdomains) on `https` or on `localhost`, `127.0.0.1` or `[::1]`. The preload checks the origin again and fills only when the top document (never a frame or shadow root) has exactly one visible, enabled `type=password` field, plus the visible username or email field before it. Nothing is filled when a page loads; the owner clicks the key, or an agent asks. Private windows never show saved logins.

**What an agent can do.** Both the approval option **Can use saved logins for this workspace** and the login's own switch must be on. `caddi_logins` returns ID, site, label and username only, for this workspace and the granted sites. `caddi_fill_login` takes a login ID and nothing else, needs control and the current lease and target, and goes through the same dispatcher, admission and synchronous final fence as every other page action. The trusted login check runs at each full page check: the option, the switch, the exact origin inside the grant, and the owner's confirmation. The first use by each session waits for the owner in the attention queue (Allow once, Allow for this session, Don't allow); a pending request ends after about two minutes. Allow once is used only at the final fence. Pause agents, the Mac locking, revoking and grant changes withdraw requests and allowances; Take over ends the lease. Personal workspaces cannot be granted at all.

**What an agent cannot do after a fill.** A field Caddi filled stays sensitive for the life of that document, whatever the page later does to its type or attributes, so observation never lists it, `caddi_fill`, `caddi_type`, `caddi_press_key` and point clicks cannot reach it, screenshots blank it, Live reports it as private and Annotate refuses it. After an agent's fill, if the page turns the field into plain text, Caddi empties it. If the password then appears anywhere else in the top document (text, another field's value, a title, label, placeholder or alt text), agent observation, waits and screenshots of that page are refused (`LOGIN_SECRET_EXPOSED`), Live and Annotate treat the page as private, and an agent-filled field is emptied. Navigating away ends the document; the agent can only navigate to granted origins.

**The access log.** Every attempt to use a login is recorded per workspace: the owner's fill, copy and show, and every agent fill request with its outcome (filled, waiting for you, or refused and why: switch off, not approved, view-only, first use declined, site mismatch, paused, password shown on the page, no control, keychain locked, and so on). An entry holds the time, the login's site, label and username, who (you, or the agent's name as its connection showed it when you approved it), what was tried and what happened; never a password. Only logins that exist in that workspace are recorded, so an agent cannot fill the log with invented IDs; repeats within a minute are counted on one entry. The file is `0600`, validated on every read, capped at 1,000 entries, cleared only by the owner, and is not part of any export. No agent operation reads it.

**Offer to save.** After the owner signs in by hand in a project or personal workspace, Caddi offers "Save this login?" (Save, Never for this site, Not now), or "Update the saved password?" when the username matches a saved login and the password differs. The bar says where the login will be saved: the current workspace only, unless the owner picks "All workspaces" on the bar. Rules:

- **Never in a private window**, and never for a preview page. The engine drops the page's report; the app checks the window again.
- **Never from an agent.** Telling the owner's submit from an agent's is done twice. In the page's preload: the password field must have received real typed input while no agent input was armed (agents can never type into password fields anyway), no agent command may be running (an agent's element click submits a form inside its command) or have run in the last 5 seconds, and the field must not have been filled by Caddi. In the main process, from facts the page cannot influence: the owner's last key press or click as the browser process saw it must be within 4 seconds before the report (agent input is sent with a flag and never counts), no agent may hold the workspace's input lease or have a request on that page, and no agent may have acted in that workspace in the last 5 seconds. `isTrusted` alone is not used, because Chromium marks the submit event of a scripted click as trusted, and an agent's point clicks arrive as real input.
- **The password's path.** Caddi does what other browsers do. At the moment the owner submits the form, the preload sends the main process the site, the username and the password, and keeps nothing itself, because the page is usually replaced a moment later. The main process holds the password in memory only, as a buffer, for at most two minutes, so the offer is still there after the next page loads. It is wiped when the owner presses **Save** (after the keychain write), **Not now** or **Never for this site**, when a newer sign-in in the same tab replaces it, when the tab or workspace closes, after two minutes, and at quit. If the main process decides not to offer (private window, an agent involved, the never-save list, already saved), it is wiped at once. It is never written to disk, never logged, and never sent to the shell, a page or an agent: the shell receives the site, username and workspace name only. While an agent holds control of the workspace, Save is refused and the offer stays for the owner to come back to. Copies the page itself made of the typed text, and the short-lived copy in the message between the two processes, are outside Caddi's control, as in any browser.
- **Limits.** Exact https origin (or this Mac over http), at most 1,024 characters, the 500-login limit, one password field with a value in the form (so sign-up forms with a confirm field are not offered), and the never-save list, which the owner can edit in the Vault. Saved and updated logins start with "Agents may use this login" off (an update keeps the existing switch).
- **Where it is saved.** A login saved from the offer goes to the workspace the owner signed in from. "All workspaces" on the bar shares the same login with every other workspace that can hold logins at that moment (never a private window's, never an archived one); a workspace that already has its own login for that site and username keeps it. Workspaces created later do not get it. Each login in the Vault says "Only in this workspace" or "Also in …", and its More menu adds it to another workspace or removes it from this one.
- **What it misses.** Caddi does not check whether the sign-in worked, so the offer also appears after a wrong password; signing in again replaces it. Sign-in forms that send the password without a form submit, and forms split over two pages, are not offered.

**Import.** **Import logins…** opens the native open panel. The chosen file is read once in the main process (a regular file, not a link, at most 5 MB, UTF-8), never copied, parsed strictly in memory (RFC 4180 quoting, embedded commas and line breaks, a leading BOM; refused: stray quotes, unterminated quotes, NUL, more than 5,000 rows or 64 columns), and the format is recognised from the header row only. The owner sees a review first (site, username, whether each row will be imported or why not) and chooses the workspace; nothing is stored until **Import logins**. Passwords stay in main-process Buffers until import or cancel (at most 15 minutes) and are then wiped; the strings parsed from the file cannot be wiped and are left to the garbage collector. Only https sites (and this Mac over http) are imported. Imported logins start with agents off. Caddi then tells the owner to delete the export file, which holds every password in plain text; Caddi does not delete it.

**Which agents could use a login.** Each login in the Vault lists the agents connected to its workspace and, in the order Caddi enforces it, whether each could use it now and why not: the approval option, control access, the login's switch, the site being in the agent's grant, the keychain item, Pause agents, and the owner's first-use answer. The switch is per login, not per workspace: a login shared into two workspaces is usable by agents in both when it is on, and the Vault says so. Agents never work in personal workspaces.

**Reveal and copy.** Show and Copy ask macOS for a fresh user-presence check (Touch ID or the account password) every time. If the build cannot do that check, Show and Copy are not offered at all. Copy clears the clipboard after 60 seconds if it still holds that password.

**What this does not protect against.**

- **The site itself.** Page script on the login's own site can always read what is in its own form, including a password Caddi filled, and can send it anywhere it likes. Caddi's protection is against the agent, not against the site. Only save logins for sites you trust with that password anyway.
- **A hostile page on the right origin.** A page on the exact origin can show a fake sign-in form and receive the password when the owner or an allowed agent fills it. Exact-origin matching limits this to that origin.
- **Copies the page hides from the check.** The copy check covers the top document's text, field values and common attributes. A page can still copy the password into a canvas, a closed shadow root, a frame, CSS, a cookie or a network request, where Caddi does not look. Screenshots can then show what the page drew.
- **Same-user processes.** Another program running as you can ask the login keychain for Caddi's items; macOS may ask you to allow it, and the item's access list trusts the app that created it. A source run's app is the development Electron binary, which other source checkouts share.
- **Memory.** The password crosses into the page's renderer as a JavaScript string to be filled, and the page preload keeps a copy for that document's life for the copy check; neither can be wiped. Main-process buffers are wiped after use.
- **"Accessible only when unlocked."** The login keychain is unlocked while you are logged in, unless you set it to lock on sleep or after a time. Caddi also stops agent work when the Mac locks or sleeps. The data-protection keychain's per-item "when unlocked, this device only" class needs a signed app with a keychain entitlement, which development builds lack, so it is not used.
- **Not independently reviewed, and the signed release has not been checked against the real keychain.** The keychain path was checked once by hand on a development Mac with a throwaway item (under a test service name the addon no longer accepts); everything else is tested against the in-memory stand-in.
- A just-typed password waits in the main process's memory for up to two minutes while the save offer is open, as in other browsers. It is not on disk and nothing outside the main process can read it, but a process that can read Caddi's memory could. The offer also appears after a failed sign-in, because Caddi does not check whether it worked.

### Stored state

Workspace metadata is validated strictly on load and has a checksum and a backup. A damaged file is never silently reset. Imported workspace files and bookmark files are reviewed before anything is added, and never carry site data, credentials or agent access.

## Known limits

- **Annotate screenshots are masked best-effort.** Before a screenshot is sent with page notes, Caddi covers password, payment and other private fields with opaque boxes and skips any crop that touches one. It cannot see text drawn on a canvas or inside a page's closed shadow root, so sensitive content shown that way can still appear in the image. If masking cannot be confirmed, no image is sent.
- **Annotate does not reach inside iframes**, and a page showing its own modal dialog blocks the note layer.
- **Annotate ends itself on pages that restyle the root element** (opacity, transform or filter on `<html>`), because that is also how a page would try to move the notes bar under your cursor. Your notes are kept.
- **Live trusts its own pointer layer only as far as the page lets it.** A page can hide the highlight, or place elements so the pointer lands on something misleading. It cannot add elements to an instruction that were not under the pointer, or read what was said. The source file and component names come from page script and are treated as untrusted text.
- **Live speech goes to the agent as said.** Whatever the owner says while Live is on is sent, including things said to someone else in the room. Stop Live, or pause agents, before a private conversation.
- **Not independently reviewed.** The protections above are covered by the project's own tests only.
- **Builds you make yourself are unsigned.** A source run or a plain `npm run package:caddi` bundle is not code signed or notarized, so macOS cannot verify where it came from. The build on the website's download page is signed with a Developer ID and notarized.
- **Same-user processes.** Anything running as your user can read the data directory, including site cookies in the workspace partitions. Site data is not encrypted by Caddi.
- **Storage partitions, not separate browsers.** Workspaces are separated by Chromium session partitions inside one app. This is weaker than separate OS users or separate browser installs. Browser fingerprint, IP address and installed fonts are shared.
- **The sensitive-field rules are heuristics.** A site that renders a secret as ordinary visible text, or names a secret field unusually, can expose it to `observe`. Visible page text near headings, links and buttons is readable by design.
- **Reading shows what a person could read.** `caddi_read_page` and `caddi_extract` return the visible text of granted pages, including names, email addresses, messages and anything else shown as ordinary text, and text a page copied out of a field into ordinary text. Hidden-text detection covers CSS hiding, clipping, zero size, off-page boxes, tiny fonts and transparent colour, but not text coloured like its background or covered by another element. Content that is faded out until it scrolls into view (opacity 0) is skipped as invisible. Same-site links keep their own query strings, which can carry tokens.
- **Prompt injection.** Page text is passed to the agent as data. Caddi limits what an agent can do, but it cannot stop an agent from being misled by what it reads. Keep origin lists short.
- **Within a granted origin, control is broad.** An agent with control can click anything non-sensitive on that origin, including buttons that delete or submit.
- **Cross-origin frames and closed shadow roots** are not inspected, so agents cannot see or act inside them. The human can. Embedded frames, including same-origin ones, are blanked in agent screenshots.
- **Screenshots can contain anything visible on the page** that the masking rules do not flag: names, email addresses, messages, account numbers shown as ordinary text, text drawn on a canvas or inside a closed shadow root, and Caddi's own Annotate or Live layers if they are open. Masking is the same best-effort heuristic as for Annotate. Only allow screenshots for agents and sites where that is acceptable.
- **The input guard is best effort in same-origin frames**, where a page's own earlier window listeners see an event before the guard. In the main frame the guard runs first.
- **A key can reach a frame from another site** if a page moves focus into it in the moment between the check and the key arriving. The guard in the main frame cannot see that frame. The key is the agent's own, not the owner's data.
- **Hover is not guarded against landing elsewhere.** Moving the mouse cannot be cancelled; a page that moves content under the point in that moment gets a mouse move on another element. Hover activates nothing by itself.
- **Client identity is not verified.** The agent's display name is whatever the client sent. The comparison code confirms which request you are approving, not what program sent it.
- **No passkeys, sync, password generation or browser extensions.** The Vault is Caddi's own, per workspace, on this Mac. It can import a CSV from other password managers but does not talk to them. There is no Secure Enclave or post-quantum storage beyond what the login keychain itself does.
- **Service connections** cannot use real credentials yet, because protected credential storage is not finished.
- **Engine updates.** Chromium security fixes arrive only when the pinned Electron version is raised and you update your checkout. There is no automatic update.
