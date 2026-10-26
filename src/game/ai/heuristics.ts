import { getCard } from "../../data/loader";
import type { ArtData, Color, HolomenCard } from "../../data/types";
import {
  artBonusOf,
  artGateError,
  availableArts,
  canPayArtCost,
  cardOf,
  effectiveMaxHp,
  legalArtTargets,
  stackColors,
  topCard,
  usableArts,
} from "../engine";
import type { GameState, HolomenStack, PlayerId, PlayerState } from "../types";

const BLOOM_VALUE: Record<HolomenCard["bloomLevel"], number> = {
  Spot: 10,
  Debut: 20,
  "1st": 55,
  "2nd": 90,
};

export function remainingHp(s: GameState, stack: HolomenStack): number {
  return Math.max(0, effectiveMaxHp(s, stack) - stack.damage);
}

export function artPower(
  s: GameState,
  attacker: HolomenStack,
  art: ArtData,
  target?: HolomenStack,
): number {
  let power = (parseInt(art.power, 10) || 0) + artBonusOf(s, attacker);
  if (
    target &&
    art.special_attack.target &&
    stackColors(s, target).includes(art.special_attack.target)
  )
    power += parseInt(art.special_attack.power ?? "0", 10) || 0;
  return Math.max(0, power);
}

export function maxArtPower(
  s: GameState,
  stack: HolomenStack,
  target?: HolomenStack,
): number {
  return topCard(s, stack).arts.reduce(
    (best, art) => Math.max(best, artPower(s, stack, art, target)),
    0,
  );
}

/** 公開情報だけで見積もる、ステージ上のホロメンの価値。 */
export function stackValue(s: GameState, stack: HolomenStack): number {
  const card = topCard(s, stack);
  return (
    remainingHp(s, stack) * 2 +
    maxArtPower(s, stack) * 2 +
    BLOOM_VALUE[card.bloomLevel] +
    stack.yells.length * 14 +
    stack.supports.length * 10 +
    (card.buzz ? 45 : 0)
  );
}

/** 深い探索 (hard/expert) で使う、投資済み資源を重く見たスタック価値。 */
function deepStackValue(s: GameState, stack: HolomenStack): number {
  const card = topCard(s, stack);
  return (
    remainingHp(s, stack) * 3 +
    maxArtPower(s, stack) * 2 +
    BLOOM_VALUE[card.bloomLevel] +
    stack.yells.length * 28 +
    stack.supports.length * 18 +
    (card.buzz ? 45 : 0)
  );
}

export function threatScore(s: GameState, stack: HolomenStack): number {
  return stackValue(s, stack) + (stack.resting ? -25 : 25);
}

/** 手札選択時の保持価値。低いカードほどコストとして捨てやすい。 */
export function cardValue(s: GameState, uid: string): number {
  if (!s.uidToCard[uid]) return 0;
  const card = cardOf(s, uid);
  if (card.cardType === "holomen")
    return (
      card.hp * 2 +
      BLOOM_VALUE[card.bloomLevel] * 3 +
      Math.max(0, ...card.arts.map((art) => parseInt(art.power, 10) || 0)) +
      (card.buzz ? 60 : 0)
    );
  if (card.cardType === "support") {
    const descriptionValue = /ドロー|手札に加え|エールを送|回復/.test(
      card.description,
    )
      ? 90
      : 0;
    return 100 + descriptionValue + (card.limited ? 35 : 0);
  }
  if (card.cardType === "yell") return 80;
  return 120;
}

function artCostShortfall(cost: readonly Color[], yells: readonly Color[]) {
  const pool = [...yells];
  let missing = 0;
  for (const color of cost.filter((item) => item !== "無")) {
    const index = pool.indexOf(color);
    if (index >= 0) pool.splice(index, 1);
    else missing++;
  }
  const colorless = cost.filter((item) => item === "無").length;
  missing += Math.max(0, colorless - pool.length);
  return missing;
}

/** この色のエールを1枚付けた時に、アーツへ近づく度合い。 */
export function cheerNeed(
  s: GameState,
  stack: HolomenStack,
  incoming: Color,
): number {
  const yells = stack.yells.map((uid) => {
    const card = cardOf(s, uid);
    return card.cardType === "yell" ? card.color : "無";
  });
  const withIncoming = [...yells, incoming];
  return topCard(s, stack).arts.reduce((best, art) => {
    const before = artCostShortfall(art.cost, yells);
    const after = artCostShortfall(art.cost, withIncoming);
    const unlock = before > 0 && after === 0 ? 1000 : 0;
    return Math.max(
      best,
      unlock + (before - after) * 220 + artPower(s, stack, art),
    );
  }, 0);
}

export function lethal(
  s: GameState,
  attacker: HolomenStack,
  art: ArtData,
  target: HolomenStack,
): boolean {
  return artPower(s, attacker, art, target) >= remainingHp(s, target);
}

// ------------------------------------------------------------
// 盤面評価 (探索AI用)
// shallow: 1手読み (normal) 用の軽量プロファイル
// deep: 複数手先を同じ比較地点まで読む探索 (hard/expert) 用プロファイル
// ------------------------------------------------------------

const WIN_SCORE = 1_000_000;

/** 1手読み用。浅い探索の基準を深い探索の調整から隔離する。 */
const SHALLOW_EVAL_WEIGHTS = {
  life: 1400,
  stack: 1,
  readyArt: 6,
  holoPower: 25,
  deck: 6,
  deckLow: 40,
  cheerDeck: 4,
  deckOut: 2600,
};

/** 複数手先を同じ比較地点まで読む深い探索用。 */
const DEEP_EVAL_WEIGHTS = {
  /** ライフ1枚 (勝利条件そのもの) */
  life: 1800,
  /** ステージ価値 (stackValue) の係数 */
  stack: 1,
  /** 前列で「今すぐコストを支払えるアーツ」の最大打点の係数 */
  readyArt: 3,
  /** 現手番で実際に残っている攻撃機会。ダウンの崖を連続HPと別に見る */
  attackTempo: 1,
  /** ステージ上の頭数。センターダウン後の継戦能力 */
  stageMember: 120,
  /** 控えがいない/1人だけの時の全滅リスク */
  loneStageRisk: 3200,
  thinStageRisk: 900,
  /** ライフ1〜2枚の終盤リスク */
  lowLifeRisk: 700,
  /** センター/コラボに立っていることの盤面テンポ */
  center: 180,
  collab: 110,
  /** ホロパワー1枚 */
  holoPower: 25,
  /** デッキ1枚 (頭打ちにしない: ドローソースの空撃ちでデッキを焼かないため) */
  deck: 6,
  /** デッキ20枚未満の1枚あたり追加ペナルティ (過剰ドローを早めに抑制) */
  deckLow: 70,
  /** 残り7枚以下では、過剰ドローを強く抑止する */
  deckCritical: 500,
  /** 低山札なのに抱えた11枚目以降の手札。使い切れないドローを評価しない */
  lowDeckHandOverflow: 120,
  /** エールデッキ1枚 (将来のエール供給) */
  cheerDeck: 4,
  /** デッキ0枚の危険 (次の自分のドローステップで敗北する) */
  deckOut: 30_000,
};

/** コスト・本文の使用条件・合法な対象を確認する。使用済み履歴は攻撃機会の評価で別に扱う。 */
function readyFrontArts(
  s: GameState,
  pid: PlayerId,
  pos: "center" | "collab",
  stack: HolomenStack,
): ArtData[] {
  return availableArts(s, stack).filter(
    (art) =>
      canPayArtCost(s, stack, art.cost, art.description) &&
      artGateError(s, pid, stack, pos, art) === null &&
      legalArtTargets(s, pid, stack, art).length > 0,
  );
}

/**
 * 現手番で実際に使えるアーツの戦術価値。
 * readyArtだけでは「使用済み」と「この直後にセンターをダウンできる」を
 * 区別できないため、ターン探索の葉で効く不連続な脅威を別に数える。
 */
function attackTempo(s: GameState, pid: PlayerId): number {
  if (
    s.phase !== "playing" ||
    s.turnPlayer !== pid ||
    (s.step !== "main" && s.step !== "performance") ||
    s.prompts.length > 0
  )
    return 0;
  const enemy = s.players[(1 - pid) as PlayerId];
  if (!enemy.center) return 25_000;

  // 通常アーツはセンターだけでなくコラボも対象にできる。旧評価は
  // センター固定だったため、瀕死のコラボを落としてライフを詰める手を
  // 応手探索が過小評価していた。バックは対象拡張条件が複雑なので、
  // ここでは前列2か所のうち、挑発などの対象制限を満たす相手だけを評価する。
  const targets = [
    { pos: "center" as const, stack: enemy.center },
    ...(enemy.collab ? [{ pos: "collab" as const, stack: enemy.collab }] : []),
  ];

  const p = s.players[pid];
  let total = 0;
  for (const [pos, stack] of [
    ["center", p.center],
    ["collab", p.collab],
  ] as const) {
    if (!stack || stack.resting || stack.usedArtsThisTurn) continue;
    if (pos === "center" && p.usedCenterArtThisTurn) continue;
    if (pos === "collab" && p.usedCollabArtThisTurn) continue;
    let best = 0;
    const arts =
      s.step === "performance"
        ? usableArts(s, pos).map((index) => availableArts(s, stack)[index])
        : readyFrontArts(s, pid, pos, stack);
    for (const art of arts) {
      for (const target of targets) {
        if (
          !legalArtTargets(s, pid, stack, art).some(
            (entry) => entry.stack.id === target.stack.id,
          )
        )
          continue;
        const power = artPower(s, stack, art, target.stack);
        let value = power * 4;
        if (power >= remainingHp(s, target.stack)) {
          const lifeOnDown = topCard(s, target.stack).lifeOnDown;
          value +=
            900 + lifeOnDown * 900 + deepStackValue(s, target.stack) * 0.6;
          if (
            enemy.life.length <= lifeOnDown ||
            (target.pos === "center" &&
              !enemy.collab &&
              enemy.back.length === 0)
          )
            value += 25_000;
        }
        best = Math.max(best, value);
      }
    }
    total += best;
  }
  return total;
}

/**
 * 手札1枚の質。枚数だけで数えると「死に札を引き直す」価値を測れないため、
 * ステージと噛み合うかで重み付けする。相手手札のように正体が分からない
 * uidは平均値 (unknown) で数える。
 */
const HAND_CARD = {
  /** 正体不明 (マスクされた相手手札など) の平均値 */
  unknown: 45,
  /** すぐステージへ出せるDebut/Spot (展開の生命線) */
  playable: 60,
  /** ステージの同名ホロメンへいずれBloomできる1st/2nd */
  bloomable: 40,
  /** 今のステージに乗り先がないBloomカード */
  deadBloom: 12,
  /** サポート (個別の効果価値は探索の適用結果が測る) */
  support: 18,
  /** その他 (通常は手札に来ない) */
  other: 30,
};

/** 手札の質の合計 (10枚で頭打ち)。 */
function handQuality(s: GameState, p: PlayerState): number {
  const stageNames = new Set<string>();
  for (const stack of [p.center, p.collab, ...p.back]) {
    if (!stack) continue;
    const top = topCard(s, stack);
    stageNames.add(top.name);
    for (const extra of top.extraNames) stageNames.add(extra);
  }
  let total = 0;
  for (const uid of p.hand.slice(0, 10)) {
    const cardId = s.uidToCard[uid];
    if (!cardId) {
      total += HAND_CARD.unknown;
      continue;
    }
    const card = getCard(cardId);
    if (card.cardType === "holomen")
      total +=
        card.bloomLevel === "Debut" || card.bloomLevel === "Spot"
          ? HAND_CARD.playable
          : stageNames.has(card.name)
            ? HAND_CARD.bloomable
            : HAND_CARD.deadBloom;
    else if (card.cardType === "support") total += HAND_CARD.support;
    else total += HAND_CARD.other;
  }
  return total;
}

export type EvaluationProfile = "shallow" | "deep";

function sideScore(
  s: GameState,
  pid: PlayerId,
  profile: EvaluationProfile,
): number {
  const p = s.players[pid];
  const weights = profile === "deep" ? DEEP_EVAL_WEIGHTS : SHALLOW_EVAL_WEIGHTS;
  let score =
    p.life.length * weights.life +
    handQuality(s, p) +
    p.holoPower.length * weights.holoPower +
    p.deck.length * weights.deck +
    p.cheerDeck.length * weights.cheerDeck;
  if (profile === "deep") {
    if (p.deck.length < 20) {
      score -= (20 - p.deck.length) * DEEP_EVAL_WEIGHTS.deckLow;
      score -=
        Math.max(0, p.hand.length - 10) * DEEP_EVAL_WEIGHTS.lowDeckHandOverflow;
    }
    if (p.deck.length < 8)
      score -= (8 - p.deck.length) * DEEP_EVAL_WEIGHTS.deckCritical;
  } else if (p.deck.length < 10) {
    score -= (10 - p.deck.length) * SHALLOW_EVAL_WEIGHTS.deckLow;
  }
  if (p.deck.length === 0) score -= weights.deckOut;
  const stage = [p.center, p.collab, ...p.back].filter(
    (stack): stack is HolomenStack => !!stack,
  );
  if (profile === "deep") {
    score += stage.length * DEEP_EVAL_WEIGHTS.stageMember;
    if (stage.length === 1) score -= DEEP_EVAL_WEIGHTS.loneStageRisk;
    else if (stage.length === 2) score -= DEEP_EVAL_WEIGHTS.thinStageRisk;
    if (p.life.length < 3)
      score -= (3 - p.life.length) * DEEP_EVAL_WEIGHTS.lowLifeRisk;
  }
  for (const stack of stage) {
    const value =
      profile === "deep" ? deepStackValue(s, stack) : stackValue(s, stack);
    score += value * weights.stack;
  }
  if (profile === "deep") {
    if (p.center) score += DEEP_EVAL_WEIGHTS.center;
    if (p.collab) score += DEEP_EVAL_WEIGHTS.collab;
  }
  // エール投資が実って「実際に撃てる」ようになった前列打点を加点する
  for (const [pos, stack] of [
    ["center", p.center],
    ["collab", p.collab],
  ] as const) {
    if (!stack) continue;
    const ready = readyFrontArts(s, pid, pos, stack).reduce(
      (best, art) => Math.max(best, artPower(s, stack, art)),
      0,
    );
    score += ready * weights.readyArt;
  }
  // attackTempoは複数手先の同じ比較地点を評価するdeepプロファイル専用。
  // 1手読み (shallow) で使うと、アーツ使用後にこの加点が消えるため、
  // 実ダメージを与えるよりendTurnを高く評価する地平線効果が起きる。
  if (profile === "deep")
    score += attackTempo(s, pid) * DEEP_EVAL_WEIGHTS.attackTempo;
  return score;
}

/**
 * seat視点の盤面評価 (自分スコア − 相手スコア)。
 * 探索AIが「候補手を適用した後の状態」同士を比較するために使う。
 * determinize済み状態を前提とし、非公開のデッキ・ライフは枚数だけを見る。
 * 手札は分かる範囲で質を数える (自分の手札は正体既知。相手の手札は
 * determinizeのプレースホルダ = 公開領域から推定した同アーキタイプの近似)。
 */
export function evaluate(
  s: GameState,
  seat: PlayerId,
  profile: EvaluationProfile = "shallow",
): number {
  if (s.phase === "finished") {
    if (s.winner === null) return 0;
    return s.winner === seat ? WIN_SCORE : -WIN_SCORE;
  }
  return (
    sideScore(s, seat, profile) - sideScore(s, (1 - seat) as PlayerId, profile)
  );
}
