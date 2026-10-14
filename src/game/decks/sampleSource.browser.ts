import type { DeckList } from "../types";

export let rawSampleDecks: DeckList[] | null = null;
export const sampleDecksReady: Promise<void> = (async () => {
  const response = await fetch("/sample_decks.json", { cache: "no-cache" });
  if (!response.ok)
    throw new Error(
      `サンプルデッキを取得できません (/sample_decks.json: ${response.status})`,
    );
  const data: unknown = await response.json();
  if (!Array.isArray(data))
    throw new Error("サンプルデッキのデータ形式が不正です");
  rawSampleDecks = data as DeckList[];
})();
