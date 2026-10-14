import { useEffect, useState } from "react";
import { preloadWithDeadline, type PreloadProgress } from "./imagePreload";

/** 通信が遅くても対戦開始を止めない上限。過ぎた分は表示しながら取得を続ける。 */
const PRELOAD_TIMEOUT_MS = 12000;

/**
 * 画像が揃うまで ready=false を返す。urls は対戦ごとに一度だけ確定させること
 * (対戦中に増やすと待機画面へ戻ってしまう)。
 *
 * 完了は「どのurlsに対する完了か」で持つ。真偽値だと対象が入れ替わった瞬間に
 * 前回の完了が残り、揃っていない状態で盤面を出してしまう。
 */
export function useImagePreloadGate(urls: readonly string[] | null): {
  ready: boolean;
  progress: PreloadProgress;
} {
  const [readyFor, setReadyFor] = useState<readonly string[] | null>(null);
  const [progress, setProgress] = useState<PreloadProgress>({
    loaded: 0,
    total: 0,
  });

  useEffect(() => {
    if (!urls) return;
    let active = true;
    const { done, cancel } = preloadWithDeadline(
      urls,
      PRELOAD_TIMEOUT_MS,
      (next) => {
        if (active) setProgress(next);
      },
    );
    void done.then(() => {
      if (active) setReadyFor(urls);
    });
    return () => {
      active = false;
      cancel();
    };
  }, [urls]);

  return { ready: urls !== null && readyFor === urls, progress };
}

/** 先読み中に見せる待機画面。カードの空欄を出さないための繋ぎ。 */
export function CardImageLoading({ progress }: { progress: PreloadProgress }) {
  const percent =
    progress.total > 0
      ? Math.round((progress.loaded / progress.total) * 100)
      : 0;
  return (
    <main className="app-loading">
      <div className="app-loading-panel">
        <span className="eyebrow">LOADING</span>
        <p>カード画像を読み込んでいます…</p>
        <div
          className="preload-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="カード画像の読み込み"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <p>
          {progress.loaded} / {progress.total}
        </p>
      </div>
    </main>
  );
}
