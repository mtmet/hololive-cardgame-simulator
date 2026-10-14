import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { GamePhase, GameState, PlayerId } from "../../game/types";

export type GameFlowSnapshot = {
  phase: GamePhase;
  turn: number;
  turnPlayer: PlayerId;
  winner: PlayerId | null;
  liveStart: boolean;
  latestLogId: number;
};

type LiveStartEffect = {
  id: string;
  kind: "liveStart";
};

type TurnStartEffect = {
  id: string;
  kind: "turn";
  player: PlayerId;
  playerName: string;
  turn: number;
  own: boolean;
};

type ResultEffect = {
  id: string;
  kind: "result";
  outcome: "victory" | "defeat" | "draw";
  winnerName: string | null;
  reason: string | null;
  /** リーサル攻撃の演出が終わるまで勝利演出を待つ時間 */
  delayMs: number;
};

export type GameFlowEffect = LiveStartEffect | TurnStartEffect | ResultEffect;

const LIVE_START_EFFECT_DURATION = 1900;
const TURN_EFFECT_DURATION = 1450;
const RESULT_EFFECT_DURATION = 3100;
const COMBAT_RESULT_DELAY_MS = 1500;

export function gameFlowSnapshot(game: GameState): GameFlowSnapshot {
  return {
    phase: game.phase,
    turn: game.turn,
    turnPlayer: game.turnPlayer,
    winner: game.winner,
    liveStart: game.prompts[0]?.type === "liveStart",
    latestLogId: game.log.at(-1)?.id ?? 0,
  };
}

export function detectGameFlowEffect(
  previous: GameFlowSnapshot,
  game: GameState,
  seat: PlayerId,
): GameFlowEffect | null {
  if (game.phase === "finished" && previous.phase !== "finished") {
    const winner = game.winner;
    const hasFinishingCombat = game.log
      .filter((entry) => entry.id > previous.latestLogId)
      .some(
        (entry) =>
          entry.combat?.kind === "special" ||
          /アーツ「|アーツダメージ/.test(entry.text),
      );
    return {
      id: `game-result-${game.rev}-${winner ?? "draw"}`,
      kind: "result",
      outcome:
        winner === null ? "draw" : winner === seat ? "victory" : "defeat",
      winnerName: winner === null ? null : game.players[winner].name,
      reason: game.winReason,
      delayMs: hasFinishingCombat ? COMBAT_RESULT_DELAY_MS : 0,
    };
  }

  if (game.prompts[0]?.type === "liveStart" && !previous.liveStart) {
    return {
      id: `live-start-${game.rev}`,
      kind: "liveStart",
    };
  }

  const turnStarted =
    game.phase === "playing" &&
    (previous.phase !== "playing" ||
      game.turn !== previous.turn ||
      game.turnPlayer !== previous.turnPlayer);
  if (!turnStarted) return null;

  return {
    id: `turn-start-${game.turn}-${game.turnPlayer}-${game.rev}`,
    kind: "turn",
    player: game.turnPlayer,
    playerName: game.players[game.turnPlayer].name,
    turn: game.turn,
    own: game.turnPlayer === seat,
  };
}

export function useGameFlowAnimations(
  game: GameState,
  seat: PlayerId,
  resultDelayMs = 0,
) {
  const [effects, setEffects] = useState<GameFlowEffect[]>([]);
  const [resultPending, setResultPending] = useState(false);
  const initialSnapshot = gameFlowSnapshot(game);
  const previousRef = useRef({
    ...initialSnapshot,
    liveStart: false,
  });
  const timersRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    const effect = detectGameFlowEffect(previousRef.current, game, seat);
    previousRef.current = gameFlowSnapshot(game);
    if (
      !effect ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const duration =
      effect.kind === "result"
        ? RESULT_EFFECT_DURATION
        : effect.kind === "liveStart"
          ? LIVE_START_EFFECT_DURATION
          : TURN_EFFECT_DURATION;
    const showEffect = () => {
      if (effect.kind === "result") setResultPending(true);
      setEffects((current) => [
        ...current.filter((item) => item.kind !== effect.kind),
        effect,
      ]);
      const removalTimer = window.setTimeout(() => {
        setEffects((current) =>
          current.filter((item) => item.id !== effect.id),
        );
        timersRef.current = timersRef.current.filter(
          (id) => id !== removalTimer,
        );
        if (effect.kind === "result") setResultPending(false);
      }, duration + 100);
      timersRef.current.push(removalTimer);
    };

    const resultDelay =
      effect.kind === "result" ? Math.max(resultDelayMs, effect.delayMs) : 0;
    if (effect.kind === "result" && resultDelay > 0) {
      setResultPending(true);
      const showTimer = window.setTimeout(() => {
        timersRef.current = timersRef.current.filter((id) => id !== showTimer);
        showEffect();
      }, resultDelay);
      timersRef.current.push(showTimer);
      return;
    }

    showEffect();
  }, [game, resultDelayMs, seat]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    },
    [],
  );

  return { effects, resultPending };
}

function resultParticleStyle(index: number): CSSProperties {
  return {
    "--flow-particle-x": `${(index * 37 + 9) % 100}vw`,
    "--flow-particle-delay": `${140 + (index % 7) * 85}ms`,
    "--flow-particle-drift": `${((index % 5) - 2) * 24}px`,
    "--flow-particle-spin": `${(index % 2 === 0 ? 1 : -1) * (210 + index * 13)}deg`,
    "--flow-particle-scale": `${0.72 + (index % 4) * 0.14}`,
  } as CSSProperties;
}

export function GameFlowAnimationLayer({
  effects,
}: {
  effects: GameFlowEffect[];
}) {
  if (effects.length === 0) return null;

  return (
    <div className="game-flow-fx-layer" aria-hidden="true">
      {effects.map((effect) =>
        effect.kind === "liveStart" ? (
          <div key={effect.id} className="game-flow-fx-live-start">
            <div className="game-flow-fx-live-start-veil" />
            <div className="game-flow-fx-live-start-moving-lights">
              {Array.from({ length: 6 }, (_, index) => (
                <i key={index} />
              ))}
            </div>
            <div className="game-flow-fx-live-start-floor">
              <i />
              <i />
              <i />
            </div>
            <div className="game-flow-fx-live-start-beams" />
            <div className="game-flow-fx-live-start-ring ring-one" />
            <div className="game-flow-fx-live-start-ring ring-two" />
            <div className="game-flow-fx-live-start-streak streak-one" />
            <div className="game-flow-fx-live-start-streak streak-two" />
            <div className="game-flow-fx-live-start-banner">
              <span>MATCH START</span>
              <strong>LIVE START</strong>
              <small>hololive OFFICIAL CARD GAME</small>
            </div>
          </div>
        ) : effect.kind === "turn" ? (
          <div
            key={effect.id}
            className={`game-flow-fx-turn${effect.own ? " is-own" : " is-opponent"}`}
          >
            <div className="game-flow-fx-turn-wash" />
            <div className="game-flow-fx-turn-streak streak-one" />
            <div className="game-flow-fx-turn-streak streak-two" />
            <div className="game-flow-fx-turn-banner">
              <span>TURN {effect.turn}</span>
              <strong>{effect.own ? "YOUR TURN" : "OPPONENT TURN"}</strong>
              <small>{effect.playerName}のターン</small>
            </div>
          </div>
        ) : (
          <div
            key={effect.id}
            className={`game-flow-fx-result is-${effect.outcome}`}
          >
            <div className="game-flow-fx-result-veil" />
            <div className="game-flow-fx-result-rays" />
            <div className="game-flow-fx-result-particles">
              {Array.from({ length: 24 }, (_, index) => (
                <i key={index} style={resultParticleStyle(index)} />
              ))}
            </div>
            <div className="game-flow-fx-result-banner">
              <span>
                {effect.outcome === "defeat" ? "GAME OVER" : "GAME SET"}
              </span>
              <strong>
                {effect.outcome === "victory"
                  ? "VICTORY"
                  : effect.outcome === "defeat"
                    ? "DEFEAT"
                    : "DRAW"}
              </strong>
              <b>
                {effect.winnerName ? `${effect.winnerName}の勝利` : "引き分け"}
              </b>
              {effect.reason && <small>{effect.reason}</small>}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
