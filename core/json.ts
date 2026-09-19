/**
 * 外から来た JSON を読むときの共通述語。registry / 台帳 / MCP / Plugin の
 * どれも同じ形を確かめるので、同じ 2 行を各ファイルに置かない。
 */

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 中身のある文字列だけを返す。空文字は「書かれていない」と同じに扱う。 */
export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
