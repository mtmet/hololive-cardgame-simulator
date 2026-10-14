// 対戦画面の表示・操作：handDisplay。
import { getCard } from "../../data/loader";
import type {
  CardType,
  BloomLevel,
  SupportType,
  Color,
  Card,
} from "../../data/types";

const HAND_TYPE_ORDER: Record<CardType, number> = {
  holomen: 0,
  support: 1,
  yell: 2,
  oshi: 3,
};

const HAND_BLOOM_ORDER: Record<BloomLevel, number> = {
  Debut: 0,
  "1st": 1,
  "2nd": 2,
  Spot: 3,
};

const HAND_SUPPORT_ORDER: Record<SupportType, number> = {
  スタッフ: 0,
  アイテム: 1,
  イベント: 2,
  ツール: 3,
  マスコット: 4,
  ファン: 5,
};

const HAND_COLOR_ORDER: Record<Color, number> = {
  白: 0,
  緑: 1,
  赤: 2,
  青: 3,
  紫: 4,
  黄: 5,
  無: 6,
};

function handSubtypeOrder(card: Card): number {
  if (card.cardType === "holomen") return HAND_BLOOM_ORDER[card.bloomLevel];
  if (card.cardType === "support") return HAND_SUPPORT_ORDER[card.supportType];
  if (card.cardType === "yell") return HAND_COLOR_ORDER[card.color];
  return 0;
}

/** ゲーム上の手札順は維持し、表示だけをカード種別ごとにまとめる。 */
export function sortHandForDisplay(
  hand: string[],
  uidToCard: Record<string, string>,
): string[] {
  return hand
    .map((uid, index) => ({ uid, index, card: getCard(uidToCard[uid]) }))
    .sort((a, b) => {
      const typeOrder =
        HAND_TYPE_ORDER[a.card.cardType] - HAND_TYPE_ORDER[b.card.cardType];
      if (typeOrder !== 0) return typeOrder;

      const subtypeOrder = handSubtypeOrder(a.card) - handSubtypeOrder(b.card);
      if (subtypeOrder !== 0) return subtypeOrder;

      const nameOrder = a.card.name.localeCompare(b.card.name, "ja");
      if (nameOrder !== 0) return nameOrder;

      const idOrder = a.card.id.localeCompare(b.card.id, "ja", {
        numeric: true,
      });
      return idOrder || a.index - b.index;
    })
    .map(({ uid }) => uid);
}
