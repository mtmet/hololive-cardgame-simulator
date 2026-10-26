// ゲーム状態とルールの処理：actions。
import type { OshiCard, HolomenCard, SupportCard } from "../../data/types";
import {
  parseEffect,
  parsePlayConditions,
  parseOshiConditional,
} from "../effects";
import type { TriggerAbility, Op } from "../effects";
import type { GameState, StagePosition, PlayerId } from "../types";
import { queueFxWaitMarker } from "./animation";
import {
  hasNoSwitch,
  oshiSkillAdjustments,
  giftOf,
  passiveOf,
  availableArtRefs,
} from "./conditions";
import { canPayArtCost } from "./costs";
import { log, logEffect, cardLogLabel } from "./logging";
import {
  requireStep,
  requireNoPrompt,
  emitAllyPlayed,
  canBloom,
  runOps,
  canBatonTouch,
  canPlaySupport,
  attachError,
  attachCostReliefUid,
  completePlayedAttach,
  finishSupportUse,
  playCostOps,
  canUseOshiSkill,
  attachActivatedUsable,
  attachedAbilityUseKey,
  activatedOpsWithUseLimit,
  giftActivatedUsable,
  artGateError,
  artTargetError,
  recordArtUse,
  buildArtOps,
  setWinner,
} from "./resolution";
import {
  cardOf,
  stageCount,
  newStack,
  getStack,
  topCard,
  holomenOf,
  resetHolomenCardUsage,
  posLabel,
  findStackById,
  cardIsPlaced,
  positionedHolomenName,
  other,
} from "./state";
import {
  collectBloomTriggerAbilities,
  collectTriggerAbilities,
  collectAllyCollabedAbilities,
  collectYellArchivedTriggerAbilities,
  collectOshiStageActionAbilities,
} from "./triggers";

// ------------------------------------------------------------
// メインステップのアクション (8章)
// ------------------------------------------------------------

export function playHolomen(s: GameState, handUid: string): void {
  requireStep(s, "main");
  requireNoPrompt(s);
  const p = s.players[s.turnPlayer];
  if (!p.hand.includes(handUid)) throw new Error("手札にないカードです");
  const c = cardOf(s, handUid);
  if (c.cardType !== "holomen") throw new Error("ホロメンカードではありません");
  if (c.bloomLevel !== "Debut" && c.bloomLevel !== "Spot")
    throw new Error("ステージに出せるのはDebutかSpotのホロメンだけです");
  if (stageCount(p) >= 6) throw new Error("ステージには6人までしか出せません");
  if (p.back.length >= 5) throw new Error("バックポジションが満杯です");
  p.hand = p.hand.filter((u) => u !== handUid);
  const st = newStack(s, handUid, s.turn);
  p.back.push(st);
  log(s, s.turnPlayer, `${c.name}をバック${p.back.length}に出しました`);
  emitAllyPlayed(s, s.turnPlayer, st);
}

export function bloom(s: GameState, handUid: string, pos: StagePosition): void {
  requireStep(s, "main");
  requireNoPrompt(s);
  const check = canBloom(s, handUid, pos);
  if (!check.ok) throw new Error(check.reason);
  const p = s.players[s.turnPlayer];
  const st = getStack(p, pos)!;
  const prevTop = topCard(s, st);
  const prevLevel = prevTop.bloomLevel;
  const prevBuzz = prevTop.cardType === "holomen" && prevTop.buzz;
  const nc = holomenOf(s, handUid);
  p.hand = p.hand.filter((u) => u !== handUid);
  resetHolomenCardUsage(s, handUid);
  st.cards.unshift(handUid);
  st.bloomedFromLevelThisTurn = prevLevel;
  st.bloomedThisTurn = true;
  s.bloomedCardUidsThisTurn[s.turnPlayer].push(handUid);
  log(s, s.turnPlayer, `${nc.name}にBloomしました (${posLabel(pos)})`);
  const abilities = collectBloomTriggerAbilities(
    s,
    s.turnPlayer,
    st,
    nc,
    prevLevel,
    prevBuzz,
  );
  runOps(s, {
    player: s.turnPlayer,
    sourceStackId: st.id,
    bloomedFromDebut: prevLevel === "Debut",
    bloomedFromBuzz: prevBuzz,
    rest: [
      { t: "enforceSupportLimits", stackId: st.id },
      { t: "continueTriggerAbilities", abilities },
    ],
    label: "Bloom",
  });
}

export function collab(s: GameState, backIndex: number): void {
  requireStep(s, "main");
  requireNoPrompt(s);
  const p = s.players[s.turnPlayer];
  if (p.usedCollabThisTurn || p.collab)
    throw new Error("コラボは1ターンに1回だけ行えます");
  const st = p.back[backIndex];
  if (!st) throw new Error("バックホロメンが見つかりません");
  if (st.resting) throw new Error("お休みしているホロメンはコラボできません");
  if (hasNoSwitch(s, st))
    throw new Error("このホロメンは効果により移動できません");
  // Q194: 通常コラボにはデッキからホロパワーへ送るカードが必要。
  if (!p.deck.length) throw new Error("デッキが0枚のためコラボできません");
  p.holoPower.unshift(p.deck.shift()!);
  p.back.splice(backIndex, 1);
  p.collab = st;
  p.usedCollabThisTurn = true;
  const c = topCard(s, st);
  log(
    s,
    s.turnPlayer,
    `バック${backIndex + 1}の${c.name}をコラボポジションに移動しました (ホロパワー+1)`,
  );
  const abilities: TriggerAbility[] = [];
  if (c.collabEffect?.description) {
    const label = `コラボエフェクト「${c.collabEffect.name ?? ""}」`;
    const program = parseEffect(c.collabEffect.description);
    if (program) {
      if (program.ops.length > 0) {
        logEffect(
          s,
          s.turnPlayer,
          `▶ ${label}: ${c.collabEffect.description}`,
          label,
          { sourceStackId: st.id },
        );
        abilities.push({
          id: `collabEffect:${st.id}:${c.id}`,
          label,
          sourceStackId: st.id,
          ops: [
            { t: "setSource", stackId: st.id },
            ...(structuredClone(program.ops) as Op[]),
          ],
        });
      }
    } else {
      log(
        s,
        s.turnPlayer,
        `⚠ ${label}「${c.collabEffect.description}」は自動処理未対応のため発揮されません`,
      );
    }
  }
  abilities.push(
    ...collectTriggerAbilities(
      s,
      { player: s.turnPlayer, pos: "collab", stack: st },
      ["collabed", "collabMoved"],
    ),
    ...collectAllyCollabedAbilities(s, s.turnPlayer, st),
  );
  runOps(s, {
    player: s.turnPlayer,
    sourceStackId: st.id,
    rest: [{ t: "continueTriggerAbilities", abilities }],
    label: "Collab",
  });
}

export function batonTouch(
  s: GameState,
  backIndex: number,
  yellUids?: string[],
): void {
  const check = canBatonTouch(s, backIndex);
  if (!check.ok) throw new Error(check.reason ?? "バトンタッチできません");
  const p = s.players[s.turnPlayer];
  const centerSt = p.center!;
  const backSt = p.back[backIndex]!;
  const cost = check.cost;
  const pay = yellUids ?? centerSt.yells.slice(0, cost);
  if (pay.length !== cost)
    throw new Error(`エールを${cost}枚アーカイブする必要があります`);
  if (new Set(pay).size !== pay.length)
    throw new Error("同じカードを複数回選ぶことはできません");
  if (!pay.every((u) => centerSt.yells.includes(u)))
    throw new Error("センターホロメンに付いていないエールが含まれています");
  centerSt.yells = centerSt.yells.filter((u) => !pay.includes(u));
  p.archive.push(...pay);
  if (pay.length > 0) s.stageYellArchivedThisTurn[s.turnPlayer] = true;
  const yellAbilities =
    pay.length > 0 ? collectYellArchivedTriggerAbilities(s, s.turnPlayer) : [];

  p.center = backSt;
  p.back[backIndex] = centerSt;
  p.usedBatonTouchThisTurn = true;
  log(
    s,
    s.turnPlayer,
    `バトンタッチ: センターの${topCard(s, centerSt).name} ⇔ バック${backIndex + 1}の${topCard(s, backSt).name} (エール${cost}枚をアーカイブ)`,
  );
  // コストのエールアーカイブとバック移動で待機した能力を同じチェックタイミングで扱う
  const moved = findStackById(s, centerSt.id);
  const batonAbilities = moved
    ? collectTriggerAbilities(s, moved, ["batonTouched"])
    : [];
  const abilities = [
    ...yellAbilities,
    ...batonAbilities,
    ...collectOshiStageActionAbilities(
      s,
      s.turnPlayer,
      "batonTouched",
      centerSt,
    ),
  ];
  runOps(s, {
    player: s.turnPlayer,
    sourceStackId: centerSt.id,
    // 10.6.3.1: 支払い・交換で最大HPが下がった場合も、待機能力より先にダウンする。
    rest: [
      { t: "checkRuleTiming" },
      { t: "continueTriggerAbilities", abilities },
    ],
    label: "バトンタッチ",
  });
}

export function playSupport(
  s: GameState,
  handUid: string,
  attachPos?: StagePosition,
): void {
  requireStep(s, "main");
  requireNoPrompt(s);
  const p = s.players[s.turnPlayer];
  const c = cardOf(s, handUid);
  if (c.cardType !== "support") throw new Error("サポートカードではありません");
  const check = canPlaySupport(s, handUid);
  if (!check.ok) throw new Error(check.reason);

  const { conditions, rest } = parsePlayConditions(c.description);
  const attaching =
    c.supportType === "ツール" ||
    c.supportType === "マスコット" ||
    c.supportType === "ファン";

  if (attaching) {
    if (!attachPos) throw new Error("付けるホロメンを選んでください");
    const st = getStack(p, attachPos);
    if (!st) throw new Error("そこにホロメンがいません");
    const err = attachError(s, st, c);
    // 枠が埋まっていても、使用コストでその付与を外せるなら付け替えられる
    const reliefUid = err ? attachCostReliefUid(s, conditions, st, c) : null;
    if (err && !reliefUid) throw new Error(err);
    p.hand = p.hand.filter((u) => u !== handUid);
    if (reliefUid) {
      st.supports = st.supports.filter((u) => u !== reliefUid);
      p.archive.push(reliefUid);
      log(
        s,
        s.turnPlayer,
        `使用コストとして${cardOf(s, reliefUid).name}をアーカイブしました`,
      );
      completePlayedAttach(s, s.turnPlayer, st, handUid, attachPos);
      return finishSupportUse(s, c);
    }
    // 使用コストの支払いに選択が要る場合は、支払いを終えてから付ける。
    // 先に付けると、コストで外すはずのツールと枠が競合する (1人1枚)。
    const costOps = playCostOps(s, s.turnPlayer, conditions, handUid);
    if (costOps.length > 0) {
      // 10.7.2.1: コストの選択を始める前に宣言したカードを公開する。
      // 手札から抜いた実体は、付与完了まで解決中領域に保持する。
      (p.resolvingSupports ??= []).push(handUid);
      log(
        s,
        s.turnPlayer,
        `サポート「${cardLogLabel(s, handUid)}」を公開しました`,
      );
      runOps(s, {
        player: s.turnPlayer,
        sourceCardUid: handUid,
        pendingAttach: { uid: handUid, pos: attachPos },
        rest: [
          ...costOps,
          { t: "attachPlayedSupport" },
          { t: "finishSupportCard", uid: handUid },
        ],
        label: `「${c.name}」`,
      });
      // コストの支払いが中断された場合でも、手札から抜いたカードを宙に浮かせない
      if (s.prompts.length === 0 && !cardIsPlaced(s, handUid))
        p.archive.push(handUid);
    } else {
      completePlayedAttach(s, s.turnPlayer, st, handUid, attachPos);
    }
  } else {
    // コスト支払い (ホロパワー)
    for (const cond of conditions) {
      if (cond.c === "holoPowerCost")
        p.archive.push(...p.holoPower.splice(0, cond.n));
    }
    p.hand = p.hand.filter((u) => u !== handUid);
    (p.resolvingSupports ??= []).push(handUid);
    log(
      s,
      s.turnPlayer,
      `サポート「${c.name}」(${c.supportType})を使用しました`,
    );
    const program = parseEffect(rest)!;
    // 使用コスト (ステージのエール・OR形) を効果本体より先に解決する
    const ops: Op[] = [
      ...playCostOps(s, s.turnPlayer, conditions, handUid),
      ...program.ops,
      { t: "finishSupportCard", uid: handUid },
    ];
    runOps(s, {
      player: s.turnPlayer,
      sourceCardUid: handUid,
      rest: ops,
      label: `「${c.name}」`,
    });
  }
  finishSupportUse(s, c);
}

export function useOshiSkill(s: GameState, sp: boolean): void {
  requireNoPrompt(s);
  const check = canUseOshiSkill(s, sp);
  if (!check.ok) throw new Error(check.reason);
  const p = s.players[s.turnPlayer];
  const oshi = cardOf(s, p.oshiUid) as OshiCard;
  const skill = sp ? oshi.spOshiSkill : oshi.oshiSkill;
  if (!skill) throw new Error("この推しスキルは使用できません");
  const adj = oshiSkillAdjustments(s, s.turnPlayer, skill.name);
  const cost: number | "X" =
    skill.cost === "X" ? "X" : Math.max(0, skill.cost + adj.costDelta);
  if (typeof cost === "number") p.archive.push(...p.holoPower.splice(0, cost));
  if (sp) {
    p.usedSpOshiSkill = true;
    p.usedSpOshiSkillThisTurn = true;
    p.usedSpOshiSkillInfo = {
      name: skill.name,
      oshiName: oshi.name,
      turn: s.turn,
      ownMainStep: true,
    };
  } else {
    p.usedOshiSkillThisTurn = true;
    (p.usedOshiSkillNamesThisTurn ??= []).push(skill.name);
    const key = `oshiSkillUse:${s.turnPlayer}`;
    s.usedTriggersThisTurn[key] = (s.usedTriggersThisTurn[key] ?? 0) + 1;
  }
  log(
    s,
    s.turnPlayer,
    `${sp ? "SP推しスキル" : "推しスキル"}「${skill.name}」を使用しました (ホロパワー-${cost})`,
  );
  queueFxWaitMarker(s, sp ? "spOshiSkill" : "oshiSkill");
  const conditional = parseOshiConditional(skill.description);
  const ops = conditional
    ? structuredClone(conditional.ops)
    : [...parseEffect(skill.description)!.ops];
  if (skill.cost === "X") ops.unshift({ t: "archiveHoloPowerAny", min: 1 });
  // 使用回数の予約と、解決後に起こる「使用した」事象を分ける。
  runOps(s, {
    player: s.turnPlayer,
    originOshiSkill: { name: skill.name, sp },
    rest: [
      ...ops,
      { t: "emitOshiSkillUsed", player: s.turnPlayer, sp, name: skill.name },
    ],
    label: `「${skill.name}」`,
  });
}

/** 起動型ギフト能力を使用する (supportUid 指定時は付与カードの起動型能力) */
export function useGiftAbility(
  s: GameState,
  stackId: number,
  index: number,
  supportUid?: string,
  archiveUid?: string,
): void {
  requireNoPrompt(s);
  requireStep(s, "main");
  const pid = s.turnPlayer;
  if (archiveUid) {
    const c = cardOf(s, archiveUid);
    const ab = c.cardType === "holomen" ? giftOf(c).archiveBloom : undefined;
    const archiveHolomenCount = s.players[pid].archive.filter(
      (uid) => cardOf(s, uid).cardType === "holomen",
    ).length;
    if (
      !ab ||
      !s.players[pid].archive.includes(archiveUid) ||
      archiveHolomenCount < ab.minArchiveHolomen
    )
      throw new Error("この能力は使用できません");
    const label = `ギフト「${(c as HolomenCard).gift?.name ?? "能力"}」`;
    logEffect(
      s,
      pid,
      `▶ ${label}(${c.name}/アーカイブ)の能力を使用します`,
      label,
      { sourceUid: archiveUid },
    );
    runOps(s, {
      player: pid,
      rest: [
        {
          t: "effectBloom",
          source: "archive",
          cardFilter: { uids: [archiveUid] },
          optional: true,
        },
      ],
      label: `「${(c as HolomenCard).gift?.name ?? "能力"}」`,
    });
    return;
  }
  const entry = findStackById(s, stackId);
  if (!entry || entry.player !== pid)
    throw new Error("この能力は使用できません");
  const top = topCard(s, entry.stack);

  if (supportUid) {
    // 付与カード (ツール/マスコット/ファン) の起動型能力
    if (!entry.stack.supports.includes(supportUid))
      throw new Error("この能力は使用できません");
    const c = cardOf(s, supportUid);
    const p = passiveOf(c as SupportCard);
    const ab = p.activated?.[index];
    if (!ab) throw new Error("この能力は使用できません");
    if (!attachActivatedUsable(s, pid, entry, ab, supportUid, index, p.cond))
      throw new Error("使用条件を満たしていないか、すでに使用しています");
    const key = attachedAbilityUseKey(
      entry.stack.id,
      supportUid,
      index,
      ab.requiresCond,
    );
    const ops = activatedOpsWithUseLimit(
      s,
      ab.ops,
      key,
      ab.timesPerTurn,
      `「${c.name}」`,
    );
    logEffect(
      s,
      pid,
      `▶ ${c.name}(${positionedHolomenName(s, entry.pos, entry.stack)})の起動型能力を使用します`,
      `「${c.name}」の能力`,
      { sourceStackId: entry.stack.id, sourceUid: supportUid },
    );
    runOps(s, {
      player: pid,
      rest: [
        {
          t: "setSource",
          stackId: entry.stack.id,
          supportUid,
          grantedSupportAbility: ab.requiresCond || undefined,
        },
        ...ops,
      ],
      label: `「${c.name}」`,
    });
    return;
  }

  const ab = giftOf(top).activated?.[index];
  if (!ab) throw new Error("この能力は使用できません");
  if (!giftActivatedUsable(s, pid, entry, ab, index))
    throw new Error("使用条件を満たしていないか、すでに使用しています");
  const key = `giftActivated:${entry.stack.cards[0]}:${index}`;
  const ops = activatedOpsWithUseLimit(
    s,
    ab.ops,
    key,
    ab.timesPerTurn,
    `「${top.gift?.name ?? "能力"}」`,
  );
  logEffect(
    s,
    pid,
    `▶ ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, entry.pos, entry.stack)})の能力を使用します`,
    `ギフト「${top.gift?.name ?? ""}」`,
    { sourceStackId: entry.stack.id },
  );
  runOps(s, {
    player: pid,
    rest: [{ t: "setSource", stackId: entry.stack.id }, ...ops],
    label: `「${top.gift?.name ?? "能力"}」`,
  });
}

export function useArts(
  s: GameState,
  fromPos: "center" | "collab",
  artIndex: number,
  targetPos: StagePosition,
): void {
  requireStep(s, "performance");
  requireNoPrompt(s);
  const p = s.players[s.turnPlayer];
  const opp = s.players[other(s.turnPlayer)];
  const st = getStack(p, fromPos);
  if (!st) throw new Error("そこにホロメンがいません");
  if (st.resting)
    throw new Error("お休みしているホロメンはアーツを使用できません");
  if (st.usedArtsThisTurn)
    throw new Error("このホロメンはすでにアーツを使用しています");
  if (fromPos === "center" ? p.usedCenterArtThisTurn : p.usedCollabArtThisTurn)
    throw new Error(
      `このパフォーマンスステップ中、${posLabel(fromPos)}からはすでにアーツを使用しています`,
    );
  const c = topCard(s, st);
  const artRef = availableArtRefs(s, st)[artIndex];
  if (!artRef) throw new Error("アーツが見つかりません");
  const art = artRef.art;
  if (!canPayArtCost(s, st, art.cost, art.description))
    throw new Error("アーツに必要なエールが付いていません");
  const gateError = artGateError(s, s.turnPlayer, st, fromPos, art);
  if (gateError) throw new Error(gateError);
  const target = getStack(opp, targetPos);
  if (!target) throw new Error("対象のホロメンがいません");

  const targetError = artTargetError(s, s.turnPlayer, st, art, {
    player: other(s.turnPlayer),
    pos: targetPos,
    stack: target,
  });
  if (targetError) throw new Error(targetError);

  st.usedArtsThisTurn = true;
  recordArtUse(s, s.turnPlayer, fromPos, st);
  if (fromPos === "center") p.usedCenterArtThisTurn = true;
  else p.usedCollabArtThisTurn = true;
  log(
    s,
    s.turnPlayer,
    `${posLabel(fromPos)}の${c.name}のアーツ「${art.name}」→ ${posLabel(targetPos)}の${topCard(s, target).name}`,
  );

  runOps(s, {
    player: s.turnPlayer,
    sourceStackId: st.id,
    artSourceStackId: st.id,
    artRef: { cardId: artRef.cardId, index: artRef.index },
    artTargetStackId: target.id,
    artPrimaryTargetStackId: target.id,
    artIndex,
    artName: art.name,
    artBonus: 0,
    rest: buildArtOps(s, art, target, fromPos),
    label: `アーツ「${art.name}」`,
  });
}

/** 投了 (1.2.3) */
export function concede(s: GameState, pid: PlayerId): void {
  setWinner(s, other(pid), `${s.players[pid].name}が投了しました`);
}
