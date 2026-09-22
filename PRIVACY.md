# Privacy Policy — Agent Tool

This policy covers the Agent Tool browser extension (Chrome, Edge, Brave) and
the Agent Tool Cursor/VS Code extension. Both are published by yuuki-sakai.

## What the extensions do

They scan folders you use with AI coding agents (such as `~/.claude` or a
project's `.claude` folder) and folders you explicitly grant through your
browser's file picker, so you can see, install, and remove Skills, Subagents,
MCP servers, and Plugins from one place.

## What is collected

**Nothing is collected, transmitted to us, or sold.** There is no analytics,
telemetry, or tracking of any kind. Neither extension has a backend server —
they run entirely on your device and talk only to the services described
below.

## What is stored, and where

| Data | Where | Why |
|---|---|---|
| Directory handles you grant via the File System Access API | Your browser's local IndexedDB | So the browser extension can reuse the folders you picked when browser permission is still available |
| A list of what the browser extension has installed (name, source, install path, timestamp) | Your browser's local IndexedDB | So installed items can be shown, updated, and removed later |
| An auto-open and a theme preference | Your browser's local IndexedDB | Two UI preferences you control from the popup |
| Jev API key and AI-assisted detection toggle (Beta feature) | `chrome.storage.local`, restricted to trusted extension contexts | Lets you opt in to AI assistance when a local scan cannot decide, without exposing the key to page/content-script contexts |
| `registry.json` (pinned state and source metadata) | Your local `globalStorageUri` (the Cursor/VS Code extension's own data folder) | To track installed tools and their update source |

None of this leaves your device. Uninstalling either extension removes its
stored data (browser: through the browser's own extension data controls;
IDE: `registry.json` is a plain file in the extension's storage folder).

To delete the Jev API key without uninstalling, open **Settings** and select
**Delete** next to the saved key. AI-assisted detection is a Beta feature
and may be withdrawn in a later release; if it is, the release that removes it
also deletes the key and the toggle from your browser.

## Network access

- **GitHub** (`github.com`, `api.github.com`, `raw.githubusercontent.com`,
  `codeload.github.com`): to resolve a repository, check whether a file
  exists, read a commit SHA, and download a Skill/Subagent archive.
- **skills.sh** and **agentsdirectory.dev**: only when you open one of these
  pages, to read the page you are already viewing (its JSON-LD metadata) so
  the extension can find the source repository.
- **TypeSafe AI / Jev** (`api.typesafe.ai`): only after you enable AI-assisted
  detection, add your own Jev API key, open the extension on an unsupported
  site, click **Find tools on this page**, and the local scan of that page
  cannot decide on its own. Scanning itself needs no key, and a page that
  resolves locally never reaches Jev. The extension sends a minimized
  set of extracted GitHub links, install-command lines, page title,
  headings, and short nearby text, so Jev can judge whether the page ships a
  tool at all — which tool to install is decided locally. Only the lines that
  actually name a source are taken from a code block, and values that look
  like a key, token, password, or URL credential are replaced with
  `[redacted]` before anything is sent.
  It does not send the full HTML, form values, cookies, local/session storage,
  or browsing history. When the page URL has a `#fragment` that points at a
  section, only that section is read, and the fragment itself is never sent.
  The API key is sent only in the Authorization header.

- **Sites you allowed for automatic detection**: only sites you explicitly
  enabled one at a time. On those sites the extension reads the page locally
  and checks GitHub as you browse. When local resolution cannot tell whether
  the page ships a tool, it asks Jev the same single question the manual scan
  asks, sending the same minimized evidence described above — so this happens
  only if you enabled AI-assisted detection and saved a key. Pages that
  resolve on their own never reach Jev. Automatic requests are capped per
  hour; only a counter (a window start and a number) is stored for that, never
  the sites you visited. Removing the site in **Settings → Automatic
  detection** stops everything immediately.

GitHub requests use public, unauthenticated endpoints. TypeSafe requests use
only the API key you explicitly provide. The browser extension still does not
request `<all_urls>`; unsupported pages are read temporarily through
`activeTab` only after your explicit click, or on a site you allowed yourself.

## Permissions

- **File System Access API** (browser extension): used only for folders you
  pick yourself through the browser's native folder picker. The extension
  cannot read or write anywhere else.
- **`webNavigation`** (browser extension): used only to notice when a
  single-page app changes its URL, so detection reruns on the new page. No
  browsing history is read or stored. The listener for automatic detection is
  scoped to the exact origins you allowed, so navigations on every other site
  never reach the extension at all.
- **Optional site access** (browser extension): the extension declares
  `https://*/*` as an *optional* host permission, which is not granted at
  install time and is not part of the install prompt. It is requested one
  origin at a time (`https://example.com/*`), only after the extension has
  actually confirmed a tool on that site and only when you press **Enable for
  this site**. It is never widened to subdomains or to all sites, and the list
  of allowed sites is read back from the browser's own permission API rather
  than from any separate record.
- **`activeTab` + `scripting`** (browser extension): used only after you click
  the manual AI scan button on the current unsupported page. This grants
  temporary access to that tab; it is not persistent access to all sites.
- **`storage`** (browser extension): stores the optional Jev API key, the
  AI-assisted-detection toggle, and the hourly counter that caps automatic
  Jev requests. The storage area is restricted to trusted extension contexts
  before the key is written. The counter holds only a timestamp and a number.

## Contact

Open an issue at the project's GitHub repository, or reach the maintainer via
the contact address on the Chrome Web Store / Open VSX listing.

## Changes

If this policy changes, the update ships with the next release and is
reflected in this file.
