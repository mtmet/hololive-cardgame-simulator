// ============================================================
// カードデータの供給元 (Node / tsx 版)
//
// scripts や server は JSON を直接 import して同期的に使う。
// ブラウザ向けには vite.config.ts の alias で cardSource.browser.ts に
// 差し替え、data/ の静的ファイル (publicDir) を fetch する。
// こうするとカードDB (約940KB) がJSバンドルに焼き込まれず、
// メインとWorkerで同じHTTPキャッシュを共有できる。
// ============================================================
import holomenJson from "../../data/holomen.json";
import oshiJson from "../../data/oshi_holomen.json";
import supportJson from "../../data/support.json";
import yellJson from "../../data/yell.json";
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

/** 同期的に使える生データ (ブラウザ版では読み込み完了まで null) */
export const rawCardData: RawCardData | null = {
  holomen: (holomenJson as { holomen: HolomenCardData[] }).holomen,
  oshi: (oshiJson as { oshi_holomen: OshiHolomenCardData[] }).oshi_holomen,
  support: (supportJson as { support: SupportCardData[] }).support,
  yell: (yellJson as { yell: YellCardData[] }).yell,
};

export const cardSourceReady: Promise<RawCardData> =
  Promise.resolve(rawCardData);
