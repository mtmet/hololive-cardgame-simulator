import { rawCardData } from "./cardSource";

/** 画像ごとの表示情報。ゲームルールとCPU保存データの互換性には影響させない。 */
export interface CardRarityData {
  image_rarities?: Record<string, string>;
}

let rarityIndex: Map<string, Record<string, string>> | undefined;
const empty: Record<string, string> = {};

export function cardImageRarities(
  cardId: string,
): Readonly<Record<string, string>> {
  if (!rawCardData) return empty;
  if (!rarityIndex) {
    rarityIndex = new Map(
      Object.values(rawCardData)
        .flat()
        .map((card) => [
          card.id,
          (card as typeof card & CardRarityData).image_rarities ?? empty,
        ]),
    );
  }
  return rarityIndex.get(cardId) ?? empty;
}
