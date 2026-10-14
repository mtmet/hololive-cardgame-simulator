import type { GameState, PlayerId } from "../types";
import type { CandidateMove } from "./legalMoves";
import { MCTS, orderTreeSearch, type TreeSearchConfig } from "./mcts";
import type { AiOptions } from "./types";

/** Master の予算は Expert と独立。テストは反復数だけを縮められる。 */
export const MASTER: TreeSearchConfig = {
  ...MCTS,
  iterations: 2400,
  promptIterations: 960,
  priorDecay: 0.85,
  priorUniform: 0.15,
  widenBase: 8,
  rootHalving: true,
  rootCandidates: 32,
  ownedSimulation: true,
  maxTimeMs: 20_000,
};

export function orderMaster(
  view: GameState,
  seat: PlayerId,
  candidates: readonly CandidateMove[],
  options: AiOptions,
): CandidateMove[] {
  return orderTreeSearch(view, seat, candidates, options, MASTER);
}
