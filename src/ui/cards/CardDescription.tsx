import { yellColorHex } from "../../data/loader";
import { cardImageRarities } from "../../data/cardRarity";
import type { Card, Color, HolomenCard, OshiCard } from "../../data/types";

function CostIcons({ cost }: { cost: Color[] }) {
  return (
    <span className="cost-icons">
      {cost.map((color, index) => (
        <span
          key={index}
          className="yell-dot"
          style={{ background: color === "無" ? "#aaa" : yellColorHex(color) }}
          title={color}
        />
      ))}
    </span>
  );
}

type DescriptionProps = {
  card: Card;
  artworkKey?: string;
  showRarity?: boolean;
};

export function CardMetadata({
  card,
  artworkKey,
  showRarity = false,
}: DescriptionProps) {
  const imageKey = card.imageVariants.includes(artworkKey ?? "")
    ? artworkKey!
    : card.imageVariants[0];
  const rarity = showRarity ? cardImageRarities(card.id)[imageKey] : undefined;
  const lines: string[] = [];
  if (card.cardType === "holomen")
    lines.push(`バトンタッチ: ${card.batonTouchCost}枚`);
  if ("tags" in card && card.tags.length > 0)
    lines.push(`タグ: ${card.tags.map((tag) => `#${tag}`).join(" ")}`);
  if (rarity) lines.push(`レアリティ: ${rarity}`);
  if (!lines.length) return null;
  return (
    <p className="muted card-metadata">
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 && <br />}
          {line}
        </span>
      ))}
    </p>
  );
}

function HolomenDescription({
  card,
  artworkKey,
  showRarity,
}: DescriptionProps & { card: HolomenCard }) {
  return (
    <div className="card-text">
      <div className="card-title">
        {card.name}{" "}
        <span className="muted">
          {card.bloomLevel}
          {card.buzz ? " (Buzz)" : ""} / HP{card.hp} / {card.colors.join("")}
        </span>
      </div>
      {card.gift && (
        <p>
          <b>ギフト「{card.gift.name}」</b>: {card.gift.description}
        </p>
      )}
      {card.collabEffect && (
        <p>
          <b>コラボエフェクト「{card.collabEffect.name}」</b>:{" "}
          {card.collabEffect.description}
        </p>
      )}
      {card.bloomEffect && (
        <p>
          <b>ブルームエフェクト「{card.bloomEffect.name}」</b>:{" "}
          {card.bloomEffect.description}
        </p>
      )}
      {card.arts.map((art, index) => (
        <p key={index}>
          <b>
            <CostIcons cost={art.cost} /> {art.name}
          </b>{" "}
          {art.power}
          {art.special_attack.target && (
            <span className="muted">
              {" "}
              特攻:{art.special_attack.target}+{art.special_attack.power}
            </span>
          )}
          {art.description && <span> — {art.description}</span>}
        </p>
      ))}
      {card.extraText && <p className="muted">エクストラ: {card.extraText}</p>}
      <CardMetadata
        card={card}
        artworkKey={artworkKey}
        showRarity={showRarity}
      />
    </div>
  );
}

function OshiDescription({
  card,
  artworkKey,
  showRarity,
}: DescriptionProps & { card: OshiCard }) {
  return (
    <div className="card-text">
      <div className="card-title">
        {card.name}{" "}
        <span className="muted">
          推し / ライフ{card.life} / {card.color}
        </span>
      </div>
      {card.stageOshiSkill && (
        <p>
          <b>推しステージスキル「{card.stageOshiSkill.name}」</b>:{" "}
          {card.stageOshiSkill.description}
        </p>
      )}
      <p>
        <b>推しスキル「{card.oshiSkill.name}」</b> (ホロパワー-
        {card.oshiSkill.cost}): {card.oshiSkill.description}
      </p>
      {card.spOshiSkill && (
        <p>
          <b>SP推しスキル「{card.spOshiSkill.name}」</b> (ホロパワー-
          {card.spOshiSkill.cost}): {card.spOshiSkill.description}
        </p>
      )}
      <CardMetadata
        card={card}
        artworkKey={artworkKey}
        showRarity={showRarity}
      />
    </div>
  );
}

/** ゲーム画面とデッキ構築画面で共通利用するカード説明。 */
export function CardDescription({
  card,
  artworkKey,
  showRarity = false,
}: DescriptionProps) {
  if (card.cardType === "holomen")
    return (
      <HolomenDescription
        card={card}
        artworkKey={artworkKey}
        showRarity={showRarity}
      />
    );
  if (card.cardType === "oshi")
    return (
      <OshiDescription
        card={card}
        artworkKey={artworkKey}
        showRarity={showRarity}
      />
    );
  if (card.cardType === "support")
    return (
      <div className="card-text">
        <div className="card-title">
          {card.name}{" "}
          <span className="muted">
            {card.supportType}
            {card.limited ? " / LIMITED" : ""}
          </span>
        </div>
        <p>{card.description}</p>
        {card.extraText && (
          <p className="muted">エクストラ: {card.extraText}</p>
        )}
        <CardMetadata
          card={card}
          artworkKey={artworkKey}
          showRarity={showRarity}
        />
      </div>
    );
  return (
    <div className="card-text">
      <div className="card-title">
        {card.name} <span className="muted">{card.color}エール</span>
      </div>
      <CardMetadata
        card={card}
        artworkKey={artworkKey}
        showRarity={showRarity}
      />
    </div>
  );
}
