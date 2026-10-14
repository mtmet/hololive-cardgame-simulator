// ============================================================
// CPU対戦AIの共通型
// game/ai/ はDOM非依存で、ヘッドレス実行環境から直接importできる。
// ============================================================
import type { GameAction } from "../actions";
import type { DeckList } from "../types";

/**
 * 難易度。
 * - easy:   等確率行動 (フルゲームfuzzにも使う)
 * - normal: 最低限のルールベース (探索・評価関数なし)
 * - hard:   評価関数 (determinize + 1手読み)
 * - expert: 情報集合モンテカルロ木探索 (PUCT + プレイアウト)
 * - master: 候補を比較選抜する情報集合木探索
 */
export type AiLevel = "easy" | "normal" | "hard" | "expert" | "master";

export interface AiOptions {
  level: AiLevel;
  /**
   * AI専用のseeded RNG。実対局のシャッフル/サイコロが使う Math.random には
   * 一切触れず、determinizationとクローン局面の仮想乱数だけに使う。
   */
  rng: () => number;
  /**
   * 相手が使用しているデッキリスト (既知の場合)。determinizeの非公開領域
   * 再構成に使う。デッキ順・手札の中身までは知らない。
   */
  opponentDeck?: DeckList | null;
}

export interface PlannedMove {
  action: GameAction;
  /**
   * 前の状態更新から次の操作までの目標間隔ms。
   * UIは計算に使った時間を差し引き、ヘッドレスでは無視してよい。
   */
  delayMs: number;
}

/** 再現可能なAI乱数 (test-bootstrapと同系のmulberry32) */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** rng で配列を複製シャッフルする (Fisher-Yates) */
export function shuffledBy<T>(items: readonly T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
