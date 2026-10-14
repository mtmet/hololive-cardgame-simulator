// ============================================================
// オンライン対戦のリレープロトコル (クライアント/サーバー共有)
// 募集中は各席のエントリを同期し、対戦開始後はサーバーがGameActionを
// 検証・実行して確定GameStateを配信する。
// ============================================================
import type { GameAction } from "../actions";
import type { DeckList, GameState, PlayerId } from "../types";

/** 参加ロール。席 (0/1) は部屋ごとに先着1名、観戦は部屋の接続上限内 */
export type OnlineRole = PlayerId | "spectator";

/** 席を指定しないプレイヤー参加要求を含む、クライアント側の参加指定 */
export type OnlineClaimRole = OnlineRole | "player";

/** 席の占有状況 (index = PlayerId) */
export type SeatsTaken = [boolean, boolean];

export const ROOM_CODE_MAX_LENGTH = 128;
export const RESUME_TOKEN_MIN_LENGTH = 20;
export const RESUME_TOKEN_MAX_LENGTH = 256;

export type RoomCodeValidation =
  | { ok: true; room: string }
  | { ok: false; reason: "required" | "tooLong" };

/**
 * URL・入力フォーム・通信境界で共有する部屋コード規則。
 * 上限は送信前のraw文字列に適用し、成功時だけtrim済みの部屋名を返す。
 */
export function validateRoomCode(value: string): RoomCodeValidation {
  const room = value.trim();
  if (room.length === 0) return { ok: false, reason: "required" };
  if (value.length > ROOM_CODE_MAX_LENGTH)
    return { ok: false, reason: "tooLong" };
  return { ok: true, room };
}

/** リレーと同じ再接続トークンの構造検証。 */
export function isValidResumeToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= RESUME_TOKEN_MIN_LENGTH &&
    value.length <= RESUME_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** 募集中の席エントリ (その席のプレイヤーが自分で選んだ名前とデッキ) */
export interface MatchSetupEntry {
  name: string;
  deck: DeckList;
}

/**
 * ゲーム開始前の募集状態。各プレイヤーが後から自分のデッキを選んで
 * 参加し、両席がそろった時点で GameState に置き換わる。
 */
export interface MatchSetupState {
  /** GameState と見分けるための判別子 */
  kind: "matchSetup";
  rev: number;
  entries: [MatchSetupEntry | null, MatchSetupEntry | null];
}

/** 部屋で同期する状態 (募集中 or 対戦中) */
export type RoomSyncState = GameState | MatchSetupState;

const isCardCounts = (value: unknown): value is Record<string, number> =>
  typeof value === "object" &&
  value !== null &&
  Object.entries(value).length <= 500 &&
  Object.entries(value).every(
    ([cardId, count]) =>
      cardId.length > 0 &&
      cardId.length <= 128 &&
      typeof count === "number" &&
      Number.isSafeInteger(count) &&
      count >= 0 &&
      count <= 100,
  );

const isArtworkCounts = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.entries(value).length <= 500 &&
  Object.entries(value).every(
    ([cardId, variants]) =>
      cardId.length > 0 &&
      cardId.length <= 128 &&
      typeof variants === "object" &&
      variants !== null &&
      Object.entries(variants).length <= 32 &&
      Object.entries(variants).every(
        ([artworkKey, count]) =>
          artworkKey.length > 0 &&
          artworkKey.length <= 256 &&
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count > 0 &&
          count <= 100,
      ),
  );

const isDeckArtworks = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const artworks = value as Record<string, unknown>;
  return (
    (artworks.oshi === undefined ||
      (typeof artworks.oshi === "string" && artworks.oshi.length <= 256)) &&
    (artworks.main === undefined || isArtworkCounts(artworks.main)) &&
    (artworks.cheer === undefined || isArtworkCounts(artworks.cheer))
  );
};

export function isMatchSetup(state: unknown): state is MatchSetupState {
  if (typeof state !== "object" || state === null) return false;
  const value = state as Record<string, unknown>;
  if (
    value.kind !== "matchSetup" ||
    typeof value.rev !== "number" ||
    !Number.isSafeInteger(value.rev) ||
    value.rev < 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length !== 2
  )
    return false;
  return value.entries.every((entry) => {
    if (entry === null) return true;
    if (typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.name !== "string" ||
      candidate.name.trim().length === 0 ||
      candidate.name.length > 40 ||
      typeof candidate.deck !== "object" ||
      candidate.deck === null
    )
      return false;
    const deck = candidate.deck as Record<string, unknown>;
    return (
      typeof deck.name === "string" &&
      deck.name.trim().length > 0 &&
      deck.name.length <= 128 &&
      typeof deck.oshiId === "string" &&
      deck.oshiId.length > 0 &&
      deck.oshiId.length <= 128 &&
      isCardCounts(deck.main) &&
      isCardCounts(deck.cheer) &&
      (deck.artworks === undefined || isDeckArtworks(deck.artworks))
    );
  });
}

/** クライアント → リレー */
export type ClientMessage =
  | { t: "join"; room: string; resumeToken?: string }
  | { t: "claim"; role: OnlineClaimRole }
  | { t: "state"; baseRev: number; state: MatchSetupState }
  | { t: "action"; baseRev: number; action: GameAction }
  | { t: "reset" };

/** リレー → クライアント */
export type ServerMessage =
  | {
      t: "welcome";
      state: RoomSyncState | null;
      seats: SeatsTaken;
      /** 再接続トークンで復帰できた実席。通常入室はnull */
      role: OnlineRole | null;
      /** 復帰した実席のトークン。観戦・未着席には送らない */
      resumeToken?: string;
    }
  | {
      t: "claimResult";
      ok: boolean;
      /** 成功時は実際に割り当てた席/観戦、失敗時は要求したロール */
      role: OnlineClaimRole;
      seats: SeatsTaken;
      /** 実席の確保に成功した時だけ発行する再接続トークン */
      resumeToken?: string;
    }
  | { t: "seats"; seats: SeatsTaken }
  | { t: "state"; state: RoomSyncState }
  | { t: "actionRejected"; reason: string; state: GameState }
  | {
      t: "reset";
      seats: SeatsTaken;
      /** reset後も部屋内で単調増加するrevを持つ空の募集状態 */
      state: MatchSetupState;
    };

/** リレーのWebSocketを待ち受けるパス (配信と同一オリジン) */
export const RELAY_PATH = "/ws";
