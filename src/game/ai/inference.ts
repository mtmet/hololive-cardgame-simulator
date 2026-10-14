// ============================================================
// 既知の相手デッキリストと公開情報の整合確認
// 構成が公開済みカードを多重集合としてすべて含む場合だけ採用し、
// 不整合 (別デッキへの差し替え等) は null へ安全にフォールバックする。
// ============================================================
import { getCard } from "../../data/loader";
import type { Color } from "../../data/types";
import type { DeckList, GameState, HolomenStack, PlayerId } from "../types";

export interface PublicCards {
  main: Map<string, number>;
  cheerColors: Map<Color, number>;
}

function addCount<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function collectStack(
  view: GameState,
  stack: HolomenStack,
  result: PublicCards,
): void {
  for (const uid of [...stack.cards, ...stack.supports, ...stack.yells]) {
    const cardId = view.uidToCard[uid];
    if (!cardId) continue;
    const card = getCard(cardId);
    if (card.cardType === "yell") addCount(result.cheerColors, card.color);
    else if (card.cardType !== "oshi") addCount(result.main, cardId);
  }
}

/** 相手のステージ・アーカイブに公開されたデッキ由来カードを数える。 */
export function publicOpponentCards(
  view: GameState,
  opp: PlayerId,
): PublicCards {
  const result: PublicCards = { main: new Map(), cheerColors: new Map() };
  const player = view.players[opp];
  for (const uid of player.archive) {
    const cardId = view.uidToCard[uid];
    if (!cardId) continue;
    const card = getCard(cardId);
    if (card.cardType === "yell") addCount(result.cheerColors, card.color);
    else if (card.cardType !== "oshi") addCount(result.main, cardId);
  }
  for (const stack of [player.center, player.collab, ...player.back])
    if (stack && !stack.faceDown) collectStack(view, stack, result);
  return result;
}

function containsCounts<K>(
  available: ReadonlyMap<K, number>,
  required: ReadonlyMap<K, number>,
): boolean {
  for (const [key, count] of required)
    if ((available.get(key) ?? 0) < count) return false;
  return true;
}

function deckCheerColors(deck: DeckList): Map<Color, number> {
  const counts = new Map<Color, number>();
  for (const [cardId, count] of Object.entries(deck.cheer)) {
    const card = getCard(cardId);
    if (card.cardType === "yell")
      counts.set(card.color, (counts.get(card.color) ?? 0) + count);
  }
  return counts;
}

/**
 * 既知の相手デッキが公開カードと整合するならそのまま返す。推しカードは常に
 * 公開情報なので一致を必須にし、不整合なら null へフォールバックする。
 */
export function inferOpponentDeck(
  view: GameState,
  opp: PlayerId,
  opponentDeck: DeckList | null | undefined,
): DeckList | null {
  if (!opponentDeck) return null;
  const player = view.players[opp];
  const publicOshiId = view.uidToCard[player.oshiUid];
  if (publicOshiId && opponentDeck.oshiId !== publicOshiId) return null;
  const published = publicOpponentCards(view, opp);
  const mainCounts = new Map(Object.entries(opponentDeck.main));
  if (!containsCounts(mainCounts, published.main)) return null;
  if (!containsCounts(deckCheerColors(opponentDeck), published.cheerColors))
    return null;
  return opponentDeck;
}
