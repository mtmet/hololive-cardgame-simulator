// ============================================================
// 接続者別のオンライン表示状態
// サーバー内部では完全な状態を保持し、送信時だけ非公開情報を取り除く。
// ゲーム中のマスクは src/game/view.ts (CPU対戦のAI観測と共用) に委譲し、
// ここでは募集中の相手デッキ非公開だけを扱う。
// ============================================================
import { isMatchSetup } from "../src/game/online/protocol";
import type {
  MatchSetupState,
  OnlineRole,
  RoomSyncState,
} from "../src/game/online/protocol";
import { gameViewFor } from "../src/game/view";
import type { DeckList } from "../src/game/types";

const HIDDEN_DECK: DeckList = {
  name: "非公開",
  oshiId: "hidden",
  main: {},
  cheer: {},
};

function setupViewFor(
  state: MatchSetupState,
  viewer: OnlineRole | null,
): MatchSetupState {
  const view = structuredClone(state);
  for (const player of [0, 1] as const) {
    if (viewer === player || !view.entries[player]) continue;
    view.entries[player]!.deck = structuredClone(HIDDEN_DECK);
  }
  return view;
}

/** 接続者が知ってよい範囲だけを含む、送信用の独立した状態を返す。 */
export function roomStateViewFor(
  state: RoomSyncState,
  viewer: OnlineRole | null,
): RoomSyncState {
  return isMatchSetup(state)
    ? setupViewFor(state, viewer)
    : gameViewFor(state, viewer);
}
