import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { getCard, yellColorHex } from "../../data/loader";
import type { GameState, PlayerId, PlayerState } from "../../game/types";
import { CardView } from "../cards/CardView";

type ActionKind =
  | "play"
  | "bloom"
  | "attach"
  | "use"
  | "archive"
  | "return"
  | "power"
  | "power-out"
  | "cheer"
  | "collab"
  | "baton"
  | "center";

type ActionZone =
  | "hand"
  | "stage"
  | "attached"
  | "archive"
  | "deck"
  | "holoPower"
  | "life"
  | "cheerDeck"
  | "yell";

type StageSlot = "center" | "collab" | `back:${number}`;

type StageStackState = {
  id: number;
  topUid: string;
  slot: StageSlot;
};

type ActionCardLocation = {
  player: PlayerId;
  zone: ActionZone;
  key: string;
  stackId?: number;
};

type ActionZoneState = {
  hand: string[];
  stage: string[];
  attached: string[];
  archive: string[];
  deck: string[];
  holoPower: string[];
  life: string[];
  cheerDeck: string[];
  yells: string[];
  pendingCheer: string[];
  pendingAttach: string[];
  pendingSources: Record<string, ActionCardLocation>;
  stageStacks: StageStackState[];
  locations: Record<string, Omit<ActionCardLocation, "player">>;
};

type ActionSnapshot = [ActionZoneState, ActionZoneState];

type ActionTransition = {
  player: PlayerId;
  uid: string;
  /**
   * 行き先の盤面で伏せるカードのUID。演出中の重複表示を防ぐために使う。
   * uidがカードの正体 (表面・出発点) を指し、盤面側のUIDと異なる場合に指定する。
   */
  hideUid?: string;
  sourceUid?: string;
  sourcePlayer?: PlayerId;
  sourceZone?: ActionZone;
  sourceStackId?: number;
  targetStackId?: number;
  zone: ActionZone;
  kind?: ActionKind;
  curveDirection?: -1 | 1;
  delay?: number;
  showLabel?: boolean;
};

type StoredRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ActionFlight = {
  id: string;
  uid: string;
  /** 演出中に盤面側で伏せるUID (通常はuidと同じ) */
  hideUid: string;
  cardId?: string;
  artworkKey?: string;
  kind: ActionKind;
  startX: number;
  startY: number;
  controlX: number;
  controlY: number;
  endX: number;
  endY: number;
  width: number;
  height: number;
  startScale: number;
  endScale: number;
  endOvershootScale: number;
  startRotation: number;
  controlRotation: number;
  endOvershootRotation: number;
  endRotation: number;
  delay: number;
  color?: string;
  faceDown: boolean;
  flipToBack: boolean;
  backKind: "holomen" | "yell";
  showLabel: boolean;
};

const ACTION_FLIGHT_DURATION = 820;
const ACTION_LABELS: Record<ActionKind, string> = {
  play: "PLAY",
  bloom: "BLOOM",
  attach: "ATTACH",
  use: "USE",
  archive: "ARCHIVE",
  return: "RETURN",
  power: "HOLOPOWER",
  "power-out": "POWER OUT",
  cheer: "CHEER",
  collab: "COLLAB",
  baton: "BATON TOUCH",
  center: "CENTER",
};

function playerZones(player: PlayerState): ActionZoneState {
  const stacks = [player.center, player.collab, ...player.back].filter(
    (stack) => stack !== null,
  );
  const stageStacks: StageStackState[] = [
    ...(player.center
      ? [
          {
            id: player.center.id,
            topUid: player.center.cards[0],
            slot: "center" as const,
          },
        ]
      : []),
    ...(player.collab
      ? [
          {
            id: player.collab.id,
            topUid: player.collab.cards[0],
            slot: "collab" as const,
          },
        ]
      : []),
    ...player.back.map((stack, index) => ({
      id: stack.id,
      topUid: stack.cards[0],
      slot: `back:${index}` as StageSlot,
    })),
  ];
  const locations: ActionZoneState["locations"] = {};
  const addLocations = (
    uids: string[],
    zone: ActionZone,
    key: string,
    stackId?: number,
  ) => {
    for (const uid of uids) locations[uid] = { zone, key, stackId };
  };
  addLocations(player.hand, "hand", "hand");
  addLocations(player.archive, "archive", "archive");
  addLocations(player.deck, "deck", "deck");
  addLocations(player.holoPower, "holoPower", "holoPower");
  addLocations(player.life, "life", "life");
  addLocations(player.cheerDeck, "cheerDeck", "cheerDeck");
  for (const stack of stacks) {
    addLocations(stack.cards, "stage", `stage:${stack.id}`, stack.id);
    addLocations(stack.supports, "attached", `attached:${stack.id}`, stack.id);
    addLocations(stack.yells, "yell", `yell:${stack.id}`, stack.id);
  }
  return {
    hand: [...player.hand],
    stage: stacks.flatMap((stack) => stack.cards),
    attached: stacks.flatMap((stack) => stack.supports),
    archive: [...player.archive],
    deck: [...player.deck],
    holoPower: [...player.holoPower],
    life: [...player.life],
    cheerDeck: [...player.cheerDeck],
    yells: stacks.flatMap((stack) => stack.yells),
    pendingCheer: [],
    pendingAttach: [],
    pendingSources: {},
    stageStacks,
    locations,
  };
}

function isBackSlot(slot: StageSlot): boolean {
  return slot.startsWith("back:");
}

export function actionSnapshot(game: GameState): ActionSnapshot {
  const snapshot = game.players.map(playerZones) as ActionSnapshot;
  for (const prompt of game.prompts) {
    if (prompt.type === "cheerAssign") {
      snapshot[prompt.player].pendingCheer.push(prompt.yellUid);
      const sourceZone =
        prompt.reason === "cheerStep"
          ? "cheerDeck"
          : prompt.reason === "life"
            ? "life"
            : undefined;
      if (sourceZone)
        snapshot[prompt.player].pendingSources[prompt.yellUid] = {
          player: prompt.player,
          zone: sourceZone,
          key: sourceZone,
        };
    }
    if (prompt.type === "effectAttach")
      snapshot[prompt.player].pendingAttach.push(prompt.uid);
  }
  return snapshot;
}

function findLocation(
  snapshot: ActionSnapshot,
  uid: string,
): ActionCardLocation | null {
  for (const player of [0, 1] as const) {
    const location = snapshot[player].locations[uid];
    if (location) return { player, ...location };
  }
  return null;
}
/**
 * オンラインの視点ビューでは、非公開領域のカードは「領域の何枚目」を表す
 * 不透明UIDで届く。位置が変われば別のUIDになるため、そのままでは
 * 手札→ステージのように非公開と公開をまたぐ移動を前後の状態で対応付けられない。
 */
const HIDDEN_ZONES = [
  "hand",
  "deck",
  "cheerDeck",
  "life",
  "holoPower",
] as const;
type HiddenZone = (typeof HIDDEN_ZONES)[number];

/** 公開領域へ現れたカードの出所として、行き先ごとに認める非公開領域。 */
const REVEAL_SOURCES: Partial<Record<ActionZone, readonly HiddenZone[]>> = {
  stage: ["hand"],
  attached: ["hand"],
  yell: ["cheerDeck", "life"],
  archive: ["hand", "holoPower", "deck"],
};

function isOpaqueUid(uid: string): boolean {
  return uid.startsWith("hidden:");
}

/**
 * 非公開領域の増減枚数。実UIDで届く領域 (自席の手札など) は通常の突き合わせで
 * 追跡できるため対象にしない。
 */
function opaqueZoneBudget(
  previous: ActionZoneState,
  current: ActionZoneState,
  direction: "out" | "in",
): Map<HiddenZone, number> {
  const budget = new Map<HiddenZone, number>();
  for (const zone of HIDDEN_ZONES) {
    if (!previous[zone].some(isOpaqueUid) && !current[zone].some(isOpaqueUid))
      continue;
    const delta =
      direction === "out"
        ? previous[zone].length - current[zone].length
        : current[zone].length - previous[zone].length;
    if (delta > 0) budget.set(zone, delta);
  }
  return budget;
}

function takeFromBudget(
  budget: Map<HiddenZone, number>,
  candidates: readonly HiddenZone[],
): HiddenZone | null {
  const zone = candidates.find((candidate) => (budget.get(candidate) ?? 0) > 0);
  if (!zone) return null;
  budget.set(zone, budget.get(zone)! - 1);
  return zone;
}

/** 裏向きのスタックは中身も位置IDになるため、行き先の側も追跡できない。 */
const FACE_DOWN_TARGET_ZONES = new Set<ActionZone>([
  "stage",
  "attached",
  "yell",
]);

/**
 * 手札を離れたが行き先を突き合わせられないカード。自席の手札は実UIDで届くので、
 * 消えたUIDをそのまま使えば裏向きに置かれても正しい表面から演出できる。
 */
function untrackedHandDepartures(
  previous: ActionSnapshot,
  current: ActionSnapshot,
  player: PlayerId,
  claimed: ReadonlySet<string>,
): string[] {
  if (previous[player].hand.some(isOpaqueUid)) return [];
  const currentHand = new Set(current[player].hand);
  return previous[player].hand.filter(
    (uid) =>
      !currentHand.has(uid) && !claimed.has(uid) && !findLocation(current, uid),
  );
}

/**
 * 非公開と公開をまたいだ移動を、非公開領域の増減枚数から推定する。
 *
 * 公開領域に現れた実UIDには対応する直前のUIDがなく、非公開領域へ戻ったカードには
 * 行き先のUIDがないため、通常の突き合わせでは相手のプレイ・ブルーム・エール付与が
 * まったく演出されない。枚数の裏付けがある分だけを移動として補う。
 */
export function hiddenBoundaryTransitions(
  previous: ActionSnapshot,
  current: ActionSnapshot,
  known: ReadonlySet<string>,
): ActionTransition[] {
  const previousTracked = new Set([
    ...Object.keys(previous[0].locations),
    ...Object.keys(previous[1].locations),
  ]);
  const claimed = new Set(known);
  const transitions: ActionTransition[] = [];

  for (const player of [0, 1] as const) {
    const budget = opaqueZoneBudget(previous[player], current[player], "out");
    const departures = untrackedHandDepartures(
      previous,
      current,
      player,
      claimed,
    );
    if (budget.size === 0 && departures.length === 0) continue;
    for (const [uid, location] of Object.entries(current[player].locations)) {
      if (claimed.has(uid) || previousTracked.has(uid)) continue;
      // ゲーム準備の裏向き配置は、手札もスタックの中身も位置IDになりうる。
      // 自席で分かっている実UIDを優先し、無ければスタック側の位置IDで演出する。
      if (isOpaqueUid(uid)) {
        if (!FACE_DOWN_TARGET_ZONES.has(location.zone)) continue;
        const identity =
          departures.shift() ?? (takeFromBudget(budget, ["hand"]) ? uid : null);
        if (identity === null) continue;
        claimed.add(identity);
        transitions.push({
          player,
          uid: identity,
          // 盤面には裏向きスタックの位置IDで並んでいるので、そちらを伏せる。
          hideUid: uid,
          sourcePlayer: player,
          sourceZone: "hand",
          targetStackId: location.stackId,
          zone: location.zone,
        });
        continue;
      }
      const candidates = REVEAL_SOURCES[location.zone];
      if (!candidates) continue;
      const sourceZone = takeFromBudget(budget, candidates);
      if (!sourceZone) continue;
      claimed.add(uid);
      transitions.push({
        player,
        uid,
        sourcePlayer: player,
        sourceZone,
        targetStackId: location.stackId,
        zone: location.zone,
      });
    }
  }

  for (const player of [0, 1] as const) {
    const budget = opaqueZoneBudget(previous[player], current[player], "in");
    if (budget.size === 0) continue;
    for (const uid of previousTracked) {
      if (isOpaqueUid(uid) || claimed.has(uid)) continue;
      const source = findLocation(previous, uid);
      if (!source || source.player !== player) continue;
      if (findLocation(current, uid)) continue;
      const zone = takeFromBudget(budget, HIDDEN_ZONES);
      if (!zone) continue;
      claimed.add(uid);
      transitions.push({
        player,
        uid,
        sourcePlayer: source.player,
        sourceZone: source.zone,
        sourceStackId: source.stackId,
        zone,
      });
    }
  }

  return transitions;
}

function stackIsFaceDown(
  game: GameState,
  player: PlayerId,
  stackId?: number,
): boolean {
  if (stackId === undefined) return false;
  const state = game.players[player];
  return [state.center, state.collab, ...state.back].some(
    (stack) => stack?.id === stackId && stack.faceDown,
  );
}

function actionKind(
  cardId: string | undefined,
  zone: ActionZone,
  sourceZone?: ActionZone,
): ActionKind {
  if (zone === "yell") return "cheer";
  if (zone === "attached") return "attach";
  if (zone === "hand") return "return";
  if (zone === "deck" || zone === "life" || zone === "cheerDeck")
    return "return";
  if (zone === "holoPower") return "power";
  if (zone === "archive")
    return sourceZone === "hand" &&
      cardId !== undefined &&
      getCard(cardId).cardType === "support"
      ? "use"
      : "archive";
  if (!cardId) return "play";
  const card = getCard(cardId);
  return card.cardType === "holomen" &&
    (card.bloomLevel === "1st" || card.bloomLevel === "2nd")
    ? "bloom"
    : "play";
}

function hexToRgbChannels(hex: string): string | undefined {
  const match = /^#([\da-f]{6})$/i.exec(hex);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

function captureCardRects(): Map<string, StoredRect> {
  const rects = new Map<string, StoredRect>();
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-animation-uid]",
  )) {
    const uid = element.dataset.animationUid;
    if (!uid) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    rects.set(uid, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  return rects;
}

function zoneTargetRect(
  player: PlayerId,
  zone: ActionZone,
  seat: PlayerId,
  stackId?: number,
): StoredRect | null {
  if (zone === "hand") {
    const element =
      player === seat
        ? document.querySelector<HTMLElement>(".hand-cards")
        : document.querySelector<HTMLElement>(`[data-player="${player}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return player === seat
      ? {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }
      : {
          left: rect.left + rect.width / 2 - 39,
          top: Math.max(62, rect.top - 40),
          width: 78,
          height: 109,
        };
  }
  if (
    stackId !== undefined &&
    (zone === "attached" || zone === "stage" || zone === "yell")
  ) {
    const stack = document.querySelector<HTMLElement>(
      `[data-combat-stack-id="${stackId}"]`,
    );
    const element = stack?.querySelector<HTMLElement>(".stack-top") ?? stack;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }
  const selectorZone =
    zone === "attached" || zone === "stage" || zone === "yell" ? null : zone;
  if (!selectorZone) return null;
  const zoneElement = document.querySelector<HTMLElement>(
    `[data-player="${player}"] [data-zone="${selectorZone}"]`,
  );
  const element =
    zoneElement?.querySelector<HTMLElement>(".card, .slot-empty") ??
    zoneElement;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function useCardActionAnimations(game: GameState, seat: PlayerId) {
  const [flights, setFlights] = useState<ActionFlight[]>([]);
  const [hiddenUids, setHiddenUids] = useState<Set<string>>(new Set());
  const [hiddenKinds, setHiddenKinds] = useState<Map<string, ActionKind>>(
    new Map(),
  );
  const [arrivedUids, setArrivedUids] = useState<Set<string>>(new Set());
  const previousSnapshotRef = useRef<ActionSnapshot | null>(null);
  const previousRectsRef = useRef<Map<string, StoredRect>>(new Map());
  // 非公開領域へ入ったカードは現在のuidToCardから消えるため、直前の対応も残す。
  const previousCardsRef = useRef<GameState["uidToCard"]>(game.uidToCard);
  const previousArtworksRef = useRef<GameState["uidToArtwork"]>(
    game.uidToArtwork,
  );
  const previousLogIdRef = useRef(game.log.at(-1)?.id ?? 0);
  const timersRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    const previous = previousSnapshotRef.current;
    const previousRects = previousRectsRef.current;
    const previousCards = previousCardsRef.current;
    const previousArtworks = previousArtworksRef.current;
    previousCardsRef.current = game.uidToCard;
    previousArtworksRef.current = game.uidToArtwork;
    const previousLogId = previousLogIdRef.current;
    const newLogs = game.log.filter((entry) => entry.id > previousLogId);
    const current = actionSnapshot(game);
    if (previous) {
      for (const player of [0, 1] as const) {
        for (const uid of [
          ...current[player].pendingCheer,
          ...current[player].pendingAttach,
        ]) {
          if (current[player].pendingSources[uid]) continue;
          const source =
            findLocation(previous, uid) ??
            previous[0].pendingSources[uid] ??
            previous[1].pendingSources[uid];
          if (source) current[player].pendingSources[uid] = source;
        }
      }
    }
    const currentRects = captureCardRects();
    previousSnapshotRef.current = current;
    previousRectsRef.current = currentRects;
    previousLogIdRef.current = game.log.at(-1)?.id ?? previousLogId;

    if (
      !previous ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;

    const handTransitions = ([0, 1] as const).flatMap<ActionTransition>(
      (player) => {
        const currentHand = new Set(current[player].hand);
        return previous[player].hand.flatMap((uid) => {
          if (currentHand.has(uid)) return [];
          const target = findLocation(current, uid);
          return target
            ? [
                {
                  player: target.player,
                  uid,
                  sourcePlayer: player,
                  sourceZone: "hand" as const,
                  targetStackId: target.stackId,
                  zone: target.zone,
                },
              ]
            : [];
        });
      },
    );
    const pendingCheerTransitions = ([0, 1] as const).flatMap<ActionTransition>(
      (sourcePlayer) =>
        previous[sourcePlayer].pendingCheer.flatMap((uid) => {
          const targetPlayer = ([0, 1] as const).find((player) =>
            current[player].yells.includes(uid),
          );
          const target = findLocation(current, uid);
          const source = previous[sourcePlayer].pendingSources[uid];
          return targetPlayer === undefined
            ? []
            : [
                {
                  player: targetPlayer,
                  uid,
                  sourcePlayer: source?.player ?? sourcePlayer,
                  sourceZone: source?.zone,
                  sourceStackId: source?.stackId,
                  targetStackId: target?.stackId,
                  zone: "yell" as const,
                },
              ];
        }),
    );
    const pendingAttachTransitions = (
      [0, 1] as const
    ).flatMap<ActionTransition>((promptPlayer) =>
      previous[promptPlayer].pendingAttach.flatMap((uid) => {
        const target = findLocation(current, uid);
        if (!target || target.zone !== "attached") return [];
        const source = previous[promptPlayer].pendingSources[uid];
        return [
          {
            player: target.player,
            uid,
            sourcePlayer: source?.player ?? promptPlayer,
            sourceZone: source?.zone,
            sourceStackId: source?.stackId,
            targetStackId: target.stackId,
            zone: "attached" as const,
            kind: "attach" as const,
          },
        ];
      }),
    );
    const batonPlayers = new Set<PlayerId>(
      newLogs.flatMap((entry) =>
        entry.player !== null && entry.text.startsWith("バトンタッチ:")
          ? [entry.player]
          : [],
      ),
    );
    const stageMoveTransitions = ([0, 1] as const).flatMap<ActionTransition>(
      (player) => {
        const movements = previous[player].stageStacks.flatMap((from) => {
          const to = current[player].stageStacks.find(
            (stack) => stack.id === from.id,
          );
          return !to ||
            to.slot === from.slot ||
            (isBackSlot(from.slot) && isBackSlot(to.slot))
            ? []
            : [{ from, to }];
        });
        const hasBatonPair =
          batonPlayers.has(player) &&
          movements.some(
            ({ from, to }) => from.slot === "center" && isBackSlot(to.slot),
          ) &&
          movements.some(
            ({ from, to }) => isBackSlot(from.slot) && to.slot === "center",
          );

        return movements.map(
          ({ from, to }, movementIndex): ActionTransition => {
            const isBatonMovement =
              hasBatonPair &&
              ((from.slot === "center" && isBackSlot(to.slot)) ||
                (isBackSlot(from.slot) && to.slot === "center"));
            const kind: ActionKind = isBatonMovement
              ? "baton"
              : from.slot === "collab" || to.slot === "collab"
                ? "collab"
                : "center";
            return {
              player,
              uid: to.topUid,
              sourceUid: from.topUid,
              sourcePlayer: player,
              sourceZone: "stage",
              sourceStackId: from.id,
              targetStackId: to.id,
              zone: "stage",
              kind,
              curveDirection: kind === "baton" ? 1 : undefined,
              delay: kind === "baton" ? 0 : undefined,
              showLabel: movementIndex === 0,
            };
          },
        );
      },
    );
    const knownTransitionUids = new Set(
      [
        ...handTransitions,
        ...pendingCheerTransitions,
        ...pendingAttachTransitions,
        ...stageMoveTransitions,
      ].map(({ uid }) => uid),
    );
    const powerTransitions = ([0, 1] as const).flatMap<ActionTransition>(
      (player) => {
        const previousPower = new Set(previous[player].holoPower);
        const currentPower = new Set(current[player].holoPower);
        const additions = current[player].holoPower
          .filter(
            (uid) => !previousPower.has(uid) && !knownTransitionUids.has(uid),
          )
          .map(
            (uid, movementIndex): ActionTransition => ({
              player,
              uid,
              sourcePlayer: findLocation(previous, uid)?.player,
              sourceZone: findLocation(previous, uid)?.zone,
              sourceStackId: findLocation(previous, uid)?.stackId,
              zone: "holoPower",
              kind: "power",
              delay: movementIndex * 90,
              showLabel: movementIndex === 0,
            }),
          );
        const removals = previous[player].holoPower
          .filter(
            (uid) => !currentPower.has(uid) && !knownTransitionUids.has(uid),
          )
          .flatMap((uid) => {
            const target = findLocation(current, uid);
            return target ? [{ uid, target }] : [];
          })
          .map(
            ({ uid, target }, movementIndex): ActionTransition => ({
              player: target.player,
              uid,
              sourcePlayer: player,
              sourceZone: "holoPower",
              targetStackId: target.stackId,
              zone: target.zone,
              kind: "power-out",
              delay: movementIndex * 90,
              showLabel: movementIndex === 0,
            }),
          );
        return [...additions, ...removals];
      },
    );
    for (const { uid } of powerTransitions) knownTransitionUids.add(uid);
    const previousYells = new Set([...previous[0].yells, ...previous[1].yells]);
    const directCheerTransitions = ([0, 1] as const).flatMap<ActionTransition>(
      (player) =>
        current[player].yells.flatMap((uid) => {
          if (previousYells.has(uid) || knownTransitionUids.has(uid)) return [];
          const source = findLocation(previous, uid);
          const target = findLocation(current, uid);
          return [
            {
              player,
              uid,
              sourcePlayer: source?.player,
              sourceZone: source?.zone,
              sourceStackId: source?.stackId,
              targetStackId: target?.stackId,
              zone: "yell" as const,
            },
          ];
        }),
    );
    for (const { uid } of directCheerTransitions) knownTransitionUids.add(uid);
    const previousTrackedUids = new Set([
      ...Object.keys(previous[0].locations),
      ...Object.keys(previous[1].locations),
    ]);
    const resolvingDown = newLogs.some((entry) =>
      entry.text.includes("ダウンしました"),
    );
    const boundaryTransitions = hiddenBoundaryTransitions(
      previous,
      current,
      knownTransitionUids,
    );
    for (const { uid } of boundaryTransitions) knownTransitionUids.add(uid);
    const genericMoves = [...previousTrackedUids].flatMap((uid) => {
      if (knownTransitionUids.has(uid)) return [];
      const source = findLocation(previous, uid);
      const target = findLocation(current, uid);
      if (!source || !target) return [];
      if (source.player === target.player && source.key === target.key)
        return [];
      // デッキから手札への移動は専用のドロー演出が担当する。
      if (source.zone === "deck" && target.zone === "hand") return [];
      // ダウンによるアーカイブ移動は戦闘演出側のゴースト表示に任せる。
      if (
        resolvingDown &&
        target.zone === "archive" &&
        (source.zone === "stage" ||
          source.zone === "attached" ||
          source.zone === "yell")
      )
        return [];
      return [{ uid, source, target }];
    });
    const genericDelayBase = stageMoveTransitions.length > 0 ? 420 : 0;
    const genericTransitions = genericMoves.map(
      ({ uid, source, target }, movementIndex): ActionTransition => ({
        player: target.player,
        uid,
        sourcePlayer: source.player,
        sourceZone: source.zone,
        sourceStackId: source.stackId,
        targetStackId: target.stackId,
        zone: target.zone,
        delay: genericDelayBase + movementIndex * 85,
        showLabel: movementIndex === 0,
      }),
    );
    const transitions: ActionTransition[] = [
      ...handTransitions,
      ...pendingCheerTransitions,
      ...pendingAttachTransitions,
      ...powerTransitions,
      ...directCheerTransitions,
      ...boundaryTransitions,
      ...stageMoveTransitions,
      ...genericTransitions,
    ];
    if (transitions.length === 0) return;

    const nextFlights = transitions.flatMap<ActionFlight>(
      (
        {
          player,
          uid,
          hideUid: transitionHideUid,
          sourceUid,
          sourcePlayer,
          sourceZone,
          sourceStackId,
          targetStackId,
          zone,
          kind: transitionKind,
          curveDirection,
          delay: transitionDelay,
          showLabel,
        },
        index,
      ) => {
        const hideUid = transitionHideUid ?? uid;
        const destination =
          currentRects.get(hideUid) ??
          currentRects.get(uid) ??
          zoneTargetRect(player, zone, seat, targetStackId);
        if (!destination) return [];

        // 位置IDの偽配置カードは使わず、実UIDだけ直前の対応へフォールバックする。
        const cardId =
          game.uidToCard[uid] ??
          (isOpaqueUid(uid) ? undefined : previousCards[uid]);
        const artworkKey =
          game.uidToArtwork?.[uid] ??
          (isOpaqueUid(uid) ? undefined : previousArtworks?.[uid]);
        const kind = transitionKind ?? actionKind(cardId, zone, sourceZone);
        const sourceOwner = sourcePlayer ?? player;
        const own = sourceOwner === seat;
        const targetIsFaceDown = stackIsFaceDown(game, player, targetStackId);
        const playerBoard = document.querySelector<HTMLElement>(
          `[data-player="${sourceOwner}"]`,
        );
        const boardRect = playerBoard?.getBoundingClientRect();
        const source = previousRects.get(sourceUid ?? uid) ??
          previousRects.get(uid) ??
          (sourceZone
            ? zoneTargetRect(sourceOwner, sourceZone, seat, sourceStackId)
            : null) ?? {
            left:
              (boardRect?.left ?? 0) +
              (boardRect?.width ?? window.innerWidth) / 2 -
              39,
            top: Math.max(62, (boardRect?.top ?? 120) - (own ? 0 : 72)),
            width: 78,
            height: 109,
          };
        const width = Math.max(58, Math.min(source.width, 78));
        const height = width * (109 / 78);
        const sourceIsSideways =
          sourceZone === "holoPower" ||
          sourceZone === "life" ||
          source.width > source.height;
        const destinationIsSideways =
          zone === "holoPower" ||
          zone === "life" ||
          destination.width > destination.height;
        const startScale = Math.max(
          0.32,
          Math.min(
            1,
            Math.min(
              source.width / (sourceIsSideways ? height : width),
              source.height / (sourceIsSideways ? width : height),
            ),
          ),
        );
        const startX = source.left + source.width / 2 - width / 2;
        const startY = source.top + source.height / 2 - height / 2;
        const rawEndX = destination.left + destination.width / 2 - width / 2;
        const rawEndY = destination.top + destination.height / 2 - height / 2;
        const endX = Math.min(
          Math.max(12, rawEndX),
          window.innerWidth - width - 12,
        );
        const endY = Math.min(
          Math.max(62, rawEndY),
          window.innerHeight - height - 12,
        );
        let controlX = startX + (endX - startX) * 0.5;
        let controlY = Math.max(
          92,
          Math.min(startY, endY) -
            Math.min(96, Math.max(42, Math.abs(endY - startY) * 0.2)),
        );
        if (kind === "baton" && curveDirection) {
          const deltaX = endX - startX;
          const deltaY = endY - startY;
          const distance = Math.max(1, Math.hypot(deltaX, deltaY));
          const curve = 44 * curveDirection;
          controlX = Math.min(
            window.innerWidth - width - 12,
            Math.max(12, startX + deltaX * 0.5 + (-deltaY / distance) * curve),
          );
          controlY = Math.min(
            window.innerHeight - height - 12,
            Math.max(62, startY + deltaY * 0.5 + (deltaX / distance) * curve),
          );
        }
        const endScale = Math.max(
          0.32,
          Math.min(
            1,
            Math.min(
              destination.width / (destinationIsSideways ? height : width),
              destination.height / (destinationIsSideways ? width : height),
            ),
          ),
        );
        const orientationChanges = sourceIsSideways || destinationIsSideways;
        const startRotation = sourceIsSideways ? 90 : -5;
        const endRotation = destinationIsSideways ? 90 : 0;
        const controlRotation = orientationChanges
          ? startRotation + (endRotation - startRotation) * 0.52
          : 4;
        const endOvershootRotation = orientationChanges
          ? endRotation + (endRotation >= startRotation ? 2 : -2)
          : -1;

        const card = cardId ? getCard(cardId) : null;
        const color =
          kind === "cheer" && card?.cardType === "yell"
            ? hexToRgbChannels(yellColorHex(card.color))
            : undefined;
        const sourceWasHidden =
          sourceZone === "deck" ||
          sourceZone === "holoPower" ||
          sourceZone === "life" ||
          sourceZone === "cheerDeck";
        const faceDown =
          kind === "power" ||
          kind === "power-out" ||
          zone === "deck" ||
          zone === "holoPower" ||
          zone === "life" ||
          zone === "cheerDeck" ||
          targetIsFaceDown ||
          (zone === "hand" &&
            player !== seat &&
            (sourceWasHidden || !sourceZone));

        return [
          {
            id: `${game.rev}-${player}-${uid}-${zone}-${index}`,
            uid,
            hideUid,
            cardId,
            artworkKey,
            kind,
            startX,
            startY,
            controlX,
            controlY,
            endX,
            endY,
            width,
            height,
            startScale,
            endScale,
            endOvershootScale: endScale * 1.08,
            startRotation,
            controlRotation,
            endOvershootRotation,
            endRotation,
            delay: transitionDelay ?? index * 110,
            color,
            faceDown,
            flipToBack: faceDown && own && sourceZone === "hand",
            backKind: card?.cardType === "yell" ? "yell" : "holomen",
            showLabel: showLabel ?? true,
          },
        ];
      },
    );
    if (nextFlights.length === 0) return;

    setFlights((currentFlights) => [...currentFlights, ...nextFlights]);
    setHiddenUids((currentHidden) => {
      const next = new Set(currentHidden);
      for (const flight of nextFlights) next.add(flight.hideUid);
      return next;
    });
    setHiddenKinds((currentKinds) => {
      const next = new Map(currentKinds);
      for (const flight of nextFlights) next.set(flight.hideUid, flight.kind);
      return next;
    });

    for (const flight of nextFlights) {
      const finishTimer = window.setTimeout(
        () => {
          timersRef.current = timersRef.current.filter(
            (currentTimer) => currentTimer !== finishTimer,
          );
          setFlights((currentFlights) =>
            currentFlights.filter((item) => item.id !== flight.id),
          );
          setHiddenUids((currentHidden) => {
            const next = new Set(currentHidden);
            next.delete(flight.hideUid);
            return next;
          });
          setHiddenKinds((currentKinds) => {
            const next = new Map(currentKinds);
            next.delete(flight.hideUid);
            return next;
          });
          setArrivedUids((currentArrived) =>
            new Set(currentArrived).add(flight.hideUid),
          );

          const arrivalTimer = window.setTimeout(() => {
            timersRef.current = timersRef.current.filter(
              (currentTimer) => currentTimer !== arrivalTimer,
            );
            setArrivedUids((currentArrived) => {
              const next = new Set(currentArrived);
              next.delete(flight.hideUid);
              return next;
            });
          }, 420);
          timersRef.current.push(arrivalTimer);
        },
        ACTION_FLIGHT_DURATION + flight.delay + 70,
      );
      timersRef.current.push(finishTimer);
    }
  }, [game, seat]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  const captureActionRects = () => {
    previousRectsRef.current = captureCardRects();
  };

  return {
    flights,
    hiddenUids,
    hiddenKinds,
    arrivedUids,
    captureActionRects,
  };
}

export function CardActionAnimationLayer({
  flights,
}: {
  flights: ActionFlight[];
}) {
  if (flights.length === 0) return null;
  return (
    <div className="action-fx-layer" aria-hidden="true">
      {flights.map((flight) => (
        <div
          key={flight.id}
          className={`action-fx-flight is-${flight.kind}${flight.flipToBack ? " is-flipping" : ""}`}
          style={
            {
              "--action-start-x": `${flight.startX}px`,
              "--action-start-y": `${flight.startY}px`,
              "--action-control-x": `${flight.controlX}px`,
              "--action-control-y": `${flight.controlY}px`,
              "--action-end-x": `${flight.endX}px`,
              "--action-end-y": `${flight.endY}px`,
              "--action-card-width": `${flight.width}px`,
              "--action-card-height": `${flight.height}px`,
              "--action-start-scale": flight.startScale,
              "--action-end-scale": flight.endScale,
              "--action-end-overshoot-scale": flight.endOvershootScale,
              "--action-start-rotation": `${flight.flipToBack ? 0 : flight.startRotation}deg`,
              "--action-control-rotation": `${flight.flipToBack ? 0 : flight.controlRotation}deg`,
              "--action-end-overshoot-rotation": `${flight.flipToBack ? 0 : flight.endOvershootRotation}deg`,
              "--action-end-rotation": `${flight.flipToBack ? 0 : flight.endRotation}deg`,
              "--action-delay": `${flight.delay}ms`,
              ...(flight.color
                ? { "--action-color": flight.color }
                : undefined),
            } as CSSProperties
          }
        >
          <span className="action-fx-trail" />
          <span className="action-fx-ring" />
          <div className="action-fx-card-orient">
            <div className="action-fx-card">
              {flight.flipToBack ? (
                <div className="action-fx-card-flip is-to-back">
                  <div className="action-fx-card-face action-fx-card-front">
                    <CardView
                      cardId={flight.cardId}
                      artworkKey={flight.artworkKey}
                      size="md"
                    />
                  </div>
                  <div className="action-fx-card-face action-fx-card-back">
                    <CardView
                      cardId={flight.cardId}
                      artworkKey={flight.artworkKey}
                      faceDown
                      backKind={flight.backKind}
                      size="md"
                    />
                  </div>
                </div>
              ) : (
                <CardView
                  cardId={flight.cardId}
                  artworkKey={flight.artworkKey}
                  faceDown={flight.faceDown}
                  backKind={flight.backKind}
                  size="md"
                />
              )}
            </div>
          </div>
          {flight.showLabel && (
            <span className="action-fx-label">
              {ACTION_LABELS[flight.kind]}
            </span>
          )}
          <span className="action-fx-particles">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
      ))}
    </div>
  );
}
