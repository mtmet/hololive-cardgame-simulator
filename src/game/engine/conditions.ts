// ゲーム状態とルールの処理：conditions。
import { cardNames } from "../../data/loader";
import type {
  SupportCard,
  HolomenCard,
  OshiCard,
  Color,
  YellCard,
} from "../../data/types";
import { parsePassive, parseGift } from "../effects";
import type {
  PassiveBonus,
  GiftDef,
  TriggerDef,
  Op,
  TargetFilter,
  CardFilter,
  StackTarget,
} from "../effects";
import type {
  GameState,
  PlayerId,
  StagePosition,
  HolomenStack,
  TurnEffectDuration,
  EffectContextData,
} from "../types";
import { engineObserver } from "./runtime";
import { allStacks, topCard, cardOf, findStackById, other } from "./state";
import type { AvailableArtRef } from "./types";

// ------------------------------------------------------------
// 付与サポートの常時効果 (キャッシュ)
// ------------------------------------------------------------

const passiveCache = new Map<string, PassiveBonus>();

export function passiveOf(card: SupportCard): PassiveBonus {
  let b = passiveCache.get(card.id);
  if (!b) {
    b = parsePassive(card);
    passiveCache.set(card.id, b);
  }
  return b;
}

const giftCache = new Map<string, GiftDef>();

export function giftOf(card: HolomenCard): GiftDef {
  let g = giftCache.get(card.id);
  if (!g) {
    g = parseGift(card.gift?.description);
    giftCache.set(card.id, g);
  }
  return g;
}

/** 盤面のギフト/付与サポートによる推しスキルのコスト・使用回数修正 */
export function oshiSkillAdjustments(
  s: GameState,
  pid: PlayerId,
  skillName: string,
): { costDelta: number; usesBonus: number } {
  let costDelta = 0;
  let usesBonus = 0;
  for (const { pos, stack } of allStacks(s.players[pid])) {
    const g = giftOf(topCard(s, stack));
    if (
      g.oshiSkillCostMod !== undefined &&
      g.oshiSkillCostMod.skillName === skillName &&
      giftPositionOk(pos, g.oshiSkillCostMod.positions)
    )
      costDelta += g.oshiSkillCostMod.delta;
    for (const uid of stack.supports) {
      const c = cardOf(s, uid);
      if (c.cardType !== "support") continue;
      const b = passiveOf(c);
      const mod = b.oshiSkillUsesBonus;
      if (!mod || mod.skillName !== skillName) continue;
      if (!giftPositionOk(pos, mod.positions)) continue;
      if (mod.requiresCond && !passiveCondMatches(s, stack, b.cond)) continue;
      usesBonus += mod.value;
    }
  }
  return { costDelta, usesBonus };
}

export function oshiSkillUseCount(s: GameState, pid: PlayerId): number {
  return s.usedTriggersThisTurn[`oshiSkillUse:${pid}`] ?? 0;
}

/** ギフト保持者のポジション制限チェック */
export function giftPositionOk(
  pos: StagePosition,
  positions?: ("center" | "collab")[],
): boolean {
  if (!positions) return true;
  return (
    typeof pos === "string" && positions.includes(pos as "center" | "collab")
  );
}

/** 能力追加の誘発は付与先ごと、サポート自身の誘発はサポート個体ごとに数える。 */
export function attachedTriggerUseKey(
  stackId: number,
  supportUid: string,
  index: number,
  granted: boolean | undefined,
): string {
  return granted
    ? `giftTriggered:support:${supportUid}:${index}:holder:${stackId}`
    : supportUid;
}

/**
 * トリガー1件が発火するかの共通判定。
 * [相手のターンで、]・ポジション限定・[ターンにX回] の3つはイベント種別に依らず
 * 共通なので、発火経路 (板面トリガーだけで10箇所ある) はすべてここを通す。
 * イベント固有の条件 (subjectFilter 等) は呼び出し側で先に判定すること。
 *
 * 発火が確定した時だけ [ターンにX回] の回数を1つ消費し、観測フックへ通知する。
 * 任意誘発は使用確認を承諾した時にだけ回数を消費するため、ここでは上限確認だけ行う。
 * 通知をここへ集約しているので、新しい発火経路を足しても実行カバレッジに乗る。
 */
export function triggerFires(
  s: GameState,
  pid: PlayerId,
  pos: StagePosition,
  def: TriggerDef,
  timesPerTurnKey: string,
  consume = true,
): boolean {
  if (def.oppTurnOnly && s.turnPlayer === pid) return false;
  if (def.selfTurnOnly && s.turnPlayer !== pid) return false;
  if (!giftPositionOk(pos, def.positions)) return false;
  if (def.timesPerTurn !== undefined) {
    const used = s.usedTriggersThisTurn[timesPerTurnKey] ?? 0;
    if (used >= def.timesPerTurn) return false;
    if (consume && !def.optional)
      s.usedTriggersThisTurn[timesPerTurnKey] = used + 1;
  }
  engineObserver?.trigger?.(def.event);
  return true;
}

/** 任意誘発を既存の効果確認へ変換し、承諾時だけ回数と効果を処理する。 */
export function triggerDefOps(
  def: TriggerDef,
  timesPerTurnKey: string,
  label: string,
  ops: Op[],
): Op[] {
  // 「終了する時、〜なら」は誘発する時刻と、解決する効果内の条件を分ける。
  // 同じ時刻に待機した先行能力で、HPやそのステップ中のライフが変わり得る。
  const effectOps: Op[] = def.perfCond
    ? [
        {
          t: "if",
          cond:
            def.perfCond === "selfLifeReduced"
              ? { c: "lifeReducedThisPerformance" }
              : { c: "not", inner: { c: "selfDamaged" } },
          then: ops,
        },
      ]
    : ops;
  if (!def.optional) return effectOps;
  const thenOps = structuredClone(effectOps) as Op[];
  if (def.timesPerTurn !== undefined)
    thenOps.unshift({ t: "markGiftUsed", key: timesPerTurnKey });
  return [
    {
      t: "chooseOps",
      label: `${label}を使いますか？`,
      thenOps,
      elseOps: [],
    },
  ];
}

export function stackNames(s: GameState, stack: HolomenStack): string[] {
  const c = topCard(s, stack);
  return [c.name, ...c.extraNames];
}

/** 1人に1名称を対応させて数える。追加名称を含めても1人を重複計上しない (Q602)。 */
export function distinctHolomenNameCount(
  s: GameState,
  stacks: HolomenStack[],
): number {
  const names = stacks.map((stack) => stackNames(s, stack));
  const assigned = new Map<string, number>();
  const assign = (index: number, visited: Set<string>): boolean => {
    for (const name of names[index]) {
      if (visited.has(name)) continue;
      visited.add(name);
      const previous = assigned.get(name);
      // 先に選ばれたホロメンを別の名称へ割り当て直せる場合も考慮する。
      if (previous === undefined || assign(previous, visited)) {
        assigned.set(name, index);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < stacks.length; index++) assign(index, new Set());
  return assigned.size;
}

/**
 * 領域を問わないカードの名称一致。
 * エクストラの「〈A〉としても扱う」はホロメン・サポートとも領域を問わず
 * 有効なので、手札・デッキ・アーカイブのカードを名称で選ぶ処理も別名を見る
 * (公式Q12/Q17/Q544/Q545/Q546)。`filter` 経由の一致は `cardMatchesFilter` が
 * 同じ扱いをするので、filterを持たない op.names 側をこの関数に合わせる。
 */
export function cardHasName(
  s: GameState,
  uid: string,
  names: string[],
): boolean {
  const c = cardOf(s, uid);
  return cardNames(c).some((name) => names.includes(name));
}

/** ◆条件が付与先ホロメンに合致するか */
export function passiveCondMatches(
  s: GameState,
  stack: HolomenStack,
  cond: import("../effects").PassiveCondition | undefined,
): boolean {
  if (!cond) return false;
  if (cond.anyOf && !cond.anyOf.some((c) => passiveCondMatches(s, stack, c)))
    return false;
  const c = topCard(s, stack);
  const names = stackNames(s, stack);
  if (cond.names && !cond.names.some((n) => names.includes(n))) return false;
  if (
    cond.minBloom &&
    !stackBloomLevels(s, stack).some(
      (lv) => bloomRank(lv) >= bloomRank(cond.minBloom!),
    )
  )
    return false;
  if (
    cond.bloomLevels &&
    !stackBloomLevels(s, stack).some((lv) => cond.bloomLevels!.includes(lv))
  )
    return false;
  if (cond.buzz && !c.buzz) return false;
  if (cond.tag && !c.tags.includes(cond.tag)) return false;
  return true;
}

/** 実行時条件付き常時ボーナス (「〜なら/〜間、このホロメンのアーツ/HP+X」) の合計 */
function passiveCondBonusValue(
  s: GameState,
  stack: HolomenStack,
  b: import("../effects").PassiveBonus,
  field: "artPlus" | "hpPlus",
): number {
  if (!b.condBonuses || b.condBonuses.length === 0) return 0;
  const entry = findStackById(s, stack.id);
  if (!entry) return 0;
  let sum = 0;
  for (const cb of b.condBonuses) {
    const v = cb[field];
    if (v === undefined) continue;
    if (cb.requiresCond && !passiveCondMatches(s, stack, b.cond)) continue;
    if (
      !evalCond(
        s,
        { player: entry.player, sourceStackId: stack.id, rest: [], label: "" },
        cb.cond,
      )
    )
      continue;
    sum += v;
  }
  return sum;
}

/** 付与サポート+ギフトを含めた最大HP */
export function effectiveMaxHp(s: GameState, stack: HolomenStack): number {
  const top = topCard(s, stack);
  let hp = top.hp;
  for (const uid of stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    hp += b.hpPlus;
    if (passiveCondMatches(s, stack, b.cond)) hp += b.condHpPlus;
    hp += passiveCondBonusValue(s, stack, b, "hpPlus");
  }
  const g = giftOf(top);
  if (g.hpPerYell) hp += g.hpPerYell * stack.yells.length;
  if (g.hpPerStacked) hp += g.hpPerStacked * (stack.cards.length - 1);
  if (g.hpPerAttachedName) {
    const count = stack.supports.filter((u) =>
      cardHasName(s, u, g.hpPerAttachedName!.names),
    ).length;
    hp += g.hpPerAttachedName.value * count;
  }
  for (const shp of g.selfHpPlus) {
    if (shp.cond) {
      const entry = findStackById(s, stack.id);
      if (
        !entry ||
        !evalCond(
          s,
          {
            player: entry.player,
            sourceStackId: stack.id,
            rest: [],
            label: "",
          },
          shp.cond,
        )
      )
        continue;
    }
    hp += shp.value;
  }
  return hp;
}

/** 付与サポート+ギフト+ターン修正によるアーツ加算値 */
export function artBonusOf(s: GameState, stack: HolomenStack): number {
  let bonus = 0;
  const names = stackNames(s, stack);
  const entry = findStackById(s, stack.id);
  for (const uid of stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    // 基本ボーナス (「付いている〈X〉のアーツ+Y」は名称一致時のみ)
    if (!b.baseCondNames || b.baseCondNames.some((n) => names.includes(n)))
      bonus += b.artPlus;
    // ポジション限定が付く追加ボーナスは、その位置にいる時だけ乗る
    // (盤面に無いスタックは限定を満たさない扱い)
    if (
      passiveCondMatches(s, stack, b.cond) &&
      (!b.condPositions ||
        (entry !== null && giftPositionOk(entry.pos, b.condPositions)))
    )
      bonus += b.condArtPlus;
    bonus += passiveCondBonusValue(s, stack, b, "artPlus");
    // 「自分のステージの〈X〉1枚につき、アーツ+Y」
    if (
      b.artPlusPerStage &&
      entry &&
      (!b.artPlusPerStage.requiresCond || passiveCondMatches(s, stack, b.cond))
    ) {
      let count = 0;
      const targetNames = b.artPlusPerStage.names;
      for (const e of allStacks(s.players[entry.player])) {
        if (stackNames(s, e.stack).some((n) => targetNames.includes(n)))
          count++;
        for (const su of e.stack.supports)
          if (cardHasName(s, su, targetNames)) count++;
      }
      bonus += b.artPlusPerStage.value * count;
    }
  }
  for (const m of s.turnModifiers)
    if (m.stackId === stack.id) bonus += m.artPlus;
  // ギフト (自身の条件付きアーツ+ と 味方からのオーラ)
  if (entry) {
    const owner = s.players[entry.player];
    const selfGift = giftOf(topCard(s, stack));
    for (const sap of selfGift.selfArtPlus) {
      if (!giftPositionOk(entry.pos, sap.positions)) continue;
      if (
        sap.cond &&
        !evalCond(
          s,
          {
            player: entry.player,
            sourceStackId: stack.id,
            rest: [],
            label: "",
          },
          sap.cond,
        )
      )
        continue;
      bonus += sap.value;
    }
    for (const { pos: hPos, stack: holder } of allStacks(owner)) {
      const hg = giftOf(topCard(s, holder));
      for (const aura of hg.auras) {
        if (!giftPositionOk(hPos, aura.positions)) continue;
        if (aura.excludeSelf && holder.id === stack.id) continue;
        if (aura.targetCollabOnly && entry.pos !== "collab") continue;
        if (aura.targetCenterOnly && entry.pos !== "center") continue;
        if (
          aura.cond &&
          !evalCond(
            s,
            {
              player: entry.player,
              sourceStackId: holder.id,
              rest: [],
              label: "",
            },
            aura.cond,
          )
        )
          continue;
        if (aura.filter && !stackMatchesFilter(s, stack, aura.filter)) continue;
        bonus += aura.value;
      }
    }
  }
  if (entry) {
    const oshi = cardOf(s, s.players[entry.player].oshiUid) as OshiCard;
    if (
      oshi.stageOshiSkill?.name === "至福のひととき" &&
      names.includes("雪花ラミィ")
    )
      bonus +=
        s.players[entry.player].archive.filter((u) =>
          cardMatchesFilter(s, entry.player, u, {
            kind: "サポート",
            tag: "ラミィのお酒",
          }),
        ).length >= 5
          ? 50
          : 20;
    if (
      oshi.stageOshiSkill?.name === "ETERNiTY FRONTiER" &&
      entry.pos === "center" &&
      names.includes("AZKi")
    )
      bonus += s.players[entry.player].holoPower.length * 20;
  }
  return bonus;
}

/** 付与サポート+ギフトオーラによる「受けるダメージ±X」の合計 */
export function damageTakenDeltaOf(
  s: GameState,
  entry: { pos: StagePosition; stack: HolomenStack },
  opts?: {
    art?: boolean;
    /** 軽減不可は各負の修正を無効にする。正の修正との相殺後に判定しない。 */
    noReduce?: boolean;
    source?: { pos: StagePosition; stack: HolomenStack } | null;
  },
): number {
  let delta = 0;
  const wearer = topCard(s, entry.stack);
  for (const uid of entry.stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    for (const dm of b.damageTaken) {
      if (opts?.noReduce && dm.delta < 0) continue;
      if (dm.requiresCond && !passiveCondMatches(s, entry.stack, b.cond))
        continue;
      if (dm.excludeTag && wearer.tags.includes(dm.excludeTag)) continue;
      if (
        dm.positions &&
        (typeof entry.pos !== "string" ||
          !dm.positions.includes(entry.pos as "center" | "collab"))
      )
        continue;
      delta += dm.delta;
    }
  }
  // 自軍のギフトによる被ダメージ修正オーラ
  const found = findStackById(s, entry.stack.id);
  if (found) {
    const owner = s.players[found.player];
    for (const { pos: hPos, stack: holder } of allStacks(owner)) {
      const hg = giftOf(topCard(s, holder));
      for (const aura of hg.damageAuras) {
        if (opts?.noReduce && aura.delta < 0) continue;
        if (!giftPositionOk(hPos, aura.positions)) continue;
        if (aura.selfOnly && holder.id !== entry.stack.id) continue;
        if (aura.artOnly && !opts?.art) continue;
        if (aura.targetPos && found.pos !== aura.targetPos) continue;
        if (
          aura.cond &&
          !evalCond(
            s,
            {
              player: found.player,
              sourceStackId: holder.id,
              rest: [],
              label: "",
            },
            aura.cond,
          )
        )
          continue;
        if (aura.filter && !stackMatchesFilter(s, entry.stack, aura.filter))
          continue;
        if (!matchesPosition(found.pos, aura.filter?.position)) continue;
        if (aura.fromSource) {
          const src = opts?.source;
          // 場を離れた発生源も、最後の持ち主・位置・Bloomレベルで情報を参照する。
          const sourcePlayer = src
            ? (findStackById(s, src.stack.id)?.player ??
              s.lastKnownHolomen?.[src.stack.id]?.player)
            : undefined;
          if (
            !src ||
            sourcePlayer !== other(found.player) ||
            !sourceMatchesFilter(s, src, aura.fromSource)
          )
            continue;
        }
        delta += aura.delta;
      }
    }
  }
  return delta;
}

/** ダメージ発生源がフィルタ (ポジション含む) に合致するか */
function sourceMatchesFilter(
  s: GameState,
  src: { pos: StagePosition; stack: HolomenStack },
  filter: TargetFilter,
): boolean {
  if (filter.position) {
    const pk = typeof src.pos === "string" ? src.pos : "back";
    const ok =
      filter.position === "front"
        ? pk === "center" || pk === "collab"
        : pk === filter.position;
    if (!ok) return false;
  }
  return stackMatchesFilter(s, src.stack, { ...filter, position: undefined });
}

/** 付与サポートの「相手からダメージを受けない」に該当するか */
export function isDamageImmune(
  s: GameState,
  entry: { pos: StagePosition; stack: HolomenStack },
): boolean {
  for (const uid of entry.stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    if (!b.noDamage) continue;
    if (b.noDamage.requiresCond && !passiveCondMatches(s, entry.stack, b.cond))
      continue;
    if (b.noDamage.positions) {
      const posKey = typeof entry.pos === "string" ? entry.pos : "back";
      if (
        !b.noDamage.positions.includes(posKey as "center" | "collab" | "back")
      )
        continue;
    }
    return true;
  }
  // ギフトの「このホロメンは相手からダメージを受けない」
  const nd = giftOf(topCard(s, entry.stack)).noDamageSelf;
  if (nd) {
    if (!nd.positions) return true;
    const posKey = typeof entry.pos === "string" ? entry.pos : "back";
    if (nd.positions.includes(posKey as "center" | "collab" | "back"))
      return true;
  }
  return false;
}

/** 相手からの特殊ダメージを受けないか */
export function isSpecialImmune(
  s: GameState,
  entry: { pos: StagePosition; stack: HolomenStack },
  sourcePlayer?: PlayerId,
): boolean {
  if (
    s.turnModifiers.some(
      (m) =>
        m.stackId === entry.stack.id &&
        m.specialImmune &&
        (m.expiresTurn ?? s.turn) >= s.turn,
    )
  )
    return true;
  const found = findStackById(s, entry.stack.id);
  if (sourcePlayer !== undefined && found?.player === sourcePlayer)
    return false;
  for (const uid of entry.stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    if (!b.noSpecialDamage) continue;
    if (
      b.noSpecialDamage.requiresCond &&
      !passiveCondMatches(s, entry.stack, b.cond)
    )
      continue;
    return true;
  }
  // 自軍のギフトによる特殊ダメージ免疫オーラ
  if (found) {
    const owner = s.players[found.player];
    for (const { pos: hPos, stack: holder } of allStacks(owner)) {
      const auras = giftOf(topCard(s, holder)).specialImmuneAuras;
      if (!auras) continue;
      for (const aura of auras) {
        if (!giftPositionOk(hPos, aura.positions)) continue;
        if (aura.targetPos) {
          const pk = typeof entry.pos === "string" ? entry.pos : "back";
          if (pk !== aura.targetPos) continue;
        }
        if (aura.filter && !stackMatchesFilter(s, entry.stack, aura.filter))
          continue;
        return true;
      }
    }
  }
  return false;
}

/** 味方のギフトにより相手からアーツダメージを受けないか (条件は保持者に対して評価) */
export function isArtImmune(
  s: GameState,
  entry: { pos: StagePosition; stack: HolomenStack },
): boolean {
  const found = findStackById(s, entry.stack.id);
  if (!found) return false;
  const owner = s.players[found.player];
  for (const { pos: hPos, stack: holder } of allStacks(owner)) {
    const auras = giftOf(topCard(s, holder)).artImmuneAuras;
    if (!auras) continue;
    for (const aura of auras) {
      if (!giftPositionOk(hPos, aura.positions)) continue;
      if (
        aura.cond &&
        !evalCond(
          s,
          {
            player: found.player,
            sourceStackId: holder.id,
            rest: [],
            label: "",
          },
          aura.cond,
        )
      )
        continue;
      if (aura.targetPos) {
        const pk = typeof entry.pos === "string" ? entry.pos : "back";
        if (pk !== aura.targetPos) continue;
      }
      if (aura.filter && !stackMatchesFilter(s, entry.stack, aura.filter))
        continue;
      return true;
    }
  }
  return false;
}

export function turnEffectActive(
  s: GameState,
  duration: TurnEffectDuration,
): boolean {
  const next = duration.nextOpponentTurn;
  if (next)
    return (
      !next.onlyDuring ||
      (s.turn > next.afterTurn && s.turnPlayer === next.player)
    );
  return (duration.expiresTurn ?? s.turn) >= s.turn;
}

/** ステージ上の指定名カード数。トップのホロメンと付与サポートを数える。 */
export function stageNamedCardCount(
  s: GameState,
  pid: PlayerId,
  names: string[],
): number {
  let count = 0;
  for (const { stack } of allStacks(s.players[pid])) {
    if (stackNames(s, stack).some((n) => names.includes(n))) count++;
    count += stack.supports.filter((u) => cardHasName(s, u, names)).length;
  }
  return count;
}

/** ステージ上の付与サポートのうち、指定名のもののuid */
export function stageSupportUidsNamed(
  s: GameState,
  pid: PlayerId,
  names: string[],
): string[] {
  const uids: string[] = [];
  for (const { stack } of allStacks(s.players[pid]))
    for (const uid of stack.supports)
      if (cardHasName(s, uid, names)) uids.push(uid);
  return uids;
}

/** バトンタッチコストの修正値込みの必要枚数 */
export function batonCostOf(s: GameState, stack: HolomenStack): number {
  let cost = topCard(s, stack).batonTouchCost;
  for (const m of s.turnModifiers)
    if (m.stackId === stack.id) cost += m.batonDelta ?? 0;
  // 付与サポートの「バトンタッチに必要な◇±X」
  for (const uid of stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    if (
      b.batonSelf &&
      (!b.batonSelf.requiresCond || passiveCondMatches(s, stack, b.cond))
    )
      cost += b.batonSelf.delta;
  }
  // 相手側の付与「相手のセンターホロメンのバトンタッチに必要な無色+X」
  const entry = findStackById(s, stack.id);
  if (entry)
    for (const mod of giftOf(topCard(s, stack)).selfBatonMods ?? [])
      if (
        !mod.cond ||
        evalCond(
          s,
          {
            player: entry.player,
            sourceStackId: stack.id,
            rest: [],
            label: "",
          },
          mod.cond,
        )
      )
        cost += mod.delta;
  if (entry && entry.pos === "center") {
    const opp = s.players[other(entry.player)];
    for (const { pos: hPos, stack: holder } of allStacks(opp)) {
      for (const uid of holder.supports) {
        const c = cardOf(s, uid);
        if (c.cardType !== "support") continue;
        const b = passiveOf(c);
        if (!b.oppCenterBaton) continue;
        if (
          b.oppCenterBaton.requiresCond &&
          !passiveCondMatches(s, holder, b.cond)
        )
          continue;
        if (
          b.oppCenterBaton.positions &&
          (typeof hPos !== "string" ||
            !b.oppCenterBaton.positions.includes(hPos as "center" | "collab"))
        )
          continue;
        cost += b.oppCenterBaton.delta;
      }
    }
  }
  return Math.max(0, cost);
}

/** 共有元も含め、使用できるアーツと不変な印刷上の参照を列挙する。 */
export function availableArtRefs(
  s: GameState,
  stack: HolomenStack,
): AvailableArtRef[] {
  const own = topCard(s, stack);
  const result = own.arts.map((art, index) => ({
    art,
    cardId: own.id,
    index,
  }));
  const tag = giftOf(own).borrowArtsTag;
  const entry = findStackById(s, stack.id);
  if (!tag || !entry) return result;
  for (const { stack: ally } of allStacks(s.players[entry.player])) {
    if (ally.id === stack.id) continue;
    const card = topCard(s, ally);
    if (!card.tags.includes(tag)) continue;
    result.push(
      ...card.arts.map((art, index) => ({ art, cardId: card.id, index })),
    );
  }
  return result;
}

/** このスタックが使用できるアーツ一覧 (ギフトによる共有を含む) */
export function availableArts(
  s: GameState,
  stack: HolomenStack,
): HolomenCard["arts"] {
  return availableArtRefs(s, stack).map((ref) => ref.art);
}

// ------------------------------------------------------------
// 効果の実行エンジン
// ------------------------------------------------------------

export function bloomRank(level: "Debut" | "1st" | "2nd" | "Spot"): number {
  return level === "Debut" ? 0 : level === "1st" ? 1 : level === "2nd" ? 2 : -1;
}

/** ホロメンの色 (ターン修正と盤面の常時効果を考慮) */
export function stackColors(s: GameState, stack: HolomenStack): Color[] {
  const target = findStackById(s, stack.id);
  if (!target && s.lastKnownHolomen?.[stack.id])
    return s.lastKnownHolomen[stack.id].colors;
  for (const m of s.turnModifiers)
    if (m.stackId === stack.id && m.allColors)
      return ["白", "緑", "赤", "青", "紫", "黄"];

  if (target && typeof target.pos === "string") {
    for (const holder of allStacks(s.players[other(target.player)])) {
      for (const uid of holder.stack.supports) {
        const card = cardOf(s, uid);
        if (card.cardType !== "support") continue;
        const passive = passiveOf(card);
        const aura = passive.oppFrontAllColors;
        if (!aura) continue;
        if (!giftPositionOk(holder.pos, aura.positions)) continue;
        if (
          aura.requiresCond &&
          !passiveCondMatches(s, holder.stack, passive.cond)
        )
          continue;
        return ["白", "緑", "赤", "青", "紫", "黄"];
      }
    }
  }
  return topCard(s, stack).colors;
}

/**
 * 「色」として数えられる色だけを返す。
 * 無色は色に含まれない (公式Q389/Q403/Q645/Q661/Q667/Q671/Q685。色とは
 * 白・緑・赤・青・紫・黄のみを指し、Spotホロメンは無色として扱われる)。
 * 色を数える・比べる処理は必ずこちらを使う。特定の色を含むかを見るだけなら
 * `stackColors` でよい (無色は6色のどれとも一致しないため)。
 */
export function stackRealColors(s: GameState, stack: HolomenStack): Color[] {
  return stackColors(s, stack).filter((c) => c !== "無");
}

/**
 * ホロメンに付いているエールが、元の色に加えて別の色としても扱われる場合の対応表。
 * hBP08-003〈FUWAMOCO〉推しステージスキル「準備は出来てるよね!」
 * (〈フワワ・アビスガード〉〈モココ・アビスガード〉に付いている赤エールすべては
 * 青エールとしても扱う) が該当する。
 * 公式Q640 のとおり**付いている間だけ**の効果なので、付け替えたエールには残らない。
 */
function yellColorAliasOf(
  s: GameState,
  stack: HolomenStack,
): { from: Color; to: Color } | null {
  // 大半の対局では該当する推しがいないので、盤面走査の前に O(1) で抜ける
  if (
    !s.players.some(
      (p) =>
        (cardOf(s, p.oshiUid) as OshiCard).stageOshiSkill?.name ===
        "準備は出来てるよね!",
    )
  )
    return null;
  const entry = findStackById(s, stack.id);
  if (!entry) return null;
  const oshi = cardOf(s, s.players[entry.player].oshiUid) as OshiCard;
  if (oshi.stageOshiSkill?.name !== "準備は出来てるよね!") return null;
  const names = stackNames(s, stack);
  if (
    !names.includes("フワワ・アビスガード") &&
    !names.includes("モココ・アビスガード")
  )
    return null;
  return { from: "赤", to: "青" };
}

/**
 * ホロメンに付いているエール1枚が持つ色。
 * 常時効果で別の色「としても」扱われる分を含むので、元の色も残る。
 * **付いているエールの色を見る処理は必ずこちらを使う** (アーカイブ・デッキ・
 * エールデッキのカードは付いていないので対象外。素の `color` でよい)。
 */
export function yellColorsOn(
  s: GameState,
  stack: HolomenStack,
  uid: string,
): Color[] {
  const card = cardOf(s, uid);
  if (card.cardType !== "yell") return [];
  const alias = yellColorAliasOf(s, stack);
  const colors: Color[] = [card.color];
  if (alias && card.color === alias.from) colors.push(alias.to);
  for (const uid of stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    if (
      b.yellAlias &&
      card.color === b.yellAlias.from &&
      (!b.yellAlias.requiresCond || passiveCondMatches(s, stack, b.cond))
    )
      colors.push(b.yellAlias.to);
  }
  return [...new Set(colors)];
}

/** ホロメンに付いているエールが指定色として扱えるか */
export function yellOnIs(
  s: GameState,
  stack: HolomenStack,
  uid: string,
  color: Color,
): boolean {
  return yellColorsOn(s, stack, uid).includes(color);
}

/** 持ち主側の推しホロメンと異なる色を持つか (無色は色として数えない) */
export function hasDiffColorFromOwnerOshi(
  s: GameState,
  stack: HolomenStack,
): boolean {
  const found = findStackById(s, stack.id);
  if (!found) return false;
  const oshi = cardOf(s, s.players[found.player].oshiUid) as OshiCard;
  return stackColors(s, stack).some((c) => c !== "無" && c !== oshi.color);
}

/**
 * 「バトンタッチ・移動・交代できない」ターン修正が有効か。
 *
 * この修正を作るのは hBP01-005〈鷹嶺ルイ〉SP推しスキル「ホークアイ」だけで、
 * 文面は「**次の相手のターンの間**、相手のセンターホロメンとコラボホロメンは、
 * バトンタッチ、移動、交代できない」。掛けた側のターン中はまだ効かない
 * (公式Q37:「相手のターンに発生するバトンタッチ、移動、交代のみができなく
 * なるため、自分のターン内であれば移動、交代させることはできます」)。
 * 制限を受けたホロメンの持ち主のターンだけを見る。
 */
export function hasNoSwitch(s: GameState, st: HolomenStack): boolean {
  const found = findStackById(s, st.id);
  if (found && s.turnPlayer !== found.player) return false;
  return s.turnModifiers.some(
    (m) => m.stackId === st.id && m.noSwitch && turnEffectActive(s, m),
  );
}

/** Q501: 「BuzzからBloomしている」は途中の履歴ではなく、真下のカードを参照する。 */
function isBloomedFromBuzz(s: GameState, stack: HolomenStack): boolean {
  const under = stack.cards[1] ? cardOf(s, stack.cards[1]) : null;
  return under?.cardType === "holomen" && under.buzz;
}

export function stackBloomLevels(
  s: GameState,
  stack: HolomenStack,
): HolomenCard["bloomLevel"][] {
  // 10.12.1: 場外へ移った後は、解除済みの修正ではなく離脱時のレベルを参照する。
  const lastKnown = s.lastKnownHolomen?.[stack.id];
  if (lastKnown?.bloomLevels && !findStackById(s, stack.id))
    return lastKnown.bloomLevels;
  const level = topCard(s, stack).bloomLevel;
  return [
    ...new Set([
      level,
      ...s.turnModifiers
        .filter(
          (m) =>
            m.stackId === stack.id &&
            m.additionalBloomLevel &&
            (m.expiresTurn ?? s.turn) >= s.turn,
        )
        .map((m) => m.additionalBloomLevel!),
    ]),
  ];
}

export function stackMatchesFilter(
  s: GameState,
  stack: HolomenStack,
  filter?: TargetFilter,
): boolean {
  if (!filter) return true;
  if (
    filter.anyOf &&
    !filter.anyOf.some((f) => stackMatchesFilter(s, stack, f))
  )
    return false;
  if (filter.bloomedFromBuzz && !isBloomedFromBuzz(s, stack)) return false;
  if (filter.diffColorFromOwnerOshi && !hasDiffColorFromOwnerOshi(s, stack))
    return false;
  // 「色が1色の」= 数える色が1色 (無色は色ではないのでSpotは該当しない。公式Q403)
  if (filter.monoColor && stackRealColors(s, stack).length !== 1) return false;
  if (
    filter.damagedAtLeast !== undefined &&
    stack.damage < filter.damagedAtLeast
  )
    return false;
  const c = topCard(s, stack);
  if (filter.color && !stackColors(s, stack).includes(filter.color))
    return false;
  if (filter.tag && !c.tags.includes(filter.tag)) return false;
  if (
    filter.names &&
    !filter.names.some((n) => stackNames(s, stack).includes(n))
  )
    return false;
  if (
    filter.nameOrTag &&
    !filter.nameOrTag.names.some((n) => stackNames(s, stack).includes(n)) &&
    !c.tags.includes(filter.nameOrTag.tag)
  )
    return false;
  if (
    filter.excludeNames &&
    filter.excludeNames.some((n) => stackNames(s, stack).includes(n))
  )
    return false;
  const levels = stackBloomLevels(s, stack);
  if (filter.bloomLevel && !levels.includes(filter.bloomLevel)) return false;
  if (
    filter.bloomLevels &&
    !filter.bloomLevels.some((lv) => levels.includes(lv))
  )
    return false;
  if (filter.excludeBloomLevel && levels.includes(filter.excludeBloomLevel))
    return false;
  if (filter.noYell && stack.yells.length > 0) return false;
  if (filter.hasYell && stack.yells.length === 0) return false;
  if (
    filter.hasAttachedFilter &&
    !stack.supports.some((u) =>
      cardMatchesFilter(
        s,
        findStackById(s, stack.id)?.player ?? s.turnPlayer,
        u,
        filter.hasAttachedFilter!,
      ),
    )
  )
    return false;
  if (
    filter.minBloom &&
    !levels.some((lv) => bloomRank(lv) >= bloomRank(filter.minBloom!))
  )
    return false;
  if (filter.buzz && !c.buzz) return false;
  if (
    filter.hasAttachedNames &&
    !stack.supports.some((u) => cardHasName(s, u, filter.hasAttachedNames!))
  )
    return false;
  if (
    filter.hasAttachedType &&
    !stack.supports.some((u) => {
      const c = cardOf(s, u);
      return (
        c.cardType === "support" && c.supportType === filter.hasAttachedType
      );
    })
  )
    return false;
  if (
    filter.hasColorYell &&
    !stack.yells.some((u) =>
      yellColorsOn(s, stack, u).some((c) => filter.hasColorYell!.includes(c)),
    )
  )
    return false;
  if (filter.resting !== undefined && !!stack.resting !== filter.resting)
    return false;
  if (filter.bloomedThisTurn && !stack.bloomedThisTurn) return false;
  if (filter.bloomedFromLevelThisTurn) {
    if (!stack.bloomedThisTurn) return false;
    const under = stack.cards[1] ? cardOf(s, stack.cards[1]) : null;
    const recordedLevel =
      stack.bloomedFromLevelThisTurn ??
      (under?.cardType === "holomen" ? under.bloomLevel : undefined);
    if (recordedLevel !== filter.bloomedFromLevelThisTurn) return false;
  }
  if (filter.enteredThisTurn && stack.enteredTurn !== s.turn) return false;
  if (
    filter.hasAttachedSupport &&
    !stack.supports.some((u) => cardOf(s, u).cardType === "support")
  )
    return false;
  return true;
}

export function cardMatchesFilter(
  s: GameState,
  pid: PlayerId,
  uid: string,
  f: CardFilter,
): boolean {
  const c = cardOf(s, uid);
  // f.any は「カード種別を問わない」の意味なので、ここで打ち切らずに
  // タグ・名称などの条件は続けて判定する (「#Tを持つカード」でエールが
  // 素通りしていた)
  if (f.alt) return f.alt.some((sub) => cardMatchesFilter(s, pid, uid, sub));
  if (f.uids && !f.uids.includes(uid)) return false;
  if (f.kind === "holomen" && c.cardType !== "holomen") return false;
  if (f.kind === "yell" && c.cardType !== "yell") return false;
  if (f.kind === "サポート" && c.cardType !== "support") return false;
  if (
    f.kind &&
    !["holomen", "yell", "サポート"].includes(f.kind) &&
    (c.cardType !== "support" || c.supportType !== f.kind)
  )
    return false;
  if (
    f.bloomLevel &&
    (c.cardType !== "holomen" || c.bloomLevel !== f.bloomLevel)
  )
    return false;
  if (
    f.excludeBloomLevel &&
    c.cardType === "holomen" &&
    c.bloomLevel === f.excludeBloomLevel
  )
    return false;
  if (
    f.minBloom &&
    (c.cardType !== "holomen" ||
      bloomRank(c.bloomLevel) < bloomRank(f.minBloom))
  )
    return false;
  if (f.buzz && (c.cardType !== "holomen" || !c.buzz)) return false;
  if (f.excludeBuzz && c.cardType === "holomen" && c.buzz) return false;
  if (f.color) {
    if (c.cardType === "holomen" && !c.colors.includes(f.color)) return false;
    if (c.cardType === "yell" && c.color !== f.color) return false;
    if (c.cardType === "support" || c.cardType === "oshi") return false;
  }
  if (f.sameColorAsOshi) {
    const oshi = cardOf(s, s.players[pid].oshiUid) as OshiCard;
    if (c.cardType === "holomen" && !c.colors.includes(oshi.color))
      return false;
    if (c.cardType === "yell" && c.color !== oshi.color) return false;
  }
  if (
    f.tag &&
    (c.cardType === "yell" || !("tags" in c) || !c.tags.includes(f.tag))
  )
    return false;
  if (f.nameContains && !c.name.includes(f.nameContains)) return false;
  if (f.limited && (c.cardType !== "support" || !c.limited)) return false;
  if (f.excludeLimited && c.cardType === "support" && c.limited) return false;
  if (f.names) {
    const names = cardNames(c);
    if (!f.names.some((n) => names.includes(n))) return false;
  }
  if (f.unlimitedOnly && (c.cardType !== "holomen" || !c.unlimitedCopies))
    return false;
  if (f.hasGift && (c.cardType !== "holomen" || !c.gift)) return false;
  if (f.hasCollabEffect && (c.cardType !== "holomen" || !c.collabEffect))
    return false;
  if (f.hasBloomEffect && (c.cardType !== "holomen" || !c.bloomEffect))
    return false;
  if (
    f.batonCost !== undefined &&
    (c.cardType !== "holomen" || c.batonTouchCost !== f.batonCost)
  )
    return false;
  if (f.sameNameAs) {
    const refNames =
      f.sameNameAs === "oshi"
        ? [cardOf(s, s.players[pid].oshiUid).name]
        : s.players[pid].collab
          ? stackNames(s, s.players[pid].collab!)
          : [];
    const names = cardNames(c);
    if (!names.some((name) => refNames.includes(name))) return false;
  }
  if (f.diffFromStage) {
    const stageNames = new Set(
      allStacks(s.players[pid]).flatMap(({ stack }) => stackNames(s, stack)),
    );
    if (stageNames.has(c.name)) return false;
  }
  return true;
}

export function evalCond(
  s: GameState,
  ctx: EffectContextData,
  cond: import("../effects").Cond,
): boolean {
  const p = s.players[ctx.player];
  // 10.12.1: 条件が発生源の情報を参照する場合、場を離れていれば最終情報を使う。
  // 対象選択・カード移動は引き続き現在のステージだけを参照する。
  const src = ctx.sourceStackId
    ? (findStackById(s, ctx.sourceStackId) ??
      s.lastKnownHolomen?.[ctx.sourceStackId] ??
      null)
    : null;
  // 解析できても評価が一度も走らない条件は、間違っていても誰も気付けない
  engineObserver?.cond?.(cond.c);
  switch (cond.c) {
    case "oppHandAtLeast":
      return s.players[other(ctx.player)].hand.length >= cond.n;
    case "oppHoloPowerAtLeast":
      return s.players[other(ctx.player)].holoPower.length >= cond.n;
    case "oshiHasStageSkill": {
      const c = cardOf(s, p.oshiUid);
      return c.cardType === "oshi" && !!c.stageOshiSkill;
    }
    case "batonTouchedThisTurn":
      return p.usedBatonTouchThisTurn;
    case "artUseNumber":
      return s.artUsesThisTurn[ctx.player].length === cond.n;
    case "archiveBloomedThisTurn":
      return (s.archiveBloomedThisTurn ?? [false, false])[ctx.player];
    case "selfRemainingHpAtLeast":
      return !!src && effectiveMaxHp(s, src.stack) - src.stack.damage >= cond.n;
    case "stageAttachedCount":
      return (
        allStacks(p)
          .flatMap((x) => x.stack.supports)
          .filter((u) => cardMatchesFilter(s, ctx.player, u, cond.filter))
          .length >= cond.n
      );
    case "stageYellHasColors": {
      const colors = allStacks(p).flatMap((x) =>
        x.stack.yells.flatMap((u) => yellColorsOn(s, x.stack, u)),
      );
      return cond.colors.every((c) => colors.includes(c));
    }
    case "milledHas": {
      const has = !!ctx.milled?.some((u) =>
        cardMatchesFilter(s, ctx.player, u, cond.filter),
      );
      return cond.negate ? !has : has;
    }
    case "centerHasTag":
      return !!p.center && topCard(s, p.center).tags.includes(cond.tag);
    case "stageHasNamedCard":
      return stageNamedCardCount(s, ctx.player, cond.names) > 0;
    case "stageHas": {
      const matches = allStacks(p).filter(
        ({ pos, stack }) =>
          (!cond.excludeSelf || stack.id !== ctx.sourceStackId) &&
          (!cond.filter.sourceOnly || stack.id === ctx.sourceStackId) &&
          (!cond.filter.excludeSource || stack.id !== ctx.sourceStackId) &&
          (!cond.pos ||
            (cond.pos === "back"
              ? typeof pos !== "string"
              : pos === cond.pos)) &&
          stackMatchesFilter(s, stack, cond.filter),
      );
      const count = cond.distinctNames
        ? distinctHolomenNameCount(
            s,
            matches.map(({ stack }) => stack),
          )
        : matches.length;
      return count >= (cond.n ?? 1);
    }
    case "lifeLessThanOpp":
      return p.life.length < s.players[other(ctx.player)].life.length;
    case "lifeAtMostOpp":
      return p.life.length <= s.players[other(ctx.player)].life.length;
    case "handLessThanOpp":
      return p.hand.length < s.players[other(ctx.player)].hand.length;
    case "downedLastOppTurn": {
      if (!cond.filter) return s.downsPrevTurn[ctx.player] > 0;
      return s.downedUidsPrevTurn[ctx.player].some((u) => {
        const c = cardOf(s, u);
        if (
          cond.filter!.tag &&
          !("tags" in c && c.tags.includes(cond.filter!.tag))
        )
          return false;
        if (cond.filter!.names && !cond.filter!.names.includes(c.name))
          return false;
        return true;
      });
    }
    case "bloomedFromDebut":
      return !!ctx.bloomedFromDebut;
    case "bloomedFromBuzz":
      return !!ctx.bloomedFromBuzz;
    case "selfActivatedByOshiSkill":
      return (
        !!src &&
        (src.stack.activatedByOshiSkills ?? []).some(
          (activation) =>
            activation.turn === s.turn &&
            !activation.sp &&
            activation.name === cond.name,
        )
      );
    case "selfBloomedBySpOshiSkill":
      return (
        ctx.bloomedByOshiSkill?.sp === true &&
        ctx.bloomedByOshiSkill.name === cond.name &&
        ctx.bloomedByOshiSkill.stackId === ctx.sourceStackId
      );
    case "artDowned":
      // 「相手のセンターホロメンをダウンさせた時」はコラボをダウンさせても発揮しない
      if (!ctx.lastArtDowned) return false;
      return !cond.pos || ctx.lastArtDownedPos === cond.pos;
    case "artOverkillAtLeast":
      return (ctx.lastOverkill ?? 0) >= cond.n;
    case "oshiIs": {
      const oshi = cardOf(s, p.oshiUid);
      return cond.names.includes(oshi.name);
    }
    case "centerIs":
      return (
        !!p.center &&
        cond.names.some((n) => stackNames(s, p.center!).includes(n))
      );
    case "centerColorIs":
      return !!p.center && stackColors(s, p.center).includes(cond.color);
    case "centerBloomLevelIs":
      return !!p.center && stackBloomLevels(s, p.center).includes(cond.level);
    case "usedLimitedThisTurn":
      return cond.kind
        ? s.usedSupportTagTypesThisTurn[ctx.player].includes(
            `!LIMITED|${cond.kind}`,
          )
        : p.usedLimitedThisTurn;
    case "holoPowerAtLeast":
      return p.holoPower.length >= cond.n;
    case "handEq":
      return p.hand.length === cond.n;
    case "stageYellArchivedThisTurn":
      return s.stageYellArchivedThisTurn[ctx.player];
    case "oppCenterHasAttachedType": {
      const oc = s.players[other(ctx.player)].center;
      return (
        !!oc &&
        oc.supports.some((u) => {
          const c = cardOf(s, u);
          return (
            c.cardType === "support" &&
            cond.kinds.includes(
              c.supportType as "マスコット" | "ファン" | "ツール",
            )
          );
        })
      );
    }
    case "selfYellExactlyOneOf": {
      if (!src) return false;
      const yellColors = src.stack.yells.flatMap((u) =>
        yellColorsOn(s, src.stack, u),
      );
      const hits = cond.colors.filter((c) => yellColors.includes(c)).length;
      return hits === 1;
    }
    case "stageAttachedCountAtLeast": {
      const count = allStacks(p).reduce(
        (acc, { stack }) =>
          acc +
          stack.supports.filter((u) => {
            const c = cardOf(s, u);
            return (
              c.cardType === "support" &&
              cond.kinds.includes(
                c.supportType as "マスコット" | "ファン" | "ツール",
              )
            );
          }).length,
        0,
      );
      return count >= cond.n;
    }
    case "oppStageHas":
      return allStacks(s.players[other(ctx.player)]).some(
        ({ pos, stack }) =>
          (!cond.pos || pos === cond.pos) &&
          stackMatchesFilter(s, stack, cond.filter),
      );
    case "usedSpSkill":
      return (
        p.usedSpOshiSkill &&
        (!cond.name || p.usedSpOshiSkillInfo?.name === cond.name) &&
        (!cond.oshiNames ||
          cond.oshiNames.includes(p.usedSpOshiSkillInfo?.oshiName ?? ""))
      );
    case "usedOshiSkillThisTurn":
      return cond.name
        ? (p.usedOshiSkillNamesThisTurn ?? []).includes(cond.name)
        : p.usedOshiSkillThisTurn;
    case "artNameIs": {
      if (!src || ctx.artIndex === undefined) return false;
      return (
        (ctx.artName ?? availableArts(s, src.stack)[ctx.artIndex]?.name) ===
        cond.name
      );
    }
    case "revealedSameBloom": {
      const cards = (ctx.revealed ?? []).map((u) => cardOf(s, u));
      if (
        cards.length !== cond.n ||
        cards.some((c) => c.cardType !== "holomen")
      )
        return false;
      return (
        new Set(cards.map((c) => (c as HolomenCard).bloomLevel)).size === 1
      );
    }
    case "usedSpSkillThisTurn":
      return (
        !!p.usedSpOshiSkillThisTurn &&
        (!cond.name || p.usedSpOshiSkillInfo?.name === cond.name) &&
        (!cond.ownMainStep ||
          (p.usedSpOshiSkillInfo?.turn === s.turn &&
            p.usedSpOshiSkillInfo.ownMainStep))
      );
    case "oppCenterBatonAtLeast": {
      const oc = s.players[other(ctx.player)].center;
      return !!oc && batonCostOf(s, oc) >= cond.n;
    }
    case "movedHolomenAtLeast":
      return (
        (ctx.pickedCards ?? []).filter(
          (u) => cardOf(s, u).cardType === "holomen",
        ).length >= cond.n
      );
    case "tagCenterCollabDiffYell": {
      const center = p.center;
      const collab = p.collab;
      if (
        !center ||
        !collab ||
        !topCard(s, center).tags.includes(cond.tag) ||
        !topCard(s, collab).tags.includes(cond.tag)
      )
        return false;
      // 両位置から1色ずつ選べることが必要。片側だけに複数色あっても成立しない。
      const centerColors = center.yells.flatMap((u) =>
        yellColorsOn(s, center, u),
      );
      const collabColors = collab.yells.flatMap((u) =>
        yellColorsOn(s, collab, u),
      );
      return centerColors.some((a) => collabColors.some((b) => a !== b));
    }
    case "not":
      return !evalCond(s, ctx, cond.inner);
    case "and":
      return cond.inner.every((c) => evalCond(s, ctx, c));
    case "or":
      return cond.inner.some((c) => evalCond(s, ctx, c));
    case "selfDamaged":
      return !!src && src.stack.damage > 0;
    case "lifeReducedThisPerformance": {
      const before = s.lifeAtPerfStart?.[ctx.player];
      return before !== undefined && p.life.length < before;
    }
    case "centerDamaged":
      return !!p.center && p.center.damage > 0;
    case "oppBackDamaged":
      return s.players[other(ctx.player)].back.some((b) => b.damage > 0);
    case "oppBackDamagedCount":
      return (
        s.players[other(ctx.player)].back.filter((b) => b.damage > 0).length >=
        cond.n
      );
    case "oppBackDamageSumAtLeast":
      return (
        s.players[other(ctx.player)].back.reduce(
          (sum, b) => sum + b.damage,
          0,
        ) >= cond.n
      );
    case "oppBackDamagedByAtLeast":
      return s.players[other(ctx.player)].back.some((b) => b.damage >= cond.n);
    case "bloomedOwnThisTurn":
      return s.bloomedCardUidsThisTurn[ctx.player].length > 0;
    case "archiveCountAtLeast":
      return p.archive.length >= cond.n;
    case "archiveHasHolomen":
      return p.archive.some((u) => cardOf(s, u).cardType === "holomen");
    case "archiveHasYell":
      return p.archive.some((u) => {
        const c = cardOf(s, u);
        return (
          c.cardType === "yell" &&
          (!cond.color || (c as YellCard).color === cond.color)
        );
      });
    case "milledFromDeckThisTurnAtLeast":
      return s.deckArchivedThisTurn[ctx.player] >= cond.n;
    case "diceRolledByName": {
      const dr = s.diceRollsThisTurn[ctx.player];
      const total = cond.names.reduce((acc, nm) => acc + (dr[nm] ?? 0), 0);
      return total >= cond.n;
    }
    case "stageYellCountAtLeast": {
      let total = 0;
      for (const { stack } of allStacks(p)) total += stack.yells.length;
      return total >= cond.n;
    }
    case "oppStageYellCountAtLeast": {
      let total = 0;
      for (const { stack } of allStacks(s.players[other(ctx.player)]))
        total += stack.yells.length;
      return total >= cond.n;
    }
    case "bothStageYellSumAtLeast": {
      let total = 0;
      for (const pid of [0, 1] as PlayerId[])
        for (const { stack } of allStacks(s.players[pid]))
          total += stack.yells.length;
      return total >= cond.n;
    }
    case "stageYellVsOpp": {
      let mine = 0;
      let opp = 0;
      for (const { stack } of allStacks(p)) mine += stack.yells.length;
      for (const { stack } of allStacks(s.players[other(ctx.player)]))
        opp += stack.yells.length;
      return cond.mode === "more"
        ? mine >= opp + (cond.margin ?? 1)
        : cond.mode === "less"
          ? mine < opp
          : mine <= opp;
    }
    case "selfHasYellExcept": {
      if (!src) return false;
      const n = src.stack.yells.filter(
        (u) => !yellOnIs(s, src.stack, u, cond.color),
      ).length;
      return n >= cond.n;
    }
    case "oshiColorIs":
      return (cardOf(s, p.oshiUid) as OshiCard).color === cond.color;
    case "usedSupportTypeThisTurn":
      return cond.kind === "サポート"
        ? s.usedSupportTypesThisTurn[ctx.player].length > 0
        : s.usedSupportTypesThisTurn[ctx.player].includes(cond.kind);
    case "usedCardNameThisTurn":
      return cond.names.some((n) =>
        s.usedSupportNamesThisTurn[ctx.player].includes(n),
      );
    case "usedTaggedSupportThisTurn": {
      const hits = (s.usedSupportTagTypesThisTurn[ctx.player] ?? []).filter(
        (e) =>
          (cond.kind === "サポート" && e.startsWith(`${cond.tag}|`)) ||
          e === `${cond.tag}|${cond.kind}`,
      ).length;
      return hits >= (cond.n ?? 1);
    }
    case "lastMilledAllSupport":
      return (
        (ctx.milled ?? []).length > 0 &&
        (ctx.milled ?? []).every((u) => cardOf(s, u).cardType === "support")
      );
    case "lastMilledAllHolomen":
      return (
        (ctx.milled ?? []).length > 0 &&
        (ctx.milled ?? []).every((u) => cardOf(s, u).cardType === "holomen")
      );
    case "lastMilledAny":
      return (ctx.milled ?? []).length > 0;
    case "selfHasAttachedType":
      return (
        !!src &&
        src.stack.supports.some((u) => {
          const c = cardOf(s, u);
          return (
            c.cardType === "support" &&
            cond.kinds.includes(
              c.supportType as "マスコット" | "ファン" | "ツール",
            )
          );
        })
      );
    case "selfHasAttachedTag":
      return (
        !!src &&
        src.stack.supports.some((u) => {
          const c = cardOf(s, u);
          return c.cardType === "support" && c.tags.includes(cond.tag);
        })
      );
    case "selfHasAttachedSupport":
      return (
        !!src &&
        src.stack.supports.some((u) => cardOf(s, u).cardType === "support")
      );
    case "centerHasYell":
      return !!p.center && p.center.yells.length >= cond.n;
    case "stageHasColorYell": {
      let cnt = 0;
      for (const { stack } of allStacks(p))
        cnt += stack.yells.filter((u) =>
          yellOnIs(s, stack, u, cond.color),
        ).length;
      return cnt >= (cond.n ?? 1);
    }
    case "stageYellColorsAtLeast": {
      const colors = new Set<string>();
      for (const { stack } of allStacks(p))
        for (const u of stack.yells)
          for (const c of yellColorsOn(s, stack, u)) colors.add(c);
      return colors.size >= cond.n;
    }
    case "stageAllYellColor": {
      const entries = allStacks(p).flatMap(({ stack }) =>
        stack.yells.map((u) => ({ stack, u })),
      );
      return (
        entries.length > 0 &&
        entries.every((e) => yellOnIs(s, e.stack, e.u, cond.color))
      );
    }
    case "stackedEq": {
      if (!src) return false;
      const stacked = src.stack.cards.length - 1;
      return cond.atLeast ? stacked >= cond.n : stacked === cond.n;
    }
    case "centerStackedAtLeast":
      return !!p.center && p.center.cards.length - 1 >= cond.n;
    case "stageCountAtMost":
      return allStacks(p).length <= cond.n;
    case "selfHasYell": {
      if (!src) return false;
      const n = src.stack.yells.filter((u) =>
        yellOnIs(s, src.stack, u, cond.color),
      ).length;
      return n >= cond.n;
    }
    case "selfYellCount": {
      if (!src) return false;
      return src.stack.yells.length >= cond.n;
    }
    case "boundYellCount": {
      const b = ctx.boundStackId ? findStackById(s, ctx.boundStackId) : null;
      if (!b) return false;
      return b.stack.yells.length >= cond.n;
    }
    case "boundIs": {
      const b = ctx.boundStackId ? findStackById(s, ctx.boundStackId) : null;
      if (!b) return false;
      return stackMatchesFilter(s, b.stack, cond.filter);
    }
    case "cheerDeckCountAtMost":
      return p.cheerDeck.length <= cond.n;
    case "deckCountAtMost":
      return p.deck.length <= cond.n;
    case "selfBloomedFromBuzz": {
      if (!src) return false;
      return isBloomedFromBuzz(s, src.stack);
    }
    case "stageCountVsOpp": {
      const mine = allStacks(p).length;
      const oppN = allStacks(s.players[other(ctx.player)]).length;
      return cond.mode === "less" ? mine < oppN : mine > oppN;
    }
    case "bothCenterBloomLevelIs": {
      const oc = p.center;
      const tc = s.players[other(ctx.player)].center;
      return (
        !!oc &&
        !!tc &&
        stackBloomLevels(s, oc).includes(cond.level) &&
        stackBloomLevels(s, tc).includes(cond.level)
      );
    }
    case "downedIs": {
      const uid = ctx.downedCards?.[0];
      if (!uid) return false;
      const c = cardOf(s, uid);
      if (c.cardType !== "holomen") return false;
      const downed = ctx.downedStackId
        ? (findStackById(s, ctx.downedStackId) ??
          s.lastKnownHolomen?.[ctx.downedStackId] ??
          null)
        : null;
      const levels = downed
        ? stackBloomLevels(s, downed.stack)
        : [c.bloomLevel];
      return (
        (!!cond.buzz && c.buzz) ||
        levels.some((lv) => ((cond.levels ?? []) as string[]).includes(lv))
      );
    }
    case "pickedAtLeast":
      return (ctx.pickedCards ?? []).length >= cond.n;
    case "attachedAtLeast":
      return (ctx.lastAttachedCount ?? 0) >= cond.n;
    case "milledAtLeast":
      return (ctx.milled ?? []).length >= cond.n;
    case "oncePerGameUnused":
      return !(s.usedEffectsOncePerGame?.[ctx.player] ?? []).includes(cond.key);
    case "stageMonoDistinct": {
      // 無色は色に含まれないため、Spotホロメンは「色が1色」に数えない (公式Q403)
      const colors = new Set<string>();
      for (const { stack } of allStacks(p)) {
        const cs = stackRealColors(s, stack);
        if (cs.length === 1) colors.add(cs[0]);
      }
      return colors.size >= cond.n;
    }
    case "selfHasAttachedName": {
      if (!src) return false;
      const cnt = src.stack.supports.filter((u) =>
        cardHasName(s, u, cond.names),
      ).length;
      return cnt >= (cond.n ?? 1);
    }
    case "lifeAtMost":
      return p.life.length <= cond.n;
    case "lifeAtLeast":
      return p.life.length >= cond.n;
    case "lifeEq":
      return p.life.length === cond.n;
    case "handAtMost":
      return p.hand.length <= cond.n;
    case "handAtLeast":
      return p.hand.length >= cond.n;
    case "secondPlayerFirstTurn":
      return s.turnPlayer !== s.firstPlayer && s.turn === 2;
    case "revealedMatches": {
      const revealed = ctx.revealed ?? [];
      return (
        revealed.length > 0 &&
        revealed.every((u) => cardMatchesFilter(s, ctx.player, u, cond.filter))
      );
    }
    case "allyUsedArtThisTurn":
      return (s.artUsesThisTurn?.[ctx.player] ?? []).some(
        (use) =>
          (!cond.pos || use.pos === cond.pos) &&
          cond.names.some((name) => use.names.includes(name)),
      );
    case "archiveHas":
      return (
        p.archive.filter((u) =>
          cardMatchesFilter(s, ctx.player, u, cond.filter),
        ).length >= cond.n
      );
    case "revealedSome":
      return (ctx.revealed ?? []).some((u) =>
        cardMatchesFilter(s, ctx.player, u, cond.filter),
      );
    case "revealedCountAtLeast":
      return (
        (ctx.revealed ?? []).filter((u) =>
          cardMatchesFilter(s, ctx.player, u, cond.filter),
        ).length >= cond.n
      );
    case "frontBothMatch":
      return (
        !!p.center &&
        !!p.collab &&
        stackMatchesFilter(s, p.center, cond.filter) &&
        stackMatchesFilter(s, p.collab, cond.filter)
      );
    case "stageAll": {
      const stacks = allStacks(p);
      return (
        stacks.length > 0 &&
        stacks.every(({ stack }) => stackMatchesFilter(s, stack, cond.filter))
      );
    }
    case "stageHasDiffColorFromSelf": {
      if (!src) return false;
      // 無色は色に含まれないため、Spotホロメンは「異なる色を持つ」に数えない (公式Q389)
      const selfColors = stackRealColors(s, src.stack);
      return allStacks(p).some(({ stack }) => {
        if (stack.id === src.stack.id) return false;
        const colors = stackRealColors(s, stack);
        // Q390: 共通色があっても、別の色を1色以上持つFUWAMOCO等は該当する。
        return colors.some((c) => !selfColors.includes(c));
      });
    }
    case "artTargetIs": {
      if (ctx.artTargetStackId == null) return false;
      const found = findStackById(s, ctx.artTargetStackId);
      if (!found) return false;
      if (cond.pos && found.pos !== cond.pos) return false;
      if (cond.filter && !stackMatchesFilter(s, found.stack, cond.filter))
        return false;
      if (
        cond.batonAtLeast !== undefined &&
        batonCostOf(s, found.stack) < cond.batonAtLeast
      )
        return false;
      return true;
    }
    case "stageToDeckThisTurn":
      return s.stageToDeckThisTurn[ctx.player];
    case "pickedHasTag": {
      const picked = ctx.pickedCards ?? [];
      return (
        picked.length > 0 &&
        picked.every((u) => {
          const c = cardOf(s, u);
          return "tags" in c && c.tags.includes(cond.tag);
        })
      );
    }
  }
}

/** 対象候補の列挙 */
export function targetCandidates(
  s: GameState,
  ctx: EffectContextData,
  target: StackTarget,
  filter?: TargetFilter,
): { player: PlayerId; pos: StagePosition; stack: HolomenStack }[] {
  const own = s.players[ctx.player];
  const opp = s.players[other(ctx.player)];
  const oppId = other(ctx.player);
  const list: { player: PlayerId; pos: StagePosition; stack: HolomenStack }[] =
    [];
  switch (target) {
    case "self": {
      const f = ctx.sourceStackId ? findStackById(s, ctx.sourceStackId) : null;
      if (f) list.push(f);
      break;
    }
    case "ownCenter":
      if (own.center)
        list.push({ player: ctx.player, pos: "center", stack: own.center });
      break;
    case "ownCollab":
      if (own.collab)
        list.push({ player: ctx.player, pos: "collab", stack: own.collab });
      break;
    case "oppCenter":
      if (opp.center)
        list.push({ player: oppId, pos: "center", stack: opp.center });
      break;
    case "oppCollab":
      if (opp.collab)
        list.push({ player: oppId, pos: "collab", stack: opp.collab });
      break;
    case "chooseOwn":
    case "allOwn":
      for (const e of allStacks(own)) list.push({ player: ctx.player, ...e });
      break;
    case "chooseOwnBack":
      own.back.forEach((stack, i) =>
        list.push({ player: ctx.player, pos: { back: i }, stack }),
      );
      break;
    case "chooseOpp":
    case "chooseOppFront":
    case "allOppFront":
      if (opp.center)
        list.push({ player: oppId, pos: "center", stack: opp.center });
      if (opp.collab)
        list.push({ player: oppId, pos: "collab", stack: opp.collab });
      break;
    case "allOwnFront":
    case "chooseOwnFront":
      if (own.center)
        list.push({ player: ctx.player, pos: "center", stack: own.center });
      if (own.collab)
        list.push({ player: ctx.player, pos: "collab", stack: own.collab });
      break;
    case "allFrontBoth":
      if (own.center)
        list.push({ player: ctx.player, pos: "center", stack: own.center });
      if (own.collab)
        list.push({ player: ctx.player, pos: "collab", stack: own.collab });
      if (opp.center)
        list.push({ player: oppId, pos: "center", stack: opp.center });
      if (opp.collab)
        list.push({ player: oppId, pos: "collab", stack: opp.collab });
      break;
    case "chooseOppAny":
    case "allOpp":
      for (const e of allStacks(opp)) list.push({ player: oppId, ...e });
      break;
    case "allBoth":
      for (const e of allStacks(own)) list.push({ player: ctx.player, ...e });
      for (const e of allStacks(opp)) list.push({ player: oppId, ...e });
      break;
    case "chooseOppBack":
    case "allOppBack":
      opp.back.forEach((stack, i) =>
        list.push({ player: oppId, pos: { back: i }, stack }),
      );
      break;
    case "chooseOppCenterOrBack":
      if (opp.center)
        list.push({ player: oppId, pos: "center", stack: opp.center });
      opp.back.forEach((stack, i) =>
        list.push({ player: oppId, pos: { back: i }, stack }),
      );
      break;
    case "artTarget": {
      const f = ctx.artTargetStackId
        ? findStackById(s, ctx.artTargetStackId)
        : null;
      if (f) list.push(f);
      break;
    }
    case "bound": {
      // 同じホロメンが二重に束縛されても対象は1人として数える
      const ids = [
        ...new Set(
          ctx.boundStackIds && ctx.boundStackIds.length > 0
            ? ctx.boundStackIds
            : ctx.boundStackId
              ? [ctx.boundStackId]
              : [],
        ),
      ];
      for (const id of ids) {
        const f = findStackById(s, id);
        if (f) list.push(f);
      }
      break;
    }
  }
  return list.filter(
    (e) =>
      stackMatchesFilter(s, e.stack, filter) &&
      (!filter?.excludeSource || e.stack.id !== ctx.sourceStackId) &&
      matchesPosition(e.pos, filter?.position),
  );
}

/** ポジション限定フィルタの判定 */
export function matchesPosition(
  pos: StagePosition,
  want?: TargetFilter["position"],
): boolean {
  if (!want) return true;
  const isBack = typeof pos === "object";
  if (want === "back") return isBack;
  if (want === "front") return !isBack;
  return pos === want;
}
