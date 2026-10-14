// 公開API。実装は役割別モジュールへ配置し、呼び出し元の参照先を維持する。
export type {
  CardFilter,
  StackTarget,
  TargetFilter,
  Cond,
  TriggerAbility,
  Op,
  DiceBranch,
  EffectProgram,
  PassiveCondition,
  TriggerEvent,
  TriggerDef,
  DamageTakenMod,
  PassiveBonus,
  ArtCostMod,
  ArtGate,
  GiftAura,
  GiftDef,
  OshiReactive,
  OshiConditional,
  PlayCondition,
  SupportUseLimit,
} from "./effects/types";
export {
  isOshiStageSkillSupported,
  parseOshiReactive,
  parseOshiConditional,
  parseOshiAdditionalCost,
} from "./effects/oshi";
export { parseCardFilter } from "./effects/filters";
export { parseArtCostMods, parseArtGates } from "./effects/costs";
export { parseEffect } from "./effects/compound";
export { parseGift } from "./effects/gifts";
export { parsePassive } from "./effects/passive";
export {
  parseSupportUseLimit,
  parseBloomEffectUseLimit,
  parsePlayConditions,
} from "./effects/limits";
