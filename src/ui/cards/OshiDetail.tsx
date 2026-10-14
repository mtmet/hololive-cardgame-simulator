// 対戦画面の表示・操作：oshiDetail。
import { getCard } from "../../data/loader";
import type { OshiCard } from "../../data/types";
import * as E from "../../game/engine";
import type { GameState, PlayerId } from "../../game/types";
import { actionPhaseReason } from "../board/gameSelection";
import { GameActionButton } from "../common/GameActionButton";
import { CardMetadata } from "./CardDescription";
import { GameCardDetail } from "./GameCardDetail";

function OshiText({
  card,
  holoPower,
  artworkKey,
}: {
  card: OshiCard;
  holoPower?: number;
  artworkKey?: string;
}) {
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
      {holoPower !== undefined && (
        <p className="muted">ホロパワー: {holoPower}枚</p>
      )}
      <CardMetadata card={card} artworkKey={artworkKey} />
    </div>
  );
}

export function OshiDetail({
  game,
  player,
  canAct,
  compact,
  onClose,
  onPreview,
  onSkill,
}: {
  game: GameState;
  player: PlayerId;
  canAct: boolean;
  compact: boolean;
  onClose: () => void;
  onPreview: (
    cardId: string,
    attachedCardIds?: string[],
    artworkKey?: string,
  ) => void;
  onSkill: (sp: boolean) => void;
}) {
  const p = game.players[player];
  const oshi = getCard(game.uidToCard[p.oshiUid]) as OshiCard;
  const phaseReason = actionPhaseReason(game, player, "main");
  const normalReason = canAct
    ? (phaseReason ?? E.canUseOshiSkill(game, false).reason)
    : null;
  const spReason = canAct
    ? (phaseReason ?? E.canUseOshiSkill(game, true).reason)
    : null;
  return (
    <div>
      <GameCardDetail
        card={oshi}
        artworkKey={game.uidToArtwork?.[p.oshiUid]}
        compact={compact}
        onClose={onClose}
        onPreview={() => onPreview(oshi.id, [], game.uidToArtwork?.[p.oshiUid])}
      >
        <OshiText
          card={oshi}
          holoPower={p.holoPower.length}
          artworkKey={game.uidToArtwork?.[p.oshiUid]}
        />
      </GameCardDetail>
      {canAct && (
        <div className="actions">
          <GameActionButton
            reason={normalReason}
            onClick={() => onSkill(false)}
          >
            推しスキル使用
          </GameActionButton>
          {oshi.spOshiSkill && (
            <GameActionButton reason={spReason} onClick={() => onSkill(true)}>
              SP推しスキル使用
            </GameActionButton>
          )}
        </div>
      )}
    </div>
  );
}
