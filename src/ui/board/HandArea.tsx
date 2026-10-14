// 手札のカード・選択枠・ドラッグ・拡大操作を表示する。
import { getCard } from "../../data/loader";
import type { GameState, PlayerId, PlayerState } from "../../game/types";
import { CardView } from "../cards/CardView";
import { CardPreviewButton } from "../cards/CardPreviewButton";
import { isPrivateDrawUid } from "../effects/drawAnimations";
import type { useCardDrag } from "./useCardDrag";
import type { Selection, MulliganVisualHand } from "./types";

interface HandAreaProps {
  me: PlayerState;
  game: GameState;
  opp: PlayerId;
  sortedHand: string[];
  mulliganVisualHand: MulliganVisualHand | null;
  pendingDrawUids: Set<string>;
  canPreviewHandWhileSelecting: (uid: string) => boolean;
  actionClassFor: (uid: string) => string | undefined;
  selectingHand: boolean;
  selection: Selection;
  multiSelect: Set<string>;
  onHandCardClick: (uid: string) => void;
  cardDrag: ReturnType<typeof useCardDrag>;
  openCardPreview: (
    cardId: string,
    attachedCardIds?: string[],
    artworkKey?: string,
    attachedArtworkKeys?: (string | undefined)[],
  ) => void;
}

export function HandArea({
  me,
  game,
  opp,
  sortedHand,
  mulliganVisualHand,
  pendingDrawUids,
  canPreviewHandWhileSelecting,
  actionClassFor,
  selectingHand,
  selection,
  multiSelect,
  onHandCardClick,
  cardDrag,
  openCardPreview,
}: HandAreaProps) {
  return (
    <div className="hand-row">
      <span className="hand-label">
        手札 ({me.hand.length}枚)
        <br />
        相手: {game.players[opp].hand.length}枚
      </span>
      <div className="hand-cards">
        {sortedHand.map((uid) => {
          const concealed = !!mulliganVisualHand && isPrivateDrawUid(uid);
          const cardId = concealed ? undefined : game.uidToCard[uid];
          const card = cardId ? getCard(cardId) : null;
          const previewVisible =
            !!card &&
            !mulliganVisualHand &&
            !pendingDrawUids.has(uid) &&
            canPreviewHandWhileSelecting(uid);
          return (
            <div className="hand-card-visual" key={uid} data-hand-uid={uid}>
              <CardView
                cardId={card?.id}
                artworkKey={game.uidToArtwork?.[uid]}
                faceDown={concealed || !card}
                size="md"
                animationUid={uid}
                animationZone="hand"
                className={[
                  pendingDrawUids.has(uid) ? "card-draw-pending" : undefined,
                  actionClassFor(uid),
                  selectingHand && !canPreviewHandWhileSelecting(uid)
                    ? "card-dimmed"
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" ")}
                selected={
                  (selection?.kind === "hand" && selection.uid === uid) ||
                  multiSelect.has(uid)
                }
                onClick={
                  mulliganVisualHand ? undefined : () => onHandCardClick(uid)
                }
                onDragPress={
                  mulliganVisualHand
                    ? undefined
                    : (event) => cardDrag.press({ kind: "hand", uid }, event)
                }
              />
              {previewVisible && card && (
                <CardPreviewButton
                  cardName={card.name}
                  className="hand-card-zoom"
                  onPreview={() =>
                    openCardPreview(card.id, [], game.uidToArtwork?.[uid])
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
