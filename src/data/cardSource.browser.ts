// ============================================================
// カードデータの供給元 (ブラウザ版)
//
// vite.config.ts の alias で cardSource.ts の代わりに読み込まれる。
// data/ は publicDir としてそのまま配信されるので、JSONをバンドルへ
// 焼き込まず fetch する。固定名JSONは利用前に再検証しつつ、メインスレッドと
// CPU Workerが検証済みレスポンスをHTTPキャッシュから共有できる。
//
// パスはサイトのルート直下 (publicDir の配置) を前提にする。
// ============================================================
import type {
  HolomenCardData,
  OshiHolomenCardData,
  SupportCardData,
  YellCardData,
} from "./types";

export interface RawCardData {
  holomen: HolomenCardData[];
  oshi: OshiHolomenCardData[];
  support: SupportCardData[];
  yell: YellCardData[];
}

/** 同期的に使える生データ。fetch 完了までは null */
export let rawCardData: RawCardData | null = null;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, self.location.origin).href, {
    // 保存済みレスポンスを利用できる一方、再配布後は必ずサーバーへ再検証する。
    cache: "no-cache",
  });
  if (!response.ok)
    throw new Error(
      `カードデータを取得できません (${path}: ${response.status})`,
    );
  return (await response.json()) as T;
}

export const cardSourceReady: Promise<RawCardData> = (async () => {
  const [holomen, oshi, support, yell] = await Promise.all([
    fetchJson<{ holomen: HolomenCardData[] }>("/holomen.json"),
    fetchJson<{ oshi_holomen: OshiHolomenCardData[] }>("/oshi_holomen.json"),
    fetchJson<{ support: SupportCardData[] }>("/support.json"),
    fetchJson<{ yell: YellCardData[] }>("/yell.json"),
  ]);
  rawCardData = {
    holomen: holomen.holomen,
    oshi: oshi.oshi_holomen,
    support: support.support,
    yell: yell.yell,
  };
  return rawCardData;
})();
