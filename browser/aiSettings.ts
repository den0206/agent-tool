const API_KEY = "jevApiKey";
const ENABLED = "jevEnabled";

let protectedStorage: Promise<void> | null = null;

/**
 * key を書く前に content script から読めなくする。呼ぶのは popup だけでよい
 * （key を読み書きするのは popup だけ。service worker は触らない）。
 * `setAccessLevel` は `minimum_chrome_version: 123` で必ず存在する。
 */
export function protectAiStorage(): Promise<void> {
  if (protectedStorage === null) {
    protectedStorage = chrome.storage.local
      .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
      .catch(error => {
        protectedStorage = null;
        throw error;
      });
  }
  return protectedStorage;
}

export async function jevApiKey(): Promise<string> {
  await protectAiStorage();
  const values = await chrome.storage.local.get([API_KEY]);
  return typeof values[API_KEY] === "string" ? values[API_KEY].trim() : "";
}

export async function setJevApiKey(value: string): Promise<void> {
  await protectAiStorage();
  const key = value.trim();
  if (key === "") await chrome.storage.local.remove([API_KEY]);
  else await chrome.storage.local.set({ [API_KEY]: key });
}

export async function jevEnabled(): Promise<boolean> {
  await protectAiStorage();
  const values = await chrome.storage.local.get([ENABLED]);
  return values[ENABLED] === true;
}

export async function setJevEnabled(enabled: boolean): Promise<void> {
  await protectAiStorage();
  await chrome.storage.local.set({ [ENABLED]: enabled });
}
