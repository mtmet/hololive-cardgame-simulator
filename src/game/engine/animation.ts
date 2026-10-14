// サイコロ表示の共通時間と、効果・演出後の解決待ち。
import type { FxWaitKind, GameState, EffectContextData } from "../types";
import { pushPrompt } from "./runtime";

/** 発動演出 (エフェクトバナー・推しスキル) の後に待つ時間 (UI側の演出時間に対応) */
const FX_RESOLUTION_DELAY_MS: Record<FxWaitKind, number> = {
  effect: 1400,
  oshiSkill: 1500,
  spOshiSkill: 1750,
};

/**
 * 演出待ちはUIがある時だけ意味を持つため、既定では無効。
 * アプリ起動時 (main.tsx) に有効化し、ヘッドレスのテストscriptsでは発火させない。
 */
export let animationWaitsEnabled = false;

export function setAnimationWaitsEnabled(enabled: boolean): void {
  animationWaitsEnabled = enabled;
}

/** サイコロ演出の完了待ちを積む (演出待ち無効時は何もせずfalse) */
export function queueDiceAnimationDelay(
  s: GameState,
  ctx: EffectContextData,
  animationLogId: number,
  resume: boolean,
  count = 1,
): boolean {
  if (!animationWaitsEnabled) return false;
  pushPrompt(s, {
    type: "animationDelay",
    player: ctx.player,
    duration: diceTiming(count).duration,
    animationLogId,
    resume,
    ctx,
  });
  return true;
}

/** 直前のログ (発動バナー等) に対する演出待ちを予約する */
export function queueFxWaitMarker(s: GameState, anim: FxWaitKind) {
  if (!animationWaitsEnabled) return;
  const logId = s.log.at(-1)?.id;
  if (logId === undefined) return;
  s.pendingFxWait = { logId, anim, rev: s.rev };
}

/**
 * 予約済みの演出待ちをanimationDelayプロンプトへ変換する。
 * revが進んだ後に残った予約 (選択待ちを挟んで手遅れになったもの) は破棄する。
 */
export function consumeFxWait(s: GameState, ctx: EffectContextData): boolean {
  const pending = s.pendingFxWait;
  if (!pending) return false;
  s.pendingFxWait = undefined;
  if (pending.rev !== s.rev) return false;
  pushPrompt(s, {
    type: "animationDelay",
    player: ctx.player,
    duration: FX_RESOLUTION_DELAY_MS[pending.anim],
    animationLogId: pending.logId,
    kind: pending.anim,
    resume: true,
    ctx,
  });
  return true;
}

/** サイコロ表示と後続効果の待機が共有する時間。個数が多くても待機は際限なく伸ばさない。 */
export const DICE_ROLL_MS = 720;
export const DICE_RESULT_HOLD_MS = 2000;
export const DICE_EXIT_MS = 180;
export const DICE_REDUCED_MOTION_MS = DICE_RESULT_HOLD_MS;

export function dieStartDelay(index: number): number {
  return Math.min(Math.max(0, index) * 60, 240);
}

export function diceTiming(count: number, reducedMotion = false) {
  const revealAt = reducedMotion ? 0 : DICE_ROLL_MS + dieStartDelay(count - 1);
  return {
    revealAt,
    duration: reducedMotion
      ? DICE_REDUCED_MOTION_MS
      : revealAt + DICE_RESULT_HOLD_MS + DICE_EXIT_MS,
  };
}
