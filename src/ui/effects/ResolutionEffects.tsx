import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cardImageUrl } from "../../data/loader";
import { diceTiming } from "../../game/engine/animation";
import type {
  DiceResultSummary,
  GameState,
  LogEntry,
  PlayerId,
} from "../../game/types";
import { DiceAnimation } from "./DiceAnimation";

type StoredRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type SourceMetadata = {
  sourceStackId?: number;
  sourceUid?: string;
  sourceOshi?: boolean;
  sourceCardId?: string;
};

type SourceRects = {
  stacks: Map<number, StoredRect>;
  uids: Map<string, StoredRect>;
  oshi: Map<PlayerId, StoredRect>;
  boards: Map<PlayerId, StoredRect>;
};

export type ResolutionLogEvent =
  | (SourceMetadata & {
      kind: "effect";
      logIds: number[];
      player: PlayerId;
      label: string;
    })
  | (SourceMetadata & {
      kind: "dice";
      logIds: number[];
      player: PlayerId;
      label: string;
      results: number[];
      rolledResults: number[];
      rollId?: number;
      summaries: DiceResultSummary[];
      versus: boolean;
    });

export type ResolutionEffect = ResolutionLogEvent & {
  id: string;
  source: StoredRect;
  cardImage: string | null;
  delay: number;
  startsAt: number;
  endsAt: number;
  reducedMotion: boolean;
  phase: "queued" | "rolling" | "result";
};

const EFFECT_DURATION = 1350;

function storedRect(element: HTMLElement | null): StoredRect | null {
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

function captureSourceRects(): SourceRects {
  const stacks = new Map<number, StoredRect>();
  const uids = new Map<string, StoredRect>();
  const oshi = new Map<PlayerId, StoredRect>();
  const boards = new Map<PlayerId, StoredRect>();

  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-combat-stack-id]",
  )) {
    const id = Number(element.dataset.combatStackId);
    if (!Number.isInteger(id)) continue;
    const rect = storedRect(
      element.querySelector<HTMLElement>(".stack-top") ?? element,
    );
    if (rect) stacks.set(id, rect);
  }

  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-animation-uid]",
  )) {
    const uid = element.dataset.animationUid;
    const rect = storedRect(element);
    if (uid && rect) uids.set(uid, rect);
  }

  for (const player of [0, 1] as const) {
    const oshiSlot = document.querySelector<HTMLElement>(
      `[data-oshi-player="${player}"]`,
    );
    const oshiRect = storedRect(
      oshiSlot?.querySelector<HTMLElement>(".card") ?? oshiSlot,
    );
    if (oshiRect) oshi.set(player, oshiRect);

    const board = document.querySelector<HTMLElement>(
      `[data-player="${player}"]`,
    );
    const boardRect = storedRect(board);
    if (boardRect) boards.set(player, boardRect);
  }

  return { stacks, uids, oshi, boards };
}

function sourceRect(
  event: ResolutionLogEvent,
  rects: SourceRects | null,
): StoredRect | null {
  if (!rects) return null;
  if (event.sourceUid) {
    const rect = rects.uids.get(event.sourceUid);
    if (rect) return rect;
  }
  if (event.sourceStackId !== undefined) {
    const rect = rects.stacks.get(event.sourceStackId);
    if (rect) return rect;
  }
  if (event.sourceOshi) {
    const rect = rects.oshi.get(event.player);
    if (rect) return rect;
  }
  const board = rects.boards.get(event.player);
  if (!board) return null;
  return {
    left: board.left + board.width / 2 - 36,
    top: board.top + board.height / 2 - 50,
    width: 72,
    height: 100,
  };
}

export function parseResolutionLogs(logs: LogEntry[]): ResolutionLogEvent[] {
  const events: ResolutionLogEvent[] = [];

  for (const entry of logs) {
    if (entry.player === null || !entry.animation) continue;
    const animation = entry.animation;
    const source = {
      sourceStackId: animation.sourceStackId,
      sourceUid: animation.sourceUid,
      sourceOshi: animation.sourceOshi,
      sourceCardId: animation.sourceCardId,
    };

    if (animation.kind === "effect") {
      events.push({
        kind: "effect",
        logIds: [entry.id],
        player: entry.player,
        label: animation.label,
        ...source,
      });
      continue;
    }

    const previous = events.at(-1);
    const previousLastId = previous?.logIds.at(-1);
    if (
      previous?.kind === "dice" &&
      !previous.versus &&
      !animation.versus &&
      previous.player === entry.player &&
      previous.label === animation.label &&
      previous.rollId === animation.rollId &&
      previous.sourceStackId === source.sourceStackId &&
      (animation.rollId !== undefined ||
        previous.sourceUid === source.sourceUid) &&
      previous.sourceOshi === source.sourceOshi &&
      previous.sourceCardId === source.sourceCardId &&
      previousLastId !== undefined &&
      entry.id === previousLastId + 1
    ) {
      previous.logIds.push(entry.id);
      previous.results.push(...animation.results);
      previous.rolledResults.push(
        ...(animation.rolledResults ?? animation.results),
      );
      continue;
    }

    events.push({
      kind: "dice",
      logIds: [entry.id],
      player: entry.player,
      label: animation.label,
      results: [...animation.results],
      rolledResults: [...(animation.rolledResults ?? animation.results)],
      rollId: animation.rollId,
      summaries: animation.summaries ?? [],
      versus: !!animation.versus,
      ...source,
    });
  }

  return events;
}

export function useResolutionAnimations(game: GameState) {
  const [effects, setEffects] = useState<ResolutionEffect[]>([]);
  const previousLogIdRef = useRef(game.log.at(-1)?.id ?? 0);
  const previousRectsRef = useRef<SourceRects | null>(null);
  const timersRef = useRef<number[]>([]);
  const queueEndsAtRef = useRef(0);

  useLayoutEffect(() => {
    const currentRects = captureSourceRects();
    const previousRects = previousRectsRef.current;
    previousRectsRef.current = currentRects;

    const previousLogId = previousLogIdRef.current;
    const latestLogId = game.log.at(-1)?.id ?? previousLogId;
    const newLogs = game.log.filter((entry) => entry.id > previousLogId);
    previousLogIdRef.current = latestLogId;

    if (newLogs.length === 0) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const now = Date.now();

    let startsAt = Math.max(now, queueEndsAtRef.current);
    const nextEffects = parseResolutionLogs(newLogs).flatMap(
      (event): ResolutionEffect[] => {
        if (reducedMotion && event.kind !== "dice") return [];
        const source = sourceRect(event, currentRects) ??
          sourceRect(event, previousRects) ?? {
            left: window.innerWidth / 2 - 36,
            top: window.innerHeight / 2 - 50,
            width: 72,
            height: 100,
          };
        const duration =
          event.kind === "dice"
            ? diceTiming(event.results.length, reducedMotion).duration
            : EFFECT_DURATION + 120;

        const effect: ResolutionEffect = {
          ...event,
          id: `resolution-${event.kind}-${event.logIds.join("-")}`,
          source,
          cardImage: event.sourceCardId
            ? cardImageUrl(
                event.sourceCardId,
                event.sourceUid
                  ? game.uidToArtwork?.[event.sourceUid]
                  : event.sourceOshi
                    ? game.uidToArtwork?.[game.players[event.player].oshiUid]
                    : undefined,
              )
            : null,
          delay: startsAt - now,
          startsAt,
          endsAt: startsAt + duration,
          reducedMotion,
          phase:
            startsAt > now ? "queued" : reducedMotion ? "result" : "rolling",
        };
        startsAt = effect.endsAt;
        return [effect];
      },
    );

    if (nextEffects.length === 0) return;
    queueEndsAtRef.current = startsAt;
    setEffects((current) => [...current, ...nextEffects]);

    for (const effect of nextEffects) {
      const schedule = (at: number, update: () => void) => {
        const timer = window.setTimeout(
          () => {
            update();
            timersRef.current = timersRef.current.filter((id) => id !== timer);
          },
          Math.max(0, at - Date.now()),
        );
        timersRef.current.push(timer);
      };
      if (effect.kind === "dice") {
        const timing = diceTiming(effect.results.length, reducedMotion);
        const reveal = () =>
          setEffects((current) =>
            current.map((item) =>
              item.id === effect.id ? { ...item, phase: "result" } : item,
            ),
          );
        if (effect.delay > 0)
          schedule(effect.startsAt, () =>
            setEffects((current) =>
              current.map((item) =>
                item.id === effect.id
                  ? { ...item, phase: reducedMotion ? "result" : "rolling" }
                  : item,
              ),
            ),
          );
        if (timing.revealAt > 0)
          schedule(effect.startsAt + timing.revealAt, reveal);
      }
      schedule(effect.endsAt, () => {
        setEffects((current) =>
          current.filter((item) => item.id !== effect.id),
        );
      });
    }
  }, [game]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    },
    [],
  );

  return effects;
}

export function ResolutionAnimationLayer({
  effects,
  viewer,
  playerNames,
}: {
  effects: ResolutionEffect[];
  viewer: PlayerId | null;
  playerNames: [string, string];
}) {
  if (effects.length === 0) return null;

  return (
    <div className="resolution-fx-layer">
      {effects.map((effect) => {
        const sourceX = effect.source.left + effect.source.width / 2;
        const sourceY = effect.source.top + effect.source.height / 2;
        const style = {
          "--resolution-left": `${effect.source.left}px`,
          "--resolution-top": `${effect.source.top}px`,
          "--resolution-width": `${effect.source.width}px`,
          "--resolution-height": `${effect.source.height}px`,
          "--resolution-source-x": `${sourceX}px`,
          "--resolution-source-y": `${sourceY}px`,
          "--resolution-delay": `${effect.delay}ms`,
        } as CSSProperties;

        if (effect.kind === "effect") {
          return (
            <div
              key={effect.id}
              className="resolution-fx-effect"
              style={style}
              aria-hidden="true"
            >
              <div className="resolution-fx-effect-veil" />
              <div className="resolution-fx-source-aura">
                <i />
                <i />
                <strong>✦</strong>
              </div>
              <div className="resolution-fx-effect-banner">
                {effect.cardImage && <img src={effect.cardImage} alt="" />}
                <div>
                  <span>EFFECT ACTIVE</span>
                  <strong>{effect.label}</strong>
                </div>
              </div>
            </div>
          );
        }

        return (
          <DiceAnimation
            key={effect.id}
            effect={effect}
            viewer={viewer}
            playerNames={playerNames}
          />
        );
      })}
    </div>
  );
}
