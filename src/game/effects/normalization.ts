// カード本文の解析：normalization。

// ============================================================
// パーサー
// ============================================================

export const COLOR_RE = "(白|緑|赤|青|紫|黄)";

export const ANY_COUNT = 99;

export function num(s: string): number {
  return parseInt(s, 10);
}

/** 一部カードで使われる半角の山括弧を全角に正規化する */
export function normalizeText(text: string): string {
  return (
    text
      // 区切り・範囲・無色コストの表記を揃える。
      .replace(/:/g, "：")
      .replace(/～/g, "〜")
      .replace(/無色エール/g, "無色")
      .replace(/<([^<>]+)>/g, "〈$1〉")
      // 公式本文内でも中点の幅が異なる名称を、カード名と同じ表記へ揃える。
      .replace(/〈[^〉]+〉/g, (name) => name.replace(/･/g, "・"))
      .replace(/(?<!直)前の相手のターン/g, "直前の相手のターン")
      .replace(/自分のセンターが/g, "自分のセンターホロメンが")
      .replace(
        /((?:自分|相手)の(?:手札|ホロパワー)が\d+枚以上)あるなら/g,
        "$1なら",
      )
      .replace(/アーツ＋/g, "アーツ+")
  );
}

export function parseNames(text: string): string[] {
  return [...normalizeText(text).matchAll(/〈([^〉]+)〉/g)].map((m) => m[1]);
}
