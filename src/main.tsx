import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { cardsReady } from "./data/loader";
import { sampleDecksReady } from "./game/decks/rules";
import { AppErrorView, ErrorBoundary } from "./ui/common/ErrorBoundary";
import "./styles/app.css";
import "./styles/theme.css";
import "./styles/dice-effects.css";
import "./styles/game-flow-effects.css";

// カードデータはバンドルではなく静的JSONのfetchで読むので、描画前に待つ。
// (どの画面もカード名・画像の解決に cardIndex を使う)
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <main className="app-loading" aria-busy="true" aria-live="polite">
    <div className="app-loading-panel">
      <span className="eyebrow">HOLOLIVE CARD GAME</span>
      <p>カードデータを読み込んでいます…</p>
    </div>
  </main>,
);

Promise.all([cardsReady, sampleDecksReady])
  .then(() => {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("カードデータの読み込みに失敗しました:", error);
    root.render(
      <AppErrorView
        title="カードデータを読み込めませんでした"
        message={message}
      />,
    );
  });
