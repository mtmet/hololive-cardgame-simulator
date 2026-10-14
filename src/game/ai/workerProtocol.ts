import type { DeckList, GameState, PlayerId } from "../types";
import type { AiLevel, PlannedMove } from "./types";

/** CPU行動計画Workerへ送るメッセージ。関数を含むAiOptionsは送らずseedからWorker内で作る。 */
export type AiWorkerRequest =
  | {
      type: "configure";
      matchId: number;
      level: AiLevel;
      seed: number;
      /** 相手 (人間側) が使用するデッキリスト。 */
      opponentDeck: DeckList | null;
    }
  | {
      type: "plan";
      matchId: number;
      requestId: number;
      state: GameState;
      seat: PlayerId;
    };

/** CPU行動計画Workerから返る、一手の計画または診断可能なエラー。 */
export type AiWorkerResponse =
  | {
      type: "planned";
      matchId: number;
      requestId: number;
      planned: PlannedMove | null;
    }
  | {
      type: "error";
      matchId: number;
      requestId: number;
      message: string;
    };
