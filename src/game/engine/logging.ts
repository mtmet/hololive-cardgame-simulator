// 対戦ログの追加・保持と、公開範囲・カード操作・効果演出の記録。
import type {
  GameState,
  PlayerId,
  LogEntry,
  DiceResultSummary,
} from "../types";
import { isPublicUid } from "../view";
import { queueFxWaitMarker } from "./animation";
import { cardOf, findStackById } from "./state";
import type { AnimationSource } from "./types";

/** エールは名称のみ、他のカードは同名の別番号を区別できる表示。内部UIDは出さない。 */
export function cardLogLabel(s: GameState, uid: string): string {
  const card = cardOf(s, uid);
  return card.cardType === "yell" ? card.name : `${card.name} (${card.id})`;
}

export function log(
  s: GameState,
  player: PlayerId | null,
  text: string,
  combat?: LogEntry["combat"],
  animation?: LogEntry["animation"],
) {
  appendGameLog(s, player, text, combat, animation);
}

/** 初回・交代・追加ターンを共通の見出しとして記録する。 */
export function logTurnStart(s: GameState) {
  appendGameLog(
    s,
    null,
    `ターン${s.turn}（${s.players[s.turnPlayer].name}）`,
    undefined,
    undefined,
    undefined,
    { turnStart: true },
  );
}

/** 選択者だけが知るカード名を、相手・観戦者向けには一般化して記録する。 */
export function logPrivate(
  s: GameState,
  player: PlayerId,
  privateText: string,
  publicText: string,
) {
  appendGameLog(s, player, privateText, undefined, undefined, undefined, {
    privateTo: player,
    publicText,
  });
}

export function logMulliganRedraw(
  s: GameState,
  player: PlayerId,
  text: string,
  uids: string[],
) {
  appendGameLog(s, player, text, undefined, undefined, {
    kind: "mulligan",
    uids: [...uids],
  });
}

/** 引いた直後の手札末尾を記録する。0枚のときは手札全体を記録しない。 */
export function logDraw(
  s: GameState,
  player: PlayerId,
  text: string,
  count: number,
) {
  appendGameLog(s, player, text, undefined, undefined, {
    kind: "draw",
    uids: count > 0 ? s.players[player].hand.slice(-count) : [],
  });
}

function animationSource(
  s: GameState,
  player: PlayerId,
  source: AnimationSource,
) {
  let sourceCardId: string | undefined;
  if (source.sourceUid) {
    sourceCardId = s.uidToCard[source.sourceUid];
  } else if (source.sourceStackId !== undefined) {
    const entry = findStackById(s, source.sourceStackId);
    const topUid = entry?.stack.cards[0];
    if (topUid) sourceCardId = s.uidToCard[topUid];
  } else if (source.sourceOshi) {
    sourceCardId = s.uidToCard[s.players[player].oshiUid];
  }
  // 発動元が記録時点で公開されていたかを残す。非公開だったカードの実UIDは、
  // 後で公開領域に出た時に過去のログと相関できてしまうため視点ビューで消える。
  const sourcePublic =
    source.sourceUid !== undefined && isPublicUid(s, source.sourceUid)
      ? true
      : undefined;
  return { ...source, sourcePublic, sourceCardId };
}

export function logEffect(
  s: GameState,
  player: PlayerId,
  text: string,
  label: string,
  source: AnimationSource,
) {
  log(s, player, text, undefined, {
    kind: "effect",
    label,
    ...animationSource(s, player, source),
  });
  // 発動バナーの直後に処理が進んで演出が被らないよう、待機を予約する
  queueFxWaitMarker(s, "effect");
}

export function logDice(
  s: GameState,
  player: PlayerId,
  text: string,
  label: string,
  results: number[],
  source: AnimationSource,
  options: {
    versus?: boolean;
    rolledResults?: number[];
    rollId?: number;
    summaries?: DiceResultSummary[];
  } = {},
) {
  log(s, player, text, undefined, {
    kind: "dice",
    label,
    results,
    rolledResults: [...(options.rolledResults ?? results)],
    rollId: options.rollId,
    summaries: options.summaries,
    versus: options.versus || undefined,
    ...animationSource(s, player, source),
  });
}

/**
 * ログは状態同期・永続化・画面描画のすべてに含まれるため、無制限に保持しない。
 * 直近500件あれば、対戦中の確認用途と演出の新着判定には十分な量を確保できる。
 */
export const MAX_GAME_LOG_ENTRIES = 500;

export function appendGameLog(
  state: GameState,
  player: PlayerId | null,
  text: string,
  combat?: LogEntry["combat"],
  animation?: LogEntry["animation"],
  draw?: LogEntry["draw"],
  details?: Pick<LogEntry, "privateTo" | "publicText" | "turnStart">,
) {
  if (state.log.length > 0 && !Number.isSafeInteger(state.log.at(-1)?.id)) {
    state.log = normalizeGameLog(state.log);
  }
  const id = (state.log.at(-1)?.id ?? 0) + 1;
  const entry: LogEntry = { id, turn: state.turn, player, text, ...details };
  if (combat) entry.combat = combat;
  if (animation) entry.animation = animation;
  if (draw) entry.draw = draw;
  state.log.push(entry);
  const overflow = state.log.length - MAX_GAME_LOG_ENTRIES;
  if (overflow > 0) state.log.splice(0, overflow);
}

/** schema 31以前の連番を持たない保存データも、そのまま再開できるようにする。 */
export function normalizeGameLog(log: LogEntry[]): LogEntry[] {
  let lastId = 0;
  const normalized = log.map((entry) => {
    const storedId = Number(entry.id);
    const id =
      Number.isSafeInteger(storedId) && storedId > lastId
        ? storedId
        : lastId + 1;
    lastId = id;
    return entry.id === id ? entry : { ...entry, id };
  });
  return normalized.slice(-MAX_GAME_LOG_ENTRIES);
}
