import type { DeckList, PlayerId } from "../types";

export type TurnOrderChoice = "random" | "first" | "second";

/** CPU対戦で選んだ手番から、実際の先攻プレイヤーを決める。 */
export function resolveFirstPlayer(
  choice: TurnOrderChoice,
  rng: () => number = Math.random,
): PlayerId {
  if (choice === "first") return 0;
  if (choice === "second") return 1;
  return rng() < 0.5 ? 0 : 1;
}

/** 候補デッキから1件を抽選する。 */
export function pickRandomDeck(
  decks: DeckList[],
  rng: () => number = Math.random,
): DeckList | null {
  if (decks.length === 0) return null;
  return decks[Math.floor(rng() * decks.length)] ?? decks[decks.length - 1];
}
