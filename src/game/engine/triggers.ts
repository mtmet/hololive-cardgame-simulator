// ゲーム状態とルールの処理：triggers。
import { cardNames } from "../../data/loader";
import type { OshiCard, HolomenCard } from "../../data/types";
import {
  parseEffect,
  parseBloomEffectUseLimit,
  parseOshiReactive,
  parseOshiStageCollab,
} from "../effects";
import type { TriggerAbility, Op, TriggerDef, OshiReactive } from "../effects";
import type {
  GameState,
  PlayerId,
  HolomenStack,
  StagePosition,
} from "../types";
import {
  stackNames,
  giftOf,
  stackMatchesFilter,
  triggerFires,
  attachedTriggerUseKey,
  matchesPosition,
  bloomRank,
  triggerDefOps,
  passiveOf,
  passiveCondMatches,
  oshiSkillAdjustments,
  oshiSkillUseCount,
  evalCond,
} from "./conditions";
import { logEffect, log } from "./logging";
import { engineObserver } from "./runtime";
import {
  allStacks,
  cardOf,
  topCard,
  positionedHolomenName,
  findStackById,
} from "./state";
import type { UsableOshiReactive } from "./types";

export function collectStepTriggerAbilities(
  s: GameState,
  pid: PlayerId,
  event: import("../effects").TriggerEvent,
): TriggerAbility[] {
  const abilities: TriggerAbility[] = [];
  for (const entry of allStacks(s.players[pid]))
    abilities.push(
      ...collectTriggerAbilities(s, { player: pid, ...entry }, [event]),
    );
  return abilities;
}

export function collectSelfEndStepStartAbilities(
  s: GameState,
  pid: PlayerId,
): TriggerAbility[] {
  const abilities = collectStepTriggerAbilities(s, pid, "selfEndStepStart");
  const p = s.players[pid];
  const endOshi = cardOf(s, p.oshiUid) as OshiCard;
  if (
    endOshi.stageOshiSkill?.name === "浜辺のヴィーナス" &&
    p.center &&
    p.collab &&
    stackNames(s, p.center).includes("ときのそら") &&
    stackNames(s, p.collab).includes("ときのそら")
  ) {
    abilities.push({
      id: `endOshi:${pid}:浜辺のヴィーナス:${s.turn}`,
      label: "推しステージスキル「浜辺のヴィーナス」",
      sourceStackId: p.center.id,
      ops: [
        { t: "holoPowerFromDeck", n: 1 },
        {
          t: "if",
          cond: { c: "stageHas", filter: { bloomLevel: "2nd" } },
          then: [{ t: "draw", n: 1 }],
        },
      ],
    });
  }
  if (
    endOshi.stageOshiSkill?.name === "もう金曜だねルイ姉" &&
    p.collab &&
    p.center &&
    stackNames(s, p.center).includes("鷹嶺ルイ")
  ) {
    abilities.push({
      id: `endOshi:${pid}:${s.turn}`,
      label: "推しステージスキル「もう金曜だねルイ姉」",
      sourceStackId: p.center.id,
      ops: [{ t: "drawUntil", n: 4 }],
    });
  }

  const delayed = s.turnModifiers.filter(
    (m) => m.stackId === -1 - pid && m.archiveStageYellAtEnd !== undefined,
  );
  s.turnModifiers = s.turnModifiers.filter(
    (m) => !(m.stackId === -1 - pid && m.archiveStageYellAtEnd !== undefined),
  );
  delayed.forEach((m, i) =>
    abilities.push({
      id: `endDelayed:${pid}:${s.turn}:${i}`,
      label: "エンドステップ開始時の遅延効果",
      ops: [{ t: "archiveStageYell", n: m.archiveStageYellAtEnd! }],
    }),
  );

  const ur = usableOshiReactive(s, pid, "selfEndStepStart", null);
  if (ur && ur.reactive.when === "selfEndStepStart") {
    abilities.push({
      id: `endReactive:${pid}:${ur.skill.name}:${s.turn}`,
      label: `${ur.sp ? "SP" : ""}推しスキル「${ur.skill.name}」`,
      ops: [
        {
          t: "offerReactiveSkill",
          sp: ur.sp,
          skillName: ur.skill.name,
          description: ur.skill.description,
          cost: ur.cost,
          ops: ur.reactive.ops,
        },
      ],
    });
  }
  return abilities;
}

/** 「自分のホロメンがステージに出た時」ギフトトリガーの発火 */
export function collectAllyPlayedOps(
  s: GameState,
  pid: PlayerId,
  played: HolomenStack,
): Op[] {
  if (s.phase !== "playing") return [];
  const p = s.players[pid];
  const abilities: TriggerAbility[] = [];
  for (const e of allStacks(p)) {
    const g = giftOf(topCard(s, e.stack));
    const key = `giftPlay:${e.stack.cards[0]}`;
    for (const def of g.triggers) {
      if (def.event !== "allyPlayed") continue;
      if (
        def.subjectFilter &&
        !stackMatchesFilter(s, played, def.subjectFilter)
      )
        continue;
      if (!triggerFires(s, pid, e.pos, def, key)) continue;
      logEffect(
        s,
        pid,
        `▶ ギフト「${topCard(s, e.stack).gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})が発動します`,
        `ギフト「${topCard(s, e.stack).gift?.name ?? ""}」`,
        { sourceStackId: e.stack.id },
      );
      abilities.push({
        id: `${key}:${abilities.length}`,
        label: `ギフト「${topCard(s, e.stack).gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})`,
        sourceStackId: e.stack.id,
        ops: structuredClone(def.ops) as Op[],
      });
    }
  }
  // 登場させた能力を完了してから、他の待機能力と解決順を選ぶ。
  return abilities.length
    ? [{ t: "runTriggerAbilities", player: pid, abilities, defer: true }]
    : [];
}

/** 「自分が(SP)推しスキルを使った時」の待機能力を収集する。 */
export function collectOshiSkillUsedAbilities(
  s: GameState,
  pid: PlayerId,
  sp: boolean,
  skillName: string,
): TriggerAbility[] {
  if (s.phase !== "playing") return [];
  const event: import("../effects").TriggerEvent = sp
    ? "spSkillUsed"
    : "oshiSkillUsed";
  const p = s.players[pid];
  const abilities: TriggerAbility[] = [];
  for (const e of allStacks(p)) {
    const g = giftOf(topCard(s, e.stack));
    const key = `giftOshiSkill:${e.stack.cards[0]}`;
    for (const def of g.triggers) {
      // 12.1.2: SPは推しスキルの一種。SP限定の誘発とは区別しつつ、
      // 「推しスキルを使った時」には通常・SPの両方を含める。
      if (def.event !== event && !(sp && def.event === "oshiSkillUsed"))
        continue;
      if (def.skillName && def.skillName !== skillName) continue;
      if (!triggerFires(s, pid, e.pos, def, key)) continue;
      logEffect(
        s,
        pid,
        `▶ ギフト「${topCard(s, e.stack).gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})が発動します`,
        `ギフト「${topCard(s, e.stack).gift?.name ?? ""}」`,
        { sourceStackId: e.stack.id },
      );
      abilities.push({
        id: `${key}:${abilities.length}`,
        label: `ギフト「${topCard(s, e.stack).gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})`,
        sourceStackId: e.stack.id,
        ops: [
          { t: "setSource", stackId: e.stack.id },
          ...(structuredClone(def.ops) as Op[]),
        ],
      });
    }
  }
  return abilities;
}

/** 「自分のエールがアーカイブに置かれた時」の誘発能力を収集する */
export function collectYellArchivedTriggerAbilities(
  s: GameState,
  pid: PlayerId,
): TriggerAbility[] {
  if (s.phase !== "playing") return [];
  return collectStepTriggerAbilities(s, pid, "yellArchived");
}

export function collectYellArchivedTriggerOps(
  s: GameState,
  pid: PlayerId,
): Op[] {
  const abilities = collectYellArchivedTriggerAbilities(s, pid);
  return abilities.length > 0
    ? [
        {
          t: "runTriggerAbilities",
          player: pid,
          abilities,
          label: "エールアーカイブ時能力",
          defer: true,
        },
      ]
    : [];
}

export function collectOshiStageTriggerAbilities(
  s: GameState,
  pid: PlayerId,
  event: "artUsed" | "returnedToDeck",
  subject: HolomenStack,
): TriggerAbility[] {
  const oshi = cardOf(s, s.players[pid].oshiUid);
  if (oshi.cardType !== "oshi" || !oshi.stageOshiSkill) return [];
  const skill = oshi.stageOshiSkill;
  let ops: Op[] | null = null;
  if (
    event === "artUsed" &&
    skill.name === "ドドドライブ" &&
    stackNames(s, subject).includes("角巻わため")
  ) {
    ops = [{ t: "holoPowerFromDeck", n: 1 }];
  } else if (
    event === "returnedToDeck" &&
    skill.name === "はあちゃまなう" &&
    s.turnPlayer === pid &&
    stackNames(s, subject).includes("赤井はあと")
  ) {
    const key = `stageOshi:${pid}:${skill.name}`;
    if ((s.usedTriggersThisTurn[key] ?? 0) >= 1) return [];
    s.usedTriggersThisTurn[key] = 1;
    ops = [{ t: "draw", n: 2 }];
  }
  if (!ops) return [];
  const label = `推しステージスキル「${skill.name}」`;
  logEffect(s, pid, `▶ ${label}が発動します`, label, {
    sourceOshi: true,
  });
  engineObserver?.trigger?.(event);
  return [{ id: `stageOshi:${event}:${subject.id}`, label, ops }];
}

/** バトンタッチ・サポート使用・装着で発揮する推しステージスキルを収集する。 */
export function collectOshiStageActionAbilities(
  s: GameState,
  pid: PlayerId,
  event: "batonTouched" | "supportUsed" | "supportAttached",
  subject?: HolomenStack,
  supportUid?: string,
): TriggerAbility[] {
  const c = cardOf(s, s.players[pid].oshiUid) as OshiCard,
    skill = c.stageOshiSkill;
  if (!skill || s.turnPlayer !== pid) return [];
  const support = supportUid ? cardOf(s, supportUid) : null;
  let ops: Op[] | null = null;
  if (
    event === "batonTouched" &&
    skill.name === "目指せ、宇宙一の番長！" &&
    subject &&
    stackNames(s, subject).includes("轟はじめ")
  )
    ops = [{ t: "holoPowerFromDeck", n: 1 }];
  if (
    event === "supportUsed" &&
    skill.name === "鉄の胃袋大魔神" &&
    support &&
    cardNames(support).includes("牛丼")
  )
    ops = [
      {
        t: "cheerFromTop",
        n: 1,
        target: "chooseOwn",
        filter: { names: ["白銀ノエル"] },
      },
      {
        t: "if",
        cond: { c: "stageHas", filter: { bloomLevel: "2nd" } },
        then: [{ t: "draw", n: 1 }],
      },
    ];
  if (
    event === "supportAttached" &&
    skill.name === "TO THE FORGE NOW" &&
    subject &&
    stackNames(s, subject).includes("カエラ・コヴァルスキア") &&
    support?.cardType === "support" &&
    support.supportType === "ツール" &&
    support.tags.includes("カエラ'sアームズ")
  )
    ops = [{ t: "draw", n: 2 }];
  if (!ops) return [];
  const key = `stageOshi:${pid}:${skill.name}`;
  if ((s.usedTriggersThisTurn[key] ?? 0) >= 1) return [];
  s.usedTriggersThisTurn[key] = 1;
  return [{ id: key, label: `推しステージスキル「${skill.name}」`, ops }];
}

/** 「自分の(subjectFilter)がステージからデッキに戻った時」の同時誘発能力を収集する。
 * returned は既に盤面から外れたスタック (subjectFilter 判定用に渡す) */
export function collectReturnedToDeckAbilities(
  s: GameState,
  pid: PlayerId,
  returned: HolomenStack,
): TriggerAbility[] {
  if (s.phase !== "playing") return [];
  const abilities = collectOshiStageTriggerAbilities(
    s,
    pid,
    "returnedToDeck",
    returned,
  );
  for (const e of allStacks(s.players[pid])) {
    if (e.stack.id === returned.id) continue;
    const top = topCard(s, e.stack);
    const g = giftOf(top);
    const key = `giftReturnedToDeck:${e.stack.cards[0]}`;
    let index = 0;
    for (const def of g.triggers) {
      if (def.event !== "returnedToDeck") continue;
      if (
        def.subjectFilter &&
        !stackMatchesFilter(s, returned, def.subjectFilter)
      )
        continue;
      if (!triggerFires(s, pid, e.pos, def, key)) continue;
      const label = `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})`;
      logEffect(s, pid, `▶ ${label}が発動します`, label, {
        sourceStackId: e.stack.id,
      });
      abilities.push({
        id: `returnedToDeck:${returned.id}:${e.stack.id}:${index++}`,
        label,
        sourceStackId: e.stack.id,
        ops: [
          { t: "setSource", stackId: e.stack.id },
          ...(structuredClone(def.ops) as Op[]),
        ],
      });
    }
  }
  return abilities;
}

export function collectBloomTriggerAbilities(
  s: GameState,
  pid: PlayerId,
  st: HolomenStack,
  nc: HolomenCard,
  prevLevel: HolomenCard["bloomLevel"],
  prevBuzz: boolean,
  originOshiSkill?: { name: string; sp: boolean },
): TriggerAbility[] {
  const abilities: TriggerAbility[] = [];
  if (nc.bloomEffect?.description) {
    const label = `ブルームエフェクト「${nc.bloomEffect.name ?? ""}」`;
    const program = parseEffect(nc.bloomEffect.description);
    if (program) {
      // Bloom元やSP推しスキルの指定は能力そのものの発揮条件。
      // 条件不成立なら、効果を実行しないだけでなく発動表示もしない。
      const firstOp = program.ops[0];
      const bloomConditionFailed =
        firstOp?.t === "if" &&
        ((firstOp.cond.c === "bloomedFromDebut" && prevLevel !== "Debut") ||
          (firstOp.cond.c === "bloomedFromBuzz" && !prevBuzz) ||
          (firstOp.cond.c === "selfBloomedBySpOshiSkill" &&
            !(
              originOshiSkill?.sp && originOshiSkill.name === firstOp.cond.name
            )));
      if (!bloomConditionFailed) {
        // 「[センターポジション限定]」等はBloomした位置で発動可否が決まる
        const bloomPos = findStackById(s, st.id)?.pos;
        const posOk =
          !program.positions ||
          bloomPos === undefined ||
          program.positions.some((p) => matchesPosition(bloomPos, p));
        // 「自分のブルームエフェクト「X」はターンにN回しか使えない」は、
        // スタックごとではなくプレイヤーごと・効果名ごとに数える
        // (同名のホロメンを同じターンに2体Bloomしても1回だけ)
        const useLimit = parseBloomEffectUseLimit(nc.bloomEffect.description);
        const limitKey = useLimit
          ? `bloomEffect:${pid}:${useLimit.name}`
          : undefined;
        const limitReached =
          useLimit !== null &&
          (s.usedTriggersThisTurn[limitKey!] ?? 0) >= useLimit.n;
        if (!posOk) {
          log(s, pid, `${label}: ポジション条件を満たさないため発揮されません`);
        } else if (limitReached) {
          log(
            s,
            pid,
            `${label}: このターンは既に使用しているため発揮されません`,
          );
        } else if (program.ops.length > 0) {
          const effectOps = structuredClone(program.ops) as Op[];
          if (limitKey) {
            const mark: Op = { t: "markTriggerUsed", key: limitKey };
            const optionalCost = effectOps[0];
            // 任意コスト型は「使う」を選び、コストを実際に支払った後で消費する。
            // 辞退時は同名Bloom効果を同じターンに改めて使える。
            if (optionalCost?.t === "optionalCost") {
              optionalCost.then.unshift(mark);
            } else {
              // 任意コストでない能力は同時収集時の後続同名能力も抑止する。
              s.usedTriggersThisTurn[limitKey] =
                (s.usedTriggersThisTurn[limitKey] ?? 0) + 1;
            }
          }
          logEffect(
            s,
            pid,
            `▶ ${label}: ${nc.bloomEffect.description}`,
            label,
            {
              sourceStackId: st.id,
            },
          );
          abilities.push({
            id: `bloomEffect:${st.id}:${nc.id}`,
            label,
            sourceStackId: st.id,
            ops: [{ t: "setSource", stackId: st.id }, ...effectOps],
          });
        }
      }
    } else {
      log(
        s,
        pid,
        `⚠ ${label}「${nc.bloomEffect.description}」は自動処理未対応のため発揮されません`,
      );
    }
  }
  // Q113/Q140: 同レベルへのBloomも「Bloomした時」には含むが、
  // 「Bloomレベルが上がった時」の条件には含めない。
  abilities.push(
    ...collectTriggerAbilities(
      s,
      {
        player: pid,
        pos: findStackById(s, st.id)?.pos ?? "center",
        stack: st,
      },
      bloomRank(nc.bloomLevel) > bloomRank(prevLevel)
        ? ["bloomed", "bloomLevelUp"]
        : ["bloomed"],
    ),
  );
  return abilities.map((ability) => ({
    ...ability,
    // Bloomの誘発条件だけを引き継ぐ。Bloomさせた能力の選択先や
    // 支払ったカードは、ブルームエフェクト自身の解決結果ではない。
    eventContext: {
      player: pid,
      label: ability.label,
      bloomedFromDebut: prevLevel === "Debut",
      bloomedFromBuzz: prevBuzz,
      bloomedByOshiSkill: originOshiSkill
        ? { ...originOshiSkill, stackId: st.id }
        : undefined,
    },
  }));
}

/** 「自分のホロメンがコラボした時」ギフトトリガーを収集する (主語が味方) */
export function collectAllyCollabedAbilities(
  s: GameState,
  pid: PlayerId,
  collabed: HolomenStack,
): TriggerAbility[] {
  if (s.phase !== "playing") return [];
  const abilities: TriggerAbility[] = [];
  const oshi = cardOf(s, s.players[pid].oshiUid) as OshiCard;
  const stageSkill = oshi.stageOshiSkill;
  const stageOps = stageSkill
    ? parseOshiStageCollab(stageSkill.description)
    : null;
  if (stageOps?.length) {
    const label = `推しステージスキル「${stageSkill!.name}」`;
    logEffect(s, pid, `▶ ${label}が発動します`, label, { sourceOshi: true });
    abilities.push({
      id: `stageOshi:collab:${collabed.id}`,
      label,
      ops: stageOps,
    });
  }
  for (const e of allStacks(s.players[pid])) {
    if (e.stack.id === collabed.id) continue;
    const top = topCard(s, e.stack);
    const g = giftOf(top);
    const key = `giftCollab:${e.stack.cards[0]}`;
    let index = 0;
    for (const def of g.triggers) {
      if (def.event !== "allyCollabed") continue;
      if (
        def.subjectFilter &&
        !stackMatchesFilter(s, collabed, def.subjectFilter)
      )
        continue;
      if (!triggerFires(s, pid, e.pos, def, key)) continue;
      const label = `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})`;
      logEffect(s, pid, `▶ ${label}が発動します`, label, {
        sourceStackId: e.stack.id,
      });
      abilities.push({
        id: `allyCollabed:${collabed.id}:${e.stack.id}:${index++}`,
        label,
        sourceStackId: e.stack.id,
        ops: [
          { t: "setSource", stackId: e.stack.id },
          ...(structuredClone(def.ops) as Op[]),
        ],
      });
    }
  }
  return abilities;
}

/** 推し/味方が一定以上の特殊ダメージを与えた時の板面ギフトトリガー */
export function collectAllyDealtSpecialAbilities(
  s: GameState,
  pid: PlayerId,
  source: HolomenStack | null,
  damage: number,
): TriggerAbility[] {
  const abilities: TriggerAbility[] = [];
  const oshiName = cardOf(s, s.players[pid].oshiUid).name;
  for (const e of allStacks(s.players[pid])) {
    const g = giftOf(topCard(s, e.stack));
    const key = `giftAllyDealtSpecial:${e.stack.cards[0]}`;
    for (const def of g.triggers) {
      if (def.event !== "allyDealtSpecial") continue;
      if (damage < (def.minDamage ?? 0)) continue;
      const subjectOk = source
        ? !def.subjectFilter || stackMatchesFilter(s, source, def.subjectFilter)
        : !!def.includeOshiSubject &&
          (!def.subjectFilter?.names ||
            def.subjectFilter.names.includes(oshiName));
      if (!subjectOk) continue;
      if (!triggerFires(s, pid, e.pos, def, key)) continue;
      const label = `ギフト「${topCard(s, e.stack).gift?.name ?? ""}」`;
      abilities.push({
        id: `${key}:${abilities.length}`,
        label,
        sourceStackId: e.stack.id,
        ops: triggerDefOps(def, key, label, structuredClone(def.ops) as Op[]),
      });
    }
  }
  return abilities;
}

/** 「自分のホロメンがアーツを使った時」ギフトトリガーを収集する (主語が味方) */
export function collectAllyArtUsedAbilities(
  s: GameState,
  pid: PlayerId,
  src: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
): TriggerAbility[] {
  if (s.phase !== "playing") return [];
  const srcPosName: "center" | "collab" | "back" =
    src.pos === "center" ? "center" : src.pos === "collab" ? "collab" : "back";
  const abilities: TriggerAbility[] = [];
  for (const e of allStacks(s.players[pid])) {
    if (e.stack.id === src.stack.id) continue;
    const top = topCard(s, e.stack);
    const g = giftOf(top);
    const key = `giftArtUsed:${e.stack.cards[0]}`;
    let index = 0;
    for (const def of g.triggers) {
      if (def.event !== "allyArtUsed") continue;
      if (def.subjectFilter) {
        if (
          def.subjectFilter.position &&
          def.subjectFilter.position !== srcPosName
        )
          continue;
        if (!stackMatchesFilter(s, src.stack, def.subjectFilter)) continue;
      }
      if (!triggerFires(s, pid, e.pos, def, key)) continue;
      const label = `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})`;
      logEffect(s, pid, `▶ ${label}が発動します`, label, {
        sourceStackId: e.stack.id,
      });
      abilities.push({
        id: `allyArtUsed:${src.stack.id}:${e.stack.id}:${index++}`,
        label,
        sourceStackId: e.stack.id,
        ops: [
          { t: "setSource", stackId: e.stack.id },
          ...(structuredClone(def.ops) as Op[]),
        ],
      });
    }
  }
  return abilities;
}

/** 「自分の〜ホロメンが(アーツ)ダメージを受けた時」ギフトトリガーを収集する (主語が味方) */
export function collectAllyDamagedAbilities(
  s: GameState,
  pid: PlayerId,
  target: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  isArtDamage: boolean,
): TriggerAbility[] {
  if (s.phase !== "playing" || target.player !== pid) return [];
  const targetPosName: "center" | "collab" | "back" =
    target.pos === "center"
      ? "center"
      : target.pos === "collab"
        ? "collab"
        : "back";
  const abilities: TriggerAbility[] = [];
  for (const e of allStacks(s.players[pid])) {
    if (e.stack.id === target.stack.id) continue;
    const top = topCard(s, e.stack);
    const g = giftOf(top);
    const key = `giftAllyDmg:${e.stack.cards[0]}`;
    let index = 0;
    for (const def of g.triggers) {
      if (def.event !== "allyDamaged") continue;
      if (def.artDamageOnly && !isArtDamage) continue;
      if (def.subjectFilter) {
        if (
          def.subjectFilter.position &&
          def.subjectFilter.position !== targetPosName
        )
          continue;
        if (!stackMatchesFilter(s, target.stack, def.subjectFilter)) continue;
      }
      if (!triggerFires(s, pid, e.pos, def, key)) continue;
      const label = `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})`;
      logEffect(s, pid, `▶ ${label}が発動します`, label, {
        sourceStackId: e.stack.id,
      });
      abilities.push({
        id: `allyDamaged:${target.stack.id}:${e.stack.id}:${index++}`,
        label,
        sourceStackId: e.stack.id,
        ops: [
          { t: "setSource", stackId: e.stack.id },
          ...(structuredClone(def.ops) as Op[]),
        ],
      });
    }
  }
  return abilities;
}

/** 「このホロメンに〈X〉が付いた時」ギフトトリガーの発火 (付与サポートが付いた直後) */
export function collectSupportAttachedOps(
  s: GameState,
  pid: PlayerId,
  stack: HolomenStack,
  supportUid: string,
): Op[] {
  if (s.phase !== "playing") return [];
  const entry = findStackById(s, stack.id);
  if (!entry) return [];
  const supName = cardOf(s, supportUid).name;
  const g = giftOf(topCard(s, stack));
  const key = `giftSupAttach:${stack.cards[0]}`;
  const abilities: TriggerAbility[] = collectOshiStageActionAbilities(
    s,
    pid,
    "supportAttached",
    stack,
    supportUid,
  );
  for (const def of g.triggers) {
    if (def.event !== "supportAttached") continue;
    if (def.attachedSupportNames && !def.attachedSupportNames.includes(supName))
      continue;
    if (!triggerFires(s, pid, entry.pos, def, key)) continue;
    logEffect(
      s,
      pid,
      `▶ ギフト「${topCard(s, stack).gift?.name ?? ""}」(${positionedHolomenName(s, entry.pos, stack)})が発動します`,
      `ギフト「${topCard(s, stack).gift?.name ?? ""}」`,
      { sourceStackId: stack.id },
    );
    abilities.push({
      id: `supportAttached:${stack.id}:${supportUid}:${abilities.length}`,
      label: `ギフト「${topCard(s, stack).gift?.name ?? ""}」`,
      sourceStackId: stack.id,
      ops: triggerDefOps(
        def,
        key,
        `ギフト「${topCard(s, stack).gift?.name ?? ""}」`,
        [
          { t: "setSource", stackId: stack.id },
          ...(structuredClone(def.ops) as Op[]),
        ],
      ),
    });
  }
  return abilities.length
    ? [{ t: "runTriggerAbilities", player: pid, abilities, defer: true }]
    : [];
}

export function collectTriggerAbilities(
  s: GameState,
  entry: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  events: import("../effects").TriggerEvent[],
  onlyUid?: string,
  attachedSource?: "hand" | "archive",
  /** downedOpponent: ダウンした相手ホロメンがいたポジション (「相手のセンターホロメンをダウンさせた時」の判定用) */
  downedPos?: StagePosition,
  eventData?: {
    value: number;
    art: boolean;
    artName?: string;
    revealed?: boolean;
    revealedArchiveReplacement?: boolean;
  },
): TriggerAbility[] {
  const abilities: TriggerAbility[] = [];
  let index = 0;
  /** 「相手のセンターホロメンをダウンさせた時」はコラボのダウンでは誘発しない */
  const downedPosOk = (def: TriggerDef): boolean =>
    !def.downedPos || downedPos === def.downedPos;
  for (const uid of entry.stack.supports) {
    if (onlyUid && uid !== onlyUid) continue;
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    for (const [abilityIndex, def] of b.triggers.entries()) {
      if (!events.includes(def.event)) continue;
      if (
        !!def.revealedArchiveReplacement !==
        !!eventData?.revealedArchiveReplacement
      )
        continue;
      if (
        def.revealedByArt &&
        (!eventData?.revealed || eventData.artName !== def.revealedByArt)
      )
        continue;
      if (
        def.event === "damaged" &&
        ((def.minDamage !== undefined &&
          (!eventData || eventData.value < def.minDamage)) ||
          (def.artDamageOnly && !eventData?.art))
      )
        continue;
      if (
        def.event === "attachedFromHand" &&
        attachedSource === "archive" &&
        !def.attachedFromArchive
      )
        continue;
      if (def.requiresCond && !passiveCondMatches(s, entry.stack, b.cond))
        continue;
      if (def.subjectUsedArtThisTurn && !entry.stack.usedArtsThisTurn) continue;
      if (
        def.wearerFilter &&
        !stackMatchesFilter(s, entry.stack, def.wearerFilter)
      )
        continue;
      if (!downedPosOk(def)) continue;
      const useKey = attachedTriggerUseKey(
        entry.stack.id,
        uid,
        abilityIndex,
        def.requiresCond,
      );
      if (!triggerFires(s, entry.player, entry.pos, def, useKey)) continue;
      logEffect(
        s,
        entry.player,
        `▶ ${positionedHolomenName(s, entry.pos, entry.stack)}の「${c.name}」の能力が発動します`,
        `「${c.name}」の能力`,
        { sourceStackId: entry.stack.id, sourceUid: uid },
      );
      abilities.push({
        id: `trigger:${entry.stack.id}:${uid}:${def.event}:${index++}`,
        label: `「${c.name}」の能力`,
        sourceStackId: entry.stack.id,
        sourceSupportUid: uid,
        ops: triggerDefOps(def, useKey, `「${c.name}」の能力`, [
          {
            t: "setSource",
            stackId: entry.stack.id,
            supportUid: uid,
            grantedSupportAbility: def.requiresCond || undefined,
          },
          ...(structuredClone(def.ops) as Op[]),
        ]),
      });
    }
  }
  if (!onlyUid) {
    const top = topCard(s, entry.stack);
    const gift = giftOf(top);
    const giftKey = `gift:${entry.stack.cards[0]}`;
    for (const def of gift.triggers) {
      if (!events.includes(def.event)) continue;
      if (
        !!def.revealedArchiveReplacement !==
        !!eventData?.revealedArchiveReplacement
      )
        continue;
      // 「公開した時」は、公開を辞退・実行できなかったアーツ使用では誘発しない。
      // 回数の消費と発動ログを出す前に、実際の公開を確認する。
      if (
        def.revealedByArt &&
        (!eventData?.revealed || eventData.artName !== def.revealedByArt)
      )
        continue;
      if (
        def.event === "damaged" &&
        ((def.minDamage !== undefined &&
          (!eventData || eventData.value < def.minDamage)) ||
          (def.artDamageOnly && !eventData?.art))
      )
        continue;
      if (def.selfBloomedFrom) {
        const under = entry.stack.cards[1]
          ? cardOf(s, entry.stack.cards[1])
          : null;
        if (
          !under ||
          under.cardType !== "holomen" ||
          under.bloomLevel !== def.selfBloomedFrom
        )
          continue;
      }
      if (!downedPosOk(def)) continue;
      if (!triggerFires(s, entry.player, entry.pos, def, giftKey)) continue;
      logEffect(
        s,
        entry.player,
        `▶ ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, entry.pos, entry.stack)})が発動します`,
        `ギフト「${top.gift?.name ?? ""}」`,
        { sourceStackId: entry.stack.id },
      );
      abilities.push({
        id: `trigger:${entry.stack.id}:gift:${def.event}:${index++}`,
        label: `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, entry.pos, entry.stack)})`,
        sourceStackId: entry.stack.id,
        ops: triggerDefOps(def, giftKey, `ギフト「${top.gift?.name ?? ""}」`, [
          { t: "setSource", stackId: entry.stack.id },
          ...(structuredClone(def.ops) as Op[]),
        ]),
      });
    }
  }
  return abilities;
}

export function collectTriggerOps(
  s: GameState,
  entry: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  events: import("../effects").TriggerEvent[],
  onlyUid?: string,
  downedPos?: StagePosition,
): Op[] {
  return collectTriggerAbilities(
    s,
    entry,
    events,
    onlyUid,
    undefined,
    downedPos,
  ).flatMap((ability) => ability.ops);
}

/** 指定タイミングで使用可能なリアクティブ推しスキルをすべて探す。 */
export function usableOshiReactives(
  s: GameState,
  pid: PlayerId,
  when: OshiReactive["when"],
  matchStack: HolomenStack | null,
  /** downedOpp: ダウンした相手ホロメンがいたポジション (「相手のセンターホロメンをダウンさせた時」の判定用) */
  downedPos?: StagePosition,
  deferPlayCheck = false,
): UsableOshiReactive[] {
  const result: UsableOshiReactive[] = [];
  const p = s.players[pid];
  const oshi = cardOf(s, p.oshiUid) as OshiCard;
  for (const sp of [false, true]) {
    const skill = sp ? oshi.spOshiSkill : oshi.oshiSkill;
    if (!skill || skill.cost === "X") continue;
    const adj = oshiSkillAdjustments(s, pid, skill.name);
    const cost = Math.max(0, skill.cost + adj.costDelta);
    if (
      !deferPlayCheck &&
      (sp ? p.usedSpOshiSkill : oshiSkillUseCount(s, pid) >= 1 + adj.usesBonus)
    )
      continue;
    if (!deferPlayCheck && p.holoPower.length < cost) continue;
    const r = parseOshiReactive(skill.description);
    if (!r || r.when !== when) continue;
    if ("oppTurnOnly" in r && r.oppTurnOnly && s.turnPlayer === pid) continue;
    // 色・名前の指定がなくても「自分のホロメン」が主語なら発生源が必要。
    if (
      !matchStack &&
      (r.when === "dealtDamageToOppBack" ||
        r.when === "dealtDamageToOppFront") &&
      !("includeOshi" in r && r.includeOshi)
    )
      continue;
    if (
      "filter" in r &&
      r.filter &&
      !(matchStack
        ? stackMatchesFilter(s, matchStack, r.filter)
        : "includeOshi" in r && r.includeOshi)
    )
      continue;
    if (
      "extraCond" in r &&
      r.extraCond &&
      !evalCond(s, { player: pid, rest: [], label: "" }, r.extraCond)
    )
      continue;
    // 「相手のセンターホロメンをダウンさせた時」はコラボのダウンでは使えない
    if ("downedPos" in r && r.downedPos && downedPos !== r.downedPos) continue;
    result.push({ reactive: r, sp, skill, cost });
  }
  return result;
}

/** 既存の単一確認タイミングでは、先に見つかった使用可能スキルを返す。 */
export function usableOshiReactive(
  s: GameState,
  pid: PlayerId,
  when: OshiReactive["when"],
  matchStack: HolomenStack | null,
  downedPos?: StagePosition,
  deferPlayCheck = false,
): UsableOshiReactive | null {
  return (
    usableOshiReactives(
      s,
      pid,
      when,
      matchStack,
      downedPos,
      deferPlayCheck,
    )[0] ?? null
  );
}
