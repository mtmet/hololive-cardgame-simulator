// 対戦画面の表示・操作：pickGuidance。
import type { CardFilter } from "../../../game/effects";
import type { Prompt, PlayerId } from "../../../game/types";

type EffectPickPrompt = Extract<Prompt, { type: "effectPickCard" }>;

type PickGuidance = {
  title: string;
  count: string;
  selection: string;
  result: string;
  notes: string[];
};

const PICK_DESTINATION_TITLES: Record<EffectPickPrompt["dest"], string> = {
  hand: "手札に加えるカードを選択",
  stage: "バックに出すカードを選択",
  cheerDeck: "エールデッキに戻すカードを選択",
  deck: "デッキに戻すカードを選択",
  deckBottom: "デッキの下に戻すカードを選択",
  deckTop: "デッキの上に戻すカードを選択",
  cheerAssign: "ホロメンに送るエールを選択",
  attach: "ホロメンに付けるカードを選択",
  holoPower: "ホロパワーにするカードを選択",
  archive: "アーカイブするカードを選択",
  bloom: "Bloomするカードを選択",
};

function pickCountLabel(prompt: EffectPickPrompt): string {
  if (prompt.zeroOrMin !== undefined)
    return prompt.zeroOrMin === prompt.pickMax
      ? `0枚または${prompt.zeroOrMin}枚`
      : `0枚または${prompt.zeroOrMin}〜${prompt.pickMax}枚`;
  if (prompt.pickMin === prompt.pickMax) return `${prompt.pickMin}枚`;
  if (prompt.pickMin === 0) return `最大${prompt.pickMax}枚（選ばなくても可）`;
  return `${prompt.pickMin}〜${prompt.pickMax}枚`;
}

function cardFilterLabel(filter: CardFilter): string {
  if (filter.alt?.length)
    return filter.alt.map(cardFilterLabel).join("、または");

  const kindLabels: Partial<Record<NonNullable<CardFilter["kind"]>, string>> = {
    holomen: "ホロメンカード",
    yell: "エールカード",
    サポート: "サポートカード",
    ファン: "ファンカード",
    マスコット: "マスコットカード",
    ツール: "ツールカード",
    アイテム: "アイテムカード",
    イベント: "イベントカード",
    スタッフ: "スタッフカード",
  };
  const base = filter.names?.length
    ? filter.names.map((name) => `〈${name}〉`).join("または")
    : (filter.kind && kindLabels[filter.kind]) || "カード";
  const qualifiers: string[] = [];

  if (filter.bloomLevel) qualifiers.push(filter.bloomLevel);
  if (filter.minBloom) qualifiers.push(`${filter.minBloom}以上`);
  if (filter.color)
    qualifiers.push(filter.color === "無" ? "無色" : `${filter.color}色`);
  if (filter.sameColorAsOshi) qualifiers.push("推しホロメンと同色");
  if (filter.sameColorAsBound) qualifiers.push("先に選んだホロメンと同色");
  if (filter.sameColorAsBoundIndex !== undefined)
    qualifiers.push(
      `先に選んだ${filter.sameColorAsBoundIndex + 1}人目のホロメンと同色`,
    );
  if (filter.tag) qualifiers.push(`#${filter.tag}`);
  if (filter.nameContains)
    qualifiers.push(`「${filter.nameContains}」を含むカード名`);
  if (filter.buzz) qualifiers.push("Buzz");
  if (filter.excludeBuzz) qualifiers.push("Buzz以外");
  if (filter.limited) qualifiers.push("LIMITED");
  if (filter.excludeLimited) qualifiers.push("LIMITEDではない");
  if (filter.unlimitedOnly) qualifiers.push("デッキ投入枚数に上限がない");
  if (filter.hasCollabEffect) qualifiers.push("コラボエフェクト持ち");
  if (filter.sameNameAs === "oshi")
    qualifiers.push("推しホロメンと同じカード名");
  if (filter.sameNameAs === "collab")
    qualifiers.push("コラボホロメンと同じカード名");
  if (filter.sameNameAsReturned)
    qualifiers.push("この効果で戻したカードと同じカード名");
  if (filter.sameNameAsAttachedTo)
    qualifiers.push("直前にエールを送ったホロメンと同じカード名");
  if (filter.diffFromStage)
    qualifiers.push("自分のステージ全員と異なるカード名");

  return qualifiers.length ? `${qualifiers.join("・")}の${base}` : base;
}

function pickSourceLabel(prompt: EffectPickPrompt, seat: PlayerId): string {
  const ownerLabel = (owner?: PlayerId) =>
    owner === undefined || owner === seat ? "自分の" : "相手の";
  switch (prompt.from) {
    case "deck":
      return "自分のデッキ";
    case "archive":
      return `${ownerLabel(prompt.archiveOwner)}アーカイブ`;
    case "cheer":
      return "自分のエールデッキ";
    case "hand":
      return "自分の手札";
    case "stageYells":
      return `${ownerLabel(prompt.yellOwner)}ステージ上のエール`;
    case "stageSupports":
      return `${ownerLabel(prompt.supportOwner)}ホロメンに付いているサポートカード`;
    case "holo":
      return "自分のホロパワー";
    case "stacked":
      return "自分のステージで重なっている下側のホロメンカード";
    case "downed":
      return "ダウン処理中のホロメンに含まれていたカード";
  }
}

function pickDestinationResult(prompt: EffectPickPrompt): string {
  switch (prompt.dest) {
    case "hand":
      return "選んだカードを手札に加えます。";
    case "stage":
      return "選んだホロメンを自分のバックに出します。";
    case "cheerDeck":
      return "選んだエールを持ち主のエールデッキの下に戻します。";
    case "deck":
      return "選んだカードをデッキに戻します。";
    case "deckBottom":
      return "選んだカードをデッキの下に戻します。";
    case "deckTop":
      return "選んだカードをデッキの上に戻します。";
    case "cheerAssign":
      return "選択後、エール1枚ごとに送るホロメンを選びます。";
    case "attach":
      return "選択後、カード1枚ごとに付けるホロメンを選びます。付けられる対象がいないカードはアーカイブされます。";
    case "holoPower":
      return "選んだカードを裏向きでホロパワーにします。";
    case "archive":
      return "選んだカードをアーカイブします。";
    case "bloom":
      return "選んだカードを先に選択したホロメンに重ねてBloomします。";
  }
}

function pickRestResult(prompt: EffectPickPrompt): string {
  if (prompt.restTo === "none") return "";
  const zone =
    prompt.from === "cheer"
      ? "エールデッキ"
      : prompt.from === "holo"
        ? "ホロパワー"
        : "デッキ";
  if (prompt.restTo === "bottom")
    return ` 選ばなかったカードは${zone}の下に戻します。`;
  if (prompt.restTo === "top")
    return ` 選ばなかったカードは${zone}の上に戻します。`;
  return " 選ばなかったカードはアーカイブします。";
}

export function pickGuidance(
  prompt: EffectPickPrompt,
  seat: PlayerId,
): PickGuidance {
  const count = pickCountLabel(prompt);
  const condition = prompt.pickGroups?.length
    ? "下記の内訳条件に合うカード"
    : prompt.pickFilter
      ? cardFilterLabel(prompt.pickFilter)
      : "表示されているカード";
  const notes: string[] = [];

  if (prompt.pickGroups?.length)
    notes.push(
      `内訳: ${prompt.pickGroups
        .map(({ filter, max }) => `${cardFilterLabel(filter)}を最大${max}枚`)
        .join("、")}`,
    );
  if (prompt.sameNameGroups?.length)
    notes.push(
      `内訳の条件${prompt.sameNameGroups
        .map((index) => index + 1)
        .join("・")}に割り当てるカードは、同じカード名にしてください。`,
    );
  if (prompt.pickFilter?.distinctPick)
    notes.push("選ぶカードは、すべて異なるカード名にしてください。");
  if (prompt.zeroOrMin !== undefined)
    notes.push(
      `効果を使わない場合は0枚、使う場合は${prompt.zeroOrMin}枚以上を選んでください。`,
    );

  const shuffle =
    prompt.shuffleAfter === "deck"
      ? " その後、デッキをシャッフルします。"
      : prompt.shuffleAfter === "cheer"
        ? " その後、エールデッキをシャッフルします。"
        : "";

  return {
    title: PICK_DESTINATION_TITLES[prompt.dest],
    count,
    selection: `${pickSourceLabel(prompt, seat)}から、${condition}を${count}選んでください。`,
    result: `${pickDestinationResult(prompt)}${pickRestResult(prompt)}${shuffle}`,
    notes,
  };
}
