// ============================================================
// オンライン対戦リレー本体
// 部屋ごとに「最新の同期状態」と「席の占有」を管理する。
// 募集完了時のゲーム作成と、対戦中のGameAction検証・実行は
// サーバーだけが行い、確定状態を全接続へ配信する。
// 一体型サーバー (server/serve.ts) と Vite devサーバー同居プラグイン
// (vite.config.ts) の両方から使う。
// ============================================================
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { applyGameAction, isGameAction } from "../src/game/actions";
import { validateDeck } from "../src/game/decks/rules";
import { createGame, setAnimationWaitsEnabled } from "../src/game/engine";
import { roomStateViewFor } from "./onlineView";
import {
  isMatchSetup,
  isValidResumeToken,
  validateRoomCode,
  RELAY_PATH,
  type ClientMessage,
  type OnlineClaimRole,
  type OnlineRole,
  type MatchSetupEntry,
  type MatchSetupState,
  type RoomSyncState,
  type SeatsTaken,
  type ServerMessage,
} from "../src/game/online/protocol";
import type { GameState, PlayerId } from "../src/game/types";

/** 無通信時にも接続状態を確認するping間隔。 */
const KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const DEFAULT_RECONNECT_GRACE_MS = 60_000;
const DEFAULT_ROOM_IDLE_TTL_MS = 30 * 60_000;
/**
 * 部屋と接続が使用する資源の上限。
 * 対戦状態は全員不在でも再接続用にTTLの間残る。空の募集部屋は即時破棄し、
 * 保持部屋数・全接続数・1接続あたりの件数とbyte量にも上限を置く。
 */
const DEFAULT_MAX_ROOMS = 200;
const DEFAULT_MAX_ROOMS_PER_SOURCE = 8;
const DEFAULT_MAX_CLIENTS_PER_ROOM = 16;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_CONNECTIONS_PER_SOURCE = 16;
const DEFAULT_JOIN_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MESSAGES_PER_10S = 300;
const DEFAULT_MAX_BYTES_PER_10S = 1024 * 1024;
const RATE_WINDOW_MS = 10_000;
/** close frameへ応答しない拒否socketも短時間で必ず解放する。 */
const REFUSED_CONNECTION_TERMINATE_MS = 250;

interface Client {
  ws: WebSocket;
  room: RoomState | null;
  role: OnlineRole | null;
  resumeToken: string | null;
  alive: boolean;
  /** 送信元単位の接続数を終了時に確実に戻すための集計key */
  sourceKey: string;
  /** 未入室socketを保持し続けないための期限 */
  joinTimer: ReturnType<typeof setTimeout> | null;
  /** 流量制限用: 現在の窓の開始時刻と受信数 */
  windowStartedAt: number;
  windowCount: number;
  windowBytes: number;
}

interface SeatReservation {
  client: Client | null;
  token: string;
  expiresAt: number | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface RoomState {
  name: string;
  state: RoomSyncState | null;
  /** 1送信元が保持部屋上限を占有し続けないための作成元key */
  ownerSourceKey: string;
  /** stateが空の時も失わない、部屋寿命内で単調増加する確定revision */
  rev: number;
  /** 状態がまだない部屋を最初に開いた接続 (P1を優先予約する) */
  creator: Client | null;
  seats: [SeatReservation | null, SeatReservation | null];
  clients: Set<Client>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface RelayOptions {
  /** テスト用。省略時は通常のゲーム作成・シャッフルを使う。 */
  gameFactory?: typeof createGame;
  /** 切断後に同じトークンからの復帰を待つ時間 */
  reconnectGraceMs?: number;
  /** 全接続がいなくなった状態付き部屋を保持する時間 */
  roomIdleTtlMs?: number;
  /** テスト用。省略時は暗号学的乱数から生成する */
  tokenFactory?: () => string;
  /** 同時に保持する部屋数の上限 */
  maxRooms?: number;
  /** 1部屋あたりの同時接続数の上限 (プレイヤー2+観戦) */
  maxClientsPerRoom?: number;
  /** 同一送信元が同時に保持できる部屋数の上限 */
  maxRoomsPerSource?: number;
  /** 未入室socketを含む、リレー全体の同時接続数上限 */
  maxConnections?: number;
  /** 同一送信元からの同時接続数上限 */
  maxConnectionsPerSource?: number;
  /** 接続後にjoinを完了するまでの制限時間 */
  joinTimeoutMs?: number;
  /** 1接続あたり10秒間に処理するメッセージ数の上限 */
  maxMessagesPer10s?: number;
  /** 1接続あたり10秒間に受信するraw payloadの合計上限 */
  maxBytesPer10s?: number;
}

/** http/http2どちらのサーバーでも受け取れる最小のupgrade窓口 */
interface UpgradeCapableServer {
  on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

export interface Relay {
  /** 既存のHTTPサーバーへupgrade処理を追加する (他パスのupgradeには触らない) */
  attach(server: UpgradeCapableServer, path?: string): void;
  close(): void;
  /** テスト・ログ用の覗き窓 */
  roomInfo(
    name: string,
  ): { rev: number | null; seats: SeatsTaken; clients: number } | null;
}

function seatsOf(room: RoomState): SeatsTaken {
  return [room.seats[0] !== null, room.seats[1] !== null];
}

function emptySetupState(rev: number): MatchSetupState {
  return { kind: "matchSetup", rev, entries: [null, null] };
}

/** 参加情報を何も保持しておらず、再接続用に残す必要がない待機部屋。 */
function isEmptyWaitingRoom(room: RoomState): boolean {
  if (!room.seats.every((seat) => seat === null)) return false;
  if (room.state === null) return true;
  return (
    isMatchSetup(room.state) &&
    room.state.entries.every((entry) => entry === null)
  );
}

function rawDataByteLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;
}

function normalizedSourceIp(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);
    if (isIP(mappedIpv4) === 4) return mappedIpv4;
  }
  return normalized;
}

/** 接続数制限に使う送信元key。実際の接続元アドレスを使用する。 */
export function connectionSourceKey(remoteAddress: string | undefined): string {
  return remoteAddress ? normalizedSourceIp(remoteAddress) : "unknown";
}

/**
 * 席を指定しない参加者へ、参加順に P1 → P2 を割り当てる。
 * 募集中に切断済みの既存エントリは、新規参加者で上書きしない。
 */
function availableSeat(room: RoomState, client: Client): PlayerId | null {
  const entries =
    room.state && isMatchSetup(room.state) ? room.state.entries : null;
  const p1ReservedForCreator =
    room.creator !== null &&
    room.creator !== client &&
    room.creator.role !== "spectator";
  if (room.seats[0] === null && !entries?.[0] && !p1ReservedForCreator)
    return 0;
  if (room.seats[1] === null && !entries?.[1]) return 1;
  return null;
}

export function createRelay(
  log: (line: string) => void = () => {},
  options: RelayOptions = {},
): Relay {
  // オンライン対戦では、LIVE START等の演出完了をプレイヤー操作として同期する。
  setAnimationWaitsEnabled(true);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  const rooms = new Map<string, RoomState>();
  const roomsBySource = new Map<string, number>();
  const clients = new Set<Client>();
  const refusedConnections = new Set<WebSocket>();
  const refusedConnectionsBySource = new Map<string, number>();
  const connectionsBySource = new Map<string, number>();
  const reconnectGraceMs =
    options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
  const roomIdleTtlMs = options.roomIdleTtlMs ?? DEFAULT_ROOM_IDLE_TTL_MS;
  const tokenFactory =
    options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
  const maxRoomsPerSource =
    options.maxRoomsPerSource ?? DEFAULT_MAX_ROOMS_PER_SOURCE;
  const maxClientsPerRoom =
    options.maxClientsPerRoom ?? DEFAULT_MAX_CLIENTS_PER_ROOM;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxConnectionsPerSource =
    options.maxConnectionsPerSource ?? DEFAULT_MAX_CONNECTIONS_PER_SOURCE;
  const joinTimeoutMs = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
  const maxMessagesPer10s =
    options.maxMessagesPer10s ?? DEFAULT_MAX_MESSAGES_PER_10S;
  const maxBytesPer10s = options.maxBytesPer10s ?? DEFAULT_MAX_BYTES_PER_10S;
  let closing = false;

  const send = (client: Client, message: ServerMessage) => {
    if (client.ws.readyState === client.ws.OPEN)
      client.ws.send(JSON.stringify(message));
  };

  const broadcast = (
    room: RoomState,
    message: ServerMessage,
    except?: Client,
  ) => {
    for (const client of room.clients)
      if (client !== except) send(client, message);
  };

  const clearSeatTimer = (reservation: SeatReservation) => {
    if (reservation.expiryTimer !== null) clearTimeout(reservation.expiryTimer);
    reservation.expiryTimer = null;
    reservation.expiresAt = null;
  };

  const clearRoomIdleTimer = (room: RoomState) => {
    if (room.idleTimer !== null) clearTimeout(room.idleTimer);
    room.idleTimer = null;
  };

  const clearJoinTimer = (client: Client) => {
    if (client.joinTimer !== null) clearTimeout(client.joinTimer);
    client.joinTimer = null;
  };

  const destroyRoom = (room: RoomState) => {
    if (rooms.get(room.name) !== room) return;
    clearRoomIdleTimer(room);
    for (const reservation of room.seats)
      if (reservation) clearSeatTimer(reservation);
    rooms.delete(room.name);
    const remainingSourceRooms =
      (roomsBySource.get(room.ownerSourceKey) ?? 1) - 1;
    if (remainingSourceRooms <= 0) roomsBySource.delete(room.ownerSourceKey);
    else roomsBySource.set(room.ownerSourceKey, remainingSourceRooms);
    log(`room expired room=${room.name}`);
  };

  const scheduleRoomCleanup = (room: RoomState) => {
    if (closing || room.clients.size > 0) return;
    if (isEmptyWaitingRoom(room)) {
      destroyRoom(room);
      return;
    }
    if (room.idleTimer !== null) return;
    room.idleTimer = setTimeout(
      () => {
        room.idleTimer = null;
        if (room.clients.size === 0) destroyRoom(room);
      },
      Math.max(0, roomIdleTtlMs),
    );
  };

  function clearSetupEntry(room: RoomState, seat: PlayerId) {
    if (
      !room.state ||
      !isMatchSetup(room.state) ||
      room.state.entries[seat] === null
    )
      return;
    const entries: MatchSetupState["entries"] = [
      room.state.entries[0],
      room.state.entries[1],
    ];
    entries[seat] = null;
    room.state = {
      kind: "matchSetup",
      rev: ++room.rev,
      entries,
    };
    broadcastState(room);
  }

  const expireSeat = (
    room: RoomState,
    seat: PlayerId,
    reservation: SeatReservation,
  ) => {
    if (room.seats[seat] !== reservation || reservation.client !== null) return;
    clearSeatTimer(reservation);
    room.seats[seat] = null;
    broadcast(room, { t: "seats", seats: seatsOf(room) });
    clearSetupEntry(room, seat);
    log(`seat expired room=${room.name} role=${seat}`);
    scheduleRoomCleanup(room);
  };

  const stateMessageFor = (
    client: Client,
    state: RoomSyncState,
  ): ServerMessage => ({
    t: "state",
    state: roomStateViewFor(state, client.role),
  });

  const broadcastState = (room: RoomState) => {
    if (!room.state) return;
    for (const client of room.clients)
      send(client, stateMessageFor(client, room.state));
  };

  const sendCurrentState = (client: Client, room: RoomState) => {
    if (room.state) send(client, stateMessageFor(client, room.state));
    else
      send(client, {
        t: "reset",
        seats: seatsOf(room),
        state: emptySetupState(room.rev),
      });
  };

  const rejectAction = (client: Client, room: RoomState, reason: string) => {
    if (room.state && !isMatchSetup(room.state))
      send(client, {
        t: "actionRejected",
        reason,
        state: roomStateViewFor(room.state, client.role) as GameState,
      });
    else sendCurrentState(client, room);
    log(`action rejected room=${room.name} reason=${reason}`);
  };

  const freeSeat = (client: Client): boolean => {
    const room = client.room;
    if (!room || client.role === null || client.role === "spectator")
      return false;
    const reservation = room.seats[client.role];
    if (reservation?.client === client) {
      clearSeatTimer(reservation);
      room.seats[client.role] = null;
      clearSetupEntry(room, client.role);
      client.resumeToken = null;
      return true;
    }
    return false;
  };

  const occupySeat = (
    room: RoomState,
    client: Client,
    seat: PlayerId,
  ): boolean => {
    const existing = room.seats[seat];
    if (existing?.client === client) {
      client.role = seat;
      client.resumeToken = existing.token;
      return false;
    }
    const previousSeatFreed = freeSeat(client);
    const token = tokenFactory();
    room.seats[seat] = {
      client,
      token,
      expiresAt: null,
      expiryTimer: null,
    };
    client.role = seat;
    client.resumeToken = token;
    return previousSeatFreed || existing === null;
  };

  const resumeSeat = (
    room: RoomState,
    client: Client,
    token: string,
  ): PlayerId | null => {
    for (const seat of [0, 1] as const) {
      const reservation = room.seats[seat];
      if (!reservation || reservation.token !== token) continue;
      if (
        reservation.expiresAt !== null &&
        reservation.expiresAt <= Date.now()
      ) {
        expireSeat(room, seat, reservation);
        return null;
      }
      const previousClient = reservation.client;
      if (previousClient !== null && previousClient !== client) {
        // token所持者を正とし、reload直後など旧socketのclose待ちでも安全に
        // 席を引き継ぐ。tokenは回転して旧socketからの再takeoverを防ぐ。
        previousClient.role = null;
        previousClient.resumeToken = null;
        previousClient.ws.close(
          4004,
          "同じ席に別の接続から復帰したため接続を終了しました",
        );
        reservation.token = tokenFactory();
        log(`seat takeover room=${room.name} role=${seat}`);
      }
      clearSeatTimer(reservation);
      reservation.client = client;
      client.role = seat;
      client.resumeToken = reservation.token;
      return seat;
    }
    return null;
  };

  const canResumeSeat = (room: RoomState, token: string | undefined) =>
    !!token &&
    room.seats.some(
      (reservation) =>
        reservation?.token === token &&
        (reservation.expiresAt === null || reservation.expiresAt > Date.now()),
    );

  const reserveSeatForReconnect = (client: Client): boolean => {
    const room = client.room;
    if (!room || typeof client.role !== "number") return false;
    const seat = client.role;
    const reservation = room.seats[seat];
    if (reservation?.client !== client) return false;
    reservation.client = null;
    reservation.expiresAt = Date.now() + Math.max(0, reconnectGraceMs);
    reservation.expiryTimer = setTimeout(
      () => expireSeat(room, seat, reservation),
      Math.max(0, reconnectGraceMs),
    );
    return true;
  };

  const leaveRoom = (client: Client, preserveSeat = false) => {
    const room = client.room;
    if (!room) return;
    const seatReserved =
      preserveSeat && !closing && reserveSeatForReconnect(client);
    const seatFreed = seatReserved ? false : freeSeat(client);
    room.clients.delete(client);
    if (room.creator === client) room.creator = null;
    client.room = null;
    client.role = null;
    client.resumeToken = null;
    if (seatFreed) broadcast(room, { t: "seats", seats: seatsOf(room) });
    if (room.clients.size === 0) scheduleRoomCleanup(room);
  };

  const handleMessage = (client: Client, message: ClientMessage) => {
    if (message.t === "join") {
      leaveRoom(client, false);
      const name = message.room;
      let room = rooms.get(name);
      if (!room && rooms.size >= maxRooms) {
        log(`join refused (room limit ${maxRooms}) room=${name}`);
        client.ws.close(4001, "部屋数の上限に達しています");
        return;
      }
      const sourceRooms = roomsBySource.get(client.sourceKey) ?? 0;
      if (!room && sourceRooms >= maxRoomsPerSource) {
        log(
          `join refused (source room limit ${maxRoomsPerSource}) source=${client.sourceKey} room=${name}`,
        );
        client.ws.close(
          4001,
          "同じ送信元から保持できる部屋数の上限に達しています",
        );
        return;
      }
      if (
        room &&
        room.clients.size >= maxClientsPerRoom &&
        !canResumeSeat(room, message.resumeToken)
      ) {
        log(`join refused (room full ${maxClientsPerRoom}) room=${name}`);
        client.ws.close(4002, "この部屋は満員です");
        return;
      }
      if (!room) {
        room = {
          name,
          state: null,
          ownerSourceKey: client.sourceKey,
          rev: 0,
          creator: client,
          seats: [null, null],
          clients: new Set(),
          idleTimer: null,
        };
        rooms.set(name, room);
        roomsBySource.set(client.sourceKey, sourceRooms + 1);
      }
      clearRoomIdleTimer(room);
      room.clients.add(client);
      client.room = room;
      clearJoinTimer(client);
      const resumedRole = message.resumeToken
        ? resumeSeat(room, client, message.resumeToken)
        : null;
      send(client, {
        t: "welcome",
        state: room.state ? roomStateViewFor(room.state, client.role) : null,
        seats: seatsOf(room),
        role: resumedRole,
        ...(resumedRole === null || client.resumeToken === null
          ? {}
          : { resumeToken: client.resumeToken }),
      });
      if (resumedRole !== null) log(`resume room=${name} role=${resumedRole}`);
      log(`join room=${name} clients=${room.clients.size}`);
      return;
    }
    const room = client.room;
    if (!room) return;
    if (message.t === "claim") {
      const requestedRole = message.role;
      const previousRole = client.role;
      let role: OnlineClaimRole = requestedRole;
      let ok = true;
      if (requestedRole === "player") {
        const currentSeat =
          typeof client.role === "number" &&
          room.seats[client.role]?.client === client
            ? client.role
            : null;
        const seat = currentSeat ?? availableSeat(room, client);
        if (seat === null) {
          ok = false;
        } else {
          role = seat;
          if (occupySeat(room, client, seat))
            broadcast(room, { t: "seats", seats: seatsOf(room) }, client);
        }
      } else if (requestedRole === "spectator") {
        const seatFreed = freeSeat(client);
        client.role = "spectator";
        client.resumeToken = null;
        if (seatFreed) broadcast(room, { t: "seats", seats: seatsOf(room) });
      } else {
        const seat = requestedRole as PlayerId;
        const occupied = room.seats[seat];
        // 席番号はサーバーが割り当てた結果の再確認にだけ使う。
        // 未着席接続からの直接指定を許すと、作成者へ予約したP1を迂回できる。
        ok = client.role === seat && occupied?.client === client;
      }
      send(client, {
        t: "claimResult",
        ok,
        role,
        seats: seatsOf(room),
        ...(ok && typeof client.role === "number" && client.resumeToken
          ? { resumeToken: client.resumeToken }
          : {}),
      });
      // 対戦途中で空席を引き継いだ接続へ、自席の非公開情報を含む表示を渡す。
      if (
        ok &&
        room.state &&
        typeof client.role === "number" &&
        !isMatchSetup(room.state) &&
        client.role !== previousRole
      )
        sendCurrentState(client, room);
      log(`claim room=${room.name} role=${String(role)} ok=${ok}`);
      return;
    }
    if (message.t === "state") {
      // 募集中の自席エントリだけを更新できる。GameStateは受け取らない。
      if (client.role === null || client.role === "spectator") {
        sendCurrentState(client, room);
        return;
      }
      if (room.state && !isMatchSetup(room.state)) {
        sendCurrentState(client, room);
        return;
      }
      // baseRevが一致した更新だけを受理し、次のrevはサーバーが発行する。
      const currentRev = room.rev;
      if (message.baseRev !== currentRev) {
        sendCurrentState(client, room);
        return;
      }
      const seat = client.role;
      const ownEntry = message.state.entries[seat];
      if (!ownEntry || !isValidSetupEntry(ownEntry)) {
        sendCurrentState(client, room);
        return;
      }
      const entries: MatchSetupState["entries"] = room.state
        ? [room.state.entries[0], room.state.entries[1]]
        : [null, null];
      // 相手席の内容は受信値を信用せず、サーバー保持値を維持する。
      // 自席も許可したフィールドだけへ正規化し、大きな余剰payloadを保持しない。
      entries[seat] = normalizeSetupEntry(ownEntry);
      const nextRev = ++room.rev;
      const entry0 = entries[0];
      const entry1 = entries[1];
      if (entry0 && entry1) {
        const firstPlayer: PlayerId = Math.random() < 0.5 ? 0 : 1;
        const game = (options.gameFactory ?? createGame)(
          [entry0.deck, entry1.deck],
          [entry0.name, entry1.name],
          firstPlayer,
        );
        game.rev = nextRev;
        room.state = game;
        log(`game started room=${room.name} first=${firstPlayer}`);
      } else {
        room.state = {
          kind: "matchSetup",
          rev: nextRev,
          entries,
        };
      }
      broadcastState(room);
      return;
    }
    if (message.t === "action") {
      if (client.role === null || client.role === "spectator") {
        rejectAction(client, room, "観戦者または未着席の接続は操作できません");
        return;
      }
      if (!room.state || isMatchSetup(room.state)) {
        rejectAction(client, room, "対戦はまだ開始していません");
        return;
      }
      if (message.baseRev !== room.state.rev) {
        // rev競合は確定状態を送り直せば解消するので、拒否理由は通知しない。
        sendCurrentState(client, room);
        log(`action stale room=${room.name} base=${message.baseRev}`);
        return;
      }
      try {
        room.state = applyGameAction(room.state, client.role, message.action);
        room.rev = room.state.rev;
        broadcastState(room);
      } catch (error) {
        rejectAction(
          client,
          room,
          error instanceof Error ? error.message : "操作を実行できません",
        );
      }
      return;
    }
    if (message.t === "reset") {
      // 観戦者や未参加者から部屋全体を終了することはできない。
      if (client.role === null || client.role === "spectator") return;
      room.state = emptySetupState(++room.rev);
      // 対戦状態だけでなく全接続の役割と席を解放し、参加前ロビーへ戻す。
      for (const reservation of room.seats)
        if (reservation) clearSeatTimer(reservation);
      for (const member of room.clients) {
        member.role = null;
        member.resumeToken = null;
      }
      room.seats = [null, null];
      broadcast(room, {
        t: "reset",
        seats: seatsOf(room),
        state: room.state,
      });
      log(`reset room=${room.name}`);
    }
  };

  wss.on("connection", (ws, request) => {
    const sourceKey = connectionSourceKey(request.socket.remoteAddress);
    const sourceConnections = connectionsBySource.get(sourceKey) ?? 0;
    const refuseConnection = (reason: string) => {
      ws.on("error", () => {});
      const pendingForSource = refusedConnectionsBySource.get(sourceKey) ?? 0;
      // close handshake待ち自体を新しい枯渇手段にしない。待機枠を超えた分は
      // close codeの到達より資源解放を優先して直ちにterminateする。
      const maxPendingRefusals = Math.max(1, Math.min(32, maxConnections));
      if (
        refusedConnections.size >= maxPendingRefusals ||
        pendingForSource >= Math.max(1, maxConnectionsPerSource)
      ) {
        ws.terminate();
        return;
      }
      refusedConnections.add(ws);
      refusedConnectionsBySource.set(sourceKey, pendingForSource + 1);
      let released = false;
      let terminateTimer: ReturnType<typeof setTimeout> | null = null;
      const releaseRefusal = () => {
        if (released) return;
        released = true;
        if (terminateTimer !== null) clearTimeout(terminateTimer);
        refusedConnections.delete(ws);
        const remaining = (refusedConnectionsBySource.get(sourceKey) ?? 1) - 1;
        if (remaining <= 0) refusedConnectionsBySource.delete(sourceKey);
        else refusedConnectionsBySource.set(sourceKey, remaining);
      };
      ws.once("close", releaseRefusal);
      // 既存クライアントが恒久エラーとして扱う「満員」のcodeを共用する。
      ws.close(4002, reason);
      terminateTimer = setTimeout(() => {
        releaseRefusal();
        if (ws.readyState !== ws.CLOSED) ws.terminate();
      }, REFUSED_CONNECTION_TERMINATE_MS);
    };
    if (clients.size >= maxConnections) {
      log(`connection refused (connection limit ${maxConnections})`);
      refuseConnection("サーバーの接続数上限に達しています");
      return;
    }
    if (sourceConnections >= maxConnectionsPerSource) {
      log(
        `connection refused (source limit ${maxConnectionsPerSource}) source=${sourceKey}`,
      );
      refuseConnection("同じ送信元からの接続数上限に達しています");
      return;
    }
    const client: Client = {
      ws,
      room: null,
      role: null,
      resumeToken: null,
      alive: true,
      sourceKey,
      joinTimer: null,
      windowStartedAt: Date.now(),
      windowCount: 0,
      windowBytes: 0,
    };
    clients.add(client);
    connectionsBySource.set(sourceKey, sourceConnections + 1);
    client.joinTimer = setTimeout(
      () => {
        client.joinTimer = null;
        if (client.room === null && ws.readyState === ws.OPEN) {
          log("join timeout");
          // 既存クライアントが恒久エラーとして扱う流量制限codeを共用する。
          ws.close(4003, "制限時間内に部屋へ入室できませんでした");
        }
      },
      Math.max(0, joinTimeoutMs),
    );
    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("message", (data) => {
      // 流量制限: 件数とraw byte量のどちらかを超えた接続は切断する。
      const now = Date.now();
      if (now - client.windowStartedAt >= RATE_WINDOW_MS) {
        client.windowStartedAt = now;
        client.windowCount = 0;
        client.windowBytes = 0;
      }
      client.windowCount++;
      client.windowBytes += rawDataByteLength(data);
      if (
        client.windowCount > maxMessagesPer10s ||
        client.windowBytes > maxBytesPer10s
      ) {
        const kind = client.windowBytes > maxBytesPer10s ? "byte" : "message";
        log(
          `rate limit exceeded kind=${kind} room=${client.room?.name ?? "-"}`,
        );
        ws.close(4003, "リクエストが多すぎます");
        return;
      }
      let message: ClientMessage;
      try {
        const parsed: unknown = JSON.parse(String(data));
        if (!isClientMessage(parsed)) {
          if (isJoinAttempt(parsed))
            ws.close(4003, "部屋コードまたは復帰情報が不正です");
          return;
        }
        message = parsed;
      } catch {
        return;
      }
      try {
        handleMessage(client, message);
      } catch (error) {
        log(`relay error: ${error instanceof Error ? error.message : error}`);
      }
    });

    // keepalive: 応答のない接続を切断して席を解放する
    const pingTimer = setInterval(() => {
      if (!client.alive) {
        clearInterval(pingTimer);
        ws.terminate();
        return;
      }
      client.alive = false;
      ws.ping();
    }, KEEPALIVE_INTERVAL_MS);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(pingTimer);
      clearJoinTimer(client);
      leaveRoom(client, true);
      clients.delete(client);
      const remainingSourceConnections =
        (connectionsBySource.get(client.sourceKey) ?? 1) - 1;
      if (remainingSourceConnections <= 0)
        connectionsBySource.delete(client.sourceKey);
      else
        connectionsBySource.set(client.sourceKey, remainingSourceConnections);
    };
    ws.on("close", cleanup);
    ws.on("error", () => {
      cleanup();
      ws.terminate();
    });
  });

  return {
    attach(server, path = RELAY_PATH) {
      server.on("upgrade", (request: IncomingMessage, socket, head) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== path) return; // Vite HMR等、他のupgradeには触らない
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      });
    },
    close() {
      closing = true;
      for (const room of rooms.values()) {
        clearRoomIdleTimer(room);
        for (const reservation of room.seats)
          if (reservation) clearSeatTimer(reservation);
      }
      rooms.clear();
      roomsBySource.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
    roomInfo(name) {
      const room = rooms.get(name);
      if (!room) return null;
      return {
        rev: room.state?.rev ?? null,
        seats: seatsOf(room),
        clients: room.clients.size,
      };
    },
  };
}

function isJoinAttempt(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "t" in value &&
    (value as { t?: unknown }).t === "join"
  );
}
function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null || !("t" in value))
    return false;
  const message = value as Record<string, unknown>;
  if (message.t === "join") {
    if (typeof message.room !== "string") return false;
    const roomValidation = validateRoomCode(message.room);
    return (
      roomValidation.ok &&
      roomValidation.room === message.room &&
      (message.resumeToken === undefined ||
        isValidResumeToken(message.resumeToken))
    );
  }
  if (message.t === "claim")
    return (
      message.role === 0 ||
      message.role === 1 ||
      message.role === "player" ||
      message.role === "spectator"
    );
  if (message.t === "reset") return true;
  if (message.t !== "state" && message.t !== "action") return false;
  if (
    typeof message.baseRev !== "number" ||
    !Number.isSafeInteger(message.baseRev) ||
    message.baseRev < 0
  )
    return false;
  return message.t === "state"
    ? isMatchSetup(message.state)
    : isGameAction(message.action);
}

/** 検証済みentryから、プロトコルで許可したフィールドだけを複製する。 */
function normalizeSetupEntry(entry: MatchSetupEntry): MatchSetupEntry {
  return {
    name: entry.name,
    deck: {
      name: entry.deck.name,
      oshiId: entry.deck.oshiId,
      main: Object.fromEntries(Object.entries(entry.deck.main)),
      cheer: Object.fromEntries(Object.entries(entry.deck.cheer)),
      ...(entry.deck.artworks
        ? {
            artworks: {
              ...(entry.deck.artworks.oshi
                ? { oshi: entry.deck.artworks.oshi }
                : {}),
              ...(entry.deck.artworks.main
                ? {
                    main: Object.fromEntries(
                      Object.entries(entry.deck.artworks.main).map(
                        ([cardId, variants]) => [
                          cardId,
                          Object.fromEntries(Object.entries(variants)),
                        ],
                      ),
                    ),
                  }
                : {}),
              ...(entry.deck.artworks.cheer
                ? {
                    cheer: Object.fromEntries(
                      Object.entries(entry.deck.artworks.cheer).map(
                        ([cardId, variants]) => [
                          cardId,
                          Object.fromEntries(Object.entries(variants)),
                        ],
                      ),
                    ),
                  }
                : {}),
            },
          }
        : {}),
    },
  };
}

function isValidSetupEntry(entry: MatchSetupEntry): boolean {
  if (
    entry.name.trim().length === 0 ||
    entry.name.length > 40 ||
    entry.deck.name.length > 128
  )
    return false;
  try {
    return validateDeck(entry.deck).ok;
  } catch {
    return false;
  }
}
