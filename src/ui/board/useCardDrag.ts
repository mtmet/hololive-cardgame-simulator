// ============================================================
// カードのドラッグ操作 (Pointer Events実装)
// HTML5 D&D はタッチで発火しないため、マウス/タッチ共通の
// ポインター操作で自前実装する。
//  - マウス: 押して少し動かすとドラッグ開始 (クリックはそのまま生きる)
//  - タッチ: 長押しでドラッグ開始。先に動かした場合はスクロールに譲る
// ゴースト表示・スクロール/長押しメニューの抑止・ドロップ位置の要素取得を
// 担当し、ドロップ先の解決と実行は呼び出し側 (GameScreen) が行う。
// ============================================================
import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DragPayload } from "./PlayerBoard";

const LONG_PRESS_MS = 300;
const MOUSE_MOVE_THRESHOLD_PX = 5;
/** 長押し成立前にこれ以上動いたらスクロール操作とみなして諦める */
const TOUCH_CANCEL_MOVE_PX = 12;

interface PressState {
  payload: DragPayload;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  sourceEl: HTMLElement;
  dragging: boolean;
  dragLayer: HTMLElement | null;
  ghost: HTMLElement | null;
  grabX: number;
  grabY: number;
  ghostWidth: number;
  ghostHeight: number;
  longPressTimer: number | null;
}

export interface DragViewportBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** ドラッグゴースト全体が表示領域内に残るよう左上座標を丸める。 */
export function clampCardDragPosition(
  left: number,
  top: number,
  cardWidth: number,
  cardHeight: number,
  viewport: DragViewportBounds,
): { left: number; top: number } {
  const maxLeft = Math.max(
    viewport.left,
    viewport.left + viewport.width - cardWidth,
  );
  const maxTop = Math.max(
    viewport.top,
    viewport.top + viewport.height - cardHeight,
  );
  return {
    left: Math.min(Math.max(left, viewport.left), maxLeft),
    top: Math.min(Math.max(top, viewport.top), maxTop),
  };
}

/** ドラッグ直後に発火するclickが選択操作として誤爆しないよう1回だけ握りつぶす */
function suppressNextClick() {
  const suppress = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    remove();
  };
  const remove = () => {
    window.removeEventListener("click", suppress, true);
    window.clearTimeout(timer);
  };
  // クリックが来ないパス (タッチ等) でも次の正当なクリックを食わないよう保険
  const timer = window.setTimeout(remove, 400);
  window.addEventListener("click", suppress, true);
}

export function useCardDrag(handlers: {
  onDragStart: (payload: DragPayload) => void;
  onDrop: (payload: DragPayload, dropElement: Element | null) => void;
  onCancel: () => void;
}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const stateRef = useRef<PressState | null>(null);
  const cleanupRef = useRef<() => void>(() => {});

  useEffect(() => () => cleanupRef.current(), []);

  const press = (
    payload: DragPayload,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (stateRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const state: PressState = {
      payload,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      sourceEl: event.currentTarget,
      dragging: false,
      dragLayer: null,
      ghost: null,
      grabX: 0,
      grabY: 0,
      ghostWidth: 0,
      ghostHeight: 0,
      longPressTimer: null,
    };
    stateRef.current = state;

    const preventTouchScroll = (touchEvent: TouchEvent) =>
      touchEvent.preventDefault();
    const preventContextMenu = (menuEvent: Event) => menuEvent.preventDefault();

    const cleanup = () => {
      if (state.longPressTimer !== null)
        window.clearTimeout(state.longPressTimer);
      state.dragLayer?.remove();
      state.dragLayer = null;
      state.ghost = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("touchmove", preventTouchScroll);
      window.removeEventListener("contextmenu", preventContextMenu, true);
      document.body.classList.remove("dragging-card");
      stateRef.current = null;
      cleanupRef.current = () => {};
    };
    cleanupRef.current = cleanup;

    const positionGhost = (x: number, y: number) => {
      if (!state.ghost) return;
      const visualViewport = window.visualViewport;
      const viewport = {
        left: visualViewport?.offsetLeft ?? 0,
        top: visualViewport?.offsetTop ?? 0,
        width: visualViewport?.width ?? window.innerWidth,
        height: visualViewport?.height ?? window.innerHeight,
      };
      const pos = clampCardDragPosition(
        x - state.grabX,
        y - state.grabY,
        state.ghostWidth,
        state.ghostHeight,
        viewport,
      );
      state.ghost.style.transform = `translate3d(${pos.left}px, ${pos.top}px, 0)`;
    };

    const startDrag = (x: number, y: number) => {
      if (state.dragging) return;
      state.dragging = true;
      if (state.longPressTimer !== null) {
        window.clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      }
      const rect = state.sourceEl.getBoundingClientRect();
      state.grabX = x - rect.left;
      state.grabY = y - rect.top;
      state.ghostWidth = rect.width;
      state.ghostHeight = rect.height;
      const ghost = state.sourceEl.cloneNode(true) as HTMLElement;
      ghost.classList.add("card-drag-ghost");
      ghost.classList.remove(
        "card-action-pending",
        "card-draw-pending",
        "card-selected",
      );
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      const dragLayer = document.createElement("div");
      dragLayer.className = "card-drag-layer";
      dragLayer.setAttribute("aria-hidden", "true");
      dragLayer.appendChild(ghost);
      state.dragLayer = dragLayer;
      state.ghost = ghost;
      // DOMへ出す前に初期座標を確定し、左上(0, 0)からの遷移を見せない。
      positionGhost(x, y);
      document.body.appendChild(dragLayer);
      // 初期位置をtransitionなしで確定してから、以降の移動だけ滑らかに補間する。
      void ghost.offsetWidth;
      ghost.classList.add("card-drag-ghost-ready");
      // ドラッグ確定後はスクロールと長押しメニューを抑止する
      // (タッチはここまで指が止まっていたので、以降のtouchmoveを止められる)
      window.addEventListener("touchmove", preventTouchScroll, {
        passive: false,
      });
      window.addEventListener("contextmenu", preventContextMenu, true);
      document.body.classList.add("dragging-card");
      handlersRef.current.onDragStart(state.payload);
    };

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== state.pointerId) return;
      if (!state.dragging) {
        const distance = Math.hypot(
          moveEvent.clientX - state.startX,
          moveEvent.clientY - state.startY,
        );
        if (state.pointerType === "touch") {
          if (distance > TOUCH_CANCEL_MOVE_PX) {
            cleanup();
            return;
          }
        } else if (distance > MOUSE_MOVE_THRESHOLD_PX) {
          startDrag(moveEvent.clientX, moveEvent.clientY);
        }
      }
      if (state.dragging) positionGhost(moveEvent.clientX, moveEvent.clientY);
    };

    const onUp = (upEvent: globalThis.PointerEvent) => {
      if (upEvent.pointerId !== state.pointerId) return;
      const wasDragging = state.dragging;
      const dropPayload = state.payload;
      let dropElement: Element | null = null;
      if (wasDragging) {
        // ゴーストがヒットテストを遮らないよう先に除去する (pointer-events:noneでも保険)
        state.dragLayer?.remove();
        state.dragLayer = null;
        state.ghost = null;
        dropElement = document.elementFromPoint(
          upEvent.clientX,
          upEvent.clientY,
        );
        suppressNextClick();
      }
      cleanup();
      if (wasDragging) handlersRef.current.onDrop(dropPayload, dropElement);
    };

    const onPointerCancel = (cancelEvent: globalThis.PointerEvent) => {
      if (cancelEvent.pointerId !== state.pointerId) return;
      const wasDragging = state.dragging;
      cleanup();
      if (wasDragging) handlersRef.current.onCancel();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onPointerCancel);
    if (event.pointerType === "touch") {
      state.longPressTimer = window.setTimeout(
        () => startDrag(state.startX, state.startY),
        LONG_PRESS_MS,
      );
    }
  };

  return { press };
}
