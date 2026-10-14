// 対戦画面の表示・操作：drawAnimations。
import type { PlayerId } from "../../game/types";

import { CardView } from "../cards/CardView";
import type { CSSProperties } from "react";

export type DrawFlight = {
  id: string;
  /** handReturn: 引き直し前から持っていた手札を山札へ戻す、最初の演出 */
  kind: "draw" | "return" | "handReturn";
  uid: string;
  cardId?: string;
  artworkKey?: string;
  player: PlayerId;
  own: boolean;
  redraw: boolean;
  batchIndex: number;
  startX: number;
  startY: number;
  controlX: number;
  controlY: number;
  endX: number;
  endY: number;
  width: number;
  height: number;
  duration: number;
  delay: number;
  removeDelay: number;
  holdAtDestination: boolean;
};

/**
 * 山札と手札を結ぶ弧の座標。ドローは山札→手札、引き直しで戻す演出は
 * 手札→山札と、同じ弧を向きだけ変えて使う。
 */
export function deckFlightGeometry(
  sourceRect: DOMRect,
  boardRect: DOMRect | undefined,
  targetRect: DOMRect | undefined,
  own: boolean,
): DeckFlightGeometry {
  const width = Math.max(
    58,
    Math.min(targetRect?.width || Number(sourceRect.width) || 78, 78),
  );
  const height = width * (109 / 78);
  const deckX = sourceRect.left + sourceRect.width / 2 - width / 2;
  const deckY = sourceRect.top + sourceRect.height / 2 - height / 2;
  const rawHandX = own
    ? (targetRect?.left ?? window.innerWidth / 2 - width / 2)
    : (boardRect?.left ?? 0) +
      (boardRect?.width ?? window.innerWidth) / 2 -
      width / 2;
  const rawHandY = own
    ? (targetRect?.top ?? window.innerHeight - height - 24)
    : Math.max(66, (boardRect?.top ?? 120) - height * 0.36);
  const handX = Math.min(
    Math.max(10, rawHandX),
    window.innerWidth - width - 10,
  );
  const handY = Math.min(
    Math.max(58, rawHandY),
    window.innerHeight - height - 10,
  );
  const controlY = Math.max(
    92,
    Math.min(deckY, handY) -
      Math.min(110, Math.max(48, Math.abs(handY - deckY) * 0.28)),
  );
  return { deckX, deckY, handX, handY, controlY, width, height };
}

export function DrawAnimationLayer({ flights }: { flights: DrawFlight[] }) {
  if (flights.length === 0) return null;
  return (
    <div className="draw-fx-layer" aria-hidden="true">
      {flights.map((flight) => {
        const returning = flight.kind !== "draw";
        return (
          <div
            key={flight.id}
            className={`draw-fx-flight${flight.own ? " is-own" : " is-opponent"}${returning ? " is-return" : ""}`}
            style={
              {
                "--draw-start-x": `${flight.startX}px`,
                "--draw-start-y": `${flight.startY}px`,
                "--draw-control-x": `${flight.controlX}px`,
                "--draw-control-y": `${flight.controlY}px`,
                "--draw-end-x": `${flight.endX}px`,
                "--draw-end-y": `${flight.endY}px`,
                "--draw-card-width": `${flight.width}px`,
                "--draw-card-height": `${flight.height}px`,
                "--draw-duration": `${flight.duration}ms`,
                "--draw-delay": `${flight.delay}ms`,
                "--draw-start-opacity": returning ? "1" : "0",
                "--draw-end-opacity": flight.holdAtDestination ? "1" : "0",
              } as CSSProperties
            }
          >
            <span className="draw-fx-streak" />
            <div className="draw-fx-card">
              <div className="draw-fx-face draw-fx-front">
                <CardView
                  cardId={flight.cardId}
                  artworkKey={flight.artworkKey}
                  size="md"
                />
              </div>
              <div className="draw-fx-face draw-fx-back">
                <CardView faceDown backKind="holomen" size="md" />
              </div>
            </div>
            <span className="draw-fx-label">
              {returning
                ? flight.own
                  ? "RETURN"
                  : "OPPONENT RETURN"
                : flight.own
                  ? "DRAW"
                  : "OPPONENT DRAW"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export type DeckFlightGeometry = {
  deckX: number;
  deckY: number;
  handX: number;
  handY: number;
  controlY: number;
  width: number;
  height: number;
};
