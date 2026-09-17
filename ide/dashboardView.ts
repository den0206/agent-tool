import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

export type DashboardItem = {
  name: string;
  kind: 'skill' | 'subagent' | 'rule' | 'mcp' | 'plugin';
  scope: 'user' | 'project';
  agents: string[];
  enabled: boolean;
  origin: 'managed' | 'user' | 'bundled';
  sourcePath?: string;
  pluginScope?: 'user' | 'project' | 'local';
  repoUrl?: string;
  summary?: string;
  hasUpdate: boolean;
  pinned?: boolean;
  running?: boolean;
  mcpScope?: 'user' | 'project' | 'local';
  floating?: string;
};

/**
 * Webview の文言。`vscode.l10n.t` は拡張ホストでしか使えないので、
 * ここで引き当ててからスクリプトへ渡す（不変条件 6: en / ja を同時に持つ）。
 */
const webviewText = (): Record<string, string> => ({
  title: vscode.l10n.t("Agent Tool"),
  refresh: vscode.l10n.t("Refresh"),
  browserExtension: vscode.l10n.t("Get the browser extension"),
  checkUpdates: vscode.l10n.t("Check for updates"),
  pinned: vscode.l10n.t("Pinned"),
  clipboard: vscode.l10n.t("Found a URL in your clipboard"),
  analyzeIt: vscode.l10n.t("Analyze it"),
  noCli: vscode.l10n.t("No AI agent CLI was found on PATH. Existing tools are still listed."),
  untrusted: vscode.l10n.t("Untrusted workspace — the list is read-only. Trust the workspace to make changes."),
  remote: vscode.l10n.t("Remote window — tool changes are available only in a local window."),
  close: vscode.l10n.t("Close"),
  actions: vscode.l10n.t("Actions"),
  addSection: vscode.l10n.t("Add a tool"),
  analyze: vscode.l10n.t("Analyze"),
  analyzing: vscode.l10n.t("Analyzing URL…"),
  urlLabel: vscode.l10n.t("Public GitHub URL"),
  updates: vscode.l10n.t("Updates available"),
  updateBanner: vscode.l10n.t("{0} tools have updates"),
  showOnly: vscode.l10n.t("Show only"),
  showAll: vscode.l10n.t("Show all"),
  environment: vscode.l10n.t("Environment"),
  cliDetected: vscode.l10n.t("CLI detected"),
  configurationFound: vscode.l10n.t("Configuration found"),
  notInstalled: vscode.l10n.t("Not installed"),
  supportedFormats: vscode.l10n.t("Supported: {0}"),
  installedFormats: vscode.l10n.t("Installed: {0}"),
  none: vscode.l10n.t("None"),
  diagnostics: vscode.l10n.t("Environment diagnostics"),
  issuesCount: vscode.l10n.t("{0} issues"),
  brokenLink: vscode.l10n.t("{0} has a broken link."),
  missingSkillFile: vscode.l10n.t("{0} has no SKILL.md."),
  duplicateIdentity: vscode.l10n.t("{0} has multiple independent copies."),
  duplicateMcpName: vscode.l10n.t("{0} is registered in both user and project MCP scopes."),
  missingExecutable: vscode.l10n.t("{0} cannot resolve its launch command on PATH."),
  showUpdates: vscode.l10n.t("Show only tools with updates"),
  userGlobal: vscode.l10n.t("User Global"),
  project: vscode.l10n.t("Project"),
  otherProjects: vscode.l10n.t("Other projects"),
  chooseProject: vscode.l10n.t("Choose a project"),
  readingProject: vscode.l10n.t("Reading project…"),
  projectEmpty: vscode.l10n.t("No tools were found in this project."),
  bundled: vscode.l10n.t("Bundled"),
  showLess: vscode.l10n.t("Show less"),
  running: vscode.l10n.t("Running"),
  floating: vscode.l10n.t("Pin the version"),
  floatingWhy: vscode.l10n.t("{0} is pinned to @latest, so it can change without notice."),
  stopped: vscode.l10n.t("Stopped"),
  noAgents: vscode.l10n.t("No tools are installed for any AI agent. Add one from the URL field above."),
  noMatch: vscode.l10n.t("No tools match this filter."),
  loading: vscode.l10n.t("Loading tools…"),
  detected: vscode.l10n.t("Detected tools"),
  notFound: vscode.l10n.t("No tools were found"),
  notFoundBody: vscode.l10n.t("This URL has no Skill, MCP, Plugin, or Subagent that Agent Tool can install."),
  install: vscode.l10n.t("Install this tool"),
  installing: vscode.l10n.t("Installing…"),
  noDescription: vscode.l10n.t("No description was provided."),
  description: vscode.l10n.t("Description"),
  howToUse: vscode.l10n.t("How to use"),
  location: vscode.l10n.t("Location"),
  source: vscode.l10n.t("Source"),
  loadFailed: vscode.l10n.t("The tool list could not be read; it may be incomplete."),
  useSkill: vscode.l10n.t("Name it in chat, or ask for something it covers."),
  useSubagent: vscode.l10n.t("Delegate to it from the agent's subagent feature."),
  useRule: vscode.l10n.t("Loaded by the agent according to its frontmatter."),
  useMcp: vscode.l10n.t("Available as an MCP tool in the matching agent."),
  usePlugin: vscode.l10n.t("Use it from the matching agent's plugin feature."),
});

/**
 * Webview 本体。スクリプトには日本語を書かない（英語 UI に混ざる）。
 * `renderOthers` は他プロジェクトの欄で、User Global を見ているときだけ出し、
 * 選ばれた 1 件だけを拡張ホストに読ませる。
 * `onlyUpdates` は更新件数のクリックで立つ絞り込み。件数を全体で数えているので、
 * 一覧もエージェントとスコープを跨いで出し、件数に入らない他プロジェクト欄は畳む。
 * そうしないと数字と一覧が食い違う。
 */
export function dashboardHtml(webview: vscode.Webview): string {
  // 推測できない値にする。`Date.now()` は当てられるので nonce の意味が薄い。
  const nonce = randomUUID().replace(/-/g, '');
  const text0 = webviewText();
  // `</script>` で閉じられないよう `<` を退避してから埋め込む。
  const text = JSON.stringify(text0).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="${(vscode.env.language ?? "").startsWith("ja") ? "ja" : "en"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 12.5px;
      --at-fg-mute: var(--vscode-descriptionForeground);
      --at-fg-faint: color-mix(in srgb, var(--vscode-descriptionForeground) 65%, transparent);
      --at-border: var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 12%, transparent));
      --at-border-soft: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
      --at-card: var(--vscode-editor-background);
      --at-elev: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 4%);
      --at-accent: var(--vscode-textLink-foreground);
      --at-accent-bg: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent);
      --at-warn: var(--vscode-editorWarning-foreground);
      --at-warn-bg: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent);
      --at-ok: var(--vscode-charts-green, #7dc383);
      --at-skill: var(--vscode-charts-orange, #d97706);
      --at-subagent: var(--vscode-charts-blue, #3b82f6);
      --at-rule: var(--vscode-charts-yellow, #eab308);
      --at-mcp: var(--vscode-charts-green, #22c55e);
      --at-plugin: var(--vscode-charts-purple, #8b5cf6);
    }
    body { margin: 0; padding: 14px 14px 24px; background: var(--vscode-sideBar-background); line-height: 1.45; }
    * { box-sizing: border-box; }
    button { border:0; color:var(--vscode-button-foreground); background:var(--vscode-button-background); border-radius:5px; padding:6px 10px; cursor:pointer; font:inherit; font-size:12px; }
    button:hover { background:var(--vscode-button-hoverBackground); }
    button.ghost { color:var(--at-fg-mute); background:transparent; border:1px solid var(--at-border); padding:4px 9px; font-size:11px; }
    button.ghost:hover { background:var(--vscode-list-hoverBackground); color:var(--vscode-foreground); }
    button.icon-btn { color:var(--at-fg-mute); background:transparent; padding:3px 5px; }
    button.icon-btn:hover { background:var(--vscode-list-hoverBackground); color:var(--vscode-foreground); }
    button.link { color:var(--at-accent); background:transparent; padding:0; font-size:11px; }
    button.link:hover { background:transparent; text-decoration:underline; }
    input { min-width:0; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--at-border)); border-radius:5px; padding:6px 8px 6px 26px; font:inherit; font-size:12px; outline:none; }
    input:focus { border-color:var(--at-accent); }
    select { width:100%; color:var(--vscode-dropdown-foreground); background:var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border,var(--at-border)); border-radius:5px; padding:6px 7px; font:inherit; font-size:12px; }

    /* Header */
    header { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:14px; }
    header h1 { margin:0; font-size:13px; font-weight:700; letter-spacing:.02em; }
    header .sub { color:var(--at-fg-mute); font-size:11px; margin-top:2px; }
    header .actions { display:flex; gap:2px; align-items:center; flex-shrink:0; }

    /* Banners */
    .banner { display:flex; gap:8px; align-items:flex-start; padding:8px 10px; margin:0 0 12px; border:1px solid var(--at-border); border-left:2px solid var(--at-warn); border-radius:6px; background:var(--at-card); color:var(--vscode-foreground); font-size:12px; }
    .banner .grow { flex:1; min-width:0; }
    .banner.readonly { border-left-color:var(--at-warn); color:var(--at-warn); }
    .banner .icon { color:var(--at-warn); flex-shrink:0; margin-top:1px; }

    /* Add tool */
    .section-label { color:var(--at-fg-mute); font-size:10.5px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; margin:0 0 6px; }
    .add-form { display:flex; gap:6px; margin:0 0 16px; }
    .add-input { flex:1; position:relative; display:flex; align-items:center; }
    .add-input svg { position:absolute; left:8px; color:var(--at-fg-faint); pointer-events:none; }
    .add-input input { width:100%; }

    /* Agent segmented control */
    .agent-nav { display:flex; background:var(--at-card); border:1px solid var(--at-border); border-radius:6px; padding:2px; margin:0 0 10px; overflow-x:auto; }
    .agent { flex:1; min-width:0; display:flex; align-items:center; justify-content:center; gap:5px; background:transparent; color:var(--at-fg-mute); border:0; border-radius:4px; padding:5px 6px; font:inherit; font-size:11px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .agent:hover { background:var(--vscode-list-hoverBackground); }
    .agent.active { color:var(--vscode-foreground); background:var(--at-elev); font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,.2); }
    .agent-dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex-shrink:0; opacity:.4; }
    .agent.active .agent-dot { opacity:1; }
    .agent[data-agent="claude"] .agent-dot { color:var(--at-skill); background:currentColor; }
    .agent[data-agent="cursor"] .agent-dot { color:var(--at-subagent); background:currentColor; }
    .agent[data-agent="codex"] .agent-dot  { color:var(--at-mcp); background:currentColor; }
    .agent[data-agent="gemini"] .agent-dot { color:var(--at-plugin); background:currentColor; }

    /* Scope switch */
    .scope-row { display:flex; align-items:center; gap:8px; margin:0 0 14px; flex-wrap:wrap; }
    .scope-row .check-updates { flex-shrink:0; }
    .scope { display:inline-flex; background:var(--at-card); border:1px solid var(--at-border); border-radius:5px; padding:1px; }
    .scope button { background:transparent; color:var(--at-fg-mute); border:0; border-radius:3px; padding:3px 10px; font:inherit; font-size:11px; cursor:pointer; }
    .scope button.active { color:var(--vscode-foreground); background:var(--at-elev); }
    .scope-name { color:var(--at-fg-faint); font-size:11px; font-family:var(--vscode-editor-font-family); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }

    /* Sections and grouped lists */
    .group-header { display:flex; align-items:baseline; justify-content:space-between; margin:16px 0 6px; }
    .group-header .count { color:var(--at-fg-faint); font-size:10.5px; }
    .group { display:grid; gap:1px; background:var(--at-border-soft); border:1px solid var(--at-border-soft); border-radius:7px; overflow:hidden; margin-bottom:6px; }

    /* Rows */
    .row { display:grid; grid-template-columns:22px minmax(0,1fr) auto; gap:10px; align-items:center; padding:9px 10px; background:var(--at-card); cursor:pointer; }
    .row:hover { background:var(--vscode-list-hoverBackground); }
    .row.selected { border-left:2px solid var(--at-accent); padding-left:8px; }
    .row .glyph { width:22px; height:22px; border-radius:5px; display:grid; place-items:center; }
    .row .glyph[data-kind="skill"]    { background:color-mix(in srgb, var(--at-skill) 14%, transparent); color:var(--at-skill); }
    .row .glyph[data-kind="subagent"] { background:color-mix(in srgb, var(--at-subagent) 14%, transparent); color:var(--at-subagent); }
    .row .glyph[data-kind="rule"]     { background:color-mix(in srgb, var(--at-rule) 14%, transparent); color:var(--at-rule); }
    .row .glyph[data-kind="mcp"]      { background:color-mix(in srgb, var(--at-mcp) 14%, transparent); color:var(--at-mcp); }
    .row .glyph[data-kind="plugin"]   { background:color-mix(in srgb, var(--at-plugin) 14%, transparent); color:var(--at-plugin); }
    .row.stopped .glyph { opacity:.55; }
    .row-name { display:flex; align-items:center; gap:6px; font-size:12.5px; font-weight:500; color:var(--vscode-foreground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .row.stopped .row-name { color:var(--at-fg-mute); }
    .row-meta { font-size:10.5px; color:var(--at-fg-mute); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; }
    .row-tail { display:flex; align-items:center; gap:8px; }
    .pin { color:var(--at-fg-mute); }
    .pill { font-size:10px; padding:2px 6px; border-radius:10px; font-weight:500; white-space:nowrap; }
    .pill.update { color:var(--at-warn); background:var(--at-warn-bg); }
    .pill.floating { color:var(--at-warn); background:transparent; border:1px solid color-mix(in srgb, var(--at-warn) 35%, transparent); }
    .status-run { display:inline-flex; align-items:center; gap:5px; font-size:10px; color:var(--at-ok); font-weight:500; }
    .status-run .dot { width:6px; height:6px; border-radius:50%; background:var(--at-ok); box-shadow:0 0 6px color-mix(in srgb, var(--at-ok) 55%, transparent); }
    .status-off { color:var(--at-fg-faint); font-size:10px; }

    /* Inline detail */
    .detail-inline { background:var(--at-card); padding:0 10px 12px 34px; }
    .detail-inline-inner { border-top:1px solid var(--at-border-soft); padding-top:10px; display:grid; gap:8px; }
    .detail-inline .label { color:var(--at-fg-faint); font-size:10px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; margin-bottom:3px; }
    .detail-inline .body { color:var(--vscode-foreground); font-size:11.5px; line-height:1.55; }
    .detail-inline .mono { color:var(--at-fg-mute); font-size:11px; font-family:var(--vscode-editor-font-family); overflow-wrap:anywhere; }
    .detail-inline .floating-note { color:var(--at-warn); font-size:11px; }

    /* Preview / clipboard cards keep old .detail style */
    .detail { margin:0 0 12px; padding:11px; border:1px solid var(--at-border); border-radius:7px; background:var(--at-card); position:relative; }
    .detail .icon-btn.float-close { position:absolute; top:6px; right:6px; }
    .detail h2 { margin:0 0 8px; font-size:13px; }
    .detail p { margin:6px 0; line-height:1.5; font-size:12px; }
    .detail-path { font-family:var(--vscode-editor-font-family); font-size:11px; overflow-wrap:anywhere; color:var(--at-fg-mute); }

    /* Footer sections (Environment / Diagnostics) */
    .footer-section { margin-top:14px; }
    .footer-toggle { width:100%; display:flex; align-items:center; justify-content:space-between; background:transparent; color:var(--at-fg-mute); border:0; padding:0 0 8px; font:inherit; font-size:10.5px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; }
    .footer-toggle .caret { display:inline-flex; align-items:center; gap:6px; }
    .footer-toggle .side { color:var(--at-fg-faint); font-size:10px; letter-spacing:0; text-transform:none; font-weight:400; }
    .footer-toggle .side.warn { color:var(--at-warn); }
    .footer-body { border:1px solid var(--at-border-soft); border-radius:7px; background:var(--at-card); overflow:hidden; }
    .footer-body p { margin:0; padding:9px 10px; font-size:11.5px; border-bottom:1px solid var(--at-border-soft); }
    .footer-body p:last-child { border-bottom:0; }
    .footer-body .env-line { display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; }
    .footer-body .env-line strong { font-weight:600; font-size:12px; }
    .footer-body .env-mono { color:var(--at-fg-mute); font-family:var(--vscode-editor-font-family); font-size:11px; overflow-wrap:anywhere; }
    .footer-body .diag-line { display:flex; gap:8px; align-items:flex-start; }
    .footer-body .diag-line .mark { color:var(--at-warn); flex-shrink:0; margin-top:1px; }
    .footer-body .diag-line .mark.broken { color:var(--vscode-errorForeground, #e57373); }
    .footer-body .diag-line .body { min-width:0; flex:1; }
    .footer-body .diag-line .body .path { color:var(--at-fg-faint); font-family:var(--vscode-editor-font-family); font-size:10.5px; margin-top:2px; overflow-wrap:anywhere; }

    /* Others (dropdown) */
    #others { margin-top:14px; }
    #other-path { color:var(--at-fg-faint); font-family:var(--vscode-editor-font-family); font-size:11px; margin:6px 0 8px; overflow-wrap:anywhere; }

    /* Utility */
    .hidden { display:none; }
    .empty { color:var(--at-fg-mute); padding:18px 6px; text-align:center; font-size:12px; }
    .loading { display:flex; align-items:center; gap:8px; color:var(--at-fg-mute); font-size:12px; }
    .spinner { width:12px; height:12px; border:2px solid var(--at-border); border-top-color:var(--at-accent); border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .section-toggle { width:100%; color:var(--at-fg-mute); background:transparent; border:1px dashed var(--at-border-soft); border-radius:5px; padding:5px 0; font:inherit; font-size:11px; text-align:center; cursor:pointer; margin:4px 0 12px; }
    .section-toggle:hover { color:var(--vscode-foreground); background:var(--vscode-list-hoverBackground); }
    .row:focus-visible { outline:1px solid var(--at-accent); outline-offset:-1px; }
  </style></head><body>
  <header>
    <div>
      <h1>Agent Tool</h1>
    </div>
    <div class="actions">
      <button class="ghost" id="browser-extension">${text0.browserExtension} ↗</button>
      <button class="icon-btn" id="refresh" title="${text0.refresh}" aria-label="${text0.refresh}"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.3 8a5.3 5.3 0 1 1-1.55-3.75"/><path d="M13.5 3v3h-3"/></svg></button>
    </div>
  </header>
  <div class="banner hidden" id="banner"></div>
  <div class="banner hidden" id="load-error"></div>
  <div class="banner hidden" id="update-banner"></div>
  <div class="section-label">${text0.addSection}</div>
  <form class="add-form" id="add-form">
    <div class="add-input">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2a6 6 0 0 0-1.9 11.7c.3.05.4-.13.4-.28v-1c-1.68.36-2.03-.8-2.03-.8-.27-.7-.68-.88-.68-.88-.56-.38.04-.37.04-.37.62.04.94.63.94.63.55.94 1.44.67 1.8.51.05-.4.21-.67.4-.83-1.34-.15-2.75-.67-2.75-3a2.35 2.35 0 0 1 .62-1.63c-.06-.15-.27-.77.06-1.6 0 0 .51-.16 1.67.62a5.8 5.8 0 0 1 3.04 0c1.16-.78 1.67-.62 1.67-.62.33.83.12 1.45.06 1.6a2.35 2.35 0 0 1 .62 1.63c0 2.34-1.41 2.85-2.75 3 .22.18.41.55.41 1.12v1.65c0 .16.11.34.42.28A6 6 0 0 0 8 2z"/></svg>
      <input id="tool-url" type="url" maxlength="2048" required placeholder="https://github.com/owner/repository" aria-label="${text0.urlLabel}">
    </div>
    <button type="submit">${text0.analyze}</button>
  </form>
  <section class="detail hidden" id="clip"></section>
  <section class="detail hidden" id="preview"></section>
  <nav class="agent-nav" id="agents" aria-label="AI Agents"></nav>
  <div class="scope-row" id="filters"></div>
  <div id="content"></div>
  <section id="others"></section>
  <section id="environment" class="footer-section"></section>
  <section id="diagnostics" class="footer-section"></section>
  <script nonce="${nonce}">
  const vscode = acquireVsCodeApi(); const T = ${text};
  let items = []; let issues = []; let diagnostics = []; let loadError = '';
  let agent = ''; let scope = 'user'; let projectName = 'Current Project'; let sectionExpanded = {};
  let onlyUpdates = false; let loaded = false; let selected = '';
  let projects = []; let otherPath = ''; let otherItems = []; let otherLoading = false; let otherError = ''; let otherIssues = [];
  let lastPreview = null; let environment = []; let compatibility = []; let readOnly = '';
  const kinds = {skill:'Skills',subagent:'Subagents',rule:'Rules',mcp:'MCP Servers',plugin:'Plugins'};
  const kindOrder = ['skill','subagent','rule','mcp','plugin'];
  const icons = {
    skill:'<svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor"><path d="M2 0h10v14H2V0zm2 3h6v1.5H4V3zm0 3h6v1.5H4V6zm0 3h4v1.5H4V9z"/></svg>',
    subagent:'<svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor"><circle cx="7" cy="4" r="3"/><path d="M1 13.5c0-3.3 2.7-6 6-6s6 2.7 6 6H1z"/></svg>',
    rule:'<svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor"><path d="M2 1h10v2H2V1zm0 4h10v1.5H2V5zm0 3.5h7V10H2V8.5zM2 11.5h10V13H2v-1.5z"/></svg>',
    mcp:'<svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor"><rect x="1" y="0" width="12" height="5" rx="1.5"/><rect x="1" y="7" width="12" height="5" rx="1.5"/></svg>',
    plugin:'<svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor"><path d="M5 0h1.5v3H5zm3.5 0H10v3H8.5zM2.5 3h9v2.5a4.5 4.5 0 01-3.5 4.4V14h-2v-3.6A4.5 4.5 0 012.5 5.5V3z"/></svg>'
  };
  const agentNames = {claude:'Claude Code',cursor:'Cursor',codex:'Codex',gemini:'Gemini CLI'};
  const agentShort = {claude:'Claude',cursor:'Cursor',codex:'Codex',gemini:'Gemini'};
  const esc = s => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const keyOf = x => x.name+'|'+x.kind+'|'+x.scope+'|'+(x.sourcePath||'');
  const shortName = p => String(p).split(/[\\\\/]/).filter(Boolean).pop() || String(p);

  const pinSvg = '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M9.828 1.172a.5.5 0 0 0-.707 0l-1.06 1.06a.5.5 0 0 0-.147.354v3.5L4.5 9.5V10h2.5v4.5h1V10h2.5v-.5L7.086 6.086v-3.5a.5.5 0 0 0-.146-.354L9.828 1.172z"/></svg>';
  const floatSvg = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4v4"/><circle cx="8" cy="10.5" r=".6" fill="currentColor" stroke="none"/><path d="M8 1.5 14.5 13H1.5L8 1.5z"/></svg>';
  const warnSvg = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4v4"/><circle cx="8" cy="10.5" r=".6" fill="currentColor" stroke="none"/><path d="M8 1.5 14.5 13H1.5L8 1.5z"/></svg>';

  function rowTail(x, other) {
    const bits = [];
    if (x.hasUpdate) bits.push('<span class="pill update">'+esc(T.updates)+'</span>');
    if (x.floating) bits.push('<span class="pill floating" title="'+esc(T.floatingWhy.replace('{0}',x.floating))+'">'+esc(T.floating)+'</span>');
    if (x.kind === 'mcp' && !other) {
      bits.push(x.running
        ? '<span class="status-run"><span class="dot"></span>'+esc(T.running)+'</span>'
        : '<span class="status-off">'+esc(T.stopped)+'</span>');
    }
    if (!other) bits.push('<button class="icon-btn action" data-index="'+items.indexOf(x)+'" title="'+esc(T.actions)+'">•••</button>');
    return '<div class="row-tail">'+bits.join('')+'</div>';
  }
  function rowHtml(x, other, i) {
    const at = other ? ' data-other="'+i+'"' : ' data-index="'+items.indexOf(x)+'"';
    const cls = 'row' + (selected===keyOf(x)?' selected':'') + (x.kind==='mcp' && !x.running && !other ? ' stopped' : '');
    const nameBits = [esc(x.name)];
    if (x.pinned) nameBits.push('<span class="pin" title="'+esc(T.pinned)+'">'+pinSvg+'</span>');
    if (x.floating) nameBits.push('<span class="pin" style="color:var(--at-warn)">'+floatSvg+'</span>');
    const metaBits = [];
    if (x.origin === 'bundled') metaBits.push(esc(T.bundled));
    if (x.repoUrl) metaBits.push(esc(x.repoUrl.replace(/^https?:\\/\\//,'')));
    else if (x.sourcePath) metaBits.push(esc(x.sourcePath));
    const meta = metaBits.length ? '<div class="row-meta">'+metaBits.join(' · ')+'</div>' : '';
    return '<div class="'+cls+'"'+at+' role="button" tabindex="0" aria-expanded="'+(selected===keyOf(x))+'">'
      + '<div class="glyph" data-kind="'+x.kind+'">'+icons[x.kind]+'</div>'
      + '<div style="min-width:0"><div class="row-name">'+nameBits.join('')+'</div>'+meta+'</div>'
      + rowTail(x, other) + '</div>' + (selected===keyOf(x) ? detailHtml(x) : '');
  }
  function rowsHtml(rows) { return rows.map((x,i)=>rowHtml(x, false, i)).join(''); }
  function bundledHtml(rows) {
    const exp = sectionExpanded['bundled'];
    const head = '<div class="group-header"><div class="section-label">'+esc(T.bundled)+'</div><div class="count">'+rows.length+'</div></div>';
    const body = exp ? '<div class="group">'+rows.map((x,i)=>rowHtml(x, false, i)).join('')+'</div>' : '';
    const tog = '<button class="section-toggle" data-kind="bundled">'+(exp?'⌃ '+esc(T.showLess):'⌄ '+rows.length+' more')+'</button>';
    return head + body + tog;
  }
  function groupHtml(title, rows, kv, other) {
    const exp = sectionExpanded[kv]; const cap = 5;
    const shown = (!exp && rows.length > cap) ? rows.slice(0, cap) : rows;
    const rest = rows.length - shown.length;
    const tog = rows.length > cap
      ? '<button class="section-toggle" data-kind="'+kv+'">'+(exp?'⌃ '+esc(T.showLess):'⌄ '+rest+' more')+'</button>'
      : '';
    const body = '<div class="group">'+shown.map((x,i)=>rowHtml(x, other, i)).join('')+'</div>'+tog;
    const header = '<div class="group-header"><div class="section-label">'+esc(title)+'</div><div class="count">'+rows.length+'</div></div>';
    return header + body;
  }
  function bindRows(nodes, pick) {
    nodes.forEach(node=>{
      const open=()=>toggleDetail(pick(node));
      node.onclick=open;
      node.onkeydown=e=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); open(); } };
    });
  }
  function renderOthers() {
    const box=document.querySelector('#others');
    if (scope!=='user'||!projects.length||onlyUpdates) { box.innerHTML=''; box.dataset.list=''; return; }
    const listKey=projects.join('|');
    if (box.dataset.list!==listKey) {
      box.innerHTML='<div class="section-label" style="margin-top:16px">'+esc(T.otherProjects)+'</div>'
        + '<select id="other-project" aria-label="'+esc(T.otherProjects)+'"><option value="">'+esc(T.chooseProject)+'</option>'
        + projects.map(p=>'<option value="'+esc(p)+'">'+esc(shortName(p))+'</option>').join('') + '</select>'
        + '<p id="other-path"></p><div id="other-body"></div>';
      box.dataset.list=listKey;
      document.querySelector('#other-project').onchange=e=>{
        otherPath=e.target.value; otherItems=[]; otherError=''; otherIssues=[]; otherLoading=otherPath!==''; renderOthers();
        if (otherPath) vscode.postMessage({type:'selectProject',path:otherPath});
      };
    }
    document.querySelector('#other-project').value=otherPath;
    document.querySelector('#other-path').textContent=otherPath;
    const rows=otherItems.filter(x=>x.agents.includes(agent));
    const body=document.querySelector('#other-body');
    const warn = otherError ? '<div class="empty">'+esc(otherError)+'</div>'
      : (otherIssues.length ? '<div class="empty">'+esc(T.loadFailed)+'<br>'+otherIssues.map(esc).join('<br>')+'</div>' : '');
    body.innerHTML = !otherPath ? ''
      : otherLoading ? '<div class="loading"><span class="spinner"></span>'+esc(T.readingProject)+'</div>'
      : warn + (rows.length ? '<div class="group">'+rows.map((x,i)=>rowHtml(x,true,i)).join('')+'</div>' : (warn ? '' : '<div class="empty">'+esc(T.projectEmpty)+'</div>'));
    bindRows(body.querySelectorAll('.row[data-other]'), node=>rows[Number(node.dataset.other)]);
  }
  function render() {
    const agents=Object.keys(agentNames).filter(a=>items.some(x=>x.agents.includes(a)));
    if (!agents.includes(agent)) agent=agents[0]??'';
    const updates=items.filter(x=>x.hasUpdate).length;
    if (updates===0) onlyUpdates=false;
    const visible=onlyUpdates
      ? items.filter(x=>x.hasUpdate)
      : items.filter(x=>x.agents.includes(agent) && x.scope===scope);

    // Update banner (click toggles filter)
    const ub = document.querySelector('#update-banner');
    if (updates > 0) {
      ub.innerHTML = '<span class="icon">'+warnSvg+'</span><div class="grow">'+esc(T.updateBanner.replace('{0}', updates))+'</div>'
        + '<button class="link" id="only-updates" title="'+esc(T.showUpdates)+'" aria-pressed="'+onlyUpdates+'">'+esc(onlyUpdates?T.showAll:T.showOnly)+'</button>';
      ub.classList.remove('hidden');
      const btn = document.querySelector('#only-updates');
      if (btn) btn.onclick = () => { onlyUpdates=!onlyUpdates; hideDetail(); render(); };
    } else {
      ub.classList.add('hidden'); ub.innerHTML='';
    }

    renderBanner();

    // Agent segmented control
    const nav = document.querySelector('#agents');
    nav.innerHTML = agents.length
      ? agents.map(a=>{
          const cnt = items.filter(x=>x.agents.includes(a) && x.origin!=='bundled').length;
          return '<button class="agent '+(a===agent?'active':'')+'" data-agent="'+a+'" role="tab" aria-selected="'+(a===agent)+'">'
            + '<span class="agent-dot"></span><span>'+esc(agentShort[a])+'</span><span style="color:var(--at-fg-faint); font-size:10.5px">'+cnt+'</span></button>';
        }).join('')
      : (loaded ? '<div class="empty" style="width:100%">'+esc(T.noAgents)+'</div>' : '');

    // Scope switch
    document.querySelector('#filters').innerHTML =
      '<div class="scope">'
        + '<button data-filter="user" class="'+(scope==='user'?'active':'')+'">'+esc(T.userGlobal)+'</button>'
        + '<button data-filter="project" class="'+(scope==='project'?'active':'')+'">'+esc(T.project)+'</button>'
      + '</div>'
      + (scope==='project' ? '<span class="scope-name">'+esc(projectName)+'</span>' : '')
      + '<button class="ghost check-updates" id="check-updates" title="'+esc(T.checkUpdates)+'" style="margin-left:auto">'+esc(T.checkUpdates)+'</button>';

    // Content
    const yours=visible.filter(x=>x.origin!=='bundled');
    const bundled=visible.filter(x=>x.origin==='bundled');
    const yourGroups = kindOrder.map(k=>[kinds[k], yours.filter(x=>x.kind===k), k]).filter(([,rows])=>rows.length);
    document.querySelector('#content').innerHTML = !loaded
      ? '<div class="loading"><span class="spinner"></span>'+esc(T.loading)+'</div>'
      : (visible.length
          ? yourGroups.map(([title,rows,kv])=>groupHtml(title,rows,kv,false)).join('')
            + (bundled.length ? bundledHtml(bundled) : '')
          : '<div class="empty">'+esc(T.noMatch)+'</div>');

    // Environment (collapsible)
    const envBox = document.querySelector('#environment');
    if (environment.length) {
      const detected = environment.filter(e=>e.path||e.found||e.configOnly).length;
      const side = detected + ' / ' + environment.length;
      envBox.innerHTML = '<button class="footer-toggle" data-fold="environment" aria-expanded="'+!!sectionExpanded.environment+'">'
        + '<span class="caret">'+(sectionExpanded.environment?'⌄':'›')+' '+esc(T.environment)+'</span>'
        + '<span class="side">'+esc(side)+'</span></button>'
        + (sectionExpanded.environment ? '<div class="footer-body">'+environment.map(info=>{
            const c=compatibility.find(x=>x.id===info.id)||{supported:[],installed:[]};
            const state=info.path?T.cliDetected:(info.found||info.configOnly?T.configurationFound:T.notInstalled);
            const list=xs=>xs.length?xs.map(x=>kinds[x]).join(', '):T.none;
            return '<p><span class="env-line">'+(info.path?'●':'○')+' <strong>'+esc(info.displayName)+'</strong> · '+esc(state)+(info.version?' · '+esc(info.version):'')+'</span>'
              + '<br><span class="env-mono">'+esc(T.supportedFormats.replace('{0}',list(c.supported)))+'<br>'+esc(T.installedFormats.replace('{0}',list(c.installed)))+'</span>'
              + (info.path?'<br><span class="env-mono">'+esc(info.path)+'</span>':'')
              + '</p>';
          }).join('')+'</div>' : '');
    } else {
      envBox.innerHTML='';
    }

    // Diagnostics (collapsible)
    const diagBox = document.querySelector('#diagnostics');
    if (diagnostics.length) {
      diagBox.innerHTML = '<button class="footer-toggle" data-fold="diagnostics" aria-expanded="'+!!sectionExpanded.diagnostics+'">'
        + '<span class="caret">'+(sectionExpanded.diagnostics?'⌄':'›')+' '+esc(T.diagnostics)+'</span>'
        + '<span class="side warn">'+esc(T.issuesCount.replace('{0}',diagnostics.length))+'</span></button>'
        + (sectionExpanded.diagnostics ? '<div class="footer-body">'+diagnostics.map(d=>{
            const paths = (d.targets||[]).map(t=>t.sourcePath).filter(Boolean);
            return '<p class="diag-line"><span class="mark '+(d.severity==='broken'?'broken':'')+'">'+(d.severity==='broken'?'✗':warnSvg)+'</span>'
              + '<span class="body">'+esc(diagnosticText(d))
              + (paths.length ? '<br><span class="path">'+paths.map(esc).join('<br>')+'</span>' : '')
              + '</span></p>';
          }).join('')+'</div>' : '');
    } else {
      diagBox.innerHTML='';
    }

    // Bindings
    document.querySelectorAll('[data-agent]').forEach(b=>b.onclick=()=>{agent=b.dataset.agent; onlyUpdates=false; hideDetail(); render();});
    document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{scope=b.dataset.filter; onlyUpdates=false; hideDetail(); render();});
    const cu=document.querySelector('#check-updates'); if (cu) cu.onclick=()=>vscode.postMessage({type:'checkUpdates'});
    bindRows(document.querySelectorAll('#content .row[data-index]'), node=>items[Number(node.dataset.index)]);
    document.querySelectorAll('.action').forEach(b=>b.onclick=e=>{e.stopPropagation(); vscode.postMessage({type:'actions',item:items[Number(b.dataset.index)]});});
    document.querySelectorAll('.section-toggle').forEach(b=>b.onclick=()=>{const key=b.dataset.kind; sectionExpanded[key]=!sectionExpanded[key]; render();});
    document.querySelectorAll('.footer-toggle').forEach(b=>b.onclick=()=>{const key=b.dataset.fold; sectionExpanded[key]=!sectionExpanded[key]; render();});
    renderOthers();
  }
  function renderBanner() {
    const box=document.querySelector('#banner');
    const noCli=environment.length>0 && environment.every(x=>!x.found);
    const text = readOnly==='untrusted' ? T.untrusted : (readOnly==='remote' ? T.remote : (noCli ? T.noCli : ''));
    box.innerHTML = text ? '<span class="icon">'+warnSvg+'</span><span>'+esc(text)+'</span>' : '';
    box.classList.toggle('hidden', text==='');
    box.classList.toggle('readonly', text!=='' && (readOnly==='untrusted' || readOnly==='remote'));
    // Keep load failures visible alongside the read-only notice, or a broken registry goes unnoticed.
    const errs=(loadError?[loadError]:[]).concat(issues);
    const failBox=document.querySelector('#load-error');
    failBox.innerHTML = errs.length ? '<span class="icon">'+warnSvg+'</span><span>'+esc(T.loadFailed)+'<br>'+errs.map(esc).join('<br>')+'</span>' : '';
    failBox.classList.toggle('hidden', errs.length===0);
  }
  function diagnosticText(d) {
    const name=d.targets&&d.targets[0]?d.targets[0].name:'';
    const key={BROKEN_LINK:'brokenLink',MISSING_SKILL_FILE:'missingSkillFile',DUPLICATE_IDENTITY:'duplicateIdentity',DUPLICATE_MCP_NAME:'duplicateMcpName',MISSING_EXECUTABLE:'missingExecutable'}[d.code];
    return (T[key]||d.message||'').replace('{0}',name);
  }
  function hideDetail() { selected=''; }
  function toggleDetail(x) { selected = selected===keyOf(x) ? '' : keyOf(x); render(); }
  function detailHtml(x) {
    const usage=esc({skill:T.useSkill,subagent:T.useSubagent,rule:T.useRule,mcp:T.useMcp,plugin:T.usePlugin}[x.kind]||'');
    return '<div class="detail-inline"><div class="detail-inline-inner">'
      + '<div><div class="label">'+esc(T.description)+'</div><div class="body">'+esc(x.summary||T.noDescription)+'</div></div>'
      + '<div><div class="label">'+esc(T.howToUse)+'</div><div class="body">'+usage+'</div></div>'
      + (x.sourcePath?'<div><div class="label">'+esc(T.location)+'</div><div class="mono">'+esc(x.sourcePath)+'</div></div>':'')
      + (x.repoUrl?'<div><div class="label">'+esc(T.source)+'</div><div class="mono">'+esc(x.repoUrl)+'</div></div>':'')
      + (x.floating?'<div class="floating-note">'+esc(T.floatingWhy.replace('{0}',x.floating))+'</div>':'')
      + '</div></div>';
  }
  const element = (tag, className, text) => { const node=document.createElement(tag); if(className) node.className=className; if(text!==undefined) node.textContent=String(text); return node; };
  function showClipboard(url) {
    const box=document.querySelector('#clip'); box.replaceChildren();
    const close=element('button','icon-btn float-close','×'); close.id='clip-close'; close.title=T.close; box.append(close);
    box.append(element('h2','',T.clipboard), element('p','detail-path',url));
    const use=element('button','',T.analyzeIt); use.id='clip-use'; box.append(use); box.classList.remove('hidden');
    close.onclick=()=>box.classList.add('hidden');
    use.onclick=()=>{ box.classList.add('hidden'); document.querySelector('#tool-url').value=url; vscode.postMessage({type:'analyzeTool',url}); };
  }
  function hidePreview() { lastPreview=null; document.querySelector('#preview').classList.add('hidden'); }
  function showPreview(result) {
    lastPreview=result; const panel=document.querySelector('#preview'); const rows=result.candidates||[]; panel.replaceChildren();
    const close=element('button','icon-btn float-close','×'); close.id='close-preview'; close.title=T.close; close.onclick=hidePreview; panel.append(close);
    if (result.loading) {
      const loading=element('div','loading'); loading.append(element('span','spinner'), document.createTextNode(T.analyzing)); panel.append(loading);
    } else if (rows.length) {
      panel.append(element('h2','',T.detected));
      rows.forEach((x,i)=>{
        const row=element('p'); const strong=element('strong','',x.installSelector||x.name);
        row.append(strong, document.createTextNode(' · '+(kinds[x.kind]||x.kind)), document.createElement('br'), document.createTextNode(x.description||T.noDescription), document.createElement('br'));
        const install=element('button','install',T.install); install.dataset.index=String(i);
        install.onclick=()=>{ install.disabled=true; install.textContent=T.installing; const candidate=rows[i]; vscode.postMessage({type:'installTool',url:result.url,kind:candidate.kind,name:candidate.name,selector:candidate.installSelector}); };
        row.append(install); panel.append(row);
      });
    } else {
      panel.append(element('h2','',T.notFound), element('p','',result.error||T.notFoundBody));
    }
    panel.classList.remove('hidden');
  }
  document.querySelector('#refresh').onclick=()=>vscode.postMessage({type:'refresh'});
  document.querySelector('#browser-extension').onclick=()=>vscode.postMessage({type:'openBrowserExtension'});
  document.querySelector('#add-form').onsubmit=e=>{e.preventDefault(); vscode.postMessage({type:'analyzeTool',url:document.querySelector('#tool-url').value});};
  window.addEventListener('message',e=>{
    if (e.data.type==='inventory') {
      loaded=true; items=e.data.items; issues=e.data.issues||[]; diagnostics=e.data.diagnostics||[]; loadError=e.data.error||'';
      if (e.data.projectName) projectName=e.data.projectName;
      projects=e.data.projects||[]; environment=e.data.environment||environment; compatibility=e.data.compatibility||compatibility; readOnly=e.data.readOnly||'';
      if (otherPath && !projects.includes(otherPath)) { otherPath=''; otherItems=[]; otherError=''; otherIssues=[]; }
      render();
    }
    if (e.data.type==='projectInventory' && e.data.path===otherPath) { otherLoading=false; otherItems=e.data.items||[]; otherIssues=e.data.issues||[]; otherError=e.data.error||''; renderOthers(); }
    if (e.data.type==='clipboard') showClipboard(e.data.url);
    if (e.data.type==='installDone') { if (e.data.ok) hidePreview(); else if (lastPreview) showPreview(lastPreview); }
    if (e.data.type==='analysisStart') showPreview(e.data);
    if (e.data.type==='preview') showPreview(e.data);
  });
  render();
  </script></body></html>`;
}
