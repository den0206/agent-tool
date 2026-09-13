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
| An auto-open and a theme preference | Your browser's local IndexedDB | Two on/off settings you control from the popup |
| `registry.json` (pinned/disabled state, cached metadata) | Your local `globalStorageUri` (the Cursor/VS Code extension's own data folder) | So the IDE extension does not need to re-scan on every view |

None of this leaves your device. Uninstalling either extension removes its
stored data (browser: through the browser's own extension data controls;
IDE: `registry.json` is a plain file in the extension's storage folder).

## Network access

- **GitHub** (`github.com`, `api.github.com`, `raw.githubusercontent.com`,
  `codeload.github.com`): to resolve a repository, check whether a file
  exists, read a commit SHA, and download a Skill/Subagent archive.
- **skills.sh** and **agentsdirectory.dev**: only when you open one of these
  pages, to read the page you are already viewing (its JSON-LD metadata) so
  the extension can find the source repository.

Every request uses the service's public, unauthenticated endpoints. No
credentials, page content, or browsing history are sent anywhere else. The
browser extension does not request `<all_urls>` — it can only see the sites
listed in its manifest's `host_permissions`.

## Permissions

- **File System Access API** (browser extension): used only for folders you
  pick yourself through the browser's native folder picker. The extension
  cannot read or write anywhere else.
- **`webNavigation`** (browser extension): used only to notice when a
  single-page app changes its URL, so detection reruns on the new page. No
  browsing history is read or stored.

## Contact

Open an issue at the project's GitHub repository, or reach the maintainer via
the contact address on the Chrome Web Store / Open VSX listing.

## Changes

If this policy changes, the update ships with the next release and is
reflected in this file.
