import type { CSSProperties } from "react";
import {
  DICE_EXIT_MS,
  DICE_ROLL_MS,
  diceTiming,
  dieStartDelay,
} from "../../game/engine/animation";
import type { PlayerId } from "../../game/types";
import type { ResolutionEffect } from "./ResolutionEffects";

const DOTS = [
  [4],
  [0, 8],
  [0, 4, 8],
  [0, 2, 6, 8],
  [0, 2, 4, 6, 8],
  [0, 2, 3, 5, 6, 8],
];
// 向かい合う面は合計7。停止時には結果の面を正面へ向ける。
const ROTATIONS = [
  [0, 0],
  [0, -90],
  [-90, 0],
  [90, 0],
  [0, 90],
  [0, 180],
];

type DiceEffect = Extract<ResolutionEffect, { kind: "dice" }>;

function Die({
  rolled,
  result,
  index,
  caption,
}: {
  rolled: number;
  result: number;
  index: number;
  caption: string;
}) {
  const rotation = ROTATIONS[rolled - 1];
  const style = {
    "--die-delay": `${dieStartDelay(index)}ms`,
    "--die-x": `${rotation?.[0] ?? 0}deg`,
    "--die-y": `${rotation?.[1] ?? 0}deg`,
    "--die-direction": index % 2 === 0 ? 1 : -1,
  } as CSSProperties;
  return (
    <div
      className="dice-fx-item"
      style={style}
      data-rolled={rolled}
      data-result={result}
    >
      <span className="dice-fx-caption">{caption}</span>
      <div className="dice-fx-perspective" aria-hidden="true">
        <div className="dice-fx-shadow" />
        {rotation ? (
          <div className="dice-fx-toss">
            <div className="dice-fx-cube">
              {DOTS.map((dots, face) => (
                <div
                  key={face}
                  className={`dice-fx-face dice-fx-face-${face + 1}`}
                >
                  {Array.from({ length: 9 }, (_, dot) => (
                    <i
                      key={dot}
                      className={dots.includes(dot) ? "is-active" : undefined}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="dice-fx-number">{rolled}</div>
        )}
      </div>
      <span className="dice-fx-value">
        出目 <strong>{rolled}</strong>
      </span>
      {rolled !== result && (
        <span className="dice-fx-modified">
          扱う目 <strong>{result}</strong>
        </span>
      )}
    </div>
  );
}

export function DiceAnimation({
  effect,
  viewer,
  playerNames,
}: {
  effect: DiceEffect;
  viewer: PlayerId | null;
  playerNames: [string, string];
}) {
  const timing = diceTiming(effect.results.length, effect.reducedMotion);
  const phase = effect.phase;
  const name = (player: PlayerId) =>
    viewer === null
      ? playerNames[player]
      : player === viewer
        ? "あなた"
        : "相手";
  const columns = Math.min(effect.results.length, 6);
  const style = {
    "--dice-delay": `${effect.delay}ms`,
    "--dice-roll-time": `${DICE_ROLL_MS}ms`,
    "--dice-exit-time": `${DICE_EXIT_MS}ms`,
    "--dice-exit-delay": `${effect.delay + timing.duration - DICE_EXIT_MS}ms`,
    "--dice-columns": Math.max(1, columns),
  } as CSSProperties;
  return (
    <div
      className={`dice-fx${effect.reducedMotion ? " is-reduced" : ""}`}
      data-phase={phase}
      data-log-id={effect.logIds.at(-1)}
      data-count={effect.results.length}
      style={style}
    >
      <div className="dice-fx-backdrop" />
      <section
        className="dice-fx-panel"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <header>
          <span className="dice-fx-owner">
            {effect.versus
              ? "お互いのサイコロ"
              : `${name(effect.player)}のサイコロ`}
          </span>
          <strong>
            {phase === "result" ? "結果" : "サイコロを振っています…"}
          </strong>
          <span className="dice-fx-source">{effect.label}</span>
        </header>
        <div className="dice-fx-grid">
          {effect.results.map((result, index) => (
            <Die
              key={index}
              rolled={effect.rolledResults[index] ?? result}
              result={result}
              index={index}
              caption={
                effect.versus
                  ? name(
                      index === 0
                        ? effect.player
                        : ((1 - effect.player) as PlayerId),
                    )
                  : effect.results.length > 1
                    ? `${index + 1}個目`
                    : ""
              }
            />
          ))}
        </div>
        {effect.summaries.length > 0 && !effect.versus && (
          <div className="dice-fx-summary">
            {effect.summaries.map((summary) => (
              <p key={summary.label}>
                {summary.label}{" "}
                <span className="dice-fx-summary-value">
                  <strong>{summary.value}</strong>
                  {summary.unit}
                </span>
              </p>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
