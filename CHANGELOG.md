# Changelog

Notable changes to Caddi are recorded here. Caddi is pre-1.0, and anything may change between commits.

## 0.1.5 (2026-11-21)

### Security

- **Other programs can no longer run code as Caddi.** Until now, any program on your Mac could start Caddi's executable as plain Node.js and run its own code with Caddi's identity, which the keychain trusts for Caddi's saved logins. Caddi now switches off those Electron features (run as Node, `NODE_OPTIONS` and the `--inspect` debugger), and the build refuses to finish if they are on.
- **The agent connector runs on its own Node.js.** Coding tools now start the connector with a pinned copy of Node.js 26.13.1 inside Caddi, signed with its own identifier. You still do not need to install Node.js.

### Changed

- **Reconnect your coding tools once.** Tools set up by 0.1.4 or earlier show "Reconnect" in the Agents dialog. Until you do, they report that the connection is out of date.

## 0.1.4 (2026-11-19)

### Fixed

- **Updating from 0.1.2 opens Caddi instead of quitting.** 0.1.3 could not read data saved by 0.1.2 and stopped at a "workspace data needs attention" dialog. Caddi now moves that data, untouched, to a folder named "Caddi (data from an earlier version)" next to its own, starts fresh and says where the old data is. Nothing is deleted.

## 0.1.3 (2026-11-18)

### Changed

- **Agent tool names begin with `caddi_`**, for example `caddi_observe` and `caddi_click`. Reconnect any agent you connected to an earlier version, and update prompts or scripts that name tools.
- **Saved data starts fresh.** Workspaces, tabs and Vault logins from 0.1.2 do not carry over. (In 0.1.3 itself, updating from 0.1.2 stopped at a dialog; 0.1.4 fixes that.)
- **Electron 45.3.2.** Brings the Chromium and Node.js security fixes since 45.0.0.
- Agents see Caddi's real version when they connect.

## 0.1.2 (2026-11-18)

### Added

- **The Board.** Each project workspace has a board for notes, links, pinned and snapped pages, and pasted or dropped images; drag cards to arrange them, and new cards never cover old ones. Open it from the sidebar. Agents read it with `caddi_board`, see an image card with `caddi_board_image`, and add a note marked as their own with `caddi_board_note` (control access only). Live pointing works on board cards too.
- **Live is two-way.** An agent answers with `caddi_live_reply`: its reply shows in the toolbar and the element it means is outlined on the page. Live also tells the agent where inside an image or panel you pointed.
- **One-click connect.** Approving an agent is one Allow with sensible defaults; Change access holds the details. Caddi asks about each new site the agent wants instead of asking for every site up front. Requests stay open for 10 minutes and sessions last 8 hours, and new requests are announced in the sidebar, with a toast and a Dock bounce.
- **Voice in the downloaded app.** The signed build now includes the local speech program, signed and checked against its recorded signed fingerprint.

### Changed

- **Live loses nothing on Stop.** Caddi finishes the phrase you are saying, transcribes what is queued, and keeps any instruction not yet delivered for the agent's next wait. Quiet speech is evened out, and the words on the page help transcription.
- **Live keeps the page full width.** What was heard and the agent's replies sit in the toolbar; the Live panel opens on demand.
- **Agents keep working on a busy Mac.** Only critical memory pressure stops new page work.

### Removed

- **Caddi Chat.** Caddi has no AI of its own. It is a browser for the coding agent you already use, connected over MCP.

### Fixed

- Agent clicks, fills and typing failed on every page in recent builds.
- Agents could not fill a saved login after you allowed it.

## 0.1.1 and earlier

### Added

- **Vault.** Saved logins become the Vault. The key in the toolbar is always there and opens the Vault for the current workspace, with a dot when the page has a saved login; Cmd+Shift+U (reassignable) fills it, lets you choose, or opens the Vault. Logins are grouped by site and searchable, and each shows which workspaces share it, its last uses and by whom, and which connected agents could use it now and why not. **Activity** records every use and every agent attempt (filled, waiting for you, or refused and why), per workspace, never a password, never exported, cleared only by you. Caddi offers to save (or update) a login after you sign in yourself, never for an agent's sign-in and never in a private window; the password leaves the page only when you press Save. **Import logins…** reads a CSV exported from 1Password, Apple Passwords, Bitwarden, Dashlane, LastPass or Chrome, Edge and Brave, shows what will be imported and what will be skipped before anything is stored, and imports with agents switched off. Show and Copy are offered only when macOS can confirm it is you.
- **Agents read page content.** Two read-only MCP tools need only Observe access. `caddi_read_page` returns a granted page as Markdown (title, address without its query string, headings, paragraphs, lists, quotes, code, links, images with alt text and tables), the main content by default or everything visible, or one observed element, in parts with `offset` and `maxChars`. `caddi_extract` returns links, tables (with spans flattened), headings, metadata or form fields (labels and types, never values) as data, paged. Only visible content is read: never field values, sensitive or Caddi-filled fields, hidden text, scripts or frames from other sites, and a page showing a saved password is refused. Results are marked as untrusted and page text cannot change their structure. The toolbar and the agent list show "… is reading this page" for a few seconds after each read. `npm run test:desktop:extraction` checks it on local pages.
- **Copy page as Markdown.** The page menu and the command palette copy the main content of the current tab as Markdown, with the same reader agents use. Not in private windows or while agents are paused.
- **Saved logins.** Each workspace can keep the logins it needs. Passwords live only in your Mac's login keychain, one item per login under a service name of its own for each build; Caddi's own file keeps only the site, username, label, workspaces, times and the agent switch. Add, edit, delete and share logins from **Logins** (Settings → Data and privacy, or Site permissions for the current site); Copy password and Show ask macOS to confirm it is you first. A key in the toolbar appears on a page whose exact origin has a saved login and fills it when you click. Approval gains **Can use saved logins for this workspace**, off by default; with it and a login's own **Agents may use this login** switch, `caddi_logins` lists usable logins without passwords and `caddi_fill_login` fills one after you confirm the agent's first use. `npm run test:desktop:logins` checks it end to end with an in-memory keychain.
- **Agents without Node.js.** The downloaded app starts the agent client with its own executable, so connecting a coding tool no longer needs Node.js installed. Source runs still use `node`.
- **OpenCode setup.** OpenCode joins the tools the Agents dialog can connect in one click.
- **Welcome on first launch.** The first time Caddi opens it shows a short welcome: what Caddi is and that it is open source under the MIT license, naming your first workspace, connecting a coding tool found on your Mac, and the Annotate and command shortcuts. It is shown once, and is under Help, Welcome to Caddi, and in the command palette after that.
- **Installer disk image.** `npm run package:caddi:release` builds the public app, named Caddi with its own bundle identifier and data folder, and `npm run dmg:caddi` puts it in a signed disk image with an Applications shortcut, ready to notarize.
- **Signed builds.** `npm run package:caddi:signed` signs the app with a Developer ID identity and the hardened runtime, and `npm run notarize:caddi` notarizes it with Apple, staples the ticket and writes the zip to distribute. Packaging can also run without the local speech files.
- **Workspace rail.** A narrow column on the left edge of the sidebar shows every open workspace as a badge. Click one to switch, or use the plus button to make a new workspace. The full menu at the top of the sidebar is unchanged.
- **One-click agent setup.** The Agents dialog lists the coding tools found on your Mac (Claude Code, Codex, Cursor, Claude Desktop, Gemini CLI, Windsurf) with a Connect button for each. Caddi adds only its own entry to the tool's settings, keeps a backup, and still requires on-screen approval.
- **Annotate mode.** Click elements on a page, write a note on each, then copy the notes as Markdown or send them to a connected agent.
- **Live mode.** Press Live (Cmd+Shift+L), talk while pointing at the page, and each sentence goes straight to one connected agent with the elements you pointed at. Speech is transcribed on your Mac by the pinned whisper.cpp; a typed field does the same without a microphone. Agents receive instructions through the new `caddi_live_wait` tool, a long poll, and the Live panel shows whether each one was heard, sent, received, and whether the agent is back.
- **Agents drive pages you can watch.** New MCP tools let an agent hover, press allowed keys, type key by key, choose options, drag, scroll by an amount or to an element, and wait for a page to load or for text to appear. A visible agent cursor with the agent's name glides to each target before anything happens, and the toolbar shows which agent is driving with a Take over button. An agent that keeps acting keeps its control for up to five minutes.
- **Screenshots for agents, if you allow them.** Approving an agent now offers "Can see the page (screenshots)", off by default. With it, `caddi_screenshot` returns a picture of the visible page with sensitive fields and embedded frames blanked.
- **Fuller observation.** `caddi_observe` reports checkbox, select and expanded state, select options, elements in same-origin frames and open shadow roots, and can filter by role or text and page through long pages.
- **Sent to agents, and notes pushed to a waiting agent.** The Notes panel is gone from the toolbar. A count beside Annotate (and "Sent to agents" in the command palette) opens one list of everything you sent from the workspace, newest first: notes made with Annotate, notes written by hand, and each Live session as one line. Every item says Draft, Sent and waiting for the agent, Received by the agent (with when), or that the agent disconnected before reading, and offers Open page, Copy, Send again, Delete (only before the agent has it) and View. `caddi_live_wait` now also returns notes sent to the waiting agent session the moment you send them, with the same Markdown `caddi_receive_feedback` returns and the ids to read attachments; a note fetched one way is never offered again the other way. The Annotate bar keeps saying "Sent · waiting for …" and then "Received by …".
- `SECURITY.md`, `THIRD_PARTY_NOTICES.md` and this changelog.

### Changed

- **Plainer words.** Annotate, Live and Sent use the same words: note, instruction, Send, Received. Live rows say Sent · waiting, Received, and Received · agent is back. The copied agent prompt now asks the agent to listen for notes and Live instructions. Screenshot capture, voice notes and saved notes moved inside a note as secondary actions.
- **Local speech pins.** The development `whisper-cli` was rebuilt from the pinned whisper.cpp commit and re-pinned (new size and SHA-256), along with its development report. The model pin is unchanged.
- **New app icon.** A white Caddi mark on a dark plate, shown in the Dock for source runs as well as in packaged builds.
- **Interface redesign.** The browser interface was redesigned from scratch for the public release.
- **Package renamed to `caddi`.** The npm package name, description and repository metadata now use the Caddi name. `npm start` runs the app. Some internal identifiers (the `src/caddi` directory, `caddi_` MCP tool names and `caddi:` npm scripts) keep an earlier name for now.
- **Documentation rewritten.** The README, contributing guide and provenance statement were rewritten for a public audience. The internal planning documents were replaced by a short set of public documents: architecture, connecting agents, security model, development and roadmap.

### Removed

- **Legacy prototype.** The earlier prototype browser, its tests, its research records and its release tooling were removed from the codebase.
