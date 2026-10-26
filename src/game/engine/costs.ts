// ゲーム状態とルールの処理：costs。
import type { Color, YellCard, OshiCard, HolomenCard } from "../../data/types";
import { parseArtCostMods, parseOshiReactive } from "../effects";
import type { Op } from "../effects";
import type {
  GameState,
  Prompt,
  StagePosition,
  HolomenStack,
  PlayerId,
  EffectContextData,
} from "../types";
import {
  stackMatchesFilter,
  matchesPosition,
  passiveOf,
  passiveCondMatches,
  yellColorsOn,
  yellOnIs,
  evalCond,
  cardHasName,
  stackNames,
  stackRealColors,
  giftOf,
  giftPositionOk,
  stackColors,
  oshiSkillAdjustments,
  oshiSkillUseCount,
  cardMatchesFilter,
  targetCandidates,
} from "./conditions";
import {
  allStacks,
  cardOf,
  findStackById,
  other,
  topCard,
  isSupportAbilitySource,
} from "./state";

/** 選択前はステージから、取り外した後はプロンプトの記録から保持者を参照する。 */
export function cheerOriginStackId(
  s: GameState,
  prompt: Extract<Prompt, { type: "cheerAssign" }>,
): number | undefined {
  return (
    prompt.originStackId ??
    allStacks(s.players[prompt.targetPlayer ?? prompt.player]).find(
      ({ stack }) => stack.yells.includes(prompt.yellUid),
    )?.stack.id
  );
}

/** エール送付プロンプトで実際に選べる送り先を列挙する。 */
export function cheerAssignCandidates(
  s: GameState,
  prompt: Extract<Prompt, { type: "cheerAssign" }>,
): { pos: StagePosition; stack: HolomenStack }[] {
  const targetP = s.players[prompt.targetPlayer ?? prompt.player];
  const originId = prompt.filter?.excludeYellOrigin
    ? cheerOriginStackId(s, prompt)
    : undefined;
  const boundIds =
    prompt.ctx?.boundStackIds && prompt.ctx.boundStackIds.length > 0
      ? prompt.ctx.boundStackIds
      : prompt.ctx?.boundStackId !== undefined
        ? [prompt.ctx.boundStackId]
        : [];
  return allStacks(targetP).filter(({ pos, stack }) => {
    if (prompt.excludedTargetStackIds?.includes(stack.id)) return false;
    if (stack.id === originId) return false;
    if (
      prompt.requiredTargetStackId !== undefined &&
      stack.id !== prompt.requiredTargetStackId
    )
      return false;
    if (prompt.filter && !stackMatchesFilter(s, stack, prompt.filter))
      return false;
    if (!matchesPosition(pos, prompt.filter?.position)) return false;
    if (prompt.frontOnly && pos !== "center" && pos !== "collab") return false;
    if (
      prompt.filter?.excludeSource &&
      prompt.ctx?.sourceStackId !== undefined &&
      stack.id === prompt.ctx.sourceStackId
    )
      return false;
    if (
      prompt.filter?.sourceOnly &&
      prompt.ctx?.sourceStackId !== undefined &&
      stack.id !== prompt.ctx.sourceStackId
    )
      return false;
    if (prompt.filter?.boundOnly && !boundIds.includes(stack.id)) return false;
    if (
      prompt.perTargetMax !== undefined &&
      (prompt.sentCounts?.[stack.id] ?? 0) >= prompt.perTargetMax
    )
      return false;
    return true;
  });
}

export function stageYellCount(s: GameState, pid: PlayerId): number {
  return allStacks(s.players[pid]).reduce(
    (sum, { stack }) => sum + stack.yells.length,
    0,
  );
}

/**
 * 「アーカイブするエール1枚のかわりに、この付与サポートをアーカイブできる」
 * (yellArchiveSub) を提供している付与サポートのuid。
 *
 * 能力の発生源ホロメンに付いているものを見る。カードの文面が
 * 「このファンが付いているホロメンの**能力で**エールをアーカイブする時」
 * なので、アーカイブされるエールが別のホロメンに付いていても働く
 * (総合ルール10.11.4 の例がまさにその形)。
 */
export function yellArchiveSubUids(
  s: GameState,
  holder: HolomenStack,
  matchesColor: (color: Color) => boolean,
  skip: readonly string[] = [],
): string[] {
  const out: string[] = [];
  for (const uid of holder.supports) {
    if (skip.includes(uid)) continue;
    const sc = cardOf(s, uid);
    if (sc.cardType !== "support") continue;
    const pb = passiveOf(sc);
    if (!pb.yellArchiveSub) continue;
    if (
      pb.yellArchiveSub.requiresCond &&
      !passiveCondMatches(s, holder, pb.cond)
    )
      continue;
    // 色指定 (おかにゃん=青) がある肩代わりは、その色のエールをアーカイブする時のみ
    if (pb.yellArchiveSub.color && !matchesColor(pb.yellArchiveSub.color))
      continue;
    out.push(uid);
  }
  return out;
}

/**
 * 起動型能力のコスト「このホロメンのエールn枚をアーカイブする」を支払えるか。
 * 付与サポートによる肩代わり (yellArchiveSub) も1枚1枚分として数える。
 */
function archiveSelfYellPayable(
  s: GameState,
  stack: HolomenStack,
  op: Extract<Op, { t: "archiveSelfYell" }>,
): boolean {
  // 「すべて」は0枚でも成立するのでコストにならない
  if (op.all) return true;
  const matching = stack.yells.filter((u) => {
    const cols = yellColorsOn(s, stack, u);
    if (op.excludeColor) return !cols.includes(op.excludeColor);
    if (op.colors) return op.colors.some((c) => cols.includes(c));
    return !op.color || cols.includes(op.color);
  });
  if (matching.length >= op.n) return true;
  // 肩代わりできる付与サポートを数える (実行時と同じ色条件で判定する)
  let subs = 0;
  for (const uid of stack.supports) {
    const sc = cardOf(s, uid);
    if (sc.cardType !== "support") continue;
    const pb = passiveOf(sc);
    if (!pb.yellArchiveSub) continue;
    if (
      pb.yellArchiveSub.requiresCond &&
      !passiveCondMatches(s, stack, pb.cond)
    )
      continue;
    const subColor = pb.yellArchiveSub.color;
    if (subColor) {
      const archivesThatColor =
        op.color === subColor ||
        op.colors?.includes(subColor) ||
        (!op.color &&
          !op.colors &&
          op.excludeColor !== subColor &&
          stack.yells.some((u) => yellOnIs(s, stack, u, subColor)));
      if (!archivesThatColor) continue;
    }
    subs++;
  }
  return matching.length + subs >= op.n;
}

/** 起動能力の明示的なコストだけを判定する。効果の対象不在はコスト不足ではない。 */
export function activatedCostPayable(
  s: GameState,
  pid: PlayerId,
  stack: HolomenStack,
  ops: readonly Op[],
  sourceSupportUid?: string,
): boolean {
  const first = ops[0];
  if (first?.t !== "optionalCost") return true;
  return canPayOptionalCost(
    s,
    {
      player: pid,
      sourceStackId: stack.id,
      sourceSupportUid,
      rest: [],
      label: "",
    },
    first.cost,
  );
}

// ------------------------------------------------------------
// パフォーマンスステップ (9章, 12.3)
// ------------------------------------------------------------

/** アーツ自身のコスト軽減文 (「〜なら、このアーツに必要な無色-X」等) の合計軽減枚数 */
function artSelfCostless(
  s: GameState,
  stack: HolomenStack,
  artDesc?: string,
): { costless: number; colorless: Partial<Record<Color, number>> } {
  const mods = parseArtCostMods(artDesc);
  const result: {
    costless: number;
    colorless: Partial<Record<Color, number>>;
  } = {
    costless: 0,
    colorless: {},
  };
  if (mods.length === 0) return result;
  const entry = findStackById(s, stack.id);
  const owner = entry?.player ?? s.turnPlayer;
  const ctx: EffectContextData = {
    player: owner,
    sourceStackId: stack.id,
    rest: [],
    label: "",
  };
  // 各modの軽減量を求める (「かわりに」は直前modの寄与を打ち消す)
  const applied: { color?: Color; value: number }[] = [];
  for (const mod of mods) {
    if (
      mod.positions &&
      (!entry || !mod.positions.some((pos) => matchesPosition(entry.pos, pos)))
    ) {
      applied.push({ color: mod.color, value: 0 });
      continue;
    }
    if (mod.cond && !evalCond(s, ctx, mod.cond)) {
      applied.push({ color: mod.color, value: 0 });
      continue;
    }
    let count = 1;
    if (mod.per) {
      count = 0;
      if (mod.per.kind === "centerAttachedName") {
        const names = mod.per.names;
        const center = s.players[owner].center;
        if (center)
          count = center.supports.filter((u) =>
            cardHasName(s, u, names),
          ).length;
      } else if (mod.per.kind === "archiveYellColorsBoth") {
        const colors = new Set<string>();
        for (const pid of [0, 1] as PlayerId[])
          for (const u of s.players[pid].archive) {
            const c = cardOf(s, u);
            if (c.cardType === "yell") colors.add((c as YellCard).color);
          }
        count = colors.size;
      }
    }
    if (mod.replacePrev && applied.length > 0)
      applied[applied.length - 1].value = 0;
    applied.push({ color: mod.color, value: mod.costless * count });
  }
  for (const a of applied) {
    if (a.value <= 0) continue;
    if (a.color)
      result.colorless[a.color] = (result.colorless[a.color] ?? 0) + a.value;
    else result.costless += a.value;
  }
  return result;
}

export function canPayArtCost(
  s: GameState,
  stack: HolomenStack,
  cost: Color[],
  artDesc?: string,
): boolean {
  return artCostCheck(s, stack, cost, artDesc).ok;
}

/** 実際の軽減・色変換・エール扱いを反映した不足枚数。盤面を変更しない。 */
export function artCostCheck(
  s: GameState,
  stack: HolomenStack,
  cost: Color[],
  artDesc?: string,
): { ok: boolean; reason?: string; missing?: Color[] } {
  // 「アーツは、エールを必要とせずに使える」ターン修正
  if (s.turnModifiers.some((m) => m.stackId === stack.id && m.artsFree))
    return { ok: true };
  // エール1枚が払える色の集合。複数の色として扱われるエールでも、
  // 1枚で払えるコストは1つだけなので色ごとに分解せず枚数単位で持つ
  const yellPools: Color[][] = stack.yells.map((u) =>
    yellColorsOn(s, stack, u),
  );
  const costEntry = findStackById(s, stack.id);
  if (costEntry) {
    const oshi = cardOf(s, s.players[costEntry.player].oshiUid) as OshiCard;
    if (
      oshi.stageOshiSkill?.name === "WORLD DOMINATION" &&
      stackNames(s, stack).includes("一伊那尓栖")
    ) {
      const opp = s.players[other(costEntry.player)];
      const oppOshi = cardOf(s, opp.oshiUid) as OshiCard;
      const oppStacks = allStacks(opp);
      // 無色は色に含まれないため、Spotホロメンは「異なる色を持つ」に数えない
      // (公式Q389/Q403。hasDiffColorFromOwnerOshi と同じ判定)
      if (
        oppStacks.length > 0 &&
        oppStacks.every(({ stack: st }) =>
          stackRealColors(s, st).some((c) => c !== oppOshi.color),
        )
      )
        return { ok: true };
    }
  }
  let colored = cost.filter((c) => c !== "無");
  // 色コストの軽減は必要総数からも取り除く
  let totalCost = cost.length;
  const removeColored = (color: string, n: number) => {
    let remove = n;
    colored = colored.filter((c) => {
      if (remove > 0 && c === color) {
        remove--;
        totalCost--;
        return false;
      }
      return true;
    });
  };
  if (costEntry) {
    const oshi = cardOf(s, s.players[costEntry.player].oshiUid) as OshiCard;
    if (
      oshi.stageOshiSkill?.name === "秩序を守る署長" &&
      stackNames(s, stack).includes("大空スバル")
    )
      removeColored("白", 1);
  }
  // 「アーツに必要な無色-X」修正を適用
  let costless = 0;
  for (const m of s.turnModifiers)
    if (m.stackId === stack.id) {
      costless += m.artCostless ?? 0;
      // 「アーツに必要な(色)-X」修正: 該当色の必要枚数を減らす
      if (m.artColorCostless)
        removeColored(m.artColorCostless.color, m.artColorCostless.n);
    }
  // アーツ自身のコスト軽減文 (条件付き/比例) を適用
  const selfMod = artSelfCostless(s, stack, artDesc);
  costless += selfMod.costless;
  for (const [color, n] of Object.entries(selfMod.colorless))
    removeColored(color, n);
  for (const uid of stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    if (b.artCostless) {
      if (!b.artCostless.requiresCond || passiveCondMatches(s, stack, b.cond))
        costless += b.artCostless.value;
    }
    // 「このカードをXエールとしても扱う」
    if (b.asYell) {
      let ok = !b.asYell.requiresCond || passiveCondMatches(s, stack, b.cond);
      // 「自分の推しホロメンが〈X〉なら」条件
      if (ok && b.asYell.oshiNames) {
        const entry = findStackById(s, stack.id);
        ok =
          !!entry &&
          b.asYell.oshiNames.includes(
            cardOf(s, s.players[entry.player].oshiUid).name,
          );
      }
      if (ok) yellPools.push([b.asYell.color]);
    }
    // 「アーツに必要なエールの色すべてを無色にする」= 色指定を撤廃
    if (b.allColorless) {
      if (!b.allColorless.requiresCond || passiveCondMatches(s, stack, b.cond))
        colored = [];
    }
  }
  // ギフトの自身アーツコスト軽減 (「このホロメンのアーツに必要な{色/無色}-X」)
  {
    const gift = giftOf(topCard(s, stack));
    if (gift.selfArtCostMods && gift.selfArtCostMods.length > 0) {
      const gEntry = findStackById(s, stack.id);
      for (const cm of gift.selfArtCostMods) {
        if (
          cm.positions &&
          (!gEntry ||
            typeof gEntry.pos !== "string" ||
            !cm.positions.includes(gEntry.pos as "center" | "collab"))
        )
          continue;
        if (
          cm.cond &&
          !evalCond(
            s,
            {
              player: gEntry?.player ?? s.turnPlayer,
              sourceStackId: stack.id,
              rest: [],
              label: "",
            },
            cm.cond,
          )
        )
          continue;
        if (cm.color) removeColored(cm.color, cm.delta);
        else costless += cm.delta;
      }
    }
    if (gift.artCostlessPerAttachedName) {
      const count = stack.supports.filter((u) =>
        cardHasName(s, u, gift.artCostlessPerAttachedName!.names),
      ).length;
      costless += gift.artCostlessPerAttachedName.value * count;
    }
  }
  // 味方ギフトによるアーツコスト軽減オーラ (「自分の〈X〉が付いている(F)ホロメンの〈Y〉のアーツに必要な(色)-Z」)
  {
    const gEntry = findStackById(s, stack.id);
    if (gEntry) {
      const owner = s.players[gEntry.player];
      for (const { pos: hPos, stack: holder } of allStacks(owner)) {
        for (const aura of giftOf(topCard(s, holder)).colorlessAuras ?? [])
          if (
            giftPositionOk(hPos, aura.positions) &&
            gEntry.pos === aura.targetPos &&
            stackMatchesFilter(s, stack, aura.filter)
          )
            colored = [];
        const auras = giftOf(topCard(s, holder)).artCostAuras;
        if (!auras) continue;
        for (const ca of auras) {
          if (!giftPositionOk(hPos, ca.positions)) continue;
          if (ca.targetPos && gEntry.pos !== ca.targetPos) continue;
          if (ca.filter && !stackMatchesFilter(s, stack, ca.filter)) continue;
          if (
            ca.cond &&
            !evalCond(
              s,
              {
                player: gEntry.player,
                sourceStackId: holder.id,
                rest: [],
                label: "",
              },
              ca.cond,
            )
          )
            continue;
          if (ca.color) removeColored(ca.color, ca.delta);
          else costless += ca.delta;
        }
      }
    }
  }
  // 相手ギフトによる「相手のセンターホロメンのアーツに必要な無色+X」妨害オーラ
  // (このホロメンが自分のセンターで、相手側にオーラ保持者がいる時。costlessを減らす=必要増)
  {
    const gEntry = findStackById(s, stack.id);
    if (gEntry && gEntry.pos === "center") {
      const foe = s.players[other(gEntry.player)];
      for (const { pos: hPos, stack: holder } of allStacks(foe)) {
        const dbf = giftOf(topCard(s, holder)).oppCenterArtCostPlus;
        if (!dbf) continue;
        if (!giftPositionOk(hPos, dbf.positions)) continue;
        if (
          dbf.cond &&
          !evalCond(
            s,
            {
              player: other(gEntry.player),
              sourceStackId: holder.id,
              rest: [],
              label: "",
            },
            dbf.cond,
          )
        )
          continue;
        costless -= dbf.delta;
      }
    }
  }
  const anyCount = Math.max(0, totalCost - colored.length - costless);
  // 色コストへのエール割り当て (1枚は1つのコストにしか使えない)。
  // 複数の色として扱われるエールがあるので、単純な先頭一致では取り違える
  const used = new Array(yellPools.length).fill(false);
  const assign = (i: number): boolean => {
    if (i === colored.length) return true;
    for (let j = 0; j < yellPools.length; j++) {
      if (used[j] || !yellPools[j].includes(colored[i])) continue;
      used[j] = true;
      if (assign(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  if (assign(0) && yellPools.length - colored.length >= anyCount)
    return { ok: true };

  // 最大マッチングで、複数色のエール1枚を重複して数えず不足を求める。
  const owners = new Array<number>(yellPools.length).fill(-1);
  const match = (i: number, seen: Set<number>): boolean => {
    for (let j = 0; j < yellPools.length; j++) {
      if (seen.has(j) || !yellPools[j].includes(colored[i])) continue;
      seen.add(j);
      if (owners[j] === -1 || match(owners[j], seen)) {
        owners[j] = i;
        return true;
      }
    }
    return false;
  };
  const missing: Color[] = [];
  for (let i = 0; i < colored.length; i++)
    if (!match(i, new Set())) missing.push(colored[i]);
  const matched = colored.length - missing.length;
  missing.push(
    ...new Array<Color>(
      Math.max(0, anyCount - (yellPools.length - matched)),
    ).fill("無"),
  );
  const counts = new Map<Color, number>();
  for (const color of missing) counts.set(color, (counts.get(color) ?? 0) + 1);
  return {
    ok: false,
    missing,
    reason: `エールが${missing.length}枚不足しています（${[...counts].map(([color, n]) => `${color === "無" ? "色指定なし" : color}${n}枚`).join("、")}）`,
  };
}

/**
 * 任意コスト (「〜できる：効果」) を支払えるか。
 * 支払えないコストで確認プロンプトを出すと、プレイヤーが「はい」を選んでも
 * コスト不足で不発になるだけの選択肢を見せてしまう。
 */
/** archiveHand の対象になる手札 (タグ/ホロメン/サポート限定を適用) */
export function archiveHandEligible(
  s: GameState,
  pid: PlayerId,
  op: Extract<Op, { t: "archiveHand" }>,
): string[] {
  return s.players[pid].hand.filter((uid) => {
    const card = cardOf(s, uid);
    if (op.holomenOnly && card.cardType !== "holomen") return false;
    if (op.supportOnly && card.cardType !== "support") return false;
    if (op.limited && (card.cardType !== "support" || !card.limited))
      return false;
    if (op.tag && (!("tags" in card) || !card.tags.includes(op.tag)))
      return false;
    return true;
  });
}

/** archiveHand の「同じタグをn枚」条件を満たせるか */
export function sameTagPayable(
  s: GameState,
  eligible: readonly string[],
  n: number,
): boolean {
  const tagCount = new Map<string, number>();
  for (const uid of eligible) {
    const card = cardOf(s, uid);
    if ("tags" in card)
      for (const tag of card.tags)
        tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  return [...tagCount.values()].some((count) => count >= n);
}

export function archiveStageYellCandidates(
  s: GameState,
  pid: PlayerId,
  op: Extract<Op, { t: "archiveStageYell" }>,
): string[] {
  return allStacks(s.players[pid])
    .filter(
      ({ pos, stack }) =>
        (!op.pos || (op.pos === "back" && typeof pos !== "string")) &&
        (!op.stackFilter || stackMatchesFilter(s, stack, op.stackFilter)),
    )
    .flatMap(({ stack }) => stack.yells.map((uid) => ({ stack, uid })))
    .filter(
      ({ stack, uid }) =>
        !op.yellColor || yellOnIs(s, stack, uid, op.yellColor),
    )
    .map(({ uid }) => uid);
}

export function archiveHandHoloReplacement(
  s: GameState,
  ctx: EffectContextData,
  op: Extract<Op, { t: "archiveHand" }>,
): { skillName: string; maxHolo: number } | null {
  // 10.13.2・5.19.1: 付属サポート自身の能力を、付け先ホロメンの能力と混同しない。
  if (
    op.replacementChecked ||
    ctx.originOshiSkill ||
    isSupportAbilitySource(s, ctx)
  )
    return null;
  const p = s.players[ctx.player];
  if (p.holoPower.length === 0) return null;
  const source = ctx.sourceStackId ? findStackById(s, ctx.sourceStackId) : null;
  if (
    !source ||
    source.player !== ctx.player ||
    !stackColors(s, source.stack).includes("赤")
  )
    return null;
  const oshi = cardOf(s, p.oshiUid);
  const skill = oshi.cardType === "oshi" ? oshi.oshiSkill : undefined;
  const reactive = skill ? parseOshiReactive(skill.description) : null;
  const adj = skill
    ? oshiSkillAdjustments(s, ctx.player, skill.name)
    : { costDelta: 0, usesBonus: 0 };
  if (
    !skill ||
    reactive?.when !== "handArchiveByRedAbility" ||
    oshiSkillUseCount(s, ctx.player) >= 1 + adj.usesBonus
  )
    return null;
  return {
    skillName: skill.name,
    // Q35: 元の手札アーカイブ枚数を超えても、置かれている
    // ホロパワーすべてまでXとして選べる。
    maxHolo: p.holoPower.length,
  };
}

export function archiveHandMinHoloForReplacement(
  s: GameState,
  ctx: EffectContextData,
  op: Extract<Op, { t: "archiveHand" }>,
  eligible: string[],
  maxHolo: number,
): number | null {
  for (let holo = 1; holo <= maxHolo; holo++) {
    const hand = Math.max(0, op.n - holo);
    if (eligible.length < hand) continue;
    if (op.sameTag && hand > 1 && !sameTagPayable(s, eligible, hand)) continue;
    return holo;
  }
  return null;
}

export function stackedCostCandidates(
  s: GameState,
  ctx: EffectContextData,
  op: Extract<Op, { t: "archiveStacked" }>,
): { stack: HolomenStack; uid: string }[] {
  const source = ctx.sourceStackId
    ? findStackById(s, ctx.sourceStackId)
    : undefined;
  const holders = op.holderNames
    ? allStacks(s.players[ctx.player]).filter(({ stack }) =>
        stackMatchesFilter(s, stack, { names: op.holderNames }),
      )
    : source
      ? [source]
      : [];
  return holders.flatMap(({ stack }) =>
    stack.cards
      .slice(1)
      .filter(
        (uid) =>
          !op.level || (cardOf(s, uid) as HolomenCard).bloomLevel === op.level,
      )
      .map((uid) => ({ stack, uid })),
  );
}

/** コストとして現れるOpの満額支払い可否。コストでなければ undefined。 */
function costOpPayable(
  s: GameState,
  ctx: EffectContextData,
  op: Op,
): boolean | undefined {
  const p = s.players[ctx.player];
  const source = ctx.sourceStackId
    ? findStackById(s, ctx.sourceStackId)
    : undefined;
  switch (op.t) {
    case "millDeck":
      return p.deck.length >= op.n;
    case "millCheer":
      return p.cheerDeck.length >= op.n;
    case "revealTop":
      return (
        p.deck.length >=
        (op.nFrom === "stageYell" ? stageYellCount(s, ctx.player) : op.n)
      );
    case "revealHoloTop":
      return p.holoPower.length >= op.n;
    case "archiveHand": {
      const eligible = archiveHandEligible(s, ctx.player, op);
      const directlyPayable =
        eligible.length >= op.n &&
        (!op.sameTag || sameTagPayable(s, eligible, op.n));
      if (directlyPayable) return true;
      const replacement = archiveHandHoloReplacement(s, ctx, op);
      return !!(
        replacement &&
        archiveHandMinHoloForReplacement(
          s,
          ctx,
          op,
          eligible,
          replacement.maxHolo,
        ) !== null
      );
    }
    case "archiveHandAll":
      return true;
    case "archiveStageYell": {
      const candidates = archiveStageYellCandidates(s, ctx.player, op);
      if (candidates.length >= op.n) return true;
      // 総合ルール10.11.4: エールが足りなくても、肩代わりできる付与サポートが
      // 発生源に付いていればコストを支払える
      const holder = ctx.sourceStackId
        ? findStackById(s, ctx.sourceStackId)
        : null;
      if (!holder) return false;
      const subs = yellArchiveSubUids(s, holder.stack, (color) =>
        op.yellColor ? op.yellColor === color : true,
      ).length;
      return candidates.length + subs >= op.n;
    }
    case "stageYellToCheerBottom":
      return (
        allStacks(p).reduce((n, { stack }) => n + stack.yells.length, 0) >= op.n
      );
    case "archiveSelfYell":
      return !!source && archiveSelfYellPayable(s, source.stack, op);
    case "archiveSelfYellAny":
      return !!source && source.stack.yells.length >= (op.min ?? 1);
    case "archiveStacked":
      return stackedCostCandidates(s, ctx, op).length >= (op.all ? 1 : op.n);
    case "archiveAttached":
      return (
        !!source &&
        source.stack.supports.filter((uid) => {
          const card = cardOf(s, uid);
          return (
            card.cardType === "support" &&
            (!op.kind || card.supportType === op.kind)
          );
        }).length >= op.n
      );
    case "archiveStageSupports":
      return (
        allStacks(p).flatMap(({ stack }) =>
          stack.supports.filter((uid) =>
            op.filter
              ? cardMatchesFilter(s, ctx.player, uid, op.filter)
              : cardHasName(s, uid, op.names),
          ),
        ).length >= op.n
      );
    case "stageSupportToDeckBottom":
      return (
        allStacks(p).flatMap(({ stack }) =>
          stack.supports.filter((uid) => cardHasName(s, uid, op.names)),
        ).length >= op.n
      );
    case "archiveHoloPower":
      return p.holoPower.length >= op.n;
    case "archiveHoloPowerAny":
      return p.holoPower.length >= op.min;
    case "handToDeckBottomNamed":
      return (
        p.hand.filter((uid) => cardHasName(s, uid, op.names)).length >= op.n
      );
    case "handToDeckBottom":
      return (
        p.hand.filter(
          (uid) =>
            !op.filter || cardMatchesFilter(s, ctx.player, uid, op.filter),
        ).length >= op.n
      );
    case "handRevealToDeckBottom":
      return (
        p.hand.filter((uid) => cardMatchesFilter(s, ctx.player, uid, op.filter))
          .length >= op.n
      );
    case "rest":
      return (
        targetCandidates(s, ctx, op.target, op.filter).filter(
          ({ stack }) => !stack.resting,
        ).length >= (op.count ?? 1)
      );
    case "backToDeckBottom":
      return (
        p.back.filter(
          (stack) => !op.filter || stackMatchesFilter(s, stack, op.filter),
        ).length >= op.n
      );
    case "moveArchive":
      return (
        p.archive.filter((uid) =>
          cardMatchesFilter(s, ctx.player, uid, op.filter),
        ).length >= op.min
      );
    case "heal":
      return (
        targetCandidates(s, ctx, op.target, op.filter).filter(
          ({ stack }) => stack.damage > 0,
        ).length >= (op.count ?? 1)
      );
    case "selfSupportToDeckTop":
      return (
        !!source &&
        !!ctx.sourceSupportUid &&
        source.stack.supports.includes(ctx.sourceSupportUid)
      );
    case "restSelf":
      return !!source && !source.stack.resting;
    case "moveYell": {
      const yellOwner = op.side === "opp" ? other(ctx.player) : ctx.player;
      const sourceStacks = op.fromSelf
        ? source
          ? [source.stack]
          : []
        : allStacks(s.players[yellOwner])
            .map(({ stack }) => stack)
            .filter(
              (stack) =>
                !op.sourceFilter ||
                stackMatchesFilter(s, stack, op.sourceFilter),
            );
      const yells = sourceStacks
        .flatMap((stack) => stack.yells.map((uid) => ({ stack, uid })))
        .filter(
          ({ stack, uid }) => !op.color || yellOnIs(s, stack, uid, op.color),
        )
        .filter(
          ({ stack, uid }) =>
            !op.colors || op.colors.some((c) => yellOnIs(s, stack, uid, c)),
        )
        .map(({ uid }) => uid);
      if (yells.length < op.min) return false;
      const targets = yells[0]
        ? cheerAssignCandidates(s, {
            type: "cheerAssign",
            player: ctx.player,
            yellUid: yells[0],
            reason: "effect",
            filter: op.targetFilter,
            targetPlayer: op.side === "opp" ? other(ctx.player) : undefined,
            perTargetMax: op.perTargetMax,
            sameTarget: op.sameTarget,
            ctx,
          })
        : [];
      const capacity =
        targets.length === 0
          ? 0
          : op.sameTarget
            ? (op.perTargetMax ?? Number.POSITIVE_INFINITY)
            : op.perTargetMax === undefined
              ? Number.POSITIVE_INFINITY
              : targets.length * op.perTargetMax;
      return capacity >= op.min;
    }
    default:
      return undefined;
  }
}

export function canPayOptionalCost(
  s: GameState,
  ctx: EffectContextData,
  cost: Op[],
): boolean {
  return cost.every((op) => costOpPayable(s, ctx, op) ?? true);
}
