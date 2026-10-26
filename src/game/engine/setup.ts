// ゲーム状態とルールの処理：setup。
import { getCard } from "../../data/loader";
import type { OshiCard } from "../../data/types";
import type {
  DeckList,
  PlayerId,
  GameState,
  PlayerState,
  Prompt,
} from "../types";
import { animationWaitsEnabled } from "./animation";
import { cardLogLabel, log, logMulliganRedraw, logTurnStart } from "./logging";
import { setWinner, advance } from "./resolution";
import { newUid, shuffle, pushPrompt } from "./runtime";
import { other, cardOf, newStack, stageCount, allStacks } from "./state";

// ------------------------------------------------------------
// ゲーム作成 (準備手順 6.2)
// ------------------------------------------------------------

export function createGame(
  decks: [DeckList, DeckList],
  names: [string, string],
  firstPlayer: PlayerId,
): GameState {
  const uidToCard: Record<string, string> = {};
  const uidToArtwork: Record<string, string> = {};
  const mkUids = (
    counts: Record<string, number>,
    artworks?: Record<string, Record<string, number>>,
  ): string[] => {
    const uids: string[] = [];
    for (const [cardId, n] of Object.entries(counts)) {
      getCard(cardId);
      const selectedArtworks = Object.entries(artworks?.[cardId] ?? {}).flatMap(
        ([artworkKey, count]) => Array<string>(count).fill(artworkKey),
      );
      for (let i = 0; i < n; i++) {
        const uid = newUid();
        uidToCard[uid] = cardId;
        const artworkKey = selectedArtworks[i];
        if (artworkKey) uidToArtwork[uid] = artworkKey;
        uids.push(uid);
      }
    }
    return uids;
  };

  const mkPlayer = (deck: DeckList, name: string): PlayerState => {
    const oshiUid = newUid();
    uidToCard[oshiUid] = deck.oshiId;
    if (deck.artworks?.oshi) uidToArtwork[oshiUid] = deck.artworks.oshi;
    return {
      name,
      oshiUid,
      deck: shuffle(mkUids(deck.main, deck.artworks?.main)),
      cheerDeck: shuffle(mkUids(deck.cheer, deck.artworks?.cheer)),
      hand: [],
      archive: [],
      holoPower: [],
      life: [],
      center: null,
      collab: null,
      back: [],
      usedOshiSkillThisTurn: false,
      usedSpOshiSkill: false,
      usedLimitedThisTurn: false,
      usedBatonTouchThisTurn: false,
      usedCollabThisTurn: false,
      usedCenterArtThisTurn: false,
      usedCollabArtThisTurn: false,
      mulliganCount: 0,
      voluntaryMulliganDone: false,
    };
  };

  const s: GameState = {
    rev: 1,
    phase: "setup",
    turn: 0,
    turnPlayer: firstPlayer,
    firstPlayer,
    turnsStarted: firstPlayer === 0 ? [1, 0] : [0, 1],
    step: "reset",
    players: [mkPlayer(decks[0], names[0]), mkPlayer(decks[1], names[1])],
    uidToCard,
    uidToArtwork,
    prompts: [],
    turnModifiers: [],
    nextStackId: 1,
    downsThisTurn: [0, 0],
    downsPrevTurn: [0, 0],
    usedTriggersThisTurn: {},
    usedEffectsOncePerGame: [[], []],
    usedSupportNamesThisTurn: [[], []],
    usedSupportTypesThisTurn: [[], []],
    usedSupportTagTypesThisTurn: [[], []],
    deckArchivedThisTurn: [0, 0],
    diceRollsThisTurn: [{}, {}],
    stageToDeckThisTurn: [false, false],
    stageYellArchivedThisTurn: [false, false],
    downedUidsThisTurn: [[], []],
    downedUidsPrevTurn: [[], []],
    diceMods: [],
    noRestResetStackIds: [[], []],
    skipResetActivate: [],
    artUsesThisTurn: [[], []],
    bloomedCardUidsThisTurn: [[], []],
    extraTurns: [],
    log: [],
    winner: null,
    winReason: null,
  };

  for (const p of s.players) p.hand = p.deck.splice(0, 7);
  log(
    s,
    null,
    `先攻: ${names[firstPlayer]} / 後攻: ${names[other(firstPlayer)]}`,
  );
  log(s, null, "ゲーム準備: 両プレイヤーが7枚ドローしました");

  pushPrompt(s, { type: "mulliganChoice", player: firstPlayer });
  pushPrompt(s, { type: "mulliganChoice", player: other(firstPlayer) });
  return s;
}

function handHasDebut(s: GameState, p: PlayerState): boolean {
  return p.hand.some((uid) => {
    const c = cardOf(s, uid);
    return c.cardType === "holomen" && c.bloomLevel === "Debut";
  });
}

/** Q120: 初期手札にDebutがない場合、最初の非公開引き直しは必須。 */
export function mulliganRequired(s: GameState, pid: PlayerId): boolean {
  return !handHasDebut(s, s.players[pid]);
}

function redrawHand(s: GameState, pid: PlayerId): string[] {
  const p = s.players[pid];
  p.deck = shuffle([...p.deck, ...p.hand]);
  p.hand = p.deck.splice(0, 7);
  return [...p.hand];
}

function forcedMulligan(s: GameState, pid: PlayerId) {
  const p = s.players[pid];
  while (!handHasDebut(s, p)) {
    // 公開するのは戻す前の手札。実UIDは残さず、引き直し後の所在と結び付けない。
    log(
      s,
      pid,
      `手札を公開しました: ${p.hand
        .map((uid) => cardLogLabel(s, uid))
        .join("、")}`,
    );
    if (p.mulliganCount >= 6) {
      setWinner(s, other(pid), `${p.name}の引き直し回数が上限に達しました`);
      return;
    }
    const redrawnHand = redrawHand(s, pid);
    logMulliganRedraw(
      s,
      pid,
      `手札にDebutホロメンがないため公開して引き直します (${p.mulliganCount + 1}回目)`,
      redrawnHand,
    );
    p.mulliganCount++;
  }
}

export function resolveMulligan(
  s: GameState,
  pid: PlayerId,
  redraw: boolean,
): void {
  consumePrompt(s, "mulliganChoice", pid);
  const p = s.players[pid];
  const required = mulliganRequired(s, pid);
  // 過去の保存・操作から辞退が届いた場合も、必須の引き直しを省略しない。
  if (redraw || required) {
    const redrawnHand = redrawHand(s, pid);
    logMulliganRedraw(
      s,
      pid,
      required
        ? "手札にDebutホロメンがないため非公開で引き直しました (最初の引き直し・ペナルティなし)"
        : "手札を引き直しました (任意の引き直し)",
      redrawnHand,
    );
    p.voluntaryMulliganDone = true;
  }
  forcedMulligan(s, pid);
  if (s.phase === "finished") return;

  if (!s.prompts.some((pr) => pr.type === "mulliganChoice")) {
    const f = s.firstPlayer;
    pushPrompt(s, { type: "placeCenter", player: f });
  }
}

export function resolvePlaceCenter(
  s: GameState,
  pid: PlayerId,
  handUid: string,
): void {
  const p = s.players[pid];
  if (!p.hand.includes(handUid)) throw new Error("手札にないカードです");
  const c = cardOf(s, handUid);
  if (c.cardType !== "holomen" || c.bloomLevel !== "Debut")
    throw new Error("センターにはDebutホロメンを置く必要があります");
  consumePrompt(s, "placeCenter", pid);
  p.hand = p.hand.filter((u) => u !== handUid);
  const st = newStack(s, handUid, 0);
  st.faceDown = true;
  p.center = st;
  log(s, pid, "センターポジションにホロメンを裏向きで置きました");
  queueNextSetupPrompt(s, pid, "center");
}

export function resolveMulliganPenalty(
  s: GameState,
  pid: PlayerId,
  uids: string[],
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "mulliganPenalty" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  if (uids.length !== prompt.count)
    throw new Error(`手札から${prompt.count}枚選ぶ必要があります`);
  if (new Set(uids).size !== uids.length)
    throw new Error("同じカードを複数回選ぶことはできません");
  const p = s.players[pid];
  if (!uids.every((u) => p.hand.includes(u)))
    throw new Error("手札にないカードが含まれています");
  s.prompts.shift();
  p.hand = p.hand.filter((u) => !uids.includes(u));
  p.deck.push(...uids);
  log(
    s,
    pid,
    `引き直しペナルティとして${uids.length}枚をデッキの下に送りました`,
  );
  queueNextSetupPrompt(s, pid, "penalty");
}

/** バックにDebut/Spotホロメンを1枚裏向きで置く (プロンプトは維持し続けて何枚でも置ける) */
export function resolvePlaceBackOne(
  s: GameState,
  pid: PlayerId,
  handUid: string,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "placeBack" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  const p = s.players[pid];
  if (stageCount(p) >= 6)
    throw new Error("ステージに置けるホロメンは合計6人までです");
  if (p.back.length >= 5) throw new Error("バックポジションは5枠までです");
  const c = cardOf(s, handUid);
  if (
    c.cardType !== "holomen" ||
    (c.bloomLevel !== "Debut" && c.bloomLevel !== "Spot")
  )
    throw new Error("バックに置けるのはDebutかSpotのホロメンだけです");
  if (!p.hand.includes(handUid)) throw new Error("手札にないカードです");
  p.hand = p.hand.filter((u) => u !== handUid);
  const st = newStack(s, handUid, 0);
  st.faceDown = true;
  p.back.push(st);
  log(s, pid, "バックポジションにホロメンを裏向きで置きました");
}

/** バック配置を完了する */
export function resolvePlaceBackDone(s: GameState, pid: PlayerId): void {
  consumePrompt(s, "placeBack", pid);
  queueNextSetupPrompt(s, pid, "back");
}

function consumePrompt(s: GameState, type: Prompt["type"], pid: PlayerId) {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== type || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  s.prompts.shift();
}

function queueNextSetupPrompt(
  s: GameState,
  pid: PlayerId,
  completed: "center" | "penalty" | "back",
) {
  if (s.phase !== "setup") return;
  if (completed === "center") {
    const count = s.players[pid].mulliganCount;
    pushPrompt(
      s,
      count > 0
        ? { type: "mulliganPenalty", player: pid, count }
        : { type: "placeBack", player: pid },
    );
    return;
  }
  if (completed === "penalty") {
    pushPrompt(s, { type: "placeBack", player: pid });
    return;
  }
  if (pid === s.firstPlayer)
    pushPrompt(s, { type: "placeCenter", player: other(pid) });
  else afterSetupPrompt(s, pid);
}

const LIVE_START_DELAY_MS = 2050;

const SETUP_REVEAL_DELAY_MS = 800;

function afterSetupPrompt(s: GameState, controller: PlayerId) {
  if (s.phase !== "setup" || s.prompts.length > 0) return;
  for (const p of s.players) {
    const oshi = cardOf(s, p.oshiUid) as OshiCard;
    // 上から1枚ずつ置くため、最後に置いたカードがライフの一番上になる。
    p.life = p.cheerDeck.splice(0, oshi.life).reverse();
  }
  log(s, null, "両プレイヤーの配置が完了しました。LIVE START!");
  // 演出待ちが無効 (ヘッドレス) なら開始演出プロンプトを挟まず即開始する
  if (!animationWaitsEnabled) {
    beginSetupReveal(s);
    return;
  }
  pushPrompt(s, {
    type: "liveStart",
    player: controller,
    duration: LIVE_START_DELAY_MS,
  });
}

/** LIVE START演出の完了後、全ホロメンの公開演出を始める */
export function resolveLiveStart(s: GameState, pid: PlayerId): void {
  consumePrompt(s, "liveStart", pid);
  beginSetupReveal(s, pid);
}

function beginSetupReveal(s: GameState, pid?: PlayerId) {
  for (const p of s.players) {
    for (const { stack } of allStacks(p)) stack.faceDown = false;
  }
  if (!animationWaitsEnabled || pid === undefined) {
    startFirstTurn(s);
    return;
  }
  pushPrompt(s, {
    type: "setupReveal",
    player: pid,
    duration: SETUP_REVEAL_DELAY_MS,
  });
}

/** 全ホロメンの公開演出後、第1ターンを始める */
export function resolveSetupReveal(s: GameState, pid: PlayerId): void {
  consumePrompt(s, "setupReveal", pid);
  startFirstTurn(s);
}

function startFirstTurn(s: GameState) {
  s.phase = "playing";
  s.turn = 1;
  s.turnPlayer = s.firstPlayer;
  s.step = "reset";
  logTurnStart(s);
  advance(s);
}
