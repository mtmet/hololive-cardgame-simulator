import type {
  MatchSetupEntry,
  MatchSetupState,
} from "../../game/online/protocol";

export interface SetupPublishAttempt {
  baseRev: number;
  entryKey: string;
  /** 送信判断に使ったstate。同じrender/effectの二重実行と応答を区別する。 */
  sourceSetup: MatchSetupState | null;
}

export type SetupPublishDecision =
  | { kind: "publish"; attempt: SetupPublishAttempt }
  | { kind: "wait" }
  | { kind: "rejected" };

function sortedCounts(counts: Record<string, number>) {
  return Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  );
}

function sortedArtworkCounts(
  counts: Record<string, Record<string, number>> | undefined,
) {
  return Object.entries(counts ?? {})
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([cardId, variants]) => [cardId, sortedCounts(variants)]);
}

/** オブジェクトの挿入順に依存しない、再送対象entryの比較キー。 */
export function setupEntryKey(entry: MatchSetupEntry): string {
  return JSON.stringify([
    entry.name,
    entry.deck.name,
    entry.deck.oshiId,
    sortedCounts(entry.deck.main),
    sortedCounts(entry.deck.cheer),
    entry.deck.artworks?.oshi ?? null,
    sortedArtworkCounts(entry.deck.artworks?.main),
    sortedArtworkCounts(entry.deck.artworks?.cheer),
  ]);
}

/**
 * 同じstateを元にしたeffectの再実行は待機し、同じrevを持つ新しいサーバーstateが
 * 戻った時だけ拒否と判断する。より新しいrevなら真の競合として再送する。
 */
export function decideSetupPublish(
  previous: SetupPublishAttempt | null,
  setup: MatchSetupState | null,
  entry: MatchSetupEntry,
): SetupPublishDecision {
  const baseRev = setup?.rev ?? 0;
  const entryKey = setupEntryKey(entry);
  if (
    previous === null ||
    previous.baseRev !== baseRev ||
    previous.entryKey !== entryKey
  )
    return {
      kind: "publish",
      attempt: { baseRev, entryKey, sourceSetup: setup },
    };
  if (previous.sourceSetup === setup) return { kind: "wait" };
  return { kind: "rejected" };
}
