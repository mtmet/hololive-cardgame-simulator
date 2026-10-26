// ============================================================
// 視点別のゲーム表示状態 (非公開情報のマスク)
// 完全なGameStateから、指定視点が知ってよい情報だけを残した
// 独立コピーを作る。オンライン配信 (server/onlineView.ts) と
// CPU対戦のAI観測 (game/ai/) が共用する。
// ============================================================
import type { GameState, PlayerId, Prompt } from "./types";

/** 視点。席 (0/1)・観戦・未確定 (null) 。観戦とnullは両者の非公開を隠す */
export type GameViewer = PlayerId | "spectator" | null;

type HiddenPool = "main" | "cheer";

interface HiddenSlot {
  actualUid: string;
  opaqueUid: string;
  pool: HiddenPool;
}

/**
 * 非公開カードには実UIDの代わりに「領域の位置」を表す不透明IDを使う。
 * 山札がshiftされてもカード自身を追跡できず、一方で同じ枚数の状態更新だけでは
 * UIが全カードの移動と誤認しない。
 */
function hiddenSlotsFor(state: GameState, player: PlayerId): HiddenSlot[] {
  const p = state.players[player];
  const slots: HiddenSlot[] = [];
  const add = (uids: readonly string[], zone: string, pool: HiddenPool) => {
    uids.forEach((actualUid, index) =>
      slots.push({
        actualUid,
        opaqueUid: `hidden:p${player}:${zone}:${index}`,
        pool,
      }),
    );
  };

  add(p.deck, "deck", "main");
  add(p.holoPower, "holoPower", "main");
  add(p.hand, "hand", "main");
  add(p.cheerDeck, "cheerDeck", "cheer");
  add(p.life, "life", "cheer");
  for (const stack of [p.center, p.collab, ...p.back]) {
    if (!stack?.faceDown) continue;
    add(stack.cards, `stack-${stack.id}-cards`, "main");
    add(stack.supports, `stack-${stack.id}-supports`, "main");
    add(stack.yells, `stack-${stack.id}-yells`, "cheer");
  }
  return slots;
}

/** 自分の入力に必要な、非公開領域から一時的に見ているカード。 */
function promptVisibleUids(
  prompt: Prompt | undefined,
  viewer: GameViewer,
): string[] {
  if (prompt?.type === "effectPickCard" && prompt.revealAll) return prompt.uids;
  if (viewer === null || viewer === "spectator" || prompt?.player !== viewer)
    return [];
  switch (prompt.type) {
    case "effectPickCard":
      return prompt.uids;
    case "cheerAssign":
      return [prompt.yellUid];
    case "effectAttach":
      return [prompt.uid];
    default:
      return [];
  }
}

/**
 * 非公開の選択内容を知る必要がない視点へ送る、入力待ちだけを表すプレースホルダー。
 *
 * Prompt に専用の view-only variant を混ぜると、実ゲーム状態の全解決器が到達不能な
 * 分岐を扱う必要が出るため、追加情報を持たない既存の形を利用する。これは
 * gameViewFor が返す観測用コピーにしか置かれず、権威状態へは保存されない。
 */
function privatePromptPlaceholder(player: PlayerId): Prompt {
  return { type: "mulliganChoice", player };
}

/** 候補全体が公開されており、非選択者にもプロンプトを見せてよいか。 */
function promptIsPublic(prompt: Prompt): boolean {
  if (prompt.type === "liveStart" || prompt.type === "setupReveal") return true;
  return prompt.type === "effectPickCard" && prompt.revealAll === true;
}

/** 過去の公開スナップショットがあっても、現在の非公開領域は公開しない。 */
function isInHiddenZone(state: GameState, uid: string): boolean {
  return ([0, 1] as const).some((player) =>
    hiddenSlotsFor(state, player).some((slot) => slot.actualUid === uid),
  );
}

/** 誰から見ても公開されているカード。視点によらない。 */
function publicUids(state: GameState): Set<string> {
  const visible = new Set<string>();
  for (const player of [0, 1] as const) {
    const p = state.players[player];
    visible.add(p.oshiUid);
    for (const uid of p.archive) visible.add(uid);
    for (const uid of p.resolvingSupports ?? []) visible.add(uid);
    for (const stack of [p.center, p.collab, ...p.back]) {
      if (!stack || stack.faceDown) continue;
      for (const uid of [...stack.cards, ...stack.supports, ...stack.yells])
        visible.add(uid);
    }
  }
  // ダウン処理中のスタックは直前まで表向きだった公開情報。
  const current = state.ruleResolution?.current;
  if (current)
    for (const uid of [...current.cards, ...current.supports, ...current.yells])
      if (!isInHiddenZone(state, uid)) visible.add(uid);
  return visible;
}

/**
 * 演出ログに実UIDを残してよいか (記録時点で公開されていたか) の判定。
 * 1件ずつの問い合わせなので集合は作らずに走査する。
 */
export function isPublicUid(state: GameState, uid: string): boolean {
  for (const player of [0, 1] as const) {
    const p = state.players[player];
    if (
      p.oshiUid === uid ||
      p.archive.includes(uid) ||
      p.resolvingSupports?.includes(uid)
    )
      return true;
    for (const stack of [p.center, p.collab, ...p.back]) {
      if (!stack || stack.faceDown) continue;
      if (
        stack.cards.includes(uid) ||
        stack.supports.includes(uid) ||
        stack.yells.includes(uid)
      )
        return true;
    }
  }
  const current = state.ruleResolution?.current;
  return (
    current !== undefined &&
    !isInHiddenZone(state, uid) &&
    (current.cards.includes(uid) ||
      current.supports.includes(uid) ||
      current.yells.includes(uid))
  );
}

/** 現在の視点で、実UIDとカードIDの対応を公開してよいカード。 */
function visibleUidsFor(state: GameState, viewer: GameViewer): Set<string> {
  const visible = publicUids(state);
  if (viewer === 0 || viewer === 1)
    for (const uid of state.players[viewer].hand) visible.add(uid);
  for (const uid of promptVisibleUids(state.prompts[0], viewer))
    visible.add(uid);
  return visible;
}

/** 内部カウンタキーの「prefix:uid:suffix」を同じ置換表で隠す。 */
function remapCompositeKey(
  value: string,
  remap: ReadonlyMap<string, string>,
): string {
  if (!value.includes(":")) return value;
  let changed = false;
  const parts = value.split(":").map((part) => {
    const mapped = remap.get(part);
    if (!mapped) return part;
    changed = true;
    return mapped;
  });
  return changed ? parts.join(":") : value;
}

/** GameState内で値がカードUIDまたはカードUID列であるフィールド名。 */
const UID_FIELDS = new Set([
  "oshiUid",
  "handUid",
  "uid",
  "uids",
  "yellUid",
  "supportUid",
  "archiveUid",
  "sourceUid",
  "sourceCardUid",
  "sourceSupportUid",
  "onlyUid",
  "cards",
  "yells",
  "supports",
  "deck",
  "cheerDeck",
  "hand",
  "archive",
  "resolvingSupports",
  "holoPower",
  "life",
  "eligible",
  "revealed",
  "milled",
  "pickedCards",
  "downedCards",
  "downedYells",
  "downedSupports",
  "downedUidsThisTurn",
  "downedUidsPrevTurn",
  "bloomedCardUidsThisTurn",
  "subSkipUids",
]);

/**
 * uidToCard以外に残るプロンプト・履歴・効果コンテキストの実UIDも置換する。
 * 任意文字列は触らず、名前が偶然 "u1" 等でも変更しない。
 */
function remapDeep(
  value: unknown,
  remap: ReadonlyMap<string, string>,
  field?: string,
  keyRemap: ReadonlyMap<string, string> = remap,
  contextHistory?: (
    uids: string[],
    context: Record<string, unknown>,
    field: string,
  ) => string[],
): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (typeof item === "string" && field && UID_FIELDS.has(field))
        value[index] = remap.get(item) ?? item;
      else remapDeep(item, remap, field, keyRemap, contextHistory);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    const mappedKey =
      field === "usedTriggersThisTurn" ? remapCompositeKey(key, keyRemap) : key;
    const mappedItem =
      ([
        "pickedCards",
        "milled",
        "downedCards",
        "downedYells",
        "downedSupports",
      ].includes(key) ||
        (key === "revealed" && record.revealedHistory !== false)) &&
      Array.isArray(item) &&
      contextHistory
        ? contextHistory(item, record, key)
        : typeof item === "string" && UID_FIELDS.has(key)
          ? (remap.get(item) ?? item)
          : key === "key" && typeof item === "string"
            ? remapCompositeKey(item, keyRemap)
            : item;
    if (mappedKey !== key) delete record[key];
    record[mappedKey] = mappedItem;
    if (typeof mappedItem !== "string")
      remapDeep(mappedItem, remap, key, keyRemap, contextHistory);
  }
}

/**
 * 視点が知ってよい範囲だけを含む、送信・観測用の独立した状態を返す。
 *
 * 本人の山札等は、デッキ構成から既知であるカード多重集合だけを保持し、実際の
 * 順序・deck/holoPower間およびlife/cheerDeck間の所在とは無関係な偽配置にする。
 * これは探索AIが完全状態を再構成する材料にもなる。相手・観戦者には多重集合も
 * 渡さず、カードIDを持たない不透明IDだけを渡す。
 */
export function gameViewFor(state: GameState, viewer: GameViewer): GameState {
  const view = structuredClone(state);
  const visible = visibleUidsFor(state, viewer);
  const remap = new Map<string, string>();
  const slotsByPlayer: [HiddenSlot[], HiddenSlot[]] = [
    hiddenSlotsFor(state, 0),
    hiddenSlotsFor(state, 1),
  ];

  for (const player of [0, 1] as const)
    for (const slot of slotsByPlayer[player])
      if (!visible.has(slot.actualUid))
        remap.set(slot.actualUid, slot.opaqueUid);

  // 現在どの公開領域にもない内部参照も、後に公開された時に追跡できないよう隠す。
  let internalIndex = 0;
  for (const uid of Object.keys(state.uidToCard))
    if (!visible.has(uid) && !remap.has(uid))
      remap.set(uid, `hidden:internal:${internalIndex++}`);

  // uidToCardはキーを書き換えるのではなく、公開可能な対応だけから再構築する。
  view.uidToCard = {};
  view.uidToArtwork = {};
  // 使用済みキーも過去の公開カードを参照する。位置順ではなくUID順で
  // 履歴専用IDを割り当て、文脈内のkeyとカウンターの対応だけを維持する。
  const keyRemap = new Map(
    [...remap.keys()].sort().map((uid, index) => [uid, `history-key-${index}`]),
  );
  // 移動済みの選択結果とダウン前情報は、現在の手札位置を表すIDにしない。
  // 公開しない選択では内容も選択者だけへ渡す。履歴IDは実体の所在と無関係。
  let historyIndex = 0;
  const historyReferences = (
    uids: string[],
    context: Record<string, unknown>,
    field: string,
  ) =>
    uids.map((uid) => {
      if (visible.has(uid)) return uid;
      const reference = `history-${field === "pickedCards" ? "picked" : field}-${historyIndex++}`;
      if (
        field === "revealed"
          ? context.revealedOwnerOnly === false ||
            context.revealedOwner === viewer
          : field !== "pickedCards" ||
            context.pickedCardsOwnerOnly === false ||
            context.pickedCardsOwner === viewer
      ) {
        const cardId = state.uidToCard[uid];
        if (cardId !== undefined) view.uidToCard[reference] = cardId;
        const artwork = state.uidToArtwork?.[uid];
        if (artwork !== undefined) view.uidToArtwork![reference] = artwork;
      }
      return reference;
    });
  // ダウン処理の直前情報は、先行能力で手札へ戻ったカードの現在位置と切り離す。
  const current = view.ruleResolution?.current;
  if (current)
    for (const field of ["cards", "yells", "supports"] as const)
      current[field] = historyReferences(current[field], {}, `downed-${field}`);
  remapDeep(view, remap, undefined, keyRemap, historyReferences);
  for (const uid of visible) {
    const cardId = state.uidToCard[uid];
    if (cardId !== undefined) view.uidToCard[uid] = cardId;
    const artworkKey = state.uidToArtwork?.[uid];
    if (artworkKey !== undefined) view.uidToArtwork[uid] = artworkKey;
  }

  // 自分は元のデッキ構成を知っているため、非公開プールの多重集合だけは既知。
  // 実UID/実配置と無関係になるようカードIDをソートして不透明位置へ偽配置する。
  if (viewer === 0 || viewer === 1) {
    for (const pool of ["main", "cheer"] as const) {
      const slots = slotsByPlayer[viewer].filter(
        (slot) => slot.pool === pool && remap.has(slot.actualUid),
      );
      const cards = slots
        .map((slot) => ({
          cardId: state.uidToCard[slot.actualUid],
          artworkKey: state.uidToArtwork?.[slot.actualUid],
        }))
        .filter(
          (
            entry,
          ): entry is { cardId: string; artworkKey: string | undefined } =>
            entry.cardId !== undefined,
        )
        .sort(
          (a, b) =>
            a.cardId.localeCompare(b.cardId, "en") ||
            (a.artworkKey ?? "").localeCompare(b.artworkKey ?? "", "en"),
        );
      slots.forEach((slot, index) => {
        const opaqueUid = remap.get(slot.actualUid)!;
        const card = cards[index];
        if (card !== undefined) {
          view.uidToCard[opaqueUid] = card.cardId;
          if (card.artworkKey !== undefined)
            view.uidToArtwork![opaqueUid] = card.artworkKey;
        }
      });
    }
  }

  // 公開済みのBloom/ダウン履歴は、現在の非公開位置とは別の参照にする。
  // 枚数とカード情報は条件判定に必要だが、デッキ内の位置は履歴に含まれない。
  for (const field of [
    "bloomedCardUidsThisTurn",
    "downedUidsThisTurn",
    "downedUidsPrevTurn",
  ] as const)
    for (const player of [0, 1] as const)
      view[field][player] = state[field][player].map((uid, index) => {
        if (visible.has(uid)) return uid;
        const reference = `history-${field}-p${player}-${index}`;
        const cardId = state.uidToCard[uid];
        if (cardId !== undefined) view.uidToCard[reference] = cardId;
        const artwork = state.uidToArtwork?.[uid];
        if (artwork !== undefined) view.uidToArtwork![reference] = artwork;
        return reference;
      });

  // 履歴の実UIDは、カードが非公開領域へ移ると位置IDとして現在地を示してしまう。
  // 公開中のカードはそのまま追跡させて演出の起点に使い、非公開のものだけ
  // 領域と相関しないログ固有IDへ差し替える (sourceStackId/sourceCardIdは残る)。
  view.log.forEach((entry, index) => {
    const original = state.log[index];
    if (entry.privateTo !== undefined && entry.privateTo !== viewer)
      entry.text = entry.publicText ?? "非公開情報を確認しました";
    delete entry.privateTo;
    delete entry.publicText;
    const actualAnimation = original?.animation;
    const actualSourceUid = actualAnimation?.sourceUid;
    if (
      entry.animation?.sourceUid !== undefined &&
      !(
        actualAnimation?.sourcePublic === true &&
        actualSourceUid !== undefined &&
        visible.has(actualSourceUid)
      )
    )
      entry.animation.sourceUid = `hidden-log-source-${entry.id}`;

    const actualDraw = original?.draw;
    if (!entry.draw || !actualDraw) return;
    if (entry.player !== viewer) {
      // 相手のドローは、後で公開領域に出たカードとも現在の非公開位置とも
      // 相関させない。カードIDを持たないため裏面で演出される。
      entry.draw.uids = actualDraw.uids.map(
        (_, cardIndex) => `hidden-${entry.draw!.kind}-${entry.id}-${cardIndex}`,
      );
      return;
    }
    // 自分が引いた履歴は本人が実際に見た情報。山札へ戻した引き直しも、位置とは
    // 相関しないログ固有IDへ移し替えたうえで本当のカードIDを渡す。
    entry.draw.uids = actualDraw.uids.map((actualUid, cardIndex) => {
      if (visible.has(actualUid)) return actualUid;
      const logUid = `revealed-draw-${entry.id}-${cardIndex}`;
      const cardId = state.uidToCard[actualUid];
      if (cardId !== undefined) view.uidToCard[logUid] = cardId;
      const artworkKey = state.uidToArtwork?.[actualUid];
      if (artworkKey !== undefined) view.uidToArtwork![logUid] = artworkKey;
      return logUid;
    });
  });

  // UIDだけを不透明化しても、候補配列の長さ・pickMax・eligible.length 等から
  // 山札や手札の条件一致枚数が分かる。選択者以外には「誰かの入力待ち」という
  // 公開情報だけを残し、プロンプト内部の構造そのものを送らない。
  const actualPrompt = state.prompts[0];
  if (actualPrompt) {
    // クライアントが解決できるのは先頭だけ。後続プロンプトを同時に送ると、
    // 現在の選択者にも次のプレイヤーの非公開候補数が見えてしまう。
    view.prompts =
      actualPrompt.player === viewer || promptIsPublic(actualPrompt)
        ? [view.prompts[0]]
        : [privatePromptPlaceholder(actualPrompt.player)];
  }

  const prompt = view.prompts[0];
  if (
    prompt?.type === "jankenHand" &&
    prompt.initiatorHand !== undefined &&
    viewer !== prompt.initiator
  )
    delete prompt.initiatorHand;
  return view;
}
