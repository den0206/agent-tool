/**
 * 使う分だけの Chrome 拡張 API。`@types/chrome` は入れない —
 * 必要になるまで依存を増やさない（CLAUDE.md「配布・依存管理」）。
 */
declare namespace chrome {
  namespace runtime {
    function getURL(path: string): string;
    function sendMessage<T = unknown, R = unknown>(message: T): Promise<R>;
    const onMessage: {
      addListener(handler: (
        message: unknown,
        sender: { tab?: { id?: number }; url?: string },
        respond: (response?: unknown) => void,
      ) => boolean | void): void;
    };
  }
  namespace i18n {
    function getMessage(key: string, substitutions?: string | string[]): string;
    /** BCP 47（`ja` / `en-US`）。`<html lang>` にそのまま入れる。 */
    function getUILanguage(): string;
  }
  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
    function setBadgeTextColor(details: { color: string; tabId?: number }): Promise<void>;
    function setTitle(details: { title: string; tabId?: number }): Promise<void>;
    function openPopup(): Promise<void>;
  }
  namespace tabs {
    function query(filter: { active?: boolean; currentWindow?: boolean }):
      Promise<{ id?: number; url?: string }[]>;
    function sendMessage<T = unknown>(tabId: number, message: T): Promise<unknown>;
    const onRemoved: { addListener(handler: (tabId: number) => void): void };
  }
  namespace webNavigation {
    const onHistoryStateUpdated: {
      addListener(handler: (details: { tabId: number; url: string }) => void): void;
    };
  }
}
