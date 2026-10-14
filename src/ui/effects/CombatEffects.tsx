import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cardImageUrl, getCard } from "../../data/loader";
import * as E from "../../game/engine";
import type { GameState, LogEntry, PlayerId } from "../../game/types";

type CombatKind = "art" | "special";
type CombatMode = "attack" | "impact";
type CombatSlot = "center" | "collab" | "back";

type StoredRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type CombatStackState = {
  id: number;
  player: PlayerId;
  slot: CombatSlot;
  topUid: string;
  cardId?: string;
  artworkKey?: string;
  name: string;
  damage: number;
  maxHp: number;
  remainingHp: number;
  usedArts: boolean;
  resting: boolean;
};

type ArtDeclaration = {
  logIndex: number;
  player: PlayerId;
  sourceName: string;
  artName: string;
  targetName: string;
  targetSlot?: CombatSlot;
};

type ArtDamageLog = {
  logIndex: number;
  player: PlayerId;
  artName: string;
  targetName: string;
  damage: number;
  critical: boolean;
  sourceStackId?: number;
  targetStackId?: number;
};

type SpecialDamageLog = {
  logIndex: number;
  targetPlayer: PlayerId;
  targetName: string;
  damage: number;
  sourceStackId?: number;
  targetStackId?: number;
};

type ArtBlockLog = {
  logIndex: number;
  attacker: PlayerId;
  targetName: string;
  sourceStackId?: number;
  targetStackId?: number;
};

type SpecialBlockLog = {
  logIndex: number;
  targetPlayer: PlayerId;
  targetName: string;
  sourceStackId?: number;
  targetStackId?: number;
};

type ActiveArt = {
  player: PlayerId;
  sourceStackId: number;
  artName: string;
  targetStackId?: number;
  attackShown: boolean;
};

export type CombatEffect = {
  id: string;
  kind: CombatKind;
  mode: CombatMode;
  name: string;
  damage?: number;
  critical: boolean;
  source?: StoredRect;
  target: StoredRect;
  targetStackId: number;
  targetCardImage?: string;
  targetResting: boolean;
  targetMaxHp: number;
  targetRemainingHp: number;
  delay: number;
};

const COMBAT_EFFECT_DURATION = 1180;

function combatSnapshot(game: GameState): CombatStackState[] {
  return ([0, 1] as const).flatMap((player) => {
    const state = game.players[player];
    const entries = [
      ...(state.center
        ? [{ stack: state.center, slot: "center" as const }]
        : []),
      ...(state.collab
        ? [{ stack: state.collab, slot: "collab" as const }]
        : []),
      ...state.back.map((stack) => ({ stack, slot: "back" as const })),
    ];
    return entries.map(({ stack, slot }) => {
      const topUid = stack.cards[0];
      const cardId = game.uidToCard[topUid];
      const card =
        !stack.faceDown && cardId && cardId !== "hidden"
          ? getCard(cardId)
          : null;
      const maxHp = stack.faceDown || !card ? 0 : E.effectiveMaxHp(game, stack);
      return {
        id: stack.id,
        player,
        slot,
        topUid,
        cardId,
        artworkKey: game.uidToArtwork?.[topUid],
        name: card?.name ?? "裏向きカード",
        damage: stack.damage,
        maxHp,
        remainingHp: Math.max(0, maxHp - stack.damage),
        usedArts: stack.usedArtsThisTurn,
        resting: stack.resting,
      };
    });
  });
}

function captureCombatRects(): Map<number, StoredRect> {
  const rects = new Map<number, StoredRect>();
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-combat-stack-id]",
  )) {
    const id = Number(element.dataset.combatStackId);
    if (!Number.isInteger(id)) continue;
    const cardElement = element.querySelector<HTMLElement>(".stack-top");
    const rect = (cardElement ?? element).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    rects.set(id, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  return rects;
}

export function parseCombatLogs(logs: LogEntry[]) {
  const declarations: ArtDeclaration[] = [];
  const artDamages: ArtDamageLog[] = [];
  const specialDamages: SpecialDamageLog[] = [];
  const artBlocks: ArtBlockLog[] = [];
  const specialBlocks: SpecialBlockLog[] = [];

  logs.forEach((entry, logIndex) => {
    if (entry.player === null) return;

    const specialCombat =
      entry.combat?.kind === "special" ? entry.combat : undefined;
    const artCombat = entry.combat?.kind === "art" ? entry.combat : undefined;
    if (specialCombat?.blocked) {
      specialBlocks.push({
        logIndex,
        targetPlayer: entry.player,
        targetName: /^(.+?)は/.exec(entry.text)?.[1] ?? "",
        sourceStackId: specialCombat.sourceStackId,
        targetStackId: specialCombat.targetStackId,
      });
      return;
    }

    const initial =
      /^(.+)のアーツ「([^」]+)」→ (センター|コラボ|バック)の(.+)$/.exec(
        entry.text,
      );
    if (initial) {
      declarations.push({
        logIndex,
        player: entry.player,
        sourceName: initial[1],
        artName: initial[2],
        targetSlot:
          initial[3] === "センター"
            ? "center"
            : initial[3] === "コラボ"
              ? "collab"
              : "back",
        targetName: initial[4],
      });
      return;
    }

    const repeat = /^(.+)のアーツ「([^」]+)」をもう1回使います → (.+)$/.exec(
      entry.text,
    );
    if (repeat) {
      declarations.push({
        logIndex,
        player: entry.player,
        sourceName: repeat[1],
        artName: repeat[2],
        targetName: repeat[3],
      });
      return;
    }

    const artDamage = /^アーツ「([^」]+)」で(.+)に(\d+)ダメージ/.exec(
      entry.text,
    );
    if (artDamage) {
      artDamages.push({
        logIndex,
        player: entry.player,
        artName: artDamage[1],
        targetName: artDamage[2],
        damage: Number(artDamage[3]),
        critical: entry.text.includes("特攻適用"),
        sourceStackId: artCombat?.sourceStackId,
        targetStackId: artCombat?.targetStackId,
      });
      return;
    }

    const artBlock = /^(.+)は相手からアーツダメージを受けません$/.exec(
      entry.text,
    );
    if (artBlock) {
      artBlocks.push({
        logIndex,
        attacker: entry.player,
        targetName: artBlock[1],
        sourceStackId: artCombat?.sourceStackId,
        targetStackId: artCombat?.targetStackId,
      });
      return;
    }

    const specialDamage = /^(.+)に特殊ダメージ(\d+)/.exec(entry.text);
    if (specialDamage) {
      specialDamages.push({
        logIndex,
        targetPlayer: entry.player,
        targetName: specialDamage[1],
        damage: Number(specialDamage[2]),
        sourceStackId: specialCombat?.sourceStackId,
        targetStackId: specialCombat?.targetStackId,
      });
      return;
    }

    const specialBlock =
      /^(.+)(?:は特殊ダメージを受けません|は相手からダメージを受けません)$/.exec(
        entry.text,
      );
    if (specialBlock) {
      specialBlocks.push({
        logIndex,
        targetPlayer: entry.player,
        targetName: specialBlock[1],
      });
    }
  });

  return {
    declarations,
    artDamages,
    specialDamages,
    artBlocks,
    specialBlocks,
  };
}

function other(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function mergedStacks(
  previous: CombatStackState[],
  current: CombatStackState[],
): CombatStackState[] {
  const stacks = new Map(previous.map((stack) => [stack.id, stack]));
  for (const stack of current) stacks.set(stack.id, stack);
  return [...stacks.values()];
}

function findSourceStack(
  declaration: ArtDeclaration,
  previous: CombatStackState[],
  current: CombatStackState[],
): CombatStackState | undefined {
  const previousById = new Map(previous.map((stack) => [stack.id, stack]));
  const candidates = current.filter(
    (stack) =>
      stack.player === declaration.player &&
      stack.name === declaration.sourceName,
  );
  return (
    candidates.find(
      (stack) => stack.usedArts && !previousById.get(stack.id)?.usedArts,
    ) ?? candidates.find((stack) => stack.usedArts)
  );
}

function findCombatStack(
  stackId: number | undefined,
  previous: CombatStackState[],
  current: CombatStackState[],
): CombatStackState | undefined {
  if (stackId === undefined) return undefined;
  return mergedStacks(previous, current).find((stack) => stack.id === stackId);
}

function findTargetStack(
  name: string,
  player: PlayerId,
  previous: CombatStackState[],
  current: CombatStackState[],
  slot?: CombatSlot,
): CombatStackState | undefined {
  const previousById = new Map(previous.map((stack) => [stack.id, stack]));
  const currentById = new Map(current.map((stack) => [stack.id, stack]));
  const candidates = mergedStacks(previous, current).filter(
    (stack) => stack.player === player && stack.name === name,
  );
  return candidates.sort((left, right) => {
    const score = (stack: CombatStackState) => {
      const before = previousById.get(stack.id);
      const after = currentById.get(stack.id);
      return (
        (slot && stack.slot === slot ? 8 : 0) +
        (before && after && after.damage > before.damage ? 6 : 0) +
        (before && !after ? 4 : 0) +
        (after ? 2 : 0)
      );
    };
    return score(right) - score(left);
  })[0];
}

export function useCombatAnimations(game: GameState) {
  const [effects, setEffects] = useState<CombatEffect[]>([]);
  const previousSnapshotRef = useRef<CombatStackState[] | null>(null);
  const previousRectsRef = useRef<Map<number, StoredRect>>(new Map());
  const previousLogIdRef = useRef(game.log.at(-1)?.id ?? 0);
  const activeArtRef = useRef<ActiveArt | null>(null);
  const timersRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    const previous = previousSnapshotRef.current;
    const previousRects = previousRectsRef.current;
    const previousLogId = previousLogIdRef.current;
    const newLogs = game.log.filter((entry) => entry.id > previousLogId);
    const current = combatSnapshot(game);
    const currentRects = captureCombatRects();
    previousSnapshotRef.current = current;
    previousRectsRef.current = currentRects;
    previousLogIdRef.current = game.log.at(-1)?.id ?? previousLogId;

    const shouldClearActiveArt = game.step !== "performance";
    if (
      !previous ||
      newLogs.length === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      if (shouldClearActiveArt) activeArtRef.current = null;
      return;
    }

    const {
      declarations,
      artDamages,
      specialDamages,
      artBlocks,
      specialBlocks,
    } = parseCombatLogs(newLogs);
    if (
      declarations.length === 0 &&
      artDamages.length === 0 &&
      specialDamages.length === 0 &&
      artBlocks.length === 0 &&
      specialBlocks.length === 0
    ) {
      if (shouldClearActiveArt) activeArtRef.current = null;
      return;
    }

    const nextEffects: CombatEffect[] = [];
    const consumedArtDamageLogs = new Set<number>();
    const consumedArtBlockLogs = new Set<number>();
    let effectIndex = 0;
    const rectFor = (stackId: number) =>
      currentRects.get(stackId) ?? previousRects.get(stackId);
    const pushEffect = ({
      kind,
      mode,
      name,
      damage,
      critical = false,
      sourceStackId,
      target,
    }: {
      kind: CombatKind;
      mode: CombatMode;
      name: string;
      damage?: number;
      critical?: boolean;
      sourceStackId?: number;
      target: CombatStackState | undefined;
    }) => {
      if (!target) return;
      const targetRect = rectFor(target.id);
      if (!targetRect) return;
      nextEffects.push({
        id: `${game.rev}-${kind}-${target.id}-${effectIndex}`,
        kind,
        mode,
        name,
        damage,
        critical,
        source:
          sourceStackId === undefined ? undefined : rectFor(sourceStackId),
        target: targetRect,
        targetStackId: target.id,
        targetCardImage: current.some((stack) => stack.id === target.id)
          ? undefined
          : target.cardId
            ? (cardImageUrl(target.cardId, target.artworkKey) ?? undefined)
            : undefined,
        targetResting: target.resting,
        targetMaxHp: target.maxHp,
        targetRemainingHp: target.remainingHp,
        delay: effectIndex * 105,
      });
      effectIndex++;
    };

    declarations.forEach((declaration, declarationIndex) => {
      const nextDeclarationLogIndex =
        declarations[declarationIndex + 1]?.logIndex ??
        Number.POSITIVE_INFINITY;
      const matchingDamages = artDamages.filter(
        (damage) =>
          damage.logIndex > declaration.logIndex &&
          damage.logIndex < nextDeclarationLogIndex &&
          damage.artName === declaration.artName,
      );
      const matchingBlocks = artBlocks.filter(
        (block) =>
          block.logIndex > declaration.logIndex &&
          block.logIndex < nextDeclarationLogIndex &&
          block.attacker === declaration.player &&
          block.targetName === declaration.targetName,
      );
      const source =
        findSourceStack(declaration, previous, current) ??
        findCombatStack(
          matchingDamages[0]?.sourceStackId ?? matchingBlocks[0]?.sourceStackId,
          previous,
          current,
        ) ??
        mergedStacks(previous, current).find(
          (stack) =>
            stack.id === activeArtRef.current?.sourceStackId &&
            stack.player === declaration.player,
        );
      const declaredTarget = findTargetStack(
        declaration.targetName,
        other(declaration.player),
        previous,
        current,
        declaration.targetSlot,
      );

      if (source)
        activeArtRef.current = {
          player: declaration.player,
          sourceStackId: source.id,
          artName: declaration.artName,
          targetStackId: declaredTarget?.id,
          attackShown: matchingDamages.length > 0 || matchingBlocks.length > 0,
        };

      // 任意効果やリアクティブ確認でダメージ処理が保留された場合は、
      // 宣言時点では攻撃演出を出さず、実ダメージのログ到着まで待つ。
      if (matchingDamages.length === 0 && matchingBlocks.length === 0) return;

      matchingDamages.forEach((damage) => {
        consumedArtDamageLogs.add(damage.logIndex);
        const target =
          findCombatStack(damage.targetStackId, previous, current) ??
          findTargetStack(
            damage.targetName,
            other(declaration.player),
            previous,
            current,
          ) ??
          declaredTarget;
        pushEffect({
          kind: "art",
          mode: "attack",
          name: declaration.artName,
          damage: damage.damage,
          critical: damage.critical,
          sourceStackId: source?.id,
          target,
        });
      });

      matchingBlocks.forEach((block) => {
        consumedArtBlockLogs.add(block.logIndex);
        const target =
          findCombatStack(block.targetStackId, previous, current) ??
          findTargetStack(
            block.targetName,
            other(block.attacker),
            previous,
            current,
            declaration.targetSlot,
          ) ??
          declaredTarget;
        pushEffect({
          kind: "art",
          mode: "attack",
          name: declaration.artName,
          damage: 0,
          sourceStackId: source?.id,
          target,
        });
      });
    });

    artDamages
      .filter((damage) => !consumedArtDamageLogs.has(damage.logIndex))
      .forEach((damage) => {
        const pending = activeArtRef.current;
        const active =
          pending?.player === damage.player &&
          pending.artName === damage.artName
            ? pending
            : null;
        const target = findTargetStack(
          damage.targetName,
          other(damage.player),
          previous,
          current,
        );
        const exactTarget =
          findCombatStack(damage.targetStackId, previous, current) ?? target;
        pushEffect({
          kind: "art",
          mode: active?.attackShown ? "impact" : "attack",
          name: damage.artName,
          damage: damage.damage,
          critical: damage.critical,
          sourceStackId: active?.sourceStackId ?? damage.sourceStackId,
          target: exactTarget,
        });
        if (active && !active.attackShown)
          activeArtRef.current = { ...active, attackShown: true };
      });

    artBlocks
      .filter((block) => !consumedArtBlockLogs.has(block.logIndex))
      .forEach((block) => {
        const pending = activeArtRef.current;
        const active = pending?.player === block.attacker ? pending : null;
        const target =
          findCombatStack(block.targetStackId, previous, current) ??
          findTargetStack(
            block.targetName,
            other(block.attacker),
            previous,
            current,
          );
        pushEffect({
          kind: "art",
          mode: active?.attackShown ? "impact" : "attack",
          name: active?.artName ?? "DAMAGE BLOCKED",
          damage: 0,
          sourceStackId: active?.sourceStackId ?? block.sourceStackId,
          target,
        });
        if (active && !active.attackShown)
          activeArtRef.current = { ...active, attackShown: true };
      });

    specialDamages.forEach((damage) => {
      const target =
        findCombatStack(damage.targetStackId, previous, current) ??
        findTargetStack(
          damage.targetName,
          damage.targetPlayer,
          previous,
          current,
        );
      const sourceStackId =
        damage.sourceStackId !== target?.id &&
        damage.sourceStackId !== undefined &&
        rectFor(damage.sourceStackId)
          ? damage.sourceStackId
          : undefined;
      pushEffect({
        kind: "special",
        mode: sourceStackId === undefined ? "impact" : "attack",
        name: "SPECIAL DAMAGE",
        damage: damage.damage,
        sourceStackId,
        target,
      });
    });

    specialBlocks.forEach((block) => {
      const target =
        findCombatStack(block.targetStackId, previous, current) ??
        findTargetStack(
          block.targetName,
          block.targetPlayer,
          previous,
          current,
        );
      const sourceStackId =
        block.sourceStackId !== target?.id &&
        block.sourceStackId !== undefined &&
        rectFor(block.sourceStackId)
          ? block.sourceStackId
          : undefined;
      pushEffect({
        kind: "special",
        mode: sourceStackId === undefined ? "impact" : "attack",
        name: "DAMAGE IMMUNE",
        damage: 0,
        sourceStackId,
        target,
      });
    });

    if (shouldClearActiveArt) activeArtRef.current = null;
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
      }, COMBAT_EFFECT_DURATION + effect.delay);
      timersRef.current.push(timer);
    }
  }, [game]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  return effects;
}

export function CombatAnimationLayer({ effects }: { effects: CombatEffect[] }) {
  if (effects.length === 0) return null;
  return (
    <div className="combat-fx-layer" aria-hidden="true">
      {effects.map((effect) => {
        const source = effect.source ?? effect.target;
        const sourceX = source.left + source.width / 2;
        const sourceY = source.top + source.height / 2;
        const targetX = effect.target.left + effect.target.width / 2;
        const targetY = effect.target.top + effect.target.height / 2;
        const deltaX = targetX - sourceX;
        const deltaY = targetY - sourceY;
        const distance = Math.hypot(deltaX, deltaY);
        const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
        const impactDelay = effect.delay + (effect.mode === "attack" ? 350 : 0);
        const damageText =
          effect.damage === undefined
            ? null
            : effect.damage > 0
              ? `-${effect.damage}`
              : "BLOCK";
        const targetHpRatio =
          effect.targetMaxHp > 0
            ? Math.max(
                0,
                Math.min(
                  100,
                  (effect.targetRemainingHp / effect.targetMaxHp) * 100,
                ),
              )
            : 0;
        const targetHealthClass =
          targetHpRatio <= 25
            ? "is-low"
            : targetHpRatio <= 55
              ? "is-mid"
              : "is-high";
        return (
          <div
            key={effect.id}
            className={`combat-fx-effect is-${effect.kind} is-${effect.mode}${effect.critical ? " is-critical" : ""}`}
            style={
              {
                "--combat-source-x": `${sourceX}px`,
                "--combat-source-y": `${sourceY}px`,
                "--combat-source-left": `${source.left}px`,
                "--combat-source-top": `${source.top}px`,
                "--combat-source-width": `${source.width}px`,
                "--combat-source-height": `${source.height}px`,
                "--combat-target-x": `${targetX}px`,
                "--combat-target-y": `${targetY}px`,
                "--combat-target-left": `${effect.target.left}px`,
                "--combat-target-top": `${effect.target.top}px`,
                "--combat-target-width": `${effect.target.width}px`,
                "--combat-target-height": `${effect.target.height}px`,
                "--combat-delta-x": `${deltaX}px`,
                "--combat-delta-y": `${deltaY}px`,
                "--combat-distance": `${distance}px`,
                "--combat-angle": `${angle}deg`,
                "--combat-mid-x": `${sourceX + deltaX * 0.5}px`,
                "--combat-mid-y": `${sourceY + deltaY * 0.5}px`,
                "--combat-delay": `${effect.delay}ms`,
                "--combat-impact-delay": `${impactDelay}ms`,
              } as CSSProperties
            }
          >
            {effect.targetCardImage && (
              <span
                className={`combat-fx-target-ghost${effect.targetResting ? " is-resting" : ""}`}
              >
                <img src={effect.targetCardImage} alt="" />
                <span
                  className={`hp-bar combat-fx-ghost-hp ${targetHealthClass}`}
                  style={
                    { "--hp-percent": `${targetHpRatio}%` } as CSSProperties
                  }
                >
                  <span className="hp-bar-track">
                    <span className="hp-bar-fill" />
                  </span>
                  <span className="hp-bar-value">
                    <strong data-value={effect.targetRemainingHp}>
                      {effect.targetRemainingHp}
                    </strong>
                  </span>
                </span>
              </span>
            )}
            {effect.mode === "attack" && effect.source && (
              <>
                <span className="combat-fx-source-aura" />
                <span className="combat-fx-beam">
                  <i />
                </span>
                <span className="combat-fx-projectile" />
              </>
            )}
            <span className="combat-fx-impact" />
            <span className="combat-fx-shards">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="combat-fx-name">
              {effect.kind === "art" ? `ARTS • ${effect.name}` : effect.name}
            </span>
            {damageText && (
              <span className="combat-fx-damage">{damageText}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
