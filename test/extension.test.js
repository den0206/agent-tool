// VS Code API をスタブして拡張の入口を検証する。Cursor を起動しないので全 OS で走る。
const { strict: assert } = require("node:assert");
const Module = require("node:module");
const { test } = require("node:test");
const { fakeEnv } = require("./helpers.js");

/** `require("vscode")` だけを差し替える。差し替えは 1 回の読み込みごとに戻す。 */
function loadExtension(stub, tool) {
  const load = Module._load;
  Module._load = (request, ...rest) => request === "vscode" ? stub
    : request === "./agentTool" && tool !== undefined ? tool : load(request, ...rest);
  try {
    delete require.cache[require.resolve("../out/ide/extension.js")];
    delete require.cache[require.resolve("../out/ide/dashboard.js")];
    delete require.cache[require.resolve("../out/ide/dashboardProvider.js")];
    delete require.cache[require.resolve("../out/ide/dashboardView.js")];
    return require("../out/ide/extension.js");
  } finally {
    Module._load = load;
  }
}

function stubVscode(overrides = {}) {
  const state = {
    warnings: [], warningDetails: [], commands: new Map(), disposed: 0,
    provider: undefined, posted: [], picks: [], watchers: 0, badge: {shown: false},
  };
  const stub = {
    l10n: { t: (text, ...args) => args.reduce((acc, value, i) => acc.replace(`{${i}}`, value), text) },
    Uri: { joinPath: () => ({ fsPath: "" }), file: fsPath => ({ fsPath }), parse: value => ({ value }) },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Right: 2 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    env: { remoteName: undefined, clipboard: { readText: async () => "" }, openExternal: uri => { state.externalUri = uri; return Promise.resolve(true); } },
    workspace: {
      isTrusted: true, workspaceFolders: undefined,
      createFileSystemWatcher: () => {
        state.watchers += 1;
        return {
          onDidCreate() {}, onDidChange() {}, onDidDelete() {},
          dispose: () => { state.watchers -= 1; },
        };
      },
    },
    window: {
      registerWebviewViewProvider: (_id, provider) => {
        state.provider = provider;
        return { dispose: () => { state.disposed += 1; } };
      },
      // モーダルの確認は最後の引数（操作ラベル）を押したことにする。
      showWarningMessage: (text, options, ...actions) => {
        state.warnings.push(text);
        state.warningDetails.push(options?.detail);
        const confirmed = options !== null && typeof options === "object" && options.modal === true;
        return Promise.resolve(confirmed ? actions[actions.length - 1] : undefined);
      },
      showInformationMessage: () => Promise.resolve(undefined),
      showInputBox: () => Promise.resolve(undefined),
      showQuickPick: items => { state.picks.push(items); return Promise.resolve(undefined); },
      createStatusBarItem: () => ({
        text: "", tooltip: "", command: "",
        show: () => { state.badge.shown = true; },
        hide: () => { state.badge.shown = false; },
        dispose() {},
      }),
      withProgress: (_options, body) => body(),
    },
    commands: {
      registerCommand: (name, body) => { state.commands.set(name, body); return { dispose() {} }; },
      executeCommand: () => Promise.resolve(undefined),
    },
    ...overrides,
  };
  return { stub, state };
}

const activateWith = (stub, storagePath, tool) => {
  const extension = loadExtension(stub, tool);
  const context = {
    globalStorageUri: { fsPath: storagePath },
    extensionUri: { fsPath: "." },
    subscriptions: [],
    globalState: { get: () => undefined, update: async () => {} },
  };
  extension.activate(context);
  return { extension, context };
};

test("activate は CLI を起動せずに全コマンドを登録する", () => {
  const { stub, state } = stubVscode();
  activateWith(stub, fakeEnv().appSupport);
  for (const name of [
    "agent-tool.toggleTool", "agent-tool.addSkill", "agent-tool.addMcp", "agent-tool.removeTool",
    "agent-tool.previewUpdate", "agent-tool.applyUpdate", "agent-tool.refreshInventory",
    "agent-tool.openToolActions", "agent-tool.checkUpdates", "agent-tool.togglePin",
    "agent-tool.inventory.focus",
  ]) {
    assert.ok(state.commands.has(name), name);
  }
});

/** 未信頼ワークスペースでは一覧だけを許可する。 */
test("未信頼ワークスペースでは書き込みを拒否する", async () => {
  const { stub, state } = stubVscode({
    workspace: { isTrusted: false, workspaceFolders: undefined },
  });
  activateWith(stub, fakeEnv().appSupport);
  await state.commands.get("agent-tool.addSkill")();
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /trust this workspace/);
});

/** Remote 環境ではローカルの Agent 設定を書き換えない。 */
test("Remote 環境では書き込みを拒否する", async () => {
  const { stub, state } = stubVscode({ env: { remoteName: "ssh-remote", clipboard: { readText: async () => "" } } });
  activateWith(stub, fakeEnv().appSupport);
  await state.commands.get("agent-tool.removeTool")({
    tool: { name: "x", kind: "skill", scope: "user", agents: ["claude"] },
    scope: "user",
    agent: "claude",
  });
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /local window/);
});

test("未信頼・Remote 環境では更新プレビューも拒否する", async () => {
  for (const [overrides, expected] of [
    [{ workspace: { isTrusted: false, workspaceFolders: undefined } }, /trust this workspace/],
    [{ env: { remoteName: "ssh-remote", clipboard: { readText: async () => "" } } }, /local window/],
  ]) {
    const { stub, state } = stubVscode(overrides);
    let previews = 0;
    activateWith(stub, fakeEnv().appSupport, { previewUpdate: async () => { previews += 1; } });
    await state.commands.get("agent-tool.previewUpdate")({
      tool: { name: "x", kind: "skill", scope: "user", agents: ["claude"] },
      scope: "user", agent: "claude",
    });
    assert.equal(previews, 0);
    assert.match(state.warnings[0], expected);
  }
});

test("未信頼ワークスペースではツール操作を表示しない", async () => {
  const { stub, state } = stubVscode({ workspace: { isTrusted: false, workspaceFolders: undefined } });
  activateWith(stub, fakeEnv().appSupport);
  await state.commands.get("agent-tool.openToolActions")({
    name: "x", kind: "skill", scope: "user", agents: ["claude"], origin: "managed",
    enabled: true, hasUpdate: true,
  });
  assert.deepEqual(state.picks, []);
  assert.match(state.warnings[0], /trust this workspace/);
});

test("Dashboard からブラウザ拡張のストアページを開く", async () => {
  const { stub, state } = stubVscode();
  activateWith(stub, fakeEnv().appSupport);
  showView(state);
  state.onMessage({ type: "openBrowserExtension" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.externalUri.value, "https://chromewebstore.google.com/detail/agent-tool/allbohfeiidaiemnagikcghaialfafhp");
});

/**
 * Webview のスクリプトは tsc も node:test も構文を見ない。
 * 文言差し込みで壊れても気付けないので、ここで構文と文言表だけ確かめる。
 */
test("Webview の HTML は構文が通り、文言を l10n から引く", () => {
  const vm = require("node:vm");
  const { readFileSync } = require("node:fs");
  const bundle = JSON.parse(readFileSync(require.resolve("../l10n/bundle.l10n.json"), "utf8"));
  const { stub } = stubVscode({
    env: { remoteName: undefined, language: "en", clipboard: { readText: async () => "" } },
    l10n: { t: text => bundle[text] ?? text },
  });
  const { DashboardProvider } = loadExtension(stub) && require("../out/ide/dashboard.js");
  const provider = new DashboardProvider(fakeEnv().appSupport);
  let html = "";
  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: "vscode-resource:",
      set html(value) { html = value; },
      get html() { return html; },
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: () => Promise.resolve(true),
    },
    visible: false,
    onDidChangeVisibility: () => ({ dispose() {} }),
  });
  provider.dispose();

  const script = html.slice(html.lastIndexOf("<script"), html.lastIndexOf("</script>"));
  const body = script.slice(script.indexOf(">") + 1);
  new vm.Script(body);                                   // 構文エラーならここで落ちる
  assert.match(body, /const T = \{/);
  assert.equal(body.includes("</script"), false);        // 文言で閉じられていない
  assert.match(html, /No tools match this filter\./);    // 文言は l10n 由来
  assert.equal(/[\u3040-\u30ff]/.test(html), false);     // 既定言語に日本語が混ざらない
});

test("dispose でタイマーとキャッシュを手放す", () => {
  const { stub } = stubVscode();
  const { context } = activateWith(stub, fakeEnv().appSupport);
  for (const item of context.subscriptions) item.dispose?.();
  assert.ok(context.subscriptions.length > 0);
});

test("遅い MCP 状態確認を重ねて起動しない", async () => {
  const { stub } = stubVscode();
  let calls = 0;
  let finish;
  const { DashboardProvider } = loadExtension(stub, {
    mcpStatus: () => {
      calls += 1;
      return new Promise(resolve => { finish = resolve; });
    },
  }) && require("../out/ide/dashboard.js");
  const provider = new DashboardProvider(fakeEnv().appSupport);
  const view = {
    webview: { options: {}, cspSource: "vscode-resource:", html: "", onDidReceiveMessage: () => ({ dispose() {} }), postMessage: () => Promise.resolve(true) },
    visible: false, onDidChangeVisibility: () => ({ dispose() {} }),
  };
  provider.resolveWebviewView(view);
  view.visible = true;
  const first = provider.refreshStatus();
  const second = provider.refreshStatus();
  assert.equal(calls, 1);
  finish({});
  await Promise.all([first, second]);
  provider.dispose();
});

/** 表示中の Webview を用意して、一覧の再読み込みが届いたかを見る。 */
function showView(state) {
  const view = {
    webview: {
      options: {}, cspSource: "vscode-resource:", html: "",
      onDidReceiveMessage: handler => { state.onMessage = handler; return { dispose() {} }; },
      postMessage: message => { state.posted.push(message); return Promise.resolve(true); },
    },
    visible: true,
    onDidChangeVisibility: handler => { state.onVisibility = handler; return { dispose() {} }; },
  };
  state.provider.resolveWebviewView(view);
  return view;
}

/**
 * 削除や追加は `void` を返す。成否を戻り値の有無で判定すると、成功しても
 * `undefined` になって一覧が再読み込みされない（削除しても表が変わらない）。
 */
test("void を返す操作の成功後も一覧を読み直す", async () => {
  const { stub, state } = stubVscode();
  // 本体は走らせない。「成功して void を返した」状況だけを作る。
  stub.window.withProgress = () => Promise.resolve(undefined);
  const { context } = activateWith(stub, fakeEnv().appSupport, {
    inventory: async () => ({ items: [], issues: [] }), mcpStatus: async () => ({}),
    watchPaths: () => [], scanPath: async () => [], projects: () => [],
  });
  try {
    showView(state);
    const before = state.posted.filter(message => message.type === "inventory").length;
    await state.commands.get("agent-tool.removeTool")({
      tool: { name: "x", kind: "skill", scope: "user", agents: ["claude"], origin: "user" },
      scope: "user",
      agent: "claude",
    });
    await new Promise(resolve => setImmediate(resolve));
    const after = state.posted.filter(message => message.type === "inventory").length;
    assert.ok(after > before, `再読み込みが走っていない (${before} → ${after})`);
  } finally {
    for (const item of context.subscriptions) item.dispose?.();
  }
});

test("Plugin の追加前に Marketplace を含むコマンドを表示する", async () => {
  const { stub, state } = stubVscode();
  stub.window.showQuickPick = items => { state.picks.push(items); return Promise.resolve("Claude Code"); };
  stub.window.withProgress = () => Promise.resolve(undefined);
  activateWith(stub, fakeEnv().appSupport);
  await state.commands.get("agent-tool.installPreview")({
    url: "https://github.com/acme/plugins", kind: "plugin", name: "tool", selector: "tool@market",
  });
  assert.equal(state.warningDetails.at(-1),
    "claude plugin marketplace add https://github.com/acme/plugins\nclaude plugin install tool@market -s user");
});

/** Plugin の削除はエージェントの CLI へ委譲する。操作一覧から落とすと到達できない。 */
test("Plugin にも削除の操作を出す", async () => {
  const { stub, state } = stubVscode();
  activateWith(stub, fakeEnv().appSupport);
  await state.commands.get("agent-tool.openToolActions")({
    name: "github@openai-curated-remote", kind: "plugin", scope: "user",
    agents: ["codex"], origin: "user", enabled: true, hasUpdate: false,
  });
  const labels = (state.picks[0] ?? []).map(action => action.label);
  assert.deepEqual(labels, ["Remove"]);
  assert.equal(state.warnings.length, 0);
});

/** 消してもエージェントの更新で戻るものには操作を出さない。 */
test("同梱プラグインには削除を出さない", async () => {
  const { stub, state } = stubVscode();
  activateWith(stub, fakeEnv().appSupport);
  await state.commands.get("agent-tool.openToolActions")({
    name: "openai-templates@openai-curated-remote", kind: "plugin", scope: "user",
    agents: ["codex"], origin: "bundled", enabled: true, hasUpdate: false,
  });
  assert.deepEqual(state.picks, []);
});

/** Webview から届くパスは信頼境界の外。既知プロジェクト以外は走査しない。 */
test("他プロジェクトの一覧は既知パスだけを走査する", async () => {
  const { stub, state } = stubVscode();
  const scanned = [];
  const item = (name, scope) => ({
    name, kind: "skill", scope, agents: ["claude"], origin: "user", enabled: true, hasUpdate: false,
  });
  const plugin = (name, sourcePath) => ({
    name, kind: "plugin", scope: "project", agents: ["claude"], origin: "user",
    enabled: true, hasUpdate: false, sourcePath,
  });
  const { context } = activateWith(stub, fakeEnv().appSupport, {
    inventory: async ({ projectPath, user }) => {
      scanned.push(projectPath);
      assert.equal(user, false);
      return {
        items: [
          item("theirs", "project"), item("mine", "user"),
          plugin("ours@here", "/known/project"), plugin("theirs@there", "/other/proj"),
        ],
        issues: ["claude Plugin: boom"],
      };
    },
    mcpStatus: async () => ({}), watchPaths: () => [], scanPath: async () => [],
    projects: () => ["/known/project"],
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    showView(state);
    await settle();
    state.onMessage({ type: "selectProject", path: "/unknown/project" });
    await settle();
    assert.equal(scanned.includes("/unknown/project"), false);

    state.onMessage({ type: "selectProject", path: "/known/project" });
    await settle();
    const posted = state.posted.filter(message => message.type === "projectInventory").at(-1);
    assert.equal(posted.path, "/known/project");
    assert.deepEqual(posted.items.map(x => x.name), ["theirs", "ours@here"]);
    assert.deepEqual(posted.issues, ["claude Plugin: boom"]);
  } finally {
    for (const entry of context.subscriptions) entry.dispose?.();
  }
});

/**
 * Webview のスクリプトは vm でしか動かせない。DOM は使う分だけスタブして、
 * カードのタップで説明が開き、もう一度で閉じることを確かめる。
 */
function runWebviewScript() {
  const vm = require("node:vm");
  const { readFileSync } = require("node:fs");
  const bundle = JSON.parse(readFileSync(require.resolve("../l10n/bundle.l10n.json"), "utf8"));
  const { stub } = stubVscode({
    env: { remoteName: undefined, language: "en", clipboard: { readText: async () => "" } },
    l10n: { t: text => bundle[text] ?? text },
  });
  const { DashboardProvider } = loadExtension(stub) && require("../out/ide/dashboard.js");
  const provider = new DashboardProvider(fakeEnv().appSupport);
  let html = "";
  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: "vscode-resource:",
      set html(value) { html = value; }, get html() { return html; },
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: () => Promise.resolve(true),
    },
    visible: false,
    onDidChangeVisibility: () => ({ dispose() {} }),
  });
  provider.dispose();

  const script = html.slice(html.lastIndexOf("<script"), html.lastIndexOf("</script>"));
  const body = script.slice(script.indexOf(">") + 1);
  const element = () => ({
    innerHTML: "", textContent: "", value: "", dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [], scrollIntoView() {},
  });
  const listeners = [];
  const context = {
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: { querySelector: element, querySelectorAll: () => [] },
    window: { addEventListener: (_type, handler) => listeners.push(handler) },
  };
  vm.createContext(context);
  new vm.Script(body).runInContext(context);
  return { context, send: message => listeners.forEach(handler => handler({ data: message })) };
}

test("カードのタップで説明を開き、もう一度で閉じる", () => {
  const { context, send } = runWebviewScript();
  const tool = {
    name: "my-skill", kind: "skill", scope: "user", agents: ["claude"], origin: "user",
    enabled: true, hasUpdate: false, summary: "what it does",
    sourcePath: "/home/me/.agents/skills/my-skill",
  };
  send({ type: "inventory", items: [tool], projects: [], issues: [] });

  const closed = context.rowsHtml([tool]);
  assert.match(closed, /role="button"/);
  assert.equal(closed.includes("what it does"), false);

  context.toggleDetail(tool);
  const open = context.rowsHtml([tool]);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /what it does/);
  assert.match(open, /\/home\/me\/\.agents\/skills\/my-skill/);

  context.toggleDetail(tool);
  assert.equal(context.rowsHtml([tool]).includes("what it does"), false);
});

/** 「導入しています…」を元に戻せるのは結果の通知だけ。成否を Webview へ返す。 */
test("導入の結果を Webview に返す", async () => {
  const { stub, state } = stubVscode();
  const { context } = activateWith(stub, fakeEnv().appSupport, {
    inventory: async () => ({ items: [], issues: [] }), mcpStatus: async () => ({}),
    watchPaths: () => [], scanPath: async () => [], projects: () => [],
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const request = { type: "installTool", url: "https://github.com/o/r", kind: "skill", name: "x" };
  const lastDone = () => state.posted.filter(message => message.type === "installDone").at(-1);
  try {
    showView(state);
    stub.commands.executeCommand = () => Promise.resolve(true);
    state.onMessage(request);
    await settle();
    assert.deepEqual(lastDone(), { type: "installDone", ok: true });

    stub.commands.executeCommand = () => Promise.resolve(false);
    state.onMessage(request);
    await settle();
    assert.deepEqual(lastDone(), { type: "installDone", ok: false });
  } finally {
    for (const entry of context.subscriptions) entry.dispose?.();
  }
});

/** 監視は View の表示中だけ。閉じたら watcher を手放す（設計決定 D-6）。 */
test("ファイル監視は View の表示中だけ動かす", () => {
  const { stub, state } = stubVscode();
  const { context } = activateWith(stub, fakeEnv().appSupport, {
    inventory: async () => ({ items: [], issues: [] }), mcpStatus: async () => ({}),
    watchPaths: () => ["/a", "/b"], scanPath: async () => [], projects: () => [],
  });
  try {
    const view = showView(state);
    assert.equal(state.watchers, 2);
    view.visible = false;
    state.onVisibility();
    assert.equal(state.watchers, 0);
  } finally {
    for (const entry of context.subscriptions) entry.dispose?.();
  }
});

test("更新があるときだけ Status Bar にバッジを出す", async () => {
  const { stub, state } = stubVscode();
  const item = hasUpdate => ({
    name: "pdf", kind: "skill", scope: "user", agents: ["claude"], origin: "managed",
    enabled: true, hasUpdate,
  });
  let updates = false;
  const { context } = activateWith(stub, fakeEnv().appSupport, {
    inventory: async () => ({ items: [item(updates)], issues: [] }), mcpStatus: async () => ({}),
    watchPaths: () => [], scanPath: async () => [], projects: () => [],
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    showView(state);
    await settle();
    assert.equal(state.badge.shown, false);
    updates = true;
    await state.commands.get("agent-tool.refreshInventory")();
    await settle();
    assert.equal(state.badge.shown, true);
  } finally {
    for (const entry of context.subscriptions) entry.dispose?.();
  }
});

/** クリップボードは読むだけ。対応外の文字列では何も提案しない。 */
test("クリップボードの対応 URL だけを 1 回提案する", async () => {
  const { stub, state } = stubVscode();
  stub.env.clipboard = { readText: async () => "  https://github.com/o/r  " };
  const { context } = activateWith(stub, fakeEnv().appSupport, {
    inventory: async () => ({ items: [], issues: [] }), mcpStatus: async () => ({}),
    watchPaths: () => [], scanPath: async () => [], projects: () => [],
    isSupportedUrl: url => url.startsWith("https://github.com/"),
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    const view = showView(state);
    await settle();
    const offers = state.posted.filter(message => message.type === "clipboard");
    assert.equal(offers.length, 1);
    assert.equal(offers[0].url, "https://github.com/o/r");

    // 同じ内容では二度提案しない
    view.visible = false;
    state.onVisibility();
    view.visible = true;
    state.onVisibility();
    await settle();
    assert.equal(state.posted.filter(message => message.type === "clipboard").length, 1);
  } finally {
    for (const entry of context.subscriptions) entry.dispose?.();
  }
});
