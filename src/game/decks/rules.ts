// ============================================================
// デッキ構築ルール (6.1) の検証とサンプルデッキ生成
// ============================================================
import { rawSampleDecks } from "./sampleSource";
export { sampleDecksReady } from "./sampleSource";
import {
  getCard,
  holomenCards,
  oshiCards,
  supportCards,
  yellCards,
} from "../../data/loader";
import type {
  Color,
  HolomenCard,
  SupportCard,
  SupportType,
} from "../../data/types";
import type { DeckList } from "../types";

export interface DeckValidation {
  ok: boolean;
  errors: string[];
}

/** 公認・公式大会でデッキに入れられる上限枚数 (2026-06-19施行)。 */
const RESTRICTED_CARD_LIMITS: Readonly<Record<string, number>> = {
  "hBP01-030": 1,
  "hBP07-101": 1,
};

/** 構築検証と検査用デッキ生成で同じ枚数上限を使う。 */
export function mainDeckCopyLimit(id: string): number {
  const card = getCard(id);
  return (
    RESTRICTED_CARD_LIMITS[id] ??
    (card.cardType === "holomen" && card.unlimitedCopies ? Infinity : 4)
  );
}

export function validateDeck(deck: DeckList): DeckValidation {
  const errors: string[] = [];
  const oshi = getCard(deck.oshiId);
  if (oshi.cardType !== "oshi")
    errors.push("推しホロメンカードを1枚選んでください");
  if (deck.artworks?.oshi && !oshi.imageVariants.includes(deck.artworks.oshi))
    errors.push("推しホロメンの画像指定が不正です");

  let mainTotal = 0;
  for (const [id, n] of Object.entries(deck.main)) {
    const c = getCard(id);
    if (!Number.isSafeInteger(n) || n <= 0) {
      errors.push(`${c.name}の枚数は1以上の整数で指定してください`);
      continue;
    }
    mainTotal += n;
    if (c.cardType === "oshi" || c.cardType === "yell")
      errors.push(`${c.name}はデッキに入れられません`);
    const limit = mainDeckCopyLimit(id);
    if (n > limit)
      errors.push(`${c.name}は${limit}枚までしか入れられません (${n}枚)`);
  }
  if (mainTotal !== 50)
    errors.push(`デッキは50枚ちょうどにしてください (現在${mainTotal}枚)`);

  let cheerTotal = 0;
  for (const [id, n] of Object.entries(deck.cheer)) {
    const c = getCard(id);
    if (!Number.isSafeInteger(n) || n <= 0) {
      errors.push(`${c.name}の枚数は1以上の整数で指定してください`);
      continue;
    }
    cheerTotal += n;
    if (c.cardType !== "yell")
      errors.push(`${c.name}はエールデッキに入れられません`);
  }
  if (cheerTotal !== 20)
    errors.push(
      `エールデッキは20枚ちょうどにしてください (現在${cheerTotal}枚)`,
    );

  const hasDebut = Object.entries(deck.main).some(([id, n]) => {
    const c = getCard(id);
    return (
      Number.isSafeInteger(n) &&
      n > 0 &&
      c.cardType === "holomen" &&
      c.bloomLevel === "Debut"
    );
  });
  if (!hasDebut)
    errors.push(
      "Debutホロメンが1枚もありません (マリガンを繰り返して敗北します)",
    );

  validateArtworkCounts(deck.main, deck.artworks?.main, "メインデッキ", errors);
  validateArtworkCounts(
    deck.cheer,
    deck.artworks?.cheer,
    "エールデッキ",
    errors,
  );

  return { ok: errors.length === 0, errors };
}

function validateArtworkCounts(
  cardCounts: Record<string, number>,
  artworkCounts: Record<string, Record<string, number>> | undefined,
  label: string,
  errors: string[],
) {
  for (const [cardId, variants] of Object.entries(artworkCounts ?? {})) {
    const card = getCard(cardId);
    const total = cardCounts[cardId] ?? 0;
    let alternateTotal = 0;
    for (const [artworkKey, count] of Object.entries(variants)) {
      if (
        artworkKey === card.imageVariants[0] ||
        !card.imageVariants.includes(artworkKey)
      ) {
        errors.push(`${label}の${card.name}に不正な画像指定があります`);
        continue;
      }
      if (!Number.isSafeInteger(count) || count <= 0) {
        errors.push(`${label}の${card.name}の画像別枚数が不正です`);
        continue;
      }
      alternateTotal += count;
    }
    if (alternateTotal > total)
      errors.push(`${label}の${card.name}の画像別枚数が総枚数を超えています`);
  }
}

// ------------------------------------------------------------
// サンプルデッキ生成: 指定色のカードで自動構築
// ------------------------------------------------------------

function isMono(c: HolomenCard, color: Color): boolean {
  return c.colors.length === 1 && c.colors[0] === color;
}

interface Lineup {
  name: string;
  debut: HolomenCard[];
  first: HolomenCard[];
  second: HolomenCard[];
}

/** 指定色で Debut+1st を揃えたキャラのライナップを、2nd の充実度順に並べて返す */
function colorLineups(color: Color): Lineup[] {
  const names = new Map<string, Lineup>();
  for (const c of holomenCards.filter((h) => isMono(h, color))) {
    const e = names.get(c.name) ?? {
      name: c.name,
      debut: [],
      first: [],
      second: [],
    };
    if (c.bloomLevel === "Debut") e.debut.push(c);
    else if (c.bloomLevel === "1st") e.first.push(c);
    else if (c.bloomLevel === "2nd") e.second.push(c);
    names.set(c.name, e);
  }
  return [...names.values()]
    .filter((e) => e.debut.length > 0 && e.first.length > 0)
    .sort((a, b) => b.second.length - a.second.length);
}

/** サンプルデッキへ優先採用するサポート種別 */
const SAMPLE_SUPPORT_TYPES: SupportType[] = [
  "スタッフ",
  "アイテム",
  "イベント",
];

/** サポートの説明にデッキのキャラ名が含まれるか (◆〈名前〉ボーナスの一致判定) */
function matchesNames(support: SupportCard, deckNames: string[]): boolean {
  return deckNames.some((n) => support.description.includes(n));
}

/** デッキのキャラ名に一致するカードを優先した順序でサポートを返す */
function supportPool(deckNames: string[]): SupportCard[] {
  const order = SAMPLE_SUPPORT_TYPES;
  return supportCards
    .filter((c) => order.includes(c.supportType))
    .sort((a, b) => {
      // 1. デッキのキャラ名に噛み合う付属カードを最優先
      const am = matchesNames(a, deckNames) ? 0 : 1;
      const bm = matchesNames(b, deckNames) ? 0 : 1;
      if (am !== bm) return am - bm;
      // 2. テーマ内の種別優先順
      const at = order.indexOf(a.supportType);
      const bt = order.indexOf(b.supportType);
      if (at !== bt) return at - bt;
      // 3. 回転を優先し非LIMITEDを先に
      return Number(a.limited) - Number(b.limited);
    });
}

export interface BuildOptions {
  name?: string;
  /** その色の何番目のオシを使うか (既定 0) */
  oshiIndex?: number;
  /** ライナップ選択の開始位置。ずらすと別キャラ構成になる (既定 0) */
  lineupOffset?: number;
}

export function buildSampleDeck(
  color: Color,
  opts: BuildOptions = {},
): DeckList | null {
  const { oshiIndex = 0, lineupOffset = 0 } = opts;

  const oshis = oshiCards.filter((o) => o.color === color);
  const oshi = oshis[Math.min(oshiIndex, oshis.length - 1)];
  const yell = yellCards.find((y) => y.color === color);
  if (!oshi || !yell) return null;

  const all = colorLineups(color);
  const lineups = all.slice(lineupOffset, lineupOffset + 3);
  if (lineups.length < 2) return null;

  const main: Record<string, number> = {};
  let total = 0;
  const add = (id: string, n: number) => {
    if (total >= 50) return;
    const use = Math.min(n, 50 - total);
    main[id] = (main[id] ?? 0) + use;
    total += use;
  };

  for (const e of lineups) {
    add(e.debut[0].id, 4);
    add(e.first[0].id, 4);
    if (e.second.length > 0) add(e.second[0].id, 2);
  }
  // 残りをサポートで埋める
  const deckNames = lineups.map((e) => e.name);
  for (const c of supportPool(deckNames)) {
    if (total >= 50) break;
    add(c.id, 4);
  }
  if (total < 50) return null;

  return {
    name: opts.name ?? `${color}単色デッキ`,
    oshiId: oshi.id,
    main,
    cheer: { [yell.id]: 20 },
  };
}

/**
 * 利用可能なサンプルデッキ一覧。
 * 実戦を想定した固定リストを data/sample_decks.json から読み込む
 * NodeではJSONを直接読み、ブラウザではsampleDecksReadyで静的JSONの取得を待つ。
 * 呼び出し側が書き換えても影響しないよう複製して返す。
 */
export function sampleDecks(): DeckList[] {
  if (!rawSampleDecks)
    throw new Error("サンプルデッキの読み込みが完了していません");
  return rawSampleDecks.map((deck) => structuredClone(deck));
}
