import { getCard } from "../../data/loader";
import { validateDeck } from "./rules";
import type { DeckArtworkSelection, DeckList } from "../types";

export const SAVED_DECKS_STORAGE_KEY = "hololive-cardgame.saved-decks.v1";

export interface SavedDeck {
  id: string;
  deck: DeckList;
  updatedAt: number;
}

type DeckStorage = Pick<Storage, "getItem" | "setItem">;

function storageOrNull(storage?: DeckStorage): DeckStorage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeCounts(
  value: unknown,
  destination: "main" | "cheer",
): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const counts: Record<string, number> = {};
  for (const [cardId, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0)
      return null;
    try {
      const card = getCard(cardId);
      if (
        (destination === "main" &&
          (card.cardType === "oshi" || card.cardType === "yell")) ||
        (destination === "cheer" && card.cardType !== "yell")
      )
        return null;
    } catch {
      return null;
    }
    counts[cardId] = count;
  }
  return counts;
}

function normalizeArtworkCounts(
  value: unknown,
  cardCounts: Record<string, number>,
): Record<string, Record<string, number>> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const result: Record<string, Record<string, number>> = {};
  for (const [cardId, rawVariants] of Object.entries(value)) {
    const total = cardCounts[cardId];
    if (!Number.isSafeInteger(total) || total <= 0 || !isRecord(rawVariants))
      return null;
    let card: ReturnType<typeof getCard>;
    try {
      card = getCard(cardId);
    } catch {
      return null;
    }
    const variants: Record<string, number> = {};
    let alternateTotal = 0;
    for (const [artworkKey, count] of Object.entries(rawVariants)) {
      if (
        artworkKey === card.imageVariants[0] ||
        !card.imageVariants.includes(artworkKey) ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count <= 0
      )
        return null;
      alternateTotal += count;
      variants[artworkKey] = count;
    }
    if (alternateTotal > total) return null;
    if (Object.keys(variants).length > 0) result[cardId] = variants;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeArtworks(
  value: unknown,
  oshiId: string,
  main: Record<string, number>,
  cheer: Record<string, number>,
): DeckArtworkSelection | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const oshi = getCard(oshiId);
  const rawOshi = value.oshi;
  if (
    rawOshi !== undefined &&
    (typeof rawOshi !== "string" || !oshi.imageVariants.includes(rawOshi))
  )
    return null;
  const normalizedOshi =
    rawOshi && rawOshi !== oshi.imageVariants[0] ? rawOshi : undefined;
  const normalizedMain = normalizeArtworkCounts(value.main, main);
  const normalizedCheer = normalizeArtworkCounts(value.cheer, cheer);
  if (normalizedMain === null || normalizedCheer === null) return null;
  if (!normalizedOshi && !normalizedMain && !normalizedCheer) return undefined;
  return {
    ...(normalizedOshi ? { oshi: normalizedOshi } : {}),
    ...(normalizedMain ? { main: normalizedMain } : {}),
    ...(normalizedCheer ? { cheer: normalizedCheer } : {}),
  };
}

function normalizeSavedDeck(value: unknown): SavedDeck | null {
  if (!isRecord(value) || !isRecord(value.deck)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const updatedAt = Number(value.updatedAt);
  const name =
    typeof value.deck.name === "string" ? value.deck.name.trim() : "";
  const oshiId = typeof value.deck.oshiId === "string" ? value.deck.oshiId : "";
  const main = normalizeCounts(value.deck.main, "main");
  const cheer = normalizeCounts(value.deck.cheer, "cheer");
  if (!id || !name || !main || !cheer || !Number.isFinite(updatedAt))
    return null;
  try {
    if (getCard(oshiId).cardType !== "oshi") return null;
  } catch {
    return null;
  }
  const artworks = normalizeArtworks(value.deck.artworks, oshiId, main, cheer);
  if (artworks === null) return null;
  const deck: DeckList = {
    name,
    oshiId,
    main,
    cheer,
    ...(artworks ? { artworks } : {}),
  };
  if (!validateDeck(deck).ok) return null;
  return { id, deck, updatedAt };
}

/** 壊れたデータや旧カードIDを含むレコードを除外して読み込む。 */
export function loadSavedDecks(storage?: DeckStorage): SavedDeck[] {
  try {
    const source = storageOrNull(storage);
    if (!source) return [];
    const raw = source.getItem(SAVED_DECKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const decks: SavedDeck[] = [];
    for (const value of parsed) {
      const saved = normalizeSavedDeck(value);
      if (!saved || seen.has(saved.id)) continue;
      seen.add(saved.id);
      decks.push(saved);
    }
    return decks;
  } catch {
    return [];
  }
}

export function saveSavedDecks(
  decks: SavedDeck[],
  storage?: DeckStorage,
): void {
  const destination = storageOrNull(storage);
  if (!destination) throw new Error("ローカルストレージを利用できませんでした");
  destination.setItem(SAVED_DECKS_STORAGE_KEY, JSON.stringify(decks));
}

export function createSavedDeckId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ------------------------------------------------------------
// デッキのJSON入出力 (バックアップ・共有用)
// ------------------------------------------------------------

export interface DeckJsonParseResult {
  decks: DeckList[];
  errors: string[];
}

/** デッキ1件を人が読める整形付きJSONにする */
export function deckToJson(deck: DeckList): string {
  return JSON.stringify(deck, null, 2);
}

/** 保存済みデッキ全体のバックアップ用JSON (配列) */
export function decksToJson(decks: DeckList[]): string {
  return JSON.stringify(decks, null, 2);
}

/** OSで使えない文字を避けた書き出しファイル名 */
export function deckExportFileName(deck: DeckList): string {
  const safe = deck.name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 60);
  return `${safe || "deck"}.json`;
}

function readCounts(
  value: unknown,
  field: "main" | "cheer",
  label: string,
  errors: string[],
): Record<string, number> | null {
  const fieldLabel =
    field === "main" ? "メインデッキ (main)" : "エールデッキ (cheer)";
  if (!isRecord(value)) {
    errors.push(`${label}: ${fieldLabel}がありません`);
    return null;
  }
  const counts: Record<string, number> = {};
  for (const [cardId, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      errors.push(`${label}: 「${cardId}」の枚数が不正です`);
      continue;
    }
    try {
      getCard(cardId);
    } catch {
      errors.push(`${label}: カードID「${cardId}」が見つかりません`);
      continue;
    }
    counts[cardId] = count;
  }
  return counts;
}

function readDeckCandidate(
  value: unknown,
  label: string,
): { deck?: DeckList; errors: string[] } {
  if (!isRecord(value))
    return { errors: [`${label}: デッキの形式ではありません`] };
  // 保存領域のバックアップ ({deck: {...}} 形式) も受け付ける
  const source = isRecord(value.deck) ? value.deck : value;
  const errors: string[] = [];
  const name = typeof source.name === "string" ? source.name.trim() : "";
  const shown = name ? `「${name}」` : label;
  if (!name) errors.push(`${label}: デッキ名 (name) がありません`);
  const oshiId = typeof source.oshiId === "string" ? source.oshiId : "";
  if (!oshiId) {
    errors.push(`${shown}: 推しホロメン (oshiId) がありません`);
  } else {
    try {
      if (getCard(oshiId).cardType !== "oshi")
        errors.push(`${shown}: 「${oshiId}」は推しホロメンではありません`);
    } catch {
      errors.push(
        `${shown}: 推しホロメンのカードID「${oshiId}」が見つかりません`,
      );
    }
  }
  const main = readCounts(source.main, "main", shown, errors);
  const cheer = readCounts(source.cheer, "cheer", shown, errors);
  if (!main || !cheer || errors.length > 0) return { errors };
  const artworks = normalizeArtworks(source.artworks, oshiId, main, cheer);
  if (artworks === null)
    return { errors: [`${shown}: カード画像の指定が不正です`] };
  const deck: DeckList = {
    name,
    oshiId,
    main,
    cheer,
    ...(artworks ? { artworks } : {}),
  };
  const validation = validateDeck(deck);
  if (!validation.ok)
    return { errors: validation.errors.map((error) => `${shown}: ${error}`) };
  return { deck, errors: [] };
}

/**
 * JSON文字列からデッキを読み取る。単体のデッキ・配列 (バックアップ) の
 * 両形式を受け付け、読めたデッキと不正内容の説明を分けて返す。
 */
export function parseDecksJson(text: string): DeckJsonParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { decks: [], errors: ["JSONとして読み取れませんでした"] };
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  if (candidates.length === 0)
    return { decks: [], errors: ["デッキが入っていません"] };
  const decks: DeckList[] = [];
  const errors: string[] = [];
  candidates.forEach((value, index) => {
    const label = candidates.length === 1 ? "デッキ" : `${index + 1}件目`;
    const result = readDeckCandidate(value, label);
    if (result.deck) decks.push(result.deck);
    else errors.push(...result.errors);
  });
  return { decks, errors };
}
