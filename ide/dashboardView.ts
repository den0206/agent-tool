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
  subtitle: vscode.l10n.t("AI agent tools in this workspace"),
  refresh: vscode.l10n.t("Refresh"),
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
  yourTools: vscode.l10n.t("Your tools"),
  updates: vscode.l10n.t("Updates available"),
  environment: vscode.l10n.t("Environment"),
  cliDetected: vscode.l10n.t("CLI detected"),
  configurationFound: vscode.l10n.t("Configuration found"),
  notInstalled: vscode.l10n.t("Not installed"),
  supportedFormats: vscode.l10n.t("Supported: {0}"),
  installedFormats: vscode.l10n.t("Installed: {0}"),
  none: vscode.l10n.t("None"),
  diagnostics: vscode.l10n.t("Environment diagnostics"),
  brokenLink: vscode.l10n.t("{0} has a broken link."),
  missingSkillFile: vscode.l10n.t("{0} has no SKILL.md."),
  duplicateIdentity: vscode.l10n.t("{0} has multiple independent copies."),
  duplicateMcpName: vscode.l10n.t("{0} is registered in both user and project MCP scopes."),
  missingExecutable: vscode.l10n.t("{0} cannot resolve its launch command on PATH."),
  showUpdates: vscode.l10n.t("Show only tools with updates"),
  userGlobal: vscode.l10n.t("User Global"),
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
  // `</script>` で閉じられないよう `<` を退避してから埋め込む。
  const text0 = webviewText();
  const text = JSON.stringify(text0).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="${(vscode.env.language ?? "").startsWith("ja") ? "ja" : "en"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
    body { margin: 0; padding: 16px; background: var(--vscode-sideBar-background); }
    header { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
    h1 { margin:0; font-size:17px; letter-spacing:-.2px; } .sub { color:var(--vscode-descriptionForeground); margin-top:3px; font-size:12px; }
    button { border:0; color:var(--vscode-button-foreground); background:var(--vscode-button-background); border-radius:6px; padding:7px 9px; cursor:pointer; font:inherit; }
    button:hover { background:var(--vscode-button-hoverBackground); } button.icon { color:var(--vscode-foreground); background:transparent; font-size:16px; padding:5px 8px; } button.header-action { color:var(--vscode-foreground); background:transparent; font-size:12px; padding:5px 8px; }
    .banner { display:flex; gap:8px; align-items:flex-start; padding:9px 11px; margin:0 0 14px; border:1px solid var(--vscode-editorWarning-foreground); border-radius:8px; color:var(--vscode-editorWarning-foreground); }
    .overview { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-bottom:18px; }
    .metric { padding:11px; border:1px solid var(--vscode-widget-border); border-radius:8px; background:var(--vscode-editor-background); }
    .metric.clickable { cursor:pointer; } .metric.active { border-color:var(--vscode-focusBorder); }
    .metric strong { display:block; font-size:21px; line-height:22px; } .metric span { color:var(--vscode-descriptionForeground); font-size:11px; }
    .agent-nav { display:flex; overflow-x:auto; margin:0 0 18px; border-bottom:1px solid var(--vscode-widget-border); } .agent { flex:0 0 auto; display:flex; align-items:center; gap:5px; color:var(--vscode-foreground); background:transparent; border-radius:0; border-bottom:2px solid transparent; padding:8px 12px 7px; }
    .agent:hover { background:var(--vscode-list-hoverBackground); } .agent.active { color:var(--vscode-textLink-foreground); border-bottom-color:var(--vscode-textLink-foreground); } .agent-count { display:none; }
    .bar { display:flex; gap:7px; align-items:center; margin:0 0 12px; } .add-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px; margin:0 0 14px; } input { min-width:0; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:6px; padding:7px 8px; font:inherit; }
    .filters { display:flex; gap:5px; overflow:auto; margin-bottom:12px; padding-bottom:2px; } .filter { white-space:nowrap; background:var(--vscode-editor-background); color:var(--vscode-foreground); border:1px solid var(--vscode-widget-border); padding:5px 8px; }
    .filter.active { color:var(--vscode-button-foreground); background:var(--vscode-button-background); border-color:var(--vscode-button-background); }
    .section { color:var(--vscode-foreground); font-size:12px; font-weight:700; letter-spacing:.3px; margin:20px 0 8px; padding:0 0 6px; border-bottom:1px solid var(--vscode-widget-border); text-transform:uppercase; }
    .list { display:grid; gap:6px; } .item { cursor:pointer; display:grid; grid-template-columns:27px minmax(0,1fr) auto; gap:9px; align-items:center; padding:9px; border:1px solid var(--vscode-widget-border); border-radius:8px; background:var(--vscode-editor-background); }
    .glyph { display:grid; place-items:center; width:27px; height:27px; border-radius:7px; background:color-mix(in srgb, var(--vscode-button-background) 20%, transparent); color:var(--vscode-textLink-foreground); font-size:14px; }
    .glyph[data-kind="skill"]    { background:color-mix(in srgb,var(--vscode-charts-orange,#d97706) 15%,transparent); color:var(--vscode-charts-orange,#d97706); }
    .glyph[data-kind="subagent"] { background:color-mix(in srgb,var(--vscode-charts-blue,#3b82f6) 15%,transparent); color:var(--vscode-charts-blue,#3b82f6); }
    .glyph[data-kind="rule"]     { background:color-mix(in srgb,var(--vscode-charts-yellow,#eab308) 15%,transparent); color:var(--vscode-charts-yellow,#eab308); }
    .glyph[data-kind="mcp"]      { background:color-mix(in srgb,var(--vscode-charts-green,#22c55e) 15%,transparent); color:var(--vscode-charts-green,#22c55e); }
    .glyph[data-kind="plugin"]   { background:color-mix(in srgb,var(--vscode-charts-purple,#8b5cf6) 15%,transparent); color:var(--vscode-charts-purple,#8b5cf6); }
    .agent-dot { width:6px; height:6px; border-radius:50%; background:var(--vscode-descriptionForeground); opacity:.3; flex-shrink:0; }
    .agent.active .agent-dot { opacity:1; }
    .agent[data-agent="claude"] .agent-dot { background:var(--vscode-charts-orange,#d97706); }
    .agent[data-agent="cursor"] .agent-dot { background:var(--vscode-charts-blue,#3b82f6); }
    .agent[data-agent="codex"]  .agent-dot { background:var(--vscode-charts-green,#22c55e); }
    .agent[data-agent="gemini"] .agent-dot { background:var(--vscode-charts-purple,#8b5cf6); }
    .agent-badge { display:flex; align-items:center; gap:10px; padding:9px 11px; margin:0 0 12px; border-radius:8px; background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); }
    .badge-pip { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
    .badge-pip[data-agent="claude"] { background:var(--vscode-charts-orange,#d97706); }
    .badge-pip[data-agent="cursor"] { background:var(--vscode-charts-blue,#3b82f6); }
    .badge-pip[data-agent="codex"]  { background:var(--vscode-charts-green,#22c55e); }
    .badge-pip[data-agent="gemini"] { background:var(--vscode-charts-purple,#8b5cf6); }
    .badge-name { font-weight:700; font-size:13px; }
    .badge-count { color:var(--vscode-descriptionForeground); font-size:11px; margin-left:auto; }
    .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; } .meta { color:var(--vscode-descriptionForeground); font-size:11px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .state { font-size:11px; color:var(--vscode-descriptionForeground); } .state.update { color:var(--vscode-editorWarning-foreground); } .state.off { opacity:.7; }
    select { width:100%; color:var(--vscode-dropdown-foreground); background:var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border)); border-radius:6px; padding:6px 7px; font:inherit; }
    #other-path { color:var(--vscode-descriptionForeground); font-family:var(--vscode-editor-font-family); font-size:11px; margin:6px 0 8px; overflow-wrap:anywhere; }
    .empty { color:var(--vscode-descriptionForeground); padding:28px 8px; text-align:center; } .hidden { display:none; } .bundled-toggle { width:100%; color:var(--vscode-descriptionForeground); background:transparent; padding:3px 0; text-align:left; font-size:11px; font-weight:600; letter-spacing:.4px; text-transform:uppercase; } .section-toggle { width:100%; color:var(--vscode-descriptionForeground); background:transparent; border:1px solid var(--vscode-widget-border); border-top:none; border-radius:0 0 8px 8px; padding:6px 0; font-size:11px; font-weight:600; text-align:center; margin-bottom:6px; } .fold-toggle { text-align:left; } .item:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:1px; } .item + .detail { margin:0 0 6px; } .detail { margin:0 0 16px; padding:11px; border:1px solid var(--vscode-widget-border); border-radius:8px; background:var(--vscode-editor-background); } .detail > .icon { float:right; } .detail h2 { margin:0 0 8px; font-size:14px; } .detail p { margin:7px 0; line-height:1.45; } .detail-label { color:var(--vscode-descriptionForeground); font-size:11px; font-weight:600; } .detail-path { font-family:var(--vscode-editor-font-family); font-size:11px; overflow-wrap:anywhere; } .issues { grid-column:1/-1; border-color:var(--vscode-editorWarning-foreground); } .issues strong { color:var(--vscode-editorWarning-foreground); font-size:15px; } .loading { display:flex; align-items:center; gap:8px; color:var(--vscode-descriptionForeground); } .spinner { width:14px; height:14px; border:2px solid var(--vscode-widget-border); border-top-color:var(--vscode-textLink-foreground); border-radius:50%; animation:spin .8s linear infinite; } @keyframes spin { to { transform:rotate(360deg) } }
  </style></head><body><header><div><h1>Agent Tool</h1><div class="sub">${text0.subtitle}</div></div><div><button class="header-action" title="${text0.checkUpdates}" id="check-updates">${text0.checkUpdates}</button><button class="header-action" title="${text0.refresh}" id="refresh">${text0.refresh}</button></div></header><div class="banner hidden" id="banner"></div><div class="overview" id="overview"></div><div class="section">${text0.addSection}</div><form class="add-form" id="add-form"><input id="tool-url" type="url" maxlength="2048" required placeholder="https://github.com/owner/repository" aria-label="${text0.urlLabel}"><button type="submit">${text0.analyze}</button></form><section class="detail hidden" id="clip"></section><section class="detail hidden" id="preview"></section><nav class="agent-nav" id="agents" aria-label="AI Agents"></nav><div class="agent-badge" id="agent-badge"></div><div class="filters" id="filters"></div><div id="content"></div><section id="others"></section><section id="environment"></section><section id="diagnostics"></section><script nonce="${nonce}">
  const vscode = acquireVsCodeApi(); const T = ${text}; let items = []; let issues = []; let diagnostics = []; let loadError = ''; let agent = ''; let scope = 'project'; let projectName = 'Current Project'; let sectionExpanded = {}; let onlyUpdates = false; let loaded = false; let selected = ''; let projects = []; let otherPath = ''; let otherItems = []; let otherLoading = false; let otherError = ''; let lastPreview = null; let environment = []; let compatibility = []; let readOnly = ''; let otherIssues = [];
  const kinds = {skill:'Skill',subagent:'Subagent',rule:'Rule',mcp:'MCP',plugin:'Plugin'}; const icons = {skill:'<svg viewBox="0 0 14 14" width="13" height="13" fill="currentColor"><path d="M2 0h10v14H2V0zm2 3h6v1.5H4V3zm0 3h6v1.5H4V6zm0 3h4v1.5H4V9z"/></svg>',subagent:'<svg viewBox="0 0 14 14" width="13" height="13" fill="currentColor"><circle cx="7" cy="4" r="3"/><path d="M1 13.5c0-3.3 2.7-6 6-6s6 2.7 6 6H1z"/></svg>',rule:'<svg viewBox="0 0 14 14" width="13" height="13" fill="currentColor"><path d="M2 1h10v2H2V1zm0 4h10v1.5H2V5zm0 3.5h7V10H2V8.5zM2 11.5h10V13H2v-1.5z"/></svg>',mcp:'<svg viewBox="0 0 14 14" width="13" height="13" fill="currentColor"><rect x="1" y="0" width="12" height="5" rx="1.5"/><rect x="1" y="7" width="12" height="5" rx="1.5"/></svg>',plugin:'<svg viewBox="0 0 14 14" width="13" height="13" fill="currentColor"><path d="M5 0h1.5v3H5zm3.5 0H10v3H8.5zM2.5 3h9v2.5a4.5 4.5 0 01-3.5 4.4V14h-2v-3.6A4.5 4.5 0 012.5 5.5V3z"/></svg>'}; const agentNames = {claude:'Claude Code',cursor:'Cursor',codex:'Codex',gemini:'Gemini CLI'};
  const esc = s => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  function rowsHtml(rows, other) { return '<div class="list">'+rows.map((x,i)=>{ const meta=esc(x.agents.join(' · '))+' · '+kinds[x.kind]+(!other&&x.kind==='mcp'?' · '+esc(x.running?T.running:T.stopped):'')+(x.floating?' · <span class="state update">'+esc(T.floating)+'</span>':'')+(x.pinned?' · 📌 '+esc(T.pinned):'')+(x.hasUpdate?' · <span class="state update">'+esc(T.updates)+'</span>':''); const tail=other?'':'<button class="icon action" data-index="'+items.indexOf(x)+'" title="'+esc(T.actions)+'">•••</button>'; const at=other?' data-other="'+i+'"':' data-index="'+items.indexOf(x)+'"'; return '<div class="item"'+at+' role="button" tabindex="0" aria-expanded="'+(selected===keyOf(x))+'"><div class="glyph" data-kind="'+x.kind+'">'+icons[x.kind]+'</div><div><div class="name">'+esc(x.name)+'</div><div class="meta">'+meta+'</div></div>'+tail+'</div>'+(selected===keyOf(x)?detailHtml(x):''); }).join('')+'</div>'; }
  function bindRows(nodes, pick) { nodes.forEach(node=>{ const open=()=>toggleDetail(pick(node)); node.onclick=open; node.onkeydown=e=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); open(); } }; }); }
  const shortName = p => String(p).split(/[\\\\/]/).filter(Boolean).pop() || String(p);
  function renderOthers() { const box=document.querySelector('#others'); if(scope!=='user'||!projects.length||onlyUpdates) { box.innerHTML=''; box.dataset.list=''; return; }
    const listKey=projects.join('|');
    if(box.dataset.list!==listKey) { box.innerHTML='<div class="section">'+esc(T.otherProjects)+'</div><select id="other-project" aria-label="'+esc(T.otherProjects)+'"><option value="">'+esc(T.chooseProject)+'</option>'+projects.map(p=>'<option value="'+esc(p)+'">'+esc(shortName(p))+'</option>').join('')+'</select><p id="other-path"></p><div id="other-body"></div>'; box.dataset.list=listKey;
      document.querySelector('#other-project').onchange=e=>{ otherPath=e.target.value; otherItems=[]; otherError=''; otherIssues=[]; otherLoading=otherPath!==''; renderOthers(); if(otherPath) vscode.postMessage({type:'selectProject',path:otherPath}); }; }
    document.querySelector('#other-project').value=otherPath;
    document.querySelector('#other-path').textContent=otherPath;
    const rows=otherItems.filter(x=>x.agents.includes(agent));
    const body=document.querySelector('#other-body');
    const warnHtml=otherError?'<div class="empty">'+esc(otherError)+'</div>':otherIssues.length?'<div class="empty">'+esc(T.loadFailed)+'<br>'+otherIssues.map(esc).join('<br>')+'</div>':'';
    body.innerHTML=!otherPath?'':otherLoading?'<div class="loading"><span class="spinner"></span>'+esc(T.readingProject)+'</div>':warnHtml+(rows.length?rowsHtml(rows,true):(warnHtml?'':'<div class="empty">'+esc(T.projectEmpty)+'</div>'));
    bindRows(body.querySelectorAll('.item[data-other]'), node=>rows[Number(node.dataset.other)]); }
  function render() { const agents=Object.keys(agentNames).filter(a=>items.some(x=>x.agents.includes(a))); if(!agents.includes(agent)) agent=agents[0]??''; const managed=items.filter(x=>x.origin!=='bundled').length, updates=items.filter(x=>x.hasUpdate).length; if(updates===0) onlyUpdates=false;
    const visible=onlyUpdates?items.filter(x=>x.hasUpdate):items.filter(x=>x.agents.includes(agent)&&x.scope===scope);
    document.querySelector('#overview').innerHTML='<div class="metric"><strong>'+(loaded?managed:'-')+'</strong><span>'+esc(T.yourTools)+'</span></div><div class="metric'+(updates?' clickable':'')+(onlyUpdates?' active':'')+'"'+(updates?' id="updates-metric" role="button" tabindex="0" aria-pressed="'+onlyUpdates+'" title="'+esc(T.showUpdates)+'"':'')+'><strong>'+(loaded?updates:'-')+'</strong><span>'+esc(T.updates)+'</span></div>'+banner();
    const metric=document.querySelector('#updates-metric'); if(metric) { const toggle=()=>{ onlyUpdates=!onlyUpdates; hideDetail(); render(); }; metric.onclick=toggle; metric.onkeydown=e=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); toggle(); } }; }
    renderBanner();
    document.querySelector('#environment').innerHTML=environment.length?'<button class="section-toggle fold-toggle" data-fold="environment" aria-expanded="'+!!sectionExpanded.environment+'">'+(sectionExpanded.environment?'⌄':'›')+' '+esc(T.environment)+'</button>'+(sectionExpanded.environment?'<div class="detail">'+environment.map(info=>{ const c=compatibility.find(x=>x.id===info.id)||{supported:[],installed:[]}; const state=info.path?T.cliDetected:info.found||info.configOnly?T.configurationFound:T.notInstalled; const list=xs=>xs.length?xs.map(x=>kinds[x]).join(', '):T.none; return '<p>'+(info.path?'●':'○')+' <strong>'+esc(info.displayName)+'</strong> · '+esc(state)+(info.version?' · '+esc(info.version):'')+'<br><span class="meta">'+esc(T.supportedFormats.replace('{0}',list(c.supported)))+'<br>'+esc(T.installedFormats.replace('{0}',list(c.installed)))+'</span>'+(info.path?'<br><span class="detail-path">'+esc(info.path)+'</span>':'')+'</p>'; }).join('')+'</div>':''):'';
    document.querySelector('#diagnostics').innerHTML=diagnostics.length?'<button class="section-toggle fold-toggle" data-fold="diagnostics" aria-expanded="'+!!sectionExpanded.diagnostics+'">'+(sectionExpanded.diagnostics?'⌄':'›')+' '+esc(T.diagnostics)+'</button>'+(sectionExpanded.diagnostics?'<div class="detail">'+diagnostics.map(d=>'<p>'+(d.severity==='broken'?'✗':'⚠')+' '+esc(diagnosticText(d))+(d.targets.map(t=>t.sourcePath).filter(Boolean).length?'<br><span class="detail-path">'+d.targets.map(t=>esc(t.sourcePath)).filter(Boolean).join('<br>')+'</span>':'')+'</p>').join('')+'</div>':''):'';
    document.querySelector('#agents').innerHTML=agents.length?agents.map(a=>'<button class="agent '+(a===agent?'active':'')+'" data-agent="'+a+'" role="tab" aria-selected="'+(a===agent)+'"><span class="agent-dot"></span><span>'+agentNames[a]+'</span><span class="agent-count">'+items.filter(x=>x.agents.includes(a)).length+'</span></button>').join(''):(loaded?'<p class="empty">'+esc(T.noAgents)+'</p>':''); const _cnt=items.filter(x=>x.agents.includes(agent)).length;const _ab=document.querySelector('#agent-badge');if(_ab)_ab.innerHTML=agent?'<span class="badge-pip" data-agent="'+agent+'"></span><span class="badge-name">'+agentNames[agent]+'</span><span class="badge-count">'+_cnt+' tool'+(_cnt===1?'':'s')+'</span>':'';
    const filters=[['user',T.userGlobal],['project',projectName]]; document.querySelector('#filters').innerHTML=filters.map(([v,n])=>'<button class="filter '+(v===scope?'active':'')+'" data-filter="'+v+'">'+esc(n)+'</button>').join('');
    const yours=visible.filter(x=>x.origin!=='bundled'); const yourGroups=Object.entries(kinds).map(([value,title])=>[title,yours.filter(x=>x.kind===value),value]).filter(([,rows])=>rows.length); const bundled=visible.filter(x=>x.origin==='bundled'); document.querySelector('#content').innerHTML=!loaded?'<div class="loading"><span class="spinner"></span>'+esc(T.loading)+'</div>':visible.length?yourGroups.map(([title,rows,kv])=>{const exp=sectionExpanded[kv]; const shown=exp?rows:rows.slice(0,5); const rest=rows.length-shown.length; const tog=rows.length>5?'<button class="section-toggle" data-kind="'+kv+'">'+(exp?'⏄ '+esc(T.showLess):'› '+rest+' more')+'</button>':''; return '<div class="section">'+title+'</div>'+rowsHtml(shown)+tog;}).join('')+(bundled.length?(()=>{const exp=sectionExpanded['bundled']; const shown=exp?bundled:[]; const rest=bundled.length; const tog='<button class="section-toggle" data-kind="bundled">'+(exp?'⏄ '+esc(T.showLess):'› '+rest+' more')+'</button>'; return '<div class="section">'+esc(T.bundled)+'</div>'+rowsHtml(shown)+tog;})():''):'<div class="empty">'+esc(T.noMatch)+'</div>';
    document.querySelectorAll('[data-agent]').forEach(b=>b.onclick=()=>{agent=b.dataset.agent; onlyUpdates=false; hideDetail(); render();}); document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{scope=b.dataset.filter; onlyUpdates=false; hideDetail(); render();}); bindRows(document.querySelectorAll('#content .item[data-index]'), node=>items[Number(node.dataset.index)]); document.querySelectorAll('.action').forEach(b=>b.onclick=e=>{e.stopPropagation(); vscode.postMessage({type:'actions',item:items[Number(b.dataset.index)]});}); document.querySelectorAll('.section-toggle').forEach(b=>b.onclick=()=>{const key=b.dataset.fold||b.dataset.kind; sectionExpanded[key]=!sectionExpanded[key]; render();}); renderOthers(); }
  function renderBanner() { const box=document.querySelector('#banner');
    const noCli=environment.length>0&&environment.every(x=>!x.found);
    const text=readOnly==='untrusted'?T.untrusted:readOnly==='remote'?T.remote:noCli?T.noCli:'';
    box.innerHTML=text?'<span>⚠</span><span>'+esc(text)+'</span>':'';
    box.classList.toggle('hidden', text===''); }
  function banner() { const lines=(loadError?[loadError]:[]).concat(issues); return lines.length?'<div class="metric issues"><strong>⚠</strong><span>'+esc(T.loadFailed)+'<br>'+lines.map(esc).join('<br>')+'</span></div>':''; }
  function diagnosticText(d) { const name=d.targets&&d.targets[0]?d.targets[0].name:''; const key={BROKEN_LINK:'brokenLink',MISSING_SKILL_FILE:'missingSkillFile',DUPLICATE_IDENTITY:'duplicateIdentity',DUPLICATE_MCP_NAME:'duplicateMcpName',MISSING_EXECUTABLE:'missingExecutable'}[d.code]; return (T[key]||d.message||'').replace('{0}',name); }
  const keyOf = x => x.name+'|'+x.kind+'|'+x.scope+'|'+(x.sourcePath||'');
  function hideDetail() { selected=''; }
  function toggleDetail(x) { selected = selected===keyOf(x) ? '' : keyOf(x); render(); }
  function detailHtml(x) { const usage=esc({skill:T.useSkill,subagent:T.useSubagent,rule:T.useRule,mcp:T.useMcp,plugin:T.usePlugin}[x.kind]||''); return '<div class="detail"><div class="detail-label">'+esc(T.description)+'</div><p>'+esc(x.summary||T.noDescription)+'</p><div class="detail-label">'+esc(T.howToUse)+'</div><p>'+usage+'</p>'+(x.sourcePath?'<div class="detail-label">'+esc(T.location)+'</div><p class="detail-path">'+esc(x.sourcePath)+'</p>':'')+(x.repoUrl?'<div class="detail-label">'+esc(T.source)+'</div><p class="detail-path">'+esc(x.repoUrl)+'</p>':'')+(x.floating?'<p class="state update">'+esc(T.floatingWhy.replace('{0}',x.floating))+'</p>':'')+'</div>'; }
  const element = (tag, className, text) => { const node=document.createElement(tag); if(className) node.className=className; if(text!==undefined) node.textContent=String(text); return node; };
  function showClipboard(url) {
    const box=document.querySelector('#clip'); box.replaceChildren();
    const close=element('button','icon','×'); close.id='clip-close'; close.title=T.close; box.append(close);
    box.append(element('h2','',T.clipboard), element('p','detail-path',url));
    const use=element('button','',T.analyzeIt); use.id='clip-use'; box.append(use); box.classList.remove('hidden');
    close.onclick=()=>box.classList.add('hidden');
    use.onclick=()=>{ box.classList.add('hidden'); document.querySelector('#tool-url').value=url; vscode.postMessage({type:'analyzeTool',url}); };
  }
  function hidePreview() { lastPreview=null; document.querySelector('#preview').classList.add('hidden'); }
  function showPreview(result) {
    lastPreview=result; const panel=document.querySelector('#preview'); const rows=result.candidates||[]; panel.replaceChildren();
    const close=element('button','icon','×'); close.id='close-preview'; close.title=T.close; close.onclick=hidePreview; panel.append(close);
    if(result.loading) {
      const loading=element('div','loading'); loading.append(element('span','spinner'), document.createTextNode(T.analyzing)); panel.append(loading);
    } else if(rows.length) {
      panel.append(element('h2','',T.detected));
      rows.forEach((x,i)=>{
        const row=element('p'); const strong=element('strong','',x.installSelector||x.name); row.append(strong, document.createTextNode(' · '+(kinds[x.kind]||x.kind)), document.createElement('br'), document.createTextNode(x.description||T.noDescription), document.createElement('br'));
        const install=element('button','install',T.install); install.dataset.index=String(i); install.onclick=()=>{ install.disabled=true; install.textContent=T.installing; const candidate=rows[i]; vscode.postMessage({type:'installTool',url:result.url,kind:candidate.kind,name:candidate.name,selector:candidate.installSelector}); }; row.append(install); panel.append(row);
      });
    } else {
      panel.append(element('h2','',T.notFound), element('p','',result.error||T.notFoundBody));
    }
    panel.classList.remove('hidden');
  }
  document.querySelector('#refresh').onclick=()=>vscode.postMessage({type:'refresh'}); document.querySelector('#check-updates').onclick=()=>vscode.postMessage({type:'checkUpdates'}); document.querySelector('#add-form').onsubmit=e=>{e.preventDefault(); vscode.postMessage({type:'analyzeTool',url:document.querySelector('#tool-url').value});}; window.addEventListener('message',e=>{if(e.data.type==='inventory'){loaded=true; items=e.data.items; issues=e.data.issues||[]; diagnostics=e.data.diagnostics||[]; loadError=e.data.error||''; if(e.data.projectName) projectName=e.data.projectName; projects=e.data.projects||[]; environment=e.data.environment||environment; compatibility=e.data.compatibility||compatibility; readOnly=e.data.readOnly||''; if(otherPath&&!projects.includes(otherPath)){otherPath=''; otherItems=[]; otherError=''; otherIssues=[];} render();}
 if(e.data.type==='projectInventory'&&e.data.path===otherPath){otherLoading=false; otherItems=e.data.items||[]; otherIssues=e.data.issues||[]; otherError=e.data.error||''; renderOthers();} if(e.data.type==='clipboard') showClipboard(e.data.url); if(e.data.type==='installDone'){ if(e.data.ok) hidePreview(); else if(lastPreview) showPreview(lastPreview); } if(e.data.type==='analysisStart') showPreview(e.data); if(e.data.type==='preview') showPreview(e.data);}); render();
  </script></body></html>`;
}
