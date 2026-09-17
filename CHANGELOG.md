# Changelog

All notable changes to Agent Tool are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The IDE dashboard has been refreshed. The tool list is now grouped into hairline-divided sections with per-kind counts; agents live in a compact segmented control at the top; the scope switch is a small segmented pill (User Global first and selected by default) next to the project name, with `Check for updates` moved to the right of that row so it no longer sits beside the top-right refresh icon. A slim banner surfaces pending updates and lets you filter to them in one click. Running MCP servers get a soft-glow green dot, stopped ones dim to grey; `@latest` MCPs carry an inline warning icon next to the name; pinned tools show a pin glyph. Bundled tools are collapsed by default; Environment and Diagnostics move to collapsible footer sections. Everything continues to use the editor theme, so light and dark themes render correctly.

### Fixed

- The browser extension toolbar action badge (the small purple pill on the icon with the number of detected tools) now sets its text color to white explicitly. On some Chrome builds the default text color is auto-derived from the badge background and lands on a muted grey, which visibly de-centers narrow digits like "1". Explicit white restores legibility and perceived alignment. The change silently no-ops on Chrome versions older than 110.
- The browser extension popup showed the red "Installed" tag on every detected Tool page, even for skills that were never installed. Its class rule `display: inline-flex` had the same CSS specificity as the browser's built-in `[hidden] { display: none }`, so the author rule won the cascade and the `hidden` attribute did nothing. The same defect kept the install button visible when it should have been hidden. A single `[hidden] { display: none !important }` reset restores the intended behavior for all popup elements.
- The "Installed" tag no longer waits for a tab reload to appear after a browser-side install. On every popup open the collection-and-disk check for the active tab now runs first, ahead of the service worker's candidate state, so a stale "candidate" left over from before the install cannot suppress the tag. The install handler also tells the current tab's content script to rescan afterwards, which makes the service worker's own detection catch up in the same session.

### Changed

- The browser extension now shows the "Installed" tag inside the popup only when the current page's Skill or Subagent was installed from the same GitHub repository. The check previously matched on name and kind alone, which mislabeled tools that shared a name with an unrelated skill already on disk. The tag is popup-only, with no toolbar badge or automatic popup.
- Tool pages whose local folder shares a name with another repository's skill now show the install detection instead of staying silent. The install button's confirmation still guards against overwriting an existing folder.
- The "Installed" tag now fires only when the browser extension can confirm the local folder still exists through the File System Access API. Entries removed outside the browser extension (by the IDE, the file system, or by hand) are dropped from the collection on the next visit if the folder-access permission is granted. When the permission is dormant the tag no longer appears based on the collection alone; the normal install detection appears in that case, and the install button's overwrite confirmation continues to guard against clobbering existing folders. The popup double-checks the folder in its own context on open, so a cold service worker's stale answer cannot outlive it.

## [0.3.0] — 2026-09-16

### Added

- The Dashboard now shows read-only environment diagnostics for broken links, missing `SKILL.md` files, independent same-name skill copies, and MCP launch commands that are absent from `PATH`. It never starts configured MCP commands or records diagnostic history.
- The Dashboard now also warns when Claude registers an MCP server with the same name at user and project scope, without guessing which registration takes precedence.
- The Environment section now separates each agent's supported formats, installed formats, and CLI detection state. Cursor is shown as configuration-detected because it has no CLI interface.
- Update previews now summarize added, removed, and changed files, flag manifest/configuration changes, and say when the displayed diff is incomplete.
- Managed, enabled Skills can now be copied between the user profile and the current project. The confirmation shows both paths, never overwrites an existing destination, and leaves the source unchanged.
- Environment and environment-diagnostics details now sit at the bottom of the Dashboard, are left-aligned and collapsed by default, and can be expanded without saving a UI preference.
- The Environment details now show the absolute path of each detected agent CLI.
- Rules are now listed in the Dashboard for both user scope (`~/.claude/rules/*.md`, `~/.cursor/rules/*.mdc`) and project scope (`<project>/.claude/rules/*.md`, `<project>/.cursor/rules/*.mdc`), including rules kept in subdirectories. You can delete rules that you or your team placed there; the extension does not add rules from a URL, and enable/disable are not offered because rules load unconditionally or based on their own `paths:` frontmatter. Codex `AGENTS.md` and Gemini `GEMINI.md` are single-file formats and out of scope.

### Changed

- Documented Remote (SSH / Dev Container / Codespaces) behavior as read-only listing with all write operations rejected, matching what the extension has always done. Previous wording implied even reading was blocked.
- Added an opt-in Playwright end-to-end script (`npm run test:browser`) that loads the packaged browser extension into Chromium and asserts the toolbar badge fills in for each supported catalog. Excluded from CI so real-site or catalog outages never break `npm test`.
- The browser extension now detects catalog skills that live under `.agent-skills/<name>/SKILL.md`, checked only when the canonical `skills/<name>/SKILL.md` returns 404. This lets repositories that keep 100+ skills in a hidden directory (measured: `akillness/jeo-skills`, 140 MB archive) install a single skill without hitting the archive size limit.
- The browser extension now shows a "!" toolbar badge (with a tooltip explaining the cause) when GitHub's unauthenticated rate limit stops it from listing skills at a directory URL. Previously the badge stayed empty, indistinguishable from a directory that has no skills.

## [0.2.1] — 2026-09-14

### Added

- MCP servers pinned to `@latest` are now flagged in the Dashboard, because their contents change on every launch and no version is recorded to update from.
- Subagents are detected whether or not their front matter lists `tools:`, so the IDE extension now installs the many subagents that omit it.

### Fixed

- The browser extension now keeps detected candidates and their badge when automatic popup opening is off, so opening the toolbar action still shows the current candidate.
- Update previews now obey the same untrusted-workspace and Remote-environment guard as other IDE operations.
- Tools installed by the browser extension can now be removed, disabled, re-enabled, and updated from the Dashboard. They were listed as managed, but every one of those actions looked for the files in the IDE extension's own store and reported that the tool was not found; applying an update wrote the new version to that store and left a second copy behind. The registry now records where the files actually are.
- Pinning a tool is no longer silently cleared when the browser extension installs the same tool again.
- Skills, subagents, and plugins can be installed from repositories whose default branch is not `main`. The download and the update check both asked for `main` by name, so those repositories returned "not found"; they now ask for the default branch itself.
- MCP arguments containing spaces reach the agent's CLI intact on Windows. Header and environment values such as `-H "Authorization: Bearer …"` were split into separate arguments, so those servers were registered incorrectly; `&` and `|` in a server URL are also accepted now.
- The Command Palette no longer lists six Agent Tool commands that did nothing when run from there, because they act on a tool selected in the Dashboard. They are still available from a tool's actions menu.
- The browser extension declares the popup's language, so screen readers no longer read a Japanese interface with an English voice, and declares its minimum Chrome version.
- Clicking the browser extension's badge after its background worker has been shut down clears the badge instead of opening an empty popup.

### Changed

- A workspace folder name containing HTML characters no longer breaks the Dashboard's filter buttons.
- The first update check after installing this version re-reads every source, because sources without an explicit branch are now recorded under the default branch rather than under `main`.

## [0.2.0] — 2026-09-13

### Added

- Tools installed by the browser extension are picked up by the IDE extension on its next scan, so they can be removed, disabled, and updated from the Dashboard like anything else.
- Registry entries whose files are gone are dropped on the next scan, so the list no longer shows tools that were deleted outside Agent Tool.
- A browser extension for Chrome, Edge, and Brave that spots skills and subagents while you browse GitHub, skills.sh, and agentsdirectory.dev, and installs them into Claude Code, Cursor, or Codex. It writes only to folders you pick, and works without the IDE extension installed.
- Opening a folder that holds several skills — `github.com/<owner>/<repo>/tree/<branch>/skills`, or a repository page on a catalog — lists them in the browser extension with an install button per row, so they go in one at a time rather than all together. Each one is fetched file by file instead of as an archive, so skills can be installed from repositories whose archive is over the download limit (measured: 104 KB taken from a repository whose archive is 116 MB).
- A Supported sites dialog in the browser extension with links to GitHub and every supported catalog.
- A light / dark / system theme setting in the browser extension's popup.
- A unified `release/Ver_<semver>` workflow that gives both extensions the same version, packages and checksums their artifacts, and attaches them to one GitHub Release, plus a privacy policy (`PRIVACY.md`) and a Chrome Web Store listing checklist (`docs/browser-store-listing.md`).
- Conditional Chrome Web Store submission from that workflow, skipped until all of its required GitHub Secrets are configured; submit the approved zip to Edge Add-ons manually.
- The browser extension's popup explains what happens before it writes: which folder the item goes into, that your browser only reveals the folder's name rather than its full path, that the source resolves to a public GitHub repository, and that unsafe archive paths and links are refused.

### Changed

- Installing stops before anything is deleted when the download contains a name no file system can take (Windows device names, `<>:"|?*`, trailing dots), instead of failing halfway through and leaving neither the old nor the new version.
- Registry entries are kept, not dropped, when a scanned folder cannot be read, so a temporary permission or sync problem no longer loses pinned and disabled state. The unreadable folder is reported instead.
- Installing over an existing Skill now replaces it instead of writing on top of it, so files that only existed in the previous version no longer linger. The old copy is removed only after the new one has been fetched.
- The browser extension's popup uses a palette matching the extension icon, with a few short, `prefers-reduced-motion`-aware animations (the detected-card entrance, the install spinner, the dialog open).
- The browser extension no longer asks for the `unlimitedStorage` permission. It keeps only a small amount of data (the folder handles you granted and the list of what it installed), which fits in the ordinary extension storage quota.
- Installing over an existing item stops instead of replacing it when that item is over 64 MB, because the old copy is held in memory so it can be put back if the replacement fails. Nothing is deleted, and the message says to remove the item yourself or pick another destination.

### Fixed

- Installing from a catalog link no longer holds the whole repository in memory while it looks for the skill. The conventional `skills/<name>` location is checked first with a single request, and when it matches only that folder is read (measured: 51.2 MB down to 2.7 KB for one entry). Catalogs whose name differs from the folder fall back to the previous behaviour.
- A skill whose repository archive is over the download limit can now be installed from its own page: when the archive is refused, the files are fetched individually instead (measured: 104 KB taken from a repository whose archive is 116 MB). Repositories whose archive works are unaffected.
- A repository listing that could not be read is no longer reported as "not found". Hitting GitHub's unauthenticated request limit now reads as a fetch failure, which is what it is.
- Choosing a folder in Brave reported what went wrong instead of doing nothing: Brave turns the File System Access API off by default, and the extension now says so and walks through enabling it in brave://flags.
- The "Installed here" list drops entries that were removed from the IDE extension. It could not read the folder to check, so it kept showing them.
- The browser extension's dropdown menus and dialogs stay legible in dark mode; some text could render unreadable against the page's own dark styling before.
- A Skill whose folder contains a symbolic link is no longer offered for install by the IDE extension. Symlinks are never extracted, so installing one produced a copy with files silently missing.
- Pasting a link that is not a skill or subagent says so in the browser extension. The message was wired up but its visibility was inverted, so nothing appeared.
- The browser extension's "paste a URL" label no longer folds the "Supported sites" link into the input's accessible name, the install-succeeded banner is announced to screen readers and keeps focus while visible, and the URL error message is now associated with its field.

## [0.1.2] — 2026-09-12

### Changed

- Dashboard rows now show an "Updates available" marker, so it is clear which tools the update count refers to.
- Clicking the "Updates available" count filters the list down to the tools that have an update; clicking it again clears the filter.
- The Dashboard shows a loading indicator until the first scan finishes, instead of looking like an empty or failed list.
- The tool list is posted before the agent CLI scan, so the first view no longer waits on spawning login shells.
- MCP status checks no longer start a new round while the previous one is still running.
- Packaging now starts from a clean build directory.

### Fixed

- Update previews, configuration files, registry reads, and GitHub API responses are now bounded, so a single large input cannot grow the extension host's memory without limit.

## [0.1.0] — 2026-09-11

### Added

- Windows and Linux support: every feature now runs on macOS, Linux, and Windows.
- Commands for previewing and applying tool updates and refreshing the inventory.
- "Check for updates" (toolbar button and command) asks each source for its latest commit and marks the tools that have one. Without it the update badge could never appear.
- An Environment section listing which agent CLIs were found, with their version and path, and a warning when none are on PATH.
- A Status Bar badge with the number of available updates; clicking it focuses the Dashboard.
- Pin and unpin a tool to stop or resume following its updates.
- The Dashboard now watches the scanned paths while it is visible and reloads the list when they change.
- A clipboard suggestion card when a supported URL is on the clipboard.
- Skills and subagents can now be installed into the current project instead of the user profile. The install flow asks where to put it when a workspace is open; project items live in the project's own `.claude/skills` or `.claude/agents`, are tracked separately from same-named user items, and can be removed and updated from the list. Enable/disable stays user-only, since nothing is parked inside a project.
- Skill pages on Agents Directory (`agentsdirectory.dev`) can now be pasted into the URL field. The page is read once and only its schema.org JSON-LD metadata is used to find the repository. Supported sites are listed in the README and declared in one place, so adding or removing one is a single entry.
- An "Other projects" dropdown below the User Global list: pick any project Claude Code has opened that actually holds tools to see its Skills, Subagents, MCP servers, and plugins with their descriptions and locations. Only the selected project is scanned, and the list is read-only.

### Changed

- Added a color extension icon for the Extensions view and Marketplace.
- Added production installation instructions and a GitHub Actions release workflow for VSIX distribution.
- Added the Plugin installation demo to the project documentation while keeping the large GIF out of the VSIX package.
- The management core runs inside the TypeScript extension, so the VSIX no longer ships a platform binary.
- Skills and subagents are now shared through junctions and hard links on Windows, and through symbolic links on macOS and Linux.
- Replaced the extension sidebar icon with a hexagonal hub design.
- Enriched the Dashboard UI: SVG icons per tool kind (Skill/Subagent/MCP/Plugin), brand-colored glyphs, agent-dot indicators on agent tabs, and an agent-badge header card showing the active agent name and tool count.
- Read-only states (untrusted workspace, remote window) are now shown as a banner on the list instead of only failing at the moment of the operation.
- Failures now say what went wrong in the user's language before the original message (protected target, unusable name, foreign link, lock timeout).
- Applying an update now asks for confirmation, like removal does.
- Tool descriptions and usage now open inline under the card that was clicked, and close on a second click; the "•••" menu is left to management actions only.
- The Dashboard now reports scan failures instead of showing an empty tool list, and all of its text is available in English and Japanese.

### Fixed

- The install button in the URL preview no longer stays on "Installing…" after the install finishes; the panel closes on success and the button returns on failure or cancellation.
- Tool details now show the location of the item; the field was read from a property that was never filled in, so the row was always missing.
- The plugin list no longer mixes in project-scoped plugins that belong to other projects; only the plugins of the project being viewed are shown.
- Scan failures in the Other projects list are reported instead of showing what looks like an empty project.
- Plugin installation now registers a supplied Marketplace before installing it; Claude no longer receives its unsupported `--marketplace` option. Plugin installation and removal show their commands for confirmation, and removal preserves the installed scope.
- GitHub subdirectory Plugins now register the repository Marketplace root and install with its `plugin@marketplace` selector.
- Removing or disabling a project-scoped Skill or Subagent no longer deletes the user-scoped item of the same name; project files are left to the project.
- Removing a project or local MCP server now targets that registration instead of the user-wide server of the same name.
- Commands containing shell syntax are refused on Windows, where arguments would otherwise be interpreted by the command processor.
- A manually configured agent CLI path is now matched on Windows as well.

### Removed

- Unused registry fields (`usage`, `projects`, `excludedProjects`, per-agent `enabled`). Nothing read or wrote them; usage history would require scanning the agents' log directories, which the scan whitelist deliberately excludes.

- Deleting a tool no longer moves it to the Trash and no longer offers a 30-second undo; the confirmation dialog states that the removal is permanent.
