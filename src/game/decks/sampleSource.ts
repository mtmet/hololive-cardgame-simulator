import sampleDeckJson from "../../../data/sample_decks.json";
import type { DeckList } from "../types";

// Node / tsxでは既存スクリプトから同期的に利用する。
// ブラウザではViteのaliasで静的JSONを取得する実装に差し替える。
export const rawSampleDecks: DeckList[] | null =
  sampleDeckJson as unknown as DeckList[];
export const sampleDecksReady: Promise<void> = Promise.resolve();
