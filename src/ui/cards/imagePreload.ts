// ============================================================
// カード画像の先読み
//
// 対戦中に初めて表示されるカードは、そのタイミングで初めて取得が始まるため
// 一瞬だけ空欄が見える。対戦で使うデッキは開始前に確定しているので、
// 画面を出す前にまとめて取得しておき、キャッシュ済みの状態で描画する。
// ============================================================
import { cardBackUrl, cardImageUrl } from "../../data/loader";
import type { DeckList } from "../../game/types";

/** 同時に走らせる取得数。多すぎると初期表示側の通信を圧迫する。 */
const PRELOAD_CONCURRENCY = 6;

/**
 * URLごとの取得結果。同じURLは一度しか要求せず、後から重ねて待つ側も
 * 同じ完了を共有する。「要求済み」を「取得済み」と数えると、まだ飛んでいる
 * 取得を待たずに盤面を出してしまう。
 */
const loads = new Map<string, Promise<void>>();

export interface PreloadProgress {
  loaded: number;
  total: number;
}

function loadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const image = new Image();
    // 失敗しても表示側にフォールバックがあるため、常にresolveして次へ進む。
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = url;
  });
}

function loadOnce(url: string): Promise<void> {
  const existing = loads.get(url);
  if (existing) return existing;
  const started = loadImage(url);
  loads.set(url, started);
  return started;
}

/** デッキで使うカードIDを重複なく返す (推し・メイン・エール)。 */
export function deckCardIds(deck: DeckList): string[] {
  return [
    ...new Set([
      deck.oshiId,
      ...Object.keys(deck.main),
      ...Object.keys(deck.cheer),
    ]),
  ];
}

/** デッキで実際に選択された画像URLを重複なく返す。 */
export function deckCardImageUrls(deck: DeckList): string[] {
  const urls = new Set<string>();
  const add = (cardId: string, artworkKey?: string) => {
    const url = cardImageUrl(cardId, artworkKey);
    if (url) urls.add(url);
  };
  add(deck.oshiId, deck.artworks?.oshi);
  for (const [zone, artworkZone] of [
    [deck.main, deck.artworks?.main],
    [deck.cheer, deck.artworks?.cheer],
  ] as const) {
    for (const [cardId, total] of Object.entries(zone)) {
      const alternateCounts = artworkZone?.[cardId] ?? {};
      const alternateTotal = Object.values(alternateCounts).reduce(
        (sum, count) => sum + count,
        0,
      );
      if (alternateTotal < total) add(cardId);
      for (const artworkKey of Object.keys(alternateCounts))
        add(cardId, artworkKey);
    }
  }
  return [...urls];
}

/** 対戦で表示されうる画像URL。裏面も含める。 */
export function matchImageUrls(decks: readonly DeckList[]): string[] {
  const urls = new Set<string>([cardBackUrl("holomen"), cardBackUrl("yell")]);
  for (const deck of decks)
    for (const url of deckCardImageUrls(deck)) urls.add(url);
  return [...urls];
}

/**
 * URLを並列数を絞って取得する。既に飛んでいる取得はその完了を待つので、
 * 先に始めた先読みの途中で待ち始めても取りこぼさない。
 * 表示を止めないよう、呼び出し側は待ち時間に上限を設けること。
 */
export async function preloadImages(
  urls: readonly string[],
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: PreloadProgress) => void;
  } = {},
): Promise<void> {
  const total = urls.length;
  let loaded = 0;
  options.onProgress?.({ loaded, total });
  if (total === 0) return;

  let next = 0;
  const worker = async () => {
    while (next < total) {
      if (options.signal?.aborted) return;
      await loadOnce(urls[next++]);
      loaded++;
      if (!options.signal?.aborted) options.onProgress?.({ loaded, total });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PRELOAD_CONCURRENCY, total) }, worker),
  );
}

/** カードIDから、取得できる画像URLだけを重複なく返す。 */
export function cardImageUrlsOf(cardIds: Iterable<string>): string[] {
  const urls: string[] = [];
  for (const cardId of new Set(cardIds)) {
    const url = cardImageUrl(cardId);
    if (url) urls.push(url);
  }
  return urls;
}

/** 公開済みUIDのカードIDと画像キーから画像URLを返す。 */
export function cardImageUrlsOfUids(
  uidToCard: Record<string, string>,
  uidToArtwork: Record<string, string> | undefined,
): string[] {
  const urls = new Set<string>();
  for (const [uid, cardId] of Object.entries(uidToCard)) {
    const url = cardImageUrl(cardId, uidToArtwork?.[uid]);
    if (url) urls.add(url);
  }
  return [...urls];
}

/** 進捗を見ずに取得だけ進める。既に要求済みのURLは重ねて要求しない。 */
export function preloadImagesInBackground(urls: readonly string[]): void {
  const pending = urls.filter((url) => !loads.has(url));
  if (pending.length > 0) void preloadImages(pending);
}

/**
 * 表示済みの状態から分かるカードを、待たずに裏で取得しておく。
 * 観戦や途中復帰などデッキリストが手元に無い場合の補助。
 */
export function preloadCardIdsInBackground(cardIds: Iterable<string>): void {
  preloadImagesInBackground(cardImageUrlsOf(cardIds));
}

/**
 * 先読みを待つが、上限時間を過ぎたら待たずに進む。
 * 通信が遅い環境で対戦開始が止まらないようにするための保険。
 */
export function preloadWithDeadline(
  urls: readonly string[],
  timeoutMs: number,
  onProgress?: (progress: PreloadProgress) => void,
): { done: Promise<void>; cancel: () => void } {
  const controller = new AbortController();
  const done = new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => resolve(), timeoutMs);
    void preloadImages(urls, {
      signal: controller.signal,
      onProgress,
    }).then(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
  return { done, cancel: () => controller.abort() };
}
