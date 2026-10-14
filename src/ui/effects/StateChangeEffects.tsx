import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as E from "../../game/engine";
import type {
  GameState,
  HolomenStack,
  PlayerId,
  TurnModifier,
} from "../../game/types";

type StateChangeKind = "buff" | "debuff" | "rest" | "active" | "heal";

type StoredRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ModifierScores = {
  buff: number;
  debuff: number;
};
type StageZone = "center" | "collab" | "back";

type StackStateSnapshot = {
  id: number;
  player: PlayerId;
  zone: StageZone;
  faceDown: boolean;
  resting: boolean;
  damage: number;
  maxHp: number;
  artBonus: number;
  composition: string;
  modifierBuff: number;
  modifierDebuff: number;
};
type StateChangePlan = {
  rev: number;
  hpChangeDelays: ReadonlyMap<number, number>;
};

export type StateChangeEffect = {
  id: string;
  stackId: number;
  kind: StateChangeKind;
  label: string;
  target: StoredRect;
  delay: number;
};

const STATE_EFFECT_DURATION = 960;
const CARD_MOVE_EFFECT_DELAY = 920;

const STATE_VALUE_CHANGE_OFFSET = 220;
function positive(value: number | undefined): number {
  return Math.max(0, value ?? 0);
}

function modifierScores(modifiers: TurnModifier[]): ModifierScores {
  let buff = 0;
  let debuff = 0;
  for (const modifier of modifiers) {
    buff += positive(modifier.artCostless);
    buff += positive(modifier.artColorCostless?.n);
    buff += modifier.artsFree ? 1 : 0;
    buff += modifier.allColors ? 1 : 0;
    buff += positive(modifier.specialPlus);
    buff += positive(modifier.repeatArt);
    buff += positive(modifier.specialAttack?.value);
    buff += modifier.artTargetExtend ? 1 : 0;
    buff += positive(modifier.firstArtDamageReduce);
    buff += modifier.specialImmune ? 1 : 0;
    if ((modifier.batonDelta ?? 0) < 0) buff += -modifier.batonDelta!;
    if ((modifier.specialPlus ?? 0) < 0) debuff += -modifier.specialPlus!;
    if ((modifier.batonDelta ?? 0) > 0) debuff += modifier.batonDelta!;
    if (modifier.noSwitch) debuff += 1;
  }
  return { buff, debuff };
}

function stageStacks(
  game: GameState,
): { player: PlayerId; stack: HolomenStack; zone: StageZone }[] {
  return ([0, 1] as const).flatMap((player) => {
    const state = game.players[player];
    return [
      ...(state.center
        ? [{ player, stack: state.center, zone: "center" as const }]
        : []),
      ...(state.collab
        ? [{ player, stack: state.collab, zone: "collab" as const }]
        : []),
      ...state.back.map((stack) => ({
        player,
        stack,
        zone: "back" as const,
      })),
    ];
  });
}

function stateSnapshot(game: GameState): StackStateSnapshot[] {
  return stageStacks(game).map(({ player, stack, zone }) => {
    const scores = modifierScores(
      game.turnModifiers.filter((modifier) => modifier.stackId === stack.id),
    );
    return {
      id: stack.id,
      player,
      zone,
      faceDown: stack.faceDown,
      resting: stack.resting,
      damage: stack.damage,
      maxHp: stack.faceDown ? 0 : E.effectiveMaxHp(game, stack),
      artBonus: stack.faceDown ? 0 : E.artBonusOf(game, stack),
      composition: [
        ...stack.cards.map((uid) => `h:${uid}`),
        ...stack.supports.map((uid) => `s:${uid}`),
        ...stack.yells.map((uid) => `y:${uid}`),
      ].join("|"),
      modifierBuff: scores.buff,
      modifierDebuff:
        scores.debuff + (game.skipResetActivate.includes(stack.id) ? 1 : 0),
    };
  });
}
function hasCardOrStageMovement(
  previous: StackStateSnapshot[],
  current: StackStateSnapshot[],
): boolean {
  const previousById = new Map(previous.map((stack) => [stack.id, stack]));
  return current.some(
    (stack) =>
      previousById.get(stack.id)?.composition !== stack.composition ||
      previousById.get(stack.id)?.zone !== stack.zone,
  );
}

function hpChangeDelaysFor(
  previous: StackStateSnapshot[] | null,
  current: StackStateSnapshot[],
  delay: number,
): ReadonlyMap<number, number> {
  const delays = new Map<number, number>();
  if (!previous) return delays;
  const previousById = new Map(previous.map((stack) => [stack.id, stack]));
  for (const stack of current) {
    const before = previousById.get(stack.id);
    if (!before || before.faceDown || stack.faceDown) continue;
    if (before.maxHp !== stack.maxHp || before.damage > stack.damage)
      delays.set(stack.id, delay);
  }
  return delays;
}

function captureStackRect(stackId: number): StoredRect | null {
  const stack = document.querySelector<HTMLElement>(
    `[data-combat-stack-id="${stackId}"]`,
  );
  const element = stack?.querySelector<HTMLElement>(".stack-top") ?? stack;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function signedLabel(name: string, delta: number): string {
  return `${name} ${delta > 0 ? "+" : ""}${delta}`;
}

export function useStateChangeAnimations(game: GameState) {
  const [effects, setEffects] = useState<StateChangeEffect[]>([]);
  const previousSnapshotRef = useRef<StackStateSnapshot[] | null>(null);
  const timersRef = useRef<number[]>([]);
  const transitionPlanRef = useRef<StateChangePlan | null>(null);
  if (transitionPlanRef.current?.rev !== game.rev) {
    const previous = previousSnapshotRef.current;
    const current = stateSnapshot(game);
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const movementDelay =
      previous && !reducedMotion && hasCardOrStageMovement(previous, current)
        ? CARD_MOVE_EFFECT_DELAY
        : 0;
    const hpChangeDelay = reducedMotion
      ? 0
      : movementDelay + STATE_VALUE_CHANGE_OFFSET;
    transitionPlanRef.current = {
      rev: game.rev,
      hpChangeDelays: hpChangeDelaysFor(previous, current, hpChangeDelay),
    };
  }
  const hpChangeDelays = transitionPlanRef.current.hpChangeDelays;

  useLayoutEffect(() => {
    const previous = previousSnapshotRef.current;
    const current = stateSnapshot(game);
    previousSnapshotRef.current = current;
    if (
      !previous ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;

    const previousById = new Map(previous.map((stack) => [stack.id, stack]));
    const cardOrStageMovement = hasCardOrStageMovement(previous, current);
    const nextEffects: StateChangeEffect[] = [];

    for (const stack of current) {
      const before = previousById.get(stack.id);
      if (!before || before.faceDown || stack.faceDown) continue;

      const changes: { kind: StateChangeKind; label: string }[] = [];
      if (before.resting !== stack.resting)
        changes.push({
          kind: stack.resting ? "rest" : "active",
          label: stack.resting ? "REST" : "ACTIVE",
        });

      const healed = before.damage - stack.damage;
      if (healed > 0)
        changes.push({ kind: "heal", label: `RECOVER +${healed}` });

      const artDelta = stack.artBonus - before.artBonus;
      const hpDelta = stack.maxHp - before.maxHp;
      const buffDelta = stack.modifierBuff - before.modifierBuff;
      const debuffDelta = stack.modifierDebuff - before.modifierDebuff;
      const buffs: string[] = [];
      const debuffs: string[] = [];

      if (artDelta > 0) buffs.push(signedLabel("ARTS", artDelta));
      if (hpDelta > 0) buffs.push(signedLabel("HP", hpDelta));
      if (buffDelta > 0) buffs.push("POWER UP");
      if (artDelta < 0) debuffs.push(signedLabel("ARTS", artDelta));
      if (hpDelta < 0) debuffs.push(signedLabel("HP", hpDelta));
      if (debuffDelta > 0) debuffs.push("STATUS DOWN");

      if (buffs.length > 0)
        changes.push({ kind: "buff", label: buffs.join(" / ") });
      if (debuffs.length > 0)
        changes.push({ kind: "debuff", label: debuffs.join(" / ") });
      if (changes.length === 0) continue;

      const target = captureStackRect(stack.id);
      if (!target) continue;
      const movementDelay = cardOrStageMovement ? CARD_MOVE_EFFECT_DELAY : 0;

      changes.forEach((change, changeIndex) => {
        nextEffects.push({
          id: `${game.rev}-${stack.id}-${change.kind}-${changeIndex}`,
          stackId: stack.id,
          kind: change.kind,
          label: change.label,
          target,
          delay: movementDelay + changeIndex * 130,
        });
      });
    }

    if (nextEffects.length === 0) return;
    setEffects((currentEffects) => [...currentEffects, ...nextEffects]);
    for (const effect of nextEffects) {
      const timer = window.setTimeout(() => {
        timersRef.current = timersRef.current.filter(
          (currentTimer) => currentTimer !== timer,
        );
        setEffects((currentEffects) =>
          currentEffects.filter((item) => item.id !== effect.id),
        );
      }, STATE_EFFECT_DURATION + effect.delay);
      timersRef.current.push(timer);
    }
  }, [game]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  return { effects, hpChangeDelays };
}

function stateSymbol(kind: StateChangeKind): string {
  if (kind === "buff") return "↑";
  if (kind === "debuff") return "↓";
  if (kind === "rest") return "Z";
  if (kind === "active") return "↻";
  return "+";
}

export function StateChangeAnimationLayer({
  effects,
}: {
  effects: StateChangeEffect[];
}) {
  if (effects.length === 0) return null;
  return (
    <div className="state-fx-layer" aria-hidden="true">
      {effects.map((effect) => (
        <div
          key={effect.id}
          className={`state-fx-effect is-${effect.kind}`}
          style={
            {
              "--state-left": `${effect.target.left}px`,
              "--state-top": `${effect.target.top}px`,
              "--state-width": `${effect.target.width}px`,
              "--state-height": `${effect.target.height}px`,
              "--state-delay": `${effect.delay}ms`,
            } as CSSProperties
          }
        >
          <span className="state-fx-aura">
            <i />
            <i />
          </span>
          <span className="state-fx-particles">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="state-fx-symbol">{stateSymbol(effect.kind)}</span>
          <span className="state-fx-label">{effect.label}</span>
        </div>
      ))}
    </div>
  );
}
