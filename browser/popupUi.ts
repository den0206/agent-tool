/**
 * Popup UI helpers. DOM-only concerns live here so tab.ts can focus on user flows.
 * Keep this module free of network, storage, and file-system access.
 */

export type PopupStage = "idle" | "resolving" | "permission" | "installing" | "done" | "error";

export const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export function applyI18n(
  t: (key: string, ...args: string[]) => string,
  root: ParentNode = document,
): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
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

export function setStage(
  container: HTMLElement,
  button: HTMLButtonElement | null,
  stage: PopupStage,
): void {
  container.dataset.stage = stage;
  const busy = stage === "resolving" || stage === "permission" || stage === "installing";
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
