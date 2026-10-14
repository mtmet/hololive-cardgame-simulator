// 効果解決の案内。操作に必要な情報と、任意で開く能力本文を分けて表示する。
import { useRef } from "react";
import { useModalFocus } from "../../common/useModalFocus";
import { getCard } from "../../../data/loader";
import { findStackById } from "../../../game/engine";
import type { Op } from "../../../game/effects";
import type {
  GameState,
  EffectContextData,
  DamageReplacementChoice,
} from "../../../game/types";
import { CloseIcon } from "../../cards/CardPreviewButton";

export type EffectInfo = { label: string; description?: string };
type EffectSource = Pick<
  EffectContextData,
  | "label"
  | "sourceStackId"
  | "sourceSupportUid"
  | "sourceCardUid"
  | "artRef"
  | "originOshiSkill"
  | "player"
>;

function sourceCardId(game: GameState, stackId?: number) {
  if (stackId === undefined) return undefined;
  const stack = findStackById(game, stackId)?.stack;
  if (stack) return stack.faceDown ? undefined : game.uidToCard[stack.cards[0]];
  return game.lastKnownHolomen?.[stackId]?.cardIds[0];
}

/** 発生元カードの全文ではなく、解決中の能力の本文だけを選ぶ。 */
export function resolutionInfo(
  game: GameState,
  source: EffectSource,
): EffectInfo {
  const info: EffectInfo = { label: source.label };
  const uid = source.sourceSupportUid ?? source.sourceCardUid;
  const id =
    (uid && game.uidToCard[uid]) ??
    sourceCardId(game, source.sourceStackId) ??
    source.artRef?.cardId;
  if (!id) return info;
  const card = getCard(id);
  if (card.cardType === "support")
    return { ...info, description: card.description };
  if (card.cardType === "oshi") {
    const skill = [card.stageOshiSkill, card.oshiSkill, card.spOshiSkill].find(
      (effect) =>
        effect?.name &&
        (source.originOshiSkill?.name === effect.name ||
          source.label.includes(`「${effect.name}」`)),
    );
    return { ...info, description: skill?.description };
  }
  if (card.cardType !== "holomen") return info;
  const effect = [
    ["ブルームエフェクト", card.bloomEffect],
    ["コラボエフェクト", card.collabEffect],
    ["ギフト", card.gift],
  ] as const;
  const ability = effect.find(
    ([kind, text]) =>
      text?.name && source.label.includes(`${kind}「${text.name}」`),
  )?.[1];
  if (ability) return { ...info, description: ability.description };
  if (source.artRef) {
    const artCard = getCard(source.artRef.cardId);
    const art =
      artCard.cardType === "holomen"
        ? artCard.arts[source.artRef.index]
        : undefined;
    if (art && source.label.includes(`アーツ「${art.name}」`))
      return { ...info, description: art.description };
  }
  return info;
}

export function replacementInfo(
  game: GameState,
  choice: DamageReplacementChoice,
  player: EffectContextData["player"],
): EffectInfo {
  if (choice.kind === "oshi")
    return { label: choice.label, description: choice.description };
  if (choice.kind === "support")
    return resolutionInfo(game, {
      player,
      label: choice.label,
      sourceSupportUid: choice.supportUid,
    });
  const id = sourceCardId(game, choice.holderStackId);
  const card = id ? getCard(id) : undefined;
  return {
    label: choice.label,
    description:
      card?.cardType === "holomen" ? card.gift?.description : undefined,
  };
}

export function abilityInfo(
  game: GameState,
  ability: {
    label: string;
    sourceStackId?: number;
    sourceSupportUid?: string;
    ops: Op[];
    reactive?: { description: string };
  },
  player: EffectContextData["player"],
): EffectInfo {
  const reactive = ability.ops.find((op) => op.t === "offerReactiveSkill");
  const description =
    ability.reactive?.description ??
    (reactive?.t === "offerReactiveSkill" ? reactive.description : undefined);
  return description
    ? { label: ability.label, description }
    : resolutionInfo(game, { ...ability, player });
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v7M12 6.5v1" />
    </svg>
  );
}

export function EffectChoice({
  info,
  onChoose,
  onInfo,
}: {
  info: EffectInfo;
  onChoose: () => void;
  onInfo: (info: EffectInfo) => void;
}) {
  return (
    <div className="effect-choice">
      <button className="primary effect-choice-action" onClick={onChoose}>
        {info.label}
      </button>
      {info.description && (
        <button
          className="game-icon-button effect-info-button"
          aria-label={`${info.label}の効果本文を表示`}
          title="効果本文を表示"
          onClick={() => onInfo(info)}
        >
          <InfoIcon />
        </button>
      )}
    </div>
  );
}

export function EffectResolutionGuide({ info }: { info: EffectInfo }) {
  return (
    <section className="effect-resolution-guide" aria-label="解決中の効果">
      <div className="effect-resolution-heading">
        <span className="muted">解決中</span>
        <strong>{info.label}</strong>
      </div>
      {info.description && (
        <details>
          <summary>効果本文を確認</summary>
          <p>{info.description}</p>
        </details>
      )}
    </section>
  );
}

/** 詳細を閉じても、解決待ちの能力や選択状態は変更しない。 */
export function EffectInfoDialog({
  info,
  onClose,
}: {
  info: EffectInfo;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useModalFocus(ref, { onEscape: onClose });
  return (
    <dialog
      ref={ref}
      className="effect-info-dialog"
      aria-labelledby="effect-info-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section>
        <header>
          <h2 id="effect-info-title">{info.label}</h2>
          <button
            className="game-icon-button"
            aria-label="効果本文を閉じる"
            title="閉じる"
            autoFocus
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="effect-info-body">{info.description}</div>
      </section>
    </dialog>
  );
}
