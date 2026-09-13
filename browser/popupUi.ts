/**
 * Popup UI helpers. DOM-only concerns live here so tab.ts can focus on user flows.
 * Keep this module free of network, storage, and file-system access.
 */

export const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export function applyI18n(t: (key: string, ...args: string[]) => string): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n ?? "");
  }
}

export function applyTheme(value: string): void {
  document.documentElement.style.colorScheme = value;
}

/**
 * Replays the detection entrance animation even when the popup resolves a second item
 * without being recreated. The class is visual-only; reduced-motion is handled in CSS.
 */
export function animateDetection(section: HTMLElement): void {
  section.classList.remove("detected-pop");
  void section.offsetWidth;
  section.classList.add("detected-pop");
}

/**
 * 導入中はボタンを押せなくし、支援技術にも「処理中」を伝える。
 * 見た目の段階は status の文言が持つので、ここでは busy かどうかだけを扱う。
 */
export function setBusy(
  container: HTMLElement,
  button: HTMLButtonElement | null,
  busy: boolean,
): void {
  container.setAttribute("aria-busy", String(busy));
  if (button !== null) button.disabled = busy;
}

export function showStatus(node: HTMLElement, text: string, error = false): void {
  node.className = error ? "status error" : "status";
  node.textContent = text;
}

export function clearStatus(node: HTMLElement): void {
  showStatus(node, "");
}
