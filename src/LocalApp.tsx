import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCard } from "./data/loader";
import { applyGameAction, type GameAction } from "./game/actions";
import { activeSeatOf, planCpuMove } from "./game/ai/driver";
import {
  pickRandomDeck,
  resolveFirstPlayer,
  type TurnOrderChoice,
} from "./game/ai/setup";
import { requestAiWorkerPlan } from "./game/ai/workerClient";
import {
  mulberry32,
  type AiLevel,
  type AiOptions,
  type PlannedMove,
} from "./game/ai/types";
import type { AiWorkerRequest } from "./game/ai/workerProtocol";
import {
  createSavedDeckId,
  loadSavedDecks,
  SAVED_DECKS_STORAGE_KEY,
} from "./game/decks/storage";
import { sampleDecks, validateDeck } from "./game/decks/rules";
import { createGame, setAnimationWaitsEnabled } from "./game/engine";
import type { DeckList, GameState, PlayerId } from "./game/types";
import {
  clearCpuMatch,
  CPU_MATCH_STORAGE_KEY,
  CpuSaveConflictError,
  cpuMatchCardSignatures,
  loadCpuMatch,
  writeCpuMatch,
  type CpuMatchConfig as MatchConfig,
  type SavedCpuMatch,
} from "./game/matches/cpuStorage";
import { gameViewFor } from "./game/view";
import {
  CardImageLoading,
  useImagePreloadGate,
} from "./ui/cards/CardImagePreload";
import { GameScreen } from "./ui/board/GameScreen";
import { useCompactGameLayout } from "./ui/board/useCompactGameLayout";
import { BackToHome } from "./ui/common/Brand";
import { matchImageUrls } from "./ui/cards/imagePreload";

// ============================================================
// CPU対戦モード (?cpu=1)
// サーバーを使わず、この画面がローカルの審判 (applyGameAction) を回す。
// 人間は seat0、CPUは seat1。CPUの入力は game/ai/driver が作る。
// ============================================================

const HUMAN_SEAT: PlayerId = 0;
const CPU_SEAT: PlayerId = 1;
const PLAYER_NAME = "プレイヤー";
const CPU_NAME = "CPU";
/** 動きを減らす設定で使う、CPU操作間の目標間隔。 */
const REDUCED_MOTION_CPU_INTERVAL_MS = 200;

/** 公開する難易度 (上から強い順)。 */
const LEVELS: { value: AiLevel; label: string; disabled?: boolean }[] = [
  { value: "master", label: "Master" },
  { value: "expert", label: "Expert" },
  { value: "hard", label: "Hard" },
  { value: "normal", label: "Normal" },
  { value: "easy", label: "Easy" },
];

function newAiOptions(
  level: AiLevel,
  opponentDeck: DeckList,
  seed: number,
): AiOptions {
  return { level, rng: mulberry32(seed), opponentDeck };
}

function randomAiSeed(): number {
  const seedArray = new Uint32Array(1);
  crypto.getRandomValues(seedArray);
  return seedArray[0];
}

function createAiWorker(): Worker {
  return new Worker(new URL("./game/ai/ai.worker.ts", import.meta.url), {
    type: "module",
  });
}

export default function LocalApp() {
  const compact = useCompactGameLayout();
  const [savedMatch, setSavedMatch] = useState(() => loadCpuMatch());
  const savedRawRef = useRef(savedMatch.raw);
  const runningSaveRef = useRef<SavedCpuMatch | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [config, setConfig] = useState<MatchConfig | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [actionError, setActionError] = useState<{
    id: number;
    message: string;
  } | null>(null);
  const gameRef = useRef<GameState | null>(game);
  gameRef.current = game;
  const aiRef = useRef<AiOptions | null>(null);
  const aiWorkerRef = useRef<Worker | null>(null);
  const aiWorkerRecoveryUsedRef = useRef(false);
  const aiMatchIdRef = useRef(0);
  const workerRequestIdRef = useRef(0);
  // 対戦で使う両デッキの画像が揃ってから盤面を出す。
  const gateUrls = useMemo(
    () => (config ? matchImageUrls([config.playerDeck, config.cpuDeck]) : null),
    [config],
  );
  const { ready: imagesReady, progress: imageProgress } =
    useImagePreloadGate(gateUrls);
  const humanView = useMemo(
    () => (game ? gameViewFor(game, HUMAN_SEAT) : null),
    [game],
  );

  // オンライン対戦と同じ進行 (LIVE START・サイコロ等の演出完了待ち) にする
  useEffect(() => {
    setAnimationWaitsEnabled(true);
  }, []);

  // 画面を離れた時は実行中の深い探索も直ちに中止する。
  useEffect(
    () => () => {
      aiWorkerRef.current?.terminate();
      aiMatchIdRef.current++;
      aiWorkerRef.current = null;
    },
    [],
  );

  const reportError = (message: string) =>
    setActionError((current) => ({ id: (current?.id ?? 0) + 1, message }));

  const stopMatch = () => {
    aiWorkerRef.current?.terminate();
    aiWorkerRef.current = null;
    aiMatchIdRef.current++;
    runningSaveRef.current = null;
    gameRef.current = null;
    setGame(null);
    setActionError(null);
  };

  const refreshSave = () => {
    const next = loadCpuMatch();
    savedRawRef.current = next.raw;
    setSavedMatch(next);
    return next;
  };

  const handleConflict = () => {
    stopMatch();
    refreshSave();
    setSaveError(null);
    setSaveNotice(
      "別のタブで保存データが変更されました。設定画面から再開してください。",
    );
  };

  // Reactの状態更新関数内で保存・操作を実行しない。StrictModeでも各操作は一度だけ確定する。
  const persistGame = (next: GameState): boolean => {
    const record = runningSaveRef.current;
    if (!record) return false;
    const updated = { ...record, game: next, updatedAt: Date.now() };
    runningSaveRef.current = updated;
    try {
      savedRawRef.current = writeCpuMatch(updated, savedRawRef.current);
      if (next.phase === "finished") {
        // 終局を先に保存してから削除する。削除に失敗しても未終了の対戦を復元しない。
        clearCpuMatch(savedRawRef.current);
        savedRawRef.current = null;
      }
      setSavedMatch({
        save: next.phase === "finished" ? null : updated,
        raw: savedRawRef.current,
        error: null,
      });
      setSaveError(null);
    } catch (error) {
      if (error instanceof CpuSaveConflictError) {
        handleConflict();
        return false;
      }
      setSaveError(
        "最新の進行を保存できませんでした。ブラウザーの保存許可・空き容量を確認してください。このまま閉じると未保存の操作が失われます。",
      );
    }
    return true;
  };
  const commitGame = (next: GameState) => {
    if (!persistGame(next)) return;
    gameRef.current = next;
    setGame(next);
  };

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== CPU_MATCH_STORAGE_KEY) return;
      if (event.storageArea !== window.localStorage) return;
      if (
        window.localStorage.getItem(CPU_MATCH_STORAGE_KEY) ===
        savedRawRef.current
      )
        return;
      if (gameRef.current) handleConflict();
      else refreshSave();
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    if (!game || !saveError) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [!!game, saveError]);

  const configureAi = (cfg: MatchConfig, seed: number) => {
    // CPUから見た相手=人間側のデッキ。デッキリストは既知として探索に使う
    // (山札の順序・手札の中身は知らない)。
    aiRef.current = newAiOptions(cfg.level, cfg.playerDeck, seed);
    aiWorkerRef.current?.terminate();
    aiWorkerRef.current = null;
    aiWorkerRecoveryUsedRef.current = false;
    const matchId = ++aiMatchIdRef.current;
    workerRequestIdRef.current = 0;
    // 難易度を問わず、CPUの行動計画は常駐Workerで実行する (描画スレッドを空ける)。
    let worker: Worker | null = null;
    try {
      worker = createAiWorker();
      aiWorkerRef.current = worker;
      const request: AiWorkerRequest = {
        type: "configure",
        matchId,
        level: cfg.level,
        seed,
        opponentDeck: cfg.playerDeck,
      };
      worker.postMessage(request);
    } catch (error) {
      worker?.terminate();
      if (aiWorkerRef.current === worker) aiWorkerRef.current = null;
      // Worker非対応環境では軽量なEasy同期計画へフォールバックする。
      console.warn("CPU Workerを開始できませんでした", error);
    }
  };

  const beginMatch = (cfg: MatchConfig, first: PlayerId) => {
    const seed = randomAiSeed();
    const next = createGame(
      [structuredClone(cfg.playerDeck), structuredClone(cfg.cpuDeck)],
      [PLAYER_NAME, CPU_NAME],
      first,
    );
    configureAi(cfg, seed);
    setConfig(cfg);
    setActionError(null);
    setSaveNotice(null);
    runningSaveRef.current = {
      sessionId: createSavedDeckId(),
      updatedAt: Date.now(),
      config: structuredClone(cfg),
      aiSeed: seed,
      game: next,
      cardSignatures: cpuMatchCardSignatures(next),
    };
    commitGame(next);
  };

  const startMatch = (cfg: MatchConfig) => {
    const latest = loadCpuMatch();
    if (latest.raw !== savedRawRef.current) {
      refreshSave();
      setSaveNotice(
        "保存データが変更されました。内容を確認してから対戦を開始してください。",
      );
      return;
    }
    if (
      latest.raw &&
      !window.confirm(
        "保存されている対戦を削除して、新しい対戦を開始しますか？",
      )
    )
      return;
    beginMatch(cfg, resolveFirstPlayer(cfg.turnOrder));
  };

  const resumeMatch = () => {
    const latest = loadCpuMatch();
    if (latest.raw !== savedRawRef.current || !latest.save) {
      refreshSave();
      setSaveNotice("保存データを読み直しました。内容を確認してください。");
      return;
    }
    const saved = latest.save;
    configureAi(saved.config, saved.aiSeed);
    setConfig(saved.config);
    setActionError(null);
    setSaveNotice(null);
    // 思考中の探索は保存しない。現在の局面からCPUが合法手を再計画する。
    runningSaveRef.current = { ...saved, sessionId: createSavedDeckId() };
    commitGame(saved.game);
  };

  const discardSave = () => {
    if (!window.confirm("保存されているCPU対戦を削除しますか？")) return;
    try {
      clearCpuMatch(savedRawRef.current);
      refreshSave();
      setSaveError(null);
      setSaveNotice(null);
    } catch (error) {
      refreshSave();
      setSaveNotice(
        error instanceof CpuSaveConflictError
          ? error.message
          : "保存データを削除できませんでした。ブラウザーの保存設定を確認してください。",
      );
    }
  };

  // 同じ設定で再戦する (ランダム選択の場合は先攻を再抽選)
  const rematch = () => {
    const cfg = config;
    if (!cfg) return;
    beginMatch(cfg, resolveFirstPlayer(cfg.turnOrder));
  };

  const mayLeave = () => {
    const current = gameRef.current;
    if (!current) return true;
    if (!persistGame(current)) return false;
    // 最新の書き込みが成功したかを同期的に確認する (setState反映前でも正しく判定)。
    const stored = loadCpuMatch();
    if (current.phase === "finished" && !stored.save) return true;
    if (
      stored.save?.sessionId === runningSaveRef.current?.sessionId &&
      stored.save?.game.rev === current.rev
    )
      return true;
    return window.confirm(
      "最新の進行を保存できていません。未保存の操作を破棄して戻りますか？",
    );
  };
  const exitMatch = () => {
    if (!mayLeave()) return;
    stopMatch();
    refreshSave();
  };

  // 人間 (seat0) の操作。オンラインの「サーバーへ送る」の代わりに
  // その場で審判 (applyGameAction) を通し、拒否は同じUXで通知する。
  const sendAction = (action: GameAction) => {
    const current = gameRef.current;
    if (!current) return;
    try {
      commitGame(applyGameAction(current, HUMAN_SEAT, action));
    } catch (error) {
      reportError(
        error instanceof Error ? error.message : "操作を実行できません",
      );
    }
  };

  // CPUドライバループ: revが進むたびに次の一手を計画する。
  // 計算時間を目標操作間隔から差し引き、残り時間だけ待って適用する。
  // 発火時にrevが変わっていたら破棄。
  useEffect(() => {
    if (!game) return;
    const options = aiRef.current;
    if (!options) return;
    if (activeSeatOf(game) !== CPU_SEAT) return;

    // Worker計画と、Worker非対応時の軽量同期計画の所要時間を操作間隔から差し引く。
    const planningStartedAt = performance.now();
    const matchId = aiMatchIdRef.current;
    let cancelled = false;
    const ownsMatch = () => !cancelled && aiMatchIdRef.current === matchId;
    let timer: number | null = null;
    let cancelRecoveryRequest: (() => void) | null = null;
    const schedule = (planned: PlannedMove | null) => {
      if (!ownsMatch() || !planned) return;
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const targetIntervalMs = reducedMotion
        ? Math.min(REDUCED_MOTION_CPU_INTERVAL_MS, planned.delayMs)
        : planned.delayMs;
      const planningElapsedMs = performance.now() - planningStartedAt;
      const remainingDelayMs = Math.max(
        0,
        targetIntervalMs - planningElapsedMs,
      );
      timer = window.setTimeout(() => {
        if (!ownsMatch()) return;
        const current = gameRef.current;
        if (
          aiMatchIdRef.current !== matchId ||
          !current ||
          current.rev !== game.rev
        )
          return;
        try {
          commitGame(applyGameAction(current, CPU_SEAT, planned.action));
        } catch (error) {
          console.error("CPUの行動適用に失敗しました", planned.action, error);
          reportError("CPUが行動できません。対戦を中断して再開してください。");
        }
      }, remainingDelayMs);
    };
    const failPlanning = (error: unknown) => {
      if (!ownsMatch()) return;
      console.error("CPUの行動計画に失敗しました", error);
      reportError("CPUが行動できません。対戦を中断して再開してください。");
    };

    const worker = aiWorkerRef.current;
    if (worker) {
      const requestId = ++workerRequestIdRef.current;
      const request: AiWorkerRequest = {
        type: "plan",
        matchId,
        requestId,
        // ログは意思決定に使わず長期戦ほど増えるため、Worker転送から除外する。
        state: game.log.length === 0 ? game : { ...game, log: [] },
        seat: CPU_SEAT,
      };
      const recoverWithEasyWorker = (workerError: unknown) => {
        if (!ownsMatch() || aiWorkerRef.current !== worker) return;
        console.warn(
          "CPU Workerの計画に失敗したためEasy Workerへ切り替えます",
          workerError,
        );
        if (aiWorkerRef.current === worker) {
          worker.terminate();
          aiWorkerRef.current = null;
        }
        if (aiWorkerRecoveryUsedRef.current) {
          failPlanning(workerError);
          return;
        }
        aiWorkerRecoveryUsedRef.current = true;
        let recoveryWorker: Worker | null = null;
        try {
          const recoverySeed = randomAiSeed();
          const easyWorker = createAiWorker();
          recoveryWorker = easyWorker;
          aiWorkerRef.current = easyWorker;
          easyWorker.postMessage({
            type: "configure",
            matchId,
            level: "easy",
            seed: recoverySeed,
            opponentDeck: options.opponentDeck ?? null,
          } satisfies AiWorkerRequest);
          const recoveryRequest: AiWorkerRequest = {
            ...request,
            requestId: ++workerRequestIdRef.current,
          };
          cancelRecoveryRequest = requestAiWorkerPlan(
            easyWorker,
            recoveryRequest,
            {
              planned: schedule,
              failed: (recoveryError) => {
                if (!ownsMatch() || aiWorkerRef.current !== easyWorker) return;
                if (aiWorkerRef.current === easyWorker) {
                  easyWorker.terminate();
                  aiWorkerRef.current = null;
                }
                failPlanning(recoveryError);
              },
            },
          );
        } catch (recoveryError) {
          recoveryWorker?.terminate();
          if (aiWorkerRef.current === recoveryWorker)
            aiWorkerRef.current = null;
          failPlanning(recoveryError);
        }
      };
      const cancelRequest = requestAiWorkerPlan(worker, request, {
        planned: schedule,
        failed: recoverWithEasyWorker,
      });
      return () => {
        cancelled = true;
        if (timer !== null) window.clearTimeout(timer);
        cancelRequest();
        cancelRecoveryRequest?.();
      };
    }

    try {
      schedule(
        planCpuMove(game, CPU_SEAT, {
          ...options,
          level: "easy",
        }),
      );
    } catch (error) {
      failPlanning(error);
    }
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [game]);

  const levelLabel =
    LEVELS.find((l) => l.value === (config?.level ?? "normal"))?.label ??
    "normal";
  const returnHome = () => {
    if (mayLeave()) window.location.href = window.location.pathname;
  };

  const banner = (
    <div className="online-banner online-connected">
      <span className="online-room">CPU対戦</span>
      {game && <span className="online-status">{levelLabel}</span>}
      {game && (
        <span className="online-status">
          {saveError ? "未保存" : "保存済み"}
        </span>
      )}
      <button type="button" onClick={returnHome}>
        ホームへ戻る
      </button>
    </div>
  );

  if (!game)
    return (
      <LocalSetup
        initial={config ?? savedMatch.save?.config ?? null}
        onStart={startMatch}
      >
        {(savedMatch.raw !== null ||
          savedMatch.error ||
          saveNotice ||
          saveError) && (
          <section className="cpu-resume-card" aria-label="CPU対戦の保存データ">
            {savedMatch.save && (
              <>
                <strong>中断した対戦があります</strong>
                <p>
                  {savedMatch.save.config.playerDeck.name} / CPU：
                  {savedMatch.save.config.cpuDeck.name}
                </p>
                <p>
                  {
                    LEVELS.find(
                      (l) => l.value === savedMatch.save?.config.level,
                    )?.label
                  }{" "}
                  ·{" "}
                  {savedMatch.save.game.phase === "setup"
                    ? "対戦準備中"
                    : `ターン ${savedMatch.save.game.turn}`}{" "}
                  ·{" "}
                  {new Date(savedMatch.save.updatedAt).toLocaleString("ja-JP")}
                </p>
                <button className="primary" onClick={resumeMatch}>
                  続きから再開
                </button>
              </>
            )}
            {savedMatch.error && <p role="alert">{savedMatch.error}</p>}
            {saveNotice && <p role="status">{saveNotice}</p>}
            {saveError && <p role="alert">{saveError}</p>}
            {savedMatch.raw !== null && (
              <button onClick={discardSave}>保存データを削除</button>
            )}
          </section>
        )}
      </LocalSetup>
    );

  // 画像が揃うまで盤面を出さない (空欄のカードを表示しないため)。
  if (!imagesReady) return <CardImageLoading progress={imageProgress} />;

  return (
    <>
      {!compact && banner}
      {saveError && (
        <div className="cpu-save-error" role="alert">
          <span>{saveError}</span>
          <button
            onClick={() => {
              if (gameRef.current) persistGame(gameRef.current);
            }}
          >
            保存を再試行
          </button>
        </div>
      )}
      <GameScreen
        game={humanView!}
        sendAction={sendAction}
        actionError={actionError}
        seat={HUMAN_SEAT}
        onExit={exitMatch}
        onHome={returnHome}
        onRematch={game.phase === "finished" ? rematch : undefined}
        exitLabel={
          game.phase === "finished" ? "設定へ戻る" : "中断して設定へ戻る"
        }
      />
    </>
  );
}

// ------------------------------------------------------------
// セットアップ画面 (デッキ・CPUデッキ・難易度・手番)
// ------------------------------------------------------------

const DECK_RANDOM = "random";

function LocalSetup({
  initial,
  onStart,
  children,
}: {
  children?: ReactNode;
  initial: MatchConfig | null;
  onStart: (config: MatchConfig) => void;
}) {
  const [samples] = useState(() => sampleDecks());
  const [savedDecks, setSavedDecks] = useState(() => loadSavedDecks());
  const decks = [...samples, ...savedDecks.map((saved) => saved.deck)];

  const initialIndexOf = (deck: DeckList | undefined) => {
    if (!deck) return 0;
    const index = decks.findIndex((d) => d.name === deck.name);
    return index >= 0 ? index : 0;
  };
  const [playerDeckKey, setPlayerDeckKey] = useState(() =>
    initial && !initial.playerDeckRandom
      ? String(initialIndexOf(initial.playerDeck))
      : DECK_RANDOM,
  );
  const [cpuDeckKey, setCpuDeckKey] = useState<string>(() =>
    initial && !initial.cpuDeckRandom
      ? String(initialIndexOf(initial.cpuDeck))
      : DECK_RANDOM,
  );
  const [level, setLevel] = useState<AiLevel>(initial?.level ?? "normal");
  const [turnOrder, setTurnOrder] = useState<TurnOrderChoice>(
    initial?.turnOrder ?? "random",
  );

  // 別タブでのデッキ作成・編集に追従する
  useEffect(() => {
    const syncSavedDecks = (event: StorageEvent) => {
      if (event.key === SAVED_DECKS_STORAGE_KEY)
        setSavedDecks(loadSavedDecks());
    };
    window.addEventListener("storage", syncSavedDecks);
    return () => window.removeEventListener("storage", syncSavedDecks);
  }, []);

  const selectedPlayerDeck =
    playerDeckKey === DECK_RANDOM ? null : decks[Number(playerDeckKey)];
  const playerDeckOk =
    playerDeckKey === DECK_RANDOM
      ? decks.length > 0
      : !!selectedPlayerDeck && validateDeck(selectedPlayerDeck).ok;
  // 抽選対象はサンプルデッキも含めた選択肢すべて (decks) にする
  const selectedCpuDeck =
    cpuDeckKey === DECK_RANDOM ? null : decks[Number(cpuDeckKey)];
  const cpuDeckOk =
    cpuDeckKey === DECK_RANDOM
      ? decks.length > 0
      : !!selectedCpuDeck && validateDeck(selectedCpuDeck).ok;

  const start = () => {
    if (!playerDeckOk || !cpuDeckOk) return;
    const playerDeck =
      playerDeckKey === DECK_RANDOM
        ? pickRandomDeck(decks)
        : selectedPlayerDeck;
    const cpuDeck =
      cpuDeckKey === DECK_RANDOM ? pickRandomDeck(decks) : selectedCpuDeck;
    if (!playerDeck || !cpuDeck) return;
    onStart({
      playerDeck,
      cpuDeck,
      level,
      turnOrder,
      playerDeckRandom: playerDeckKey === DECK_RANDOM,
      cpuDeckRandom: cpuDeckKey === DECK_RANDOM,
    });
  };

  return (
    <main className="lobby-shell">
      <section className="lobby lobby-join">
        <BackToHome />
        <header className="lobby-hero">
          <span className="eyebrow">VS CPU</span>
          <h1>CPU対戦</h1>
          <p className="lobby-note">
            使用するデッキとCPUの強さ、先攻・後攻を設定してください。
          </p>
        </header>

        {children}
        <div className="lobby-setup-grid">
          <label className="control-card">
            <span>使用デッキ</span>
            <select
              value={playerDeckKey}
              onChange={(e) => setPlayerDeckKey(e.target.value)}
            >
              <option value={DECK_RANDOM} disabled={decks.length === 0}>
                ランダム (下の一覧から抽選)
              </option>
              {decks.map((d, i) => (
                <option key={i} value={String(i)}>
                  {d.name} (推し：{getCard(d.oshiId).name})
                </option>
              ))}
            </select>
          </label>
          <label className="control-card">
            <span>CPUのデッキ</span>
            <select
              value={cpuDeckKey}
              onChange={(e) => setCpuDeckKey(e.target.value)}
            >
              <option value={DECK_RANDOM} disabled={decks.length === 0}>
                ランダム (下の一覧から抽選)
              </option>
              {decks.map((d, i) => (
                <option key={i} value={String(i)}>
                  {d.name} (推し：{getCard(d.oshiId).name})
                </option>
              ))}
            </select>
          </label>
          <label className="control-card">
            <span>CPUの強さ</span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as AiLevel)}
            >
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value} disabled={l.disabled}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="control-card">
            <span>手番</span>
            <select
              value={turnOrder}
              onChange={(e) => setTurnOrder(e.target.value as TurnOrderChoice)}
            >
              <option value="random">ランダム</option>
              <option value="first">先攻</option>
              <option value="second">後攻</option>
            </select>
          </label>
        </div>

        <div className="lobby-actions">
          <button
            className="primary"
            disabled={!playerDeckOk || !cpuDeckOk}
            onClick={start}
          >
            対戦開始
          </button>
        </div>
        {decks.length === 0 &&
          (playerDeckKey === DECK_RANDOM || cpuDeckKey === DECK_RANDOM) && (
            <p className="setup-deck-note">
              抽選できるデッキがありません。デッキを作成してください。
            </p>
          )}
      </section>
    </main>
  );
}
