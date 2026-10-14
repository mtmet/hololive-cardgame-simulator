// ============================================================
// オンライン対戦のWebSocket同期アダプタ
// リレーサーバー経由でゲーム状態を参加ウィンドウ間で同期する。
// 切断時は自動再接続し、部屋への再入室・席の再確保・
// 状態の新旧突き合わせまで面倒を見る。
// ============================================================
import {
  isMatchSetup,
  isValidResumeToken,
  RELAY_PATH,
  type ClientMessage,
  type MatchSetupState,
  type OnlineClaimRole,
  type OnlineRole,
  type RoomSyncState,
  type SeatsTaken,
  type ServerMessage,
} from "./protocol";
import type { GameAction } from "../actions";

export type OnlineStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface OnlineSyncHandle {
  /** 空いているプレイヤー席、特定席、または観戦を要求する */
  claim(role: OnlineClaimRole): void;
  /** 募集状態をサーバーへ送る。対戦開始後のGameStateは送信しない */
  publishSetup(state: MatchSetupState, baseRev: number): void;
  /** 対戦中の操作をサーバーへ送って検証・実行を依頼する */
  action(action: GameAction, baseRev: number): void;
  /** 部屋の対戦を破棄して全員をロビーへ戻す */
  reset(): void;
  dispose(): void;
}

const RESUME_TOKEN_KEY_PREFIX = "hololive-online-resume:";

function tokenStorage(): Storage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function loadResumeToken(room: string): string | null {
  try {
    const storage = tokenStorage();
    if (!storage) return null;
    const key = RESUME_TOKEN_KEY_PREFIX + room;
    const token = storage.getItem(key);
    if (token === null) return null;
    if (isValidResumeToken(token)) return token;
    storage.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

function saveResumeToken(room: string, token: string | null) {
  try {
    const storage = tokenStorage();
    if (!storage) return;
    const key = RESUME_TOKEN_KEY_PREFIX + room;
    if (isValidResumeToken(token)) storage.setItem(key, token);
    else storage.removeItem(key);
  } catch {
    // ストレージを無効にしている環境では、同じ画面内の再接続だけ継続する。
  }
}

export function createOnlineSync(options: {
  room: string;
  onState: (state: RoomSyncState) => void;
  onReset: (state: MatchSetupState | null) => void;
  onSeats: (seats: SeatsTaken) => void;
  onClaimResult: (ok: boolean, role: OnlineClaimRole) => void;
  /** 再接続トークン失効などで、以前の表示roleが無効になったことを通知する */
  onRoleInvalidated: (role: OnlineRole) => void;
  onActionRejected: (reason: string) => void;
  onStatus: (status: OnlineStatus) => void;
  /** サーバーが再試行不能な理由で接続を終了した時に表示する */
  onConnectionError?: (reason: string) => void;
  /** 再接続時に、サーバー側の状態消失を検出するための参照 */
  getState: () => RoomSyncState | null;
}): OnlineSyncHandle {
  let ws: WebSocket | null = null;
  let disposed = false;
  let desiredRole: OnlineClaimRole | null = null;
  let resumeToken = loadResumeToken(options.room);
  let confirmedRole: OnlineRole | null = null;
  // 未着席向けstateのまま実席だけを先にUIへ通知すると、非公開カードを
  // 数値roleで描画してしまう。実席用stateが後続するまでrole確定を保留する。
  let pendingGameRole: OnlineRole | null = null;
  let latestStateIsGame = false;

  let retryDelay = 1000;
  let retryTimer: number | null = null;
  let everConnected = false;

  const sendMessage = (message: ClientMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(message));
  };

  const connect = () => {
    if (disposed) return;
    options.onStatus(everConnected ? "reconnecting" : "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}${RELAY_PATH}`);
    ws = socket;

    socket.onopen = () => {
      retryDelay = 1000;
      sendMessage({
        t: "join",
        room: options.room,
        ...(resumeToken ? { resumeToken } : {}),
      });
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === "welcome") {
        everConnected = true;
        options.onStatus("connected");
        options.onSeats(message.seats);
        pendingGameRole = null;
        if (message.role === null) {
          // stateを渡す前に旧roleを無効化し、未着席向けの秘匿stateを
          // 以前の数値roleで描画する瞬間を作らない。
          if (confirmedRole !== null) options.onRoleInvalidated(confirmedRole);
          confirmedRole = null;
        } else {
          confirmedRole = message.role;
        }

        if (message.state) {
          // 再接続時はサーバーの確定状態を常に正とする。
          // 切断中のローカル変更を押し返すと、他端末の更新を上書きし得る。
          latestStateIsGame = !isMatchSetup(message.state);
          options.onState(message.state);
        } else if (options.getState()) {
          latestStateIsGame = false;
          options.onReset(null);
        } else {
          latestStateIsGame = false;
        }
        if (message.role !== null) {
          // 正しいトークンで復帰できた場合は、席番号の再claimを送らない。
          desiredRole = message.role;
          if (
            typeof message.role === "number" &&
            isValidResumeToken(message.resumeToken)
          ) {
            resumeToken = message.resumeToken;
            saveResumeToken(options.room, resumeToken);
          } else if (typeof message.role === "number") {
            resumeToken = null;
            saveResumeToken(options.room, null);
          }
          options.onClaimResult(true, message.role);
        } else {
          // サーバー再起動や猶予切れで無効になったトークンは破棄する。
          resumeToken = null;
          saveResumeToken(options.room, null);
        }
        // 同じ画面内で猶予切れになった場合は、空いていれば以前の席を再要求する。
        if (message.role === null && desiredRole !== null) {
          const reclaimRole: OnlineClaimRole =
            typeof desiredRole === "number" ? "player" : desiredRole;
          desiredRole = reclaimRole;
          sendMessage({ t: "claim", role: reclaimRole });
        }
        return;
      }
      if (message.t === "claimResult") {
        if (message.ok) {
          // 実席と再接続トークンを、同じタブの再読込後も復帰できるよう保持する。
          desiredRole = message.role as OnlineRole;
          if (
            typeof message.role === "number" &&
            isValidResumeToken(message.resumeToken)
          ) {
            resumeToken = message.resumeToken;
            saveResumeToken(options.room, resumeToken);
          } else if (typeof message.role === "number") {
            resumeToken = null;
            saveResumeToken(options.room, null);
          } else if (message.role === "spectator") {
            resumeToken = null;
            saveResumeToken(options.room, null);
          }
          if (
            typeof message.role === "number" &&
            confirmedRole !== message.role &&
            latestStateIsGame
          ) {
            // リレーはclaimResultの直後に、その実席用のstateを送る。
            // それまでは未着席/観戦向けstateと数値roleを組み合わせない。
            pendingGameRole = message.role;
          } else if (message.role !== "player") {
            confirmedRole = message.role;
            pendingGameRole = null;
            options.onClaimResult(true, message.role);
          } else {
            options.onClaimResult(true, message.role);
          }
        } else if (desiredRole === message.role) {
          desiredRole = null;
          pendingGameRole = null;
        }
        if (!message.ok) options.onClaimResult(false, message.role);
        options.onSeats(message.seats);
        return;
      }
      if (message.t === "seats") {
        options.onSeats(message.seats);
        return;
      }
      if (message.t === "state") {
        latestStateIsGame = !isMatchSetup(message.state);
        options.onState(message.state);
        if (pendingGameRole !== null && latestStateIsGame) {
          const claimedRole = pendingGameRole;
          pendingGameRole = null;
          confirmedRole = claimedRole;
          options.onClaimResult(true, claimedRole);
        }

        return;
      }
      if (message.t === "actionRejected") {
        // 競合や不正操作時も、サーバー確定状態へ必ず戻す。
        latestStateIsGame = true;
        options.onState(message.state);
        if (pendingGameRole !== null) {
          const claimedRole = pendingGameRole;
          pendingGameRole = null;
          confirmedRole = claimedRole;
          options.onClaimResult(true, claimedRole);
        }

        options.onActionRejected(message.reason);
        return;
      }
      if (message.t === "reset") {
        // 対戦終了後は以前の席を自動で取り直さず、全員を参加前へ戻す。
        desiredRole = null;
        resumeToken = null;
        confirmedRole = null;
        pendingGameRole = null;
        latestStateIsGame = false;
        saveResumeToken(options.room, null);
        options.onSeats(message.seats);
        options.onReset(message.state);
      }
    };

    socket.onclose = (event) => {
      if (disposed || ws !== socket) return;
      ws = null;
      pendingGameRole = null;
      if ([4001, 4002, 4003, 4004].includes(event.code)) {
        options.onStatus("closed");
        options.onConnectionError?.(
          event.reason || "サーバーとの接続を継続できませんでした。",
        );
        return;
      }
      options.onStatus("reconnecting");
      retryTimer = window.setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    };

    socket.onerror = () => {
      socket.close();
    };
  };

  connect();

  return {
    claim(role) {
      desiredRole = role;
      pendingGameRole = null;
      sendMessage({ t: "claim", role });
    },
    publishSetup(state, baseRev) {
      sendMessage({ t: "state", baseRev, state });
    },
    action(action, baseRev) {
      sendMessage({ t: "action", baseRev, action });
    },
    reset() {
      sendMessage({ t: "reset" });
    },
    dispose() {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      const socket = ws;
      ws = null;
      socket?.close();
    },
  };
}
