export interface YellColorCount {
  color: string;
  count: number;
}

/** エール色を最初に登場した順で集計する。 */
export function groupYellColors(colors: string[]): YellColorCount[] {
  const counts = new Map<string, number>();
  for (const color of colors) counts.set(color, (counts.get(color) ?? 0) + 1);
  return [...counts].map(([color, count]) => ({ color, count }));
}

/**
 * 単色は5枚以上、複数色は枚数に関係なく「色丸×枚数」表示にまとめる。
 */
export function shouldGroupYells(colors: string[]): boolean {
  const colorCount = new Set(colors).size;
  return colors.length >= 5 || colorCount >= 2;
}
