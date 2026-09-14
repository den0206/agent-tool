# Agent Tool — Future Feature Roadmap

## 1. Purpose

This document collects candidate features that can extend Agent Tool from an installer/inventory utility into a broader management and diagnostics layer for AI agent tooling.

The guiding principles are:

- keep users in control of all mutations
- prefer local inspection over remote telemetry
- surface risk and compatibility before installation
- make cross-agent environments easier to understand
- reduce configuration drift, duplication, and stale tools
- build on the existing inventory, update, source, and safety boundaries rather than bypassing them

The proposals below are ordered by product value and implementation priority.

---

## 2. P1 — High-value management features

### 2.1 Conflict Detection

Detect ambiguous, duplicated, or competing tool definitions across supported agents and scopes.

Examples:

- same Skill name exists in both user and project scope with different contents
- same MCP server name exists in user / project / local registrations
- managed and unmanaged copies of the same tool coexist
- symlink and physical copies point to different versions
- shared-store and agent-specific copies have drifted apart

Suggested UI:

- show a warning badge on the affected tool
- explain which copy is actually effective for each agent
- offer read-only comparison before any resolution action
- never delete or rewrite conflicting entries automatically

Why this matters:

Conflict Detection turns inventory data into actionable diagnostics and directly reduces hard-to-debug agent behavior.

---

### 2.2 Tool Health Check

Add a health layer to installed tools.

Potential checks:

- source repository or referenced path no longer exists
- expected Skill/Subagent file is missing
- MCP process cannot start or exits immediately
- required CLI is not available on PATH
- recorded source commit no longer resolves
- managed symlink is broken
- registry/ledger metadata points to a missing target
- installed tool format is no longer compatible with its target agent

Suggested states:

- Healthy
- Warning
- Broken
- Unknown

The check should remain non-destructive. Fixes should be explicit user actions.

---

### 2.3 Diff Before Update

Before applying an update, show what will materially change.

Useful classifications:

- documentation-only change
- Skill instructions changed
- executable command or MCP configuration changed
- new files added
- files removed
- source path changed
- permissions or external access requirements appear to have changed
- version pin changed

The existing update flow already resolves source revisions, so this feature can build on that path.

Security benefit:

Users can distinguish a routine documentation update from a change that alters executable behavior.

---

## 3. P2 — Cross-agent and trust features

### 3.1 Compatibility Matrix

Show which agents can consume a selected tool and at what level.

Example:

| Tool | Claude | Cursor | Codex | Gemini |
| --- | --- | --- | --- | --- |
| Skill A | Supported | Supported | Supported | Unsupported |
| Subagent B | Supported | Supported | Unsupported | Unsupported |
| MCP C | Supported | Supported | Supported | Supported |

Possible states:

- Supported
- Partial
- Unsupported
- Unknown

This should be derived from Agent Tool's own compatibility rules rather than guessed dynamically.

---

### 3.2 One-click Migration / Replication

Help users copy or link an existing tool to another compatible agent.

Example workflows:

- "Use this Claude Skill in Cursor and Codex"
- "Move duplicated Skills into the shared store"
- "Restore agent-specific copies from a shared source"

Safety requirements:

- preview every destination
- never overwrite unmanaged content silently
- pass every mutation through the existing write safety boundary
- make migration reversible where practical

---

### 3.3 Risk / Trust Score

Provide a pre-install review score for public tools.

Possible signals:

- repository archived or active
- source commit age
- recent maintenance activity
- required shell commands
- external network access described by the tool
- environment-variable or credential references
- install footprint
- use of mutable refs such as `main` or `latest`
- presence of binaries or generated archives

Suggested output:

- Low Risk
- Review Recommended
- High Risk

Important design rule:

This must be presented as a heuristic, not as a security guarantee.

The UI should always expose the reasons behind the score.

---

## 4. P3 — Workflow and organization features

### 4.1 Tool Collections / Profiles

Allow users to define reusable groups such as:

- Flutter Development
- Rust Backend
- Research
- Minimal
- Work
- Personal

Potential actions:

- enable/disable a group
- install missing members
- export/import profile metadata
- compare the current environment with a saved profile

Profiles should contain references and desired state, not copies of credentials or private configuration.

---

### 4.2 Workspace Recommendations

Use known project files to suggest relevant tools.

Examples:

- `pubspec.yaml` → Flutter/Dart-related tools
- `Cargo.toml` → Rust-related tools
- `package.json` → Node/TypeScript-related tools
- `pyproject.toml` → Python-related tools

Recommendations should:

- be opt-in or passive suggestions
- never auto-install
- avoid uploading workspace content
- use minimal local signals only

Suggested label:

> Suggested for this workspace

---

### 4.3 Tool Dependency View

Visualize relationships between tools and runtime dependencies.

Examples:

- Skill → MCP server
- Plugin → CLI
- Subagent → Skill
- Tool → required executable
- Tool → shared-store source

Primary use case:

Before removal, show what may be affected.

This can become the basis of a safer impact-analysis step.

---

### 4.4 Local Usage Analytics

Optionally track lightweight local usage metadata.

Possible fields:

- last seen / last used time
- approximate invocation count
- last successful health check

Use cases:

- identify stale tools
- show "Unused for 60 days"
- recommend cleanup

Privacy constraints:

- disabled by default unless reliable local signals exist
- do not store prompts or conversation content
- do not send usage data remotely
- document exactly what is recorded

---

## 5. Signature Feature Proposal — Agent Environment Doctor

The strongest umbrella feature is an **Agent Environment Doctor**.

It would run a read-only diagnostic pass across the user's supported AI agent environment and produce a single health report.

Example result:

> Agent Environment Doctor
>
> 7 issues found
>
> - 2 broken Skill links
> - 1 duplicate MCP registration
> - 1 missing CLI
> - 2 tools with available updates
> - 1 floating `@latest` dependency

Potential checks:

- installed agent CLIs
- PATH resolution
- Skill/Subagent locations
- MCP registrations
- duplicate/conflicting tools
- broken links
- stale sources
- floating versions
- unsupported combinations
- Remote/read-only state
- managed vs unmanaged resources

Potential surfaces:

- Dashboard button: **Run Doctor**
- VS Code command: **Agent Tool: Diagnose Environment**
- future CLI: `agent-tool doctor`

Why this is strategically useful:

It combines existing Agent Tool strengths — inventory, source tracking, compatibility, status checks, and safety boundaries — into a single recognizable product feature.

---

## 6. Suggested Implementation Order

### Phase 1

1. Conflict Detection
2. Tool Health Check
3. Diff Before Update

These provide immediate value using data Agent Tool already collects.

### Phase 2

4. Agent Environment Doctor
5. Compatibility Matrix
6. One-click Migration
7. Risk / Trust Score

The Doctor can progressively aggregate the earlier diagnostics rather than being built as a separate subsystem.

### Phase 3

8. Tool Collections / Profiles
9. Workspace Recommendations
10. Dependency View
11. Local Usage Analytics

These features broaden workflow convenience after the core management and diagnostics experience is mature.

---

## 7. Non-goals

The roadmap should not introduce behavior that weakens existing safety properties.

Avoid:

- automatic installation based only on workspace detection
- silent conflict resolution
- remote collection of prompts or tool usage
- deleting unmanaged files without explicit confirmation
- executing downloaded scripts for scoring or inspection
- treating a trust score as proof that a tool is safe

---

## 8. Product Direction

The long-term product direction can be summarized as:

> **Discover → Inspect → Install → Manage → Diagnose**

Agent Tool already covers discovery, installation, and inventory well.

The highest-value next step is to become the place where users can answer:

- What AI tools are installed?
- Which agent is actually using them?
- Are any broken or duplicated?
- What will change if I update this?
- Is this new tool worth trusting?
- Is my overall agent environment healthy?

That direction keeps the product focused while creating a clear path beyond a basic installer.
