const { test } = require("node:test");
const assert = require("node:assert/strict");

test("導入中はボタンを止めて aria-busy を立て、終わったら戻す", async () => {
  const { setBusy } = await import("../out/web/browser/popupUi.js");
  const attributes = new Map();
  const container = { setAttribute: (name, value) => attributes.set(name, value) };
  const button = { disabled: false };

  setBusy(container, button, true);
  assert.equal(attributes.get("aria-busy"), "true");
  assert.equal(button.disabled, true);

  setBusy(container, button, false);
  assert.equal(attributes.get("aria-busy"), "false");
  assert.equal(button.disabled, false);
});
