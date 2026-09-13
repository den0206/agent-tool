# Browser extension — store listing

Ready-to-paste content for the Chrome Web Store Developer Dashboard. Edge
Add-ons accepts the same zip and mostly the same fields; reuse this file
there too. Chrome first (see [release plan](agent-tool-release-plan.md)) —
fill in the other stores only after Chrome approves.

Build the zip with `npm run package:browser` (or let
`release.yml` build it from a `release/Ver_<semver>` branch) and upload
`vsix/agent-tool-browser.zip`.

## Release automation

`release.yml` submits the already-built zip to Chrome automatically only when
every Chrome secret is present. Missing secrets skip Chrome without blocking
the VSIX or GitHub Release. Submit the Chrome-approved zip to Edge manually.

| Store | Required GitHub Secrets | One-time manual setup |
|---|---|---|
| Chrome Web Store | `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`, `CHROME_PUBLISHER_ID`, `CHROME_EXTENSION_ID` | Enable 2-step verification; create the listing and complete Privacy / Distribution in Developer Dashboard. |

The API submits an update; store review remains asynchronous. A Chrome API error
stops the workflow before Open VSX and the GitHub Release are published.

## Store listing tab

| Field | Value |
|---|---|
| Extension name | Agent Tool |
| Summary (≤ 132 chars) | Find skills and subagents while you browse, and install them into Claude Code, Cursor, or Codex. |
| Category | Developer Tools |
| Language | English (the extension also ships Japanese via `_locales/ja`) |
| Homepage URL | `https://github.com/den0206/agent-tool` |
| Support URL | `https://github.com/den0206/agent-tool/issues` |

### Description

```
Agent Tool spots Skills and Subagents while you browse GitHub, skills.sh,
and Agents Directory, and installs them straight into Claude Code, Cursor,
or Codex — no copy-pasting URLs into a terminal.

- Detects a Skill or Subagent automatically on a supported page, or accepts
  a pasted URL from any of them.
- Installs into the config directory you pick (~/.claude, ~/.cursor,
  ~/.codex, or the shared ~/.agents) through your browser's native folder
  picker. The extension never writes anywhere else.
- Keeps a local list of what it installed so you can remove it again later.
- Works standalone — the Agent Tool Cursor/VS Code extension is not
  required, though installs are picked up by it if you also use it.
- No accounts, no telemetry, no analytics. See the privacy policy for
  exactly what is stored and where.

Supported sources: github.com, skills.sh, agentsdirectory.dev.
```

### Screenshots

Upload in this order (each is already sized to Chrome Web Store's required
1280×800 pixels):

1. `media/chrome-web-store/auto-detect.png` — the popup opening automatically after
   navigating to a Skill on GitHub.
2. `media/chrome-web-store/input-detect.png` — pasting a supported URL straight into
   the popup, without needing to visit the page first.

### Promotional image

Upload `media/chrome-web-store/promo-small.png` as the required 440×280 small
promo tile. The 128×128 store icon is included in the package as
`browser/icons/icon-128.png`. A marquee tile and video are optional, so do not
make them part of the initial release.

## Privacy practices tab

### Single purpose

> Detect Agent Skills and Subagents on supported sites (GitHub, skills.sh,
> Agents Directory) and install them into a local AI coding agent's config
> folder that the user selects.

### Permission justifications

| Permission | Justification |
|---|---|
| `host_permissions`: `github.com`, `skills.sh`, `agentsdirectory.dev` (+ `www.` variants) | Content script detection runs only on these sites. |
| `host_permissions`: `api.github.com`, `raw.githubusercontent.com`, `codeload.github.com` | Public GitHub endpoints used to resolve a repository, check a file exists, read a commit SHA, and download the archive to install. No authentication is used or requested. |
| `webNavigation` | Detects single-page-app URL changes (`onHistoryStateUpdated`) so a supported page found without a full reload is still detected. Does not read or store browsing history. |
| File System Access API (no manifest permission — requested per-use via `showDirectoryPicker()`) | Writes only inside the folder the user picks. |

### Data usage disclosure

Declare that the extension handles supported-page URLs and JSON-LD metadata
locally to detect installable resources, and the local data listed in
[`PRIVACY.md`](../PRIVACY.md) to manage user-selected folders and installed
items. It does **not** collect or transmit personally identifiable,
financial, health, authentication, location, or communication data; it has no
analytics or backend. Match the Dashboard's current field labels exactly and
do not mark locally processed page URLs or metadata as unhandled.

### Privacy policy URL

Link to the raw or blob URL of [`PRIVACY.md`](../PRIVACY.md) on GitHub,
e.g. `https://github.com/den0206/agent-tool/blob/main/PRIVACY.md`.

## After Chrome approves

- Edge Add-ons: same zip, same listing fields, submit via the Partner
  Center.
- Brave: no separate submission — point users at the Chrome Web Store
  listing. Brave disables the File System Access API by default; the
  extension already detects this and links to `brave://flags` with the
  exact steps.
