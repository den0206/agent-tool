import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tests = readdirSync("test").filter(file => file.endsWith(".test.js")).sort().map(file => `test/${file}`);
// 後始末を忘れたテストはタイマーを残し、全件成功のまま終わらなくなる。
// 1 件ごとと全体の両方に上限を置き、黙って止まらず失敗で返す。
const result = spawnSync(process.execPath, ["--test", "--test-timeout=60000", ...tests], {
  stdio: "inherit", timeout: 300_000,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
