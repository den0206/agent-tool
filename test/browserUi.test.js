const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

test("popup package exposes install safety and accessible live status", () => {
  const html = readFileSync(join(__dirname, "..", "browser", "tab.html"), "utf8");
  assert.match(html, /id="security-title"/);
  assert.match(html, /id="permission-note"/);
  assert.match(html, /id="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="found-card"[^>]*aria-busy="false"/);
});

test("detected tool animation respects reduced motion", () => {
  const css = readFileSync(join(__dirname, "..", "browser", "detection.css"), "utf8");
  assert.match(css, /@keyframes detected-bloom/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /#found\.detected-pop \.card/);
});

test("browser manifest keeps permissions minimal", () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, "..", "browser", "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.permissions, ["webNavigation"]);
  assert.equal(manifest.permissions.includes("unlimitedStorage"), false);
});

test("popup UI stage helper keeps aria-busy and button state in sync", async () => {
  const { setStage } = await import("../out/web/browser/popupUi.js");
  const attributes = new Map();
  const container = {
    dataset: {},
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const button = { disabled: false };

  setStage(container, button, "permission");
  assert.equal(container.dataset.stage, "permission");
  assert.equal(attributes.get("aria-busy"), "true");
  assert.equal(button.disabled, true);

  setStage(container, button, "idle");
  assert.equal(container.dataset.stage, "idle");
  assert.equal(attributes.get("aria-busy"), "false");
  assert.equal(button.disabled, false);
});
