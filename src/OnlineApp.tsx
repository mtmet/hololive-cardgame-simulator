import { useEffect, useRef, useState } from "react";
import type { GameAction } from "./game/actions";
import {
  isMatchSetup,
  type MatchSetupState,
  type OnlineClaimRole,
  type OnlineRole,
  type SeatsTaken,
} from "./game/online/protocol";
import {
  createOnlineSync,
  type OnlineStatus,
  type OnlineSyncHandle,
} from "./game/online/sync";
import type { DeckList, GameState, PlayerId } from "./game/types";
import {
  CardImageLoading,
  useImagePreloadGate,
} from "./ui/cards/CardImagePreload";
import { GameScreen } from "./ui/board/GameScreen";
import {
  cardImageUrlsOfUids,
  matchImageUrls,
  preloadImagesInBackground,
} from "./ui/cards/imagePreload";
import { MatchSetup } from "./ui/lobby/MatchSetup";
import {
  deckNameInputError,
  playerNameInputError,
} from "./ui/common/inputValidation";
import {
  decideSetupPublish,
  type SetupPublishAttempt,
} from "./ui/lobby/onlineSetupRetry";

// ============================================================
// オンラインモード (リレーサーバー経由で遠隔の窓と同期)
// ============================================================

/** 参加ボタンで選んだ内容。席確保後に募集状態へ反映し、反映を確認したら破棄する */
interface PendingEntry {
  seat: PlayerId | null;
  name: string;
  deck: DeckList;
  usesDefaultName: boolean;
}

export default function OnlineApp({ room }: { room: string }) {
  const [game, setGameRaw] = useState<GameState | null>(null);
  const [setup, setSetupRaw] = useState<MatchSetupState | null>(null);
  const [role, setRole] = useState<OnlineRole | null>(null);
  const [seats, setSeats] = useState<SeatsTaken>([false, false]);
  const [status, setStatus] = useState<OnlineStatus>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    id: number;
    message: string;
  } | null>(null);
  const [entryTick, setEntryTick] = useState(0);
  const gameRef = useRef<GameState | null>(game);
  gameRef.current = game;
  const setupRef = useRef<MatchSetupState | null>(setup);
  setupRef.current = setup;
  const roleRef = useRef<OnlineRole | null>(role);
  roleRef.current = role;
  const syncRef = useRef<OnlineSyncHandle | null>(null);
  const myEntryRef = useRef<PendingEntry | null>(null);
  const setupPublishAttemptRef = useRef<SetupPublishAttempt | null>(null);
  // 対戦で使う画像は、参加した時点から進捗を見せて取得する (CPU対戦と同じ)。
  // 自分のデッキは参加時と募集状態から覚えておく (対戦開始で募集状態は消える)。
  // 相手のデッキは非公開なので、マスクされたエントリを先読み対象に含めない。
  const [myDeck, setMyDeck] = useState<DeckList | null>(null);
  const knownDecksRef = useRef(new Map<string, DeckList>());
  const rememberDeck = (deck: DeckList | null | undefined) => {
    if (deck && deck.oshiId !== "hidden")
      knownDecksRef.current.set(
        JSON.stringify([deck.oshiId, deck.name, deck.artworks ?? null]),
        deck,
      );
  };
  rememberDeck(myDeck);
  for (const entry of setup?.entries ?? []) rememberDeck(entry?.deck);
  const knownDecks = [...knownDecksRef.current.values()];

  // 待機の対象は、参加時と対戦開始時に確定させる。対戦中に増やすと待機画面へ
  // 戻ってしまうため、開始後は固定する。デッキが分からない観戦・途中復帰は、
  // 視点ビューに見えているカードだけを対象にする。
  const gateUrlsRef = useRef<string[] | null>(null);
  const gateKeyRef = useRef<string | null>(null);
  const gateKey = game
    ? "match"
    : myDeck
      ? knownDecks
          .map((deck) =>
            JSON.stringify([deck.oshiId, deck.name, deck.artworks ?? null]),
          )
          .join("|")
      : "";
  if (gateKeyRef.current !== gateKey) {
    gateKeyRef.current = gateKey;
    gateUrlsRef.current = !gateKey
      ? null
      : game
        ? [
            ...new Set([
              ...matchImageUrls(knownDecks),
              ...cardImageUrlsOfUids(game.uidToCard, game.uidToArtwork),
            ]),
          ]
        : matchImageUrls(knownDecks);
  }
  const { ready: imagesReady, progress: imageProgress } = useImagePreloadGate(
    gateUrlsRef.current,
  );

  // 進行につれて公開されるカードも、待たせずに裏で取得しておく。
  useEffect(() => {
    if (game)
      preloadImagesInBackground(
        cardImageUrlsOfUids(game.uidToCard, game.uidToArtwork),
      );
  }, [game]);

  useEffect(() => {
    const sync = createOnlineSync({
      room,
      getState: () => gameRef.current ?? setupRef.current,
      onState: (state) => {
        setActionError(null);
        if (isMatchSetup(state)) {
          // WebSocketは順序を保証し、状態はサーバーだけが確定する。
          // reset後の募集状態も含め、受信した状態で種類ごと置き換える。
          setGameRaw(null);
          setSetupRaw(state);
        } else {
          setSetupRaw(null);
          setGameRaw(state);
        }
      },
      onReset: (resetState) => {
        setupPublishAttemptRef.current = null;
        myEntryRef.current = null;
        knownDecksRef.current.clear();
        setMyDeck(null);
        setActionError(null);
        roleRef.current = null;
        setRole(null);
        setSetupRaw(resetState);
        setGameRaw(null);
      },
      onSeats: setSeats,
      onStatus: (nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === "reconnecting")
          setupPublishAttemptRef.current = null;
        if (nextStatus !== "closed") setConnectionError(null);
      },
      onConnectionError: setConnectionError,
      onActionRejected: (message) =>
        setActionError((current) => ({
          id: (current?.id ?? 0) + 1,
          message,
        })),
      onRoleInvalidated: () => {
        roleRef.current = null;
        setRole(null);
        setClaimError(null);
      },
      onClaimResult: (ok, claimedRole) => {
        if (ok) {
          // "player" 要求の成功時は、リレーが実際の席番号を返す。
          if (claimedRole === "player") return;
          const pending = myEntryRef.current;
          if (pending && typeof claimedRole === "number") {
            pending.seat = claimedRole;
            if (pending.usesDefaultName)
              pending.name = `プレイヤー${claimedRole + 1}`;
            setEntryTick((t) => t + 1);
          }
          roleRef.current = claimedRole;
          setRole(claimedRole);
          setClaimError(null);
        } else {
          setupPublishAttemptRef.current = null;
          if (roleRef.current === claimedRole) {
            roleRef.current = null;
            setRole(null);
          }
          if (
            claimedRole === "player" ||
            myEntryRef.current?.seat === claimedRole
          )
            myEntryRef.current = null;
          setClaimError(
            claimedRole === "spectator"
              ? "参加できませんでした。もう一度お試しください。"
              : claimedRole === "player"
                ? "プレイヤー席が埋まっています。観戦で参加してください。"
                : `プレイヤー${claimedRole + 1}の席は他の参加者が使用中です。`,
          );
        }
      },
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      syncRef.current = null;
    };
  }, [room]);

  // 席を確保できたら自分のエントリを募集状態へ反映する。
  // 両席がそろった後の先攻抽選とゲーム作成はサーバーが確定する。
  // 競合でリレーに拒否され最新状態を押し返された場合も、ここが再反映する
  useEffect(() => {
    const mine = myEntryRef.current;
    if (!mine || mine.seat === null || role !== mine.seat) return;
    if (game) {
      setupPublishAttemptRef.current = null;
      myEntryRef.current = null;
      return;
    }
    if (setup?.entries[mine.seat]) {
      setupPublishAttemptRef.current = null;
      myEntryRef.current = null; // 反映を確認できた
      return;
    }
    const entry = { name: mine.name, deck: mine.deck };
    const decision = decideSetupPublish(
      setupPublishAttemptRef.current,
      setup,
      entry,
    );
    if (decision.kind === "wait") return;
    if (decision.kind === "rejected") {
      setupPublishAttemptRef.current = null;
      myEntryRef.current = null;
      setClaimError(
        "参加内容をサーバーへ登録できませんでした。名前とデッキを確認して、もう一度参加してください。",
      );
      return;
    }
    setupPublishAttemptRef.current = decision.attempt;
    const baseRev = decision.attempt.baseRev;
    const entries: MatchSetupState["entries"] = [
      setup?.entries[0] ?? null,
      setup?.entries[1] ?? null,
    ];
    entries[mine.seat] = entry;
    const next: MatchSetupState = {
      kind: "matchSetup",
      rev: baseRev + 1,
      entries,
    };
    syncRef.current?.publishSetup(next, baseRev);
    // 両席がそろった場合もゲーム作成はサーバーへ任せる。
    // ローカルへ先行反映せず、サーバー応答で自席を確認できるまで
    // myEntryRefを保持する (rev競合で押し返されたら最新baseRevで再送)。
  }, [setup, game, role, entryTick]);

  const sendGameAction = (action: GameAction) => {
    if (!game) return;
    syncRef.current?.action(action, game.rev);
  };

  const claim = (r: OnlineClaimRole) => {
    setClaimError(null);
    syncRef.current?.claim(r);
  };

  const joinSetup = (
    name: string,
    deck: DeckList,
    usesDefaultName: boolean,
  ) => {
    const nameError = playerNameInputError(name);
    const deckError = deckNameInputError(deck.name);
    if (nameError || deckError) {
      setupPublishAttemptRef.current = null;
      myEntryRef.current = null;
      setClaimError(nameError ?? deckError);
      return;
    }
    setupPublishAttemptRef.current = null;
    const normalizedDeck: DeckList = {
      ...deck,
      name: deck.name.trim(),
    };
    myEntryRef.current = {
      seat: null,
      name: name.trim(),
      deck: normalizedDeck,
      usesDefaultName,
    };
    // 自席エントリが募集状態へ載る前に対戦が始まることがあるため、
    // 自分のデッキはここで覚えて先読みを始める。
    setMyDeck(normalizedDeck);
    setClaimError(null);
    claim("player");
  };

  const cancelSetup = () => {
    if (!window.confirm("募集を取り消しますか？")) return;
    syncRef.current?.reset();
    setupPublishAttemptRef.current = null;
    myEntryRef.current = null;
    setSetupRaw(null);
  };

  const exitGame = () => {
    if (roleRef.current === "spectator") {
      // 観戦者は部屋の状態に触れず、自分のウィンドウだけをホームへ戻す。
      // 再入室は同じ ?room= 付きURLでいつでもできるため確認は挟まない。
      window.location.href = window.location.pathname;
      return;
    }
    if (
      !window.confirm(
        "対戦を終了して、部屋の全員をロビーへ戻します。よろしいですか？",
      )
    )
      return;
    syncRef.current?.reset();
    setupPublishAttemptRef.current = null;
    myEntryRef.current = null;
    setSetupRaw(null);
    setGameRaw(null);
  };

  const bannerWithError = (
    <OnlineBanner
      room={room}
      status={status}
      seats={seats}
      error={connectionError}
    />
  );

  // 参加したら、画像が揃うまで進捗を出す。盤面は揃ってから表示する。
  if (gateUrlsRef.current && !imagesReady) {
    return (
      <>
        {bannerWithError}
        <CardImageLoading progress={imageProgress} />
      </>
    );
  }

  if (status === "connecting") {
    return (
      <>
        {bannerWithError}
        <main className="lobby-shell">
          <section className="lobby lobby-join">
            <header className="lobby-hero">
              <span className="eyebrow">ONLINE MATCH</span>
              <h1>部屋「{room}」へ接続しています…</h1>
              <p className="lobby-note">
                サーバーに接続できない場合は、ホストがサーバーを起動しているか確認してください。
              </p>
            </header>
          </section>
        </main>
      </>
    );
  }

  if (status === "closed") {
    return (
      <>
        {bannerWithError}
        <main className="lobby-shell">
          <section className="lobby lobby-join">
            <header className="lobby-hero">
              <span className="eyebrow">CONNECTION CLOSED</span>
              <h1>オンライン接続を終了しました</h1>
              <p className="lobby-note" role="alert">
                {connectionError ?? "サーバーとの接続を継続できませんでした。"}
              </p>
            </header>
            <div className="lobby-actions">
              <button
                className="primary"
                onClick={() => window.location.reload()}
              >
                再読み込みして接続する
              </button>
              <button
                onClick={() => {
                  window.location.href = window.location.pathname;
                }}
              >
                ホームへ戻る
              </button>
            </div>
          </section>
        </main>
      </>
    );
  }

  if (!game) {
    // 募集フェーズ: 各プレイヤーが自分の名前とデッキを選んで参加する
    if (role === "spectator") {
      return (
        <>
          {bannerWithError}
          <main className="lobby-shell">
            <section className="lobby lobby-join">
              <header className="lobby-hero">
                <span className="eyebrow">ONLINE MATCH</span>
                <h1>対戦の開始を待っています…</h1>
                <p className="lobby-note">
                  観戦モードで参加しました。両プレイヤーがそろうと自動で対戦画面に切り替わります。
                </p>
              </header>
              <div className="lobby-actions">
                <button onClick={exitGame}>観戦を終了</button>
              </div>
            </section>
          </main>
        </>
      );
    }
    const myEntry = typeof role === "number" ? setup?.entries[role] : null;
    if (typeof role === "number" && myEntry) {
      const oppEntry = setup?.entries[role === 0 ? 1 : 0];
      return (
        <>
          {bannerWithError}
          <main className="lobby-shell">
            <section className="lobby lobby-join">
              <header className="lobby-hero">
                <span className="eyebrow">ONLINE MATCH</span>
                <h1>対戦相手を待っています…</h1>
                <p className="lobby-note">
                  上のバナーの「招待リンク」を相手に共有してください。相手がデッキを選んで参加すると対戦が始まります。
                </p>
              </header>
              <div className="setup-wait-summary">
                <p>
                  あなた: {myEntry.name}(デッキ: {myEntry.deck.name})
                </p>
                <p>
                  相手: {oppEntry ? `${oppEntry.name} (参加済み)` : "未参加"}
                </p>
              </div>
              <div className="lobby-actions">
                <button onClick={cancelSetup}>募集を取り消す</button>
              </div>
            </section>
          </main>
        </>
      );
    }
    return (
      <>
        {bannerWithError}
        <MatchSetup
          setup={setup}
          claimError={claimError}
          onJoin={joinSetup}
          onSpectate={() => claim("spectator")}
        />
      </>
    );
  }

  if (role === null) {
    return (
      <>
        {bannerWithError}
        <main className="lobby-shell">
          <section className="lobby lobby-join">
            <header className="lobby-hero">
              <span className="eyebrow">ONLINE MATCH</span>
              <h1>進行中の対戦があります</h1>
              <p className="lobby-note">
                プレイヤーとして復帰するか、観戦で参加してください。プレイヤー席は参加順に自動で割り当てられます。
              </p>
            </header>
            {claimError && (
              <p className="lobby-storage-error" role="alert">
                {claimError}
              </p>
            )}
            <div className="seat-select seat-select-single">
              <button
                className="primary"
                disabled={seats[0] && seats[1]}
                onClick={() => claim("player")}
              >
                <span className="seat-button-number">PLAYER</span>
                プレイヤーとして参加
                {seats[0] && seats[1] ? " (満席)" : ""}
              </button>
            </div>
            <div className="seat-spectate">
              <button onClick={() => claim("spectator")}>観戦する</button>
            </div>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      {bannerWithError}
      <GameScreen
        game={game}
        sendAction={sendGameAction}
        actionError={actionError}
        seat={role === "spectator" ? 0 : role}
        spectator={role === "spectator"}
        onExit={exitGame}
      />
    </>
  );
}

function OnlineBanner({
  room,
  status,
  seats,
  error,
}: {
  room: string;
  status: OnlineStatus;
  seats: SeatsTaken;
  error?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null)
        window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copyInvite = () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(room)}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      if (copiedTimerRef.current !== null)
        window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className={`online-banner online-${status}`}>
      <span className="online-room" title={`部屋コード: ${room}`}>
        部屋 {room}
      </span>
      <span className="online-seats">
        席 {(seats[0] ? 1 : 0) + (seats[1] ? 1 : 0)}/2
      </span>
      <span className="online-status" role={error ? "alert" : undefined}>
        {error ??
          (status === "connected"
            ? "オンライン"
            : status === "connecting"
              ? "接続中…"
              : status === "reconnecting"
                ? "再接続中…"
                : "接続終了")}
      </span>
      <button type="button" onClick={copyInvite}>
        {copied ? "コピーしました" : "招待リンク"}
      </button>
    </div>
  );
}
