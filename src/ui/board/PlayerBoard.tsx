import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cardImageUrl, getCard, yellColorHex } from "../../data/loader";
import type { Color, HolomenCard, OshiCard } from "../../data/types";
import * as E from "../../game/engine";
import type {
  GameState,
  HolomenStack,
  PlayerId,
  StagePosition,
} from "../../game/types";
import { CardPreviewButton } from "../cards/CardPreviewButton";
import { CardView } from "../cards/CardView";
import { groupYellColors, shouldGroupYells } from "../cards/yellDisplay";

export type DragPayload =
  | { kind: "hand"; uid: string }
  | { kind: "stack"; pos: StagePosition }
  | { kind: "cheer"; yellUid: string };

function posEq(a: StagePosition, b: StagePosition): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.back === b.back;
}

/** ドロップ先ヒットテスト用のdata属性値 (GameScreenのparseDropPosと対) */
function dropPosAttr(pos: StagePosition): string {
  return typeof pos === "string" ? pos : `back:${pos.back}`;
}

const ART_DAMAGE_DISPLAY_DELAY = 350;
const STACK_REVEAL_DURATION = 720;
const STACK_ORIENTATION_DURATION = 420;

function artDamageDisplayDelay(
  game: GameState,
  targetStackId: number,
  targetName: string,
): number {
  const firstLog = Math.max(0, game.log.length - 8);
  for (let index = game.log.length - 1; index >= firstLog; index--) {
    const entry = game.log[index];
    const text = entry.text;
    if (entry.combat?.kind === "art") {
      if (
        entry.combat.targetStackId === targetStackId &&
        /^アーツ「[^」]+」で/.test(text)
      )
        return ART_DAMAGE_DISPLAY_DELAY;
      continue;
    }
    if (!text.includes(targetName) || !text.includes("ダメージ")) continue;
    const artDamage = /^アーツ「[^」]+」で(.+)に\d+ダメージ/.exec(text);
    return artDamage?.[1] === targetName ? ART_DAMAGE_DISPLAY_DELAY : 0;
  }
  return 0;
}

function HpBar({
  current,
  max,
  damageDelay = 0,
  stateChangeDelay = 0,
}: {
  current: number;
  max: number;
  damageDelay?: number;
  stateChangeDelay?: number;
}) {
  const displayedHpRef = useRef({ current, max });
  const [displayedCurrent, setDisplayedCurrent] = useState(current);
  const [displayedMax, setDisplayedMax] = useState(max);
  const [feedback, setFeedback] = useState<{
    kind: "damage" | "heal";
    key: number;
  } | null>(null);
  const ratio =
    displayedMax > 0
      ? Math.max(0, Math.min(100, (displayedCurrent / displayedMax) * 100))
      : 0;
  const healthClass =
    ratio <= 25 ? "is-low" : ratio <= 55 ? "is-mid" : "is-high";

  useEffect(() => {
    const previous = displayedHpRef.current;
    if (current === previous.current && max === previous.max) return;
    const applyChange = () => {
      displayedHpRef.current = { current, max };
      setDisplayedCurrent(current);
      setDisplayedMax(max);
      setFeedback((last) => ({
        kind:
          current < previous.current || max < previous.max ? "damage" : "heal",
        key: (last?.key ?? 0) + 1,
      }));
    };
    const isStateChange = max !== previous.max || current > previous.current;
    const delay = isStateChange
      ? stateChangeDelay
      : current < previous.current
        ? damageDelay
        : 0;
    if (delay > 0) {
      const timer = window.setTimeout(applyChange, delay);
      return () => window.clearTimeout(timer);
    }
    applyChange();
  }, [current, max, damageDelay, stateChangeDelay]);

  return (
    <span
      className={`hp-bar ${healthClass}`}
      role="meter"
      aria-label={`HP ${displayedCurrent}/${displayedMax}`}
      aria-valuemin={0}
      aria-valuemax={displayedMax}
      aria-valuenow={displayedCurrent}
      title={`HP ${displayedCurrent}/${displayedMax} (ダメージ${displayedMax - displayedCurrent})`}
      style={{ "--hp-percent": `${ratio}%` } as CSSProperties}
    >
      <span className="hp-bar-track" aria-hidden="true">
        <span className="hp-bar-fill" />
      </span>
      <span className="hp-bar-value">
        <strong
          key={`value-${feedback?.key ?? 0}`}
          className={feedback ? `is-${feedback.kind}` : undefined}
          data-value={displayedCurrent}
        >
          {displayedCurrent}
        </strong>
      </span>
      {feedback && (
        <span
          key={`feedback-${feedback.key}`}
          className={`hp-bar-feedback is-${feedback.kind}`}
          aria-hidden="true"
        />
      )}
    </span>
  );
}

// ============================================================
// 盤面
// ============================================================

export function PlayerBoard({
  game,
  player,
  seat,
  interactive = true,
  hpChangeDelays,
  flipped,
  onDragPress,
  canDropOnStack,
  canDropOnSlot,
  onStackClick,
  onSupportClick,
  onCardPreview,
  canPreviewStack,
  boardDroppable,
  onOshiClick,
  onArchiveClick,
  selectedStack,
  selectedOshiPlayer,
  actionClassFor,
  targeting = false,
  canSelectStack,
}: {
  game: GameState;
  player: PlayerId;
  seat: PlayerId;
  /** 観戦などで盤面からのドラッグ操作を無効化する */
  interactive?: boolean;
  hpChangeDelays: ReadonlyMap<number, number>;
  flipped?: boolean;
  /** スタックのドラッグ開始候補 (useCardDrag.press へ委譲) */
  onDragPress: (
    payload: DragPayload,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  canDropOnStack: (pos: StagePosition) => boolean;
  canDropOnSlot: (slot: "center" | "collab" | "backArea") => boolean;
  onStackClick: (player: PlayerId, pos: StagePosition) => void;
  onSupportClick: (player: PlayerId, pos: StagePosition, uid: string) => void;
  onCardPreview: (
    cardId: string,
    attachedCardIds?: string[],
    artworkKey?: string,
    attachedArtworkKeys?: (string | undefined)[],
  ) => void;
  canPreviewStack: (player: PlayerId, pos: StagePosition) => boolean;
  boardDroppable?: boolean;
  onOshiClick: () => void;
  onArchiveClick: (player: PlayerId) => void;
  selectedStack: { player: PlayerId; pos: StagePosition } | null;
  selectedOshiPlayer: PlayerId | null;
  actionClassFor: (uid: string) => string | undefined;
  targeting?: boolean;
  canSelectStack?: (player: PlayerId, pos: StagePosition) => boolean;
}) {
  const p = game.players[player];
  const own = interactive && player === seat;
  const isSel = (pos: StagePosition) =>
    selectedStack?.player === player && posEq(selectedStack.pos, pos);

  const stackView = (
    stack: HolomenStack | null,
    pos: StagePosition,
    label: string,
    slotKind?: "center" | "collab",
  ) => {
    const stackDroppable = !!stack && canDropOnStack(pos);
    const slotDroppable = !!slotKind && canDropOnSlot(slotKind);
    const droppable = stackDroppable || slotDroppable;
    return (
      <div
        className={`slot${targeting && stack ? (canSelectStack?.(player, pos) ? " target-candidate" : " target-unavailable") : ""}`}
        key={label}
      >
        <span className="slot-label">{label}</span>
        {stack ? (
          <div
            data-drop-player={player}
            data-drop-pos={dropPosAttr(pos)}
            data-drop-slot={slotKind}
          >
            <StackView
              game={game}
              stack={stack}
              hpStateChangeDelay={hpChangeDelays.get(stack.id) ?? 0}
              selected={isSel(pos)}
              onClick={
                stack.faceDown ? undefined : () => onStackClick(player, pos)
              }
              onSupportClick={(uid) => onSupportClick(player, pos, uid)}
              onCardPreview={onCardPreview}
              showPreview={canPreviewStack(player, pos)}
              draggable={own && !stack.faceDown}
              onDragPress={(event) =>
                onDragPress({ kind: "stack", pos }, event)
              }
              droppable={droppable}
              actionClassFor={actionClassFor}
            />
          </div>
        ) : (
          <div
            className={`slot-empty${droppable ? " drop-ok" : ""}`}
            data-drop-player={player}
            data-drop-slot={slotKind}
          />
        )}
      </div>
    );
  };

  const oshi = getCard(game.uidToCard[p.oshiUid]) as OshiCard;
  const backDroppable = own && canDropOnSlot("backArea");

  return (
    <div
      className={`board${flipped ? " flipped" : ""}${game.turnPlayer === player && game.phase === "playing" ? " board-active" : ""}${boardDroppable ? " drop-ok" : ""}`}
      data-player={player}
      data-drop-board=""
    >
      <div className="board-side board-resources-left">
        <Pile
          label="ライフ"
          count={p.life.length}
          back="yell"
          sideways
          zone="life"
        />
        <Pile
          label="エールデッキ"
          count={p.cheerDeck.length}
          back="yell"
          zone="cheerDeck"
        />
      </div>
      <div className="stage">
        <div className="stage-front">
          {stackView(p.collab, "collab", "コラボ", "collab")}
          {stackView(p.center, "center", "センター", "center")}
          <div
            className={`slot${targeting ? " target-unavailable" : ""}`}
            data-oshi-player={player}
          >
            <span className="slot-label">推し</span>
            <CardView
              cardId={oshi.id}
              artworkKey={game.uidToArtwork?.[p.oshiUid]}
              size="md"
              selected={selectedOshiPlayer === player}
              onClick={onOshiClick}
            />
          </div>
        </div>
        <div
          className={`stage-back${backDroppable ? " drop-ok" : ""}`}
          data-drop-player={player}
          data-drop-slot="backArea"
          style={
            {
              "--back-width-units": Math.max(
                1,
                Math.min(p.back.length + 1, 5) +
                  p.back.filter((st) => st.resting).length * 0.4,
              ),
              "--back-gap-total": `${Math.max(0, Math.min(p.back.length + 1, 5) - 1) * 8}px`,
            } as CSSProperties
          }
        >
          {p.back.map((st, i) => (
            <div
              key={st.id}
              className={`slot${targeting ? (canSelectStack?.(player, { back: i }) ? " target-candidate" : " target-unavailable") : ""}`}
            >
              <span className="slot-label">バック{i + 1}</span>
              <div
                data-drop-player={player}
                data-drop-pos={dropPosAttr({ back: i })}
              >
                <StackView
                  game={game}
                  stack={st}
                  hpStateChangeDelay={hpChangeDelays.get(st.id) ?? 0}
                  selected={isSel({ back: i })}
                  onClick={
                    st.faceDown
                      ? undefined
                      : () => onStackClick(player, { back: i })
                  }
                  onSupportClick={(uid) =>
                    onSupportClick(player, { back: i }, uid)
                  }
                  onCardPreview={onCardPreview}
                  showPreview={canPreviewStack(player, { back: i })}
                  draggable={own && !st.faceDown}
                  onDragPress={(event) =>
                    onDragPress({ kind: "stack", pos: { back: i } }, event)
                  }
                  droppable={canDropOnStack({ back: i })}
                  actionClassFor={actionClassFor}
                />
              </div>
            </div>
          ))}
          {p.back.length < 5 && (
            <div className="slot">
              <span className="slot-label">バック</span>
              <div className="slot-empty slot-ghost" />
            </div>
          )}
        </div>
      </div>
      <div className="board-side board-resources-right">
        <Pile
          label="ホロパワー"
          count={p.holoPower.length}
          back="holomen"
          sideways
          zone="holoPower"
        />
        <Pile label="デッキ" count={p.deck.length} back="holomen" zone="deck" />
        <ArchivePile
          game={game}
          archive={p.archive}
          onOpen={() => onArchiveClick(player)}
          actionClassFor={actionClassFor}
        />
      </div>
    </div>
  );
}

function Pile({
  label,
  count,
  back,
  sideways,
  zone,
}: {
  label: string;
  count: number;
  back: "holomen" | "yell";
  /** 公式プレイマットで横向きに置かれる山 (ライフ・ホロパワー) */
  sideways?: boolean;
  zone?: "deck" | "holoPower" | "life" | "cheerDeck";
}) {
  return (
    <div className="pile" data-zone={zone}>
      <span className="slot-label">{label}</span>
      {count > 0 ? (
        <div className={sideways ? "sideways-wrap" : undefined}>
          <CardView
            faceDown
            backKind={back}
            size="sm"
            title={`${count}枚`}
            className={sideways ? "card-sideways" : undefined}
          />
        </div>
      ) : (
        <div
          className={`slot-empty slot-sm${sideways ? " slot-sideways" : ""}`}
        />
      )}
      <span className="pile-count">{count}</span>
    </div>
  );
}

function ArchivePile({
  game,
  archive,
  onOpen,
  actionClassFor,
}: {
  game: GameState;
  archive: string[];
  onOpen: () => void;
  actionClassFor: (uid: string) => string | undefined;
}) {
  const top = archive[archive.length - 1];
  const empty = archive.length === 0;
  return (
    <div
      className={`pile${empty ? "" : " pile-clickable"}`}
      data-zone="archive"
      onClick={empty ? undefined : onOpen}
      role={empty ? undefined : "button"}
      tabIndex={empty ? undefined : 0}
      aria-label={`アーカイブ ${archive.length}枚を表示`}
      onKeyDown={(event) => {
        if (!empty && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        }
      }}
      title={empty ? undefined : "クリックでアーカイブを表示 (公開情報)"}
    >
      <span className="slot-label">アーカイブ</span>
      {top ? (
        <CardView
          cardId={game.uidToCard[top]}
          artworkKey={game.uidToArtwork?.[top]}
          size="sm"
          animationUid={top}
          animationZone="archive"
          className={actionClassFor(top)}
        />
      ) : (
        <div className="slot-empty slot-sm" />
      )}
      <span className="pile-count">{archive.length}</span>
    </div>
  );
}

/** 重なっているカードを重なって見えるように表示する */
function StackView({
  game,
  stack,
  hpStateChangeDelay,
  selected,
  onClick,
  onSupportClick,
  onCardPreview,
  showPreview,
  draggable,
  onDragPress,
  droppable,
  actionClassFor,
}: {
  game: GameState;
  stack: HolomenStack;
  hpStateChangeDelay: number;
  selected: boolean;
  onClick?: () => void;
  onSupportClick?: (uid: string) => void;
  onCardPreview: (
    cardId: string,
    attachedCardIds?: string[],
    artworkKey?: string,
    attachedArtworkKeys?: (string | undefined)[],
  ) => void;
  showPreview: boolean;
  draggable?: boolean;
  onDragPress?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  droppable?: boolean;
  actionClassFor: (uid: string) => string | undefined;
}) {
  const topCardId = game.uidToCard[stack.cards[0]];
  const card =
    !stack.faceDown && topCardId && topCardId !== "hidden"
      ? (getCard(topCardId) as HolomenCard)
      : null;
  const cardHidden = stack.faceDown || card === null;
  const previousVisibilityRef = useRef({
    stackId: stack.id,
    faceDown: stack.faceDown,
  });
  const previousOrientationRef = useRef({
    stackId: stack.id,
    resting: stack.resting,
  });
  const [revealing, setRevealing] = useState(false);
  const [orientationMotion, setOrientationMotion] = useState<
    "to-rest" | "to-active" | null
  >(null);

  useLayoutEffect(() => {
    const previous = previousVisibilityRef.current;
    previousVisibilityRef.current = {
      stackId: stack.id,
      faceDown: stack.faceDown,
    };
    if (stack.faceDown || previous.stackId !== stack.id) {
      setRevealing(false);
      return;
    }
    if (
      !previous.faceDown ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;

    setRevealing(true);
    const timer = window.setTimeout(
      () => setRevealing(false),
      STACK_REVEAL_DURATION,
    );
    return () => window.clearTimeout(timer);
  }, [stack.id, stack.faceDown]);

  useLayoutEffect(() => {
    const previous = previousOrientationRef.current;
    previousOrientationRef.current = {
      stackId: stack.id,
      resting: stack.resting,
    };
    if (
      previous.stackId !== stack.id ||
      previous.resting === stack.resting ||
      stack.faceDown ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setOrientationMotion(null);
      return;
    }

    setOrientationMotion(stack.resting ? "to-rest" : "to-active");
    const timer = window.setTimeout(
      () => setOrientationMotion(null),
      STACK_ORIENTATION_DURATION,
    );
    return () => window.clearTimeout(timer);
  }, [stack.id, stack.faceDown, stack.resting]);

  const topActionClass = actionClassFor(stack.cards[0]);
  const stackActionPending =
    topActionClass?.includes("card-action-pending") ?? false;
  const stackActionClass = stackActionPending
    ? " stack-action-pending"
    : topActionClass?.includes("card-action-arrived")
      ? " stack-action-arrived"
      : "";
  const bloomUnderlayUid = topActionClass?.includes("card-action-bloom")
    ? stack.cards[1]
    : undefined;
  const maxHp = cardHidden ? 0 : E.effectiveMaxHp(game, stack);
  const remainingHp = Math.max(0, maxHp - stack.damage);
  const hpDamageDelay = card
    ? artDamageDisplayDelay(game, stack.id, card.name)
    : 0;
  return (
    <div
      className={`stack-wrap${stack.resting ? " stack-resting" : ""}${stackActionClass}`}
      data-combat-stack-id={stack.id}
    >
      <div className={`stack-cards${droppable ? " drop-ok" : ""}`}>
        {bloomUnderlayUid && (
          <div className="stack-action-underlay" aria-hidden="true">
            <CardView
              cardId={game.uidToCard[bloomUnderlayUid]}
              artworkKey={game.uidToArtwork?.[bloomUnderlayUid]}
              faceDown={stack.faceDown}
              size="md"
              resting={stack.resting}
            />
          </div>
        )}
        <CardView
          cardId={topCardId}
          artworkKey={game.uidToArtwork?.[stack.cards[0]]}
          faceDown={cardHidden}
          size="md"
          selected={selected}
          resting={stack.resting}
          onClick={onClick}
          onDragPress={draggable ? onDragPress : undefined}
          animationUid={stack.cards[0]}
          animationZone="stage"
          className={`stack-top${revealing ? " stack-reveal-source" : ""}${orientationMotion ? ` stack-orientation-${orientationMotion}` : ""}${topActionClass ? ` ${topActionClass}` : ""}`}
        />
        {!cardHidden && card && showPreview && (
          <CardPreviewButton
            cardName={card.name}
            className="stage-card-zoom"
            onPreview={() =>
              onCardPreview(
                card.id,
                stack.supports.map((uid) => game.uidToCard[uid]),
                game.uidToArtwork?.[stack.cards[0]],
                stack.supports.map((uid) => game.uidToArtwork?.[uid]),
              )
            }
          />
        )}
        {revealing && card && (
          <div className="stack-reveal-overlay" aria-hidden="true">
            <div className="stack-reveal-flip">
              <div className="stack-reveal-face stack-reveal-front">
                <CardView
                  cardId={card.id}
                  artworkKey={game.uidToArtwork?.[stack.cards[0]]}
                  size="md"
                  resting={stack.resting}
                />
              </div>
              <div className="stack-reveal-face stack-reveal-back">
                <CardView faceDown backKind="holomen" size="md" />
              </div>
            </div>
          </div>
        )}
        {!cardHidden && stack.supports.length > 0 && (
          <div className="support-chips" aria-hidden={stackActionPending}>
            {stack.supports.map((uid, i) => {
              const c = getCard(game.uidToCard[uid]);
              const url = cardImageUrl(c.id, game.uidToArtwork?.[uid]);
              return (
                <img
                  key={uid}
                  className={`support-chip${onSupportClick ? " clickable" : ""}${actionClassFor(uid) ? ` ${actionClassFor(uid)}` : ""}`}
                  data-animation-uid={uid}
                  data-animation-zone="attached"
                  src={url ?? undefined}
                  alt={c.name}
                  title={`${c.name} (クリックで詳細)`}
                  style={{ top: i * 14 }}
                  draggable={false}
                  onClick={
                    onSupportClick
                      ? (e) => {
                          e.stopPropagation();
                          onSupportClick(uid);
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
      {!cardHidden && (
        <div className="stack-badges" aria-hidden={stackActionPending}>
          <HpBar
            current={remainingHp}
            max={maxHp}
            damageDelay={hpDamageDelay}
            stateChangeDelay={hpStateChangeDelay}
          />
          {stack.cards.length > 1 && (
            <span
              className="bloom-badge"
              title={`重なっているカード${stack.cards.length - 1}枚`}
            >
              ×{stack.cards.length}
            </span>
          )}
        </div>
      )}
      {!cardHidden && stack.yells.length > 0 && (
        <YellDots
          game={game}
          yells={stack.yells}
          actionClassFor={actionClassFor}
          hidden={stackActionPending}
        />
      )}
    </div>
  );
}

// ---------------- エール表示 ----------------

/** 合体ゴーストが1点へ集まるまでの時間 (yell-mergeアニメーションと同じ) */
const YELL_MERGE_DURATION = 380;
/** 合体後にまとめ表示がポップして現れる時間 */
const YELL_REVEAL_DURATION = 420;

type YellMergeStart = {
  uid: string;
  color: string;
  left: number;
  top: number;
};
type YellMergeGhost = YellMergeStart & { dx: number; dy: number };

function yellDotColor(game: GameState, uid: string): string {
  return yellColorHex((getCard(game.uidToCard[uid]) as { color: Color }).color);
}

/**
 * スタックに付いたエールのドット表示。
 * - 付与/移動で並び位置が変わるドットはFLIPでスライドさせる
 * - 混色または単色5枚以上で、色別の「●×n」表示へ切り替える
 * - まとめ表示中に付与されたエールは、付与演出の完了時にnが増える
 *   (飛行中のエールは card-action-pending の間はまだ数えない)
 */
function YellDots({
  game,
  yells,
  actionClassFor,
  hidden,
}: {
  game: GameState;
  yells: string[];
  actionClassFor: (uid: string) => string | undefined;
  hidden: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousOffsetsRef = useRef(
    new Map<string, { left: number; top: number }>(),
  );
  const mergeStartsRef = useRef<YellMergeStart[] | null>(null);
  const timersRef = useRef<number[]>([]);

  const settledUids = yells.filter(
    (uid) => !actionClassFor(uid)?.includes("card-action-pending"),
  );
  const settledCount = settledUids.length;
  const settledColors = settledUids.map((uid) => yellDotColor(game, uid));
  const shouldGroup = shouldGroupYells(settledColors);
  const shouldStayGrouped = shouldGroupYells(
    yells.map((uid) => yellDotColor(game, uid)),
  );

  const [collapsed, setCollapsed] = useState(shouldGroup);
  const [ghosts, setGhosts] = useState<YellMergeGhost[] | null>(null);
  const [revealing, setRevealing] = useState(false);
  const arrivedUid = yells.find(
    (uid) => actionClassFor(uid) === "card-action-arrived",
  );
  const arrivedColor = arrivedUid ? yellDotColor(game, arrivedUid) : null;
  const animationUid = yells.find((uid) => actionClassFor(uid));
  const animationColor = animationUid ? yellDotColor(game, animationUid) : null;

  // 展開表示: 前回と位置が変わったドットを旧位置から新位置へスライドさせる
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (collapsed || !container) {
      previousOffsetsRef.current = new Map();
      return;
    }
    const previous = previousOffsetsRef.current;
    const next = new Map<string, { left: number; top: number }>();
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    for (const el of container.querySelectorAll<HTMLElement>(
      "[data-yell-uid]",
    )) {
      const uid = el.dataset.yellUid;
      if (!uid) continue;
      const offset = { left: el.offsetLeft, top: el.offsetTop };
      next.set(uid, offset);
      const before = previous.get(uid);
      if (
        reduceMotion ||
        !before ||
        (before.left === offset.left && before.top === offset.top) ||
        actionClassFor(uid) // 付与/移動演出中のドットは演出側に任せる
      )
        continue;
      el.animate(
        [
          {
            transform: `translate(${before.left - offset.left}px, ${before.top - offset.top}px)`,
          },
          { transform: "translate(0, 0)" },
        ],
        { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
      );
    }
    previousOffsetsRef.current = next;
  });

  // まとめ表示の条件を満たしたら、現在のドット位置を覚えて切り替える。
  // 付与直後は演出フックがcard-action-pendingを付ける前の一瞬だけ
  // settledCountが実際より多く見えるため、判定を1タスク遅らせて
  // (その間に値が変わればクリーンアップでキャンセルされる) 誤発動を防ぐ
  useEffect(() => {
    if (collapsed || !shouldGroup) return;
    const timer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== timer);
      const container = containerRef.current;
      if (
        container &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        mergeStartsRef.current = [
          ...container.querySelectorAll<HTMLElement>("[data-yell-uid]"),
        ]
          .filter((el) => !el.classList.contains("card-action-pending"))
          .map((el) => ({
            uid: el.dataset.yellUid ?? "",
            color: yellDotColor(game, el.dataset.yellUid ?? ""),
            left: el.offsetLeft,
            top: el.offsetTop,
          }));
      }
      setCollapsed(true);
    }, 0);
    timersRef.current.push(timer);
    return () => {
      window.clearTimeout(timer);
      timersRef.current = timersRef.current.filter((t) => t !== timer);
    };
  }, [collapsed, game, settledCount, shouldGroup]);

  // まとめ表示へ切り替わった直後: 覚えた位置からまとめドットの位置へ合体するゴーストを飛ばす
  useLayoutEffect(() => {
    const starts = mergeStartsRef.current;
    if (!collapsed || !starts) return;
    mergeStartsRef.current = null;
    const container = containerRef.current;
    if (!container || starts.length === 0) return;
    const targets = [
      ...container.querySelectorAll<HTMLElement>("[data-yell-color]"),
    ];
    if (targets.length === 0) return;
    setGhosts(
      starts.map((start) => {
        const target =
          targets.find((item) => item.dataset.yellColor === start.color) ??
          targets[0];
        return {
          ...start,
          dx: target.offsetLeft - start.left,
          dy: target.offsetTop - start.top,
        };
      }),
    );
    const mergeTimer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== mergeTimer);
      setGhosts(null);
      setRevealing(true);
      const revealTimer = window.setTimeout(() => {
        timersRef.current = timersRef.current.filter((t) => t !== revealTimer);
        setRevealing(false);
      }, YELL_REVEAL_DURATION);
      timersRef.current.push(revealTimer);
    }, YELL_MERGE_DURATION);
    timersRef.current.push(mergeTimer);
  }, [collapsed]);

  // エールが減って条件を満たさなくなったら展開表示へ戻す
  useEffect(() => {
    if (collapsed && !shouldStayGrouped) {
      setCollapsed(false);
      setGhosts(null);
    }
  }, [collapsed, shouldStayGrouped]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  if (collapsed) {
    const visibleUids = settledUids.length > 0 ? settledUids : yells;
    const visibleCounts = new Map(
      groupYellColors(visibleUids.map((uid) => yellDotColor(game, uid))).map(
        ({ color, count }) => [color, count],
      ),
    );
    const groups = groupYellColors(
      yells.map((uid) => yellDotColor(game, uid)),
    ).map(({ color }) => ({
      color,
      count: visibleCounts.get(color) ?? 0,
    }));
    return (
      <div
        ref={containerRef}
        className={`yell-dots yell-dots-collapsed${ghosts ? " yell-merging" : ""}`}
        aria-hidden={hidden}
      >
        {groups.map(({ color, count }) => {
          const isArriving = arrivedColor === color;
          return (
            <span
              key={color}
              data-yell-color={color}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                visibility: count === 0 ? "hidden" : undefined,
              }}
            >
              <span
                className={`yell-dot yell-collapsed-dot${revealing ? " yell-collapsed-reveal" : ""}${!ghosts && !revealing && isArriving ? " yell-collapsed-pulse" : ""}`}
                data-animation-uid={
                  animationColor === color ? animationUid : undefined
                }
                data-animation-zone="yell"
                style={{ background: color }}
              />
              <span
                className={`yell-count${revealing ? " yell-count-reveal" : ""}${!ghosts && !revealing && isArriving ? " yell-count-pop" : ""}`}
              >
                ×{count}
              </span>
            </span>
          );
        })}
        {ghosts?.map((ghost) => (
          <span
            key={ghost.uid}
            className="yell-dot yell-merge-ghost"
            style={
              {
                left: ghost.left,
                top: ghost.top,
                background: yellDotColor(game, ghost.uid),
                "--yell-merge-dx": `${ghost.dx}px`,
                "--yell-merge-dy": `${ghost.dy}px`,
              } as CSSProperties
            }
          />
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="yell-dots" aria-hidden={hidden}>
      {yells.map((uid) => (
        <span
          key={uid}
          data-yell-uid={uid}
          className={`yell-dot${actionClassFor(uid) ? ` ${actionClassFor(uid)}` : ""}`}
          data-animation-uid={uid}
          data-animation-zone="yell"
          style={{ background: yellDotColor(game, uid) }}
        />
      ))}
    </div>
  );
}
