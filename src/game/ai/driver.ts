// ============================================================
// CPUの進行ドライバ
// 「今この状態でCPU席が取るべき1手」を決める純関数。
// UI (LocalApp) はdelayMsを操作間隔の目標値として計算時間を差し引き、
// 残り時間後に適用する。ヘッドレステストは即時適用する。
// 状態を変更せず、revが進むたびに呼び直される前提。
// ============================================================
import type { GameState, PlayerId } from "../types";
import { gameViewFor } from "../view";
import { activeSeatOf, enumerateCandidates, tryAction } from "./legalMoves";
import { orderCandidates } from "./policy";
import type { AiOptions, PlannedMove } from "./types";

export { activeSeatOf } from "./legalMoves";

/**
 * プロンプト応答・1手いずれも共通の操作間隔の目標値 (全難易度共通)。
 * 800〜1200msの範囲で毎回ランダムに振る。
 * LocalAppがこの目標から計算時間を差し引くため、思考が長ければ待機は短くなり、
 * 目標を超えた場合は待機なしで即適用する。
 */
const ACTION_INTERVAL_MIN_MS = 800;
const ACTION_INTERVAL_MAX_MS = 1200;

function describeSituation(s: GameState, seat: PlayerId): string {
  const prompt = s.prompts[0];
  return (
    `seat=${seat} turn=${s.turn} step=${s.step} phase=${s.phase}` +
    (prompt ? ` prompt=${prompt.type}` : " prompt=none")
  );
}

/**
 * CPU席の次の一手を計画する。CPUが行動する局面でなければ null。
 * 合法手が見つからない場合は例外 (フルゲームfuzzで検出する想定の異常系)。
 */
export function planCpuMove(
  s: GameState,
  seat: PlayerId,
  options: AiOptions,
): PlannedMove | null {
  if (activeSeatOf(s) !== seat) return null;
  const prompt = s.prompts[0];

  // 演出待ちプロンプトは選択の余地がなく、人間側の演出時間だけ待って解決する
  if (prompt?.type === "animationDelay")
    return {
      action: { type: "resolveAnimationDelay" },
      delayMs: prompt.duration,
    };
  if (prompt?.type === "liveStart")
    return {
      action: { type: "resolveLiveStart" },
      delayMs: prompt.duration,
    };
  if (prompt?.type === "setupReveal")
    return {
      action: { type: "resolveSetupReveal" },
      delayMs: prompt.duration,
    };

  const candidates = enumerateCandidates(s, seat, options.rng);
  if (candidates.length === 0)
    throw new Error(`CPUの合法手がありません (${describeSituation(s, seat)})`);

  // 方策は非公開情報を除いた観測だけで並べ替える (カンニング防止)。
  // randomは観測を読まないため、ビュー生成は遅延させる。
  let cachedView: GameState | null = null;
  const getView = () => (cachedView ??= gameViewFor(s, seat));
  const ordered = orderCandidates(getView, seat, candidates, options);

  const targetIntervalMs =
    ACTION_INTERVAL_MIN_MS +
    Math.floor(
      options.rng() * (ACTION_INTERVAL_MAX_MS - ACTION_INTERVAL_MIN_MS),
    );
  for (const candidate of ordered)
    if (!candidate.verify || tryAction(s, seat, candidate.action))
      return { action: candidate.action, delayMs: targetIntervalMs };

  throw new Error(
    `CPUの候補がすべて不合法でした (${describeSituation(s, seat)})`,
  );
}
