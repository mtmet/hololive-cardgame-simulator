import { lazy, Suspense, useMemo } from "react";
import { resolveOnlineRoomRoute } from "./ui/lobby/onlineRoomRoute";

const Lobby = lazy(() =>
  import("./ui/lobby/Lobby").then((module) => ({ default: module.Lobby })),
);
const OnlineApp = lazy(() => import("./OnlineApp"));
const LocalApp = lazy(() => import("./LocalApp"));

function AppLoading({ label }: { label: string }) {
  return (
    <main className="app-loading" aria-busy="true" aria-live="polite">
      <div className="app-loading-panel">
        <span className="eyebrow">HOLOLIVE CARD GAME</span>
        <p>{label}</p>
      </div>
    </main>
  );
}

function InvalidOnlineRoom({ error }: { error: string }) {
  return (
    <main className="lobby-shell">
      <section className="lobby lobby-join">
        <header className="lobby-hero">
          <span className="eyebrow">INVALID ROOM</span>
          <h1>部屋コードを確認してください</h1>
          <p className="lobby-note" role="alert">
            {error}
          </p>
          <p className="lobby-note">
            招待URLを開いた場合は、URLのroom指定が途中で切れていないか確認してください。
          </p>
        </header>
        <div className="lobby-actions">
          <button
            className="primary"
            onClick={() => {
              window.location.href = window.location.pathname;
            }}
          >
            ホームへ戻る
          </button>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  // ?room=部屋コード が付いていればオンラインモード、?cpu が付いていれば
  // CPU対戦モード、なければデッキ管理と部屋コード入力だけのホーム画面
  const { roomRoute, cpu } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      roomRoute: resolveOnlineRoomRoute(window.location.search),
      cpu: params.has("cpu"),
    };
  }, []);
  const loadingMatch = roomRoute.kind === "valid" || cpu;

  return (
    <Suspense
      fallback={
        <AppLoading
          label={
            loadingMatch
              ? "対戦画面を読み込んでいます…"
              : "ホームを読み込んでいます…"
          }
        />
      }
    >
      {roomRoute.kind === "invalid" ? (
        <InvalidOnlineRoom error={roomRoute.error} />
      ) : roomRoute.kind === "valid" ? (
        <OnlineApp room={roomRoute.room} />
      ) : cpu ? (
        <LocalApp />
      ) : (
        <Lobby />
      )}
    </Suspense>
  );
}
