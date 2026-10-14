// ============================================================
// determinization: 観測ビューから完全状態を再構成する
// 探索AIは候補手を実際に適用して評価するが、真の状態を使うと
// 隠し情報 (デッキ順・相手の手札・非公開ライフ) をリークする。
// そこで gameViewFor(state, seat) のビューを入力に、見えない領域を
// 「公開情報と矛盾しないランダムな完全状態」として再構成する。
//
// - 自分の非公開領域 (デッキ∪ホロパワー、ライフ∪エールデッキ):
//   中身の多重集合は既知・配置順だけが未知なので、プールを
//   シャッフルして再配置する。入力中の選択候補や付与待ちのカードは、
//   その領域から移すと選択が不正になるため所在・順序を保持する
// - 相手の非公開uid: 識別子ごと不明なので、相手の公開領域
//   (ステージ・アーカイブ) から推定したカードプールでプレース
//   ホルダを割り当てる。エンジンが cardOf で参照しても落ちない
//   ことが目的で、評価関数は枚数しか見ないため精度は問わない
// ============================================================
import { getCard, holomenCards, yellCards } from "../../data/loader";
import type { DeckList, GameState, PlayerId, PlayerState } from "../types";
import { inferOpponentDeck, publicOpponentCards } from "./inference";
import { shuffledBy } from "./types";

/** 複数領域のuidをまとめてシャッフルし、同じ枚数ずつ再配置する */
function redealAcross(
  zones: string[][],
  rng: () => number,
  fixed: ReadonlySet<string>,
): void {
  const pool = shuffledBy(
    zones.flatMap((zone) => zone.filter((uid) => !fixed.has(uid))),
    rng,
  );
  let offset = 0;
  for (const zone of zones) {
    for (let i = 0; i < zone.length; i++)
      if (!fixed.has(zone[i])) zone[i] = pool[offset++];
  }
}

/** 相手の公開領域から、隠しカードの識別子プールを推定する */
function guessPools(
  det: GameState,
  opp: PlayerState,
): { mainPool: string[]; yellPool: string[] } {
  const mainPool: string[] = [];
  const yellPool: string[] = [];
  const collect = (uid: string) => {
    const cardId = det.uidToCard[uid];
    if (!cardId) return;
    (getCard(cardId).cardType === "yell" ? yellPool : mainPool).push(cardId);
  };
  for (const uid of opp.archive) collect(uid);
  for (const uid of opp.resolvingSupports ?? []) collect(uid);
  for (const stack of [opp.center, opp.collab, ...opp.back]) {
    if (!stack) continue;
    for (const uid of [...stack.cards, ...stack.supports, ...stack.yells])
      collect(uid);
  }
  // 公開領域が空でも割り当てられるよう、カードDBから補充する
  if (mainPool.length === 0)
    mainPool.push(
      ...holomenCards
        .filter((card) => card.bloomLevel === "Debut")
        .slice(0, 4)
        .map((card) => card.id),
    );
  if (yellPool.length === 0)
    yellPool.push(...yellCards.slice(0, 6).map((card) => card.id));
  return { mainPool, yellPool };
}

function expanded(counts: Readonly<Record<string, number>>): string[] {
  return Object.entries(counts).flatMap(([cardId, count]) =>
    Array.from({ length: count }, () => cardId),
  );
}

function subtractPublished(
  cards: readonly string[],
  published: ReadonlyMap<string, number>,
): string[] {
  const remaining = new Map(published);
  return cards.filter((cardId) => {
    const count = remaining.get(cardId) ?? 0;
    if (count <= 0) return true;
    remaining.set(cardId, count - 1);
    return false;
  });
}

function inferredPools(
  det: GameState,
  oppSeat: PlayerId,
  deck: DeckList,
): { mainPool: string[]; yellPool: string[] } {
  const published = publicOpponentCards(det, oppSeat);
  const mainPool = subtractPublished(expanded(deck.main), published.main);

  // 公開情報はエールの色まででよいため、同色カードから順に差し引く。
  const remainingColors = new Map(published.cheerColors);
  const yellPool = expanded(deck.cheer).filter((cardId) => {
    const card = getCard(cardId);
    if (card.cardType !== "yell") return false;
    const count = remainingColors.get(card.color) ?? 0;
    if (count <= 0) return true;
    remainingColors.set(card.color, count - 1);
    return false;
  });
  return { mainPool, yellPool };
}

/**
 * 観測ビューの非公開領域を再構成した完全状態を返す (入力は変更しない)。
 * seat はビューの視点席 (gameViewFor に渡したものと同じ)。
 * 乱数は options.rng 系の自前RNGのみを使い、Math.random には触れない。
 */
export function determinize(
  view: GameState,
  seat: PlayerId,
  rng: () => number,
  opponentDeck: DeckList | null = null,
): GameState {
  const det = structuredClone(view);
  const self = det.players[seat];
  const opp = det.players[(1 - seat) as PlayerId];

  // 自分が現在選択・送付しているカードは観測済み。入力の前提を維持する。
  const fixed = new Set<string>();
  for (const prompt of det.prompts) {
    if (prompt.player !== seat) continue;
    if (prompt.type === "effectPickCard")
      for (const uid of prompt.uids) fixed.add(uid);
    else if (prompt.type === "effectAttach") fixed.add(prompt.uid);
    else if (prompt.type === "cheerAssign") fixed.add(prompt.yellUid);
  }
  // 自分: 順序・所在だけが非公開のプールを混ぜ直す
  redealAcross([self.deck, self.holoPower], rng, fixed);
  redealAcross([self.life, self.cheerDeck], rng, fixed);

  // 相手: 識別子が消されたuidへプレースホルダを割り当てる
  const fallback = guessPools(det, opp);
  const inferred = inferOpponentDeck(det, (1 - seat) as PlayerId, opponentDeck);
  const exact = inferred
    ? inferredPools(det, (1 - seat) as PlayerId, inferred)
    : null;
  const mainPool = shuffledBy(exact?.mainPool ?? [], rng);
  const yellPool = shuffledBy(exact?.yellPool ?? [], rng);
  let mainOffset = 0;
  let yellOffset = 0;
  const assign = (
    uid: string,
    pool: string[],
    fallbackPool: string[],
    nextOffset: () => number,
  ) => {
    if (det.uidToCard[uid] !== undefined) return;
    const offset = nextOffset();
    det.uidToCard[uid] =
      pool[offset] ?? fallbackPool[Math.floor(rng() * fallbackPool.length)];
  };
  const assignMain = (uid: string) =>
    assign(uid, mainPool, fallback.mainPool, () => mainOffset++);
  const assignYell = (uid: string) =>
    assign(uid, yellPool, fallback.yellPool, () => yellOffset++);
  for (const uid of [...opp.life, ...opp.cheerDeck]) assignYell(uid);
  for (const uid of [...opp.deck, ...opp.hand, ...opp.holoPower])
    assignMain(uid);
  // ゲーム準備中の裏向きステージ (通常は準備中に探索しないが安全のため)
  for (const stack of [opp.center, opp.collab, ...opp.back]) {
    if (!stack?.faceDown) continue;
    for (const uid of [...stack.cards, ...stack.supports]) assignMain(uid);
    for (const uid of stack.yells) assignYell(uid);
  }
  // 領域から取り出し済みのままプロンプトに保留されているuid
  // (ライフ損失でshift済みのcheerAssign等)。相手のものは識別子が無いので補う
  for (const prompt of det.prompts) {
    if (prompt.type === "cheerAssign") assignYell(prompt.yellUid);
    else if (prompt.type === "effectAttach") assignMain(prompt.uid);
    else if (prompt.type === "effectPickCard")
      for (const uid of prompt.uids)
        (prompt.from === "cheer" ? assignYell : assignMain)(uid);
  }
  return det;
}
