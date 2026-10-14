// ============================================================
// expert CPU の情報集合モンテカルロ木探索 (IS-MCTS)
//
// 幅を固定せず、有望な枝へ試行を集中させる統計的best-first探索。
// 探索の幅を人が決めないので、同じ計算量を自動的に深い読みへ配分する。
//
// 1. 反復ごとにdeterminizeし直す (SO-ISMCTS)。隠し情報の偏りに強く、
//    枝の合法性の揺れもavailability数で吸収する
// 2. 枝の選択はPUCT。事前確率をルールベース方策の順位から作り、
//    段階的拡張 (progressive widening) で訪問が増えた節点だけ幅を広げる
// 3. 葉はルールベース方策のプレイアウトで進め、木の深さに関係なく
//    「自分のターン + 相手の返し」の同じ絶対ターンで評価する
// 4. 同一ターン内の次の決定では部分木を引き継いで探索を積み増す。
//    探索済みの手順をそのまま再生することはせず、毎回読み直す
//
// 以前の実装は固定幅ビーム + paranoid応手読み (turnSearch.ts) だった。
// 共通の相手 (hard) に対する勝率で 56.5% → 83.3% と明確に上回ったため
// 置き換えた。
// ============================================================
import {
  advanceSimulation,
  applyGameAction,
  type GameAction,
} from "../actions";
import { cloneSimulationState, type OwnedSimulationState } from "./cloneState";
import type { GameState, PlayerId } from "../types";
import { determinize } from "./determinize";
import { evaluate } from "./heuristics";
import { orderHeuristic } from "./heuristicPolicy";
import {
  activeSeatOf,
  enumerateCandidates,
  type CandidateMove,
} from "./legalMoves";
import { findLethalPlan } from "./lethal";
import { mulberry32, type AiOptions } from "./types";

/**
 * 探索量。1反復のコストは「木を降りる適用 + 葉のプレイアウト」で、
 * 木が深まるほどプレイアウトが短くなるため反復あたりの費用は逓減する。
 */
export const MCTS = {
  /** 木を新規に作る決定 (ターンの最初の手など) の反復数 */
  iterations: 1400,
  /** 部分木を引き継いだ決定の追加反復数 */
  reuseIterations: 320,
  /** 引き継ぎに必要な最低訪問数。これ未満なら新規扱いで探索し直す */
  reuseMinVisits: 48,
  /** プロンプト解決だけの決定 (影響が小さく回数が多い) の反復数 */
  promptIterations: 320,
  /** 引き継ぎ時に読み飛ばしてよい演出待ちの最大数 */
  autoResolveGap: 8,
  /** PUCTの探索係数 */
  explore: 1.6,
  /** 事前確率のルールベース順位ごとの減衰率 */
  priorDecay: 0.7,
  /** 段階的拡張の初期幅と成長率 (幅 = base + rate * sqrt(訪問数)) */
  widenBase: 4,
  widenRate: 1.5,
  /** 木で展開する深さの上限 */
  maxDepth: 48,
  /** 葉のプレイアウトで進める手数の上限 */
  rolloutActionLimit: 64,
  /** 未探索の枝を「列挙の近似が外れた候補」と見なす連続失敗回数 */
  failureLimit: 3,
  /** 価値の基準線を作るプレイアウト数 (決定ごとに1回だけ) */
  baselineSamples: 4,
  /** 基準線との差を[-1,1]へ潰す尺度 */
  valueScale: 3500,
  /** 最終手を価値で選ぶ時に信頼する最低訪問割合 (最多訪問比) */
  selectVisitRatio: 0.2,
};

/** Expert と Master で統計・予算を混ぜずに共通の探索器を使う。 */
export type TreeSearchConfig = typeof MCTS & {
  rootHalving?: boolean;
  rootCandidates?: number;
  priorUniform?: number;
  horizonTurns?: number;
  maxTimeMs?: number;
  ownedSimulation?: boolean;
};

/** 選択の余地がない演出待ち。引き継ぎ時にこれだけは読み飛ばせる。 */
const AUTO_RESOLVE_TYPES = new Set<GameAction["type"]>([
  "resolveAnimationDelay",
  "resolveLiveStart",
  "resolveSetupReveal",
]);

interface Edge {
  action: GameAction;
  verify?: boolean;
  /** ルールベース順位から作った事前確率 */
  prior: number;
  visits: number;
  /** seat視点の価値の総和 (相手節点でも符号は反転させず貯める) */
  total: number;
  /** determinizationで合法として現れた回数 (ISMCTSの availability) */
  available: number;
  /**
   * 適用に連続して失敗した回数。determinizationによって合法性が変わるだけの
   * 枝は次の反復で復活させたいので即座には捨てず、成功したら0へ戻す。
   * 上限に達した枝は列挙の近似が外れた候補として選択から外す。
   */
  failures: number;
  child: Node | null;
}

interface Node {
  visits: number;
  /** actionKey → 枝 */
  edges: Map<string, Edge>;
}

/** 同一ターン内で引き継ぐ部分木。AiOptionsは1対局中同じ参照。 */
interface Session {
  seat: PlayerId;
  /** 部分木を作った時点のグローバルターン */
  turn: number;
  /** 部分木を作った時点の観測rev */
  rev: number;
  /** 引き継いだ統計と尺度を揃えるため据え置く価値の基準線 */
  baseline: number;
  root: Node;
}

const sessions = new WeakMap<AiOptions, Session>();
class DiscardSimulation extends Error {}

function actionKey(action: GameAction): string {
  return JSON.stringify(action);
}

function newNode(): Node {
  return { visits: 0, edges: new Map() };
}

function tryApply(
  state: GameState,
  actor: PlayerId,
  action: GameAction,
  rng: () => number,
  config?: TreeSearchConfig,
  verify = false,
): GameState | null {
  try {
    if (config?.ownedSimulation && !verify)
      return advanceSimulation(
        state as OwnedSimulationState,
        actor,
        action,
        rng,
      );
    return applyGameAction(state, actor, action, rng);
  } catch {
    // 所有コピーを直接進めた標本は、途中まで動いた可能性があるため全体を捨てる。
    if (config?.ownedSimulation && !verify) throw new DiscardSimulation();
    // determinize後だけ不合法になる近似候補は、この反復では無かったものとして扱う。
    return null;
  }
}

function rankedCandidates(
  state: GameState,
  actor: PlayerId,
  rng: () => number,
): CandidateMove[] {
  return orderHeuristic(
    state,
    actor,
    enumerateCandidates(state, actor, rng),
    rng,
  );
}

/** ルールベース順位rank (0始まり) の事前確率。合計が1になるよう正規化する。 */
function priorOf(
  rank: number,
  count: number,
  config: TreeSearchConfig,
): number {
  const decay = config.priorDecay;
  const norm = (1 - decay) / (1 - decay ** count);
  const uniform = config.priorUniform ?? 0;
  return (1 - uniform) * decay ** rank * norm + uniform / count;
}

/**
 * 葉の価値。基準線との差を[-1,1]へ潰す。
 *
 * 基準線は「何もせずルールベース方策に任せた場合の到達点」(referenceBaseline)。
 * 盤面の絶対的な優劣ではなく「既定の指し方より良くなったか」を測るため、
 * 値は0付近に集まり、tanhが飽和せず手の差を保てる。q=0を「既定と同等」と
 * 解釈できるので、未訪問の枝の初期評価もそのまま0で済む。
 *
 * ルート局面をそのまま基準線にすると、ルート (自分のメイン中) だけ
 * evaluateのattackTempo項が乗り、葉 (相手ターン明け) には乗らないため、
 * 全葉が一様に大きな負の差を持ってtanhの端に張り付いてしまう。
 * 基準線を葉と同じ地点まで進めることでこのずれをなくす。
 */
function leafValue(
  state: GameState,
  seat: PlayerId,
  baseline: number,
  config: TreeSearchConfig,
): number {
  if (state.phase === "finished")
    return state.winner === null ? 0 : state.winner === seat ? 1 : -1;
  // 終局 (±1) が必ず最上/最下になるよう、非終局は少し内側に収める。
  return (
    0.95 *
    Math.tanh((evaluate(state, seat, "deep") - baseline) / config.valueScale)
  );
}

/**
 * 葉からルールベース方策で進め、stopTurnに達した地点を返す。
 * 木の深さに関係なく同じ絶対ターンで止まるため、全葉の比較地点が揃う。
 */
function rollout(
  state: GameState,
  rng: () => number,
  stopTurn: number,
  config: TreeSearchConfig,
  deadline = Infinity,
): GameState {
  let current = state;
  for (let step = 0; step < config.rolloutActionLimit; step++) {
    if (
      deadline !== Infinity &&
      step % 8 === 0 &&
      performance.now() >= deadline
    )
      break;
    if (current.phase === "finished" || current.turn >= stopTurn) break;
    const actor = activeSeatOf(current);
    if (actor === null) break;
    let next: GameState | null = null;
    for (const candidate of rankedCandidates(current, actor, rng)) {
      next = tryApply(
        current,
        actor,
        candidate.action,
        rng,
        config,
        candidate.verify,
      );
      if (next) break;
    }
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * 価値の基準線。determinizeした局面をルールベース方策のまま葉の地点まで
 * 進め、その評価値を平均する。決定ごとに1回だけ求め、同一ターンで部分木を
 * 引き継ぐ間は引き継いだ統計と尺度を揃えるため据え置く。
 */
function referenceBaseline(
  base: GameState,
  seat: PlayerId,
  options: AiOptions,
  stopTurn: number,
  config: TreeSearchConfig,
  deadline = Infinity,
): number {
  let total = 0;
  let counted = 0;
  let rootTotal = 0;
  for (let sample = 0; sample < config.baselineSamples; sample++) {
    if (performance.now() >= deadline) break;
    const det = determinize(base, seat, options.rng, options.opponentDeck);
    rootTotal += evaluate(det, seat, "deep");
    let settled: GameState;
    try {
      settled = rollout(det, options.rng, stopTurn, config, deadline);
    } catch (error) {
      if (error instanceof DiscardSimulation) continue;
      throw error;
    }
    // 終局した標本は評価値が±WIN_SCOREなので、基準線には数えない。
    if (settled.phase === "finished") continue;
    total += evaluate(settled, seat, "deep");
    counted++;
  }
  // 既定の指し方が必ず決着する局面では、ルート評価値で代用する。
  // どちらへ転ぶ局面でも葉の終局値 (±1) が支配するので影響は小さい。
  return counted > 0 ? total / counted : rootTotal / config.baselineSamples;
}

/**
 * この節点でこの反復に使える枝を返す (無ければ作る)。
 * 段階的拡張により、訪問数が少ない節点ではルールベース上位だけを候補にする。
 */
function edgesFor(
  node: Node,
  ranked: readonly CandidateMove[],
  config: TreeSearchConfig,
): Edge[] {
  const width =
    config.widenBase + Math.floor(config.widenRate * Math.sqrt(node.visits));
  const allowed: Edge[] = [];
  ranked.forEach((candidate, rank) => {
    const key = actionKey(candidate.action);
    let edge = node.edges.get(key);
    if (!edge) {
      if (rank >= width) return;
      edge = {
        action: candidate.action,
        prior: priorOf(rank, ranked.length, config),
        visits: 0,
        total: 0,
        available: 0,
        failures: 0,
        child: null,
      };
      node.edges.set(key, edge);
    } else if (edge.failures >= config.failureLimit && edge.visits === 0)
      return;
    else if (edge.visits === 0 && rank >= width) return;
    // 探索した枝も未探索の枝も、合法として現れた回数を数える (ISMCTS)。
    edge.available++;
    edge.verify = candidate.verify;
    allowed.push(edge);
  });
  return allowed;
}

/** PUCT。actorが自分でなければ、seat視点の価値を反転して最小化する。 */
function selectEdge(
  allowed: readonly Edge[],
  actor: PlayerId,
  seat: PlayerId,
  config: TreeSearchConfig,
): Edge | null {
  const sign = actor === seat ? 1 : -1;
  let best: Edge | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const edge of allowed) {
    // 未訪問はq=0 (価値はルート基準の差なので「変化なし」が中立)。
    const q = edge.visits > 0 ? (sign * edge.total) / edge.visits : 0;
    const score =
      q +
      (config.explore * edge.prior * Math.sqrt(edge.available)) /
        (1 + edge.visits);
    if (score > bestScore) {
      bestScore = score;
      best = edge;
    }
  }
  return best;
}

/**
 * 1反復。木を降りて新しい葉を作り、プレイアウトの価値を経路へ戻す。
 * rootRankedはルート枝の並び (driverが渡した候補) で、深い節点では
 * その局面で列挙し直す。
 */
function simulate(
  root: Node,
  rootState: GameState,
  seat: PlayerId,
  stopTurn: number,
  rootRanked: readonly CandidateMove[],
  baseline: number,
  rng: () => number,
  config: TreeSearchConfig,
  deadline = Infinity,
): void {
  try {
    const visitedNodes: Node[] = [root];
    const visitedEdges: Edge[] = [];
    let node = root;
    let state = config.ownedSimulation
      ? cloneSimulationState(rootState)
      : rootState;

    for (let depth = 0; depth < config.maxDepth; depth++) {
      if (
        deadline !== Infinity &&
        depth % 8 === 0 &&
        performance.now() >= deadline
      )
        return;
      if (state.phase === "finished" || state.turn >= stopTurn) break;
      const actor = activeSeatOf(state);
      if (actor === null) break;
      const ranked =
        depth === 0 ? rootRanked : rankedCandidates(state, actor, rng);
      if (ranked.length === 0) break;

      let allowed = edgesFor(node, ranked, config);
      let chosen: Edge | null = null;
      let advanced: GameState | null = null;
      // 適用に失敗した枝はこの反復だけ外して選び直す。determinizationが違えば
      // 合法になりうるので、枝そのものは残す。
      while (allowed.length > 0) {
        const edge = selectEdge(allowed, actor, seat, config);
        if (!edge) break;
        const next = tryApply(
          state,
          actor,
          edge.action,
          rng,
          config,
          edge.verify,
        );
        if (next) {
          edge.failures = 0;
          chosen = edge;
          advanced = next;
          break;
        }
        edge.failures++;
        allowed = allowed.filter((item) => item !== edge);
      }
      if (!chosen || !advanced) break;

      visitedEdges.push(chosen);
      const expanded = chosen.child === null;
      chosen.child ??= newNode();
      node = chosen.child;
      visitedNodes.push(node);
      state = advanced;
      // 新しい葉を作ったら、そこからはプレイアウトに任せる。
      if (expanded) break;
    }

    const settled = rollout(state, rng, stopTurn, config, deadline);
    // 時間切れで同じターンまで読み切れなかった標本は統計へ混ぜない。
    if (deadline !== Infinity && performance.now() >= deadline) return;
    const value = leafValue(settled, seat, baseline, config);
    for (const visited of visitedNodes) visited.visits++;
    for (const edge of visitedEdges) {
      edge.visits++;
      edge.total += value;
    }
  } catch (error) {
    if (!(error instanceof DiscardSimulation)) throw error;
  }
}

/**
 * 同じ隠しカード配置で各候補を試し、平均値の低い半分を段階的に落とす。
 * 根では prior に任せず全候補へ試行を割り当てる。枝の先は通常の PUCT で
 * 手順・相手の応手を改善するため、単純な定石プレイアウトの比較ではない。
 */
function raceRoot(
  root: Node,
  base: GameState,
  seat: PlayerId,
  stopTurn: number,
  fallback: readonly CandidateMove[],
  baseline: number,
  options: AiOptions,
  config: TreeSearchConfig,
  iterations: number,
  deadline: number,
): CandidateMove[] {
  // 同一カードの別コピーも合法候補としては残すが、初回の探索枠を独占させない。
  const representatives: CandidateMove[] = [];
  const seen = new Set<string>();
  for (const candidate of fallback) {
    const key = JSON.stringify(candidate.action, (field, value: unknown) =>
      field === "handUid" && typeof value === "string"
        ? (base.uidToCard[value] ?? value)
        : value,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    representatives.push(candidate);
  }
  const limit = config.rootCandidates ?? 32;
  // 種類ごとに1手は残し、Bloomや付与先の多さで交代・スキル・パスを締め出さない。
  const kinds = new Set<GameAction["type"]>();
  const diverse = representatives.filter((candidate) => {
    if (kinds.has(candidate.action.type)) return false;
    kinds.add(candidate.action.type);
    return true;
  });
  const selected = new Set(diverse);
  for (const candidate of representatives) {
    if (selected.size >= limit) break;
    selected.add(candidate);
  }
  let alive = representatives.filter((candidate) => selected.has(candidate));
  const eliminated: CandidateMove[] = [];
  let remaining = iterations;
  const score = (candidate: CandidateMove): number => {
    const edge = root.edges.get(actionKey(candidate.action));
    return edge?.visits ? edge.total / edge.visits : -Infinity;
  };
  while (alive.length > 0 && remaining >= alive.length) {
    const rounds = Math.max(1, Math.ceil(Math.log2(alive.length)));
    const samples = Math.max(
      1,
      Math.floor(remaining / (rounds * alive.length)),
    );
    for (let sample = 0; sample < samples; sample++) {
      if (performance.now() >= deadline) break;
      const det = determinize(base, seat, options.rng, options.opponentDeck);
      const seed = Math.floor(options.rng() * 0x1_0000_0000);
      for (const candidate of alive) {
        if (performance.now() >= deadline) break;
        simulate(
          root,
          det,
          seat,
          stopTurn,
          [candidate],
          baseline,
          mulberry32(seed),
          config,
          deadline,
        );
        remaining--;
      }
    }
    alive.sort((a, b) => score(b) - score(a));
    if (performance.now() >= deadline || alive.length <= 2) break;
    eliminated.unshift(...alive.splice(Math.ceil(alive.length / 2)));
  }
  const searched = new Set([...alive, ...eliminated]);
  return [
    ...alive,
    ...eliminated,
    ...fallback.filter((candidate) => !searched.has(candidate)),
  ];
}

/**
 * 引き継いだ節点の枝を、今回driverが渡した候補だけに絞る。
 * プロンプトの組合せ候補 (pickSamples) は列挙のたびに変わるため、
 * 実局面に無い枝を残すと選べない手を推してしまう。
 */
function pruneToCandidates(
  node: Node,
  candidates: readonly CandidateMove[],
): void {
  const keys = new Set(
    candidates.map((candidate) => actionKey(candidate.action)),
  );
  let visits = 0;
  for (const [key, edge] of [...node.edges]) {
    if (!keys.has(key)) {
      node.edges.delete(key);
      continue;
    }
    visits += edge.visits;
  }
  node.visits = visits;
}

/**
 * 前回の決定で残した部分木のうち、今の観測に対応する節点を返す。
 *
 * 引き継げるのは「前回の推奨手がそのまま適用された」と確信できる時だけ。
 * driverは順序の先頭でverify不要な候補を無検証で採用するため、前回の
 * 先頭手がverify不要だったなら、実局面でもそれが適用されている。
 * revの差から、その後に挟まった演出待ちの解決だけを読み飛ばす。
 */
function reusableRoot(
  options: AiOptions,
  view: GameState,
  seat: PlayerId,
): { root: Node; baseline: number } | null {
  const session = sessions.get(options);
  sessions.delete(options);
  if (!session || session.seat !== seat || session.turn !== view.turn)
    return null;
  const gap = view.rev - session.rev - 1;
  if (gap < 0 || gap > MCTS.autoResolveGap) return null;

  let node = session.root;
  for (let step = 0; step < gap; step++) {
    const edges = [...node.edges.values()];
    if (edges.length !== 1) return null;
    const [edge] = edges;
    if (!AUTO_RESOLVE_TYPES.has(edge.action.type) || !edge.child) return null;
    node = edge.child;
  }
  return { root: node, baseline: session.baseline };
}

/**
 * expert: 候補を情報集合MCTSの結果順に並べる。
 * 探索しなかった候補はルールベース順のまま後置し、driverの検証で
 * 先頭が不合法だった場合のフォールバックとして機能させる。
 */
export function orderMcts(
  view: GameState,
  seat: PlayerId,
  candidates: readonly CandidateMove[],
  options: AiOptions,
): CandidateMove[] {
  return orderTreeSearch(view, seat, candidates, options, MCTS);
}

export function orderTreeSearch(
  view: GameState,
  seat: PlayerId,
  candidates: readonly CandidateMove[],
  options: AiOptions,
  config: TreeSearchConfig,
): CandidateMove[] {
  const deadline = performance.now() + (config.maxTimeMs ?? Infinity);
  if (config.rootHalving) sessions.delete(options);
  const fallback = orderHeuristic(view, seat, candidates, options.rng);

  // 確定リーサルは探索せず即答する (保守的な確定打点だけを見るソルバー)。
  const lethalPlan = findLethalPlan(view, seat);
  if (lethalPlan?.[0]) {
    sessions.delete(options);
    const key = actionKey(lethalPlan[0]);
    const lethalMove = candidates.find(
      (candidate) => actionKey(candidate.action) === key,
    );
    if (lethalMove)
      return [lethalMove, ...fallback.filter((item) => item !== lethalMove)];
  }

  // 選択の余地がない局面と、盤面評価の材料が乏しいゲーム準備中は探索しない。
  if (fallback.length <= 1 || view.phase !== "playing") {
    sessions.delete(options);
    return fallback;
  }

  const reused = config.rootHalving ? null : reusableRoot(options, view, seat);
  const root = reused?.root ?? newNode();
  if (reused) pruneToCandidates(root, candidates);
  const carried = reused && root.visits >= config.reuseMinVisits;
  const iterations = carried
    ? config.reuseIterations
    : view.prompts.length > 0
      ? config.promptIterations
      : config.iterations;

  // 「自分のターン + 相手の返し」を読む。ログは評価に関与せず
  // クローンコストだけ増やすので空にする。
  const stopTurn = view.turn + (config.horizonTurns ?? 2);
  const base: GameState = { ...view, log: [] };
  // 引き継いだ統計は前回の基準線で貯まっているので、尺度を揃えて据え置く。
  const baseline = carried
    ? reused.baseline
    : referenceBaseline(base, seat, options, stopTurn, config, deadline);
  if (config.rootHalving) {
    return raceRoot(
      root,
      base,
      seat,
      stopTurn,
      fallback,
      baseline,
      options,
      config,
      iterations,
      deadline,
    );
  } else
    for (let iteration = 0; iteration < iterations; iteration++) {
      const det = determinize(base, seat, options.rng, options.opponentDeck);
      simulate(
        root,
        det,
        seat,
        stopTurn,
        fallback,
        baseline,
        options.rng,
        config,
      );
    }

  // 枝を実候補へ戻す。ルート枝はdriverの候補から作ったので必ず対応が付く。
  const byKey = new Map<string, CandidateMove>();
  for (const candidate of fallback) {
    const key = actionKey(candidate.action);
    if (!byKey.has(key)) byKey.set(key, candidate);
  }
  const entries: { edge: Edge; candidate: CandidateMove }[] = [];
  for (const [key, edge] of root.edges) {
    const candidate = byKey.get(key);
    if (candidate) entries.push({ edge, candidate });
  }

  // 最多訪問の一定割合以上を集めた枝だけを信頼し、その中の最良平均を採る。
  // 純粋な最多訪問だと、反復数が少ない決定で事前確率 (=ルールベースの
  // 好み) がそのまま残り、探索が見つけた手を捨ててしまう。
  const maxVisits = entries.reduce(
    (best, entry) => Math.max(best, entry.edge.visits),
    0,
  );
  const threshold = Math.max(2, maxVisits * config.selectVisitRatio);
  const trusted = entries.filter((entry) => entry.edge.visits >= threshold);
  const ranked = (trusted.length > 0 ? trusted : entries)
    .filter((entry) => entry.edge.visits > 0)
    .sort(
      (a, b) => b.edge.total / b.edge.visits - a.edge.total / a.edge.visits,
    );

  const searched = new Set(ranked.map((entry) => entry.candidate));
  const order = [
    ...ranked.map((entry) => entry.candidate),
    ...fallback.filter((candidate) => !searched.has(candidate)),
  ];

  // 次の決定へ部分木を引き継ぐ。先頭手がverify必須なら、driverが別の手を
  // 採用する可能性があるので引き継がない。
  const top = ranked[0];
  if (!config.rootHalving && top && !top.candidate.verify && top.edge.child)
    sessions.set(options, {
      seat,
      turn: view.turn,
      rev: view.rev,
      baseline,
      root: top.edge.child,
    });
  return order;
}
