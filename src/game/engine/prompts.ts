// ゲーム状態とルールの処理：prompts。
import type { CardFilter, Op } from "../effects";
import type {
  GameState,
  PlayerId,
  StagePosition,
  Prompt,
  JankenHand,
} from "../types";
import { stackColors, cardMatchesFilter } from "./conditions";
import { cheerAssignCandidates } from "./costs";
import { cardLogLabel, log, logPrivate } from "./logging";
import {
  runTriggerAbility,
  advance,
  offerIncomingDamageReplacement,
  applyToStack,
  queueSpecialDamage,
  runOps,
  distinctCheerTargetsPayable,
  cheerAssignCapacity,
  archiveRedirectTargets,
  rememberHolomen,
  dropIfEmptyStack,
  countDeckArchived,
  queueYellArchivedReactive,
  isYellTransferOnlySupport,
  hasAttachTarget,
  effectAttachTargetError,
  effectTargetEntries,
  resetAttachedCardUsage,
  finishIncomingDamageReplacement,
} from "./resolution";
import { pushPrompt, shuffle } from "./runtime";
import {
  getStack,
  findStackById,
  cardOf,
  allStacks,
  stageCount,
  newStack,
  topCard,
  holomenOf,
  resetHolomenCardUsage,
  positionedHolomenName,
  posLabel,
  other,
} from "./state";
import {
  collectYellArchivedTriggerAbilities,
  collectAllyPlayedOps,
  collectYellArchivedTriggerOps,
  collectBloomTriggerAbilities,
  collectTriggerAbilities,
  collectSupportAttachedOps,
} from "./triggers";

// ---------------- 効果プロンプトの解決 ----------------

export function resolveTriggerAbilityChoice(
  s: GameState,
  pid: PlayerId,
  id: string,
): void {
  const prompt = s.prompts[0];
  if (
    !prompt ||
    prompt.type !== "triggerAbilityChoice" ||
    prompt.player !== pid
  )
    throw new Error("現在この能力は選べません");
  const selectedIndex = prompt.abilities.findIndex(
    (ability) => ability.id === id,
  );
  if (selectedIndex < 0) throw new Error("選んだ能力が見つかりません");
  const selected = prompt.abilities[selectedIndex];
  // 旧保存に同じIDの複数の誘発があっても、選んだ1件だけを解決する。
  const remaining = prompt.abilities.filter(
    (_, index) => index !== selectedIndex,
  );
  s.prompts.shift();
  prompt.ctx.rest.unshift({
    t: "continueTriggerAbilities",
    abilities: remaining,
  });
  runTriggerAbility(s, prompt.ctx, selected);
  advance(s);
}

/** 10.11.2の置換効果適用順選択を解決し、選んだ効果の任意確認へ進む。 */
export function resolveDamageReplacementChoice(
  s: GameState,
  pid: PlayerId,
  id: string,
): void {
  const prompt = s.prompts[0];
  if (
    !prompt ||
    prompt.type !== "damageReplacementChoice" ||
    prompt.player !== pid
  )
    throw new Error("現在この置換効果は選べません");
  const selected = prompt.choices.find((choice) => choice.id === id);
  if (!selected) throw new Error("選んだ置換効果が見つかりません");
  s.prompts.shift();
  offerIncomingDamageReplacement(s, pid, selected, prompt.ctx);
  advance(s);
}

export function resolveEffectTarget(
  s: GameState,
  pid: PlayerId,
  targetPlayer: PlayerId,
  pos: StagePosition,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "effectTarget" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  const st = getStack(s.players[targetPlayer], pos);
  if (!st) throw new Error("そこにホロメンがいません");
  const candidates = effectTargetEntries(s, prompt);
  const entry = candidates.find(
    (e) => e.stack.id === st.id && e.player === targetPlayer,
  );
  if (!entry) throw new Error("この効果の対象にできません");
  if (
    !prompt.damageAllocation &&
    prompt.chosen.some((c) => c.stackId === st.id)
  )
    throw new Error("すでに選択済みです");
  if (prompt.distinctColors) {
    const colors = stackColors(s, st);
    for (const c of prompt.chosen) {
      const prev = findStackById(s, c.stackId);
      if (prev && stackColors(s, prev.stack).some((x) => colors.includes(x)))
        throw new Error(
          "すでに選んだホロメンと異なる色のホロメンを選んでください",
        );
    }
  }
  if (prompt.apply.t !== "special")
    applyToStack(s, prompt.ctx, entry, prompt.apply);
  prompt.chosen.push({ player: targetPlayer, stackId: st.id });
  if (
    prompt.chosen.length >= prompt.count ||
    (!prompt.damageAllocation && prompt.chosen.length >= candidates.length)
  ) {
    s.prompts.shift();
    if (prompt.apply.t === "special") {
      const amounts: Record<number, number> = {};
      if (prompt.damageAllocation)
        for (const chosen of prompt.chosen)
          amounts[chosen.stackId] =
            (amounts[chosen.stackId] ?? 0) + prompt.apply.dmg;
      queueSpecialDamage(
        s,
        prompt.ctx,
        [...new Set(prompt.chosen.map((c) => c.stackId))],
        prompt.apply,
        prompt.damageAllocation ? amounts : undefined,
      );
    }
    runOps(s, prompt.ctx);
    advance(s);
  }
}

/** 選択セットを種別ごとの枠に割り当てられるか検証する (「ホロメンX枚と(F)X枚」等) */
function validGroupPick(
  s: GameState,
  pid: PlayerId,
  uids: string[],
  groups: { filter: CardFilter; max: number }[],
  sameNameGroups?: number[],
): boolean {
  const assign: number[] = new Array(uids.length).fill(-1);
  const counts: number[] = new Array(groups.length).fill(0);
  const rec = (i: number): boolean => {
    if (i === uids.length) {
      if (sameNameGroups) {
        // 指定グループに割り当てたカードはすべて同じカード名であること
        const names = new Set<string>();
        uids.forEach((u, j) => {
          if (sameNameGroups.includes(assign[j])) names.add(cardOf(s, u).name);
        });
        if (names.size > 1) return false;
      }
      return true;
    }
    for (let g = 0; g < groups.length; g++) {
      if (counts[g] >= groups[g].max) continue;
      if (!cardMatchesFilter(s, pid, uids[i], groups[g].filter)) continue;
      assign[i] = g;
      counts[g]++;
      if (rec(i + 1)) return true;
      counts[g]--;
      assign[i] = -1;
    }
    return false;
  };
  return rec(0);
}

/** UI・通信境界・解決器で共用する、カード選択の純粋な合法性検査。 */
export function effectPickCardSelectionError(
  s: GameState,
  pid: PlayerId,
  prompt: Extract<Prompt, { type: "effectPickCard" }>,
  uids: readonly string[],
): string | null {
  if (uids.length > prompt.pickMax)
    return `選べるのは${prompt.pickMax}枚までです`;
  if (
    uids.length < prompt.pickMin &&
    !(prompt.zeroOrMin !== undefined && uids.length === 0)
  )
    return `${prompt.pickMin}枚以上選ぶ必要があります`;
  if (
    prompt.zeroOrMin !== undefined &&
    uids.length > 0 &&
    uids.length < prompt.zeroOrMin
  )
    return `選ばないか、${prompt.zeroOrMin}枚以上選ぶ必要があります`;
  if (new Set(uids).size !== uids.length)
    return "同じカードを複数回選ぶことはできません";
  if (!uids.every((u) => prompt.uids.includes(u)))
    return "選択できないカードが含まれています";
  if (
    prompt.pickFilter &&
    !uids.every((u) => cardMatchesFilter(s, pid, u, prompt.pickFilter!))
  )
    return "条件に合わないカードが含まれています";
  if (prompt.pickFilter?.distinctPick) {
    const names = uids.map((u) => cardOf(s, u).name);
    if (new Set(names).size !== names.length)
      return "異なるカード名のカードを選んでください";
  }
  if (
    prompt.pickGroups &&
    !validGroupPick(s, pid, [...uids], prompt.pickGroups, prompt.sameNameGroups)
  )
    return "選んだカードの組み合わせが条件に合いません";
  if (
    prompt.uidPickGroups?.some((group) => {
      const count = uids.filter((uid) => group.uids.includes(uid)).length;
      return count < group.pickMin || count > group.pickMax;
    })
  )
    return "選んだカードの組み合わせが領域ごとの枚数条件に合いません";
  return null;
}

export function resolveEffectPickCard(
  s: GameState,
  pid: PlayerId,
  uids: string[],
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "effectPickCard" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  const selectionError = effectPickCardSelectionError(s, pid, prompt, uids);
  if (selectionError) throw new Error(selectionError);
  if (prompt.revealThenPick) {
    s.prompts.shift();
    // まだデッキ内にある札を公開する。次の選択完了時にだけ移動する。
    prompt.ctx.revealed = [...uids];
    prompt.ctx.revealedOwner = pid;
    prompt.ctx.revealedOwnerOnly = false;
    prompt.ctx.revealedHistory = false;
    if (uids.length) {
      log(
        s,
        pid,
        `${uids.map((uid) => cardLogLabel(s, uid)).join("、")}を公開しました`,
      );
      pushPrompt(s, {
        type: "effectPickCard",
        player: pid,
        uids: [...uids],
        pickMin: Math.min(prompt.revealThenPick.n, uids.length),
        pickMax: Math.min(prompt.revealThenPick.n, uids.length),
        dest: "hand",
        restTo: prompt.revealThenPick.restTo,
        from: "deck",
        revealAll: true,
        ctx: prompt.ctx,
        shuffleAfter: prompt.shuffleAfter,
      });
    } else runOps(s, prompt.ctx);
    advance(s);
    return;
  }
  // 閲覧結果は選択後の条件用に残すが、移動先の現在位置を公開する参照にしない。
  const finishesRevealed =
    ["deck", "cheer", "holo"].includes(prompt.from) &&
    prompt.ctx.revealed?.some((uid) => prompt.uids.includes(uid));
  if (prompt.orderOnly) {
    const p = s.players[pid];
    const zone =
      prompt.from === "cheer"
        ? p.cheerDeck
        : prompt.from === "holo"
          ? p.holoPower
          : p.deck;
    const remaining = zone.filter((uid) => !uids.includes(uid));
    if (prompt.orderOnly === "bottom")
      zone.splice(0, zone.length, ...remaining, ...uids);
    else zone.splice(0, zone.length, ...uids, ...remaining);
    s.prompts.shift();
    if (finishesRevealed) prompt.ctx.revealedHistory = true;
    const zoneName =
      prompt.from === "cheer"
        ? "エールデッキ"
        : prompt.from === "holo"
          ? "ホロパワー"
          : "デッキ";
    log(
      s,
      pid,
      `${uids.length}枚を指定した順で${zoneName}の${prompt.orderOnly === "bottom" ? "下" : "上"}に戻しました`,
    );
    runOps(s, prompt.ctx);
    advance(s);
    return;
  }
  if (
    prompt.dest === "cheerAssign" &&
    uids.length > 0 &&
    prompt.cheerTargetGroups
  ) {
    if (prompt.cheerTargetGroups.length < uids.length)
      throw new Error("選択順に対応する送り先条件が不足しています");
    const invalidGroup = uids.some(
      (yellUid, index) =>
        cheerAssignCandidates(s, {
          type: "cheerAssign",
          player: pid,
          yellUid,
          reason: "effect",
          ctx: prompt.ctx,
          filter: prompt.cheerTargetGroups![index],
          targetPlayer: prompt.cheerTargetPlayer,
        }).length === 0,
    );
    if (invalidGroup)
      throw new Error("選んだエールを指定された対象へ送れません");
    if (
      prompt.distinctCheerTargets &&
      !distinctCheerTargetsPayable(
        s,
        pid,
        prompt.cheerTargetGroups.slice(0, uids.length),
        prompt.ctx,
        prompt.cheerTargetPlayer,
      )
    )
      throw new Error("各条件では異なるホロメンを選ぶ必要があります");
  }
  if (
    prompt.dest === "cheerAssign" &&
    uids.length > 0 &&
    !prompt.cheerTargetGroups
  ) {
    const previewPrompt: Extract<Prompt, { type: "cheerAssign" }> = {
      type: "cheerAssign",
      player: pid,
      yellUid: uids[0],
      reason: "effect",
      ctx: prompt.ctx,
      filter: prompt.targetFilter,
      targetPlayer: prompt.cheerTargetPlayer,
      perTargetMax: prompt.perTargetMax,
      sameTarget: prompt.sameTarget,
    };
    const capacity = cheerAssignCapacity(s, previewPrompt);
    if (uids.length > capacity)
      throw new Error("選んだエールを送れるホロメンがいません");
  }
  const p = s.players[pid];
  const redirectedSupports: {
    uid: string;
    owner: PlayerId;
    targetNames: string[];
  }[] = [];
  if (prompt.from === "stageSupports" && prompt.dest === "archive") {
    const owner = prompt.supportOwner ?? pid;
    const ownerP = s.players[owner];
    for (const uid of uids) {
      if (!ownerP.center?.supports.includes(uid)) continue;
      const targetNames = archiveRedirectTargets(s, owner, uid, "center");
      if (targetNames) redirectedSupports.push({ uid, owner, targetNames });
    }
  }
  s.prompts.shift();
  if (finishesRevealed) prompt.ctx.revealedHistory = true;

  // 付与カードは成功まで元の領域に残す (5.17.3.4)。
  const attachSource: Extract<Prompt, { type: "effectAttach" }>["source"] =
    prompt.dest === "attach" &&
    (prompt.from === "deck" ||
      prompt.from === "archive" ||
      prompt.from === "hand")
      ? {
          player:
            prompt.from === "archive" ? (prompt.archiveOwner ?? pid) : pid,
          zone: prompt.from,
        }
      : undefined;
  // 選択元から取り除く
  const yellOrigins: Record<string, number> = {};
  const removeFrom = (zone: string[]) =>
    attachSource ? zone : zone.filter((u) => !uids.includes(u));
  if (prompt.from === "deck") p.deck = removeFrom(p.deck);
  else if (prompt.from === "archive") {
    const ownerP = s.players[prompt.archiveOwner ?? pid];
    ownerP.archive = removeFrom(ownerP.archive);
  } else if (prompt.from === "cheer") p.cheerDeck = removeFrom(p.cheerDeck);
  else if (prompt.from === "hand") p.hand = removeFrom(p.hand);
  else if (prompt.from === "stageYells") {
    const ownerP = s.players[prompt.yellOwner ?? pid];
    for (const { stack } of allStacks(ownerP)) {
      // 付け替え先が元と同じホロメンだった時に「何もしない」と判定できるよう、
      // 取り外す前に元の持ち主を覚えておく (5.17.4.1)。
      for (const uid of stack.yells)
        if (uids.includes(uid)) yellOrigins[uid] = stack.id;
      stack.yells = stack.yells.filter((u) => !uids.includes(u));
    }
  } else if (prompt.from === "stageSupports") {
    const ownerP = s.players[prompt.supportOwner ?? pid];
    for (const { stack } of allStacks(ownerP))
      stack.supports = stack.supports.filter((u) => !uids.includes(u));
  } else if (prompt.from === "stacked") {
    // 重なっているホロメン (一番上のカードは対象外なので先頭は残る)
    for (const { stack } of allStacks(p))
      stack.cards = stack.cards.filter((u, i) => i === 0 || !uids.includes(u));
  } else if (prompt.from === "downed") {
    // ダウンしたスタックがまだ場にある間に選ぶ場合、行き先を問わず必ず取り除く。
    // 残したままにすると手札とステージの両方に同じカードが存在してしまう
    const live = prompt.ctx.downedStackId
      ? findStackById(s, prompt.ctx.downedStackId)
      : null;
    if (live) {
      const yellAbilities =
        live.stack.yells.length > 0 &&
        live.stack.cards.every((u) => uids.includes(u))
          ? collectYellArchivedTriggerAbilities(s, live.player)
          : [];
      rememberHolomen(s, live.player, live.pos, live.stack);
      live.stack.cards = live.stack.cards.filter((u) => !uids.includes(u));
      live.stack.yells = live.stack.yells.filter((u) => !uids.includes(u));
      live.stack.supports = live.stack.supports.filter(
        (u) => !uids.includes(u),
      );
      dropIfEmptyStack(s, live.stack.id, prompt.ctx, yellAbilities);
    }
  } else if (prompt.from === "holo") p.holoPower = removeFrom(p.holoPower);

  const names = uids.map((u) => cardLogLabel(s, u)).join("、");
  const restForOrder =
    prompt.restOrder && (prompt.restTo === "bottom" || prompt.restTo === "top")
      ? prompt.uids.filter((uid) => !uids.includes(uid))
      : [];
  const queuesOrderPrompt = restForOrder.length > 1;

  // 行き先
  let cheerAssignQueued = false;
  let movedUids = [...uids];
  let movedToArchiveUids = [...uids];
  switch (prompt.dest) {
    case "hand":
      p.hand.push(...uids);
      if (uids.length > 0) {
        if (prompt.revealSelection === false)
          logPrivate(
            s,
            pid,
            `${names}を手札に加えました`,
            `${uids.length}枚を手札に加えました`,
          );
        else log(s, pid, `${names}を手札に加えました`);
      }
      break;
    case "stage": {
      const enteredOps: Op[] = [];
      // 「そのホロメン」に続く効果へ、実際に登場したスタックを引き継ぐ。
      prompt.ctx.boundStackId = undefined;
      prompt.ctx.boundStackIds = [];
      for (const uid of uids) {
        if (stageCount(p) >= 6 || p.back.length >= 5) {
          if (prompt.from === "deck") p.deck.push(uid);
          else if (prompt.from === "archive") p.archive.push(uid);
          else if (prompt.from === "hand") p.hand.push(uid);
          movedUids = movedUids.filter((picked) => picked !== uid);
          log(
            s,
            pid,
            `ステージが満杯のため${cardOf(s, uid).name}は元の領域に残りました`,
          );
          continue;
        }
        const played = newStack(s, uid, s.turn);
        p.back.push(played);
        prompt.ctx.boundStackId ??= played.id;
        prompt.ctx.boundStackIds.push(played.id);
        log(
          s,
          pid,
          `${cardOf(s, uid).name}をバック${p.back.length}に出しました`,
        );
        enteredOps.push(...collectAllyPlayedOps(s, pid, played));
      }
      prompt.ctx.rest.unshift(...enteredOps);
      break;
    }
    case "cheerDeck": {
      // エールは所有者のエールデッキ(下)に戻す (相手のエールを戻す効果に対応)
      const ownerP = s.players[prompt.yellOwner ?? pid];
      ownerP.cheerDeck.push(...uids);
      if (uids.length > 0) log(s, pid, `${names}をエールデッキに戻しました`);
      break;
    }
    case "deck":
      p.deck.push(...uids);
      if (uids.length > 0) log(s, pid, `${names}をデッキに戻しました`);
      break;
    case "deckBottom":
      p.deck.push(...uids);
      if (uids.length > 0) {
        if (prompt.revealSelection)
          log(s, pid, `${names}を公開し、デッキの下に戻しました`);
        else log(s, pid, `${uids.length}枚をデッキの下に戻しました`);
      }
      break;
    case "deckTop":
      p.deck.unshift(...uids);
      if (uids.length > 0) {
        if (prompt.revealSelection)
          log(s, pid, `${names}を公開し、デッキの上に戻しました`);
        else log(s, pid, `${uids.length}枚をデッキの上に戻しました`);
      }
      break;
    case "holoPower":
      for (const uid of uids) p.holoPower.unshift(uid);
      if (uids.length > 0)
        log(s, pid, `${uids.length}枚をホロパワーにしました`);
      break;
    case "archive": {
      // 相手の付与サポート等は持ち主のアーカイブに置く
      // カードは持ち主のアーカイブへ置く。相手のエール・付与サポートを
      // アーカイブする効果で、自分のアーカイブへ入れてはいけない
      const destP =
        prompt.from === "stageSupports"
          ? s.players[prompt.supportOwner ?? pid]
          : prompt.from === "stageYells"
            ? s.players[prompt.yellOwner ?? pid]
            : p;
      const redirected = new Set(redirectedSupports.map((x) => x.uid));
      const archived = uids.filter((uid) => !redirected.has(uid));
      movedToArchiveUids = archived;
      destP.archive.push(...archived);
      if (prompt.from === "deck") countDeckArchived(s, pid, archived.length);
      if (archived.length > 0) {
        log(
          s,
          pid,
          `${archived.map((u) => cardLogLabel(s, u)).join("、")}をアーカイブしました`,
        );
        if (prompt.from === "stageYells") {
          const yellOwner = prompt.yellOwner ?? pid;
          s.stageYellArchivedThisTurn[yellOwner] = true;
          queueYellArchivedReactive(s, prompt.ctx, archived);
          // エールの持ち主側にある「自分のエールがアーカイブに置かれた時」を
          // 誘発させる。相手の効果でアーカイブされた場合も持ち主を取り違えない。
          prompt.ctx.rest.unshift(
            ...collectYellArchivedTriggerOps(s, yellOwner),
          );
        }
      }
      break;
    }
    case "bloom": {
      // 選んだホロメンを ctx.boundStackId のホロメンに重ねてBloomする (効果Bloom)
      const uid = uids[0];
      const bound = prompt.ctx.boundStackId
        ? findStackById(s, prompt.ctx.boundStackId)
        : null;
      if (uid && bound) {
        const st = bound.stack;
        const prevTop = topCard(s, st);
        const prevLevel = prevTop.bloomLevel;
        const prevBuzz = prevTop.cardType === "holomen" && prevTop.buzz;
        const nc = holomenOf(s, uid);
        resetHolomenCardUsage(s, uid);
        st.cards.unshift(uid);
        st.bloomedFromLevelThisTurn = prevLevel;
        st.bloomedThisTurn = true;
        s.bloomedCardUidsThisTurn[pid].push(uid);
        if (prompt.from === "archive")
          (s.archiveBloomedThisTurn ??= [false, false])[pid] = true;
        log(
          s,
          pid,
          `効果により${positionedHolomenName(s, bound.pos, st)}にBloomしました`,
        );
        const abilities = collectBloomTriggerAbilities(
          s,
          pid,
          st,
          nc,
          prevLevel,
          prevBuzz,
          prompt.ctx.originOshiSkill,
        );
        prompt.ctx.bloomedFromDebut = prevLevel === "Debut";
        prompt.ctx.bloomedFromBuzz = prevBuzz;
        if (prompt.ctx.originOshiSkill) {
          prompt.ctx.bloomedByOshiSkill = {
            ...prompt.ctx.originOshiSkill,
            stackId: st.id,
          };
        }
        prompt.ctx.rest.unshift(
          { t: "enforceSupportLimits", stackId: st.id },
          { t: "runTriggerAbilities", player: pid, abilities, defer: true },
        );
      }
      break;
    }
    case "cheerAssign": {
      // 一括送付中は誘発を待機させ、最後の送付・残りカード返却後に続きを再開する。
      uids.forEach((yellUid, i) => {
        pushPrompt(s, {
          type: "cheerAssign",
          player: pid,
          yellUid,
          reason: "effect",
          filter: prompt.cheerTargetGroups?.[i] ?? prompt.targetFilter,
          targetPlayer: prompt.cheerTargetPlayer,
          perTargetMax: prompt.perTargetMax,
          sameTarget: prompt.sameTarget,
          distinctTargets: prompt.distinctCheerTargets,
          originStackId: yellOrigins[yellUid],
          excludedTargetStackIds:
            prompt.from === "downed" && prompt.ctx.downedStackId !== undefined
              ? [prompt.ctx.downedStackId]
              : prompt.from === "stageYells" &&
                  isYellTransferOnlySupport(s, prompt.ctx)
                ? [yellOrigins[yellUid]]
                : undefined,
          ctx: prompt.ctx,
          resume: i === uids.length - 1 && !queuesOrderPrompt,
        });
      });
      if (uids.length > 0) {
        if (prompt.revealSelection === false)
          logPrivate(
            s,
            pid,
            `${names}を選びました`,
            `${uids.length}枚を選びました`,
          );
        else log(s, pid, `${names}を公開しました`);
        cheerAssignQueued = true;
      }
      break;
    }
    case "attach": {
      prompt.ctx.lastAttachedCount = 0;
      // 付けられる対象がいるカードだけ順に付与先を選ぶ
      const attachNames = prompt.targetFilter?.names;
      const excludeStackId =
        prompt.targetFilter?.excludeSource &&
        prompt.ctx?.sourceStackId !== undefined
          ? prompt.ctx.sourceStackId
          : undefined;
      const attachables: string[] = [];
      for (const uid of uids) {
        const c = cardOf(s, uid);
        const preview: Extract<Prompt, { type: "effectAttach" }> = {
          type: "effectAttach",
          player: pid,
          uid,
          targetNames: attachNames,
          targetFilter: prompt.targetFilter,
          excludeStackId,
          ctx: prompt.ctx,
        };
        const ok = c.cardType === "support" && hasAttachTarget(s, preview);
        if (ok) attachables.push(uid);
        else {
          if (!attachSource) p.archive.push(uid);
          movedUids = movedUids.filter((picked) => picked !== uid);
          log(
            s,
            pid,
            `${c.name}は付けられる対象がいないため${attachSource ? "元の領域に残りました" : "アーカイブしました"}`,
          );
        }
      }
      attachables.forEach((uid, i) => {
        pushPrompt(s, {
          type: "effectAttach",
          player: pid,
          uid,
          source: attachSource,
          sameTarget: prompt.sameTarget,
          targetNames: attachNames,
          targetFilter: prompt.targetFilter,
          excludeStackId,
          attachedFromHand:
            prompt.from === "hand" || prompt.from === "archive" || undefined,
          attachedFromArchive: prompt.from === "archive" || undefined,
          // 全プロンプトで同じctxに成功枚数を記録し、最後だけ後続Opを再開する。
          ctx: prompt.ctx,
          resume: !queuesOrderPrompt && i === attachables.length - 1,
        });
      });
      if (attachables.length > 0) {
        if (prompt.revealSelection === false)
          logPrivate(
            s,
            pid,
            `${names}を選びました`,
            `${uids.length}枚を選びました`,
          );
        else log(s, pid, `${names}を公開しました`);
        cheerAssignQueued = true;
      }
      break;
    }
  }

  // 残り(見せたが選ばなかったカード)の扱い
  if (queuesOrderPrompt) {
    pushPrompt(s, {
      type: "effectPickCard",
      player: pid,
      uids: restForOrder,
      pickMin: restForOrder.length,
      pickMax: restForOrder.length,
      dest: prompt.restTo === "bottom" ? "deckBottom" : "deckTop",
      restTo: "none",
      from: prompt.from,
      orderOnly: prompt.restTo === "bottom" ? "bottom" : "top",
      orderMatters: true,
      orderLabel: `残りのカードを${prompt.restTo === "bottom" ? "上から下" : "上に置く順"}に選んでください`,
      preservePickedCards: true,
      revealAll: prompt.revealAll,
      ctx: prompt.ctx,
    });
    cheerAssignQueued = true;
  } else if (prompt.restTo !== "none") {
    const rest = prompt.uids.filter((u) => !uids.includes(u));
    const zoneName =
      prompt.from === "cheer"
        ? "エールデッキ"
        : prompt.from === "holo"
          ? "ホロパワー"
          : "デッキ";
    if (prompt.from === "deck")
      p.deck = p.deck.filter((u) => !rest.includes(u));
    if (prompt.from === "cheer")
      p.cheerDeck = p.cheerDeck.filter((u) => !rest.includes(u));
    if (prompt.from === "holo")
      p.holoPower = p.holoPower.filter((u) => !rest.includes(u));
    const zone =
      prompt.from === "cheer"
        ? p.cheerDeck
        : prompt.from === "holo"
          ? p.holoPower
          : p.deck;
    if (prompt.restTo === "bottom") {
      zone.push(...rest);
      if (rest.length > 0)
        log(s, pid, `残り${rest.length}枚を${zoneName}の下に戻しました`);
    } else if (prompt.restTo === "top") {
      zone.unshift(...rest);
      if (rest.length > 0)
        log(s, pid, `残り${rest.length}枚を${zoneName}の上に戻しました`);
    } else if (prompt.restTo === "archive") {
      p.archive.push(...rest);
      if (prompt.from === "deck") countDeckArchived(s, pid, rest.length);
      if (rest.length > 0)
        log(s, pid, `残り${rest.length}枚をアーカイブしました`);
    }
  }

  if (prompt.shuffleAfter === "deck") {
    p.deck = shuffle(p.deck);
    log(s, pid, "デッキをシャッフルしました");
  } else if (prompt.shuffleAfter === "cheer") {
    p.cheerDeck = shuffle(p.cheerDeck);
    log(s, pid, "エールデッキをシャッフルしました");
  } else if (prompt.shuffleAfter === "holo") {
    p.holoPower = shuffle(p.holoPower);
    log(s, pid, "ホロパワーをシャッフルしました");
  }

  // 後続の「戻したホロメンX枚につき」等が参照できるよう選んだカードを記録
  if (!prompt.preservePickedCards) {
    prompt.ctx.pickedCards = [...movedUids];
    const fromPublic = [
      "archive",
      "stageYells",
      "stageSupports",
      "stacked",
      "downed",
    ].includes(prompt.from);
    const publicSelection =
      fromPublic ||
      prompt.revealAll ||
      (["deckTop", "deckBottom", "holoPower"].includes(prompt.dest)
        ? prompt.revealSelection === true
        : prompt.revealSelection !== false);
    prompt.ctx.pickedCardsOwnerOnly = !publicSelection;
    prompt.ctx.pickedCardsOwner = pid;
  }
  // アーカイブ行きの選択は「アーカイブしたカード/エールX枚につき」の参照用に記録
  if (prompt.dest === "archive") prompt.ctx.milled = [...movedToArchiveUids];
  prompt.ctx.rest.unshift(
    ...redirectedSupports.map(
      (r): Op => ({
        t: "archiveRedirect",
        ...r,
        recordArchived: true,
      }),
    ),
  );
  if (!cheerAssignQueued) runOps(s, prompt.ctx);
  advance(s);
}

/** 同時付与の結果を次の選択へ引き継ぐ。JSON経由ではctxの参照共有が失われる。 */
function carryAttachmentContext(
  s: GameState,
  prompt: Extract<Prompt, { type: "effectAttach" }>,
): void {
  if (!prompt.ctx || prompt.resume !== false) return;
  const next = s.prompts[0];
  if (
    next?.player === prompt.player &&
    (next.type === "effectAttach" ||
      (next.type === "effectPickCard" && next.orderOnly))
  )
    next.ctx = prompt.ctx;
}

/**
 * 付け先がなくなった effectAttach プロンプトを取り除く。
 * 複数枚をまとめて付ける効果は付与先を先に予約しないため、1枚目を付けた結果
 * (マスコットは1人1枚等) 2枚目の付け先が消えることがある。付けられないカードは
 * 元の領域に残す。解決領域にある場合のみアーカイブする (5.17.3.4)。
 */
function dropUnattachablePrompts(s: GameState): void {
  while (s.prompts[0]?.type === "effectAttach") {
    const prompt = s.prompts[0];
    if (hasAttachTarget(s, prompt)) return;
    s.prompts.shift();
    if (!prompt.source) s.players[prompt.player].archive.push(prompt.uid);
    log(
      s,
      prompt.player,
      `${cardOf(s, prompt.uid).name}は付けられる対象がいないため${prompt.source ? "元の領域に残りました" : "アーカイブしました"}`,
    );
    if (prompt.ctx && prompt.resume !== false) {
      runOps(s, prompt.ctx);
      return;
    }
    carryAttachmentContext(s, prompt);
  }
}

export function resolveEffectAttach(
  s: GameState,
  pid: PlayerId,
  pos: StagePosition,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "effectAttach" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  const p = s.players[pid];
  const st = getStack(p, pos);
  if (!st) throw new Error("そこにホロメンがいません");
  const c = cardOf(s, prompt.uid);
  if (c.cardType !== "support") throw new Error("付けられないカードです");
  const err = effectAttachTargetError(s, prompt, pos, st, c);
  if (err) throw new Error(err);
  if (prompt.source) {
    const zone = s.players[prompt.source.player][prompt.source.zone];
    const index = zone.indexOf(prompt.uid);
    if (index < 0) throw new Error("付けるカードが元の領域にありません");
    zone.splice(index, 1);
    resetAttachedCardUsage(s, prompt.uid);
  }
  s.prompts.shift();
  st.supports.push(prompt.uid);
  log(
    s,
    pid,
    `${c.name}を${posLabel(pos)}の${topCard(s, st).name}に付けました`,
  );
  if (prompt.ctx) {
    // 「付けたなら、そのホロメンの〜」が付け先を参照できるよう記録
    prompt.ctx.attachedToStackId = st.id;
    (prompt.ctx.attachedToStackIds ??= []).push(st.id);
    prompt.ctx.lastAttachedCount = (prompt.ctx.lastAttachedCount ?? 0) + 1;
    const attachedOps: Op[] = [];
    if (prompt.attachedFromHand) {
      const entry = findStackById(s, st.id);
      if (entry) {
        const abilities = collectTriggerAbilities(
          s,
          entry,
          ["attachedFromHand"],
          prompt.uid,
          prompt.attachedFromArchive ? "archive" : "hand",
        );
        if (abilities.length > 0)
          attachedOps.push({
            t: "runTriggerAbilities",
            player: pid,
            abilities,
            defer: true,
          });
      }
    }
    attachedOps.push(...collectSupportAttachedOps(s, pid, st, prompt.uid));
    prompt.ctx.rest.unshift(...attachedOps);
    if (prompt.resume !== false) runOps(s, prompt.ctx);
    else carryAttachmentContext(s, prompt);
  } else {
    const entry = findStackById(s, st.id);
    const abilities =
      prompt.attachedFromHand && entry
        ? collectTriggerAbilities(
            s,
            entry,
            ["attachedFromHand"],
            prompt.uid,
            prompt.attachedFromArchive ? "archive" : "hand",
          )
        : [];
    const rest: Op[] = [];
    if (abilities.length > 0)
      rest.push({ t: "continueTriggerAbilities", abilities });
    rest.push(...collectSupportAttachedOps(s, pid, st, prompt.uid));
    if (rest.length > 0)
      runOps(s, {
        player: pid,
        sourceStackId: st.id,
        rest,
        label: "サポート付与時能力",
      });
  }
  // 今の付与で枠が埋まり、後続の付与先がなくなっていることがある
  dropUnattachablePrompts(s);
  advance(s);
}

/** サイコロ演出の完了後に保留していた効果解決を再開する */
export function resolveAnimationDelay(s: GameState, pid: PlayerId): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "animationDelay" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  s.prompts.shift();
  if (prompt.resume) runOps(s, prompt.ctx);
  advance(s);
}

/** サイコロの目の宣言プロンプトの解決 (次に出る目を宣言した目として扱う) */
export function resolveDeclareDice(
  s: GameState,
  pid: PlayerId,
  value: number,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "declareDice" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  if (!Number.isInteger(value) || value < 1 || value > 6)
    throw new Error("1〜6の目を宣言してください");
  s.prompts.shift();
  s.diceMods.push({ player: pid, value, once: true, expiresTurn: s.turn });
  log(s, pid, `サイコロの目の宣言: 次に出る目を【${value}】として扱います`);
  runOps(s, prompt.ctx);
  advance(s);
}

const JANKEN_LABELS: Record<JankenHand, string> = {
  rock: "グー",
  scissors: "チョキ",
  paper: "パー",
};

/** つのまきじゃんけんの手を受け付け、両者の選択後に同時公開して解決する。 */
export function resolveJankenHand(
  s: GameState,
  pid: PlayerId,
  hand: JankenHand,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "jankenHand" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  if (!(hand in JANKEN_LABELS))
    throw new Error("じゃんけんの手を選んでください");
  s.prompts.shift();

  if (pid === prompt.initiator) {
    pushPrompt(s, {
      ...prompt,
      player: other(prompt.initiator),
      initiatorHand: hand,
    });
    advance(s);
    return;
  }

  const mine = prompt.initiatorHand;
  if (!mine) throw new Error("先に選ばれた手を確認できません");
  const tied = mine === hand;
  log(
    s,
    prompt.initiator,
    `${prompt.ctx.label}: じゃんけん → 自分【${JANKEN_LABELS[mine]}】 相手【${JANKEN_LABELS[hand]}】${tied ? " (あいこ)" : ""}`,
  );
  if (tied) {
    pushPrompt(s, {
      type: "jankenHand",
      player: prompt.initiator,
      initiator: prompt.initiator,
      winOps: prompt.winOps,
      ctx: prompt.ctx,
    });
    advance(s);
    return;
  }

  const won =
    (mine === "rock" && hand === "scissors") ||
    (mine === "scissors" && hand === "paper") ||
    (mine === "paper" && hand === "rock");
  log(
    s,
    prompt.initiator,
    `${prompt.ctx.label}: じゃんけんに${won ? "勝ちました" : "負けました"}`,
  );
  if (won) prompt.ctx.rest.unshift(...structuredClone(prompt.winOps));
  runOps(s, prompt.ctx);
  advance(s);
}

/** UI・通信境界・解決器で共用する、手札アーカイブ選択の純粋な合法性検査。 */
export function effectArchiveHandSelectionError(
  s: GameState,
  pid: PlayerId,
  prompt: Extract<Prompt, { type: "effectArchiveHand" }>,
  uids: readonly string[],
): string | null {
  const max = prompt.countMax ?? prompt.count;
  if (uids.length < prompt.count || uids.length > max)
    return prompt.count === max
      ? `手札から${prompt.count}枚選んでください`
      : `手札から${prompt.count}〜${max}枚選んでください`;
  if (new Set(uids).size !== uids.length)
    return "同じカードを複数回選ぶことはできません";
  const p = s.players[pid];
  if (!uids.every((u) => p.hand.includes(u)))
    return "手札にないカードが含まれています";
  if (prompt.eligible && !uids.every((u) => prompt.eligible!.includes(u)))
    return "この効果で選べないカードが含まれています";
  if (prompt.sameTag && uids.length > 1) {
    const shared = uids
      .map((u) => {
        const c = cardOf(s, u);
        return "tags" in c ? c.tags : [];
      })
      .reduce((acc, tags) => acc.filter((t) => tags.includes(t)));
    if (shared.length === 0) return "同じタグを持つカード同士を選んでください";
  }
  return null;
}

export function resolveEffectArchiveHand(
  s: GameState,
  pid: PlayerId,
  uids: string[],
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "effectArchiveHand" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  const selectionError = effectArchiveHandSelectionError(s, pid, prompt, uids);
  if (selectionError) throw new Error(selectionError);
  const p = s.players[pid];
  s.prompts.shift();
  p.hand = p.hand.filter((u) => !uids.includes(u));
  p.archive.push(...uids);
  // 後続の「アーカイブしたカードX枚につき」等が参照できるよう記録
  prompt.ctx.milled = [...(prompt.ctx.replacementArchived ?? []), ...uids];
  prompt.ctx.replacementArchived = undefined;
  log(s, pid, `手札${uids.length}枚をアーカイブしました`);
  const source = prompt.ctx.sourceStackId
    ? findStackById(s, prompt.ctx.sourceStackId)
    : null;
  if (uids.length > 0 && source?.player === pid)
    prompt.ctx.rest.unshift({
      t: "runTriggerAbilities",
      player: pid,
      abilities: collectTriggerAbilities(s, source, ["handArchived"]),
      defer: true,
    });
  runOps(s, prompt.ctx);
  advance(s);
}

export function resolveEffectConfirm(
  s: GameState,
  pid: PlayerId,
  yes: boolean,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "effectConfirm" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  s.prompts.shift();
  finishIncomingDamageReplacement(prompt.ctx, prompt.damageReplacementId);
  if (yes) prompt.ctx.rest.unshift(...prompt.thenOps);
  else if (prompt.elseOps) prompt.ctx.rest.unshift(...prompt.elseOps);
  else log(s, pid, "効果の使用を見送りました");
  runOps(s, prompt.ctx);
  advance(s);
}
