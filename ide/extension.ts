import * as vscode from "vscode";
import * as agentTool from "./agentTool";
import { AgentId, KindId } from "../core/agent";
import { AgentToolError } from "../core/errors";
import { mcpServers } from "./pasteInput";
import { DashboardItem, DashboardProvider } from "./dashboard";

type ToolNode = { tool: DashboardItem; scope: DashboardItem["scope"]; agent?: string };

/** 開いているワークスペース。project スコープの実体の置き場はここで決まる。 */
const workspacePath = (): string | undefined =>
  vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

const selectorOf = (node: ToolNode): agentTool.Selector => ({
  name: node.tool.name, kind: node.tool.kind as KindId, scope: node.scope,
  agent: node.agent as AgentId, sourcePath: node.tool.sourcePath,
  projectPath: node.scope === "project" ? workspacePath() : undefined,
});

/** 追加先の選択。ワークスペースが無ければ選ばせずに user へ入れる。 */
async function pickScope(): Promise<{ scope: "user" | "project"; projectPath?: string } | undefined> {
  const folder = workspacePath();
  if (folder === undefined) return { scope: "user" };
  const picked = await vscode.window.showQuickPick([
    { label: vscode.l10n.t("User Global"), description: vscode.l10n.t("Available in every project"),
      value: "user" as const },
    { label: vscode.l10n.t("Current Project"), description: folder, value: "project" as const },
  ], { placeHolder: vscode.l10n.t("Where should it be installed?") });
  if (picked === undefined) return undefined;
  return picked.value === "project" ? { scope: "project", projectPath: folder } : { scope: "user" };
}

/**
 * 失敗の理由を利用者の言葉にする。生のメッセージにはパスやコマンドが入っていて
 * 直すのに要るので捨てない。前に 1 行の意味を足すだけにする（UI 設計 8.3）。
 */
const HINTS: Partial<Record<string, () => string>> = {
  WRITE_GUARD_DENIED: () => vscode.l10n.t("The target is protected."),
  INVALID_NAME: () => vscode.l10n.t("The name from the source cannot be used as a path."),
  NOT_IN_REGISTRY: () => vscode.l10n.t("Another tool manages this item."),
  SYMLINK_OUTSIDE_STORE: () => vscode.l10n.t("This link was not created by Agent Tool."),
  LOCK_TIMEOUT: () => vscode.l10n.t("Another window is writing; try again."),
};

const message = (error: unknown): string => {
  if (error instanceof AgentToolError) {
    const hint = HINTS[error.code]?.();
    return hint === undefined ? error.message : `${hint} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
};

export function activate(context: vscode.ExtensionContext): void {
  const storagePath = context.globalStorageUri.fsPath;
  const dashboard = new DashboardProvider(storagePath);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agent-tool.inventory", dashboard), dashboard);

  /** 書き込みの共通ガード。未信頼・Remote では操作しない。 */
  async function canWrite(): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(vscode.l10n.t("Agent Tool: trust this workspace before changing tools."));
      return false;
    }
    if (vscode.env.remoteName) {
      void vscode.window.showWarningMessage(vscode.l10n.t("Agent Tool: tool changes are available only in the local window."));
      return false;
    }
    return true;
  }

  /**
   * 成否は戻り値の有無ではなく `ok` で表す。`void` を返す操作（削除・追加）は
   * 成功しても `undefined` になるので、有無で判定すると一覧の再読み込みが走らない。
   */
  type Outcome<T> = { ok: true; value: T } | { ok: false };

  async function withProgress<T>(title: string, body: () => Promise<T>): Promise<Outcome<T>> {
    try {
      return {
        ok: true,
        value: await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title }, body),
      };
    } catch (error) {
      void vscode.window.showWarningMessage(`Agent Tool: ${message(error)}`);
      return { ok: false };
    }
  }

  const command = (name: string, body: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(name, body));
  };

  command("agent-tool.addSkill", async (providedUrl?: string) => {
    if (!await canWrite()) return;
    const url = providedUrl ?? await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Public GitHub Skill URL"),
      placeHolder: "https://github.com/owner/repository",
      ignoreFocusOut: true,
    });
    if (!url) return;
    const target = await pickScope();
    if (target === undefined) return;
    const result = await withProgress(vscode.l10n.t("Agent Tool: Adding Skill"),
      () => agentTool.add({ storagePath, url, kind: "skill", ...target }));
    if (result.ok) void dashboard.refresh(true);
  });

  command("agent-tool.addMcp", async () => {
    if (!await canWrite()) return;
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("MCP server name"), ignoreFocusOut: true,
    });
    if (!name) return;
    const definition = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("MCP server JSON, HTTP URL, or launch command"),
      placeHolder: "{\"command\":\"npx\",\"args\":[\"-y\",\"server\"]}",
      ignoreFocusOut: true,
    });
    if (!definition) return;
    const result = await withProgress(vscode.l10n.t("Agent Tool: Adding MCP server"), async () => {
      for (const server of mcpServers(definition, name)) {
        await agentTool.mcpAdd({ storagePath, agent: "cursor", server });
      }
    });
    if (result.ok) void dashboard.refresh(true);
  });

  // 成否を返す。Webview の「導入しています…」は、この結果でしか元に戻せない。
  command("agent-tool.installPreview", async (input: {
    url?: string; kind?: string; name?: string; selector?: string;
  }): Promise<boolean> => {
    if (!input?.url || !input.kind || !input.name || !await canWrite()) return false;
    let agent: AgentId | undefined;
    if (input.kind === "plugin") {
      const pluginAgents = { "Claude Code": "claude", Codex: "codex" } as const;
      const picked = await vscode.window.showQuickPick(Object.keys(pluginAgents),
        { placeHolder: vscode.l10n.t("Choose an AI agent") });
      if (!picked) return false;
      agent = pluginAgents[picked as keyof typeof pluginAgents];
      const commands = agentTool.pluginAddCommands(agent, input.selector ?? input.name, input.url);
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("Install {0}?", input.selector ?? input.name),
        { modal: true, detail: commands.map(argv => argv.join(" ")).join("\n") }, vscode.l10n.t("Install"));
      if (choice !== vscode.l10n.t("Install")) return false;
    }
    // Plugin の置き場はエージェントの CLI が決める。選ばせられるのは Skill / Subagent だけ。
    const target = input.kind === "plugin" ? { scope: "user" as const } : await pickScope();
    if (target === undefined) return false;
    const result = await withProgress(vscode.l10n.t("Agent Tool: Installing Tool"), () =>
      input.kind === "plugin"
        ? agentTool.pluginAdd({ storagePath, agent: agent!, name: input.selector ?? input.name!, url: input.url })
        : agentTool.add({
          storagePath, url: input.url!, ...target,
          kind: input.kind as "skill" | "subagent" | "plugin", name: input.name,
        }));
    if (result.ok) void dashboard.refresh(true);
    return result.ok;
  });

  command("agent-tool.removeTool", async (node: ToolNode) => {
    if (!node?.tool || !node.agent || !await canWrite()) return;
    // ゴミ箱には送らないので、取り消せないことを明示して確認を取る（設計決定 D-5）。
    const pluginCommand = node.tool.kind === "plugin"
      && (node.agent === "claude" || node.agent === "codex")
      ? agentTool.pluginRemoveCommand(node.agent, node.tool.name, node.tool.pluginScope ?? "user").join(" ")
      : undefined;
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Remove {0}? This cannot be undone.", node.tool.name),
      { modal: true, detail: pluginCommand ?? node.tool.sourcePath }, vscode.l10n.t("Remove"));
    if (!choice) return;

    const selector = selectorOf(node);
    // 種別ごとに宛先が違う。Skill / Subagent だけがこちらの管理ストアの実体で、
    // MCP は設定ファイルか CLI、Plugin はエージェントの CLI が持っている。
    const result = await withProgress(vscode.l10n.t("Agent Tool: Removing tool"), () => {
      switch (node.tool.kind) {
        case "mcp":
          // `mcpScope` は一覧が読んだ登録先そのもの。`scope` に潰すと
          // プロジェクトのサーバーを消したつもりで user のサーバーが消える。
          return agentTool.mcpRemove({
            storagePath, agent: selector.agent, name: selector.name,
            scope: node.tool.mcpScope ?? "user",
          });
        case "plugin":
          return agentTool.pluginRemove({
            storagePath, agent: selector.agent, name: selector.name,
            scope: node.tool.pluginScope ?? "user",
            bundled: node.tool.origin === "bundled",
          });
        default:
          return agentTool.remove({ storagePath, selector });
      }
    });
    if (result.ok) void dashboard.refresh(true);
  });

  command("agent-tool.previewUpdate", async (node: ToolNode) => {
    if (!node?.tool || !node.agent || !await canWrite()) return;
    const selector = selectorOf(node);
    const previewed = await withProgress(vscode.l10n.t("Agent Tool: Preparing diff"),
      () => agentTool.updatePreview({ storagePath, selector }));
    if (!previewed.ok) return;
    const diff = previewed.value;
    if (diff.files.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Agent Tool: {0} is up to date.", node.tool.name));
      return;
    }
    const summary = [
      vscode.l10n.t("Update preview: {0} added, {1} removed, {2} changed.",
        diff.summary.added, diff.summary.removed, diff.summary.changed),
      ...(diff.summary.manifestChanged ? [vscode.l10n.t("Manifest/configuration changed.")] : []),
      ...(diff.summary.omitted ? [vscode.l10n.t("Some changes are not shown.")] : []),
    ].join(" ");
    void vscode.window.showInformationMessage(summary);
    // 本文は Diff Editor に渡すあいだだけ持ち、Editor を閉じたら破棄する。
    const first = diff.files[0];
    const before = await vscode.workspace.openTextDocument({ content: first.before });
    const after = await vscode.workspace.openTextDocument({ content: first.after });
    await vscode.commands.executeCommand("vscode.diff", before.uri, after.uri,
      `${node.tool.name}: ${diff.currentSha?.slice(0, 7) ?? "-"} → ${diff.latestSha.slice(0, 7)}`);
  });

  command("agent-tool.applyUpdate", async (node: ToolNode) => {
    if (!node?.tool || !node.agent || !await canWrite()) return;
    // 実体を置き換える操作で、元には戻せない（設計決定 D-5）。
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Apply the update to {0}? The current version is replaced.", node.tool.name),
      { modal: true, detail: node.tool.sourcePath }, vscode.l10n.t("Apply"));
    if (!choice) return;
    const selector = selectorOf(node);
    const result = await withProgress(vscode.l10n.t("Agent Tool: Applying update"),
      () => agentTool.updateApply({ storagePath, selector }));
    if (result.ok) void dashboard.refresh(true);
  });

  command("agent-tool.copySkill", async (node: ToolNode) => {
    if (!node?.tool || !node.agent || !await canWrite()) return;
    const target = await pickScope();
    if (target === undefined) return;
    const selector = selectorOf(node);
    const previewed = await withProgress(vscode.l10n.t("Agent Tool: Preparing copy"), async () =>
      agentTool.migrationPreview({ storagePath, selector, ...target }));
    if (!previewed.ok) return;
    const preview = previewed.value;
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Copy {0}? Existing files will not be overwritten.", preview.name),
      { modal: true, detail: `${preview.sourcePath}\n→ ${preview.destinationPath}` }, vscode.l10n.t("Copy"));
    if (!choice) return;
    const result = await withProgress(vscode.l10n.t("Agent Tool: Copying Skill"), () =>
      agentTool.migrate({ storagePath, selector, ...target }));
    if (result.ok) void dashboard.refresh(true);
  });

  command("agent-tool.addSkillToAnotherAgent", async (node: ToolNode) => {
    if (!node?.tool?.sourceUrl || !await canWrite()) return;
    await vscode.env.openExternal(vscode.Uri.parse(node.tool.sourceUrl));
  });

  command("agent-tool.togglePin", async (node: ToolNode) => {
    if (!node?.tool || !node.agent || !await canWrite()) return;
    const result = await withProgress(vscode.l10n.t("Agent Tool: Updating tool"),
      () => agentTool.togglePin({ storagePath, selector: selectorOf(node) }));
    if (result.ok) void dashboard.refresh(true);
  });

  command("agent-tool.refreshInventory", () => void dashboard.refresh(true));

  command("agent-tool.inventory.focus", () =>
    vscode.commands.executeCommand("workbench.view.extension.agent-tool"));

  command("agent-tool.checkUpdates", async () => {
    if (!await canWrite()) return;
    const result = await withProgress(vscode.l10n.t("Agent Tool: Checking for updates"),
      () => agentTool.checkUpdates({ storagePath }));
    if (!result.ok) return;
    // 通知は 1 つにまとめる。取得元ごとに出すと画面が埋まる。
    if (result.value.issues.length > 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Agent Tool: some sources could not be checked."),
        { modal: false, detail: result.value.issues.join("\n") });
    }
    void dashboard.refresh(true);
  });

  command("agent-tool.openToolActions", async (item: DashboardItem) => {
    if (!await canWrite()) return;
    const agent = item.agents.length === 0 || item.agents.length === 1
      ? item.agents[0] ?? "claude"
      : await vscode.window.showQuickPick(item.agents, { placeHolder: vscode.l10n.t("Choose an agent") });
    if (!agent) return;
    const node: ToolNode = { tool: item, scope: item.scope, agent };
    // 実体を管理できない対象には更新を出さない。
    // 削除だけは宛先が別にある — MCP は設定ファイルか CLI、Plugin はエージェントの CLI。
    // 同梱物は消してもエージェントの更新で戻るので、そもそも出さない。
    const manageable = agentTool.isManageable(selectorOf(node));
    const removable = manageable
      || (item.origin !== "bundled"
        && (item.kind === "mcp"
          || (item.kind === "plugin" && (agent === "claude" || agent === "codex"))));
    const actions = [
      ...(manageable && item.hasUpdate
        ? [{ label: vscode.l10n.t("Preview update"), value: "agent-tool.previewUpdate" },
           { label: vscode.l10n.t("Apply update"), value: "agent-tool.applyUpdate" }] : []),
      ...(manageable && item.origin === "managed"
        ? [{ label: item.pinned ? vscode.l10n.t("Unpin (follow updates again)")
               : vscode.l10n.t("Pin (stop following updates)"),
            value: "agent-tool.togglePin" }] : []),
      ...(manageable && item.enabled && item.kind === "skill" && item.origin === "managed"
        ? [{ label: vscode.l10n.t("Copy to another scope"), value: "agent-tool.copySkill" }] : []),
      ...(manageable && item.enabled && item.kind === "skill" && item.origin === "managed" && item.sourceUrl
        ? [{ label: vscode.l10n.t("Add to another AI agent"), value: "agent-tool.addSkillToAnotherAgent" }] : []),
      ...(removable ? [{ label: vscode.l10n.t("Remove"), value: "agent-tool.removeTool" }] : []),
    ];
    if (actions.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Agent Tool: {0} is managed outside Agent Tool.", item.name));
      return;
    }
    const choice = await vscode.window.showQuickPick(actions, { placeHolder: item.name });
    if (choice) await vscode.commands.executeCommand(choice.value, node);
  });

}

export function deactivate(): void {}
