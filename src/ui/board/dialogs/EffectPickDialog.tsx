// 効果のカード選択。選択状態は対戦画面が保持し、説明・候補・確定を表示する。
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useModalFocus } from "../../common/useModalFocus";
import { getCard } from "../../../data/loader";
import type { GameAction } from "../../../game/actions";
import * as E from "../../../game/engine";
import type { GameState, PlayerId, Prompt } from "../../../game/types";
import { CardView } from "../../cards/CardView";
import { CardPreviewButton } from "../../cards/CardPreviewButton";
import { toggleBoundedSelection } from "../selection";
import { pickGuidance } from "./pickGuidance";

interface EffectPickDialogProps {
  game: GameState;
  seat: PlayerId;
  myPrompt: Prompt | undefined;
  multiSelect: Set<string>;
  setMultiSelect: Dispatch<SetStateAction<Set<string>>>;
  isPickModalHidden: boolean;
  setHiddenPickPromptKey: Dispatch<SetStateAction<string | null>>;
  pickPromptKey: string | null;
  effectCardId: string | undefined;
  effectArtworkKey: string | undefined;
  openCardPreview: (
    cardId: string,
    attachedCardIds?: string[],
    artworkKey?: string,
    attachedArtworkKeys?: (string | undefined)[],
  ) => void;
  dispatch: (action: GameAction) => void;
}

function ModalVisibilityIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
      {hidden && <path className="visibility-slash" d="M4 4 20 20" />}
    </svg>
  );
}

export function EffectPickDialog({
  game,
  seat,
  myPrompt,
  multiSelect,
  setMultiSelect,
  isPickModalHidden,
  setHiddenPickPromptKey,
  pickPromptKey,
  effectCardId,
  effectArtworkKey,
  openCardPreview,
  dispatch,
}: EffectPickDialogProps) {
  // プロンプトごとに画面を再作成し、次の効果へ使用承諾を持ち越さない。
  const [useAccepted, setUseAccepted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visibilityRef = useRef<HTMLButtonElement>(null);
  useModalFocus(ref, {
    active: myPrompt?.type === "effectPickCard" && !isPickModalHidden,
    onEscape: () => setHiddenPickPromptKey(pickPromptKey),
    fallbackFocus: visibilityRef,
  });
  useEffect(() => {
    if (myPrompt?.type !== "effectPickCard" || !isPickModalHidden) return;
    const showOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat)
        return;
      event.preventDefault();
      setHiddenPickPromptKey(null);
    };
    document.addEventListener("keydown", showOnEscape);
    return () => document.removeEventListener("keydown", showOnEscape);
  }, [isPickModalHidden, myPrompt?.type, setHiddenPickPromptKey]);
  if (!myPrompt || myPrompt.type !== "effectPickCard") return null;
  const optionalMinimum = myPrompt.zeroOrMin;
  const hasUsageChoice = optionalMinimum !== undefined && optionalMinimum > 0;
  const showUsageChoice = hasUsageChoice && !useAccepted;
  // 使用を選んだ後は、0枚での辞退を含めず必要枚数だけを案内・検証する。
  const selectionPrompt = hasUsageChoice
    ? {
        ...myPrompt,
        pickMin: Math.max(myPrompt.pickMin, optionalMinimum),
        zeroOrMin: undefined,
      }
    : myPrompt;
  const guidance = pickGuidance(selectionPrompt, seat);
  const selectedUids = [...multiSelect];
  const selectionError = E.effectPickCardSelectionError(
    game,
    seat,
    selectionPrompt,
    selectedUids,
  );
  const pickable = (uid: string) =>
    !myPrompt.pickFilter ||
    E.cardMatchesFilter(game, seat, uid, myPrompt.pickFilter);
  const hasUnpickable = myPrompt.uids.some((uid) => !pickable(uid));
  const toggle = (uid: string) => {
    if (!pickable(uid)) return;
    setMultiSelect((current) =>
      toggleBoundedSelection(current, uid, myPrompt.pickMax),
    );
  };
  const stageYellHolderLabel = (uid: string): string | null => {
    if (myPrompt.from !== "stageYells") return null;
    const owner = myPrompt.yellOwner ?? seat;
    const holder = E.allStacks(game.players[owner]).find(({ stack }) =>
      stack.yells.includes(uid),
    );
    if (!holder) return null;
    const position =
      holder.pos === "center"
        ? "センター"
        : holder.pos === "collab"
          ? "コラボ"
          : `バック${holder.pos.back + 1}`;
    const side = owner === seat ? "" : "相手・";
    return `${side}${position}：${E.topCard(game, holder.stack).name}`;
  };
  return (
    <div
      className={`overlay pick-modal-layer${isPickModalHidden ? " is-hidden" : ""}`}
    >
      <div
        className="pick-modal-anchor"
        ref={ref}
        role={isPickModalHidden ? undefined : "dialog"}
        aria-modal={isPickModalHidden ? undefined : true}
        aria-labelledby={isPickModalHidden ? undefined : "effect-pick-title"}
        aria-describedby={
          isPickModalHidden ? undefined : "effect-pick-guidance"
        }
      >
        <button
          type="button"
          className="pick-modal-visibility-button"
          ref={visibilityRef}
          aria-label={
            isPickModalHidden ? "選択モーダルを表示" : "選択モーダルを非表示"
          }
          title={
            isPickModalHidden ? "選択モーダルを表示" : "選択モーダルを非表示"
          }
          aria-pressed={isPickModalHidden}
          onClick={() =>
            setHiddenPickPromptKey(isPickModalHidden ? null : pickPromptKey)
          }
        >
          <ModalVisibilityIcon hidden={!isPickModalHidden} />
        </button>
        <div className="overlay-box pick-box" aria-hidden={isPickModalHidden}>
          <h3 id="effect-pick-title">
            {showUsageChoice
              ? "この効果を使用しますか？"
              : `${guidance.title}（${multiSelect.size}/${myPrompt.pickMax}枚選択）`}
          </h3>
          <section
            id="effect-pick-guidance"
            className={`pick-guidance${effectCardId ? " pick-guidance-has-preview" : ""}`}
            aria-label="カード選択の説明"
          >
            {(myPrompt.ctx.label || effectCardId) && (
              <p className="pick-guidance-context">
                {myPrompt.ctx.label && <span>解決中の効果</span>}
                {myPrompt.ctx.label}
              </p>
            )}
            {effectCardId && (
              <CardPreviewButton
                className="pick-guidance-zoom"
                cardName={getCard(effectCardId).name}
                onPreview={() =>
                  openCardPreview(effectCardId, [], effectArtworkKey)
                }
              />
            )}
            <p>
              <strong>選ぶカード</strong>
              {guidance.selection}
            </p>
            <p>
              <strong>選択後</strong>
              {guidance.result}
            </p>
            {guidance.notes.length > 0 && (
              <ul className="pick-guidance-notes">
                {guidance.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            {!showUsageChoice && (
              <p className="pick-guidance-operation">
                カードをタップして選択／解除し、選び終えたら「確定」を押してください。
                {selectionPrompt.pickMin === 0 &&
                  " 選ばない場合は、0枚のまま「確定」を押します。"}
              </p>
            )}
            {!showUsageChoice && myPrompt.orderMatters && (
              <p className="pick-guidance-operation">
                <strong>選択順</strong>
                {myPrompt.orderLabel ??
                  "カードに表示される番号の順で並びを確定します。"}
              </p>
            )}
          </section>
          {!showUsageChoice && (
            <div className="pick-grid">
              {myPrompt.uids.map((uid) => {
                const holderLabel = stageYellHolderLabel(uid);
                const selectionOrder = [...multiSelect].indexOf(uid) + 1;
                return (
                  <div className="pick-card-option" key={uid}>
                    <div className="modal-card-visual">
                      <CardView
                        cardId={game.uidToCard[uid]}
                        artworkKey={game.uidToArtwork?.[uid]}
                        size="md"
                        selected={multiSelect.has(uid)}
                        className={pickable(uid) ? undefined : "card-dimmed"}
                        onClick={() => toggle(uid)}
                      />
                      <CardPreviewButton
                        cardName={getCard(game.uidToCard[uid]).name}
                        className="modal-card-zoom"
                        onPreview={() =>
                          openCardPreview(
                            game.uidToCard[uid],
                            [],
                            game.uidToArtwork?.[uid],
                          )
                        }
                      />
                    </div>
                    {holderLabel && (
                      <span className="pick-card-source">{holderLabel}</span>
                    )}
                    {myPrompt.orderMatters && selectionOrder > 0 && (
                      <span className="pick-card-source">
                        選択順：{selectionOrder}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!showUsageChoice && hasUnpickable && (
            <p className="muted">
              暗く表示されているカードは条件外のため選択できません。
            </p>
          )}
          {!showUsageChoice && selectionError && multiSelect.size > 0 && (
            <p className="muted">{selectionError}</p>
          )}
          {showUsageChoice ? (
            <div className="pick-use-actions">
              <button
                className="primary"
                onClick={() => {
                  setMultiSelect(new Set());
                  setUseAccepted(true);
                }}
              >
                使用する
              </button>
              <button
                onClick={() =>
                  dispatch({ type: "resolveEffectPickCard", uids: [] })
                }
              >
                使用しない
              </button>
            </div>
          ) : (
            <button
              className="primary"
              disabled={selectionError !== null}
              onClick={() =>
                dispatch({ type: "resolveEffectPickCard", uids: selectedUids })
              }
            >
              確定
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
