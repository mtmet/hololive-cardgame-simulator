// ゲーム状態とルールの処理：runtime。
import type { GameState, Prompt } from "../types";
import type { EngineObserver } from "./types";

// ------------------------------------------------------------
// ユーティリティ
// ------------------------------------------------------------

let uidCounter = 0;

let gameRandomSource: () => number = () => Math.random();

export let engineObserver: EngineObserver | null = null;

export function setEngineObserver(observer: EngineObserver | null): void {
  engineObserver = observer;
}

/**
 * 入力待ちを積む唯一の入口。
 * プロンプトの生成箇所は90以上あるので、計装 (どの種類が出たか) と
 * 将来の共通処理をここへ集約する。直接 s.prompts.push() しないこと。
 */
export function pushPrompt(s: GameState, prompt: Prompt): void {
  engineObserver?.prompt?.(prompt.type);
  s.prompts.push(prompt);
}

/** GameAction境界 (actions.ts) から実行されたアクション種別を観測する */
export function observeGameAction(type: string): void {
  engineObserver?.action?.(type);
}

/**
 * 同期処理の間だけゲーム乱数を差し替える。
 * AIがクローン局面を試す時に、実対局のMath.randomを消費しないために使う。
 */
export function withGameRandomSource<T>(rng: () => number, run: () => T): T {
  const previous = gameRandomSource;
  gameRandomSource = rng;
  try {
    return run();
  } finally {
    gameRandomSource = previous;
  }
}

export function gameRandom(): number {
  return gameRandomSource();
}

export function newUid(): string {
  return `u${++uidCounter}`;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(gameRandom() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
