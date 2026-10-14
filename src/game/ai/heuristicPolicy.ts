// ============================================================
// ルールベース方策 (探索なし・評価関数なし)
// 行動種類ごとの固定優先度と手作りの状況ルールだけで候補を並べる。
// - easy難易度の本体
// - 上位難易度の共通部品:
//   探索候補の1次絞り込み (screening)、プレイアウト方策 (rollout)、
//   プロンプト解決のモデル化に使う
// ============================================================
import type { SupportCard } from "../../data/types";
import { applyGameAction, type GameAction } from "../actions";
import {
  availableArts,
  canPayArtCost,
  cardOf,
  getStack,
  topCard,
} from "../engine";
import type {
  GameState,
  HolomenStack,
  PlayerId,
  StagePosition,
} from "../types";
import {
  artPower,
  cardValue,
  cheerNeed,
  lethal,
  maxArtPower,
  remainingHp,
  stackValue,
  threatScore,
} from "./heuristics";
import { enumerateCandidates, type CandidateMove } from "./legalMoves";
import { shuffledBy } from "./types";

/** ステップを進めるだけの手 (盤面アクションと区別する) */
export const PASS_TYPES = new Set<GameAction["type"]>([
  "goPerformance",
  "endTurn",
]);

function other(seat: PlayerId): PlayerId {
  return (1 - seat) as PlayerId;
}

function positionBonus(pos: StagePosition): number {
  return pos === "center" ? 1600 : pos === "collab" ? 1200 : 0;
}

function stackAt(
  view: GameState,
  player: PlayerId,
  pos: StagePosition,
): HolomenStack | null {
  return getStack(view.players[player], pos);
}

function selectedCardValue(view: GameState, uids: readonly string[]): number {
  return uids.reduce((sum, uid) => sum + cardValue(view, uid), 0);
}

function artCandidateScore(
  view: GameState,
  seat: PlayerId,
  fromPos: "center" | "collab",
  artIndex: number,
  targetPos: StagePosition,
): number {
  const attacker = stackAt(view, seat, fromPos);
  const target = stackAt(view, other(seat), targetPos);
  if (!attacker || !target) return -10000;
  const art = availableArts(view, attacker)[artIndex];
  if (!art) return -10000;
  const power = artPower(view, attacker, art, target);
  const downReward = lethal(view, attacker, art, target)
    ? 6000 + topCard(view, target).lifeOnDown * 1800
    : 0;
  return (
    10000 +
    power * 8 +
    threatScore(view, target) +
    downReward +
    (targetPos === "center" ? 900 : 0) +
    (fromPos === "center" ? 250 : 0)
  );
}

function targetScore(
  view: GameState,
  seat: PlayerId,
  player: PlayerId,
  pos: StagePosition,
): number {
  const target = stackAt(view, player, pos);
  if (!target) return -10000;
  const prompt = view.prompts[0];
  if (prompt?.type !== "effectTarget") return stackValue(view, target);
  const apply = prompt.apply;
  const friendly = player === seat;
  if (apply.t === "special")
    return (
      (friendly ? -1 : 1) *
      (threatScore(view, target) +
        (apply.dmg >= remainingHp(view, target) ? 5000 : 0))
    );
  const harmful = new Set([
    "bind",
    "rest",
    "down",
    "toDeckBottom",
    "devolve",
    "turnNoSwitch",
  ]).has(apply.t);
  if (harmful) return (friendly ? -1 : 1) * threatScore(view, target);
  if (apply.t === "heal" || apply.t === "setHp")
    return (
      (friendly ? 1 : -1) * (target.damage * 10 + stackValue(view, target))
    );
  if (apply.t === "activate")
    return (
      (friendly ? 1 : -1) *
      (stackValue(view, target) + (target.resting ? 1000 : 0))
    );
  return (friendly ? 1 : -1) * stackValue(view, target);
}

function promptCardSelectionScore(
  view: GameState,
  uids: readonly string[],
): number {
  const prompt = view.prompts[0];
  if (prompt?.type !== "effectPickCard") return selectedCardValue(view, uids);
  const lowValueDest = new Set(["archive", "deck", "deckBottom", "cheerDeck"]);
  const value = selectedCardValue(view, uids);
  return lowValueDest.has(prompt.dest) ? -value : value;
}

function supportPriority(card: SupportCard): number {
  const helpful = /ドロー|手札に加え|エールを送|回復|サーチ/.test(
    card.description,
  );
  return helpful ? 600 : -7000;
}

function scoreHeuristicAction(
  view: GameState,
  seat: PlayerId,
  action: GameAction,
): number {
  const player = view.players[seat];
  switch (action.type) {
    case "resolveAnimationDelay":
    case "resolveLiveStart":
    case "resolveSetupReveal":
    case "resolveRuleAbilityChoice":
    case "resolveRuleDownChoice":
    case "resolveTriggerAbilityChoice":
    case "resolveDamageReplacementChoice":
      return 0;
    case "resolveMulligan": {
      const hasDebut = player.hand.some((uid) => {
        const card = cardOf(view, uid);
        return card.cardType === "holomen" && card.bloomLevel === "Debut";
      });
      return action.redraw === !hasDebut ? 1000 : 0;
    }
    case "resolveMulliganPenalty":
    case "resolveEffectArchiveHand":
      return -selectedCardValue(view, action.uids);
    case "resolvePlaceCenter":
      return 3000 + cardValue(view, action.handUid);
    case "resolvePlaceBackOne":
      return 2000 + cardValue(view, action.handUid);
    case "resolvePlaceBackDone":
      return 0;
    case "resolveCheerAssign": {
      const targetPlayer =
        view.prompts[0]?.type === "cheerAssign"
          ? (view.prompts[0].targetPlayer ?? seat)
          : seat;
      const target = stackAt(view, targetPlayer, action.pos);
      const prompt = view.prompts[0];
      if (!target || prompt?.type !== "cheerAssign") return -10000;
      const cardId = view.uidToCard[prompt.yellUid];
      const yell = cardId ? cardOf(view, prompt.yellUid) : null;
      const color = yell?.cardType === "yell" ? yell.color : "無";
      return cheerNeed(view, target, color) + positionBonus(action.pos);
    }
    case "resolveChooseCenter": {
      const target = player.back[action.backIndex];
      return target ? stackValue(view, target) : -10000;
    }
    case "resolveEffectTarget":
      return targetScore(view, seat, action.targetPlayer, action.pos);
    case "resolveEffectPickCard":
      return promptCardSelectionScore(view, action.uids);
    case "resolveEffectAttach": {
      const target = stackAt(view, seat, action.pos);
      return target
        ? stackValue(view, target) + positionBonus(action.pos)
        : -10000;
    }
    case "resolveEffectConfirm":
      return action.yes ? 1000 : 0;
    case "resolveReactiveSkill":
      return action.use ? 1000 : 0;
    case "resolveDeclareDice":
      return action.value;
    case "resolveJankenHand":
      return 0;
    case "playHolomen":
      return 8000 + cardValue(view, action.handUid);
    case "bloom": {
      const card = cardOf(view, action.handUid);
      const level = card.cardType === "holomen" ? card.bloomLevel : "Debut";
      const rank = level === "2nd" ? 2 : level === "1st" ? 1 : 0;
      return 9000 + rank * 1000 + positionBonus(action.pos);
    }
    case "collab": {
      const target = player.back[action.backIndex];
      if (!target) return -10000;
      const card = topCard(view, target);
      const canAttack = availableArts(view, target).some((art) =>
        canPayArtCost(view, target, art.cost, art.description),
      );
      const useful = !!card.collabEffect || canAttack;
      return useful ? 6000 + stackValue(view, target) : 500;
    }
    case "batonTouch": {
      const center = player.center;
      const replacement = player.back[action.backIndex];
      if (!center || !replacement) return -10000;
      const opponent = view.players[other(seat)];
      const incoming = [opponent.center, opponent.collab]
        .filter((stack): stack is HolomenStack => !!stack)
        .reduce(
          (best, stack) => Math.max(best, maxArtPower(view, stack, center)),
          0,
        );
      if (incoming < remainingHp(view, center)) return 400;
      return (
        5800 +
        remainingHp(view, replacement) * 8 +
        stackValue(view, replacement) -
        stackValue(view, center) / 2
      );
    }
    case "playSupport": {
      const card = cardOf(view, action.handUid);
      if (card.cardType !== "support") return -10000;
      const target = action.pos ? stackAt(view, seat, action.pos) : null;
      const targetBonus = action.pos ? positionBonus(action.pos) : 0;
      const base = action.pos ? 6500 : 6500 + supportPriority(card);
      return base + (target ? stackValue(view, target) / 10 + targetBonus : 0);
    }
    case "useGiftAbility":
      return 5000;
    case "useOshiSkill":
      return action.sp ? 4700 : 5200;
    case "useArts":
      return artCandidateScore(
        view,
        seat,
        action.fromPos,
        action.artIndex,
        action.targetPos,
      );
    case "goPerformance":
      return 1000;
    case "endTurn":
      return view.step === "performance" ? 0 : -1000;
    case "concede":
      return Number.NEGATIVE_INFINITY;
  }
}

/**
 * ルールベースの選好順。同点はシャッフルで解消する。
 * 採点はプレイアウトの内側ループで何度も呼ばれるため、比較関数の中では
 * なく先に1回だけ計算する (同じ候補を比較のたびに採点し直さない)。
 */
export function orderHeuristic(
  view: GameState,
  seat: PlayerId,
  candidates: readonly CandidateMove[],
  rng: () => number,
): CandidateMove[] {
  const scored = shuffledBy(candidates, rng).map((candidate) => ({
    candidate,
    score: scoreHeuristicAction(view, seat, candidate.action),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.candidate);
}

/** プレイアウト中に解決するプロンプト数の上限 (効果連鎖の暴走保険) */
export const ROLLOUT_PROMPT_LIMIT = 40;

/**
 * 候補適用後に残った入力待ちをルールベース方策で解決しきる
 * (探索内のシミュレーション)。相手の選択 (エール送り先・ダウン処理順等) も
 * 同じ方策でモデル化する。手番アクションは進めない (評価対象は
 * 「この1手」の直接の帰結まで)。状態はすべてdeterminize済みの想像上の
 * ものなので、そのまま観測として渡してよい。
 */
export function rolloutPrompts(state: GameState, rng: () => number): GameState {
  for (
    let step = 0;
    step < ROLLOUT_PROMPT_LIMIT && state.phase !== "finished";
    step++
  ) {
    const prompt = state.prompts[0];
    if (!prompt) break;
    const actor = prompt.player;
    const ordered = orderHeuristic(
      state,
      actor,
      enumerateCandidates(state, actor, rng),
      rng,
    );
    let next: GameState | null = null;
    for (const candidate of ordered) {
      try {
        next = applyGameAction(state, actor, candidate.action, rng);
        break;
      } catch {
        // 近似列挙 (verify付き候補) の不合法分は次善候補で再試行する
      }
    }
    if (!next) break;
    state = next;
  }
  return state;
}
