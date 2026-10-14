import * as E from "./engine";
import {
  cloneSimulationState,
  type OwnedSimulationState,
} from "./ai/cloneState";
import type {
  GameState,
  JankenHand,
  PlayerId,
  Prompt,
  StagePosition,
} from "./types";

/** ゲーム状態を変更しようとしている主体。観戦者も境界で明示的に扱う。 */
export type GameActor = PlayerId | "spectator";

/**
 * 画面・通信・将来のサーバー実行で共通利用するゲーム操作。
 * 任意関数ではなく純データに限定し、操作主体の検証と記録を可能にする。
 */
export type GameAction =
  | { type: "resolveAnimationDelay" }
  | { type: "resolveLiveStart" }
  | { type: "resolveSetupReveal" }
  | { type: "resolveMulligan"; redraw: boolean }
  | { type: "resolveMulliganPenalty"; uids: string[] }
  | { type: "resolvePlaceCenter"; handUid: string }
  | { type: "resolvePlaceBackOne"; handUid: string }
  | { type: "resolvePlaceBackDone" }
  | { type: "resolveCheerAssign"; pos: StagePosition }
  | { type: "resolveChooseCenter"; backIndex: number }
  | { type: "resolveTriggerAbilityChoice"; id: string }
  | { type: "resolveDamageReplacementChoice"; id: string }
  | { type: "resolveRuleDownChoice"; stackId: number }
  | { type: "resolveRuleAbilityChoice"; id: string }
  | {
      type: "resolveEffectTarget";
      targetPlayer: PlayerId;
      pos: StagePosition;
    }
  | { type: "resolveEffectPickCard"; uids: string[] }
  | { type: "resolveEffectAttach"; pos: StagePosition }
  | { type: "resolveEffectArchiveHand"; uids: string[] }
  | { type: "resolveEffectConfirm"; yes: boolean }
  | { type: "resolveReactiveSkill"; use: boolean }
  | { type: "resolveDeclareDice"; value: number }
  | { type: "resolveJankenHand"; hand: JankenHand }
  | { type: "playHolomen"; handUid: string }
  | { type: "bloom"; handUid: string; pos: StagePosition }
  | { type: "collab"; backIndex: number }
  | { type: "batonTouch"; backIndex: number; yellUids?: string[] }
  | { type: "playSupport"; handUid: string; pos?: StagePosition }
  | {
      type: "useGiftAbility";
      stackId: number;
      index: number;
      supportUid?: string;
      archiveUid?: string;
    }
  | { type: "useOshiSkill"; sp: boolean }
  | {
      type: "useArts";
      fromPos: "center" | "collab";
      artIndex: number;
      targetPos: StagePosition;
    }
  | { type: "goPerformance" }
  | { type: "endTurn" }
  | { type: "concede" };

type GameActionType = GameAction["type"];

const NO_PAYLOAD_ACTIONS = new Set<GameActionType>([
  "resolveAnimationDelay",
  "resolveLiveStart",
  "resolveSetupReveal",
  "resolvePlaceBackDone",
  "goPerformance",
  "endTurn",
  "concede",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSafeIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPlayerId = (value: unknown): value is PlayerId =>
  value === 0 || value === 1;

const isStagePosition = (value: unknown): value is StagePosition =>
  value === "center" ||
  value === "collab" ||
  (isRecord(value) && isSafeIndex(value.back));

const isUid = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

const isUidArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every(isUid) &&
  new Set(value).size === value.length;

function actionUidArray(action: GameAction): string[] | undefined {
  switch (action.type) {
    case "resolveMulliganPenalty":
    case "resolveEffectPickCard":
    case "resolveEffectArchiveHand":
      return action.uids;
    case "batonTouch":
      return action.yellUids;
    default:
      return undefined;
  }
}

/** JSONで届いた値が、実行可能なGameActionの形を満たすか検証する。 */
export function isGameAction(value: unknown): value is GameAction {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const type = value.type as GameActionType;
  if (NO_PAYLOAD_ACTIONS.has(type)) return true;
  switch (type) {
    case "resolveMulligan":
      return typeof value.redraw === "boolean";
    case "resolveMulliganPenalty":
    case "resolveEffectPickCard":
    case "resolveEffectArchiveHand":
      return isUidArray(value.uids);
    case "resolvePlaceCenter":
    case "resolvePlaceBackOne":
    case "playHolomen":
      return isUid(value.handUid);
    case "resolveCheerAssign":
    case "resolveEffectAttach":
      return isStagePosition(value.pos);
    case "resolveChooseCenter":
    case "collab":
      return isSafeIndex(value.backIndex);
    case "resolveTriggerAbilityChoice":
    case "resolveDamageReplacementChoice":
    case "resolveRuleAbilityChoice":
      return isUid(value.id);
    case "resolveRuleDownChoice":
      return isSafeIndex(value.stackId);
    case "resolveEffectTarget":
      return isPlayerId(value.targetPlayer) && isStagePosition(value.pos);
    case "resolveEffectConfirm":
      return typeof value.yes === "boolean";
    case "resolveReactiveSkill":
      return typeof value.use === "boolean";
    case "resolveDeclareDice":
      return isSafeIndex(value.value) && value.value >= 1 && value.value <= 6;
    case "resolveJankenHand":
      return (
        value.hand === "rock" ||
        value.hand === "scissors" ||
        value.hand === "paper"
      );
    case "bloom":
      return isUid(value.handUid) && isStagePosition(value.pos);
    case "batonTouch":
      return (
        isSafeIndex(value.backIndex) &&
        (value.yellUids === undefined || isUidArray(value.yellUids))
      );
    case "playSupport":
      return (
        isUid(value.handUid) &&
        (value.pos === undefined || isStagePosition(value.pos))
      );
    case "useGiftAbility":
      return (
        isSafeIndex(value.stackId) &&
        isSafeIndex(value.index) &&
        (value.supportUid === undefined || isUid(value.supportUid)) &&
        (value.archiveUid === undefined || isUid(value.archiveUid))
      );
    case "useOshiSkill":
      return typeof value.sp === "boolean";
    case "useArts":
      return (
        (value.fromPos === "center" || value.fromPos === "collab") &&
        isSafeIndex(value.artIndex) &&
        isStagePosition(value.targetPos)
      );
    default:
      return false;
  }
}

const PROMPT_TYPE_BY_ACTION: Partial<Record<GameActionType, Prompt["type"]>> = {
  resolveAnimationDelay: "animationDelay",
  resolveLiveStart: "liveStart",
  resolveSetupReveal: "setupReveal",
  resolveMulligan: "mulliganChoice",
  resolveMulliganPenalty: "mulliganPenalty",
  resolvePlaceCenter: "placeCenter",
  resolvePlaceBackOne: "placeBack",
  resolvePlaceBackDone: "placeBack",
  resolveCheerAssign: "cheerAssign",
  resolveChooseCenter: "chooseCenter",
  resolveTriggerAbilityChoice: "triggerAbilityChoice",
  resolveDamageReplacementChoice: "damageReplacementChoice",
  resolveRuleDownChoice: "ruleDownChoice",
  resolveRuleAbilityChoice: "ruleAbilityChoice",
  resolveEffectTarget: "effectTarget",
  resolveEffectPickCard: "effectPickCard",
  resolveEffectAttach: "effectAttach",
  resolveEffectArchiveHand: "effectArchiveHand",
  resolveEffectConfirm: "effectConfirm",
  resolveReactiveSkill: "reactiveSkill",
  resolveDeclareDice: "declareDice",
  resolveJankenHand: "jankenHand",
};

/** 操作主体・フェーズ・手番・入力待ちの共通検証。nullなら実行可能。 */
export function validateGameAction(
  state: GameState,
  actor: GameActor,
  action: GameAction,
): string | null {
  if (actor === "spectator") return "観戦者はゲームを操作できません";
  if (state.phase === "finished") return "ゲームはすでに終了しています";
  const selectedUids = actionUidArray(action);
  if (selectedUids && new Set(selectedUids).size !== selectedUids.length)
    return "同じカードを複数回選ぶことはできません";

  const requiredPromptType = PROMPT_TYPE_BY_ACTION[action.type];
  if (requiredPromptType) {
    const prompt = state.prompts[0];
    if (
      !prompt ||
      prompt.type !== requiredPromptType ||
      prompt.player !== actor
    )
      return "このプレイヤーが解決できる選択ではありません";
    if (action.type === "resolveEffectPickCard") {
      if (prompt.type !== "effectPickCard")
        return "このプレイヤーが解決できる選択ではありません";
      return E.effectPickCardSelectionError(state, actor, prompt, action.uids);
    }
    if (action.type === "resolveEffectArchiveHand") {
      if (prompt.type !== "effectArchiveHand")
        return "このプレイヤーが解決できる選択ではありません";
      return E.effectArchiveHandSelectionError(
        state,
        actor,
        prompt,
        action.uids,
      );
    }
    return null;
  }

  // 投了は進行中なら、自分の手番や入力待ちの有無にかかわらず行える。
  if (action.type === "concede")
    return state.phase === "playing" ? null : "ゲームが進行中ではありません";

  if (state.phase !== "playing") return "ゲームが進行中ではありません";
  if (state.turnPlayer !== actor)
    return "現在はこのプレイヤーの手番ではありません";
  if (state.prompts.length > 0) return "先に選択を解決してください";
  return null;
}

/**
 * カードの物理領域は常に高々1つ。プロンプト/効果コンテキストは移動中カードへの
 * 参照なので数えず、どの物理領域にもない一時保留 (0件) は許可する。
 */
function assertUniquePhysicalCardUids(state: GameState): void {
  // 通常経路では位置説明の文字列を作らない。探索中にも同じ不変条件を検査しつつ、
  // 重複した時だけ下の詳細な診断を実行する。
  const uids: string[] = [];
  for (const p of state.players) {
    uids.push(
      p.oshiUid,
      ...p.deck,
      ...p.cheerDeck,
      ...p.hand,
      ...p.archive,
      ...(p.resolvingSupports ?? []),
      ...p.holoPower,
      ...p.life,
    );
    for (const stack of [p.center, p.collab, ...p.back])
      if (stack) uids.push(...stack.cards, ...stack.yells, ...stack.supports);
  }
  if (new Set(uids).size === uids.length) return;
  diagnoseDuplicatePhysicalCardUids(state);
}

function diagnoseDuplicatePhysicalCardUids(state: GameState): void {
  const seen = new Map<string, string>();
  const add = (uid: string, location: string) => {
    const previous = seen.get(uid);
    if (previous)
      throw new Error(
        `カードUID ${uid} が複数領域に存在します (${previous}, ${location})`,
      );
    seen.set(uid, location);
  };
  for (const player of [0, 1] as const) {
    const p = state.players[player];
    add(p.oshiUid, `P${player}.oshi`);
    for (const zone of [
      "deck",
      "cheerDeck",
      "hand",
      "archive",
      "holoPower",
      "life",
    ] as const)
      p[zone].forEach((uid, index) => add(uid, `P${player}.${zone}[${index}]`));
    p.resolvingSupports?.forEach((uid, index) =>
      add(uid, `P${player}.resolvingSupports[${index}]`),
    );
    for (const [position, stack] of [
      ["center", p.center],
      ["collab", p.collab],
      ...p.back.map((item, index) => [`back[${index}]`, item] as const),
    ] as const) {
      if (!stack) continue;
      stack.cards.forEach((uid, index) =>
        add(uid, `P${player}.${position}.cards[${index}]`),
      );
      stack.yells.forEach((uid, index) =>
        add(uid, `P${player}.${position}.yells[${index}]`),
      );
      stack.supports.forEach((uid, index) =>
        add(uid, `P${player}.${position}.supports[${index}]`),
      );
    }
  }
}

/**
 * 検証済みの操作を複製した状態へ原子的に適用する。
 * 失敗時は元の状態を一切変更せず、成功時だけrevを1進める。
 */
export function applyGameAction(
  state: GameState,
  actor: GameActor,
  action: GameAction,
  simulationRng?: () => number,
): GameState {
  if (simulationRng)
    return E.withGameRandomSource(simulationRng, () =>
      applyCopiedAction(state, actor, action, cloneSimulationState),
    );
  return applyCopiedAction(state, actor, action, structuredClone);
}

/**
 * 探索が占有しているコピーだけを破壊的に進める。通常と同じルール・検証を通す。
 * 例外時のロールバックはしないので、その標本全体を捨てる必要がある。
 * 分岐を試す場合や失敗後も別候補を試す場合は applyGameAction を使う。
 */
export function advanceSimulation(
  state: OwnedSimulationState,
  actor: PlayerId,
  action: GameAction,
  rng: () => number,
): OwnedSimulationState {
  return E.withGameRandomSource(rng, () =>
    applyCopiedAction(state, actor, action, (owned) => owned),
  ) as OwnedSimulationState;
}

function applyCopiedAction(
  state: GameState,
  actor: GameActor,
  action: GameAction,
  copy: (state: GameState) => GameState,
): GameState {
  const validationError = validateGameAction(state, actor, action);
  if (validationError) throw new Error(validationError);
  // validateGameActionが観戦者を拒否することを型システムにも明示する。
  if (actor === "spectator") throw new Error("観戦者はゲームを操作できません");

  const next = copy(state);
  E.observeGameAction(action.type);
  switch (action.type) {
    case "resolveAnimationDelay":
      E.resolveAnimationDelay(next, actor);
      break;
    case "resolveLiveStart":
      E.resolveLiveStart(next, actor);
      break;
    case "resolveSetupReveal":
      E.resolveSetupReveal(next, actor);
      break;
    case "resolveMulligan":
      E.resolveMulligan(next, actor, action.redraw);
      break;
    case "resolveMulliganPenalty":
      E.resolveMulliganPenalty(next, actor, action.uids);
      break;
    case "resolvePlaceCenter":
      E.resolvePlaceCenter(next, actor, action.handUid);
      break;
    case "resolvePlaceBackOne":
      E.resolvePlaceBackOne(next, actor, action.handUid);
      break;
    case "resolvePlaceBackDone":
      E.resolvePlaceBackDone(next, actor);
      break;
    case "resolveCheerAssign":
      E.resolveCheerAssign(next, actor, action.pos);
      break;
    case "resolveChooseCenter":
      E.resolveChooseCenter(next, actor, action.backIndex);
      break;
    case "resolveTriggerAbilityChoice":
      E.resolveTriggerAbilityChoice(next, actor, action.id);
      break;
    case "resolveDamageReplacementChoice":
      E.resolveDamageReplacementChoice(next, actor, action.id);
      break;
    case "resolveRuleDownChoice":
      E.resolveRuleDownChoice(next, actor, action.stackId);
      break;
    case "resolveRuleAbilityChoice":
      E.resolveRuleAbilityChoice(next, actor, action.id);
      break;
    case "resolveEffectTarget":
      E.resolveEffectTarget(next, actor, action.targetPlayer, action.pos);
      break;
    case "resolveEffectPickCard":
      E.resolveEffectPickCard(next, actor, action.uids);
      break;
    case "resolveEffectAttach":
      E.resolveEffectAttach(next, actor, action.pos);
      break;
    case "resolveEffectArchiveHand":
      E.resolveEffectArchiveHand(next, actor, action.uids);
      break;
    case "resolveEffectConfirm":
      E.resolveEffectConfirm(next, actor, action.yes);
      break;
    case "resolveReactiveSkill":
      E.resolveReactiveSkill(next, actor, action.use);
      break;
    case "resolveDeclareDice":
      E.resolveDeclareDice(next, actor, action.value);
      break;
    case "resolveJankenHand":
      E.resolveJankenHand(next, actor, action.hand);
      break;
    case "playHolomen":
      E.playHolomen(next, action.handUid);
      break;
    case "bloom":
      E.bloom(next, action.handUid, action.pos);
      break;
    case "collab":
      E.collab(next, action.backIndex);
      break;
    case "batonTouch":
      E.batonTouch(next, action.backIndex, action.yellUids);
      break;
    case "playSupport":
      E.playSupport(next, action.handUid, action.pos);
      break;
    case "useGiftAbility":
      E.useGiftAbility(
        next,
        action.stackId,
        action.index,
        action.supportUid,
        action.archiveUid,
      );
      break;
    case "useOshiSkill":
      E.useOshiSkill(next, action.sp);
      break;
    case "useArts":
      E.useArts(next, action.fromPos, action.artIndex, action.targetPos);
      break;
    case "goPerformance":
      E.goPerformance(next);
      break;
    case "endTurn":
      E.endTurn(next);
      break;
    case "concede":
      E.concede(next, actor);
      break;
  }
  assertUniquePhysicalCardUids(next);
  next.rev = state.rev + 1;
  return next;
}
