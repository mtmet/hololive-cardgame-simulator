import { getCard } from "../../data/loader";
import type { AiLevel } from "../ai/types";
import type { TurnOrderChoice } from "../ai/setup";
import { parseDecksJson } from "../decks/storage";
import { CPU_RULES_VERSION } from "./rulesVersion";
import type { DeckList, GameState, Prompt } from "../types";
import { gameViewFor } from "../view";

export const CPU_MATCH_STORAGE_KEY = "hololive-cardgame.cpu-match.v1";
export interface CpuMatchConfig {
  playerDeck: DeckList;
  cpuDeck: DeckList;
  level: AiLevel;
  turnOrder: TurnOrderChoice;
  playerDeckRandom?: boolean;
  cpuDeckRandom?: boolean;
}
export interface SavedCpuMatch {
  sessionId: string;
  updatedAt: number;
  config: CpuMatchConfig;
  aiSeed: number;
  game: GameState;
  cardSignatures: Record<string, string>;
}
export interface CpuMatchLoadResult {
  save: SavedCpuMatch | null;
  raw: string | null;
  error: string | null;
}
type MatchStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const source = (storage?: MatchStorage) => storage ?? window.localStorage;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

// 誤った編集・欠損の検出用。暗号化や改ざん防止ではない。
export function cpuSaveChecksum(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
function cardSignature(id: string): string {
  const { imageVariants: _images, ...rules } = getCard(id);
  return cpuSaveChecksum(JSON.stringify(rules));
}
export function cpuMatchCardSignatures(
  game: GameState,
): Record<string, string> {
  return Object.fromEntries(
    [...new Set(Object.values(game.uidToCard))]
      .sort()
      .map((id) => [id, cardSignature(id)]),
  );
}

// 効果の継続情報も含め全状態を保存する。視点用のマスク済み状態は保存しない。
const promptTypes = new Set<Prompt["type"]>([
  "animationDelay",
  "cheerAssign",
  "chooseCenter",
  "damageReplacementChoice",
  "declareDice",
  "effectArchiveHand",
  "effectAttach",
  "effectConfirm",
  "effectPickCard",
  "effectTarget",
  "jankenHand",
  "liveStart",
  "mulliganChoice",
  "mulliganPenalty",
  "placeBack",
  "placeCenter",
  "reactiveSkill",
  "ruleAbilityChoice",
  "ruleDownChoice",
  "setupReveal",
  "triggerAbilityChoice",
]);
function validateSave(value: unknown): asserts value is SavedCpuMatch {
  if (
    !record(value) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    !integer(value.updatedAt) ||
    !integer(value.aiSeed) ||
    value.aiSeed > 0xffffffff ||
    !record(value.config) ||
    !record(value.game) ||
    !record(value.cardSignatures)
  )
    throw new Error("保存データが破損しています。");
  const { config, game } = value;
  if (
    !["easy", "normal", "hard", "expert", "master"].includes(
      String(config.level),
    ) ||
    !["random", "first", "second"].includes(String(config.turnOrder)) ||
    parseDecksJson(JSON.stringify([config.playerDeck, config.cpuDeck])).decks
      .length !== 2
  )
    throw new Error(
      "保存されたデッキや対戦設定を読み込めません。カードデータが変更された可能性があります。",
    );
  if (
    !integer(game.rev) ||
    !integer(game.turn) ||
    !integer(game.nextStackId) ||
    !["setup", "playing", "finished"].includes(String(game.phase)) ||
    !["reset", "draw", "cheer", "main", "performance", "end"].includes(
      String(game.step),
    ) ||
    ![0, 1].includes(game.turnPlayer as number) ||
    ![0, 1].includes(game.firstPlayer as number) ||
    !Array.isArray(game.players) ||
    game.players.length !== 2 ||
    !record(game.uidToCard) ||
    !Array.isArray(game.prompts) ||
    !Array.isArray(game.log) ||
    !Array.isArray(game.turnModifiers) ||
    !record(game.usedTriggersThisTurn) ||
    !Array.isArray(game.extraTurns) ||
    !Array.isArray(game.diceMods) ||
    !Array.isArray(game.skipResetActivate)
  )
    throw new Error("保存された盤面を読み込めません。");
  for (const key of [
    "turnsStarted",
    "downsThisTurn",
    "downsPrevTurn",
    "usedSupportNamesThisTurn",
    "usedSupportTypesThisTurn",
    "usedSupportTagTypesThisTurn",
    "deckArchivedThisTurn",
    "diceRollsThisTurn",
    "stageToDeckThisTurn",
    "stageYellArchivedThisTurn",
    "downedUidsThisTurn",
    "downedUidsPrevTurn",
    "noRestResetNames",
    "artUsesThisTurn",
    "bloomedCardUidsThisTurn",
  ])
    if (!Array.isArray(game[key]) || game[key].length !== 2)
      throw new Error("保存された盤面を読み込めません。");
  for (const prompt of game.prompts)
    if (
      !record(prompt) ||
      !promptTypes.has(prompt.type as Prompt["type"]) ||
      ![0, 1].includes(prompt.player as number)
    )
      throw new Error("保存された効果処理を読み込めません。");
  for (const id of Object.values(game.uidToCard)) {
    if (
      typeof id !== "string" ||
      value.cardSignatures[id] !== cardSignature(id)
    )
      throw new Error(
        "使用カードの内容が更新されています。この対戦は再開できません。",
      );
  }
  const uids = (list: unknown) => {
    if (
      !Array.isArray(list) ||
      list.some(
        (uid) =>
          typeof uid !== "string" ||
          !Object.hasOwn(game.uidToCard as object, uid),
      )
    )
      throw new Error("保存されたカードを読み込めません。");
  };
  for (const player of game.players) {
    if (
      !record(player) ||
      typeof player.name !== "string" ||
      typeof player.oshiUid !== "string" ||
      !Object.hasOwn(game.uidToCard, player.oshiUid) ||
      !Array.isArray(player.back)
    )
      throw new Error("保存されたプレイヤーを読み込めません。");
    for (const key of [
      "deck",
      "cheerDeck",
      "hand",
      "archive",
      "holoPower",
      "life",
    ])
      uids(player[key]);
    if (player.resolvingSupports !== undefined) uids(player.resolvingSupports);
    for (const key of [
      "usedOshiSkillThisTurn",
      "usedSpOshiSkill",
      "usedLimitedThisTurn",
      "usedBatonTouchThisTurn",
      "usedCollabThisTurn",
      "usedCenterArtThisTurn",
      "usedCollabArtThisTurn",
      "voluntaryMulliganDone",
    ])
      if (typeof player[key] !== "boolean")
        throw new Error("保存された使用状況を読み込めません。");
    for (const stack of [player.center, player.collab, ...player.back]) {
      if (stack === null) continue;
      if (
        !record(stack) ||
        !integer(stack.id) ||
        !integer(stack.damage) ||
        !integer(stack.enteredTurn) ||
        ["resting", "faceDown", "bloomedThisTurn", "usedArtsThisTurn"].some(
          (key) => typeof stack[key] !== "boolean",
        )
      )
        throw new Error("保存されたホロメンを読み込めません。");
      for (const key of ["cards", "yells", "supports"]) uids(stack[key]);
    }
  }
  if (game.uidToArtwork !== undefined) {
    if (!record(game.uidToArtwork))
      throw new Error("保存されたイラストを読み込めません。");
    for (const [uid, artwork] of Object.entries(game.uidToArtwork))
      if (
        typeof game.uidToCard[uid] !== "string" ||
        !getCard(game.uidToCard[uid] as string).imageVariants.includes(
          String(artwork),
        )
      )
        throw new Error(
          "使用イラストが見つかりません。この対戦は再開できません。",
        );
  }
  gameViewFor(game as unknown as GameState, 0);
  gameViewFor(game as unknown as GameState, 1);
}

export function loadCpuMatch(storage?: MatchStorage): CpuMatchLoadResult {
  let raw: string | null = null;
  try {
    raw = source(storage).getItem(CPU_MATCH_STORAGE_KEY);
    if (raw === null) return { save: null, raw, error: null };
    const envelope: unknown = JSON.parse(raw);
    if (
      !record(envelope) ||
      envelope.version !== 1 ||
      typeof envelope.payload !== "string" ||
      envelope.checksum !== cpuSaveChecksum(envelope.payload)
    )
      throw new Error("保存データが破損しているか、未対応の形式です。");
    if (envelope.rulesVersion !== CPU_RULES_VERSION)
      throw new Error(
        "対戦ルールが更新されています。この対戦は再開できません。",
      );
    const save: unknown = JSON.parse(envelope.payload);
    validateSave(save);
    return {
      save: save.game.phase === "finished" ? null : save,
      raw,
      error: null,
    };
  } catch (error) {
    return {
      save: null,
      raw,
      error:
        error instanceof Error ? error.message : "保存データを読み込めません。",
    };
  }
}

export class CpuSaveConflictError extends Error {
  constructor() {
    super(
      "別のタブで保存データが変更されました。設定画面から再開してください。",
    );
  }
}
// 以前に読み込んだ内容と一致する場合だけ上書きする。古いタブからの進行で壊さない。
export function writeCpuMatch(
  save: SavedCpuMatch,
  expectedRaw: string | null,
  storage?: MatchStorage,
): string {
  const destination = source(storage);
  if (destination.getItem(CPU_MATCH_STORAGE_KEY) !== expectedRaw)
    throw new CpuSaveConflictError();
  const payload = JSON.stringify(save);
  const raw = JSON.stringify({
    version: 1,
    rulesVersion: CPU_RULES_VERSION,
    checksum: cpuSaveChecksum(payload),
    payload,
  });
  destination.setItem(CPU_MATCH_STORAGE_KEY, raw);
  return raw;
}
export function clearCpuMatch(
  expectedRaw: string | null,
  storage?: MatchStorage,
): void {
  const destination = source(storage);
  if (destination.getItem(CPU_MATCH_STORAGE_KEY) !== expectedRaw)
    throw new CpuSaveConflictError();
  destination.removeItem(CPU_MATCH_STORAGE_KEY);
}
