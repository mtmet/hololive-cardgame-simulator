// ゲーム状態とルールの処理：state。
import { getCard } from "../../data/loader";
import type { Card, HolomenCard } from "../../data/types";
import type {
  GameState,
  HolomenStack,
  PlayerId,
  PlayerState,
  StagePosition,
} from "../types";

export function cardOf(s: GameState, uid: string): Card {
  const cardId = s.uidToCard[uid];
  if (cardId) return getCard(cardId);
  const history = /^last-known:(\d+):(\d+)$/.exec(uid);
  return getCard(
    history
      ? (s.lastKnownHolomen?.[Number(history[1])]?.cardIds[
          Number(history[2])
        ] ?? "")
      : "",
  );
}

export function holomenOf(s: GameState, uid: string): HolomenCard {
  const c = cardOf(s, uid);
  if (c.cardType !== "holomen") throw new Error("ホロメンカードではありません");
  return c;
}

export function topCard(s: GameState, stack: HolomenStack): HolomenCard {
  return holomenOf(s, stack.cards[0]);
}

export function other(p: PlayerId): PlayerId {
  return (1 - p) as PlayerId;
}

export function getStack(
  p: PlayerState,
  pos: StagePosition,
): HolomenStack | null {
  if (pos === "center") return p.center;
  if (pos === "collab") return p.collab;
  return p.back[pos.back] ?? null;
}

/** ステージ上の全ホロメン (推しを除く) */
export function allStacks(
  p: PlayerState,
): { pos: StagePosition; stack: HolomenStack }[] {
  const r: { pos: StagePosition; stack: HolomenStack }[] = [];
  if (p.center) r.push({ pos: "center", stack: p.center });
  if (p.collab) r.push({ pos: "collab", stack: p.collab });
  p.back.forEach((stack, i) => r.push({ pos: { back: i }, stack }));
  return r;
}

export function stageCount(p: PlayerState): number {
  return allStacks(p).length;
}

export function findStackById(
  s: GameState,
  stackId: number,
): { player: PlayerId; pos: StagePosition; stack: HolomenStack } | null {
  for (const pid of [0, 1] as PlayerId[]) {
    for (const { pos, stack } of allStacks(s.players[pid])) {
      if (stack.id === stackId) return { player: pid, pos, stack };
    }
  }
  return null;
}

/** 発生源の情報参照専用。効果の対象や能力の保持者は現在のステージから探す。 */
export function sourceHolomen(
  s: GameState,
  stackId: number,
): HolomenStack | null {
  return (
    findStackById(s, stackId)?.stack ??
    s.lastKnownHolomen?.[stackId]?.stack ??
    null
  );
}

/** ステージ外から登場するホロメンのギフトは新しい能力として扱う (4.1.4)。 */
export function resetHolomenCardUsage(s: GameState, uid: string): void {
  for (const key of Object.keys(s.usedTriggersThisTurn)) {
    // ネイティブギフトの履歴は「gift種別:カードUID[:能力番号]」。
    // プレイヤー・能力名の共通制限や、付いていたサポートの履歴は消さない。
    if (key.startsWith("gift") && key.split(":")[1] === uid)
      delete s.usedTriggersThisTurn[key];
  }
}

export function newStack(
  s: GameState,
  uid: string,
  turn: number,
): HolomenStack {
  resetHolomenCardUsage(s, uid);
  return {
    id: s.nextStackId++,
    cards: [uid],
    yells: [],
    supports: [],
    damage: 0,
    resting: false,
    faceDown: false,
    enteredTurn: turn,
    bloomedThisTurn: false,
    usedArtsThisTurn: false,
  };
}

export function posLabel(pos: StagePosition): string {
  if (pos === "center") return "センター";
  if (pos === "collab") return "コラボ";
  return `バック${pos.back + 1}`;
}

export function positionedHolomenName(
  s: GameState,
  pos: StagePosition,
  stack: HolomenStack,
): string {
  return `${posLabel(pos)}の${topCard(s, stack).name}`;
}

export function playerName(s: GameState, p: PlayerId): string {
  return s.players[p].name;
}

/** そのカードがいずれかの領域に置かれているか (解決途中の宙ぶらりんを検出する) */
export function cardIsPlaced(s: GameState, uid: string): boolean {
  for (const pl of s.players) {
    if (
      pl.hand.includes(uid) ||
      pl.deck.includes(uid) ||
      pl.cheerDeck.includes(uid) ||
      pl.archive.includes(uid) ||
      pl.resolvingSupports?.includes(uid) ||
      pl.holoPower.includes(uid) ||
      pl.life.includes(uid) ||
      pl.oshiUid === uid
    )
      return true;
    for (const { stack } of allStacks(pl))
      if (
        stack.cards.includes(uid) ||
        stack.yells.includes(uid) ||
        stack.supports.includes(uid)
      )
        return true;
  }
  return false;
}
