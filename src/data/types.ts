// ============================================================
// カードデータの型定義 (data/*.json に対応)
// ============================================================

/** カードの色 (無 はコスト表記では任意の色を意味する) */
export type Color = "白" | "緑" | "赤" | "青" | "紫" | "黄" | "無";

/** Bloomレベル (1stBuzz は Buzz を持つ 1st として扱う) */
export type BloomLevelRaw = "Debut" | "1st" | "1stBuzz" | "2nd" | "Spot";
export type BloomLevel = "Debut" | "1st" | "2nd" | "Spot";

export interface NamedEffect {
  name?: string;
  description?: string;
}

export interface SpecialAttack {
  /** 特攻の対象色 */
  target?: Color;
  /** 加算されるダメージ (例: "50") */
  power?: string;
}

export interface ArtData {
  name: string;
  cost: Color[];
  /** 基本値。"60" や "100+" の形式 */
  power: string;
  description: string;
  special_attack: SpecialAttack;
}

export interface CardImageData {
  /** card_images/ 配下の画像ファイル名。先頭が既定画像 */
  images?: string[];
}

export interface HolomenCardData extends CardImageData {
  id: string;
  name: string;
  bloom: BloomLevelRaw;
  color: Color[];
  hp: number;
  bloom_effect: NamedEffect;
  collab_effect: NamedEffect;
  gift: NamedEffect;
  arts: ArtData[];
  extra?: string;
  tags: string[];
  baton_touch: Color[];
}

export interface OshiSkillData {
  cost: number | "X";
  name: string;
  description: string;
}

export interface OshiHolomenCardData extends CardImageData {
  id: string;
  name: string;
  life: number;
  color: Color;
  oshi_stage_skill?: Omit<OshiSkillData, "cost">;
  oshi_skill: OshiSkillData;
  sp_oshi_skill: Partial<OshiSkillData>;
}

export type SupportType =
  | "スタッフ"
  | "アイテム"
  | "イベント"
  | "ツール"
  | "マスコット"
  | "ファン";

export interface SupportCardData extends CardImageData {
  id: string;
  name: string;
  card_type: SupportType;
  limited: boolean;
  description: string;
  extra?: string;
  tags: string[];
}

export interface YellCardData extends CardImageData {
  id: string;
  name: string;
  color: Color[];
}

// ------------------------------------------------------------
// 正規化済みカード (ゲームエンジンが扱う統一型)
// ------------------------------------------------------------

export type CardType = "holomen" | "oshi" | "support" | "yell";

export interface CardBase {
  id: string;
  name: string;
  cardType: CardType;
  /** 選択可能な画像キー。先頭が既定画像 */
  imageVariants: string[];
}

export interface HolomenCard extends CardBase {
  cardType: "holomen";
  bloomLevel: BloomLevel;
  buzz: boolean;
  colors: Color[];
  hp: number;
  bloomEffect?: NamedEffect;
  collabEffect?: NamedEffect;
  gift?: NamedEffect;
  arts: ArtData[];
  extraText?: string;
  /** extra「〈X〉としても扱う」から抽出した追加名称 */
  extraNames: string[];
  /** extra「ダウンした時、自分のライフ-N」のN (通常は1) */
  lifeOnDown: number;
  /** extra「このホロメンはBloomできない」 */
  cannotBloom: boolean;
  /** extra「デッキに何枚でも入れられる」 */
  unlimitedCopies: boolean;
  tags: string[];
  /** バトンタッチコスト (任意色エールの枚数) */
  batonTouchCost: number;
}

export interface OshiCard extends CardBase {
  cardType: "oshi";
  life: number;
  color: Color;
  stageOshiSkill?: Omit<OshiSkillData, "cost">;
  oshiSkill: OshiSkillData;
  spOshiSkill?: OshiSkillData;
}

export interface SupportCard extends CardBase {
  cardType: "support";
  supportType: SupportType;
  limited: boolean;
  description: string;
  extraText?: string;
  /** エクストラによる追加名称。旧形式のカード定義では未指定。 */
  extraNames?: string[];
  tags: string[];
}

export interface YellCard extends CardBase {
  cardType: "yell";
  color: Color;
}

export type Card = HolomenCard | OshiCard | SupportCard | YellCard;
