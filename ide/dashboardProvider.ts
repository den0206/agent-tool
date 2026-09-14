import * as vscode from 'vscode';
import { basename, dirname } from 'node:path';
import * as agentTool from './agentTool';
import { dashboardHtml, type DashboardItem } from './dashboardView';

/** 書き込みを拒む理由。空文字なら書ける。表示と可否の判定を 1 か所にする。 */
const readOnlyReason = (): '' | 'untrusted' | 'remote' =>
  !vscode.workspace.isTrusted ? 'untrusted'
    : vscode.env.remoteName !== undefined ? 'remote' : '';

export class DashboardProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private snapshot?: {at: number; items: DashboardItem[]};
  private status = new Map<string, boolean>();
  private issues: string[] = [];
  private knownProjects: string[] = [];
  /** CLI の検出結果。ログインシェルを起こすので、手動更新のときだけ引き直す。 */
  private environment?: agentTool.AgentInfo[];
  /** 直前に提案した URL。再表示のたびに同じ提案を出さないためだけに持つ。 */
  private offered = '';
  private pollTimer?: NodeJS.Timeout;
  private statusPending = false;
  private watchers: vscode.FileSystemWatcher[] = [];
  private watchTimer?: NodeJS.Timeout;
  /** 更新件数のバッジ。0 件のときは出さない。 */
  private readonly badge = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);

  constructor(private readonly storagePath: string) {}
  dispose(): void {
    this.stopPoll();
    this.stopWatch();
    this.badge.dispose();
    this.view = undefined;
    this.snapshot = undefined;
    this.issues = [];
    this.knownProjects = [];
    this.environment = undefined;
    this.offered = '';
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {enableScripts: true};
    view.webview.html = dashboardHtml(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'refresh') void this.refresh(true);
      if (message?.type === 'checkUpdates')
        void vscode.commands.executeCommand('agent-tool.checkUpdates');
      if (message?.type === 'addSkill')
        void vscode.commands.executeCommand(
          'agent-tool.addSkill',
          typeof message.url === 'string' ? message.url : undefined,
        );
      if (message?.type === 'analyzeTool' && typeof message.url === 'string')
        void this.analyze(message.url);
      if (message?.type === 'installTool' && typeof message.url === 'string' && typeof message.kind === 'string')
        void this.install(message);
      if (message?.type === 'addMcp')
        void vscode.commands.executeCommand('agent-tool.addMcp');
      if (message?.type === 'actions' && isItem(message.item))
        void vscode.commands.executeCommand('agent-tool.openToolActions', message.item);
      if (message?.type === 'selectProject' && typeof message.path === 'string')
        void this.loadProject(message.path);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refresh();
        void this.offerClipboard();
        this.startPoll();
        this.startWatch();
      } else {
        this.stopPoll();
        this.stopWatch();
        this.snapshot = undefined;
        this.issues = [];
        this.knownProjects = [];
        this.environment = undefined;
      }
    });
    if (view.visible) {
      void this.refresh();
      void this.offerClipboard();
      this.startPoll();
      this.startWatch();
    }
  }

  async refresh(force = false): Promise<void> {
    if (!this.view?.visible) return;
    if (!force && this.snapshot && Date.now() - this.snapshot.at < 180_000) {
      this.post(this.snapshot.items, this.issues);
      return;
    }
    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      // 他プロジェクトの候補。既知パスを読むだけで、ホームは走査しない。
      this.knownProjects = agentTool
        .projects({storagePath: this.storagePath})
        .filter((path) => path !== folder);
      const {items, issues} = await agentTool.inventory({
        storagePath: this.storagePath,
        projectPath: folder,
        // 未信頼・Remote では台帳の取り込みも entry の除去も行わない。
        writable: readOnlyReason() === '',
      });
      // 待っている間に View が隠れたら、解放したはずの状態を書き戻さない。
      if (!this.view?.visible) return;
      const found = items as DashboardItem[];
      this.snapshot = {at: Date.now(), items: found};
      // 走査に失敗したエージェントは黙って 0 件にしない。「未検出」と
      // 「読めなかった」が同じ見た目になると、消してよいものが判断できない。
      this.post(found, issues);
      // CLI の検出はログインシェルを起こすので一覧より遅い。待たせると初期表示が
      // 止まって見えるため、一覧を出してから引き直して差分だけ送り直す。
      if (force || this.environment === undefined) {
        const environment = await agentTool
          .scanPath({storagePath: this.storagePath})
          .catch(() => []);
        if (!this.view?.visible) return;
        this.environment = environment;
        this.post(found, issues);
      }
    } catch (error) {
      this.post([], [], error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 他プロジェクトの一覧。Webview から来たパスは信頼せず、`~/.claude.json` の
   * 既知プロジェクトに載っているものだけを走査する。結果は保持しない。
   */
  private async loadProject(path: string): Promise<void> {
    if (!this.knownProjects.includes(path)) return;
    try {
      const {items, issues} = await agentTool.inventory({
        storagePath: this.storagePath,
        projectPath: path,
        user: false,
      });
      this.view?.webview.postMessage({
        type: 'projectInventory', path, issues,
        items: items.filter((item) =>
          item.scope === 'project' && (item.kind !== 'plugin' || item.sourcePath === path)),
      });
    } catch (error) {
      this.view?.webview.postMessage({
        type: 'projectInventory', path, items: [], issues: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 導入の結果を返す。返さないと Webview のボタンが「導入しています…」で止まる。 */
  private async install(message: unknown): Promise<void> {
    const ok = await vscode.commands.executeCommand('agent-tool.installPreview', message);
    this.view?.webview.postMessage({type: 'installDone', ok: ok === true});
  }

  /** クリップボードに解析できる URL があれば 1 回だけ提案する。読むだけで何も実行しない。 */
  private async offerClipboard(): Promise<void> {
    let text = '';
    try {
      text = (await vscode.env.clipboard.readText()).trim();
    } catch {
      return;
    }
    if (text === '' || text.length > 2048 || text === this.offered) return;
    if (!agentTool.isSupportedUrl(text)) return;
    this.offered = text;
    this.view?.webview.postMessage({type: 'clipboard', url: text});
  }

  private async analyze(url: string): Promise<void> {
    this.view?.webview.postMessage({type: 'analysisStart', loading: true});
    try {
      const result = await agentTool.preview({url});
      this.view?.webview.postMessage({type: 'preview', ...result});
    } catch (error) {
      this.view?.webview.postMessage({type: 'preview', url, candidates: [],
        error: error instanceof Error ? error.message : vscode.l10n.t('The URL could not be analyzed.')});
    }
  }

  private startWatch(): void {
    this.stopWatch();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    for (const path of agentTool.watchPaths({storagePath: this.storagePath, projectPath: folder})) {
      const file = path.endsWith('.json');
      const uri = vscode.Uri.file(file ? dirname(path) : path);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(uri, file ? basename(path) : '**'));
      const touched = (): void => this.scheduleRefresh();
      watcher.onDidCreate(touched);
      watcher.onDidChange(touched);
      watcher.onDidDelete(touched);
      this.watchers.push(watcher);
    }
  }

  private stopWatch(): void {
    if (this.watchTimer) { clearTimeout(this.watchTimer); this.watchTimer = undefined; }
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  private scheduleRefresh(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.refresh(true);
    }, 400);
  }

  private startPoll(): void {
    this.stopPoll();
    void this.refreshStatus();
    this.pollTimer = setInterval(() => void this.refreshStatus(), 3_000);
  }

  private stopPoll(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.status.clear();
  }

  async refreshStatus(): Promise<void> {
    if (this.statusPending || !this.view?.visible) return;
    this.statusPending = true;
    try {
      const status = await agentTool.mcpStatus({storagePath: this.storagePath});
      if (!this.view?.visible) return;
      this.status = new Map(Object.entries(status));
      if (this.snapshot) this.post(this.snapshot.items, this.issues);
    } catch { /* keep previous status */ } finally {
      this.statusPending = false;
    }
  }

  private post(items: DashboardItem[], issues: string[] = [], error?: string): void {
    this.issues = issues;
    const annotated = items.map(item =>
      item.kind === 'mcp'
        ? {...item, running: item.agents.some(a => this.status.get(`${a}:${item.name}`) === true)}
        : item
    );
    const updates = annotated.filter(item => item.hasUpdate).length;
    this.badge.text = `$(arrow-up) ${updates}`;
    this.badge.tooltip = vscode.l10n.t("Agent Tool: {0} updates available", String(updates));
    this.badge.command = 'agent-tool.inventory.focus';
    if (updates > 0) this.badge.show(); else this.badge.hide();

    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const projectName = folder === undefined
      ? 'Current Project'
      : folder.split(/[\\/]/).filter(Boolean).pop() ?? 'Current Project';
    this.view?.webview.postMessage({
      type: 'inventory', items: annotated, projectName, issues, error,
      projects: this.knownProjects, environment: this.environment ?? [],
      readOnly: readOnlyReason(),
    });
  }
}

function isItem(value: unknown): value is DashboardItem {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as DashboardItem).name === 'string' &&
    Array.isArray((value as DashboardItem).agents)
  );
}
