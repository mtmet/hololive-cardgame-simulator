// ============================================================
// CPUの意思決定 (難易度別ディスパッチ)
// 候補の「順序付け」だけを行い、合法性の最終確認はdriverが行う。
// - easy:   等確率 (フルゲームfuzzにも使う)
// - normal: ルールベース (探索・評価関数なし)
// - hard:   評価関数 (determinize + 1手読み)
// - expert: 情報集合モンテカルロ木探索 (PUCT + プレイアウト)
// ============================================================
import { applyGameAction, type GameAction } from "../actions";
import type { GameState, PlayerId } from "../types";
import { determinize } from "./determinize";
import { evaluate } from "./heuristics";
import { orderHeuristic, PASS_TYPES, rolloutPrompts } from "./heuristicPolicy";
import type { CandidateMove } from "./legalMoves";
import { orderMcts } from "./mcts";
import { orderMaster } from "./master";
import { shuffledBy, type AiOptions } from "./types";

/**
 * 候補を選好順に並べ替える。driverは先頭から検証し、最初に通った手を採用する。
 * getView は非公開情報を除いた観測 (gameViewFor)。easyは使用しないため
 * 遅延評価にしてクローンコストを避ける。
 */
export function orderCandidates(
  getView: () => GameState,
  seat: PlayerId,
  candidates: readonly CandidateMove[],
  options: AiOptions,
): CandidateMove[] {
  // 先行入力は非公開なので、探索で推測して偏らせず等確率で選ぶ。
  if (
    candidates.every(
      (candidate) => candidate.action.type === "resolveJankenHand",
    )
  )
    return shuffledBy(candidates, options.rng);
  switch (options.level) {
    case "master":
      return orderMaster(getView(), seat, candidates, options);
    case "easy":
      return orderRandom(candidates, options.rng);
    case "normal":
      return orderHeuristic(getView(), seat, candidates, options.rng);
    case "hard":
      return orderEvaluated(getView(), seat, candidates, options);
    case "expert":
      // 1手読みの1次評価は挟まず、ルールベース順位を事前確率として
      // 木探索へ直接渡す (順位付けは探索の統計が決める)。
      return orderMcts(getView(), seat, candidates, options);
  }
}

function orderRandom(
  candidates: readonly CandidateMove[],
  rng: () => number,
): CandidateMove[] {
  const shuffled = shuffledBy(candidates, rng);
  const active = shuffled.filter((c) => !PASS_TYPES.has(c.action.type));
  const passes = shuffled.filter((c) => PASS_TYPES.has(c.action.type));
  // 8割は盤面アクションを優先し、2割でステップを進める (進行性と網羅性の両立)
  if (active.length > 0 && rng() >= 0.2) return [...active, ...passes];
  return [...passes, ...active];
}

// ------------------------------------------------------------
// hard: 評価関数 (determinization + 1手読み)
// ------------------------------------------------------------

/**
 * hard探索の予算。1決定あたりの候補適用は topCandidates × samples 回
 * (+プロンプト解決のrollout) に収め、UIの思考時間 (〜1秒) 内で終わらせる。
 */
const EVAL_SEARCH = {
  /** ルールベース順位の上位何件を探索対象にするか */
  topCandidates: 8,
  /** determinizationのサンプル数 (サイコロ等の乱数もこの平均で吸収する) */
  samples: 4,
};

/**
 * hard: 候補手をdeterminizeした状態のクローンへ試行適用し、適用後の
 * 盤面評価 (evaluate) のサンプル平均で採点して並べ替える。
 * - 探索対象はルールベース順位の上位だけに絞る (性能制御)。残りは順位のまま
 *   後置し、driverの検証で先頭が不合法だった場合のフォールバックとして
 *   機能させる
 * - 真の状態は一切参照しない (情報公平性)。1サンプル内は同じdeterminize
 *   結果を全候補で共有し、候補間の比較条件を揃える
 * - パス (goPerformance/endTurn) は探索で採点しない。endTurnの適用結果には
 *   相手のターン開始利得 (ドロー・エール) が必ず含まれ、どの行動列でも
 *   避けられないその損を「パスだけ」が背負って不当に沈む。代わりにパスを
 *   中立スコアの位置に置き、能動手は「盤面を良くする時だけ」先行させる
 *   (何もしないより悪い手でデッキや手札を焼く暴走の防止)
 */
function orderEvaluated(
  view: GameState,
  seat: PlayerId,
  candidates: readonly CandidateMove[],
  options: AiOptions,
): CandidateMove[] {
  const { rng } = options;
  const prelim = orderHeuristic(view, seat, candidates, rng);
  // 単一候補は探索不要。ゲーム準備中は盤面評価の材料が乏しくルールベースで十分
  if (prelim.length <= 1 || view.phase !== "playing") return prelim;
  const actives = prelim.filter((c) => !PASS_TYPES.has(c.action.type));
  const passes = prelim.filter((c) => PASS_TYPES.has(c.action.type));
  const searched = actives.slice(0, EVAL_SEARCH.topCandidates);
  const restActives = actives.slice(EVAL_SEARCH.topCandidates);
  if (searched.length === 0) return prelim;

  // ログは評価に関与せず、rollout中のクローンコストだけ増やすので空にする
  const base: GameState = { ...view, log: [] };
  const totals = new Map<CandidateMove, number>();
  let neutralTotal = 0;
  for (let sample = 0; sample < EVAL_SEARCH.samples; sample++) {
    const det = determinize(base, seat, rng, options.opponentDeck);
    // 真の状態では合法でもdeterminize後は不合法になりうる (稀)。
    // その場合は「盤面が動かなかった」中立スコアで扱う
    const neutral = evaluate(det, seat);
    neutralTotal += neutral;
    for (const candidate of searched) {
      let score = neutral;
      try {
        const next = applyGameAction(det, seat, candidate.action, rng);
        score = evaluate(rolloutPrompts(next, rng), seat);
      } catch {
        // 中立スコアのまま
      }
      totals.set(candidate, (totals.get(candidate) ?? 0) + score);
    }
  }
  const scoreOf = (candidate: CandidateMove) => totals.get(candidate) ?? 0;
  const sorted = [...searched].sort((a, b) => scoreOf(b) - scoreOf(a));
  const above = sorted.filter((c) => scoreOf(c) > neutralTotal);
  const belowOrEqual = sorted.filter((c) => scoreOf(c) <= neutralTotal);
  // 盤面を良くする手 → パス → その他 (プロンプト解決にはパスが無いので
  // 単純に採点順になる)。restActivesはルールベース順のまま最後尾へ
  return [...above, ...passes, ...belowOrEqual, ...restActives];
}
