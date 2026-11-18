# Roadmap

Caddi is an early development preview. This is a plain list of what is not done yet. It is not a schedule and there are no dates.

## Distribution

- **A published signed download.** The packaging scripts can now produce a Developer ID signed, notarized release build and a drag-to-Applications installer disk image (see [DEVELOPMENT.md](DEVELOPMENT.md)). The current build is on the website's download page; older versions are not archived.
- **Automatic updates.** There is none. Update-verification code exists in `src/caddi/updates` but is not connected to a real installer.
- **Intel Macs, Windows and Linux.** Not supported. Packaging assumes Apple Silicon, and agent connections assume Unix sockets.
- **Final app identity.** The bundle ID, data directory name, npm script names and MCP tool names still use an earlier internal name (`caddi`). Renaming them needs a data migration.

## Credentials and storage

- **Protected credential storage.** Saved login passwords are stored in the login keychain through the native addon. Service keys and workspace keys still use the earlier, unfinished data-protection keychain path, which needs a signed app.
- **Real service connections.** The GitHub, Vercel and Resend adapters exist and are tested against synthetic backends. Adding a connection with a real token is disabled until credential storage is done.
- **Saved page notes.** Notes and deliveries last for the current app session. Encrypted saving exists in code but is not enabled in ordinary runs.
- **Persistent agent pairing.** Every agent must be approved again after each restart. A client identity protocol exists in `src/caddi/access` but is not used by the MCP client yet.
- **Vault: what is left.** The Vault works for username and password forms on one page, with import from CSV, an offer to save after you sign in, and an access log. Not done: passkeys; password generation; matching subdomains or related sites (only the exact origin matches today); sign-in forms split over two pages (a username page, then a password page); one-time codes (TOTP); checking that a sign-in worked before offering to save it; importing 1Password's own `.1pux` or other non-CSV exports; sync between Macs (there is none, by design for now); and checking the keychain access in a signed release build.
- **Password managers and passkeys.** The Vault imports CSV exports from other password managers but does not connect to them. No passkeys.
- **Clearing a workspace's site data** from the interface. Not available yet. You can see storage use per workspace.

## Browser features

- **Extensions.** Not supported. Only an isolated test of one bundled fixture extension exists.
- **Screen sharing and other site permissions.** Sites can ask for notifications, camera and microphone. Everything else is denied.
- **Sync and accounts.** There is no Caddi account and no sync between machines. Import and export of workspace organization and bookmarks is manual.
- **Search engine choice.** Searches go to DuckDuckGo. The state model allows other engines, but nothing in the interface changes it yet.

## Agents

- **Frames from other sites.** Agents observe and act inside same-origin frames and open shadow roots, but not inside cross-origin frames or closed shadow roots. Cross-origin frames would need the page layer in every frame and a per-frame target; they are counted in observations, blanked in screenshots, and points that land on them are refused.
- **Reading more than one page.** `caddi_read_page` and `caddi_extract` read one page that is already open in a granted tab. There is no crawling of several pages, no following of links by Caddi, and no fetching of URLs on an agent's behalf.
- **Reading PDFs and other documents.** PDF text, images and canvas text are not read. A PDF opened in a tab returns no content.
- **Reading frames from other sites.** Like observation, reading counts frames from other sites but does not enter them.
- **Saving extracted content to files.** Copy page as Markdown copies to the clipboard. There is no export to a file, and agents receive content only in tool results.
- **File upload.** Agents cannot choose files for a file input. File inputs stay with the person.
- **Native drag and drop.** Agent drags use pointer and mouse events. Elements that rely on the browser's own HTML drag and drop (`draggable`) are not supported; the drag is cancelled so no system drag session starts.
- **Screenshots of background tabs.** An agent screenshot is of the tab shown in a visible window only.
- **Keyboard.** Only a fixed list of keys and chords (Enter, Escape, Tab, arrows, editing keys, Shift and Alt movement, Meta+A). No clipboard, browser or app shortcuts. Typed text has no line breaks and no characters outside the basic multilingual plane (no emoji).
- **Typing feedback.** Letters, digits and spaces arrive as full key presses; other characters arrive as typed characters without their key down and up events.
- **Sending marked-up screenshots.** Notes with drawn marks on captured stills can be prepared and previewed locally but not sent to an agent.
- **Voice notes.** Local speech-to-text through whisper.cpp works only when the pinned speech program and model are present (the signed download includes them). It has not been tested across real microphones and devices.
- **Live mode.** The speech segmenter is a simple energy detector: it has been tested with synthetic audio and one synthetic spoken sentence, not with real microphones, rooms or accents. Pointing covers the main frame only (no iframes). Only one Live session runs at a time, for one agent. The agent must keep calling `caddi_live_wait`; Caddi cannot push into an agent that is not waiting. "Received · agent is back" means the agent called again, not that the change worked.
- **Sent to agents.** "Received" means the agent's own call returned the note; it does not mean the change was made. Deleting a received note is not possible, and deleting a draft removes it from this session's list only: with encrypted saving turned on, loading saved drafts brings it back, because the stored format has no delete record. Live sessions are listed for this run only, as counts.

## Quality

- **Accessibility.** Controls have accessible names and keyboard handling, but the app has not been tested end to end with VoiceOver, with physical input methods, or against WCAG.
- **Independent security review.** None yet. See [SECURITY-MODEL.md](SECURITY-MODEL.md) for known limits.
- **Compatibility testing with real sites.** Tests use synthetic local pages. Real-world sign-in flows, video calls and heavy web apps have not been checked systematically.
- **Long-running use.** No soak testing over days with many tabs and agents.
- **Continuous integration.** GitHub Actions runs `npm ci`, `npm test` and `npm audit` on a macOS runner for every push and pull request. The Electron smoke tests need a visible display and are run locally only.

## Suggesting something

Open an issue describing the problem you want solved. For security problems, follow [SECURITY.md](../SECURITY.md) instead.
