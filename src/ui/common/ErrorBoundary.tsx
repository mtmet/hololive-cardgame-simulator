// ============================================================
// 最上位のエラーバウンダリ
// 描画中の例外や遅延チャンクの読み込み失敗で白画面のまま固まるのを防ぐ。
// オンライン対戦は再接続トークン (sessionStorage) を持つ同じタブで
// 再読み込みすれば元の席と非公開情報へ復帰できるため、その案内を出す。
// エラーバウンダリはクラスコンポーネントでしか書けない (React 18 時点)。
// ============================================================
import React, { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  failed: boolean;
  message: string;
}

export function AppErrorView({
  title = "画面の表示に失敗しました",
  message,
}: {
  title?: string;
  message?: string;
}) {
  return (
    <main className="app-error" role="alert">
      <div className="app-error-panel">
        <span className="eyebrow">HOLOLIVE CARD GAME</span>
        <h1>{title}</h1>
        <p>
          再読み込みをお試しください。オンライン対戦中だった場合は、
          同じタブで再読み込みすれば元の席へ復帰できます。
          CPU対戦は、再読み込み後の設定画面から保存した対戦を再開できます。
        </p>
        {message && <p className="app-error-detail">{message}</p>}
        <div className="app-error-actions">
          <button className="primary" onClick={() => window.location.reload()}>
            再読み込み
          </button>
          <button
            onClick={() => {
              // 同じ状態で繰り返し失敗する場合の退避先 (部屋指定を外してホームへ)
              window.location.href = window.location.pathname;
            }}
          >
            ホームへ戻る
          </button>
        </div>
      </div>
    </main>
  );
}

export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      failed: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // 本番ビルドでも原因を追えるよう、コンポーネントスタック付きで記録する
    console.error("画面の描画に失敗しました:", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <AppErrorView message={this.state.message} />;
  }
}
