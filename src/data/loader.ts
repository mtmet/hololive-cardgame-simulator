// ============================================================
// カードデータの読み込みと正規化
// ============================================================
import { cardSourceReady, rawCardData, type RawCardData } from "./cardSource";
import type {
  Card,
  Color,
  HolomenCard,
  HolomenCardData,
  OshiCard,
  OshiHolomenCardData,
  OshiSkillData,
  SupportCard,
  SupportCardData,
  YellCard,
  YellCardData,
} from "./types";

function hasContent(e: { name?: string; description?: string } | undefined) {
  return !!e && (!!e.name || !!e.description);
}

function normalizeCardImages(id: string, images: string[] | undefined) {
  const filenamePattern = new RegExp(
    `^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:_(?:[2-9]|[1-9]\\d+))?\\.png$`,
    "i",
  );
  const safeImages = (images ?? []).filter(
    (filename, index, all) =>
      filenamePattern.test(filename) && all.indexOf(filename) === index,
  );
  return safeImages.length > 0 ? safeImages : [`${id}.png`];
}

function normalizeHolomen(d: HolomenCardData): HolomenCard {
  const extra = d.extra ?? "";
  // 「〈A〉〈B〉としても扱う」から追加名称を抽出
  const extraNames: string[] = [];
  if (extra.includes("としても扱う")) {
    for (const m of extra.matchAll(/〈([^〉]+)〉/g)) extraNames.push(m[1]);
  }
  const lifeMatch = extra.match(/ダウンした時、自分のライフ-(\d+)/);
  return {
    id: d.id,
    name: d.name,
    cardType: "holomen",
    imageVariants: normalizeCardImages(d.id, d.images),
    bloomLevel: d.bloom === "1stBuzz" ? "1st" : d.bloom,
    buzz: d.bloom.includes("Buzz"),
    colors: d.color,
    hp: d.hp,
    bloomEffect: hasContent(d.bloom_effect) ? d.bloom_effect : undefined,
    collabEffect: hasContent(d.collab_effect) ? d.collab_effect : undefined,
    gift: hasContent(d.gift) ? d.gift : undefined,
    arts: d.arts,
    extraText: extra || undefined,
    extraNames,
    lifeOnDown: lifeMatch ? parseInt(lifeMatch[1], 10) : 1,
    cannotBloom: extra.includes("Bloomできない"),
    unlimitedCopies: extra.includes("何枚でも入れられる"),
    tags: d.tags,
    batonTouchCost: d.baton_touch.length,
  };
}

function normalizeOshi(d: OshiHolomenCardData): OshiCard {
  return {
    id: d.id,
    name: d.name,
    cardType: "oshi",
    imageVariants: normalizeCardImages(d.id, d.images),
    life: d.life,
    color: d.color,
    stageOshiSkill: hasContent(d.oshi_stage_skill)
      ? d.oshi_stage_skill
      : undefined,
    oshiSkill: d.oshi_skill,
    spOshiSkill: hasContent(d.sp_oshi_skill)
      ? (d.sp_oshi_skill as OshiSkillData)
      : undefined,
  };
}

function normalizeSupport(d: SupportCardData): SupportCard {
  const extra = d.extra || "";
  return {
    id: d.id,
    name: d.name,
    cardType: "support",
    imageVariants: normalizeCardImages(d.id, d.images),
    supportType: d.card_type,
    limited: d.limited,
    description: d.description,
    extraText: extra || undefined,
    extraNames: extra.includes("としても扱う")
      ? [...extra.matchAll(/〈([^〉]+)〉/g)].map((m) => m[1])
      : [],
    tags: d.tags,
  };
}

function normalizeYell(d: YellCardData): YellCard {
  return {
    id: d.id,
    name: d.name,
    cardType: "yell",
    imageVariants: normalizeCardImages(d.id, d.images),
    color: d.color[0],
  };
}

// 供給元 (cardSource) は Node では JSON の直接 import、ブラウザでは fetch。
// 中身が入るのは cardsReady の解決後なので、配列とMapは同一参照のまま埋める。
export const holomenCards: HolomenCard[] = [];
export const oshiCards: OshiCard[] = [];
export const supportCards: SupportCard[] = [];
export const yellCards: YellCard[] = [];

/** 全カードの id → Card 索引 */
const cardIndexMap = new Map<string, Card>();
export const cardIndex: ReadonlyMap<string, Card> = cardIndexMap;

function applyRawCardData(raw: RawCardData): void {
  if (cardIndexMap.size > 0) return; // 二重適用を防ぐ (Nodeでは同期適用済み)
  holomenCards.push(...raw.holomen.map(normalizeHolomen));
  oshiCards.push(...raw.oshi.map(normalizeOshi));
  supportCards.push(...raw.support.map(normalizeSupport));
  yellCards.push(...raw.yell.map(normalizeYell));
  for (const c of [
    ...holomenCards,
    ...oshiCards,
    ...supportCards,
    ...yellCards,
  ])
    cardIndexMap.set(c.id, c);
}

// Node/tsx では import 時点で使える。ブラウザでは cardsReady を待つ。
if (rawCardData) applyRawCardData(rawCardData);

/**
 * カードデータの読み込み完了。
 * ブラウザのエントリ (main.tsx / ai.worker.ts) は描画・処理の前にこれを待つ。
 */
export const cardsReady: Promise<void> = cardSourceReady.then(applyRawCardData);

export function getCard(id: string): Card {
  const c = cardIndex.get(id);
  if (!c) throw new Error(`未知のカードID: ${id}`);
  return c;
}

/** 領域を問わず有効なエクストラの追加名称を含む。 */
export function cardNames(card: Card): string[] {
  return [
    ...new Set([
      card.name,
      ...(card.cardType === "holomen" || card.cardType === "support"
        ? (card.extraNames ?? [])
        : []),
    ]),
  ];
}

/** ホロメンが指定名称として扱えるか (extraの「としても扱う」を含む) */
export function holomenHasName(card: HolomenCard, name: string): boolean {
  return card.name === name || card.extraNames.includes(name);
}

// ------------------------------------------------------------
// 画像パス (vite publicDir=data により /card_images/... で配信)
// ------------------------------------------------------------

const YELL_COLOR_HEX: Record<string, string> = {
  白: "#f5f5f0",
  緑: "#3faf5f",
  赤: "#e04545",
  青: "#3f7fdf",
  紫: "#9b59d0",
  黄: "#e8c832",
};

export interface CardImageVariant {
  key: string;
  url: string;
  label: string;
}

export function cardImageVariants(cardId: string): CardImageVariant[] {
  const card = getCard(cardId);
  return card.imageVariants.map((key, index) => ({
    key,
    url: `/card_images/${key}`,
    label: `イラスト${index + 1}`,
  }));
}

export function cardImageUrl(cardId: string, imageKey?: string): string | null {
  // エールを含め通常のカード画像を使う。
  // 画像が存在しない場合は UI 側の onError フォールバックで色チップ表示になる。
  const card = getCard(cardId);
  const filename = card.imageVariants.includes(imageKey ?? "")
    ? imageKey!
    : card.imageVariants[0];
  return filename ? `/card_images/${filename}` : null;
}

export function cardBackUrl(kind: "holomen" | "yell"): string {
  return `/card_backside_images/${kind}_backside.png`;
}

export function yellColorHex(color: Color): string {
  return YELL_COLOR_HEX[color] ?? "#999";
}
