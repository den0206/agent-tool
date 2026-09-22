import { PAGE_LIMIT } from "../core/limits.js";

/** 本文を読みながら byte 上限を掛ける。全文読込後の切り詰めは上限にならない。 */
export async function readText(response: Response, limit: number): Promise<string | null> {
  if (response.body === null) return null;
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(next.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 「読めなかった」と「並んでいない」を混ぜないための見張り。`listSkills` は理由を問わず
 * 空配列を返すので、枠切れ（403/429 + `x-ratelimit-remaining: 0`）だけは呼び出し側が
 * 区別できるようにする。0 件を「無い」と表示すると、利用者は直しようのない案内を受け取る。
 */
export function rateLimitWatch(): { get: (url: string) => Promise<unknown | null>; hit: () => boolean } {
  let limited = false;
  const observant: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if ((response.status === 403 || response.status === 429)
        && response.headers.get("x-ratelimit-remaining") === "0") {
      limited = true;
    }
    return response;
  };
  return { get: url => fetchJson(url, observant), hit: () => limited };
}

/** JSON 応答を 2 MB まで読む。上限超過・通信失敗・壊れた JSON は同じく読めなかった扱い。 */
export async function fetchJson(url: string, fetchImpl: typeof fetch = fetch): Promise<unknown | null> {
  const response = await fetchImpl(url, { cache: "no-store" }).catch(() => null);
  if (response === null || !response.ok) return null;
  const text = await readText(response, PAGE_LIMIT);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
