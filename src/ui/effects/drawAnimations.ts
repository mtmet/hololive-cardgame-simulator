import type { GameState, PlayerId } from "../../game/types";

export const DRAW_FLIGHT_DURATION = 980;
export const DRAW_CARD_STAGGER_MS = 130;
export const DRAW_FLIGHT_REMOVE_BUFFER_MS = 90;
export const MULLIGAN_HAND_REVEAL_PAUSE_MS = 650;
export const MULLIGAN_RETURN_DURATION_MS = 720;
export const MULLIGAN_RETURN_STAGGER_MS = 70;
export const MULLIGAN_NEXT_DRAW_GAP_MS = 150;
export const MULLIGAN_RETURN_START_MS =
  DRAW_FLIGHT_DURATION +
  6 * DRAW_CARD_STAGGER_MS +
  MULLIGAN_HAND_REVEAL_PAUSE_MS;
export const MULLIGAN_BATCH_INTERVAL_MS =
  MULLIGAN_RETURN_START_MS +
  MULLIGAN_RETURN_DURATION_MS +
  6 * MULLIGAN_RETURN_STAGGER_MS +
  MULLIGAN_NEXT_DRAW_GAP_MS;
/**
 * 引き直し前から持っていた手札を山札へ戻す、最初のバッチより前の時間。
 * バッチ間の「戻して次を引く」区間と同じ長さにして流れを揃える。
 */
export const MULLIGAN_HAND_RETURN_LEAD_MS =
  MULLIGAN_BATCH_INTERVAL_MS - MULLIGAN_RETURN_START_MS;
const RESULT_REVEAL_GAP_MS = 120;

interface DrawZonePlayerSnapshot {
  deck: string[];
  hand: string[];
  /** 手札を山札へ戻す演出用。戻した後の状態には対応が残らないため控える */
  handCardIds: Record<string, string>;
  handArtworkKeys: Record<string, string>;
  mulliganCount: number;
  voluntaryMulliganDone: boolean;
}

export interface DrawZoneSnapshot {
  players: [DrawZonePlayerSnapshot, DrawZonePlayerSnapshot];
  lastLogId: number;
}

export interface DrawnCard {
  player: PlayerId;
  uid: string;
  batchIndex: number;
  cardIndex: number;
  redraw: boolean;
  logId?: number;
}

export interface MulliganDrawBatch {
  player: PlayerId;
  batchIndex: number;
  uids: string[];
  logId?: number;
}

/** 引き直しで山札へ戻る、引き直し前から持っていた手札の1枚。 */
export interface ReturnedHandCard {
  player: PlayerId;
  uid: string;
  cardId?: string;
  artworkKey?: string;
  cardIndex: number;
}

/**
 * Online viewが発行する、カード実体を追跡できない表示専用UID。
 * 実UIDは "u1" 形式、本人に公開してよいログ固有IDは "revealed-" 始まりで、
 * 隠す側だけが "hidden" で始まる。
 */
export function isPrivateDrawUid(uid: string): boolean {
  return uid.startsWith("hidden");
}

/**
 * 非公開UIDにはview上の偽配置cardIdを使わない。実カードと異なる表面を
 * 演出で見せる代わりに、CardViewの裏面フォールバックへ渡す。
 */
export function drawAnimationCardId(
  uidToCard: Readonly<Record<string, string>>,
  uid: string,
): string | undefined {
  return isPrivateDrawUid(uid) ? undefined : uidToCard[uid];
}

export function drawAnimationArtworkKey(
  uidToArtwork: Readonly<Record<string, string>> | undefined,
  uid: string,
): string | undefined {
  return isPrivateDrawUid(uid) ? undefined : uidToArtwork?.[uid];
}

export function mulliganDrawBatches(drawn: DrawnCard[]): MulliganDrawBatch[] {
  const batches = new Map<string, MulliganDrawBatch>();
  for (const card of drawn) {
    if (!card.redraw) continue;
    const key = `${card.player}:${card.batchIndex}`;
    const current = batches.get(key);
    if (current) current.uids.push(card.uid);
    else
      batches.set(key, {
        player: card.player,
        batchIndex: card.batchIndex,
        uids: [card.uid],
        logId: card.logId,
      });
  }
  return [...batches.values()].sort((a, b) => a.batchIndex - b.batchIndex);
}

/**
 * 引き直し前の手札を山札へ戻す演出の長さ。最初のバッチはこの分だけ後ろへずれる。
 */
export function mulliganHandReturnLead(returned: ReturnedHandCard[]): number {
  return returned.length > 0 ? MULLIGAN_HAND_RETURN_LEAD_MS : 0;
}

export function drawAnimationDuration(
  drawn: DrawnCard[],
  returned: ReturnedHandCard[] = [],
): number {
  if (drawn.length === 0) return 0;
  return (
    mulliganHandReturnLead(returned) +
    Math.max(
      ...drawn.map(({ batchIndex, cardIndex, redraw }) =>
        redraw
          ? batchIndex * MULLIGAN_BATCH_INTERVAL_MS + MULLIGAN_RETURN_START_MS
          : batchIndex * MULLIGAN_BATCH_INTERVAL_MS +
            cardIndex * DRAW_CARD_STAGGER_MS +
            DRAW_FLIGHT_DURATION +
            DRAW_FLIGHT_REMOVE_BUFFER_MS,
      ),
    ) +
    RESULT_REVEAL_GAP_MS
  );
}

export function drawZoneSnapshot(game: GameState): DrawZoneSnapshot {
  return {
    players: game.players.map((player) => ({
      deck: [...player.deck],
      hand: [...player.hand],
      handCardIds: Object.fromEntries(
        player.hand.flatMap((uid) => {
          const cardId = game.uidToCard[uid];
          return cardId === undefined ? [] : [[uid, cardId] as const];
        }),
      ),
      handArtworkKeys: Object.fromEntries(
        player.hand.flatMap((uid) => {
          const artworkKey = game.uidToArtwork?.[uid];
          return artworkKey === undefined ? [] : [[uid, artworkKey] as const];
        }),
      ),
      mulliganCount: player.mulliganCount,
      voluntaryMulliganDone: player.voluntaryMulliganDone,
    })) as [DrawZonePlayerSnapshot, DrawZonePlayerSnapshot],
    lastLogId: game.log.at(-1)?.id ?? 0,
  };
}

/**
 * 引き直しで山札へ戻る、引き直し前の手札。戻した後の状態からは実体を辿れないため、
 * 直前スナップショットのUIDと (本人に公開済みの) 表面をそのまま使う。
 */
export function returnedHandsSince(
  previous: DrawZoneSnapshot,
  drawn: DrawnCard[],
): ReturnedHandCard[] {
  const redrawPlayers = new Set(
    drawn.filter(({ redraw }) => redraw).map(({ player }) => player),
  );
  const returned: ReturnedHandCard[] = [];
  for (const player of [0, 1] as const) {
    if (!redrawPlayers.has(player)) continue;
    const prior = previous.players[player];
    prior.hand.forEach((uid, cardIndex) => {
      returned.push({
        player,
        uid,
        cardId: isPrivateDrawUid(uid) ? undefined : prior.handCardIds[uid],
        artworkKey: isPrivateDrawUid(uid)
          ? undefined
          : prior.handArtworkKeys[uid],
        cardIndex,
      });
    });
  }
  return returned;
}

function inferredPrivateViewDraws(
  prior: DrawZonePlayerSnapshot,
  current: GameState["players"][PlayerId],
  gameRev: number,
  player: PlayerId,
): string[] {
  const deckDecrease = Math.max(0, prior.deck.length - current.deck.length);
  if (deckDecrease === 0) return [];

  const previousHand = new Set(prior.hand);
  // 自席viewでは手札だけ実UIDになるため、山札とのUID一致がなくても
  // 新しく公開された手札を正しいカード表面で演出できる。
  const newlyVisible = current.hand.filter(
    (uid) => !previousHand.has(uid) && !isPrivateDrawUid(uid),
  );
  if (newlyVisible.length > 0)
    return newlyVisible.slice(-Math.min(deckDecrease, newlyVisible.length));

  // 相手・観戦viewの手札は位置IDなので、枚数差だけを使う。カードや位置と
  // 後から相関できない、revision内限定の演出IDを発行する。
  const handIncrease = Math.max(0, current.hand.length - prior.hand.length);
  const count = Math.min(deckDecrease, handIncrease);
  return Array.from(
    { length: count },
    (_, index) => `hidden-draw-${gameRev}-${player}-${index}`,
  );
}

export function drawnCardsSince(
  previous: DrawZoneSnapshot,
  game: GameState,
): DrawnCard[] {
  const recordedPlayers = new Set<PlayerId>();
  const normalCardIndices: [number, number] = [0, 0];
  const drawn: DrawnCard[] = [];
  let batchIndex = 0;

  for (const entry of game.log) {
    const player = entry.player;
    if (
      entry.id <= previous.lastLogId ||
      (player !== 0 && player !== 1) ||
      !entry.draw
    )
      continue;

    recordedPlayers.add(player);
    const redraw = entry.draw.kind === "mulligan";
    entry.draw.uids.forEach((uid, cardIndex) => {
      drawn.push({
        player,
        uid,
        batchIndex,
        cardIndex: redraw ? cardIndex : normalCardIndices[player]++,
        redraw,
        logId: entry.id,
      });
    });
    if (redraw) batchIndex++;
  }

  for (const player of [0, 1] as const) {
    const current = game.players[player];
    const prior = previous.players[player];
    if (recordedPlayers.has(player)) continue;

    const previousDeck = new Set(prior.deck);
    const previousHand = new Set(prior.hand);
    const redrewWithoutMetadata =
      game.phase === "setup" &&
      (current.mulliganCount > prior.mulliganCount ||
        (!prior.voluntaryMulliganDone && current.voluntaryMulliganDone));
    const exactDraws = current.hand.filter(
      (uid) => !previousHand.has(uid) && previousDeck.has(uid),
    );
    const playerDrawn = redrewWithoutMetadata
      ? current.hand
      : exactDraws.length > 0
        ? exactDraws
        : inferredPrivateViewDraws(prior, current, game.rev, player);
    if (playerDrawn.length === 0) continue;

    playerDrawn.forEach((uid, cardIndex) => {
      drawn.push({
        player,
        uid,
        batchIndex,
        cardIndex,
        redraw: redrewWithoutMetadata,
      });
    });
    batchIndex++;
  }

  return drawn;
}
