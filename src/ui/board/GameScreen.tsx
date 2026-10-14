import { EffectPickDialog } from "./dialogs/EffectPickDialog";
import {
  EffectChoice,
  EffectInfoDialog,
  EffectResolutionGuide,
  abilityInfo,
  replacementInfo,
  resolutionInfo,
} from "./dialogs/EffectResolutionGuide";
import type { EffectInfo } from "./dialogs/EffectResolutionGuide";
import { HandArea } from "./HandArea";
import { GameMenu } from "./GameMenu";
import type { Selection, MulliganVisualHand } from "./types";
export type { DeckFlightGeometry } from "../effects/drawFlights";
// 対戦画面の表示・操作：screen。
import { getCard, yellColorHex } from "../../data/loader";
import type { SupportCard, Color } from "../../data/types";
import { validateGameAction } from "../../game/actions";
import type { GameAction } from "../../game/actions";
import * as E from "../../game/engine";
import type {
  PlayerId,
  StagePosition,
  GameState,
  Prompt,
} from "../../game/types";
import { CardDescription } from "../cards/CardDescription";
import { CloseIcon, CardPreviewButton } from "../cards/CardPreviewButton";
import { CheerChip, CardView } from "../cards/CardView";
import { GameCardDetail, GameDetailPanel } from "../cards/GameCardDetail";
import { OshiDetail } from "../cards/OshiDetail";
import { GameActionButton } from "../common/GameActionButton";
import { useModalFocus } from "../common/useModalFocus";
import {
  useCardActionAnimations,
  CardActionAnimationLayer,
} from "../effects/CardActionEffects";
import {
  useCombatAnimations,
  CombatAnimationLayer,
} from "../effects/CombatEffects";
import {
  useGameFlowAnimations,
  GameFlowAnimationLayer,
} from "../effects/GameFlowEffects";
import {
  useOshiSkillAnimations,
  OshiSkillAnimationLayer,
} from "../effects/OshiSkillEffects";
import {
  useResolutionAnimations,
  ResolutionAnimationLayer,
} from "../effects/ResolutionEffects";
import {
  useStateChangeAnimations,
  StateChangeAnimationLayer,
} from "../effects/StateChangeEffects";
import {
  isPrivateDrawUid,
  drawnCardsSince,
  returnedHandsSince,
  drawAnimationDuration,
  drawZoneSnapshot,
  mulliganHandReturnLead,
  mulliganDrawBatches,
  MULLIGAN_RETURN_STAGGER_MS,
  MULLIGAN_RETURN_DURATION_MS,
  DRAW_FLIGHT_REMOVE_BUFFER_MS,
  MULLIGAN_BATCH_INTERVAL_MS,
  DRAW_CARD_STAGGER_MS,
  drawAnimationCardId,
  drawAnimationArtworkKey,
  DRAW_FLIGHT_DURATION,
  MULLIGAN_RETURN_START_MS,
} from "../effects/drawAnimations";
import type { DrawZoneSnapshot } from "../effects/drawAnimations";
import { deckFlightGeometry, DrawAnimationLayer } from "../effects/drawFlights";
import type { DrawFlight } from "../effects/drawFlights";
import { PlayerBoard } from "./PlayerBoard";
import type { DragPayload } from "./PlayerBoard";
import { GameLogDialog } from "./dialogs/GameLogDialog";
import { GameSidebar } from "./GameSidebar";
import { pickGuidance } from "./dialogs/pickGuidance";
import {
  selectableStackIds,
  attachedSupportCardId,
  actionPhaseReason,
  supportPlayabilityReason,
  handTargetFailures,
} from "./gameSelection";
import { sortHandForDisplay } from "./handDisplay";
import { toggleBoundedSelection } from "./selection";
import { useCardDrag } from "./useCardDrag";
import { useCompactGameLayout } from "./useCompactGameLayout";
import { useState, useRef, useMemo, useEffect, useLayoutEffect } from "react";

/** アーツの対象選択モード */
type ArtMode = { fromPos: "center" | "collab"; artIndex: number } | null;

/** バトンタッチ時にアーカイブするエールを選んでいる状態 */
type BatonPayment = {
  backIndex: number;
  required: number;
  selected: Set<string>;
} | null;

const STEP_LABELS: Record<string, string> = {
  reset: "リセット",
  draw: "手札",
  cheer: "エール",
  main: "メイン",
  performance: "パフォーマンス",
  end: "エンド",
};

type CardPreviewState = {
  cardId: string;
  attachedCardIds: string[];
  attachedArtworkKeys?: (string | undefined)[];
  artworkKey?: string;
};

/** 引き直し前の手札を戻している間の、どのドローバッチにも属さない空の手札 */
const HAND_RETURN_BATCH_INDEX = -1;

type HandCardPosition = { left: number; top: number };

const HAND_REFLOW_DURATION = 300;

const HAND_DRAW_REFLOW_DELAY = 360;

const HAND_DRAW_REFLOW_DURATION = 560;

function scrollHandCardIntoView(handCards: HTMLElement, handCard: HTMLElement) {
  const containerRect = handCards.getBoundingClientRect();
  const cardRect = handCard.getBoundingClientRect();
  const inset = 8;
  if (cardRect.left < containerRect.left + inset)
    handCards.scrollLeft -= containerRect.left + inset - cardRect.left;
  else if (cardRect.right > containerRect.right - inset)
    handCards.scrollLeft += cardRect.right - (containerRect.right - inset);
}

export function GameScreen({
  game,
  sendAction,
  actionError,
  seat,
  spectator = false,
  onExit,
  onHome,
  onRematch,
  exitLabel,
}: {
  game: GameState;
  /** 操作をサーバーへ送り、サーバー確定状態の受信を待つ */
  sendAction: (action: GameAction) => void;
  /** サーバーが競合・権限・ルール違反で操作を拒否した時の通知 */
  actionError?: { id: number; message: string } | null;
  /** 表示視点の席。観戦時は下側に表示するプレイヤー */
  seat: PlayerId;
  /** 観戦モード: 全操作を無効化し、両者の手札を伏せて表示する */
  spectator?: boolean;
  onExit: () => void;
  /** スマホのメニューから、対戦を保存してホームへ戻る。 */
  onHome?: () => void;
  /** CPU対戦用: 勝敗画面に「もう一戦」を出す (オンラインでは未指定) */
  onRematch?: () => void;
  /** 勝敗画面の退出ボタンの文言 (既定は「ロビーへ戻る」) */
  exitLabel?: string;
}) {
  const compact = useCompactGameLayout();
  const [logOpen, setLogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [multiSelect, setMultiSelect] = useState<Set<string>>(new Set());
  const [cardPreview, setCardPreview] = useState<CardPreviewState | null>(null);
  const [effectInfo, setEffectInfo] = useState<EffectInfo | null>(null);
  const [inspectedCard, setInspectedCard] = useState<CardPreviewState | null>(
    null,
  );
  const [hiddenPickPromptKey, setHiddenPickPromptKey] = useState<string | null>(
    null,
  );
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const [artMode, setArtMode] = useState<ArtMode>(null);
  const [batonMode, setBatonMode] = useState(false);
  const [batonPayment, setBatonPayment] = useState<BatonPayment>(null);
  /** タップ2段階操作: 手札カードの対象 (Bloom先/付与先) を選んでいる状態 */
  const [handTargetMode, setHandTargetMode] = useState<{
    kind: "bloom" | "attach";
    uid: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // アーカイブは公開情報。クリックで両プレイヤーの中身を一覧表示する
  const [archiveView, setArchiveView] = useState<PlayerId | null>(null);
  const archiveRef = useRef<HTMLDivElement>(null);
  const batonPaymentRef = useRef<HTMLDivElement>(null);
  const cardPreviewRef = useRef<HTMLDivElement>(null);
  useModalFocus(archiveRef, {
    active: archiveView !== null,
    onEscape: () => setArchiveView(null),
  });
  useModalFocus(batonPaymentRef, {
    active: batonPayment !== null,
    onEscape: () => setBatonPayment(null),
  });
  useModalFocus(cardPreviewRef, {
    active: cardPreview !== null,
    onEscape: () => setCardPreview(null),
  });
  const [drawFlights, setDrawFlights] = useState<DrawFlight[]>([]);
  const [drawingUids, setDrawingUids] = useState<Set<string>>(new Set());
  const [mulliganVisualHand, setMulliganVisualHand] =
    useState<MulliganVisualHand | null>(null);
  const [deferredLogIds, setDeferredLogIds] = useState<Set<number>>(new Set());
  const combatEffects = useCombatAnimations(game);
  const oshiSkillEffects = useOshiSkillAnimations(game);
  const resolutionEffects = useResolutionAnimations(game);
  const { effects: stateChangeEffects, hpChangeDelays } =
    useStateChangeAnimations(game);
  const logRef = useRef<HTMLDivElement>(null);
  const previousDrawZonesRef = useRef<DrawZoneSnapshot | null>(null);
  const previousHandPositionsRef = useRef<Map<string, HandCardPosition>>(
    new Map(),
  );
  const handReflowAnimationsRef = useRef<Map<string, Animation>>(new Map());
  const drawTimersRef = useRef<number[]>([]);
  const drawingUidDeadlinesRef = useRef<Map<string, number>>(new Map());
  const {
    flights: actionFlights,
    hiddenUids: hiddenActionUids,
    hiddenKinds: hiddenActionKinds,
    arrivedUids: arrivedActionUids,
    captureActionRects,
  } = useCardActionAnimations(game, seat);
  const actionClassFor = (uid: string) =>
    hiddenActionUids.has(uid)
      ? `card-action-pending card-action-${hiddenActionKinds.get(uid) ?? "move"}`
      : arrivedActionUids.has(uid)
        ? "card-action-arrived"
        : undefined;
  const openCardPreview = (
    cardId: string,
    attachedCardIds: string[] = [],
    artworkKey?: string,
    attachedArtworkKeys?: (string | undefined)[],
  ) =>
    setCardPreview({
      cardId,
      attachedCardIds,
      artworkKey,
      attachedArtworkKeys,
    });

  // 確認するカードを対象選択の操作元と分け、確認後も元の選択を続けられるようにする。
  const inspectUnavailableCard = (
    cardId: string,
    attachedCardIds: string[] = [],
    artworkKey?: string,
    attachedArtworkKeys?: (string | undefined)[],
  ) => {
    if (compact)
      openCardPreview(cardId, attachedCardIds, artworkKey, attachedArtworkKeys);
    else
      setInspectedCard({
        cardId,
        attachedCardIds,
        artworkKey,
        attachedArtworkKeys,
      });
  };

  // Pointer Eventsによるドラッグ (マウス/タッチ両対応)。
  // ゴーストや長押し判定はフック側、ドロップ先の解決は performDrop が担う
  const cardDrag = useCardDrag({
    onDragStart: (payload) => setDrag(payload),
    onDrop: (payload, element) => {
      setDrag(null);
      performDrop(payload, element);
    },
    onCancel: () => setDrag(null),
  });

  const opp: PlayerId = seat === 0 ? 1 : 0;
  const me = game.players[seat];
  const displayedHand = mulliganVisualHand?.uids ?? me.hand;
  const sortedHand = useMemo(
    () =>
      spectator
        ? []
        : mulliganVisualHand?.uids.some(isPrivateDrawUid)
          ? [...displayedHand]
          : sortHandForDisplay(displayedHand, game.uidToCard),
    [spectator, displayedHand, game.uidToCard, mulliganVisualHand],
  );
  const drawMotionEnabled =
    typeof window !== "undefined" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const previousDrawZones = previousDrawZonesRef.current;
  const newlyDrawn =
    drawMotionEnabled && previousDrawZones
      ? drawnCardsSince(previousDrawZones, game)
      : [];
  const newlyReturnedHand = previousDrawZones
    ? returnedHandsSince(previousDrawZones, newlyDrawn)
    : [];
  const { effects: gameFlowEffects, resultPending } = useGameFlowAnimations(
    game,
    seat,
    game.phase === "finished"
      ? drawAnimationDuration(newlyDrawn, newlyReturnedHand)
      : 0,
  );
  const resultRef = useRef<HTMLDivElement>(null);
  useModalFocus(resultRef, {
    active: game.phase === "finished" && !resultPending,
  });
  const pendingDrawUids = new Set(drawingUids);
  for (const uid of mulliganVisualHand?.hiddenUids ?? [])
    pendingDrawUids.add(uid);
  const enteringDrawUids = new Set<string>();
  if (drawMotionEnabled)
    for (const { player, uid } of newlyDrawn)
      if (!spectator && player === seat) {
        pendingDrawUids.add(uid);
        enteringDrawUids.add(uid);
      }
  const handLayoutKey = sortedHand.join("|");
  const visibleGameLog = game.log.filter((log) => !deferredLogIds.has(log.id));
  const latestLogId = visibleGameLog.at(-1)?.id ?? 0;
  const prompt: Prompt | undefined = game.prompts[0];
  // 観戦時はプロンプトを自分のものとして扱わない (操作UIも演出タイマーの解決も
  // プレイヤーの窓に任せる)
  const myPrompt =
    !spectator && prompt && prompt.player === seat ? prompt : undefined;
  const effectPromptKey = myPrompt ? JSON.stringify(myPrompt) : null;
  const inspectingDuringResolution =
    !!prompt &&
    [
      "triggerAbilityChoice",
      "damageReplacementChoice",
      "ruleAbilityChoice",
      "ruleDownChoice",
      "effectConfirm",
      "reactiveSkill",
    ].includes(prompt.type);
  useEffect(() => setEffectInfo(null), [effectPromptKey, compact]);
  const pickPromptKey =
    myPrompt?.type === "effectPickCard" ? JSON.stringify(myPrompt) : null;
  const multiSelectPromptKey =
    myPrompt?.type === "effectPickCard" ||
    myPrompt?.type === "effectArchiveHand" ||
    myPrompt?.type === "mulliganPenalty"
      ? `${game.rev}:${JSON.stringify(myPrompt)}`
      : null;
  const isPickModalHidden =
    pickPromptKey !== null && hiddenPickPromptKey === pickPromptKey;
  const myTurn = !spectator && game.turnPlayer === seat;
  const isMain =
    game.phase === "playing" && game.step === "main" && !prompt && myTurn;
  const isPerf =
    game.phase === "playing" &&
    game.step === "performance" &&
    !prompt &&
    myTurn;

  const selectingStack = !!(
    artMode ||
    batonMode ||
    handTargetMode ||
    (myPrompt &&
      ["cheerAssign", "chooseCenter", "effectTarget", "effectAttach"].includes(
        myPrompt.type,
      ))
  );
  const selectingHand =
    !!myPrompt &&
    [
      "placeCenter",
      "placeBack",
      "mulliganPenalty",
      "effectArchiveHand",
    ].includes(myPrompt.type);
  const targetStackIds = selectableStackIds(game, seat, {
    art: artMode,
    baton: batonMode,
    hand: handTargetMode,
    prompt: myPrompt,
  });
  const canSelectStack = (player: PlayerId, pos: StagePosition) => {
    const stack = E.getStack(game.players[player], pos);
    return !!stack && !stack.faceDown && targetStackIds.has(stack.id);
  };

  useEffect(() => {
    setInspectedCard(null);
  }, [selection, selectingStack, selectingHand, game.rev]);

  useEffect(() => {
    if (selectingStack || myPrompt) {
      setLogOpen(false);
    }
  }, [selectingStack, myPrompt]);
  useEffect(() => {
    if (!isMain) setHandTargetMode(null);
    if (!isPerf) setArtMode(null);
  }, [isMain, isPerf]);

  // 成功して次の状態へ進んだ時だけ選択を破棄する。サーバー拒否で同じrev・
  // 同じプロンプトが戻った場合は、選び直しにならないよう保持する。
  useEffect(() => {
    setMultiSelect(new Set());
  }, [multiSelectPromptKey]);

  useEffect(() => {
    if (
      (selection?.kind === "support" &&
        !attachedSupportCardId(game, selection)) ||
      (selection?.kind === "hand" && !me.hand.includes(selection.uid)) ||
      (selection?.kind === "stack" &&
        !E.getStack(game.players[selection.player], selection.pos))
    )
      setSelection(null);
  }, [game, selection]);

  useEffect(() => {
    if (!isMain) {
      setBatonMode(false);
      setBatonPayment(null);
    }
  }, [isMain]);
  useEffect(() => {
    if (hiddenPickPromptKey !== null && hiddenPickPromptKey !== pickPromptKey)
      setHiddenPickPromptKey(null);
  }, [hiddenPickPromptKey, pickPromptKey]);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [latestLogId]);

  useLayoutEffect(() => {
    const previous = previousDrawZonesRef.current;
    previousDrawZonesRef.current = drawZoneSnapshot(game);
    if (!previous || !drawMotionEnabled) return;

    const drawn = drawnCardsSince(previous, game);
    if (drawn.length === 0) return;

    const returnedHand = returnedHandsSince(previous, drawn);
    const handReturnLead = mulliganHandReturnLead(returnedHand);
    // 手札は表示順に並べて描いている。戻していくカードも、直前まで自分が
    // 置かれていたスロットから飛ばすため同じ並びへそろえる。
    const handReturnSlots = new Map<string, number>();
    const ownReturnCardIds: Record<string, string> = {};
    const ownReturnUids: string[] = [];
    for (const { player, uid, cardId } of returnedHand) {
      if (spectator || player !== seat) continue;
      if (cardId === undefined) {
        ownReturnUids.length = 0;
        break;
      }
      ownReturnCardIds[uid] = cardId;
      ownReturnUids.push(uid);
    }
    sortHandForDisplay(ownReturnUids, ownReturnCardIds).forEach((uid, slot) =>
      handReturnSlots.set(uid, slot),
    );

    const mulliganBatches = mulliganDrawBatches(drawn);
    const ownMulliganBatches = mulliganBatches.filter(
      ({ player }) => !spectator && player === seat,
    );
    const sortedBatchHands = new Map(
      ownMulliganBatches.map((batch) => [
        batch.batchIndex,
        batch.uids.some(isPrivateDrawUid)
          ? batch.uids
          : sortHandForDisplay(batch.uids, game.uidToCard),
      ]),
    );

    const handCards = document.querySelector<HTMLElement>(".hand-cards");
    const ownDraws = drawn.filter(({ player }) => player === seat);
    const lastOwnDraw = ownDraws.at(-1);
    const lastOwnDrawCard = lastOwnDraw
      ? document.querySelector<HTMLElement>(
          `[data-hand-uid="${lastOwnDraw.uid}"]`,
        )
      : null;
    if (handCards && lastOwnDrawCard)
      scrollHandCardIntoView(handCards, lastOwnDrawCard);
    const handSlotRects = handCards
      ? Array.from(
          handCards.querySelectorAll<HTMLElement>("[data-hand-uid]"),
          (element) => element.getBoundingClientRect(),
        )
      : [];

    const deckElement = (player: PlayerId) =>
      document.querySelector<HTMLElement>(
        `[data-player="${player}"] [data-zone="deck"]`,
      );
    const handSlotRect = (index: number) =>
      handSlotRects.length === 0
        ? undefined
        : handSlotRects[Math.min(index, handSlotRects.length - 1)];

    // 引き直し前から持っていた手札を、最初のドローより先に山札へ戻す。
    // 戻した後の状態にはカードが残らないため、座標は同数の現手札スロットを使う。
    const handReturnFlights = returnedHand.flatMap<DrawFlight>(
      ({ player, uid, cardId, artworkKey, cardIndex }, index) => {
        const source = deckElement(player);
        if (!source) return [];

        const own = !spectator && player === seat;
        const slotIndex = handReturnSlots.get(uid) ?? cardIndex;
        const geometry = deckFlightGeometry(
          source.getBoundingClientRect(),
          source.closest<HTMLElement>(".board")?.getBoundingClientRect(),
          own ? handSlotRect(slotIndex) : undefined,
          own,
        );
        const delay = slotIndex * MULLIGAN_RETURN_STAGGER_MS;
        return [
          {
            id: `${game.rev}-${player}-${uid}-${index}-hand-return`,
            kind: "handReturn",
            uid,
            cardId: own ? cardId : undefined,
            artworkKey: own ? artworkKey : undefined,
            player,
            own,
            redraw: true,
            batchIndex: -1,
            startX: geometry.handX,
            startY: geometry.handY,
            controlX:
              geometry.handX +
              (geometry.deckX - geometry.handX) * 0.48 +
              (own ? 18 : -18),
            controlY: geometry.controlY,
            endX: geometry.deckX,
            endY: geometry.deckY,
            width: geometry.width,
            height: geometry.height,
            duration: MULLIGAN_RETURN_DURATION_MS,
            delay,
            removeDelay:
              delay +
              MULLIGAN_RETURN_DURATION_MS +
              DRAW_FLIGHT_REMOVE_BUFFER_MS,
            holdAtDestination: false,
          },
        ];
      },
    );

    const batchFlights = drawn.flatMap<DrawFlight>(
      ({ player, uid, batchIndex, cardIndex, redraw }, index) => {
        const source = deckElement(player);
        if (!source) return [];

        const own = !spectator && player === seat;
        const finalRedrawBatch =
          redraw &&
          !drawn.some(
            (card) =>
              card.redraw &&
              card.player === player &&
              card.batchIndex > batchIndex,
          );
        const sortedBatchHand = sortedBatchHands.get(batchIndex);
        const currentHandIndex = redraw
          ? (sortedBatchHand?.indexOf(uid) ?? -1)
          : sortedHand.indexOf(uid);
        const targetSlotIndex =
          currentHandIndex >= 0 ? currentHandIndex : cardIndex;
        const batchStart =
          handReturnLead + batchIndex * MULLIGAN_BATCH_INTERVAL_MS;
        const delay = batchStart + cardIndex * DRAW_CARD_STAGGER_MS;
        const handCard =
          own && !redraw
            ? document.querySelector<HTMLElement>(`[data-hand-uid="${uid}"]`)
            : null;
        const {
          deckX: startX,
          deckY: startY,
          handX: endX,
          handY: endY,
          controlY,
          width,
          height,
        } = deckFlightGeometry(
          source.getBoundingClientRect(),
          source.closest<HTMLElement>(".board")?.getBoundingClientRect(),
          handCard?.getBoundingClientRect() ??
            (own ? handSlotRects[targetSlotIndex] : undefined),
          own,
        );
        const controlX = startX + (endX - startX) * 0.52 + (own ? -18 : 18);

        const drawFlight: DrawFlight = {
          id: `${game.rev}-${batchIndex}-${player}-${uid}-${index}-draw`,
          kind: "draw",
          uid,
          cardId: drawAnimationCardId(game.uidToCard, uid),
          artworkKey: drawAnimationArtworkKey(game.uidToArtwork, uid),
          player,
          own,
          redraw,
          batchIndex,
          startX,
          startY,
          controlX,
          controlY,
          endX,
          endY,
          width,
          height,
          duration: DRAW_FLIGHT_DURATION,
          delay,
          removeDelay:
            DRAW_FLIGHT_DURATION + delay + DRAW_FLIGHT_REMOVE_BUFFER_MS,
          holdAtDestination: false,
        };
        if (!redraw || finalRedrawBatch) return [drawFlight];

        const returnDelay =
          batchStart +
          MULLIGAN_RETURN_START_MS +
          cardIndex * MULLIGAN_RETURN_STAGGER_MS;
        const returnControlX = endX + (startX - endX) * 0.48 + (own ? 18 : -18);
        return [
          drawFlight,
          {
            id: `${game.rev}-${batchIndex}-${player}-${uid}-${index}-return`,
            kind: "return",
            uid,
            cardId: drawAnimationCardId(game.uidToCard, uid),
            artworkKey: drawAnimationArtworkKey(game.uidToArtwork, uid),
            player,
            own,
            redraw,
            batchIndex,
            startX: endX,
            startY: endY,
            controlX: returnControlX,
            controlY,
            endX: startX,
            endY: startY,
            width,
            height,
            duration: MULLIGAN_RETURN_DURATION_MS,
            delay: returnDelay,
            removeDelay:
              returnDelay +
              MULLIGAN_RETURN_DURATION_MS +
              DRAW_FLIGHT_REMOVE_BUFFER_MS,
            holdAtDestination: false,
          },
        ];
      },
    );
    const flights = [...handReturnFlights, ...batchFlights];
    if (flights.length === 0) {
      // 前回状態から導出した一時的な非表示を解除するため再描画する。
      setDrawingUids((current) => new Set(current));
      return;
    }

    // 戻す演出の間、手札は空になっている。飛んでいるカードと二重に見せない。
    if (handReturnLead > 0 && ownMulliganBatches.length > 0)
      setMulliganVisualHand({
        rev: game.rev,
        batchIndex: HAND_RETURN_BATCH_INDEX,
        uids: [],
        hiddenUids: new Set(),
      });

    for (const batch of ownMulliganBatches) {
      const sortedUids = sortedBatchHands.get(batch.batchIndex) ?? batch.uids;
      const showBatch = () =>
        setMulliganVisualHand({
          rev: game.rev,
          batchIndex: batch.batchIndex,
          uids: sortedUids,
          hiddenUids: new Set(sortedUids),
        });
      const delay =
        handReturnLead + batch.batchIndex * MULLIGAN_BATCH_INTERVAL_MS;
      if (delay === 0) showBatch();
      else {
        const timer = window.setTimeout(() => {
          drawTimersRef.current = drawTimersRef.current.filter(
            (current) => current !== timer,
          );
          showBatch();
        }, delay);
        drawTimersRef.current.push(timer);
      }
    }

    const finalOwnBatch = ownMulliganBatches.at(-1);
    if (finalOwnBatch) {
      const clearDelay =
        handReturnLead +
        finalOwnBatch.batchIndex * MULLIGAN_BATCH_INTERVAL_MS +
        MULLIGAN_RETURN_START_MS;
      const timer = window.setTimeout(() => {
        drawTimersRef.current = drawTimersRef.current.filter(
          (current) => current !== timer,
        );
        setMulliganVisualHand((current) =>
          current?.rev === game.rev &&
          current.batchIndex === finalOwnBatch.batchIndex
            ? null
            : current,
        );
      }, clearDelay);
      drawTimersRef.current.push(timer);
    }

    const logRevealSchedule = new Map<number, number>();
    const redrawLogIds = new Set<number>();
    for (const batch of mulliganBatches) {
      if (batch.logId === undefined) continue;
      redrawLogIds.add(batch.logId);
      const delay =
        handReturnLead + batch.batchIndex * MULLIGAN_BATCH_INTERVAL_MS;
      if (delay > 0) logRevealSchedule.set(batch.logId, delay);
    }
    const sequenceEnd = drawAnimationDuration(drawn, returnedHand);
    for (const entry of game.log)
      if (
        entry.id > previous.lastLogId &&
        !redrawLogIds.has(entry.id) &&
        sequenceEnd > 0
      )
        logRevealSchedule.set(entry.id, sequenceEnd);
    if (logRevealSchedule.size > 0) {
      setDeferredLogIds((current) => {
        const next = new Set(current);
        for (const logId of logRevealSchedule.keys()) next.add(logId);
        return next;
      });
      for (const [logId, delay] of logRevealSchedule) {
        const timer = window.setTimeout(() => {
          drawTimersRef.current = drawTimersRef.current.filter(
            (current) => current !== timer,
          );
          setDeferredLogIds((current) => {
            const next = new Set(current);
            next.delete(logId);
            return next;
          });
        }, delay);
        drawTimersRef.current.push(timer);
      }
    }

    setDrawFlights((current) => [...current, ...flights]);
    setDrawingUids((current) => {
      const next = new Set(current);
      for (const flight of flights)
        if (flight.own && !flight.redraw) next.add(flight.uid);
      return next;
    });

    const now = Date.now();
    for (const flight of flights) {
      if (!flight.own || flight.redraw) continue;
      const deadline = now + flight.removeDelay;
      const currentDeadline =
        drawingUidDeadlinesRef.current.get(flight.uid) ?? 0;
      drawingUidDeadlinesRef.current.set(
        flight.uid,
        Math.max(currentDeadline, deadline),
      );
    }

    for (const flight of flights) {
      const deadline = now + flight.removeDelay;
      const timer = window.setTimeout(() => {
        drawTimersRef.current = drawTimersRef.current.filter(
          (current) => current !== timer,
        );
        setDrawFlights((current) =>
          current.filter((item) => item.id !== flight.id),
        );
        if (flight.own && flight.redraw && flight.kind === "draw")
          setMulliganVisualHand((current) => {
            if (
              !current ||
              current.rev !== game.rev ||
              current.batchIndex !== flight.batchIndex
            )
              return current;
            const hiddenUids = new Set(current.hiddenUids);
            hiddenUids.delete(flight.uid);
            return { ...current, hiddenUids };
          });
        if (
          flight.own &&
          !flight.redraw &&
          drawingUidDeadlinesRef.current.get(flight.uid) === deadline
        ) {
          drawingUidDeadlinesRef.current.delete(flight.uid);
          setDrawingUids((current) => {
            const next = new Set(current);
            next.delete(flight.uid);
            return next;
          });
        }
      }, deadline - now);
      drawTimersRef.current.push(timer);

      if (flight.own && flight.redraw && flight.kind === "return") {
        const hideTimer = window.setTimeout(() => {
          drawTimersRef.current = drawTimersRef.current.filter(
            (current) => current !== hideTimer,
          );
          setMulliganVisualHand((current) => {
            if (
              !current ||
              current.rev !== game.rev ||
              current.batchIndex !== flight.batchIndex
            )
              return current;
            const hiddenUids = new Set(current.hiddenUids);
            hiddenUids.add(flight.uid);
            return { ...current, hiddenUids };
          });
        }, flight.delay);
        drawTimersRef.current.push(hideTimer);
      }
    }
  }, [drawMotionEnabled, game.rev, seat]);

  useLayoutEffect(() => {
    const handCards = document.querySelector<HTMLElement>(".hand-cards");
    if (!handCards) return;

    const elements = new Map<string, HTMLElement>();
    const nextPositions = new Map<string, HandCardPosition>();
    for (const element of handCards.querySelectorAll<HTMLElement>(
      "[data-hand-uid]",
    )) {
      const uid = element.dataset.handUid;
      if (!uid) continue;
      elements.set(uid, element);
      nextPositions.set(uid, {
        left: element.offsetLeft,
        top: element.offsetTop,
      });
    }

    const previousPositions = previousHandPositionsRef.current;
    previousHandPositionsRef.current = nextPositions;
    for (const animation of handReflowAnimationsRef.current.values())
      animation.cancel();
    handReflowAnimationsRef.current.clear();
    if (!drawMotionEnabled || previousPositions.size === 0) return;

    const animateDrawEntry = enteringDrawUids.size > 0;
    for (const [uid, next] of nextPositions) {
      const previous = previousPositions.get(uid);
      const element = elements.get(uid);
      if (!previous || !element) continue;
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      const animation = element.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        {
          duration: animateDrawEntry
            ? HAND_DRAW_REFLOW_DURATION
            : HAND_REFLOW_DURATION,
          delay: animateDrawEntry ? HAND_DRAW_REFLOW_DELAY : 0,
          easing: "cubic-bezier(0.22, 0.82, 0.26, 1)",
          fill: animateDrawEntry ? "backwards" : "none",
        },
      );
      handReflowAnimationsRef.current.set(uid, animation);
    }
  }, [drawMotionEnabled, handLayoutKey]);

  useEffect(
    () => () => {
      for (const timer of drawTimersRef.current) window.clearTimeout(timer);
      drawingUidDeadlinesRef.current.clear();
      for (const animation of handReflowAnimationsRef.current.values())
        animation.cancel();
      handReflowAnimationsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    if (actionError) setError(actionError.message);
  }, [actionError]);

  const dispatch = (action: GameAction): boolean => {
    const validationError = validateGameAction(
      game,
      spectator ? "spectator" : seat,
      action,
    );
    if (validationError) {
      setError(validationError);
      return false;
    }
    captureActionRects();
    if (compact) setSelection(null);
    sendAction(action);
    return true;
  };

  const beginBatonTouch = (backIndex: number) => {
    const check = E.canBatonTouch(game, backIndex);
    if (!check.ok) {
      setError(check.reason ?? "このホロメンとはバトンタッチできません");
      return;
    }
    setBatonMode(false);
    if (check.cost === 0) {
      dispatch({ type: "batonTouch", backIndex, yellUids: [] });
      return;
    }
    setBatonPayment({
      backIndex,
      required: check.cost,
      selected: new Set(),
    });
  };

  const animationDelayRef = useRef<{
    logId: number;
    deadline: number;
    informed: boolean;
    submittedGame?: GameState;
  } | null>(null);

  useEffect(() => {
    if (!myPrompt || myPrompt.type !== "animationDelay") {
      animationDelayRef.current = null;
      return;
    }
    // 待機対象の演出 (サイコロ or 発動バナー) をログIDで特定する。
    // 推しスキル演出は別レイヤーのため一致せず、durationのみで待つ
    const matchedFx = resolutionEffects.find((effect) =>
      effect.logIds.includes(myPrompt.animationLogId),
    );
    let entry = animationDelayRef.current;
    if (
      !entry ||
      entry.logId !== myPrompt.animationLogId ||
      (!entry.informed && matchedFx)
    ) {
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      entry = {
        logId: myPrompt.animationLogId,
        deadline:
          matchedFx?.endsAt ??
          Date.now() + (reducedMotion ? 0 : myPrompt.duration),
        informed: !!matchedFx,
      };
      animationDelayRef.current = entry;
    }
    // 同じ状態での再描画は再送しない。再接続で新しい状態を受信し、
    // まだ同じ待機が残っていれば終了通知を送れるようにする。
    if (entry.submittedGame === game) return;
    // 演出要素の追加・削除による再実行では残り時間で張り直す (待機の二重加算防止)
    const remaining = Math.max(0, entry.deadline - Date.now());
    const timer = window.setTimeout(() => {
      if (entry !== animationDelayRef.current || entry.submittedGame === game)
        return;
      entry.submittedGame = game;
      dispatch({ type: "resolveAnimationDelay" });
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [game.rev, myPrompt, resolutionEffects, seat]);

  useEffect(() => {
    if (!myPrompt || myPrompt.type !== "liveStart") return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = window.setTimeout(
      () => dispatch({ type: "resolveLiveStart" }),
      reducedMotion ? 0 : myPrompt.duration,
    );
    return () => window.clearTimeout(timer);
  }, [game.rev, myPrompt, seat]);

  useEffect(() => {
    if (!myPrompt || myPrompt.type !== "setupReveal") return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = window.setTimeout(
      () => dispatch({ type: "resolveSetupReveal" }),
      reducedMotion ? 0 : myPrompt.duration,
    );
    return () => window.clearTimeout(timer);
  }, [game.rev, myPrompt, seat]);

  // ---------------- ドロップ判定 ----------------

  /** 自分のスタックへのドロップが有効か */
  const canDropOnOwnStack = (p: DragPayload, pos: StagePosition): boolean => {
    if (p.kind === "cheer")
      return !!myPrompt && myPrompt.type === "cheerAssign";
    if (p.kind === "hand") {
      const c = getCard(game.uidToCard[p.uid]);
      if (c.cardType === "holomen")
        return isMain && E.canBloom(game, p.uid, pos).ok;
      if (c.cardType === "support")
        return (
          isMain &&
          (c.supportType === "ツール" ||
            c.supportType === "マスコット" ||
            c.supportType === "ファン") &&
          E.canAttachSupportFromHand(game, p.uid, pos).ok
        );
    }
    if (p.kind === "stack" && p.pos === "center" && typeof pos !== "string")
      return isMain && E.canBatonTouch(game, pos.back).ok;
    return false;
  };

  const dropOnStack = (p: DragPayload, pos: StagePosition) => {
    if (p.kind === "cheer") {
      dispatch({ type: "resolveCheerAssign", pos });
    } else if (p.kind === "hand") {
      const c = getCard(game.uidToCard[p.uid]);
      if (c.cardType === "holomen")
        dispatch({ type: "bloom", handUid: p.uid, pos });
      else if (c.cardType === "support")
        dispatch({ type: "playSupport", handUid: p.uid, pos });
    } else if (
      p.kind === "stack" &&
      p.pos === "center" &&
      typeof pos !== "string"
    ) {
      beginBatonTouch(pos.back);
    }
  };

  /** 自分の盤面背景へのドロップ = スタッフ/アイテム/イベントの使用 */
  const canDropOnBoard = (p: DragPayload): boolean => {
    if (p.kind !== "hand" || !isMain) return false;
    const c = getCard(game.uidToCard[p.uid]);
    return (
      c.cardType === "support" &&
      (c.supportType === "スタッフ" ||
        c.supportType === "アイテム" ||
        c.supportType === "イベント")
    );
  };

  /** 空スロット (自分側) へのドロップ */
  const dropOnSlot = (
    p: DragPayload,
    slot: "center" | "collab" | "backArea",
  ) => {
    if (slot === "backArea" && p.kind === "hand") {
      if (myPrompt?.type === "placeBack") {
        dispatch({ type: "resolvePlaceBackOne", handUid: p.uid });
        return;
      }
      dispatch({ type: "playHolomen", handUid: p.uid });
      return;
    }
    if (
      slot === "center" &&
      p.kind === "hand" &&
      myPrompt?.type === "placeCenter"
    ) {
      dispatch({ type: "resolvePlaceCenter", handUid: p.uid });
      return;
    }
    if (p.kind === "stack" && typeof p.pos !== "string") {
      const backIndex = p.pos.back;
      if (slot === "collab") {
        dispatch({ type: "collab", backIndex });
      } else if (slot === "center" && myPrompt?.type === "chooseCenter") {
        dispatch({ type: "resolveChooseCenter", backIndex });
      }
    }
  };

  const canDropOnSlotFor = (
    p: DragPayload,
    slot: "center" | "collab" | "backArea",
  ): boolean => {
    if (slot === "backArea")
      return (
        p.kind === "hand" &&
        (() => {
          const c = getCard(game.uidToCard[p.uid]);
          return (
            c.cardType === "holomen" &&
            (c.bloomLevel === "Debut" || c.bloomLevel === "Spot") &&
            (isMain || myPrompt?.type === "placeBack")
          );
        })()
      );
    if (slot === "center") {
      if (p.kind === "hand")
        return (
          myPrompt?.type === "placeCenter" &&
          (() => {
            const c = getCard(game.uidToCard[p.uid]);
            return c.cardType === "holomen" && c.bloomLevel === "Debut";
          })()
        );
      if (p.kind === "stack" && typeof p.pos !== "string")
        return myPrompt?.type === "chooseCenter";
      return false;
    }
    if (slot === "collab")
      return (
        p.kind === "stack" &&
        typeof p.pos !== "string" &&
        isMain &&
        !me.collab &&
        !me.usedCollabThisTurn
      );
    return false;
  };

  const parseDropPos = (raw: string): StagePosition =>
    raw === "center" || raw === "collab"
      ? raw
      : { back: Number(raw.slice("back:".length)) };

  /**
   * ドロップ位置のDOM要素からドロップ先を解決して実行する。
   * スタック→スロット→盤面の順に判定し、無効なら外側の要素へ辿る
   * (HTML5 D&D時代のイベントバブリングと同じ優先順)
   */
  const performDrop = (payload: DragPayload, element: Element | null) => {
    let node: Element | null = element;
    while (node) {
      const target = node.closest(
        "[data-drop-pos], [data-drop-slot], [data-drop-board]",
      );
      if (!target) return;
      const ownTarget = target.getAttribute("data-drop-player") === `${seat}`;
      const rawPos = target.getAttribute("data-drop-pos");
      if (rawPos !== null && ownTarget) {
        const pos = parseDropPos(rawPos);
        if (canDropOnOwnStack(payload, pos)) {
          dropOnStack(payload, pos);
          return;
        }
      }
      const rawSlot = target.getAttribute("data-drop-slot");
      if (rawSlot !== null && ownTarget) {
        const slot = rawSlot as "center" | "collab" | "backArea";
        if (canDropOnSlotFor(payload, slot)) {
          dropOnSlot(payload, slot);
          return;
        }
      }
      if (target.hasAttribute("data-drop-board")) {
        if (
          payload.kind === "hand" &&
          target.getAttribute("data-player") === `${seat}` &&
          canDropOnBoard(payload)
        ) {
          const uid = payload.uid;
          dispatch({ type: "playSupport", handUid: uid });
        }
        return;
      }
      node = target.parentElement;
    }
  };

  // ---------------- クリック ----------------

  const onStackClick = (player: PlayerId, pos: StagePosition) => {
    const stack = E.getStack(game.players[player], pos);
    if (stack?.faceDown) {
      setSelection(null);
      return;
    }
    if (inspectingDuringResolution && stack) {
      openCardPreview(
        game.uidToCard[stack.cards[0]],
        stack.supports.map((uid) => game.uidToCard[uid]),
        game.uidToArtwork?.[stack.cards[0]],
        stack.supports.map((uid) => game.uidToArtwork?.[uid]),
      );
      return;
    }
    if ((selectingStack && !canSelectStack(player, pos)) || selectingHand) {
      if (stack)
        inspectUnavailableCard(
          game.uidToCard[stack.cards[0]],
          stack.supports.map((uid) => game.uidToCard[uid]),
          game.uidToArtwork?.[stack.cards[0]],
          stack.supports.map((uid) => game.uidToArtwork?.[uid]),
        );
      return;
    }
    // アーツの対象選択: 相手のホロメンをクリック (バックは対象拡張がある時のみengine側で許可)
    if (artMode && player !== seat) {
      const m = artMode;
      setArtMode(null);
      dispatch({
        type: "useArts",
        fromPos: m.fromPos,
        artIndex: m.artIndex,
        targetPos: pos,
      });
      return;
    }
    if (batonMode && player === seat && typeof pos !== "string") {
      beginBatonTouch(pos.back);
      return;
    }
    // タップ2段階操作: 手札カードで選んだ対象へBloom/付与を実行する
    if (handTargetMode && player === seat) {
      const mode = handTargetMode;
      if (!me.hand.includes(mode.uid)) {
        setHandTargetMode(null);
        return;
      }
      if (mode.kind === "bloom") {
        const check = E.canBloom(game, mode.uid, pos);
        if (!check.ok) {
          setError(check.reason ?? "ここにはBloomできません");
          return;
        }
        setHandTargetMode(null);
        dispatch({ type: "bloom", handUid: mode.uid, pos });
      } else {
        setHandTargetMode(null);
        dispatch({ type: "playSupport", handUid: mode.uid, pos });
      }
      return;
    }
    if (myPrompt?.type === "cheerAssign") {
      // 通常は自分の盤面、相手ホロメンへの付け替え時は相手の盤面をクリックする
      const expectPlayer = myPrompt.targetPlayer ?? seat;
      if (player === expectPlayer) {
        dispatch({ type: "resolveCheerAssign", pos });
        return;
      }
    }
    if (
      myPrompt?.type === "chooseCenter" &&
      player === seat &&
      typeof pos !== "string"
    ) {
      dispatch({ type: "resolveChooseCenter", backIndex: pos.back });
      return;
    }
    if (myPrompt?.type === "effectTarget") {
      dispatch({ type: "resolveEffectTarget", targetPlayer: player, pos });
      return;
    }
    if (myPrompt?.type === "effectAttach" && player === seat) {
      dispatch({ type: "resolveEffectAttach", pos });
      return;
    }
    setSelection({ kind: "stack", player, pos });
  };

  /** タップ2段階モード中に対象候補として光らせるか */
  const canTargetStackInMode = (
    mode: { kind: "bloom" | "attach"; uid: string },
    pos: StagePosition,
  ): boolean =>
    isMain &&
    (mode.kind === "bloom"
      ? E.canBloom(game, mode.uid, pos).ok
      : E.canAttachSupportFromHand(game, mode.uid, pos).ok);

  /** 対象候補は拡大ボタンで確認し、対象外はカード本体から確認する。 */
  const canPreviewStackWhileSelecting = (
    player: PlayerId,
    pos: StagePosition,
  ): boolean => {
    const stack = E.getStack(game.players[player], pos);
    return (
      selectingStack &&
      !!stack &&
      !stack.faceDown &&
      canSelectStack(player, pos)
    );
  };

  const onOshiCardClick = (player: PlayerId) => {
    if (inspectingDuringResolution) {
      const uid = game.players[player].oshiUid;
      openCardPreview(game.uidToCard[uid], [], game.uidToArtwork?.[uid]);
      return;
    }
    if (selectingStack || selectingHand) {
      const uid = game.players[player].oshiUid;
      inspectUnavailableCard(game.uidToCard[uid], [], game.uidToArtwork?.[uid]);
    } else setSelection({ kind: "oshi", player });
  };

  const onSupportClick = (
    player: PlayerId,
    pos: StagePosition,
    uid: string,
  ) => {
    if (inspectingDuringResolution) {
      const stack = E.getStack(game.players[player], pos);
      if (stack && !stack.faceDown && stack.supports.includes(uid))
        openCardPreview(game.uidToCard[uid], [], game.uidToArtwork?.[uid]);
      return;
    }
    if ((selectingStack && !canSelectStack(player, pos)) || selectingHand) {
      const stack = E.getStack(game.players[player], pos);
      if (stack && !stack.faceDown && stack.supports.includes(uid))
        inspectUnavailableCard(
          game.uidToCard[uid],
          [],
          game.uidToArtwork?.[uid],
        );
      return;
    }
    // 対象選択・アタッチ・バトンなどの特殊モード中は通常のスタッククリックとして扱う
    if (artMode || batonMode || handTargetMode || myPrompt) {
      onStackClick(player, pos);
      return;
    }
    setSelection({ kind: "support", uid, from: { player, pos } });
  };

  const onHandCardClick = (uid: string) => {
    if (inspectingDuringResolution && me.hand.includes(uid)) {
      openCardPreview(game.uidToCard[uid], [], game.uidToArtwork?.[uid]);
      return;
    }
    if (selectingHand && !canPreviewHandWhileSelecting(uid)) {
      if (me.hand.includes(uid))
        inspectUnavailableCard(
          game.uidToCard[uid],
          [],
          game.uidToArtwork?.[uid],
        );
      return;
    }
    if (myPrompt?.type === "placeCenter") {
      dispatch({ type: "resolvePlaceCenter", handUid: uid });
      return;
    }
    if (myPrompt?.type === "placeBack") {
      dispatch({ type: "resolvePlaceBackOne", handUid: uid });
      return;
    }
    if (
      myPrompt?.type === "mulliganPenalty" ||
      myPrompt?.type === "effectArchiveHand"
    ) {
      // 限定コストは選択可能な手札以外を無視
      if (
        myPrompt.type === "effectArchiveHand" &&
        myPrompt.eligible &&
        !myPrompt.eligible.includes(uid)
      )
        return;
      const max =
        myPrompt.type === "mulliganPenalty"
          ? myPrompt.count
          : (myPrompt.countMax ?? myPrompt.count);
      setMultiSelect((current) => toggleBoundedSelection(current, uid, max));
      return;
    }
    if (myPrompt) return;
    setArtMode(null);
    setBatonMode(false);
    setHandTargetMode(null);
    setSelection({ kind: "hand", uid });
  };

  const canPreviewHandWhileSelecting = (uid: string): boolean => {
    if (!myPrompt || !me.hand.includes(uid)) return false;
    const card = getCard(game.uidToCard[uid]);
    if (myPrompt.type === "placeCenter")
      return card.cardType === "holomen" && card.bloomLevel === "Debut";
    if (myPrompt.type === "placeBack")
      return (
        E.stageCount(me) < 6 &&
        me.back.length < 5 &&
        card.cardType === "holomen" &&
        (card.bloomLevel === "Debut" || card.bloomLevel === "Spot")
      );
    if (myPrompt.type === "mulliganPenalty") return true;
    if (myPrompt.type === "effectArchiveHand")
      return !myPrompt.eligible || myPrompt.eligible.includes(uid);
    return false;
  };

  // ---------------- ステータスバー (常時固定高で表示し、レイアウトのカクつきを防ぐ) ----------------

  function effectChoices<T extends { id: string; label: string }>(
    choices: T[],
    onChoose: (choice: T) => void,
    getInfo: (choice: T) => EffectInfo,
  ) {
    // PCは従来のボタン配置を保ち、スマホだけ本文を任意で確認できる。
    if (!compact)
      return choices.map((choice) => (
        <button
          key={choice.id}
          className="primary"
          onClick={() => onChoose(choice)}
        >
          {choice.label}
        </button>
      ));
    return (
      <div className="effect-choice-list">
        {choices.map((choice) => (
          <EffectChoice
            key={choice.id}
            info={getInfo(choice)}
            onInfo={setEffectInfo}
            onChoose={() => onChoose(choice)}
          />
        ))}
      </div>
    );
  }

  const incomingDamageNotice = (current: Extract<Prompt, { ctx: unknown }>) => {
    const info = E.incomingDamageInfo(game, current.ctx);
    if (!info) return null;
    return (
      <div className="incoming-damage-notice" aria-label="受けるダメージ">
        <strong>
          {info.kind === "art" ? "アーツダメージ" : "特殊ダメージ"}{" "}
          {info.damage}
        </strong>
      </div>
    );
  };

  const statusContent = () => {
    if (game.phase === "finished")
      return (
        <div className="prompt-bar idle">
          <span className="muted">ゲーム終了</span>
        </div>
      );
    if (spectator) {
      const label = !prompt
        ? `${game.players[game.turnPlayer].name}のターンです`
        : prompt.type === "animationDelay" ||
            prompt.type === "liveStart" ||
            prompt.type === "setupReveal"
          ? "演出を再生しています…"
          : `${game.players[prompt.player].name}の選択を待っています…`;
      return (
        <div className="prompt-bar idle">
          <span className="muted">
            観戦中 — {label}(手札 {me.name}: {me.hand.length}枚 /{" "}
            {game.players[opp].name}: {game.players[opp].hand.length}枚)
          </span>
        </div>
      );
    }
    if (artMode) {
      return (
        <div className="prompt-bar">
          <span>
            アーツの対象: 枠で強調された相手のホロメンをタップしてください
          </span>
          <button onClick={() => setArtMode(null)}>キャンセル</button>
        </div>
      );
    }
    if (batonMode) {
      return (
        <div className="prompt-bar">
          <span>バトンタッチ先のバックホロメンをタップしてください</span>
          <button onClick={() => setBatonMode(false)}>キャンセル</button>
        </div>
      );
    }
    if (handTargetMode) {
      return (
        <div className="prompt-bar">
          <span>
            {handTargetMode.kind === "bloom"
              ? "Bloomさせる自分のホロメンをタップしてください"
              : "付ける先の自分のホロメンをタップしてください"}
          </span>
          <button onClick={() => setHandTargetMode(null)}>キャンセル</button>
        </div>
      );
    }
    if (!prompt) {
      const giftAbilities = myTurn ? E.usableGiftAbilities(game, seat) : [];
      return (
        <div className="prompt-bar idle">
          <span className="muted">
            {!myTurn
              ? "相手のターンです"
              : game.step === "main"
                ? "メインステップ: カードをタップして操作を選べます"
                : game.step === "performance"
                  ? "パフォーマンスステップ: センター/コラボを選んでアーツを使用できます"
                  : ""}
          </span>
          {giftAbilities
            .filter((ga) => !compact || !!ga.archiveUid)
            .map((ga) => (
              <button
                key={`${ga.stackId}:${ga.supportUid ?? ga.archiveUid ?? ""}:${ga.index}`}
                onClick={() =>
                  dispatch({
                    type: "useGiftAbility",
                    stackId: ga.stackId,
                    index: ga.index,
                    supportUid: ga.supportUid,
                    archiveUid: ga.archiveUid,
                  })
                }
                title="ギフトの起動型能力を使用します"
              >
                ⚡ {ga.label}
              </button>
            ))}
          {isMain && (
            <button
              className="primary turn-advance-button"
              onClick={() => dispatch({ type: "goPerformance" })}
            >
              {game.turn === 1 ? "ターン終了" : "パフォーマンスへ"}
            </button>
          )}
          {isPerf && (
            <button
              className="primary turn-advance-button"
              onClick={() => dispatch({ type: "endTurn" })}
            >
              ターン終了
            </button>
          )}
        </div>
      );
    }
    if (
      prompt.type === "animationDelay" ||
      prompt.type === "liveStart" ||
      prompt.type === "setupReveal"
    ) {
      return (
        <div className="prompt-bar idle">
          <span className="muted">
            {prompt.type === "liveStart"
              ? "LIVE START — 配置したホロメンを公開します…"
              : prompt.type === "setupReveal"
                ? "ホロメンを公開しています…"
                : prompt.kind === "effect"
                  ? "効果の発動を確認しています…"
                  : prompt.kind === "oshiSkill" || prompt.kind === "spOshiSkill"
                    ? "推しスキルの発動を確認しています…"
                    : "サイコロの結果を確認しています…"}
          </span>
        </div>
      );
    }
    if (prompt.player !== seat) {
      return (
        <div className="prompt-bar idle">
          <span className="muted">
            {game.players[prompt.player].name}の選択を待っています…
          </span>
        </div>
      );
    }
    switch (prompt.type) {
      case "triggerAbilityChoice":
        return (
          <div className="prompt-bar">
            <span>先に解決する能力を選んでください:</span>
            {effectChoices(
              prompt.abilities,
              (ability) =>
                dispatch({
                  type: "resolveTriggerAbilityChoice",
                  id: ability.id,
                }),
              (ability) => abilityInfo(game, ability, prompt.player),
            )}
          </div>
        );
      case "damageReplacementChoice":
        return (
          <div className="prompt-bar">
            {incomingDamageNotice(prompt)}
            <span>先に適用するダメージ置換効果を選んでください:</span>
            {effectChoices(
              prompt.choices,
              (choice) =>
                dispatch({
                  type: "resolveDamageReplacementChoice",
                  id: choice.id,
                }),
              (choice) => replacementInfo(game, choice, prompt.player),
            )}
          </div>
        );
      case "ruleDownChoice":
        return (
          <div className="prompt-bar">
            <span>先にダウン処理するホロメンを選んでください:</span>
            {prompt.choices.map((choice) => (
              <button
                key={choice.stackId}
                className="primary"
                onClick={() =>
                  dispatch({
                    type: "resolveRuleDownChoice",
                    stackId: choice.stackId,
                  })
                }
              >
                {choice.label}
              </button>
            ))}
          </div>
        );
      case "ruleAbilityChoice":
        return (
          <div className="prompt-bar">
            <span>先に解決するダウン時能力を選んでください:</span>
            {effectChoices(
              prompt.choices,
              (choice) =>
                dispatch({ type: "resolveRuleAbilityChoice", id: choice.id }),
              (choice) => {
                const ability = game.ruleResolution?.current?.abilities.find(
                  (ability) => ability.id === choice.id,
                );
                return ability
                  ? abilityInfo(game, ability, prompt.player)
                  : { label: choice.label };
              },
            )}
          </div>
        );
      case "mulliganChoice": {
        const required = E.mulliganRequired(game, prompt.player);
        return (
          <div className="prompt-bar">
            <span>
              {required
                ? "Debutホロメンがいないため、手札を引き直してください (非公開・ペナルティなし)"
                : "手札を引き直しますか？ (1回だけ・任意)"}
            </span>
            <button
              className="primary"
              onClick={() =>
                dispatch({ type: "resolveMulligan", redraw: true })
              }
            >
              引き直す
            </button>
            {!required && (
              <button
                onClick={() =>
                  dispatch({ type: "resolveMulligan", redraw: false })
                }
              >
                そのまま
              </button>
            )}
          </div>
        );
      }
      case "placeCenter":
        return (
          <div className="prompt-bar">
            <span>
              手札のDebutホロメンをセンターへドラッグ (またはクリック)
              してください
            </span>
          </div>
        );
      case "mulliganPenalty":
        return (
          <div className="prompt-bar">
            <span>
              引き直しペナルティ: 手札から{prompt.count}枚選んでデッキの下へ (
              {multiSelect.size}/{prompt.count})
            </span>
            <button
              className="primary"
              disabled={multiSelect.size !== prompt.count}
              onClick={() => {
                const uids = [...multiSelect];
                dispatch({ type: "resolveMulliganPenalty", uids });
              }}
            >
              確定
            </button>
          </div>
        );
      case "placeBack":
        return (
          <div className="prompt-bar">
            <span>
              Debut/Spotホロメンをバックへドラッグ (またはクリック) —
              置かなくてもOK ({game.players[seat].back.length}枚配置済み)
            </span>
            <button
              className="primary"
              onClick={() => dispatch({ type: "resolvePlaceBackDone" })}
            >
              完了
            </button>
          </div>
        );
      case "cheerAssign": {
        const yell = getCard(game.uidToCard[prompt.yellUid]);
        return (
          <div className="prompt-bar">
            <CheerChip
              cardId={yell.id}
              artworkKey={game.uidToArtwork?.[prompt.yellUid]}
              animationUid={prompt.yellUid}
              onDragPress={(event) =>
                cardDrag.press(
                  { kind: "cheer", yellUid: prompt.yellUid },
                  event,
                )
              }
            />
            <span>
              {yell.name}を送るホロメンへドラッグ (またはクリック) —{" "}
              {prompt.reason === "life"
                ? "ライフから"
                : prompt.reason === "effect"
                  ? "効果による送付"
                  : "エールステップ"}
            </span>
          </div>
        );
      }
      case "chooseCenter":
        return (
          <div className="prompt-bar">
            <span>センターに移動するバックホロメンをタップしてください</span>
          </div>
        );
      case "effectTarget": {
        const labels: Record<string, string> = {
          special: `特殊ダメージ${(prompt.apply as { dmg?: number }).dmg ?? ""}`,
          heal: "HP回復",
          turnArtPlus: "アーツ強化",
          setHp: "HP変更",
          bind: "対象の選択",
          swapCenter: "センターとの交代",
        };
        return (
          <div className="prompt-bar">
            <span>
              効果の対象を選んでください ({labels[prompt.apply.t]} / 残り
              {prompt.count - prompt.chosen.length}
              {prompt.damageAllocation ? "回の割り振り" : "体"})
            </span>
          </div>
        );
      }
      case "effectAttach": {
        const card = getCard(game.uidToCard[prompt.uid]);
        return (
          <div className="prompt-bar">
            <span>「{card.name}」を付けるホロメンをタップしてください</span>
          </div>
        );
      }
      case "effectArchiveHand": {
        const max = prompt.countMax ?? prompt.count;
        const rangeLabel =
          prompt.count === max ? `${prompt.count}` : `${prompt.count}〜${max}`;
        const selectedUids = [...multiSelect];
        const selectionError = E.effectArchiveHandSelectionError(
          game,
          seat,
          prompt,
          selectedUids,
        );
        return (
          <div className="prompt-bar">
            <span>
              手札からアーカイブするカードを{rangeLabel}枚選択
              {prompt.sameTag ? "（同じタグを共有）" : ""} ({multiSelect.size}/
              {max})
            </span>
            {selectionError && multiSelect.size >= prompt.count && (
              <span className="muted">{selectionError}</span>
            )}
            <button
              className="primary"
              disabled={selectionError !== null}
              onClick={() =>
                dispatch({
                  type: "resolveEffectArchiveHand",
                  uids: selectedUids,
                })
              }
            >
              確定
            </button>
          </div>
        );
      }
      case "effectConfirm":
        return (
          <div className="prompt-bar">
            {prompt.damageReplacementId && incomingDamageNotice(prompt)}
            <span>{prompt.label}</span>
            <button
              className="primary"
              onClick={() =>
                dispatch({ type: "resolveEffectConfirm", yes: true })
              }
            >
              はい
            </button>
            <button
              onClick={() =>
                dispatch({ type: "resolveEffectConfirm", yes: false })
              }
            >
              いいえ
            </button>
          </div>
        );
      case "reactiveSkill":
        return (
          <div className="prompt-bar">
            {incomingDamageNotice(prompt)}
            <span title={prompt.description}>
              {prompt.sp ? "SP推しスキル" : "推しスキル"}「{prompt.skillName}
              」を使用しますか？ (ホロパワー-{prompt.cost})
            </span>
            <button
              className="primary"
              onClick={() =>
                dispatch({ type: "resolveReactiveSkill", use: true })
              }
            >
              使用する
            </button>
            <button
              onClick={() =>
                dispatch({ type: "resolveReactiveSkill", use: false })
              }
            >
              使用しない
            </button>
          </div>
        );
      case "declareDice":
        return (
          <div className="prompt-bar">
            <span>サイコロの目の宣言: 次に出る目を選んでください</span>
            {[1, 2, 3, 4, 5, 6].map((v) => (
              <button
                key={v}
                className="primary"
                onClick={() =>
                  dispatch({ type: "resolveDeclareDice", value: v })
                }
              >
                {v}
              </button>
            ))}
          </div>
        );
      case "jankenHand": {
        const hands = [
          ["rock", "グー"],
          ["scissors", "チョキ"],
          ["paper", "パー"],
        ] as const;
        return (
          <div className="prompt-bar">
            <span>つのまきじゃんけん: 出す手を選んでください</span>
            {hands.map(([hand, label]) => (
              <button
                key={hand}
                className="primary"
                onClick={() => dispatch({ type: "resolveJankenHand", hand })}
              >
                {label}
              </button>
            ))}
          </div>
        );
      }
      case "effectPickCard": {
        const guidance = pickGuidance(prompt, seat);
        return (
          <div className="prompt-bar idle">
            <span className="muted">{guidance.title}中…</span>
          </div>
        ); // 実体はモーダルで表示
      }
    }
  };

  // ---------------- カード選択モーダル ----------------

  const archiveModal = () => {
    if (archiveView === null) return null;
    const p = game.players[archiveView];
    // 最後にアーカイブされたカードが先頭になるよう新しい順に並べる
    const uids = [...p.archive].reverse();
    return (
      <div className="overlay" onClick={() => setArchiveView(null)}>
        <div
          className="overlay-box pick-box archive-modal"
          ref={archiveRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="archive-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="archive-modal-header">
            <h3 id="archive-title">
              {p.name}のアーカイブ ({p.archive.length}枚)
            </h3>
            <button
              className="game-icon-button"
              aria-label="アーカイブを閉じる"
              title="閉じる"
              onClick={() => setArchiveView(null)}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="archive-modal-content">
            {uids.length === 0 ? (
              <p className="muted">アーカイブは空です。</p>
            ) : (
              <div className="pick-grid">
                {uids.map((uid, i) => (
                  <div className="modal-card-option" key={`${uid}:${i}`}>
                    <div className="modal-card-visual">
                      <CardView
                        cardId={game.uidToCard[uid]}
                        artworkKey={game.uidToArtwork?.[uid]}
                        size="md"
                        title={`${getCard(game.uidToCard[uid]).name}の詳細を表示`}
                        onClick={() =>
                          openCardPreview(
                            game.uidToCard[uid],
                            [],
                            game.uidToArtwork?.[uid],
                          )
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const batonPaymentModal = () => {
    if (!batonPayment || !me.center) return null;
    const toggle = (uid: string) =>
      setBatonPayment((current) =>
        current
          ? {
              ...current,
              selected: toggleBoundedSelection(
                current.selected,
                uid,
                current.required,
              ),
            }
          : null,
      );
    return (
      <div className="overlay" onClick={() => setBatonPayment(null)}>
        <div
          className="overlay-box pick-box"
          ref={batonPaymentRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="baton-payment-title"
          onClick={(event) => event.stopPropagation()}
        >
          <h3 id="baton-payment-title">
            アーカイブするエールを選択（{batonPayment.selected.size}/
            {batonPayment.required}枚）
          </h3>
          <p className="muted">
            バトンタッチ後に残したい色を考えて、支払うエールを選んでください。
          </p>
          <div className="pick-grid">
            {me.center.yells.map((uid) => {
              const cardId = game.uidToCard[uid];
              const card = getCard(cardId);
              return (
                <div className="pick-card-option" key={uid}>
                  <div className="modal-card-visual">
                    <CardView
                      cardId={cardId}
                      artworkKey={game.uidToArtwork?.[uid]}
                      size="md"
                      selected={batonPayment.selected.has(uid)}
                      onClick={() => toggle(uid)}
                    />
                    <CardPreviewButton
                      cardName={card.name}
                      className="modal-card-zoom"
                      onPreview={() =>
                        openCardPreview(cardId, [], game.uidToArtwork?.[uid])
                      }
                    />
                  </div>
                  <span className="pick-card-source">{card.name}</span>
                </div>
              );
            })}
          </div>
          <div className="overlay-actions">
            <button onClick={() => setBatonPayment(null)}>キャンセル</button>
            <button
              className="primary"
              disabled={batonPayment.selected.size !== batonPayment.required}
              onClick={() => {
                const { backIndex, selected } = batonPayment;
                setBatonPayment(null);
                dispatch({
                  type: "batonTouch",
                  backIndex,
                  yellUids: [...selected],
                });
              }}
            >
              バトンタッチ
            </button>
          </div>
        </div>
      </div>
    );
  };

  const cardPreviewModal = () => {
    if (!cardPreview) return null;
    const card = getCard(cardPreview.cardId);
    return (
      <div
        className="db-card-preview"
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) setCardPreview(null);
        }}
      >
        <div
          className="db-card-preview-dialog card-preview-dialog-with-details"
          ref={cardPreviewRef}
          role="dialog"
          aria-modal="true"
          aria-label={`${card.name}の詳細表示`}
        >
          <div className="card-preview-toolbar">
            <button
              type="button"
              className="db-card-preview-close"
              aria-label="詳細表示を閉じる"
              onClick={() => setCardPreview(null)}
            >
              <span />
            </button>
          </div>
          <div className="card-preview-scroll">
            <div className="card-preview-body">
              <CardView
                cardId={cardPreview.cardId}
                artworkKey={cardPreview.artworkKey}
                size="lg"
                className="db-card-preview-card"
              />
              <div className="card-preview-details">
                <CardDescription
                  card={card}
                  artworkKey={cardPreview.artworkKey}
                />
                {cardPreview.attachedCardIds.length > 0 && (
                  <section className="card-preview-attachments">
                    <h3>付属カード</h3>
                    {cardPreview.attachedCardIds.map(
                      (attachedCardId, index) => {
                        const attachedCard = getCard(attachedCardId);
                        return (
                          <div
                            className="card-preview-attached"
                            key={`${attachedCardId}:${index}`}
                          >
                            <CardDescription
                              card={attachedCard}
                              artworkKey={
                                cardPreview.attachedArtworkKeys?.[index]
                              }
                            />
                          </div>
                        );
                      },
                    )}
                  </section>
                )}
              </div>
            </div>
            <div className="db-card-preview-meta">
              <span>{cardPreview.cardId}</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ---------------- 詳細パネル ----------------

  const detailPanel = () => {
    if (!selection)
      return (
        <div className="detail-empty">
          カードをクリック (タップ) すると、詳細と操作ボタンが表示されます。
          <br />
          ドラッグ&ドロップでも操作できます (スマホは長押しでドラッグ):
          <ul className="hint-list">
            <li>手札のホロメン → バックエリア: ステージに出す</li>
            <li>手札の1st/2nd → ホロメン: Bloom</li>
            <li>手札のツール/マスコット/ファン → ホロメン: 付ける</li>
            <li>手札のスタッフ/アイテム/イベント → 自分の盤面: 使用</li>
            <li>バックホロメン → コラボ枠: コラボ</li>
            <li>センターホロメン → 交代先のバックホロメン: バトンタッチ</li>
            <li>センター/コラボ → 相手ホロメン: アーツ攻撃</li>
          </ul>
        </div>
      );
    if (selection.kind === "hand") {
      const cardId = game.uidToCard[selection.uid];
      if (!me.hand.includes(selection.uid)) return null;
      const card = getCard(cardId);
      const uid = selection.uid;
      const usableSupport =
        card.cardType === "support" &&
        (card.supportType === "スタッフ" ||
          card.supportType === "アイテム" ||
          card.supportType === "イベント");
      const mainReason = actionPhaseReason(game, seat, "main");
      const supportReason =
        card.cardType === "support"
          ? (mainReason ?? supportPlayabilityReason(game, uid, isMain))
          : null;
      const ownStacks = mainReason ? [] : E.allStacks(me);
      const bloomPossible = ownStacks.some(
        ({ pos }) => E.canBloom(game, uid, pos).ok,
      );
      const attachPossible =
        card.cardType === "support" &&
        ownStacks.some(
          ({ pos }) => E.canAttachSupportFromHand(game, uid, pos).ok,
        );
      const targetKind =
        card.cardType === "support" && !usableSupport
          ? "attach"
          : card.cardType === "holomen" &&
              (card.bloomLevel === "1st" || card.bloomLevel === "2nd")
            ? "bloom"
            : null;
      const targetFailures = targetKind
        ? handTargetFailures(game, seat, uid, targetKind)
        : [];
      const placementReason =
        mainReason ??
        (E.stageCount(me) >= 6
          ? "ステージの上限（6人）に達しています"
          : me.back.length >= 5
            ? "バックの上限（5人）に達しています"
            : null);
      return (
        <div>
          <GameCardDetail
            card={card}
            artworkKey={game.uidToArtwork?.[uid]}
            compact={compact}
            onClose={closeSelectedCard}
            onPreview={() =>
              openCardPreview(cardId, [], game.uidToArtwork?.[uid])
            }
          >
            <div>
              <CardDescription
                card={card}
                artworkKey={game.uidToArtwork?.[uid]}
              />
            </div>
          </GameCardDetail>
          {!spectator && game.phase === "playing" && (
            <div className="actions">
              {card.cardType === "holomen" &&
                (card.bloomLevel === "Debut" || card.bloomLevel === "Spot") && (
                  <GameActionButton
                    reason={placementReason}
                    onClick={() =>
                      dispatch({ type: "playHolomen", handUid: uid })
                    }
                  >
                    バックに出す
                  </GameActionButton>
                )}
              {targetKind === "bloom" && (
                <GameActionButton
                  primary
                  reason={
                    mainReason ??
                    (bloomPossible
                      ? null
                      : "このカードでBloomできるホロメンがいません")
                  }
                  onClick={() => setHandTargetMode({ kind: "bloom", uid })}
                >
                  Bloomする
                </GameActionButton>
              )}
              {targetKind === "attach" && (
                <GameActionButton
                  primary
                  reason={
                    supportReason ??
                    (attachPossible ? null : "条件を満たす付与先がありません")
                  }
                  onClick={() => setHandTargetMode({ kind: "attach", uid })}
                >
                  付ける
                </GameActionButton>
              )}
              {usableSupport && (
                <GameActionButton
                  reason={supportReason}
                  onClick={() =>
                    dispatch({ type: "playSupport", handUid: uid })
                  }
                >
                  使用する
                </GameActionButton>
              )}
            </div>
          )}
          {!spectator && targetFailures.length > 0 && !supportReason && (
            <section
              className="action-target-reasons"
              aria-label={
                targetKind === "attach"
                  ? "付けられないホロメン"
                  : "Bloomできないホロメン"
              }
            >
              <p>
                {targetKind === "attach"
                  ? "付けられないホロメン"
                  : "Bloomできないホロメン"}
              </p>
              <ul>
                {targetFailures.map(({ stackId, label, reason }) => (
                  <li key={stackId}>
                    <span>{label}</span>：{reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      );
    }
    if (selection.kind === "oshi") {
      return (
        <OshiDetail
          game={game}
          player={selection.player}
          compact={compact}
          onClose={closeSelectedCard}
          onPreview={openCardPreview}
          canAct={
            !spectator && game.phase === "playing" && selection.player === seat
          }
          onSkill={(sp) => dispatch({ type: "useOshiSkill", sp })}
        />
      );
    }
    if (selection.kind === "support") {
      const supportCardId = attachedSupportCardId(game, selection);
      if (!supportCardId) return null;
      const supportCard = getCard(supportCardId) as SupportCard;
      const from = selection.from;
      return (
        <div>
          <GameCardDetail
            card={supportCard}
            artworkKey={game.uidToArtwork?.[selection.uid]}
            compact={compact}
            onClose={closeSelectedCard}
            onPreview={() =>
              openCardPreview(
                supportCardId,
                [],
                game.uidToArtwork?.[selection.uid],
              )
            }
          >
            <CardDescription
              card={supportCard}
              artworkKey={game.uidToArtwork?.[selection.uid]}
            />
          </GameCardDetail>
          {!spectator &&
            from.player === seat &&
            game.phase === "playing" &&
            E.giftAbilityOptions(game, seat)
              .filter((ability) => ability.supportUid === selection.uid)
              .map((ability) => (
                <div className="actions" key={ability.index}>
                  <GameActionButton
                    reason={ability.reason}
                    onClick={() =>
                      dispatch({
                        type: "useGiftAbility",
                        stackId: ability.stackId,
                        index: ability.index,
                        supportUid: ability.supportUid,
                      })
                    }
                  >
                    ⚡ {supportCard.name}の能力を使用
                  </GameActionButton>
                </div>
              ))}
          <div className="actions">
            <button onClick={() => setSelection({ kind: "stack", ...from })}>
              ← ホロメンに戻る
            </button>
          </div>
        </div>
      );
    }
    const stack = E.getStack(game.players[selection.player], selection.pos);
    if (!stack || stack.faceDown) return null;
    const card = E.topCard(game, stack);
    const stackPos = selection.pos;
    const stackPlayer = selection.player;
    const supports = stack.supports.map((u) => ({
      uid: u,
      card: getCard(game.uidToCard[u]) as SupportCard,
    }));
    const ownFront =
      selection.player === seat &&
      (selection.pos === "center" || selection.pos === "collab");
    const ownCenter = selection.player === seat && selection.pos === "center";
    const ownBackIndex =
      selection.player === seat && typeof selection.pos !== "string"
        ? selection.pos.back
        : null;
    const batonChecks =
      ownCenter && isMain
        ? me.back.map((_, index) => E.canBatonTouch(game, index))
        : [];
    const canStartBaton = batonChecks.some((check) => check.ok);
    const batonReason =
      me.back.length === 0
        ? "交代できるバックホロメンがいません"
        : (batonChecks.find(
            (check, index) =>
              !check.ok &&
              !me.back[index].resting &&
              !E.hasNoSwitch(game, me.back[index]),
          )?.reason ?? batonChecks.find((check) => !check.ok)?.reason);
    return (
      <div>
        <GameCardDetail
          card={card}
          artworkKey={game.uidToArtwork?.[stack.cards[0]]}
          compact={compact}
          onClose={closeSelectedCard}
          onPreview={() =>
            openCardPreview(
              card.id,
              stack.supports.map((uid) => game.uidToCard[uid]),
              game.uidToArtwork?.[stack.cards[0]],
              stack.supports.map((uid) => game.uidToArtwork?.[uid]),
            )
          }
          status={
            <div className="compact-stack-status">
              <span>
                HP {Math.max(0, E.effectiveMaxHp(game, stack) - stack.damage)}/
                {E.effectiveMaxHp(game, stack)}
              </span>
              <span className="detail-yells" aria-label="付いているエール">
                エール{" "}
                {stack.yells.length === 0
                  ? "なし"
                  : stack.yells.map((uid) => {
                      const yell = getCard(game.uidToCard[uid]);
                      const color =
                        yell.cardType === "yell" ? yell.color : "無";
                      return (
                        <span
                          key={uid}
                          className="yell-dot"
                          title={`${color}エール`}
                          aria-label={`${color}エール`}
                          style={{ background: yellColorHex(color) }}
                        />
                      );
                    })}
              </span>
              {stack.resting && <span>お休み中</span>}
            </div>
          }
        >
          <div className="card-text">
            <CardDescription
              card={card}
              artworkKey={game.uidToArtwork?.[stack.cards[0]]}
            />
            {!compact && (
              <p className="muted">
                ダメージ: {stack.damage} / 残りHP:{" "}
                {Math.max(0, E.effectiveMaxHp(game, stack) - stack.damage)}
                {stack.resting ? " / お休み中" : ""}
              </p>
            )}
          </div>
        </GameCardDetail>
        {supports.length > 0 && (
          <section
            className="attached-support-details"
            aria-label="付いているサポート"
          >
            <p>付いているサポート ({supports.length}枚)</p>
            <div className="attached-supports">
              {supports.map(({ uid, card: sc }) => (
                <button
                  key={uid}
                  type="button"
                  className="attached-chip"
                  onClick={() =>
                    setSelection({
                      kind: "support",
                      uid,
                      from: { player: stackPlayer, pos: stackPos },
                    })
                  }
                >
                  {sc.name}
                </button>
              ))}
            </div>
          </section>
        )}
        {ownCenter && !spectator && game.phase === "playing" && (
          <div className="actions">
            <GameActionButton
              primary
              reason={
                actionPhaseReason(game, seat, "main") ??
                (canStartBaton ? null : batonReason)
              }
              onClick={() => setBatonMode(true)}
            >
              バトンタッチ (必要エール{E.batonCostOf(game, stack)}枚)
            </GameActionButton>
          </div>
        )}
        {!spectator &&
          game.phase === "playing" &&
          stackPlayer === seat &&
          E.giftAbilityOptions(game, seat)
            .filter(
              (ability) => ability.stackId === stack.id && !ability.archiveUid,
            )
            .map((ability) => (
              <div
                className="actions"
                key={`${ability.supportUid ?? ""}:${ability.index}`}
              >
                <GameActionButton
                  reason={ability.reason}
                  onClick={() =>
                    dispatch({
                      type: "useGiftAbility",
                      stackId: ability.stackId,
                      index: ability.index,
                      supportUid: ability.supportUid,
                    })
                  }
                >
                  ⚡{" "}
                  {ability.supportUid
                    ? getCard(game.uidToCard[ability.supportUid]).name
                    : (card.gift?.name ?? "起動型能力")}
                  を使用
                </GameActionButton>
              </div>
            ))}
        {ownBackIndex !== null && !spectator && game.phase === "playing" && (
          <div className="actions">
            <GameActionButton
              primary
              reason={
                actionPhaseReason(game, seat, "main") ??
                (me.usedCollabThisTurn
                  ? "コラボはこのターンに使用済みです"
                  : me.collab
                    ? "コラボポジションにすでにホロメンがいます"
                    : stack.resting
                      ? "お休み中のホロメンはコラボできません"
                      : E.hasNoSwitch(game, stack)
                        ? "このホロメンは移動できません"
                        : !me.deck.length
                          ? "デッキが0枚のためコラボできません"
                          : null)
              }
              onClick={() =>
                dispatch({ type: "collab", backIndex: ownBackIndex })
              }
            >
              コラボする
            </GameActionButton>
          </div>
        )}
        {ownFront && !spectator && game.phase === "playing" && (
          <div className="actions">
            {E.availableArts(game, stack).map((a, i) => (
              <GameActionButton
                key={i}
                primary
                reason={
                  E.canUseArt(
                    game,
                    seat,
                    selection.pos as "center" | "collab",
                    i,
                  ).reason
                }
                onClick={() =>
                  setArtMode({
                    fromPos: selection.pos as "center" | "collab",
                    artIndex: i,
                  })
                }
              >
                アーツ: {a.name} ({a.power})
              </GameActionButton>
            ))}
          </div>
        )}
      </div>
    );
  };

  const closeSelectedCard = () => {
    setSelection(null);
    setArtMode(null);
    setHandTargetMode(null);
    setBatonMode(false);
  };

  const selectedStack = selection?.kind === "stack" ? selection : null;
  const selectedOshiPlayer =
    selection?.kind === "oshi" ? selection.player : null;
  const detailContent = inspectedCard ? (
    <div>
      <GameCardDetail
        card={getCard(inspectedCard.cardId)}
        artworkKey={inspectedCard.artworkKey}
        compact={false}
        onPreview={() =>
          openCardPreview(
            inspectedCard.cardId,
            inspectedCard.attachedCardIds,
            inspectedCard.artworkKey,
            inspectedCard.attachedArtworkKeys,
          )
        }
      >
        <CardDescription
          card={getCard(inspectedCard.cardId)}
          artworkKey={inspectedCard.artworkKey}
        />
      </GameCardDetail>
      {inspectedCard.attachedCardIds.length > 0 && (
        <section
          className="attached-support-details"
          aria-label="付いているサポート"
        >
          <p>付いているサポート ({inspectedCard.attachedCardIds.length}枚)</p>
          {inspectedCard.attachedCardIds.map((id, index) => (
            <CardDescription
              key={`${id}:${index}`}
              card={getCard(id)}
              artworkKey={inspectedCard.attachedArtworkKeys?.[index]}
            />
          ))}
        </section>
      )}
    </div>
  ) : (
    detailPanel()
  );
  // 解決中にカードが手札やステージから移動しても、発生元の本文を確認できる。
  const effectCtx = myPrompt && "ctx" in myPrompt ? myPrompt.ctx : undefined;
  const effectUid = effectCtx?.sourceSupportUid ?? effectCtx?.sourceCardUid;
  const effectStack =
    effectCtx?.sourceStackId === undefined
      ? null
      : E.findStackById(game, effectCtx.sourceStackId)?.stack;
  const effectCardId =
    (effectUid && game.uidToCard[effectUid]) ||
    effectCtx?.artRef?.cardId ||
    (effectStack && !effectStack.faceDown
      ? game.uidToCard[effectStack.cards[0]]
      : undefined);
  const effectArtworkKey =
    game.uidToArtwork?.[
      effectUid ??
        (effectStack && !effectStack.faceDown ? effectStack.cards[0] : "")
    ];
  // 全文パネルは手動でカードを選んだ時だけ開く。演出待ちでは開かない。
  const mobileDetailContent = !myPrompt && selection ? detailContent : null;
  const resolvingInfo = !compact
    ? null
    : myPrompt?.type === "reactiveSkill"
      ? {
          label: `${myPrompt.sp ? "SP推しスキル" : "推しスキル"}「${myPrompt.skillName}」`,
          description: myPrompt.description,
        }
      : effectCtx &&
          myPrompt &&
          ![
            "animationDelay",
            "effectPickCard",
            "triggerAbilityChoice",
            "damageReplacementChoice",
          ].includes(myPrompt.type)
        ? resolutionInfo(game, effectCtx)
        : null;
  const renderLog = () => (
    <div className="log-panel" ref={logRef} aria-live="polite">
      {visibleGameLog.map((l) => {
        // 再開した対戦に残る旧形式も、操作主のラベルを付けず区切り表示する。
        const legacyTurn = /^=== ターン(\d+) \((.*)\) ===$/.exec(l.text);
        if (l.turnStart || legacyTurn) {
          return (
            <div
              key={l.id}
              className="log-entry log-turn-start"
              role="heading"
              aria-level={3}
            >
              {legacyTurn
                ? `ターン${legacyTurn[1]}（${legacyTurn[2]}）`
                : l.text}
            </div>
          );
        }
        return (
          <div
            key={l.id}
            className={`log-entry${l.text.startsWith("▶") ? " log-effect" : ""}${l.text.startsWith("⚠") ? " log-warn" : ""}`}
          >
            {l.player !== null && (
              <span className={`log-player p${l.player}`}>
                {game.players[l.player].name}
              </span>
            )}
            {l.text}
          </div>
        );
      })}
    </div>
  );

  // ---------------- 描画 ----------------

  return (
    <div
      className={`game-screen${compact ? " game-compact" : ""}${selectingStack ? " selecting-target" : ""}`}
      onClick={(event) => {
        if (!selection || selectingStack || myPrompt || batonPayment || drag)
          return;
        const target = event.target;
        // カードや操作部品のクリックは、それぞれの選択・実行処理に任せる。
        if (
          target instanceof Element &&
          !target.closest(
            ".card, .stack-wrap, .mobile-card-panel, .sidebar, button, [role='button'], .overlay, .db-card-preview, .game-log-dialog",
          )
        )
          closeSelectedCard();
      }}
    >
      <header className="game-header">
        <span className={`turn-label${myTurn ? " my-turn" : ""}`}>
          ターン{game.turn} ー {game.players[game.turnPlayer].name}
          {myTurn ? " (あなた)" : ""}
        </span>
        <nav className="steps" aria-label="ターン進行">
          {(
            ["reset", "draw", "cheer", "main", "performance", "end"] as const
          ).map((st) => (
            <span
              key={st}
              aria-current={
                game.step === st && game.phase === "playing"
                  ? "step"
                  : undefined
              }
              className={`step-chip${game.step === st && game.phase === "playing" ? " active" : ""}`}
            >
              {STEP_LABELS[st]}
            </span>
          ))}
        </nav>
        <div className="header-actions">
          {compact && (
            <>
              <button onClick={() => setLogOpen(true)}>ログ</button>
              <button
                aria-expanded={menuOpen}
                aria-controls="game-mobile-menu"
                onClick={() => setMenuOpen((open) => !open)}
              >
                メニュー
              </button>
            </>
          )}
          {(!compact || menuOpen) && (
            <GameMenu
              compact={compact}
              setMenuOpen={setMenuOpen}
              spectator={spectator}
              game={game}
              dispatch={dispatch}
              onExit={onExit}
              onHome={onHome}
              exitLabel={exitLabel}
            />
          )}
        </div>
      </header>

      <div className="game-body">
        <div className="boards">
          <PlayerBoard
            game={game}
            player={opp}
            seat={seat}
            interactive={!spectator}
            hpChangeDelays={hpChangeDelays}
            flipped
            onDragPress={cardDrag.press}
            canDropOnStack={() => false}
            canDropOnSlot={() => false}
            targeting={selectingStack}
            canSelectStack={canSelectStack}
            onStackClick={onStackClick}
            onSupportClick={onSupportClick}
            onCardPreview={openCardPreview}
            canPreviewStack={canPreviewStackWhileSelecting}
            onOshiClick={() => onOshiCardClick(opp)}
            onArchiveClick={setArchiveView}
            selectedStack={selectedStack}
            selectedOshiPlayer={selectedOshiPlayer}
            actionClassFor={actionClassFor}
          />
          <PlayerBoard
            game={game}
            player={seat}
            seat={seat}
            interactive={!spectator}
            hpChangeDelays={hpChangeDelays}
            onDragPress={cardDrag.press}
            canDropOnStack={(pos) =>
              drag
                ? canDropOnOwnStack(drag, pos)
                : handTargetMode
                  ? canTargetStackInMode(handTargetMode, pos)
                  : false
            }
            canDropOnSlot={(slot) => !!drag && canDropOnSlotFor(drag, slot)}
            targeting={selectingStack}
            canSelectStack={canSelectStack}
            onStackClick={onStackClick}
            onSupportClick={onSupportClick}
            onCardPreview={openCardPreview}
            canPreviewStack={canPreviewStackWhileSelecting}
            boardDroppable={!!drag && canDropOnBoard(drag)}
            onOshiClick={() => onOshiCardClick(seat)}
            onArchiveClick={setArchiveView}
            selectedStack={selectedStack}
            selectedOshiPlayer={selectedOshiPlayer}
            actionClassFor={actionClassFor}
          />
        </div>
        {!compact && <GameSidebar detail={detailContent} log={renderLog()} />}
      </div>

      <footer className="hand-area">
        {compact && mobileDetailContent && !batonPayment && (
          <GameDetailPanel
            className="mobile-card-panel"
            contentClassName="mobile-panel-content"
            label="選択カードの操作"
            key={JSON.stringify(selection)}
          >
            {mobileDetailContent}
          </GameDetailPanel>
        )}
        {compact && resolvingInfo && (
          <EffectResolutionGuide key={effectPromptKey} info={resolvingInfo} />
        )}
        {statusContent()}
        {!spectator && (
          <HandArea
            me={me}
            game={game}
            opp={opp}
            sortedHand={sortedHand}
            mulliganVisualHand={mulliganVisualHand}
            pendingDrawUids={pendingDrawUids}
            canPreviewHandWhileSelecting={canPreviewHandWhileSelecting}
            actionClassFor={actionClassFor}
            selectingHand={selectingHand}
            selection={selection}
            multiSelect={multiSelect}
            onHandCardClick={onHandCardClick}
            cardDrag={cardDrag}
            openCardPreview={openCardPreview}
          />
        )}
      </footer>

      <DrawAnimationLayer flights={drawFlights} />
      <CardActionAnimationLayer flights={actionFlights} />
      <StateChangeAnimationLayer effects={stateChangeEffects} />
      <CombatAnimationLayer effects={combatEffects} />
      <OshiSkillAnimationLayer effects={oshiSkillEffects} />
      <ResolutionAnimationLayer
        effects={resolutionEffects}
        viewer={spectator ? null : seat}
        playerNames={[game.players[0].name, game.players[1].name]}
      />
      {/* ターン開始/勝敗バナーは視点依存 (YOUR TURN等) のため観戦では出さない */}
      <GameFlowAnimationLayer effects={spectator ? [] : gameFlowEffects} />

      {error && <div className="toast">{error}</div>}
      {batonPaymentModal()}
      <EffectPickDialog
        key={
          myPrompt?.type === "effectPickCard"
            ? multiSelectPromptKey
            : "no-card-pick"
        }
        game={game}
        seat={seat}
        myPrompt={myPrompt}
        multiSelect={multiSelect}
        setMultiSelect={setMultiSelect}
        isPickModalHidden={isPickModalHidden || menuOpen}
        setHiddenPickPromptKey={setHiddenPickPromptKey}
        pickPromptKey={pickPromptKey}
        effectCardId={effectCardId}
        effectArtworkKey={effectArtworkKey}
        openCardPreview={openCardPreview}
        dispatch={dispatch}
      />
      {archiveModal()}
      {cardPreviewModal()}
      {compact && effectInfo && (
        <EffectInfoDialog
          info={effectInfo}
          onClose={() => setEffectInfo(null)}
        />
      )}
      {compact && logOpen && (
        <GameLogDialog onClose={() => setLogOpen(false)}>
          {renderLog()}
        </GameLogDialog>
      )}

      {game.phase === "finished" && !resultPending && (
        <div className="overlay">
          <div
            className="overlay-box"
            ref={resultRef}
            role="dialog"
            aria-modal="true"
            aria-label="対戦結果"
          >
            <h2>
              {game.winner === null
                ? "引き分け"
                : game.players[game.winner].name + "の勝利!"}
            </h2>
            <p>{game.winReason}</p>
            <div className="overlay-actions">
              {onRematch && (
                <button className="primary" onClick={onRematch}>
                  もう一戦
                </button>
              )}
              <button
                className={onRematch ? undefined : "primary"}
                onClick={onExit}
              >
                {/* 観戦者のonExitは部屋をリセットせず、自分だけホームへ戻る */}
                {spectator ? "ホームへ戻る" : (exitLabel ?? "ロビーへ戻る")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// カードテキスト
// ============================================================

function CostIcons({ cost }: { cost: Color[] }) {
  return (
    <span className="cost-icons">
      {cost.map((c, i) => (
        <span
          key={i}
          className="yell-dot"
          style={{ background: c === "無" ? "#aaa" : yellColorHex(c) }}
          title={c}
        />
      ))}
    </span>
  );
}
