// 盤面の選択状態と引き直し表示の型。
import type { PlayerId, StagePosition } from "../../game/types";

export type Selection =
  | { kind: "hand"; uid: string }
  | { kind: "stack"; player: PlayerId; pos: StagePosition }
  | { kind: "oshi"; player: PlayerId }
  | {
      kind: "support";
      uid: string;
      from: { player: PlayerId; pos: StagePosition };
    }
  | null;

export type MulliganVisualHand = {
  rev: number;
  batchIndex: number;
  uids: string[];
  hiddenUids: Set<string>;
};
