// ゲーム状態とルールの処理：types。
import type { HolomenCard, OshiSkillData } from "../../data/types";
import type { Op, Cond, OshiReactive } from "../effects";
import type { Prompt } from "../types";

/**
 * 実行されたOp・誘発した能力を外から観測するためのフック。
 * 回帰テスト側で「どのOp種別・どのトリガーが一度も走っていないか」を測るためだけの
 * ものなので、既定は無効 (null) で本番の挙動には影響しない。
 */
export interface EngineObserver {
  op?(kind: Op["t"]): void;
  trigger?(event: import("../effects").TriggerEvent): void;
  prompt?(type: Prompt["type"]): void;
  action?(type: string): void;
  /** 評価された条件式の種別 (解析ではなく engine の評価層を通った印) */
  cond?(kind: Cond["c"]): void;
}

export type AnimationSource = {
  sourceStackId?: number;
  sourceUid?: string;
  sourceOshi?: boolean;
};

// ------------------------------------------------------------
// 起動型ギフト能力 (「[ターンにX回]自分のメインステップで(に使える)、〜」)
// ------------------------------------------------------------

export interface GiftAbilityRef {
  stackId: number;
  index: number;
  label: string;
  /** 起動元が付与カード (ツール/マスコット/ファン) の場合、そのカードのuid */
  supportUid?: string;
  /** 起動元がアーカイブのホロメンの場合、そのuid */
  archiveUid?: string;
}

export type GiftAbilityOption = GiftAbilityRef & {
  ok: boolean;
  reason?: string;
};

export interface AvailableArtRef {
  art: HolomenCard["arts"][number];
  /** アーツが印刷されているカードID */
  cardId: string;
  /** そのカード内での印刷上のindex */
  index: number;
}

export type PendingIncomingDamage =
  | Extract<Op, { t: "artDamage" }>
  | Extract<Op, { t: "specialToStack" }>;

export type UsableOshiReactive = {
  reactive: OshiReactive;
  sp: boolean;
  skill: OshiSkillData;
  cost: number;
};

export type DiceOp = Extract<Op, { t: "dice" }>;
