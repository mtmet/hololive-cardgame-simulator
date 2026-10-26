// ゲーム状態とルールの処理：resolution。
import { cardNames, getCard } from "../../data/loader";
import type {
  OshiCard,
  YellCard,
  SupportCard,
  HolomenCard,
} from "../../data/types";
import {
  parsePlayConditions,
  parseEffect,
  parseSupportUseLimit,
  parseOshiReactive,
  parseOshiConditional,
  parseOshiAdditionalCost,
  parseArtGates,
} from "../effects";
import type {
  TriggerAbility,
  Op,
  TargetFilter,
  PlayCondition,
  GiftDef,
  PassiveBonus,
  StackTarget,
  CardFilter,
} from "../effects";
import type {
  GameState,
  PlayerId,
  StagePosition,
  HolomenStack,
  PlayerState,
  EffectContextData,
  Prompt,
  TurnEffectDuration,
  DamageReplacementChoice,
  DiceResultSummary,
  RuleDownAbility,
  RuleDownCause,
} from "../types";
import {
  queueFxWaitMarker,
  consumeFxWait,
  queueDiceAnimationDelay,
} from "./animation";
import {
  stackColors,
  stackNames,
  hasNoSwitch,
  giftOf,
  evalCond,
  stackMatchesFilter,
  matchesPosition,
  triggerFires,
  batonCostOf,
  cardHasName,
  passiveOf,
  cardMatchesFilter,
  stageNamedCardCount,
  yellOnIs,
  targetCandidates,
  isSpecialImmune,
  isDamageImmune,
  damageTakenDeltaOf,
  stageSupportUidsNamed,
  oshiSkillAdjustments,
  oshiSkillUseCount,
  giftPositionOk,
  passiveCondMatches,
  availableArts,
  stackBloomLevels,
  effectiveMaxHp,
  distinctHolomenNameCount,
  yellColorsOn,
  hasDiffColorFromOwnerOshi,
  availableArtRefs,
  stackRealColors,
  isArtImmune,
  artBonusOf,
  turnEffectActive,
  triggerDefOps,
} from "./conditions";
import {
  cheerOriginStackId,
  cheerAssignCandidates,
  canPayOptionalCost,
  archiveStageYellCandidates,
  activatedCostPayable,
  canPayArtCost,
  artCostCheck,
  stageYellCount,
  yellArchiveSubUids,
  archiveHandEligible,
  stackedCostCandidates,
  archiveHandHoloReplacement,
  archiveHandMinHoloForReplacement,
  sameTagPayable,
} from "./costs";
import {
  cardLogLabel,
  log,
  logDraw,
  logPrivate,
  logDice,
  logEffect,
  logTurnStart,
} from "./logging";
import { pushPrompt, engineObserver, shuffle, gameRandom } from "./runtime";
import {
  cardOf,
  getStack,
  findStackById,
  allStacks,
  positionedHolomenName,
  topCard,
  other,
  posLabel,
  playerName,
  stageCount,
  sourceHolomen,
  isSupportAbilitySource,
} from "./state";
import {
  collectTriggerAbilities,
  collectStepTriggerAbilities,
  collectSelfEndStepStartAbilities,
  usableOshiReactives,
  collectAllyPlayedOps,
  collectSupportAttachedOps,
  collectYellArchivedTriggerAbilities,
  collectReturnedToDeckAbilities,
  collectOshiSkillUsedAbilities,
  collectYellArchivedTriggerOps,
  collectOshiStageActionAbilities,
  usableOshiReactive,
  collectOshiStageTriggerAbilities,
  collectAllyArtUsedAbilities,
  collectAllyDamagedAbilities,
  collectAllyDealtSpecialAbilities,
  collectTriggerOps,
} from "./triggers";
import type {
  GiftAbilityOption,
  GiftAbilityRef,
  PendingIncomingDamage,
  UsableOshiReactive,
  DiceOp,
} from "./types";

/** 10.12.1：最終情報を、手札・山札へ移った実UIDと結び付けずに保存する。 */
export function rememberHolomen(
  s: GameState,
  player: PlayerId,
  pos: StagePosition,
  stack: HolomenStack,
): void {
  if (!stack.cards.length || stack.faceDown) return;
  const snapshot = structuredClone(stack);
  const colors = [...stackColors(s, stack)];
  const cardIds: string[] = [];
  let index = 0;
  for (const field of ["cards", "yells", "supports"] as const)
    snapshot[field] = stack[field].map((uid) => {
      const reference = `last-known:${stack.id}:${index++}`;
      cardIds.push(cardOf(s, uid).id);
      return reference;
    });
  (s.lastKnownHolomen ??= {})[stack.id] = {
    player,
    pos: structuredClone(pos),
    stack: snapshot,
    colors,
    bloomLevels: stackBloomLevels(s, stack),
    cardIds,
  };
}

function removeStack(
  s: GameState,
  p: PlayerState,
  pos: StagePosition,
): HolomenStack | null {
  const st = getStack(p, pos);
  if (st) rememberHolomen(s, s.players[0] === p ? 0 : 1, pos, st);
  if (pos === "center") p.center = null;
  else if (pos === "collab") p.collab = null;
  else p.back.splice(pos.back, 1);
  return st;
}

/**
 * ダウン時の「重なりを手札に戻す」でホロメンが1枚も残らなかったスタックを
 * ステージから外す。空のスタックを置いたままにすると、トップカードを見る
 * 処理 (effectiveMaxHp / giftOf 等) が壊れる。
 * ステージを離れた時点で、残るエール・サポートをアーカイブする (4.4.7)。
 * 後続のダウン時能力も、移動後の実際の領域から付与カードを回収できる。
 */
export function dropIfEmptyStack(
  s: GameState,
  stackId: number,
  ctx: EffectContextData,
  yellAbilities: TriggerAbility[],
): void {
  const live = findStackById(s, stackId);
  if (!live || live.stack.cards.length > 0) return;
  removeStack(s, s.players[live.player], live.pos);
  const redirected: Op[] = [];
  const archivedSupports: string[] = [];
  for (const uid of live.stack.supports) {
    const targetNames = archiveRedirectTargets(s, live.player, uid, live.pos);
    if (targetNames)
      redirected.push({
        t: "archiveRedirect",
        owner: live.player,
        uid,
        targetNames,
      });
    else archivedSupports.push(uid);
  }
  s.players[live.player].archive.push(...live.stack.yells, ...archivedSupports);
  if (live.stack.yells.length > 0)
    s.stageYellArchivedThisTurn[live.player] = true;
  s.turnModifiers = s.turnModifiers.filter((m) => m.stackId !== stackId);
  ctx.rest.unshift(
    ...redirected,
    ...(yellAbilities.length > 0
      ? [
          {
            t: "runTriggerAbilities" as const,
            player: live.player,
            abilities: yellAbilities,
            defer: true,
          },
        ]
      : []),
  );
}

// ------------------------------------------------------------
// ターン進行 (7章)
// ------------------------------------------------------------

export function advance(s: GameState): void {
  while (s.phase === "playing" && s.prompts.length === 0) {
    switch (s.step) {
      case "reset": {
        // 各プレイヤーの最初のターンはリセットを飛ばす (7.2.1 / Q391)。
        // 追加ターンがあるため、対局全体のターン数では判定できない。
        if (s.turnsStarted[s.turnPlayer] > 1) {
          const p = s.players[s.turnPlayer];
          if (s.resetActionsDoneTurn !== s.turn) {
            const resetOshi = cardOf(s, p.oshiUid) as OshiCard;
            for (const { pos, stack } of allStacks(p)) {
              if (
                resetOshi.stageOshiSkill?.name === "Justiceの古代自動人形" &&
                stackNames(s, stack).includes("セシリア・イマーグリーン")
              ) {
                log(
                  s,
                  s.turnPlayer,
                  positionedHolomenName(s, pos, stack) +
                    "は推しステージスキルによりアクティブになりません",
                );
                continue;
              }
              // 「次の相手のリセットステップでアクティブにならない」効果 (消費型)
              if (s.skipResetActivate.includes(stack.id)) {
                log(
                  s,
                  s.turnPlayer,
                  `${positionedHolomenName(s, pos, stack)}は効果によりアクティブになりません`,
                );
                continue;
              }
              stack.resting = false;
            }
            s.skipResetActivate = s.skipResetActivate.filter(
              (id) => !allStacks(p).some((e) => e.stack.id === id),
            );
            if (p.collab && !hasNoSwitch(s, p.collab)) {
              // ギフト「(条件の時、)このホロメンはバックポジションに移動してもお休みしない」
              const collabGift = giftOf(topCard(s, p.collab));
              const giftNoRest =
                !!collabGift.noRestOnMove &&
                (!collabGift.noRestOnMove.cond ||
                  evalCond(
                    s,
                    {
                      player: s.turnPlayer,
                      sourceStackId: p.collab.id,
                      rest: [],
                      label: "",
                    },
                    collabGift.noRestOnMove.cond,
                  ));
              const noRest =
                giftNoRest ||
                s.noRestResetStackIds[s.turnPlayer].includes(p.collab.id);
              p.back.push(p.collab);
              // 「お休みしない」は新たにお休みにする処理を省略するだけ。
              // ドッキリうさぎ等でアクティブにならなかった場合は、元の状態を保つ。
              if (!noRest) p.collab.resting = true;
              p.collab = null;
              log(
                s,
                s.turnPlayer,
                noRest
                  ? "コラボホロメンをバックに移動しました (能力によりお休みしない)"
                  : "コラボホロメンをバックに移動してお休みさせました",
              );
            }
            if (p.collab && hasNoSwitch(s, p.collab))
              log(
                s,
                s.turnPlayer,
                "コラボホロメンは効果によりバックへ移動できません",
              );
            s.resetActionsDoneTurn = s.turn;
          }
          // 7.2.5: 期限切れで最大HPが下がった場合も、センター選択・手札ステップ前に処理する。
          // 入力待ちから戻っても、上のアクティブ化とコラボ移動は一度だけ。
          runOps(s, {
            player: s.turnPlayer,
            rest: [{ t: "checkRuleTiming" }],
            label: "リセットステップのチェックタイミング",
          });
          if (s.phase !== "playing" || s.prompts.length > 0) return;
          if (!p.center && p.back.length > 0) {
            if (!pickCenter(s, s.turnPlayer, "reset")) return;
          }
        }
        s.step = "draw";
        break;
      }
      case "draw": {
        const p = s.players[s.turnPlayer];
        if (p.deck.length === 0) {
          setWinner(
            s,
            other(s.turnPlayer),
            `${p.name}はデッキからカードを引けませんでした`,
          );
          return;
        }
        p.hand.push(p.deck.shift()!);
        logDraw(s, s.turnPlayer, "手札ステップ: 1枚ドローしました", 1);
        s.step = "cheer";
        break;
      }
      case "cheer": {
        const p = s.players[s.turnPlayer];
        if (p.cheerDeck.length > 0 && allStacks(p).length > 0) {
          const yellUid = p.cheerDeck.shift()!;
          log(
            s,
            s.turnPlayer,
            `エールステップ: ${cardLogLabel(s, yellUid)}を公開しました`,
          );
          pushPrompt(s, {
            type: "cheerAssign",
            player: s.turnPlayer,
            yellUid,
            reason: "cheerStep",
          });
          // 送付が完了するまでステップ表示は「エール」のまま
          // (resolveCheerAssign が step を進める)
          return;
        }
        if (p.cheerDeck.length === 0) {
          log(
            s,
            s.turnPlayer,
            "エールデッキが0枚のためエールステップをスキップします",
          );
        }
        s.step = "main";
        break;
      }
      case "main":
      case "performance":
        return;
      case "end": {
        const p = s.players[s.turnPlayer];
        if (!p.center && p.back.length > 0) {
          if (!pickCenter(s, s.turnPlayer, "end")) return;
        }
        log(s, s.turnPlayer, "エンドステップ: ターンを終了します");
        nextTurn(s);
        break;
      }
    }
  }
}

function pickCenter(
  s: GameState,
  pid: PlayerId,
  reason: "reset" | "end",
): boolean {
  const p = s.players[pid];
  const movable = p.back
    .map((st, i) => ({ st, i }))
    .filter(({ st }) => !hasNoSwitch(s, st));
  const active = movable.filter(({ st }) => !st.resting);
  const candidates = active.length > 0 ? active : movable;
  if (candidates.length === 0) return true;
  if (candidates.length === 1) {
    moveBackToCenter(s, pid, candidates[0].i);
    return true;
  }
  pushPrompt(s, { type: "chooseCenter", player: pid, reason });
  return false;
}

function moveBackToCenter(s: GameState, pid: PlayerId, backIndex: number) {
  const p = s.players[pid];
  const st = p.back.splice(backIndex, 1)[0];
  p.center = st;
  log(
    s,
    pid,
    `バック${backIndex + 1}の${topCard(s, st).name}をセンターポジションに移動しました`,
  );
}

export function resolveChooseCenter(
  s: GameState,
  pid: PlayerId,
  backIndex: number,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "chooseCenter" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  const p = s.players[pid];
  const st = p.back[backIndex];
  if (!st) throw new Error("バックホロメンが見つかりません");
  if (hasNoSwitch(s, st))
    throw new Error("このホロメンは効果により移動できません");
  const hasActive = p.back.some((b) => !b.resting && !hasNoSwitch(s, b));
  if (hasActive && st.resting)
    throw new Error("お休みしていないホロメンを選ぶ必要があります");
  s.prompts.shift();
  moveBackToCenter(s, pid, backIndex);
  // リセットステップの処理は選択待ちに入る前に完了している。
  // ここでresetへ戻ると、直前にコラボからバックへ移動してお休みした
  // ホロメンまで再度アクティブになってしまうため、ドローステップから再開する。
  if (prompt.reason === "reset") s.step = "draw";
  advance(s);
}

export function resolveCheerAssign(
  s: GameState,
  pid: PlayerId,
  pos: StagePosition,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "cheerAssign" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  // 送付先のホロメンを持つプレイヤー (省略時は操作プレイヤー自身)
  const targetP = s.players[prompt.targetPlayer ?? pid];
  const st = getStack(targetP, pos);
  if (!st) throw new Error("そこにホロメンがいません");
  if (prompt.excludedTargetStackIds?.includes(st.id))
    throw new Error("この効果では別のホロメンを選んでください");
  if (
    prompt.filter?.excludeYellOrigin &&
    st.id === cheerOriginStackId(s, prompt)
  )
    throw new Error("エールの元の保持者以外に付け替えてください");
  if (
    prompt.requiredTargetStackId !== undefined &&
    st.id !== prompt.requiredTargetStackId
  )
    throw new Error("この効果で最初に選んだホロメンに送ってください");
  if (prompt.filter && !stackMatchesFilter(s, st, prompt.filter))
    throw new Error("この効果の対象条件を満たしていません");
  if (prompt.filter?.position && !matchesPosition(pos, prompt.filter.position))
    throw new Error("この効果の対象条件を満たしていません");
  if (prompt.frontOnly && pos !== "center" && pos !== "collab")
    throw new Error("センターかコラボのホロメンに送ってください");
  if (
    prompt.filter?.excludeSource &&
    prompt.ctx?.sourceStackId !== undefined &&
    st.id === prompt.ctx.sourceStackId
  )
    throw new Error("このホロメン以外に送ってください");
  if (
    prompt.filter?.sourceOnly &&
    prompt.ctx?.sourceStackId !== undefined &&
    st.id !== prompt.ctx.sourceStackId
  )
    throw new Error("この効果の発生源のホロメンに送ってください");
  if (prompt.filter?.boundOnly && prompt.ctx) {
    const ids =
      prompt.ctx.boundStackIds && prompt.ctx.boundStackIds.length > 0
        ? prompt.ctx.boundStackIds
        : prompt.ctx.boundStackId
          ? [prompt.ctx.boundStackId]
          : [];
    if (!ids.includes(st.id))
      throw new Error("この効果で選んだホロメンに送ってください");
  }
  if (prompt.perTargetMax !== undefined) {
    const counts = { ...(prompt.sentCounts ?? {}) };
    if ((counts[st.id] ?? 0) >= prompt.perTargetMax)
      throw new Error(
        `同じホロメンには${prompt.perTargetMax}枚までしか送れません`,
      );
    counts[st.id] = (counts[st.id] ?? 0) + 1;
    // 同じ効果の後続の送付プロンプトへ枚数を引き継ぐ
    const next = s.prompts[1];
    if (next?.type === "cheerAssign" && next.perTargetMax !== undefined)
      next.sentCounts = counts;
  }
  if (prompt.sameTarget) {
    // 同じ効果で後続する送付すべてを、最初に選んだホロメンへ固定する。
    const next = s.prompts[1];
    if (next?.type === "cheerAssign" && next.sameTarget)
      next.requiredTargetStackId = st.id;
  }
  if (prompt.distinctTargets) {
    const next = s.prompts[1];
    if (next?.type === "cheerAssign" && next.distinctTargets)
      next.excludedTargetStackIds = [
        ...(prompt.excludedTargetStackIds ?? []),
        st.id,
      ];
  }
  s.prompts.shift();
  st.yells.push(prompt.yellUid);
  const yell = cardOf(s, prompt.yellUid) as YellCard;
  // 付け替えで元と同じホロメンを選んだ場合は「何もしない」ため、盤面を戻すだけで
  // 「エールが付いた時」は誘発しない (総合ルール5.17.4.1・1.3.2.1)。
  const unchanged = prompt.originStackId === st.id;
  log(
    s,
    pid,
    unchanged
      ? `${yell.name}は同じホロメンのため付け替えは行われませんでした`
      : `${yell.name}を${posLabel(pos)}の${topCard(s, st).name}に送りました`,
  );
  // エールステップの送付が完了したらメインステップへ
  if (prompt.reason === "cheerStep" && s.step === "cheer") s.step = "main";
  // 「このホロメンにエールが付いた時」付与トリガー
  const yellTrig: Op = {
    t: "runTriggerAbilities",
    player: prompt.targetPlayer ?? pid,
    abilities: unchanged
      ? []
      : collectTriggerAbilities(
          s,
          { player: prompt.targetPlayer ?? pid, pos, stack: st },
          ["yellAttached"],
        ),
    defer: true,
  };
  if (prompt.ctx) {
    if (prompt.nextTopCheer)
      prompt.ctx.rest.unshift({
        ...prompt.nextTopCheer,
        requiredTargetStackId: st.id,
      });
    if (!unchanged) {
      prompt.ctx.attachedToStackId = st.id;
      (prompt.ctx.attachedToStackIds ??= []).push(st.id);
      prompt.ctx.rest.unshift(yellTrig);
    }
    if (prompt.resume === false) {
      // JSON往復ではctxの共有参照が失われるため、更新済みの続きごと渡す。
      const next = s.prompts[0];
      if (
        next?.type === "cheerAssign" ||
        (next?.type === "effectPickCard" && next.orderOnly)
      )
        next.ctx = prompt.ctx;
    } else runOps(s, prompt.ctx);
  } else if (s.phase === "playing" && !unchanged) {
    runOps(s, { player: pid, rest: [yellTrig], label: "エール付与時能力" });
  }
  advance(s);
}

/** 1つのeffectPickCardから送れるエールの最大枚数。 */
export function cheerAssignCapacity(
  s: GameState,
  prompt: Extract<Prompt, { type: "cheerAssign" }>,
): number {
  const targets = cheerAssignCandidates(s, prompt);
  if (targets.length === 0) return 0;
  if (prompt.sameTarget) return prompt.perTargetMax ?? Number.POSITIVE_INFINITY;
  return prompt.perTargetMax === undefined
    ? Number.POSITIVE_INFINITY
    : targets.length * prompt.perTargetMax;
}

/** 対象条件の各枠へ、互いに異なる送り先を1人ずつ割り当てられるか。 */
export function distinctCheerTargetsPayable(
  s: GameState,
  player: PlayerId,
  groups: TargetFilter[],
  ctx: EffectContextData,
  targetPlayer?: PlayerId,
): boolean {
  const used = new Set<number>();
  const assign = (index: number): boolean => {
    if (index >= groups.length) return true;
    const candidates = cheerAssignCandidates(s, {
      type: "cheerAssign",
      player,
      yellUid: "",
      reason: "effect",
      filter: groups[index],
      targetPlayer,
      ctx,
    });
    for (const { stack } of candidates) {
      if (used.has(stack.id)) continue;
      used.add(stack.id);
      if (assign(index + 1)) return true;
      used.delete(stack.id);
    }
    return false;
  };
  return assign(0);
}

function turnEffectDuration(
  s: GameState,
  player: PlayerId,
  untilNextOppTurn?: boolean,
  onlyDuring = false,
): TurnEffectDuration {
  return untilNextOppTurn
    ? {
        nextOpponentTurn: {
          player: other(player),
          afterTurn: s.turn,
          onlyDuring,
        },
      }
    : { expiresTurn: s.turn };
}

function nextTurn(s: GameState) {
  // [ターンに1回] はターンごとにリセット (リアクティブスキルは相手ターンでも使うため両者)
  for (const p of s.players) {
    p.usedOshiSkillThisTurn = false;
    p.usedOshiSkillNamesThisTurn = [];
    p.usedSpOshiSkillThisTurn = false;
    p.usedLimitedThisTurn = false;
    p.limitedUsedCount = 0;
    p.limitedLimit = undefined;
    p.usedBatonTouchThisTurn = false;
    p.usedCollabThisTurn = false;
    p.usedCenterArtThisTurn = false;
    p.usedCollabArtThisTurn = false;
  }
  s.turnModifiers = s.turnModifiers.filter((m) =>
    m.nextOpponentTurn
      ? !(
          s.turn > m.nextOpponentTurn.afterTurn &&
          s.turnPlayer === m.nextOpponentTurn.player
        )
      : (m.expiresTurn ?? s.turn) > s.turn,
  );
  if (s.downRewards)
    s.downRewards = s.downRewards.filter((r) => r.expiresTurn > s.turn);
  // 「直前の相手のターン」は、そのプレイヤーの追加ターンでも保持する。
  const previousOpponent = other(s.turnPlayer);
  s.downsPrevTurn[previousOpponent] = s.downsThisTurn[previousOpponent];
  s.downsThisTurn = [0, 0];
  s.downedUidsPrevTurn[previousOpponent] = [
    ...s.downedUidsThisTurn[previousOpponent],
  ];
  s.downedUidsThisTurn = [[], []];
  s.diceMods = s.diceMods.filter((m) => m.expiresTurn > s.turn);
  s.usedTriggersThisTurn = {};
  s.usedSupportNamesThisTurn = [[], []];
  s.usedSupportTypesThisTurn = [[], []];
  s.usedSupportTagTypesThisTurn = [[], []];
  s.deckArchivedThisTurn = [0, 0];
  s.diceRollsThisTurn = [{}, {}];
  s.stageToDeckThisTurn = [false, false];
  s.stageYellArchivedThisTurn = [false, false];
  s.artUsesThisTurn = [[], []];
  s.bloomedCardUidsThisTurn = [[], []];
  s.archiveBloomedThisTurn = [false, false];
  for (const pl of s.players)
    for (const { stack } of allStacks(pl)) {
      stack.bloomedThisTurn = false;
      stack.bloomedFromLevelThisTurn = undefined;
      stack.usedArtsThisTurn = false;
    }
  // 追加ターンは最後に適用されたものから1つずつ実行する (5.26.2-5.26.3)
  const extraTurnPlayer = s.extraTurns.pop();
  if (extraTurnPlayer !== undefined) {
    s.turnPlayer = extraTurnPlayer;
    log(s, s.turnPlayer, "効果により、もう1回自分のターンを開始します");
  } else {
    s.turnPlayer = other(s.turnPlayer);
  }
  s.turn++;
  s.turnsStarted[s.turnPlayer]++;
  s.step = "reset";
  logTurnStart(s);
}

export function goPerformance(s: GameState): void {
  beginPerformance(s);
}

function beginPerformance(s: GameState, finishAfterStart = false): void {
  requireStep(s, "main");
  requireNoPrompt(s);
  if (s.turn === 1) {
    log(
      s,
      s.turnPlayer,
      "先攻の第1ターンのためパフォーマンスステップをスキップします",
    );
    runOps(s, {
      player: s.turnPlayer,
      rest: [{ t: "beginEndStep" }],
      label: "エンドステップ",
    });
    advance(s);
    return;
  }

  s.step = "performance";
  s.lifeAtPerfStart = [s.players[0].life.length, s.players[1].life.length];
  log(s, s.turnPlayer, "パフォーマンスステップを開始します");
  const turnAbilities = collectStepTriggerAbilities(
    s,
    s.turnPlayer,
    "selfPerfStepStart",
  );
  const turnOshi = cardOf(s, s.players[s.turnPlayer].oshiUid);
  const turnP = s.players[s.turnPlayer];
  if (
    turnOshi.cardType === "oshi" &&
    turnOshi.stageOshiSkill?.name === "魔性の再演" &&
    turnP.collab &&
    turnP.center?.bloomedThisTurn &&
    stackNames(s, turnP.center).includes("宝鐘マリン")
  ) {
    turnAbilities.push({
      id: `stageOshi:selfPerfStepStart:${s.turnPlayer}:${s.turn}`,
      label: "推しステージスキル「魔性の再演」",
      sourceStackId: turnP.center.id,
      ops: [
        {
          t: "effectBloom",
          targetPos: "center",
          filter: { names: ["宝鐘マリン"], bloomedThisTurn: true },
          source: "hand",
          cardFilter: { kind: "holomen", color: "青" },
          rebloom: true,
          optional: true,
        },
      ],
    });
  }
  const oppPlayer = other(s.turnPlayer);
  const oppAbilities = collectStepTriggerAbilities(
    s,
    oppPlayer,
    "oppPerfStepStart",
  );
  runOps(s, {
    player: s.turnPlayer,
    rest: [
      {
        t: "runTriggerAbilities",
        player: s.turnPlayer,
        abilities: turnAbilities,
        label: "パフォーマンスステップ開始時能力",
      },
      {
        t: "runTriggerAbilities",
        player: oppPlayer,
        abilities: oppAbilities,
        label: "パフォーマンスステップ開始時能力",
      },
      ...(finishAfterStart ? [{ t: "finishPerformanceStep" } as const] : []),
    ],
    label: "パフォーマンスステップ開始時能力",
  });
  advance(s);
}

function beginEndStep(s: GameState, ctx: EffectContextData) {
  s.step = "end";
  const abilities = collectSelfEndStepStartAbilities(s, s.turnPlayer);
  ctx.rest.unshift({ t: "continueTriggerAbilities", abilities });
}

export function endTurn(s: GameState): void {
  if (s.step !== "performance" && s.step !== "main")
    throw new Error("今はターンを終了できません");
  requireNoPrompt(s);
  if (s.step === "main") {
    // アーツを使わず終了する操作でも、7.6の開始・終了時能力は発揮する。
    // 開始時能力が選択待ちになった場合も、その解決後に終了時へ進む。
    beginPerformance(s, true);
    return;
  }
  runOps(s, {
    player: s.turnPlayer,
    rest: performanceEndOps(s),
    label: "ターン終了",
  });
  advance(s);
}

function performanceEndOps(s: GameState): Op[] {
  const rest: Op[] = [];
  if (s.step === "performance") {
    const activeAbilities = collectStepTriggerAbilities(
      s,
      s.turnPlayer,
      "selfPerfStepEnd",
    );
    for (const usable of usableOshiReactives(
      s,
      s.turnPlayer,
      "selfPerfStepEnd",
      null,
    ))
      if (usable.reactive.when === "selfPerfStepEnd")
        activeAbilities.push({
          id: `perfEndOshi:${usable.skill.name}`,
          label: `推しスキル「${usable.skill.name}」`,
          ops: [
            {
              t: "offerReactiveSkill",
              sp: usable.sp,
              skillName: usable.skill.name,
              description: usable.skill.description,
              cost: usable.cost,
              ops: usable.reactive.ops,
            },
          ],
        });
    rest.push({
      t: "runTriggerAbilities",
      player: s.turnPlayer,
      abilities: activeAbilities,
      label: "パフォーマンスステップ終了時能力",
    });
    const defender = other(s.turnPlayer);
    const abilities = collectStepTriggerAbilities(
      s,
      defender,
      "oppPerfStepEnd",
    );
    rest.push({
      t: "runTriggerAbilities",
      player: defender,
      abilities,
      label: "パフォーマンスステップ終了時能力",
    });
  }
  rest.push({ t: "beginEndStep" });
  return rest;
}

export function requireStep(s: GameState, step: GameState["step"]) {
  if (s.phase !== "playing") throw new Error("ゲームが進行中ではありません");
  if (s.step !== step) throw new Error(`このステップでは実行できません`);
}

export function requireNoPrompt(s: GameState) {
  if (s.prompts.length > 0) throw new Error("先に選択を解決してください");
}

export function emitAllyPlayed(
  s: GameState,
  pid: PlayerId,
  played: HolomenStack,
) {
  const ops = collectAllyPlayedOps(s, pid, played);
  if (ops.length > 0)
    runOps(s, { player: pid, rest: ops, label: "登場時能力" });
}

/**
 * ホロメンの能力でエールをアーカイブした時、チェックタイミングまで誘発を
 * 待機させる。エールの持ち主ではなく、能力の使用者と発生源で
 * 判定する（相手のエールをアーカイブした場合も「能力でエールを」に含む）。
 */
export function queueYellArchivedReactive(
  s: GameState,
  ctx: EffectContextData,
  archivedUids: string[],
): void {
  if (archivedUids.length === 0 || isSupportAbilitySource(s, ctx)) return;
  const source = ctx.sourceStackId ? findStackById(s, ctx.sourceStackId) : null;
  const reactives = usableOshiReactives(
    s,
    ctx.player,
    "yellArchivedByAbility",
    source?.stack ?? null,
    undefined,
    true,
  );
  for (const usable of reactives) {
    if (usable.reactive.when !== "yellArchivedByAbility") continue;
    (ctx.pendingTriggers ??= []).push({
      player: ctx.player,
      abilities: captureTriggerContexts(
        {
          player: ctx.player,
          milled: [...archivedUids],
          rest: [],
          label: usable.skill.name,
        },
        [
          {
            id: `yellArchivedReactive:${usable.skill.name}:${archivedUids.join(":")}`,
            label: `${usable.sp ? "SP" : ""}推しスキル「${usable.skill.name}」`,
            ops: [
              {
                t: "offerReactiveSkill",
                sp: usable.sp,
                skillName: usable.skill.name,
                description: usable.skill.description,
                cost: usable.cost,
                ops: usable.reactive.ops,
              },
            ],
          },
        ],
      ),
    });
  }
}

export function canBloom(
  s: GameState,
  handUid: string,
  pos: StagePosition,
): { ok: boolean; reason?: string } {
  const p = s.players[s.turnPlayer];
  if (!p.hand.includes(handUid))
    return { ok: false, reason: "手札にないカードです" };
  const st = getStack(p, pos);
  if (!st) return { ok: false, reason: "そこにホロメンがいません" };
  return canBloomOnto(s, handUid, st);
}

/** カードを指定スタックにBloomできるか (効果Bloom用に一部制限を無視できる) */
export function canBloomOnto(
  s: GameState,
  uid: string,
  st: HolomenStack,
  opts?: {
    /** 最初のターン制限を無視 (「この能力では最初のターンでもBloomできる」) */
    ignoreFirstTurns?: boolean;
    /** このターンに出た制限を無視 */
    ignoreEntered?: boolean;
    /** このターンBloom済み制限を無視 (「もう1回Bloomできる」) */
    ignoreBloomed?: boolean;
    /** Bloomレベル順を無視 */
    ignoreLevel?: boolean;
  },
): { ok: boolean; reason?: string } {
  const nc = cardOf(s, uid);
  if (nc.cardType !== "holomen")
    return { ok: false, reason: "ホロメンカードではありません" };
  const tc = topCard(s, st);
  if (s.turnsStarted[s.turnPlayer] <= 1 && !opts?.ignoreFirstTurns)
    return { ok: false, reason: "各プレイヤーの最初のターンはBloomできません" };
  if (st.enteredTurn === s.turn && !opts?.ignoreEntered)
    return { ok: false, reason: "このターンに出たホロメンはBloomできません" };
  if (st.bloomedThisTurn && !opts?.ignoreBloomed)
    return { ok: false, reason: "このターンすでにBloomしています" };
  if (nc.bloomLevel === "Debut" || nc.bloomLevel === "Spot")
    return { ok: false, reason: "DebutやSpotへはBloomできません" };
  if (tc.cannotBloom || tc.bloomLevel === "Spot")
    return { ok: false, reason: "このホロメンはBloomできません" };
  const okLevel =
    (nc.bloomLevel === "1st" &&
      (tc.bloomLevel === "Debut" || tc.bloomLevel === "1st")) ||
    (nc.bloomLevel === "2nd" &&
      (tc.bloomLevel === "1st" || tc.bloomLevel === "2nd"));
  if (!okLevel && !opts?.ignoreLevel)
    return { ok: false, reason: "Bloomレベルの順番が正しくありません" };
  const namesNew = [nc.name, ...nc.extraNames];
  const namesOld = [tc.name, ...tc.extraNames];
  if (!namesNew.some((n) => namesOld.includes(n)))
    return { ok: false, reason: "同名のホロメンにしかBloomできません" };
  if (nc.hp <= st.damage)
    return { ok: false, reason: "Bloom後のHPを上回るダメージを受けています" };
  return { ok: true };
}

/** 味方が相手をダウンさせた時のギフトも、保持者ごとに解決順を選ぶ。 */
function collectAllyDownedOpponentAbilities(
  s: GameState,
  pid: PlayerId,
  subject: HolomenStack | null,
  downedStackId: number,
): RuleDownAbility[] {
  if (!subject) return [];
  const abilities: RuleDownAbility[] = [];
  for (const e of allStacks(s.players[pid])) {
    const top = topCard(s, e.stack);
    const g = giftOf(top);
    const key = `giftAllyDownedOpponent:${e.stack.cards[0]}`;
    for (const [index, def] of g.triggers.entries()) {
      if (def.event !== "allyDownedOpponent") continue;
      if (
        def.subjectFilter &&
        !stackMatchesFilter(s, subject, def.subjectFilter)
      )
        continue;
      if (!triggerFires(s, pid, e.pos, def, key)) continue;
      abilities.push({
        id: `allyDownedOpponent:${downedStackId}:${e.stack.id}:${index}`,
        player: pid,
        label: `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, e.pos, e.stack)})`,
        sourceStackId: e.stack.id,
        ops: structuredClone(def.ops) as Op[],
      });
    }
  }
  return abilities;
}

function emitSupportAttached(
  s: GameState,
  pid: PlayerId,
  stack: HolomenStack,
  supportUid: string,
): void {
  const ops = collectSupportAttachedOps(s, pid, stack, supportUid);
  if (ops.length > 0)
    runOps(s, {
      player: pid,
      sourceStackId: stack.id,
      rest: ops,
      label: "サポート付与時能力",
    });
}

/** バトンタッチの実行可否と実効コスト */
export function canBatonTouch(
  s: GameState,
  backIndex: number,
): { ok: boolean; cost: number; reason?: string } {
  const fail = (reason: string, cost = 0) => ({ ok: false, cost, reason });
  if (s.phase !== "playing") return fail("ゲームが進行中ではありません");
  if (s.step !== "main") return fail("このステップでは実行できません");
  if (s.prompts.length > 0) return fail("先に選択を解決してください");
  const p = s.players[s.turnPlayer];
  if (!p.center) return fail("センターホロメンがいません");
  const cost = batonCostOf(s, p.center);
  if (p.usedBatonTouchThisTurn)
    return fail("バトンタッチは1ターンに1回だけ行えます", cost);
  if (p.center.resting)
    return fail("お休みしているセンターホロメンはバトンタッチできません");
  if (hasNoSwitch(s, p.center)) return fail("効果によりバトンタッチできません");
  const backSt = p.back[backIndex];
  if (!backSt) return fail("バックホロメンが見つかりません");
  if (hasNoSwitch(s, backSt))
    return fail("交代するバックホロメンが効果により移動できません");
  if (backSt.resting)
    return fail("お休みしているホロメンとはバトンタッチできません");
  if (p.center.yells.length < cost)
    return fail(`エールを${cost}枚アーカイブする必要があります`, cost);
  return { ok: true, cost };
}

/**
 * 「自分のセンターホロメンに付いている〈X〉をアーカイブする時、アーカイブする
 * かわりに、自分のバックホロメンの〈Y〉に付け替えられる」(hBP06-030〈姫森ルーナ〉
 * ギフト) の置換が効くなら、付け替え先の名称を返す。
 *
 * 公式Q520: 〈ルーナイト〉**自身の能力**でアーカイブする場合も置換できる。
 * 公式Q521: 付いていたホロメンが**ダウン**してアーカイブされる場合も置換できる。
 * どの経路からアーカイブされるかを問わないので、位置は「アーカイブされる直前に
 * 付いていたホロメンの位置」を呼び出し側から渡す (ダウン処理ではスタックが
 * 先に撤去されていて盤面から引けないため)。
 */
export function archiveRedirectTargets(
  s: GameState,
  owner: PlayerId,
  uid: string,
  fromPos: StagePosition | undefined,
): string[] | null {
  if (fromPos !== "center") return null;
  const ownerP = s.players[owner];
  const holder = ownerP.collab;
  if (!holder) return null;
  const redirect = giftOf(topCard(s, holder)).archiveRedirect;
  if (!redirect) return null;
  if (redirect.oppTurnOnly && s.turnPlayer === owner) return null;
  if (!cardHasName(s, uid, redirect.supportNames)) return null;
  if (
    !ownerP.back.some((st) =>
      stackNames(s, st).some((n) => redirect.targetNames.includes(n)),
    )
  )
    return null;
  return redirect.targetNames;
}

/** 付与型サポートをそのホロメンに付けられない理由 (付けられるなら null) */
export function attachError(
  s: GameState,
  st: HolomenStack,
  card: SupportCard,
): string | null {
  const passive = passiveOf(card);
  if (passive.attachOnlyNames) {
    const names = stackNames(s, st);
    if (!passive.attachOnlyNames.some((n) => names.includes(n)))
      return `このカードは${passive.attachOnlyNames.join("/")}にしか付けられません`;
  }
  const kind = card.supportType;
  if (kind !== "マスコット" && kind !== "ツール" && kind !== "ファン")
    return null;
  const gift = giftOf(topCard(s, st));
  const limit =
    (kind === "ツール" && gift.extraToolTag ? 2 : gift.supportLimits?.[kind]) ??
    (kind === "ファン" ? Number.POSITIVE_INFINITY : 1);
  const sameType = st.supports.filter(
    (u) => (cardOf(s, u) as SupportCard).supportType === kind,
  );
  if (sameType.length >= limit)
    return `${kind}は1人につき${limit}枚しか付けられません`;
  if (
    kind === "ツール" &&
    gift.extraToolTag &&
    sameType.length === 1 &&
    !card.tags.includes(gift.extraToolTag)
  )
    return "追加のツールには指定タグが必要です";
  if (
    gift.supportLimitDistinctNames?.includes(kind) &&
    sameType.some((u) => cardOf(s, u).name === card.name)
  )
    return `${kind}は異なるカード名で付ける必要があります`;
  return null;
}

function supportBindCandidates(
  s: GameState,
  pid: PlayerId,
  op: Extract<Op, { t: "chooseBind" }>,
): HolomenStack[] {
  const own = s.players[pid];
  const opp = s.players[other(pid)];
  let candidates: HolomenStack[];
  switch (op.scope) {
    case "own":
      candidates = allStacks(own).map((e) => e.stack);
      break;
    case "ownBack":
      candidates = [...own.back];
      break;
    case "ownCollab":
      candidates = own.collab ? [own.collab] : [];
      break;
    case "ownCenter":
      candidates = own.center ? [own.center] : [];
      break;
    case "opp":
      candidates = allStacks(opp).map((e) => e.stack);
      break;
    case "oppFront":
      candidates = [opp.center, opp.collab].filter(
        (stack): stack is HolomenStack => !!stack,
      );
      break;
  }
  return candidates.filter((stack) => {
    const entry = findStackById(s, stack.id);
    return (
      stackMatchesFilter(s, stack, op.filter) &&
      !!entry &&
      matchesPosition(entry.pos, op.filter?.position)
    );
  });
}

/** 同じ指示で各1人を選ぶ場合、後の選択も含めて可能な人数を保つ。 */
function maximalBindCandidates<T extends { stack: HolomenStack }>(
  s: GameState,
  ctx: EffectContextData,
  op: Pick<Extract<Op, { t: "chooseBind" }>, "count" | "countFrom" | "append">,
  candidates: T[],
): T[] {
  if (op.countFrom || (op.count ?? 1) !== 1) return candidates;
  const chosen = new Set(op.append ? (ctx.boundStackIds ?? []) : []);
  const following: number[][] = [];
  for (const next of ctx.rest) {
    if (
      next.t !== "chooseBind" ||
      !next.append ||
      next.countFrom ||
      (next.count ?? 1) !== 1
    )
      break;
    following.push(
      supportBindCandidates(s, ctx.player, next)
        .map((stack) => stack.id)
        .filter((id) => !chosen.has(id)),
    );
  }
  if (!following.length) return candidates;
  // 複数名の同一ホロメンは1枠だけを埋められる。前の割り当ても組み直して数える。
  const maximum = (groups: number[][]): number => {
    const assigned = new Map<number, number>();
    const assign = (group: number, visited: Set<number>): boolean => {
      for (const id of groups[group]) {
        if (visited.has(id)) continue;
        visited.add(id);
        const previous = assigned.get(id);
        if (previous === undefined || assign(previous, visited)) {
          assigned.set(id, group);
          return true;
        }
      }
      return false;
    };
    for (let i = 0; i < groups.length; i++) assign(i, new Set());
    return assigned.size;
  };
  const required = maximum([
    candidates.map(({ stack }) => stack.id),
    ...following,
  ]);
  return candidates.filter(
    ({ stack }) =>
      1 +
        maximum(
          following.map((group) => group.filter((id) => id !== stack.id)),
        ) >=
      required,
  );
}

/** 保存時の候補も現在の束縛列に照合し、入力・CPU・画面で同じ対象を使う。 */
export function effectTargetEntries(
  s: GameState,
  prompt: Extract<Prompt, { type: "effectTarget" }>,
) {
  const ctx =
    prompt.perspective === undefined
      ? prompt.ctx
      : { ...prompt.ctx, player: prompt.perspective };
  const entries = targetCandidates(s, ctx, prompt.target, prompt.filter).filter(
    ({ stack }) =>
      !prompt.eligibleStackIds || prompt.eligibleStackIds.includes(stack.id),
  );
  return prompt.apply.t === "bind" && prompt.chosen.length === 0
    ? maximalBindCandidates(
        s,
        ctx,
        { count: prompt.count, append: true },
        entries,
      )
    : entries;
}

function supportTargetExists(
  s: GameState,
  pid: PlayerId,
  target: import("../effects").StackTarget,
  filter?: import("../effects").TargetFilter,
  damagedOnly = false,
): boolean {
  const own = s.players[pid];
  const opp = s.players[other(pid)];
  let candidates: { pos: StagePosition; stack: HolomenStack }[] = [];
  if (target === "chooseOwn" || target === "allOwn")
    candidates = allStacks(own);
  else if (target === "chooseOwnBack")
    candidates = own.back.map((stack, back) => ({ pos: { back }, stack }));
  else if (target === "chooseOwnFront" || target === "allOwnFront")
    candidates = [
      own.center ? { pos: "center" as const, stack: own.center } : null,
      own.collab ? { pos: "collab" as const, stack: own.collab } : null,
    ].filter(
      (entry): entry is { pos: "center" | "collab"; stack: HolomenStack } =>
        !!entry,
    );
  else if (target === "ownCenter")
    candidates = own.center ? [{ pos: "center", stack: own.center }] : [];
  else if (target === "ownCollab")
    candidates = own.collab ? [{ pos: "collab", stack: own.collab }] : [];
  else if (
    target === "chooseOpp" ||
    target === "chooseOppAny" ||
    target === "allOpp"
  )
    candidates = allStacks(opp);
  else if (target === "chooseOppBack" || target === "allOppBack")
    candidates = opp.back.map((stack, back) => ({ pos: { back }, stack }));
  else if (target === "chooseOppFront" || target === "allOppFront")
    candidates = [
      opp.center ? { pos: "center" as const, stack: opp.center } : null,
      opp.collab ? { pos: "collab" as const, stack: opp.collab } : null,
    ].filter(
      (entry): entry is { pos: "center" | "collab"; stack: HolomenStack } =>
        !!entry,
    );
  else if (target === "chooseOppCenterOrBack")
    candidates = [
      ...(opp.center ? [{ pos: "center" as const, stack: opp.center }] : []),
      ...opp.back.map((stack, back) => ({ pos: { back }, stack })),
    ];
  else if (target === "oppCenter")
    candidates = opp.center ? [{ pos: "center", stack: opp.center }] : [];
  else if (target === "oppCollab")
    candidates = opp.collab ? [{ pos: "collab", stack: opp.collab }] : [];
  else return true;
  return candidates.some(
    ({ pos, stack }) =>
      stackMatchesFilter(s, stack, filter) &&
      matchesPosition(pos, filter?.position) &&
      (!damagedOnly || stack.damage > 0),
  );
}

/**
 * effectBloom の「使えるカード×Bloom先」の組合せを列挙する。
 * runOps の実行と、能力の使用可否判定 (10.7.2.3.7) で同じ判定を使う。
 */
function effectBloomCandidates(
  s: GameState,
  pid: PlayerId,
  op: Extract<Op, { t: "effectBloom" }>,
  sourceStackId: number | undefined,
  boundStackId?: number,
): { player: PlayerId; pos: StagePosition; stack: HolomenStack }[] {
  const p = s.players[pid];
  const opts = {
    ignoreFirstTurns: op.allowFirstTurn,
    ignoreEntered: op.filter?.enteredThisTurn,
    ignoreBloomed: op.rebloom || op.filter?.bloomedThisTurn,
    ignoreLevel: op.ignoreLevel,
  };
  const sourceStack = sourceStackId
    ? findStackById(s, sourceStackId)?.stack
    : undefined;
  const pool = (
    op.source === "hand"
      ? p.hand
      : op.source === "archive"
        ? p.archive
        : op.source === "deck"
          ? p.deck
          : (sourceStack?.cards.slice(1) ?? [])
  ).filter(
    (u) => !op.cardFilter || cardMatchesFilter(s, pid, u, op.cardFilter),
  );
  return allStacks(p)
    .filter(
      ({ pos, stack }) =>
        (!op.targetPos ||
          (op.targetPos === "back"
            ? typeof pos !== "string"
            : pos === op.targetPos)) &&
        (!op.targetSelf || stack.id === sourceStackId) &&
        (!op.targetBound || stack.id === boundStackId) &&
        (!op.filter?.excludeSource || stack.id !== sourceStackId) &&
        stackMatchesFilter(s, stack, op.filter) &&
        pool.some((u) => canBloomOnto(s, u, stack, opts).ok),
    )
    .map((e) => ({ player: pid, ...e }));
}

/** hEB01-003: 推しスキルと黄の〈博衣こより〉の公開枚数を助手くん分増やす。 */
function revealCountBonus(s: GameState, ctx: EffectContextData): number {
  const p = s.players[ctx.player];
  const oshi = cardOf(s, p.oshiUid);
  if (
    oshi.cardType !== "oshi" ||
    oshi.stageOshiSkill?.name !== "助手くん限定の『こよ色観測』"
  )
    return 0;
  const fromOshi = ctx.originOshiSkill?.sp === false;
  const src = ctx.sourceStackId ? findStackById(s, ctx.sourceStackId) : null;
  const fromYellowKoyori =
    !!src &&
    stackNames(s, src.stack).includes("博衣こより") &&
    stackColors(s, src.stack).includes("黄");
  return fromOshi || fromYellowKoyori
    ? stageNamedCardCount(s, ctx.player, ["こよりの助手くん"])
    : 0;
}

/** 「エールN枚以上なら選んだホロメンのアーツ加算」だけが残る場合のN。 */
function boundYellArtBonusMinimum(ops: Op[]): number | undefined {
  const remaining = ops.filter((op) => op.t !== "finishSupportCard");
  const conditional = remaining[0];
  if (
    remaining.length === 1 &&
    conditional?.t === "if" &&
    conditional.cond.c === "boundYellCount" &&
    conditional.then.length === 1 &&
    conditional.then[0].t === "turnArtPlus" &&
    conditional.then[0].target === "bound" &&
    conditional.then[0].value > 0
  )
    return conditional.cond.n;
  return undefined;
}

/** 選ぶだけでは状態を変えない、対象依存のサポートの後続処理を検査する。 */
function supportBoundTargetCanChangeState(
  s: GameState,
  pid: PlayerId,
  stack: HolomenStack,
  ops: Op[],
): boolean {
  const remaining = ops.filter((op) => op.t !== "finishSupportCard");
  const first = remaining[0];
  const second = remaining[1];
  // ツートンカラーパソコン: 色の基準を選ぶだけでは状態変化にならない。
  if (
    remaining.length === 2 &&
    first?.t === "searchDeck" &&
    first.groups?.some((g) => g.filter.sameColorAsBoundIndex !== undefined) &&
    second?.t === "shuffleDeck"
  )
    return s.players[pid].deck.length > 0;
  if (
    remaining.length === 2 &&
    first?.t === "stackedToHand" &&
    second?.t === "turnArtPlusPerCount" &&
    second.per === "picked" &&
    second.target === "bound"
  )
    return first.max > 0 && stack.cards.length > 1;
  const threshold = boundYellArtBonusMinimum(remaining.slice(1));
  if (
    first?.t === "moveYell" &&
    first.targetFilter?.boundOnly &&
    !first.fromSelf &&
    first.side !== "opp" &&
    threshold !== undefined
  ) {
    if (stack.yells.length >= threshold) return true; // Q406: 付け替えずに加算できる。
    // 同じホロメンへ戻すだけでは付け替えにならない (5.17.4.1)。
    return (
      first.max > 0 &&
      allStacks(s.players[pid]).some(
        ({ stack: from }) =>
          from.id !== stack.id &&
          (!first.sourceFilter ||
            stackMatchesFilter(s, from, first.sourceFilter)) &&
          from.yells.some(
            (uid) =>
              (!first.color || yellOnIs(s, from, uid, first.color)) &&
              (!first.colors ||
                first.colors.some((color) => yellOnIs(s, from, uid, color))),
          ),
      )
    );
  }
  // 10.7.2.3.7: 選ぶだけでは状態変化にならない。対象に依存する
  // 回復や固定の特殊ダメージなら、ダメージの有無や確定した保護・免疫・軽減まで確認する。
  // 任意防御の支払い・未対応の後続効果を、確定した不発とは判断しない。
  const entry = findStackById(s, stack.id);
  const ctx: EffectContextData = {
    player: pid,
    boundStackId: stack.id,
    boundStackIds: [stack.id],
    rest: [],
    label: "",
  };
  const pending: Op[] = [...remaining];
  let changes = false;
  let checkedTargetEffect = false;
  while (pending.length > 0) {
    const op = pending.shift()!;
    if (op.t === "if" || op.t === "ifElse") {
      const match = evalCond(s, ctx, op.cond);
      pending.unshift(...(match ? op.then : op.t === "ifElse" ? op.else : []));
    } else if (
      op.t === "special" &&
      op.target === "bound" &&
      !op.dmgFrom &&
      !op.scaleBy &&
      !op.includeOppCenter
    ) {
      checkedTargetEffect = true;
      if (
        entry &&
        !isProtectedFrom(s, entry, pid) &&
        !isSpecialImmune(s, entry, pid) &&
        !(entry.player !== pid && isDamageImmune(s, entry)) &&
        calculateSpecialDamage(s, ctx, entry, { t: "special", dmg: op.dmg }) > 0
      )
        changes = true;
    } else if (op.t === "heal" && op.target === "bound") {
      checkedTargetEffect = true;
      if (op.value !== 0 && stack.damage > 0) changes = true;
    } else return true;
  }
  return !checkedTargetEffect || changes;
}

/** 回復が空振りしても、同じ対象への後続のアーカイブエール送付が可能か。 */
function boundFollowupCanSendArchiveYell(
  s: GameState,
  pid: PlayerId,
  ops: Op[],
): boolean {
  for (const op of ops) {
    if (op.t === "if" || op.t === "ifElse") {
      const cond = evalCond(s, { player: pid, rest: [], label: "" }, op.cond);
      const branch =
        op.t === "ifElse" ? (cond ? op.then : op.else) : cond ? op.then : [];
      if (boundFollowupCanSendArchiveYell(s, pid, branch)) return true;
      continue;
    }
    if (op.t === "cheerFromArchive" && op.target === "bound" && op.n > 0) {
      if (op.perArchiveNamed) {
        const count = s.players[pid].archive.filter((uid) =>
          cardHasName(s, uid, op.perArchiveNamed!.names),
        ).length;
        if (Math.floor(count / op.perArchiveNamed.per) * op.n <= 0) continue;
      }
      if (
        s.players[pid].archive.some((uid) => {
          const card = cardOf(s, uid);
          return (
            card.cardType === "yell" &&
            (!op.colors || op.colors.includes(card.color))
          );
        })
      )
        return true;
    }
  }
  return false;
}

/** 実際に別のホロメンへ送れるエールがあるか。元への付け直しは状態変化ではない。 */
function yellMoveCanChangeState(
  s: GameState,
  ctx: EffectContextData,
  op: Extract<Op, { t: "moveYell" }>,
): boolean {
  if (op.max <= 0) return false;
  const owner = op.side === "opp" ? other(ctx.player) : ctx.player;
  return allStacks(s.players[owner]).some(({ stack }) => {
    if (op.fromSelf && stack.id !== ctx.sourceStackId) return false;
    if (op.sourceFilter && !stackMatchesFilter(s, stack, op.sourceFilter))
      return false;
    return stack.yells.some((uid) => {
      if (op.color && !yellOnIs(s, stack, uid, op.color)) return false;
      if (op.colors && !op.colors.some((c) => yellOnIs(s, stack, uid, c)))
        return false;
      return cheerAssignCandidates(s, {
        type: "cheerAssign",
        player: ctx.player,
        targetPlayer: owner,
        yellUid: uid,
        reason: "effect",
        filter: op.targetFilter,
        perTargetMax: op.perTargetMax,
        ctx,
      }).some((target) => target.stack.id !== stack.id);
    });
  });
}

/** 付け替え以外に効果・コストを持たないサポートは、実際の移動を省略できない。 */
export function isYellTransferOnlySupport(
  s: GameState,
  ctx: EffectContextData,
): boolean {
  if (!ctx.sourceCardUid) return false;
  const card = cardOf(s, ctx.sourceCardUid);
  if (card.cardType !== "support") return false;
  const { conditions, rest } = parsePlayConditions(card.description);
  if (conditions.length > 0) return false;
  const program = parseEffect(rest);
  return program?.ops.length === 1 && program.ops[0].t === "moveYell";
}

/** 交代する双方の移動制限と、バック側の状態・カード条件を検査する。 */
function swapCenterCandidates(
  s: GameState,
  player: PlayerId,
  op: Extract<Op, { t: "swapCenter" }>,
) {
  const pid = op.side === "own" ? player : other(player);
  const p = s.players[pid];
  if (!p.center || hasNoSwitch(s, p.center)) return [];
  return p.back
    .map((stack, back) => ({ player: pid, pos: { back }, stack }))
    .filter(
      ({ stack }) =>
        (!op.requireActive || !stack.resting) &&
        !hasNoSwitch(s, stack) &&
        stackMatchesFilter(s, stack, op.filter),
    );
}

/** 1回の確定出目に対する条件。合計と両者ライフの比較は呼び出し側で扱う。 */
function diceBranchMatches(
  cond: DiceOp["branches"][number]["cond"],
  roll: number,
  life: number,
): boolean {
  if (cond === "eqBothLife") return false;
  if (cond === "odd") return roll % 2 === 1;
  if (cond === "even") return roll % 2 === 0;
  if (cond === "geLife") return roll >= life;
  if (cond === "leLife") return roll <= life;
  if ("perValue" in cond) return Math.floor(roll / cond.perValue) > 0;
  if ("eq" in cond) return cond.eq.includes(roll);
  if ("ne" in cond) return !cond.ne.includes(roll);
  return "ge" in cond ? roll >= cond.ge : roll <= cond.le;
}

function supportOpsCanChangeState(
  s: GameState,
  pid: PlayerId,
  ops: Op[],
  sourceStackId?: number,
  isSupport = false,
): boolean {
  const p = s.players[pid];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.t === "shuffleDeck" || op.t === "shuffleCheer") continue;
    // 対象を選べる chooseBind 等に到達した時点で true を返す。
    // ここまで来た bound 参照には選択済みの対象がないため、変化を起こせない。
    // 例: 「ブヒー！」のダウン条件が不成立なら、後続のアーツ加算も空振りする。
    if ("target" in op && op.target === "bound") continue;
    if (
      op.t === "boundToDeckBottom" ||
      op.t === "boundStackAllToDeckBottom" ||
      op.t === "boundRestToBack" ||
      op.t === "noActivateNextReset" ||
      op.t === "stackedToHand" ||
      op.t === "boundArtPlusReplace" ||
      op.t === "turnArtPlusPerBoundYell" ||
      (op.t === "downReward" && op.boundSubject) ||
      (op.t === "moveYell" && op.targetFilter?.boundOnly)
    )
      continue;
    if (op.t === "draw") {
      if (p.deck.length > 0 && op.n > 0) return true;
      continue;
    }
    if (op.t === "turnThirdArtBackTarget") {
      // 固定の特殊ダメージが無効でも、後続の対象拡張が有効なら使える。
      // 受け手がいない拡張だけで、空振りするサポートを使用可能にしない。
      if (
        allStacks(p).some(({ stack }) =>
          op.names.some((name) => stackNames(s, stack).includes(name)),
        )
      )
        return true;
      continue;
    }
    if (op.t === "holoPowerFromDeck") {
      if (p.deck.length > 0 && op.n > 0) return true;
      continue;
    }
    if (op.t === "lookTop") {
      // 非公開領域の中身は使用可否の判定に使わない。空なら見ることもできない。
      const source =
        op.source === "cheer"
          ? p.cheerDeck
          : op.source === "holo"
            ? p.holoPower
            : p.deck;
      if (source.length > 0 && op.n > 0) return true;
      continue;
    }
    if (op.t === "handRevealToDeckBottom") {
      // Q248: 戻す手札がない場合、後続の同名カード検索も発揮しない。
      return (
        p.hand.filter((uid) => cardMatchesFilter(s, pid, uid, op.filter))
          .length >= op.n
      );
    }
    if (op.t === "handToDeckBottom") {
      if (p.hand.length > 0 && op.n > 0) return true;
      continue;
    }
    if (op.t === "shuffleHandIntoDeck") {
      if (p.hand.length > 0 || (op.thenDraw > 0 && p.deck.length > 0))
        return true;
      continue;
    }
    if (op.t === "bothShuffleHandIntoDeck") {
      if (
        s.players.some(
          (pl) => pl.hand.length > 0 || (op.thenDraw > 0 && pl.deck.length > 0),
        )
      )
        return true;
      continue;
    }
    if (op.t === "optionalCost") {
      const ctx = { player: pid, sourceStackId, rest: [], label: "" };
      if (
        canPayOptionalCost(s, ctx, op.cost) &&
        supportOpsCanChangeState(
          s,
          pid,
          [...op.cost, ...op.then],
          sourceStackId,
          isSupport,
        )
      )
        return true;
      continue;
    }
    if (op.t === "stageYellToCheerBottom") {
      if (op.n > 0 && allStacks(p).some(({ stack }) => stack.yells.length > 0))
        return true;
      continue;
    }
    if (op.t === "millCheer") {
      if (p.cheerDeck.length > 0 && op.n > 0) return true;
      continue;
    }
    if (op.t === "archiveStageYell") {
      if (op.n > 0 && archiveStageYellCandidates(s, pid, op).length > 0)
        return true;
      continue;
    }
    if (op.t === "searchCheer" || op.t === "cheerFromTop") {
      const targets =
        op.t === "searchCheer"
          ? supportTargetExists(s, pid, "chooseOwn", op.targetFilter)
          : supportTargetExists(s, pid, op.target, op.filter);
      if (p.cheerDeck.length > 0 && op.n > 0 && targets) return true;
      continue;
    }
    if (op.t === "forceOppCollab") {
      const opp = s.players[other(pid)];
      if (!opp.collab && opp.back.some((st) => !hasNoSwitch(s, st)))
        return true;
      continue;
    }
    if (op.t === "revealTop") {
      if (p.deck.length > 0 && op.n > 0) return true;
      continue;
    }
    // 公開処理に到達しても true にならなかったなら公開カードはない。
    if (
      op.t === "revealedTo" ||
      (op.t === "turnArtPlusPerCount" && op.per === "revealedSupport")
    )
      continue;
    if (op.t === "drawThenArchive") {
      if (
        (p.deck.length > 0 && op.draw > 0) ||
        (p.hand.length > 0 && op.archive > 0)
      )
        return true;
      continue;
    }
    if (op.t === "moveYell") {
      if (
        yellMoveCanChangeState(
          s,
          { player: pid, sourceStackId, rest: [], label: "" },
          op,
        )
      )
        return true;
      continue;
    }
    if (op.t === "searchDeck") {
      // 空の山札からの検索は変化を起こせない (Q551)。
      // ただし後続の独立した能力まで打ち切らない。
      if (p.deck.length === 0) continue;
      if (op.dest === "stage") return stageCount(p) < 6 && p.back.length < 5;
      return true;
    }
    if (op.t === "moveArchive") {
      const count = p.archive.filter((uid) =>
        cardMatchesFilter(s, pid, uid, op.filter),
      ).length;
      if (
        count > 0 &&
        (op.dest !== "stage" || (stageCount(p) < 6 && p.back.length < 5))
      )
        return true;
      // 回収できなくても後続のドローやエール送付は解決する (Q606/Q675)。
      // 使用条件やコストではないので、ここで使用不可と確定しない。
      continue;
    }
    if (op.t === "chooseBind") {
      let candidates = supportBindCandidates(s, pid, op);
      const next = ops[i + 1];
      if (
        next?.t === "heal" &&
        next.target === "bound" &&
        !boundFollowupCanSendArchiveYell(s, pid, ops.slice(i + 2))
      )
        candidates = candidates.filter((stack) => stack.damage > 0);
      candidates = candidates.filter((stack) =>
        supportBoundTargetCanChangeState(s, pid, stack, ops.slice(i + 1)),
      );
      // 指定人数に足りなくても、可能な対象へ適用する (10.7.2.3.3)。
      // 対象がいなければ、その対象に依存しない後続効果も調べる。
      if (candidates.length > 0 && (op.count ?? 1) > 0) return true;
      continue;
    }
    if (op.t === "dice") {
      if (op.sumArtPlus || op.aggOdd) return true;
      const rolls = op.rolls ?? 1;
      const mods =
        isSupport && !op.rollsFrom
          ? diceModifiersFor(s, pid, rolls, "(サポート)", false)
          : [];
      // ランダムな出目は予測せず、確定した全出目の修正だけを使用可否に反映する。
      // Q552: 後続を実行できなければ、サイコロだけを振るサポートは使えない。
      // 1回限りの修正や、適用順によって結果が変わる修正は不発と断定しない。
      const fixed =
        mods.length > 0 &&
        mods.every(
          (mod) =>
            !mod.once &&
            !mod.double &&
            mod.value !== undefined &&
            mod.value === mods[0].value,
        )
          ? mods[0].value
          : undefined;
      if (
        op.branches.some((branch) => {
          if (fixed !== undefined) {
            const matches =
              branch.cond === "eqBothLife"
                ? fixed * rolls ===
                  p.life.length + s.players[other(pid)].life.length
                : diceBranchMatches(branch.cond, fixed, p.life.length);
            if (!matches) return false;
          }
          return supportOpsCanChangeState(
            s,
            pid,
            branch.ops,
            sourceStackId,
            isSupport,
          );
        })
      )
        return true;
      continue;
    }
    if (op.t === "if" || op.t === "ifElse") {
      const cond = evalCond(
        s,
        { player: pid, sourceStackId, rest: [], label: "" },
        op.cond,
      );
      const branch = op.t === "ifElse" ? (cond ? op.then : op.else) : op.then;
      if (cond || op.t === "ifElse") {
        if (supportOpsCanChangeState(s, pid, branch, sourceStackId, isSupport))
          return true;
      }
      continue;
    }
    if (op.t === "chooseOps") {
      if (
        supportOpsCanChangeState(
          s,
          pid,
          op.thenOps,
          sourceStackId,
          isSupport,
        ) ||
        supportOpsCanChangeState(s, pid, op.elseOps, sourceStackId, isSupport)
      )
        return true;
      continue;
    }
    if (op.t === "markOncePerGameUsed") continue;
    if (op.t === "swapCenter") {
      if (swapCenterCandidates(s, pid, op).length > 0) return true;
      continue;
    }
    if (op.t === "archiveOppYell") {
      if (
        allStacks(s.players[other(pid)]).some(
          (e) =>
            (!op.fromCenter || e.pos === "center") && e.stack.yells.length > 0,
        )
      )
        return true;
      continue;
    }
    if (op.t === "cheerFromArchive") {
      if (op.perArchiveNamed) {
        const count = p.archive.filter((uid) =>
          cardHasName(s, uid, op.perArchiveNamed!.names),
        ).length;
        if (Math.floor(count / op.perArchiveNamed.per) * op.n <= 0) continue;
      }
      const hasYell = p.archive.some((uid) => {
        const card = cardOf(s, uid);
        return (
          card.cardType === "yell" &&
          (!op.colors || op.colors.includes(card.color))
        );
      });
      if (hasYell && supportTargetExists(s, pid, op.target, op.filter))
        return true;
      continue;
    }
    if (op.t === "special") {
      const ctx: EffectContextData = {
        player: pid,
        sourceStackId,
        rest: [],
        label: "",
      };
      const candidates = targetCandidates(s, ctx, op.target, op.filter);
      if (op.includeOppCenter && s.players[other(pid)].center)
        candidates.push({
          player: other(pid),
          pos: "center",
          stack: s.players[other(pid)].center!,
        });
      if (
        candidates.some((entry) => {
          // 確定している無効化・軽減でHPが変動しないなら、この効果だけでは使用できない。
          if (isProtectedFrom(s, entry, pid)) return false;
          if (isSpecialImmune(s, entry, pid)) return false;
          if (entry.player !== pid && isDamageImmune(s, entry)) return false;
          if (!sourceStackId && !op.dmgFrom && !op.scaleBy)
            return op.dmg + damageTakenDeltaOf(s, entry, { art: false }) > 0;
          return true;
        })
      )
        return true;
      continue;
    }
    if (op.t === "heal") {
      if (supportTargetExists(s, pid, op.target, op.filter, true)) return true;
      continue;
    }
    if (op.t === "turnCostMod" || op.t === "turnArtPlus") {
      if (supportTargetExists(s, pid, op.target, op.filter)) return true;
      continue;
    }
    if (op.t === "effectBloom") {
      if (effectBloomCandidates(s, pid, op, sourceStackId).length > 0)
        return true;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * OR形の使用コスト「自分の手札N枚か自分のステージの〈X〉M枚をアーカイブ」の
 * 支払い可能な選択肢。使用可否の判定と、実際の支払いで同じ関数を使う。
 * 手札の枚数からは、これから使うカード自身 (playUid) を除く。
 */
function playCostChoices(
  s: GameState,
  pid: PlayerId,
  cond: { n: number; names: string[]; stageN: number },
  playUid: string,
): { hand: boolean; stage: boolean } {
  const p = s.players[pid];
  const handCount = p.hand.filter((u) => u !== playUid).length;
  return {
    hand: handCount >= cond.n,
    stage: stageSupportUidsNamed(s, pid, cond.names).length >= cond.stageN,
  };
}

function playCostPayable(
  s: GameState,
  pid: PlayerId,
  cond: { n: number; names: string[]; stageN: number },
  playUid: string,
): boolean {
  const choices = playCostChoices(s, pid, cond, playUid);
  return choices.hand || choices.stage;
}

/**
 * 使用コストのOp列。支払える選択肢が2つあるときだけ二択を出す。
 * 手札を数える都合上、呼び出し側は先に使用カードを手札から抜いておくこと。
 */
export function playCostOps(
  s: GameState,
  pid: PlayerId,
  conditions: PlayCondition[],
  playUid: string,
): Op[] {
  const ops: Op[] = [];
  for (const cond of conditions) {
    if (cond.c === "archiveYellCost") {
      ops.push({ t: "archiveStageYell", n: cond.n });
    } else if (cond.c === "archiveHandOrStageNamed") {
      const stageArchive: Op = {
        t: "archiveStageSupports",
        names: cond.names,
        n: cond.stageN,
      };
      const handArchive: Op = { t: "archiveHand", n: cond.n };
      const choices = playCostChoices(s, pid, cond, playUid);
      if (choices.hand && choices.stage)
        ops.push({
          t: "chooseOps",
          label: `使用コスト: 手札${cond.n}枚をアーカイブしますか (いいえ: ステージの${cond.names
            .map((n) => `〈${n}〉`)
            .join("")}${cond.stageN}枚)`,
          thenOps: [handArchive],
          elseOps: [stageArchive],
        });
      else ops.push(choices.hand ? handArchive : stageArchive);
    }
  }
  return ops;
}

/**
 * 付け先の枠競合が「使用コストで外せる付与」によるものなら、その付与のuidを返す。
 * 〈石の斧〉をアーカイブして同じホロメンへ〈アキ・ローゼンタールの斧〉を付け替える形。
 * この場合コストの払い方は1通りに決まるので、選択を挟まずここで支払う。
 */
export function attachCostReliefUid(
  s: GameState,
  conditions: PlayCondition[],
  st: HolomenStack,
  c: SupportCard,
): string | null {
  for (const cond of conditions) {
    if (cond.c !== "archiveHandOrStageNamed" || cond.stageN !== 1) continue;
    const uid = st.supports.find((u) => cardHasName(s, u, cond.names));
    if (!uid) continue;
    // 実際にそれを外せば付けられるようになるかを確かめる
    const stillBlocked = attachError(
      s,
      { ...st, supports: st.supports.filter((u) => u !== uid) },
      c,
    );
    if (!stillBlocked) return uid;
  }
  return null;
}

/** サポートカードの使用可否 */
export function canPlaySupport(
  s: GameState,
  handUid: string,
): { ok: boolean; reason?: string } {
  const p = s.players[s.turnPlayer];
  if (!p.hand.includes(handUid))
    return { ok: false, reason: "手札にないカードです" };
  const c = cardOf(s, handUid);
  if (c.cardType !== "support")
    return { ok: false, reason: "サポートカードではありません" };
  const parsedPlay = parsePlayConditions(c.description);
  if (c.limited) {
    const limit = p.limitedLimit ?? 1;
    const used = p.limitedUsedCount ?? (p.usedLimitedThisTurn ? 1 : 0);
    if (used >= limit)
      return {
        ok: false,
        reason: `LIMITEDカードは1ターンに${limit}枚しか使用できません`,
      };
    if (s.turn === 1 && s.turnPlayer === s.firstPlayer) {
      const oshi = cardOf(s, p.oshiUid);
      const allowed = parsedPlay.allowFirstPlayerFirstTurnOshiNames?.includes(
        oshi.name,
      );
      if (!allowed)
        return {
          ok: false,
          reason: "LIMITEDカードは先攻の最初のターンには使用できません",
        };
    }
  }
  // カード自身に書かれた使用回数制限 (LIMITEDとは別枠)。
  // 「自分の〈X〉はターンにN回しか使えない」/「自分の#Tを持つ(種別)は…」
  const useLimit = parseSupportUseLimit(c.description);
  if (useLimit) {
    const used = useLimit.name
      ? s.usedSupportNamesThisTurn[s.turnPlayer].filter(
          (n) => n === useLimit.name,
        ).length
      : s.usedSupportTagTypesThisTurn[s.turnPlayer].filter(
          (e) => e === `${useLimit.tag}|${useLimit.supportType}`,
        ).length;
    if (used >= useLimit.n)
      return {
        ok: false,
        reason: useLimit.name
          ? `〈${useLimit.name}〉は1ターンに${useLimit.n}回しか使用できません`
          : `#${useLimit.tag}を持つ${useLimit.supportType}は1ターンに${useLimit.n}回しか使用できません`,
      };
  }
  const { conditions, rest } = parsedPlay;
  for (const cond of conditions) {
    if (cond.c === "handAtMost") {
      if (p.hand.length - 1 > cond.n)
        return {
          ok: false,
          reason: `手札がこのカードを含まず${cond.n}枚以下の時のみ使用できます`,
        };
    } else if (cond.c === "handAtLeast") {
      if (p.hand.length - 1 < cond.n)
        return {
          ok: false,
          reason: `手札がこのカードを含まず${cond.n}枚以上の時のみ使用できます`,
        };
    } else if (cond.c === "cond") {
      if (
        !evalCond(
          s,
          { player: s.turnPlayer, rest: [], label: c.name },
          cond.cond,
        )
      )
        return {
          ok: false,
          reason: `使用条件「${cond.text}」を満たしていません`,
        };
    } else if (cond.c === "oshiIs") {
      const oshi = cardOf(s, p.oshiUid);
      if (!cond.names.includes(oshi.name))
        return {
          ok: false,
          reason: `推しホロメンが${cond.names.join("/")}の時のみ使用できます`,
        };
    } else if (cond.c === "holoPowerCost") {
      if (p.holoPower.length < cond.n)
        return { ok: false, reason: `ホロパワーが${cond.n}枚必要です` };
    } else if (cond.c === "stageAll") {
      const all = allStacks(p).every(({ stack }) =>
        stackMatchesFilter(s, stack, cond.filter),
      );
      if (!all)
        return {
          ok: false,
          reason: "ステージのホロメン全員が条件を満たしていません",
        };
    } else if (cond.c === "lifeAtMost") {
      if (p.life.length > cond.n)
        return {
          ok: false,
          reason: `ライフが${cond.n}以下の時のみ使用できます`,
        };
    } else if (cond.c === "archiveYellCost") {
      const totalYells = allStacks(p).reduce(
        (acc, { stack }) => acc + stack.yells.length,
        0,
      );
      if (totalYells < cond.n)
        return { ok: false, reason: `ステージのエールが${cond.n}枚必要です` };
    } else if (cond.c === "archiveHandOrStageNamed") {
      // どちらか片方でも払えれば使える (支払い方は使用時に選ぶ)
      if (!playCostPayable(s, s.turnPlayer, cond, handUid))
        return {
          ok: false,
          reason: `手札${cond.n}枚か、ステージの${cond.names.map((n) => `〈${n}〉`).join("")}${cond.stageN}枚が必要です`,
        };
    } else if (cond.c === "unsupported") {
      return {
        ok: false,
        reason: `使用条件「${cond.text}」は自動処理未対応のため使用できません`,
      };
    } else {
      return {
        ok: false,
        reason: "このカードの使用コストは自動処理未対応のため使用できません",
      };
    }
  }
  const attaching =
    c.supportType === "ツール" ||
    c.supportType === "マスコット" ||
    c.supportType === "ファン";
  if (!attaching) {
    const program = parseEffect(rest);
    if (!program)
      return {
        ok: false,
        reason: "このカードの効果は自動処理未対応のため使用できません",
      };
    // 使用するサポート自身は効果の解決中には手札にない。
    // 手札返却・引き直しの判定へ含めると、カード1枚だけでも使用可能になってしまう。
    const effectState: GameState = {
      ...s,
      players: [...s.players],
    };
    effectState.players[s.turnPlayer] = {
      ...p,
      hand: p.hand.filter((uid) => uid !== handUid),
    };
    // Q341: デッキ検索だけのサポートは、使用コストを払えても空デッキでは使えない。
    // 検索候補の有無ではなく、非公開領域にカードが存在するかだけを判定する。
    if (
      p.deck.length === 0 &&
      program.ops.some((op) => op.t === "searchDeck") &&
      program.ops.every((op) => op.t === "searchDeck" || op.t === "shuffleDeck")
    )
      return { ok: false, reason: "デッキにカードがありません" };
    // Q98: 効果が空振りしても、支払える使用コストのアーカイブで状態が変わる。
    // コストの支払可否は上の使用条件検査で確認済み。
    const changesByCost = conditions.some(
      (cond) =>
        ((cond.c === "holoPowerCost" || cond.c === "archiveYellCost") &&
          cond.n > 0) ||
        (cond.c === "archiveHandOrStageNamed" && cond.n > 0 && cond.stageN > 0),
    );
    if (
      !changesByCost &&
      !supportOpsCanChangeState(
        effectState,
        s.turnPlayer,
        program.ops,
        undefined,
        true,
      )
    )
      return {
        ok: false,
        reason: "このカードを解決してもゲームの状態を変えられません",
      };
  }
  return { ok: true };
}

/** 手札の付与先を実行時と同じ条件で判定する。表示用の判定では状態を変更しない。 */
export function canAttachSupportFromHand(
  s: GameState,
  handUid: string,
  pos: StagePosition,
): { ok: boolean; reason?: string } {
  const check = canPlaySupport(s, handUid);
  if (!check.ok) return check;
  const card = cardOf(s, handUid) as SupportCard;
  if (!["ツール", "マスコット", "ファン"].includes(card.supportType))
    return { ok: false, reason: "付与するサポートではありません" };
  const stack = getStack(s.players[s.turnPlayer], pos);
  if (!stack || stack.faceDown)
    return { ok: false, reason: "そこにホロメンがいません" };
  const error = attachError(s, stack, card);
  if (
    error &&
    !attachCostReliefUid(
      s,
      parsePlayConditions(card.description).conditions,
      stack,
      card,
    )
  )
    return { ok: false, reason: error };
  return { ok: true };
}

/** ステージ外から付け直したカードは新しい能力の発生源となる (4.1.4)。 */
export function resetAttachedCardUsage(s: GameState, uid: string): void {
  const activatedPrefix = `giftActivated:support:${uid}:`;
  const triggeredPrefix = `giftTriggered:support:${uid}:`;
  for (const key of Object.keys(s.usedTriggersThisTurn))
    if (
      key === uid ||
      key.startsWith(activatedPrefix) ||
      key.startsWith(triggeredPrefix)
    )
      delete s.usedTriggersThisTurn[key];
}

/**
 * 手札から付与サポートを付ける処理の締め (ログ・未対応警告・付与時トリガー)。
 * コスト支払いを挟む経路 (attachPlayedSupport op) と直接付ける経路で共用する。
 */
export function completePlayedAttach(
  s: GameState,
  pid: PlayerId,
  st: HolomenStack,
  handUid: string,
  pos: StagePosition,
): void {
  const c = cardOf(s, handUid);
  resetAttachedCardUsage(s, handUid);
  st.supports.push(handUid);
  log(
    s,
    pid,
    `サポート「${c.name}」(${c.cardType === "support" ? c.supportType : ""})を${posLabel(pos)}の${topCard(s, st).name}に付けました`,
  );
  if (c.cardType === "support" && !passiveOf(c).full)
    log(s, pid, `⚠「${c.name}」の一部効果は自動処理未対応です`);
  // 「手札から付けた時」トリガー
  runOps(s, {
    player: pid,
    sourceStackId: st.id,
    rest: [
      {
        t: "emitTriggers",
        stackId: st.id,
        events: ["attachedFromHand"],
        onlyUid: handUid,
      },
    ],
    label: `「${c.name}」`,
  });
  // 付与先ホロメンの「このホロメンに〈X〉が付いた時」ギフトトリガー
  emitSupportAttached(s, pid, st, handUid);
}

/** サポート使用の締め: 使用履歴 (「このターンに〜を使っていた」条件用) の記録 */
export function finishSupportUse(s: GameState, c: SupportCard): void {
  const p = s.players[s.turnPlayer];
  s.usedSupportNamesThisTurn[s.turnPlayer].push(...cardNames(c));
  s.usedSupportTypesThisTurn[s.turnPlayer].push(c.supportType);
  for (const tag of c.tags)
    s.usedSupportTagTypesThisTurn[s.turnPlayer].push(`${tag}|${c.supportType}`);
  if (c.limited) {
    p.usedLimitedThisTurn = true;
    p.limitedUsedCount = (p.limitedUsedCount ?? 0) + 1;
    // 「LIMITEDの(種別)を使っていた」条件用 (タグは'!'で始まらないため衝突しない)
    s.usedSupportTagTypesThisTurn[s.turnPlayer].push(
      `!LIMITED|${c.supportType}`,
    );
  }
}

/** 推しスキルの使用可否 */
export function canUseOshiSkill(
  s: GameState,
  sp: boolean,
): { ok: boolean; reason?: string } {
  if (s.phase !== "playing")
    return { ok: false, reason: "ゲームが進行中ではありません" };
  if (s.step !== "main")
    return {
      ok: false,
      reason: "推しスキルはメインステップにのみ使用できます",
    };
  const p = s.players[s.turnPlayer];
  const oshi = cardOf(s, p.oshiUid) as OshiCard;
  const skill = sp ? oshi.spOshiSkill : oshi.oshiSkill;
  if (!skill)
    return { ok: false, reason: "この推しホロメンはSP推しスキルを持ちません" };

  if (sp && p.usedSpOshiSkill)
    return { ok: false, reason: "SP推しスキルはゲームに1回しか使用できません" };
  const adj = oshiSkillAdjustments(s, s.turnPlayer, skill.name);
  const cost = skill.cost === "X" ? 1 : Math.max(0, skill.cost + adj.costDelta);
  if (!sp && oshiSkillUseCount(s, s.turnPlayer) >= 1 + adj.usesBonus)
    return {
      ok: false,
      reason: adj.usesBonus
        ? "推しスキルはこのターンの使用回数上限です"
        : "推しスキルはこのターンに使用済みです",
    };
  if (p.holoPower.length < cost)
    return {
      ok: false,
      reason: `ホロパワーが${cost - p.holoPower.length}枚不足しています（必要${cost}枚／現在${p.holoPower.length}枚）`,
    };
  // リアクティブスキルは該当タイミングで自動確認される
  if (parseOshiReactive(skill.description))
    return {
      ok: false,
      reason: "このスキルは該当タイミングで自動的に使用を確認されます",
    };
  // 条件付きスキル (「(条件)の時に使える：」)
  const conditional = parseOshiConditional(skill.description);
  if (conditional) {
    const condOk = evalCond(
      s,
      { player: s.turnPlayer, rest: [], label: "" },
      conditional.cond,
    );
    if (!condOk) return { ok: false, reason: "使用条件を満たしていません" };
    return { ok: true };
  }
  if (!parseEffect(skill.description))
    return {
      ok: false,
      reason: "このスキルの効果は自動処理未対応のため使用できません",
    };
  if (
    !canPayOptionalCost(
      s,
      { player: s.turnPlayer, rest: [], label: skill.name },
      parseOshiAdditionalCost(skill.description),
    )
  )
    return { ok: false, reason: "このスキルの追加コストを支払えません" };
  return { ok: true };
}

function giftActivatedReason(
  s: GameState,
  pid: PlayerId,
  entry: { pos: StagePosition; stack: HolomenStack },
  ab: NonNullable<GiftDef["activated"]>[number],
  index: number,
): string | null {
  if (!giftPositionOk(entry.pos, ab.positions))
    return `この能力は${ab.positions!.map(posLabel).join("・")}でのみ使用できます`;
  const key = `giftActivated:${entry.stack.cards[0]}:${index}`;
  if (
    ab.timesPerTurn !== undefined &&
    (s.usedTriggersThisTurn[key] ?? 0) >= ab.timesPerTurn
  )
    return ab.timesPerTurn === 1
      ? "この能力はこのターンに使用済みです"
      : "この能力はこのターンの使用回数上限に達しています";
  if (
    ab.cond &&
    !evalCond(
      s,
      { player: pid, sourceStackId: entry.stack.id, rest: [], label: "" },
      ab.cond,
    )
  )
    return "この能力の使用条件を満たしていません";
  if (!activatedCostPayable(s, pid, entry.stack, ab.ops))
    return "能力のコストを支払えません";
  // 永続能力による特別なBloomの操作は、実際にBloomできる組み合わせが必要。
  // 起動能力そのものには、サポートのプレイだけを制限する10.7.2.3.7を適用しない。
  if (
    ab.ops.every((op) => op.t === "effectBloom") &&
    !supportOpsCanChangeState(s, pid, ab.ops, entry.stack.id)
  )
    return "この効果でBloomできるホロメンがいません";
  return null;
}

export function giftActivatedUsable(
  ...args: Parameters<typeof giftActivatedReason>
): boolean {
  return giftActivatedReason(...args) === null;
}

/** 能力追加（5.19.1）の回数制限は、能力を得たホロメンも区別する。 */
export function attachedAbilityUseKey(
  stackId: number,
  supportUid: string,
  index: number,
  granted: boolean | undefined,
): string {
  return `giftActivated:support:${supportUid}:${index}${granted ? `:holder:${stackId}` : ""}`;
}

/** 付与カード(ツール/マスコット/ファン)の起動型能力が使用可能か */
function attachActivatedReason(
  s: GameState,
  pid: PlayerId,
  entry: { pos: StagePosition; stack: HolomenStack },
  ab: NonNullable<PassiveBonus["activated"]>[number],
  supportUid: string,
  index: number,
  cond: import("../effects").PassiveCondition | undefined,
): string | null {
  if (!giftPositionOk(entry.pos, ab.positions))
    return `この能力は${ab.positions!.map(posLabel).join("・")}でのみ使用できます`;
  if (ab.requiresCond && !passiveCondMatches(s, entry.stack, cond))
    return "この能力の使用条件を満たしていません";
  const key = attachedAbilityUseKey(
    entry.stack.id,
    supportUid,
    index,
    ab.requiresCond,
  );
  if (
    ab.timesPerTurn !== undefined &&
    (s.usedTriggersThisTurn[key] ?? 0) >= ab.timesPerTurn
  )
    return ab.timesPerTurn === 1
      ? "この能力はこのターンに使用済みです"
      : "この能力はこのターンの使用回数上限に達しています";
  if (!activatedCostPayable(s, pid, entry.stack, ab.ops, supportUid))
    return "能力のコストを支払えません";
  return null;
}

export function attachActivatedUsable(
  ...args: Parameters<typeof attachActivatedReason>
): boolean {
  return attachActivatedReason(...args) === null;
}

/** 使用済み・条件外の能力も含め、閲覧用に理由を返す。自動誘発能力は含めない。 */
export function giftAbilityOptions(
  s: GameState,
  pid: PlayerId,
): GiftAbilityOption[] {
  const out: GiftAbilityOption[] = [];
  const phaseReason =
    s.phase !== "playing"
      ? "ゲームが進行中ではありません"
      : s.turnPlayer !== pid
        ? "相手のターンです"
        : s.prompts.length
          ? "カードの選択・効果の処理を完了してください"
          : s.step !== "main"
            ? "この能力はメインステップに使用できます"
            : null;
  const add = (ref: GiftAbilityRef, reason: string | null) => {
    out.push({ ...ref, ok: !reason, ...(reason ? { reason } : {}) });
  };
  for (const entry of allStacks(s.players[pid])) {
    if (entry.stack.faceDown) continue;
    const top = topCard(s, entry.stack);
    giftOf(top).activated?.forEach((ab, index) => {
      add(
        {
          stackId: entry.stack.id,
          index,
          label: `${top.gift?.name ?? "能力"} (${positionedHolomenName(s, entry.pos, entry.stack)})`,
        },
        phaseReason ?? giftActivatedReason(s, pid, entry, ab, index),
      );
    });
    for (const uid of entry.stack.supports) {
      const c = cardOf(s, uid);
      if (c.cardType !== "support") continue;
      const p = passiveOf(c);
      p.activated?.forEach((ab, index) => {
        add(
          {
            stackId: entry.stack.id,
            index,
            label: `${c.name} (${positionedHolomenName(s, entry.pos, entry.stack)})`,
            supportUid: uid,
          },
          phaseReason ??
            attachActivatedReason(s, pid, entry, ab, uid, index, p.cond),
        );
      });
    }
  }
  const archiveHolomenCount = s.players[pid].archive.filter(
    (uid) => cardOf(s, uid).cardType === "holomen",
  ).length;
  for (const uid of s.players[pid].archive) {
    const c = cardOf(s, uid);
    if (c.cardType !== "holomen") continue;
    const ab = giftOf(c).archiveBloom;
    if (!ab) continue;
    const reason =
      phaseReason ??
      (archiveHolomenCount < ab.minArchiveHolomen
        ? `アーカイブのホロメンが${ab.minArchiveHolomen - archiveHolomenCount}枚不足しています`
        : allStacks(s.players[pid]).some(
              ({ stack }) => canBloomOnto(s, uid, stack).ok,
            )
          ? null
          : "このカードでBloomできるホロメンがいません");
    add(
      {
        stackId: 0,
        index: 0,
        archiveUid: uid,
        label: `${c.gift?.name ?? "能力"} (${c.name}/アーカイブ)`,
      },
      reason,
    );
  }
  return out;
}

/** 現在使用できる起動型能力。CPU・実行側には従来と同じ参照だけを返す。 */
export function usableGiftAbilities(
  s: GameState,
  pid: PlayerId,
): GiftAbilityRef[] {
  if (
    s.phase !== "playing" ||
    s.step !== "main" ||
    s.turnPlayer !== pid ||
    s.prompts.length > 0
  )
    return [];
  return giftAbilityOptions(s, pid)
    .filter((option) => option.ok)
    .map(({ ok, reason, ...ref }) => ref);
}

/** 任意コストを辞退した能力はプレイされていないため、使用回数を消費しない。 */
export function activatedOpsWithUseLimit(
  s: GameState,
  ops: Op[],
  key: string,
  timesPerTurn: number | undefined,
  label: string,
): Op[] {
  const result = structuredClone(ops);
  if (timesPerTurn === undefined) return result;
  const mark: Op = { t: "markTriggerUsed", key };
  let body = result;
  // 条件を満たした場合だけ支払うコスト（みこの35P条件など）も扱う。
  while (body[0]?.t === "if") body = body[0].then;
  const first = body[0];
  if (first?.t === "optionalCost") {
    first.then.unshift(mark);
  } else if (first?.t === "dice" && first.optional) {
    body[0] = {
      t: "chooseOps",
      label: `${label}: サイコロを${first.rolls ?? 1}回振りますか？`,
      thenOps: [mark, { ...first, optional: undefined }],
      elseOps: [],
    };
  } else {
    s.usedTriggersThisTurn[key] = (s.usedTriggersThisTurn[key] ?? 0) + 1;
  }
  return result;
}

/** 使用可能なアーツのindex一覧 */
export function usableArts(
  s: GameState,
  fromPos: "center" | "collab",
): number[] {
  if (s.phase !== "playing" || s.step !== "performance") return [];
  const p = s.players[s.turnPlayer];
  const st = getStack(p, fromPos);
  const positionUsed =
    fromPos === "center" ? p.usedCenterArtThisTurn : p.usedCollabArtThisTurn;
  if (!st || st.resting || st.usedArtsThisTurn || positionUsed) return [];
  return availableArts(s, st)
    .map((_, i) => (canUseArt(s, s.turnPlayer, fromPos, i).ok ? i : -1))
    .filter((i) => i >= 0);
}

/** 相手の永続能力による対象制限。効果による対象変更にも適用する (1.3.3)。 */
function opponentArtTargetError(
  s: GameState,
  pid: PlayerId,
  pos: StagePosition,
): string | null {
  if (pos !== "collab") {
    const opponent = other(pid);
    const opp = s.players[opponent];
    for (const entry of allStacks(opp)) {
      const taunt = giftOf(topCard(s, entry.stack)).taunt;
      if (!taunt) continue;
      if (!giftPositionOk(entry.pos, taunt.positions)) continue;
      if (
        taunt.cond &&
        !evalCond(
          s,
          {
            player: opponent,
            sourceStackId: entry.stack.id,
            rest: [],
            label: "",
          },
          taunt.cond,
        )
      )
        continue;
      if (opp.collab)
        return `相手のギフト「${topCard(s, entry.stack).gift?.name ?? ""}」により、アーツはコラボホロメンしか対象にできません`;
    }
  }
  return null;
}

/** アーツの通常の対象制限を満たすか。初回使用と再使用で共通化する。 */
export function artTargetError(
  s: GameState,
  pid: PlayerId,
  source: HolomenStack,
  art: HolomenCard["arts"][number],
  target: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
): string | null {
  if (target.player !== other(pid)) return "相手のホロメンを選んでください";

  if (
    /このアーツは、相手のセンターホロメンしか対象にできない/.test(
      art.description,
    ) &&
    target.pos !== "center"
  )
    return "このアーツは相手のセンターホロメンしか対象にできません";

  if (typeof target.pos !== "string") {
    const sourceCard = topCard(s, source);
    const giftExt = giftOf(sourceCard).selfArtTargetExtend;
    const giftExtOk =
      !!giftExt &&
      (!giftExt.cond ||
        evalCond(
          s,
          { player: pid, sourceStackId: source.id, rest: [], label: "" },
          giftExt.cond,
        )) &&
      (!giftExt.filter || stackMatchesFilter(s, target.stack, giftExt.filter));
    // Q205: コスト後の対象変更を、支払い前の無条件な対象拡張にしない。
    const changesTargetAfterCost = parseEffect(art.description)?.ops.some(
      (op) =>
        op.t === "optionalCost" &&
        op.then.some((next) => next.t === "changeArtTargetToOppBack"),
    );
    const extendOk =
      (!changesTargetAfterCost &&
        /このアーツは、?相手のバックホロメンも対象にできる/.test(
          art.description,
        )) ||
      giftExtOk ||
      (s.artUsesThisTurn[pid].length === 2 &&
        !stackBloomLevels(s, target.stack).includes("Debut") &&
        s.turnModifiers.some(
          (m) => m.stackId === source.id && m.thirdArtBackTarget,
        )) ||
      s.turnModifiers.some(
        (m) =>
          m.stackId === source.id &&
          m.artTargetExtend !== undefined &&
          stackMatchesFilter(s, target.stack, m.artTargetExtend),
      );
    if (!extendOk) return "このアーツは相手のバックホロメンを対象にできません";
  }

  return opponentArtTargetError(s, pid, target.pos);
}

export function legalArtTargets(
  s: GameState,
  pid: PlayerId,
  source: HolomenStack,
  art: HolomenCard["arts"][number],
): { player: PlayerId; pos: StagePosition; stack: HolomenStack }[] {
  const opponent = other(pid);
  return allStacks(s.players[opponent])
    .map((entry) => ({ player: opponent, ...entry }))
    .filter((entry) => artTargetError(s, pid, source, art, entry) === null);
}

export function artGateError(
  s: GameState,
  pid: PlayerId,
  st: HolomenStack,
  fromPos: "center" | "collab",
  art: HolomenCard["arts"][number],
): string | null {
  for (const gate of parseArtGates(art.description)) {
    if (
      gate.requireAttachedNames &&
      !st.supports.some((u) => cardHasName(s, u, gate.requireAttachedNames!))
    )
      return `このアーツは「${gate.requireAttachedNames.join("・")}」が付いていないと使用できません`;
    if (
      gate.requireArchiveSupport !== undefined &&
      s.players[pid].archive.filter((u) => cardOf(s, u).cardType === "support")
        .length < gate.requireArchiveSupport
    )
      return `このアーツは自分のアーカイブにサポートカードが${gate.requireArchiveSupport}枚以上ないと使用できません`;
    if (
      gate.collabRequires &&
      fromPos === "collab" &&
      !evalCond(
        s,
        { player: pid, sourceStackId: st.id, rest: [], label: "" },
        gate.collabRequires,
      )
    )
      return "このアーツは条件を満たしていないためコラボポジションでは使用できません";
  }
  return null;
}

/** 対象を選ぶ前のアーツ使用可否。実行時と同じコスト・使用条件を調べる。 */
export function canUseArt(
  s: GameState,
  pid: PlayerId,
  fromPos: "center" | "collab",
  artIndex: number,
): { ok: boolean; reason?: string } {
  const p = s.players[pid];
  const st = getStack(p, fromPos);
  let reason: string | undefined;
  if (s.phase !== "playing") reason = "ゲームが進行中ではありません";
  else if (s.turnPlayer !== pid) reason = "相手のターンです";
  else if (s.prompts.length)
    reason = "カードの選択・効果の処理を完了してください";
  else if (s.step !== "performance")
    reason = "アーツはパフォーマンスステップに使用できます";
  else if (!st) reason = "そこにホロメンがいません";
  else if (st.resting) reason = "お休み中のホロメンはアーツを使用できません";
  else if (st.usedArtsThisTurn)
    reason = "このホロメンはこのターンにアーツを使用済みです";
  else if (
    fromPos === "center" ? p.usedCenterArtThisTurn : p.usedCollabArtThisTurn
  )
    reason = `${posLabel(fromPos)}ではこのターンにアーツを使用済みです`;
  else {
    const art = availableArts(s, st)[artIndex];
    if (!art) reason = "アーツが見つかりません";
    else
      reason =
        artCostCheck(s, st, art.cost, art.description).reason ??
        artGateError(s, pid, st, fromPos, art) ??
        (legalArtTargets(s, pid, st, art).length
          ? undefined
          : "このアーツで攻撃できる相手ホロメンがいません");
  }
  return reason ? { ok: false, reason } : { ok: true };
}

export function recordArtUse(
  s: GameState,
  pid: PlayerId,
  pos: StagePosition,
  stack: HolomenStack,
): void {
  (s.artUsesThisTurn ??= [[], []])[pid].push({
    names: stackNames(s, stack),
    tags: [...topCard(s, stack).tags],
    pos,
  });
}

/** アーツ1回分のOp列を構築し、ダウン時の処理・与ダメージ時の自動能力を記録する。 */
export function buildArtOps(
  s: GameState,
  art: HolomenCard["arts"][number],
  target: HolomenStack,
  fromPos: StagePosition,
): Op[] {
  const ops: Op[] = [];
  const afterDamage: Op[] = [];
  const downedOps: Op[] = [];
  if (art.description) {
    const program = parseEffect(art.description);
    if (program) {
      // ダウン時能力は11.3.1.1へ渡す。与ダメージ時の回復は、
      // 他の待機能力と順序を選べる自動能力としてダメージ処理へ渡す。
      // 位置ヘッダはアーツ本体の使用制限ではなく、本文の効果の発揮条件。
      // ダウン時に解決する効果も含め、今回アーツを使った位置で判定する。
      const positionOk =
        !program.positions ||
        program.positions.some((pos) => matchesPosition(fromPos, pos));
      for (const op of positionOk ? program.ops : []) {
        if (op.t === "if" && op.cond.c === "artDowned") downedOps.push(op);
        else if (op.t === "healSelfPerArtDealt") afterDamage.push(op);
        else ops.push(op);
      }
    } else
      log(
        s,
        s.turnPlayer,
        `⚠ アーツ効果「${art.description}」は自動処理未対応のため発揮されません`,
      );
  }
  ops.push({
    t: "artDamage",
    base: parseInt(art.power, 10) || 0,
    specialColor: art.special_attack.target,
    specialDmg: parseInt(art.special_attack.power ?? "0", 10) || 0,
    targetStackId: target.id,
    artName: art.name,
    downedOps: downedOps.length ? downedOps : undefined,
    dealtOps: afterDamage.length ? afterDamage : undefined,
  });
  ops.push({ t: "repeatArtCheck" });
  return ops;
}

/** 初回に確定した印刷上の定義から、再使用する同じアーツを復元する。 */
function artFromContext(
  s: GameState,
  ctx: EffectContextData,
  source: HolomenStack,
): HolomenCard["arts"][number] | undefined {
  if (ctx.artRef) {
    const card = getCard(ctx.artRef.cardId);
    return card.cardType === "holomen"
      ? card.arts[ctx.artRef.index]
      : undefined;
  }
  // 保存前の進行状態と、artIndexだけを組み立てる既存テストの互換経路。
  return ctx.artIndex === undefined
    ? undefined
    : availableArts(s, source)[ctx.artIndex];
}

/** 再使用を新しい1回のアーツとして開始するため、前回だけの結果を破棄する。 */
function resetArtTransientContext(
  ctx: EffectContextData,
  sourceStackId: number,
  targetStackId: number | undefined,
  artName: string,
): void {
  ctx.sourceStackId = sourceStackId;
  ctx.sourceCardUid = undefined;
  ctx.supportChangedState = undefined;
  ctx.sourceSupportUid = undefined;
  ctx.grantedSupportAbility = undefined;
  ctx.artTargetStackId = targetStackId;
  ctx.artPrimaryTargetStackId = targetStackId;
  ctx.artNoReduce = undefined;
  ctx.specialDamageBatch = undefined;
  ctx.pendingRuleCauses = undefined;
  ctx.pendingLifeDamage = undefined;
  ctx.artBonus = 0;
  ctx.boundStackId = undefined;
  ctx.boundStackIds = undefined;
  ctx.bloomedFromDebut = undefined;
  ctx.bloomedFromBuzz = undefined;
  ctx.bloomedByOshiSkill = undefined;
  ctx.lastArtDowned = undefined;
  ctx.lastArtDownedPos = undefined;
  ctx.artUsedEmitted = undefined;
  ctx.lastOverkill = undefined;
  ctx.lastArtDealt = undefined;
  ctx.triggerDamage = undefined;
  ctx.artDiceSum = undefined;
  ctx.revealed = undefined;
  ctx.revealedOwnerOnly = undefined;
  ctx.revealedOwner = undefined;
  ctx.revealedHistory = undefined;
  ctx.milled = undefined;
  ctx.replacementArchived = undefined;
  ctx.pickedCards = undefined;
  ctx.pickedCardsOwnerOnly = undefined;
  ctx.pickedCardsOwner = undefined;
  ctx.returnedBoth = undefined;
  ctx.returnedYell = undefined;
  ctx.healed = undefined;
  ctx.downedCards = undefined;
  ctx.downedYells = undefined;
  ctx.downedSupports = undefined;
  ctx.downedStackId = undefined;
  ctx.pendingAttach = undefined;
  ctx.attachedToStackId = undefined;
  ctx.attachedToStackIds = undefined;
  ctx.lastAttachedCount = undefined;
  // 前のアーツで待機した能力はrepeatArtCheck前に解決済み。
  ctx.pendingTriggers = undefined;
  ctx.label = `アーツ「${artName}」`;
}

/**
 * 被弾側で同時に適用できる置換効果を列挙する。
 * 総合ルール10.11.2により、複数ある場合は影響を受けるプレイヤーが順番を選ぶ。
 */
function incomingDamageReplacementChoices(
  s: GameState,
  target: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  o: {
    art: boolean;
    noReduce?: boolean;
    attacker: PlayerId;
    diceDone: number[];
    replacementDone: string[];
    artOrder?: { raw: number; reduced: number; firstReduction: number };
  },
): DamageReplacementChoice[] {
  const defender = target.player;
  if (defender === o.attacker) return [];
  const done = new Set(o.replacementDone);
  const choices: DamageReplacementChoice[] = [];

  for (const ur of usableOshiReactives(
    s,
    defender,
    "damagedByOpp",
    target.stack,
  )) {
    const reactive = ur.reactive;
    if (reactive.when !== "damagedByOpp") continue;
    if (o.noReduce && reactive.reduce !== undefined) continue;
    const id = "oshi:" + (ur.sp ? "sp" : "normal") + ":" + ur.skill.name;
    if (done.has(id)) continue;
    const redirectUsable =
      !reactive.redirect ||
      (o.art &&
        allStacks(s.players[defender]).some((e) =>
          stackMatchesFilter(s, e.stack, reactive.redirect),
        ));
    if (!redirectUsable) continue;
    const ops = reactive.redirect
      ? ([
          { t: "chooseBind", scope: "own", filter: reactive.redirect },
          { t: "redirectDamage" },
        ] satisfies Op[])
      : reactive.ops;
    choices.push({
      id,
      label:
        (ur.sp ? "SP推しスキル" : "推しスキル") + "「" + ur.skill.name + "」",
      kind: "oshi",
      sp: ur.sp,
      skillName: ur.skill.name,
      description: ur.skill.description,
      cost: ur.cost,
      promptKind: ops ? "ops" : "reduce",
      reduce: reactive.reduce,
      reduceAll: reactive.reduceAll,
      ops,
      wrapResume: !!ops,
      targetStackId: target.stack.id,
    });
  }

  // 軽減不可でも身代わりやエール付け替えは使える (5.22.3.1)。
  // 以下のサポート・ギフトはダメージの軽減/無効化なので候補にしない。
  if (o.noReduce) return choices;

  const immunity = giftOf(topCard(s, target.stack)).noArtDamageAtLeast;
  const order = o.artOrder;
  if (
    immunity &&
    order &&
    order.raw >= immunity.n &&
    order.reduced > 0 &&
    (order.firstReduction > 0 || order.reduced < immunity.n) &&
    evalCond(
      s,
      { player: defender, sourceStackId: target.stack.id, rest: [], label: "" },
      immunity.cond,
    )
  ) {
    // 5.22.4 / 10.11.2: 閾値による無効も、受けるダメージの置換。
    // 数値の軽減より常に後にすると、初回軽減を温存する順序を選べない。
    const name = topCard(s, target.stack).gift?.name ?? "";
    choices.push(
      {
        id: `artOrder:${target.stack.id}:immunity`,
        kind: "artDamageOrder",
        holderStackId: target.stack.id,
        order: "immunity",
        label: `ギフト「${name}」を先に適用`,
        description:
          `${immunity.n}以上のアーツダメージを先に受けなくします。` +
          (order.firstReduction > 0 ? "最初の一撃の軽減は残ります。" : ""),
      },
      {
        id: `artOrder:${target.stack.id}:reductions`,
        kind: "artDamageOrder",
        holderStackId: target.stack.id,
        order: "reductions",
        label:
          order.firstReduction > 0
            ? `最初のアーツダメージ-${order.firstReduction}を先に適用`
            : "ダメージ軽減を先に適用",
        description:
          "先にダメージを軽減し、その後の値でギフトの無効化条件を確認します。",
      },
    );
  }

  if (s.turnPlayer !== defender) {
    for (const uid of target.stack.supports) {
      const id = "support:" + uid;
      if (done.has(id)) continue;
      const sc = cardOf(s, uid);
      if (sc.cardType !== "support") continue;
      const pb = passiveOf(sc);
      if (!pb.damageReduce) continue;
      if (
        pb.damageReduce.requiresCond &&
        !passiveCondMatches(s, target.stack, pb.cond)
      )
        continue;
      choices.push({
        id,
        label: "「" + sc.name + "」",
        kind: "support",
        supportUid: uid,
        targetStackId: target.stack.id,
        reduce: pb.damageReduce.value,
      });
    }
  }

  for (const { pos: hPos, stack: holder } of allStacks(s.players[defender])) {
    const shield = giftOf(topCard(s, holder)).backSpecialShield;
    const shieldId = "backSpecialShield:" + holder.id;
    if (
      shield &&
      !o.art &&
      typeof target.pos !== "string" &&
      (!shield.oppTurnOnly || s.turnPlayer !== defender) &&
      holder.cards.length > 1 &&
      !done.has(shieldId)
    ) {
      const holderName = positionedHolomenName(s, hPos, holder);
      choices.push({
        id: shieldId,
        label: `ギフト「${topCard(s, holder).gift?.name ?? ""}」(${holderName})`,
        kind: "backSpecialShield",
        holderStackId: holder.id,
        holderName,
      });
    }
    const id = "gift:" + holder.id;
    if (done.has(id) || o.diceDone.includes(holder.id)) continue;
    const adr = giftOf(topCard(s, holder)).allyDamageDiceReduce;
    if (!adr) continue;
    if (!giftPositionOk(hPos, adr.positions)) continue;
    if (adr.excludeSelf && holder.id === target.stack.id) continue;
    if (adr.filter && !stackMatchesFilter(s, target.stack, adr.filter))
      continue;
    const key = "giftAllyDiceReduce:" + holder.cards[0];
    if (
      adr.timesPerTurn !== undefined &&
      (s.usedTriggersThisTurn[key] ?? 0) >= adr.timesPerTurn
    )
      continue;
    const branches: Extract<Op, { t: "dice" }>["branches"] = [];
    if (adr.oddNegate)
      branches.push({
        cond: "odd",
        ops: [{ t: "reduceReceivedDamage", value: 0, negate: true }],
      });
    else if (adr.oddReduce !== undefined)
      branches.push({
        cond: "odd",
        ops: [{ t: "reduceReceivedDamage", value: adr.oddReduce }],
      });
    if (adr.evenReduce !== undefined)
      branches.push({
        cond: "even",
        ops: [{ t: "reduceReceivedDamage", value: adr.evenReduce }],
      });
    const holderName = positionedHolomenName(s, hPos, holder);
    choices.push({
      id,
      label:
        "ギフト「" +
        (topCard(s, holder).gift?.name ?? "") +
        "」(" +
        holderName +
        ")",
      kind: "gift",
      holderStackId: holder.id,
      holderName,
      key: adr.timesPerTurn !== undefined ? key : undefined,
      branches,
    });
  }
  return choices;
}

/** 選ばれた置換効果について、従来と同じ任意使用確認を出す。 */
export function offerIncomingDamageReplacement(
  s: GameState,
  defender: PlayerId,
  choice: DamageReplacementChoice,
  ctx: EffectContextData,
): void {
  if (choice.kind === "artDamageOrder") {
    const pending = pendingIncomingDamage(ctx);
    if (!pending || pending.t !== "artDamage")
      throw new Error("適用順を選ぶアーツがありません");
    pending.thresholdOrderResolved = true;
    if (choice.order === "immunity") pending.negate = true;
    else {
      const target = findStackById(s, pending.targetStackId);
      const sourceId = ctx.artSourceStackId ?? ctx.sourceStackId;
      const source = sourceId ? findStackById(s, sourceId) : null;
      if (target) {
        const calculated = calculateArtDamage(
          s,
          ctx,
          pending,
          target,
          source,
          false,
        );
        if (calculated.damage > 0 && calculated.firstMods.length > 0) {
          const reduce = calculated.firstMods.reduce(
            (sum, mod) => sum + mod.firstArtDamageReduce!,
            0,
          );
          s.turnModifiers = s.turnModifiers.filter(
            (mod) => !calculated.firstMods.includes(mod),
          );
          pending.extraReduce = (pending.extraReduce ?? 0) + reduce;
          log(s, defender, `効果により受けるアーツダメージ-${reduce}`);
        }
      }
    }
    finishIncomingDamageReplacement(ctx, choice.id);
    runOps(s, ctx);
    return;
  }
  if (choice.kind === "backSpecialShield") {
    pushPrompt(s, {
      type: "effectConfirm",
      player: defender,
      label: `${choice.label}でバックへの特殊ダメージを防ぎますか？`,
      thenOps: [
        { t: "setSource", stackId: choice.holderStackId },
        { t: "archiveStacked", n: 1 },
        { t: "turnBackSpecialImmune" },
      ],
      damageReplacementId: choice.id,
      ctx: {
        player: defender,
        rest: [{ t: "resume", inner: ctx }],
        label: "特殊ダメージ防護",
      },
    });
    return;
  }
  if (choice.kind === "oshi") {
    const reactiveCtx: EffectContextData =
      choice.promptKind === "ops" && choice.wrapResume
        ? {
            player: defender,
            sourceStackId: choice.targetStackId,
            rest: [{ t: "resume", inner: ctx }],
            label: "「" + choice.skillName + "」",
          }
        : ctx;
    pushPrompt(s, {
      type: "reactiveSkill",
      player: defender,
      sp: choice.sp,
      skillName: choice.skillName,
      description: choice.description,
      cost: choice.cost,
      kind: choice.promptKind,
      reduce: choice.reduce,
      reduceAll: choice.reduceAll,
      ops: choice.ops,
      damageReplacementId: choice.id,
      ctx: reactiveCtx,
    });
    return;
  }

  if (choice.kind === "support") {
    const sc = cardOf(s, choice.supportUid);
    pushPrompt(s, {
      type: "effectConfirm",
      player: defender,
      label: `「${sc.name}」をアーカイブして、ダメージを-${choice.reduce}しますか？`,
      thenOps: [
        {
          t: "setSource",
          stackId: choice.targetStackId,
          supportUid: choice.supportUid,
        },
        { t: "archiveSelfSupport" },
        { t: "reduceReceivedDamage", value: choice.reduce },
      ],
      damageReplacementId: choice.id,
      ctx: {
        player: defender,
        rest: [{ t: "resume", inner: ctx }],
        label: "「" + sc.name + "」",
      },
    });
    return;
  }

  const thenOps: Op[] = [
    { t: "setSource", stackId: choice.holderStackId },
    { t: "dice", rolls: 1, branches: choice.branches },
  ];
  if (choice.key) thenOps.unshift({ t: "markGiftUsed", key: choice.key });
  pushPrompt(s, {
    type: "effectConfirm",
    player: defender,
    label: "「" + choice.holderName + "」の能力でサイコロを振りますか？",
    thenOps,
    damageReplacementId: choice.id,
    ctx: {
      player: defender,
      rest: [{ t: "resume", inner: ctx }],
      label: "「" + choice.holderName + "」",
    },
  });
}

function pendingIncomingDamage(
  ctx: EffectContextData,
): PendingIncomingDamage | null {
  for (const op of ctx.rest) {
    if (op.t === "artDamage" || op.t === "specialToStack") return op;
    if (op.t === "resume") {
      const pending = pendingIncomingDamage(op.inner);
      if (pending) return pending;
    }
  }
  return null;
}

/** 「全員」の軽減を同じ特殊ダメージ事象へ適用し、次の事象とは分離する。 */
function reduceIncomingDamage(
  s: GameState,
  ctx: EffectContextData,
  player: PlayerId,
  reduce: number,
  all?: TargetFilter,
): void {
  for (const op of ctx.rest) {
    if (op.t === "resume") {
      if (pendingIncomingDamage(op.inner)) {
        reduceIncomingDamage(s, op.inner, player, reduce, all);
        return;
      }
      continue;
    }
    if (op.t !== "artDamage" && op.t !== "specialToStack") continue;
    if (!all || op.t === "artDamage" || !ctx.specialDamageBatch) {
      op.extraReduce = (op.extraReduce ?? 0) + reduce;
      return;
    }
    const matches = (id: number) => {
      const target = findStackById(s, id);
      return (
        target?.player === player && stackMatchesFilter(s, target.stack, all)
      );
    };
    // 防御確認の順番にかかわらず、まだHPへ適用していない同時ダメージ全体を軽減。
    for (const hit of ctx.specialDamageBatch) {
      if (matches(hit.targetStackId))
        hit.damage = Math.max(0, hit.damage - reduce);
    }
    for (const pending of ctx.rest) {
      if (pending.t === "finishSpecialDamageBatch") break;
      if (pending.t === "specialToStack" && matches(pending.targetStackId))
        pending.extraReduce = (pending.extraReduce ?? 0) + reduce;
    }
    return;
  }
}

type DamageTarget = NonNullable<ReturnType<typeof findStackById>>;

/** 受ける側の軽減・免疫と、アーツの対象に対する特攻・条件を区別する。 */
function originalArtDamageTarget(
  s: GameState,
  op: Extract<Op, { t: "artDamage" }>,
  recipient: DamageTarget,
): DamageTarget | null {
  return op.originalTargetStackId === undefined
    ? recipient
    : findStackById(s, op.originalTargetStackId);
}

function artDamageIgnoresReduction(
  s: GameState,
  ctx: EffectContextData,
  target: DamageTarget | null,
  src: DamageTarget | null,
) {
  // 付与サポートの「このホロメンのアーツダメージは軽減されない」
  let noReduce = !!ctx.artNoReduce;
  if (
    src &&
    target &&
    giftOf(topCard(s, src.stack)).artNoReduceArchiveTargetColor
  ) {
    const targetColors = stackColors(s, target.stack);
    noReduce = s.players[src.player].archive.some((uid) => {
      const c = cardOf(s, uid);
      return c.cardType === "yell" && targetColors.includes(c.color);
    });
  }
  if (src) {
    for (const uid of src.stack.supports) {
      const c = cardOf(s, uid);
      if (c.cardType !== "support") continue;
      const b = passiveOf(c);
      if (
        b.artNoReduce &&
        (!b.artNoReduce.requiresCond ||
          passiveCondMatches(s, src.stack, b.cond))
      )
        noReduce = true;
    }
  }
  return noReduce;
}

/** アーツ使用時の誘発収集で参照する、実際の公開とダメージの情報。 */
function artTriggerEventData(ctx: EffectContextData, damage: number) {
  return {
    value: damage,
    art: true,
    artName: ctx.artName,
    revealed: !!ctx.revealed?.length && !ctx.revealedOwnerOnly,
  };
}

// 表示と実ダメージ適用で同じ計算を使う。状態・乱数・使用履歴を変更しない。
function calculateArtDamage(
  s: GameState,
  ctx: EffectContextData,
  op: Extract<Op, { t: "artDamage" }>,
  target: DamageTarget,
  src: DamageTarget | null,
  noReduce: boolean,
) {
  let damage = op.base + (ctx.artBonus ?? 0);
  if (src) damage += artBonusOf(s, src.stack);
  let specialApplied = false;
  const artTarget = originalArtDamageTarget(s, op, target);
  const targetColors = artTarget ? stackColors(s, artTarget.stack) : [];
  if (
    op.specialColor &&
    op.specialDmg > 0 &&
    targetColors.includes(op.specialColor)
  ) {
    damage += op.specialDmg;
    specialApplied = true;
  }
  // ターン修正の「(色)特攻+Xを得る」
  if (src) {
    for (const tm of s.turnModifiers) {
      if (
        tm.stackId === src.stack.id &&
        tm.specialAttack &&
        (tm.expiresTurn ?? s.turn) >= s.turn &&
        targetColors.includes(tm.specialAttack.color)
      ) {
        damage += tm.specialAttack.value;
        specialApplied = true;
      }
    }
  }
  let taken = damageTakenDeltaOf(s, target, {
    art: true,
    source: src,
    noReduce,
  });
  // ギフトの「受けるアーツダメージ±X」
  const giftTaken = giftOf(topCard(s, target.stack)).artDamageTaken ?? 0;
  if (!noReduce || giftTaken > 0) taken += giftTaken;
  if (!noReduce && src)
    for (const mod of s.turnModifiers)
      if (
        mod.stackId === target.stack.id &&
        mod.artReduceFrom &&
        turnEffectActive(s, mod) &&
        stackBloomLevels(s, src.stack).includes(mod.artReduceFrom.level)
      )
        taken -= mod.artReduceFrom.value;
  if (taken !== 0) damage = Math.max(0, damage + taken);
  // ギフトのサイコロ軽減による無効化 (「そのダメージを受けない」)
  if (op.negate && !noReduce) damage = 0;
  const reduced = noReduce ? 0 : (op.extraReduce ?? 0);
  if (reduced > 0) damage = Math.max(0, damage - reduced);
  // 「最初に受けるアーツダメージ-X」のターン修正 (消費型)
  const firstMods = s.turnModifiers.filter(
    (tm) =>
      tm.stackId === target.stack.id &&
      tm.firstArtDamageReduce !== undefined &&
      turnEffectActive(s, tm) &&
      (!tm.firstArtDamagePos ||
        matchesPosition(target.pos, tm.firstArtDamagePos)),
  );
  return { damage, specialApplied, taken, reduced, firstMods };
}

function applyArtDamageImmunity(
  s: GameState,
  target: DamageTarget,
  damage: number,
  noReduce: boolean,
) {
  // アーツ-Xの修正で合計が負になることがある。ダメージは0未満にならない
  // (5.22.2: 0ダメージは「ダメージを与える/受ける」に当たらない)
  damage = Math.max(0, damage);
  const immune = giftOf(topCard(s, target.stack)).noArtDamageAtLeast;
  if (
    !noReduce &&
    immune &&
    damage >= immune.n &&
    evalCond(
      s,
      {
        player: target.player,
        sourceStackId: target.stack.id,
        rest: [],
        label: "",
      },
      immune.cond,
    )
  )
    damage = 0;
  return damage;
}

function calculateSpecialDamage(
  s: GameState,
  ctx: EffectContextData,
  entry: DamageTarget,
  apply: Extract<Prompt, { type: "effectTarget" }>["apply"] & { t: "special" },
  beforeReduction = false,
) {
  // 発生源の「与える特殊ダメージ+X」パッシブ
  let dealtPlus = 0;
  const srcEntry = ctx.sourceStackId
    ? findStackById(s, ctx.sourceStackId)
    : null;
  if (srcEntry && srcEntry.player !== entry.player) {
    for (const uid of srcEntry.stack.supports) {
      const c = cardOf(s, uid);
      if (c.cardType !== "support") continue;
      const b = passiveOf(c);
      if (!b.specialDealtPlus) continue;
      if (
        b.specialDealtPlus.requiresCond &&
        !passiveCondMatches(s, srcEntry.stack, b.cond)
      )
        continue;
      // 「相手のセンターホロメンに与える特殊ダメージ+X」は対象がセンターの時のみ
      if (b.specialDealtPlus.centerOnly && entry.pos !== "center") continue;
      dealtPlus += b.specialDealtPlus.value;
    }
  }
  // 発生源側のギフトによる「味方が与える特殊ダメージ+X」オーラ。
  // includeOshi のオーラは、発生源スタックを持たない推しスキルにも適用する。
  const auraSourcePlayer = srcEntry
    ? srcEntry.player
    : ctx.originOshiSkill
      ? ctx.player
      : null;
  if (auraSourcePlayer !== null && auraSourcePlayer !== entry.player) {
    const srcOwner = s.players[auraSourcePlayer];
    const sourceOshi = ctx.originOshiSkill
      ? (cardOf(s, srcOwner.oshiUid) as OshiCard)
      : null;
    for (const { pos: hPos, stack: holder } of allStacks(srcOwner)) {
      const hg = giftOf(topCard(s, holder));
      if (!hg.specialDealtAuras) continue;
      for (const aura of hg.specialDealtAuras) {
        if (!giftPositionOk(hPos, aura.positions)) continue;
        if (aura.centerOnly && entry.pos !== "center") continue;
        if (srcEntry) {
          if (
            aura.filter &&
            !stackMatchesFilter(s, srcEntry.stack, aura.filter)
          )
            continue;
        } else {
          if (!aura.includeOshi || !sourceOshi) continue;
          if (
            aura.filter?.names &&
            !aura.filter.names.includes(sourceOshi.name)
          )
            continue;
          if (aura.filter?.color && aura.filter.color !== sourceOshi.color)
            continue;
        }
        dealtPlus += aura.value;
      }
    }
  }
  // 「このターンの間、選んだホロメンが与える特殊ダメージ+X」のターン修正
  if (srcEntry && srcEntry.player !== entry.player) {
    for (const tm of s.turnModifiers) {
      if (
        tm.stackId === srcEntry.stack.id &&
        tm.specialPlus &&
        (tm.expiresTurn ?? s.turn) >= s.turn
      )
        dealtPlus += tm.specialPlus;
    }
  }
  // 情報を参照する軽減条件には最終情報を使う。場を離れた付属・ギフトは復活させない。
  const sourceInfo =
    srcEntry ??
    (ctx.sourceStackId ? s.lastKnownHolomen?.[ctx.sourceStackId] : null);
  const taken = damageTakenDeltaOf(s, entry, {
    art: false,
    source: sourceInfo,
    noReduce: beforeReduction,
  });
  const dmg = Math.max(
    0,
    apply.dmg +
      dealtPlus +
      taken -
      (beforeReduction ? 0 : (apply.extraReduce ?? 0)),
  );
  return dmg;
}

/** 防御確認で止まっている現在の一撃だけを表示する。後続の一撃は含めない。 */
export function incomingDamageInfo(
  s: GameState,
  ctx: EffectContextData,
): {
  kind: "art" | "special";
  damage: number;
  targetName: string;
  sourceLabel: string;
} | null {
  for (const op of ctx.rest) {
    if (op.t === "resume") {
      const info = incomingDamageInfo(s, op.inner);
      if (info) return info;
    }
    if (op.t !== "artDamage" && op.t !== "specialToStack") continue;
    const target = findStackById(s, op.targetStackId);
    if (!target || target.stack.faceDown) return null;
    const src = findStackById(
      s,
      (op.t === "artDamage" ? ctx.artSourceStackId : undefined) ??
        ctx.sourceStackId ??
        -1,
    );
    let damage = 0;
    if (op.t === "artDamage") {
      const noReduce = artDamageIgnoresReduction(
        s,
        ctx,
        originalArtDamageTarget(s, op, target),
        src,
      );
      const immune =
        !noReduce &&
        target.player !== ctx.player &&
        (isDamageImmune(s, target) || isArtImmune(s, target));
      const calculated = calculateArtDamage(s, ctx, op, target, src, noReduce);
      damage = calculated.damage;
      if (damage > 0 && !noReduce)
        damage = Math.max(
          0,
          damage -
            calculated.firstMods.reduce(
              (sum, mod) => sum + mod.firstArtDamageReduce!,
              0,
            ),
        );
      damage = immune ? 0 : applyArtDamageImmunity(s, target, damage, noReduce);
    } else if (
      !op.negate &&
      !isProtectedFrom(s, target, ctx.player) &&
      !isSpecialImmune(s, target, ctx.player) &&
      !(target.player !== ctx.player && isDamageImmune(s, target))
    ) {
      damage = calculateSpecialDamage(s, ctx, target, { ...op, t: "special" });
    }
    return {
      kind: op.t === "artDamage" ? "art" : "special",
      damage,
      targetName: `${playerName(s, target.player)}の${positionedHolomenName(s, target.pos, target.stack)}`,
      sourceLabel: op.t === "artDamage" ? `アーツ「${op.artName}」` : ctx.label,
    };
  }
  return null;
}

/** 使用・辞退した置換効果を記録し、残る置換効果をもう一度確認可能にする。 */
export function finishIncomingDamageReplacement(
  ctx: EffectContextData,
  id: string | undefined,
): void {
  if (!id) return;
  const pending = pendingIncomingDamage(ctx);
  if (!pending) return;
  pending.replacementDone = [
    ...new Set([...(pending.replacementDone ?? []), id]),
  ];
  pending.interruptChecked = false;
}

/**
 * 被弾側の「ダメージを受ける時」置換効果を確認プロンプトにする。
 * 複数なら適用順を選ばせ、1つなら直接その効果の任意使用確認を出す。
 */
function interceptIncomingDamage(
  s: GameState,
  ctx: EffectContextData,
  target: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  o: {
    art: boolean;
    noReduce?: boolean;
    attacker: PlayerId;
    defer: () => void;
    diceDone: number[];
    replacementDone: string[];
    artOrder?: { raw: number; reduced: number; firstReduction: number };
  },
): boolean {
  // 「ダメージを受ける時」はQ227の確定時に発揮する。被弾後に回すと
  // ダウン処理で付与カードが先に場を離れ、能力の発揮時点も変わってしまう。
  const incomingAbilities: TriggerAbility[] = [];
  const incomingIds: string[] = [];
  for (const uid of target.stack.supports) {
    const id = `incoming:${uid}`;
    if (o.replacementDone.includes(id)) continue;
    const abilities = collectTriggerAbilities(
      s,
      target,
      ["incomingDamage"],
      uid,
    );
    if (abilities.length === 0) continue;
    incomingIds.push(id);
    incomingAbilities.push(...abilities);
  }
  if (incomingAbilities.length > 0) {
    o.defer();
    const pending = pendingIncomingDamage(ctx);
    if (pending) {
      pending.replacementDone = [
        ...new Set([...(pending.replacementDone ?? []), ...incomingIds]),
      ];
      // 自動能力を解決した後、残る任意の防御効果も確認する。
      pending.interruptChecked = false;
    }
    runOps(s, {
      player: target.player,
      rest: [
        { t: "continueTriggerAbilities", abilities: incomingAbilities },
        { t: "resume", inner: ctx },
      ],
      label: "ダメージを受ける時の能力",
    });
    return true;
  }
  const choices = incomingDamageReplacementChoices(s, target, {
    art: o.art,
    noReduce: o.noReduce,
    attacker: o.attacker,
    diceDone: o.diceDone,
    replacementDone: o.replacementDone,
    artOrder: o.artOrder,
  });
  if (choices.length === 0) return false;

  o.defer();
  if (choices.length > 1) {
    pushPrompt(s, {
      type: "damageReplacementChoice",
      player: target.player,
      choices,
      ctx,
    });
  } else {
    offerIncomingDamageReplacement(s, target.player, choices[0], ctx);
  }
  return true;
}

/** 防御による中断を1本の効果列で継続し、複数対象へのダメージを同時に適用する。 */
export function queueSpecialDamage(
  s: GameState,
  ctx: EffectContextData,
  targetStackIds: number[],
  apply: Extract<
    Extract<Prompt, { type: "effectTarget" }>["apply"],
    { t: "special" }
  >,
  amounts?: Record<number, number>,
) {
  const { includeOppCenter, ...damage } = apply;
  const center = includeOppCenter ? s.players[other(ctx.player)].center : null;
  if (center) targetStackIds = [center.id, ...targetStackIds];
  const batch = targetStackIds.length > 1;
  if (batch) ctx.specialDamageBatch = [];
  ctx.rest.unshift(
    ...targetStackIds.map(
      (targetStackId): Op => ({
        ...damage,
        t: "specialToStack",
        targetStackId,
        dmg: amounts?.[targetStackId] ?? damage.dmg,
      }),
    ),
    ...(batch ? [{ t: "finishSpecialDamageBatch" } as const] : []),
  );
}

/** 確定した特殊ダメージのログ・ダウン原因・後続能力を登録する。 */
function recordSpecialDamage(
  s: GameState,
  ctx: EffectContextData,
  entry: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  damage: number,
  noLife?: boolean,
  opponentTargetCount = 1,
) {
  log(
    s,
    ctx.player,
    `${posLabel(entry.pos)}の${topCard(s, entry.stack).name}に特殊ダメージ${damage}`,
    {
      kind: "special",
      sourceStackId: ctx.sourceStackId,
      targetStackId: entry.stack.id,
    },
  );
  ctx.rest.unshift({
    t: "afterSpecialDamage",
    targetStackId: entry.stack.id,
    targetPlayer: entry.player,
    targetPos: entry.pos,
    damage,
    opponentTargetCount,
  });
  deferRuleDown(ctx, {
    player: ctx.player,
    // 待機能力の発生源が既にダウンしていても、ホロメン由来の記録は残す。
    // サポート自身や推しスキルによるダメージはホロメン由来にしない。
    sourceStackId:
      !isSupportAbilitySource(s, ctx) && !ctx.originOshiSkill
        ? ctx.sourceStackId
        : undefined,
    targetStackId: entry.stack.id,
    noLifeTargetStackId: noLife ? entry.stack.id : undefined,
  });
}

/** 対象へ効果を適用する */
export function applyToStack(
  s: GameState,
  ctx: EffectContextData,
  entry: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  apply: Extract<Prompt, { type: "effectTarget" }>["apply"],
) {
  const name = topCard(s, entry.stack).name;
  const targetName = `${posLabel(entry.pos)}の${name}`;
  switch (apply.t) {
    case "special": {
      // Q365: 人数等から決めた基本値へ加算してから0を判定する。
      // 軽減で0になる一撃には、防御の選択機会を残す。
      if (
        apply.dmg <= 0 &&
        calculateSpecialDamage(s, ctx, entry, apply, true) <= 0
      ) {
        log(
          s,
          ctx.player,
          `${ctx.label}: ダメージが0のため効果は発揮されません`,
        );
        break;
      }
      const specialCombat = {
        kind: "special" as const,
        sourceStackId: ctx.sourceStackId,
        targetStackId: entry.stack.id,
      };
      // 不発のログも「特殊ダメージを与えようとした側」の行に出す (アーツと同じ)
      if (isProtectedFrom(s, entry, ctx.player)) {
        log(
          s,
          ctx.player,
          `${targetName}は保護されているためHPが変動しません`,
          {
            ...specialCombat,
            blocked: true,
          },
        );
        break;
      }
      if (isSpecialImmune(s, entry, ctx.player)) {
        log(s, ctx.player, `${targetName}は特殊ダメージを受けません`, {
          ...specialCombat,
          blocked: true,
        });
        break;
      }
      if (entry.player !== ctx.player && isDamageImmune(s, entry)) {
        log(s, ctx.player, `${targetName}は相手からダメージを受けません`, {
          ...specialCombat,
          blocked: true,
        });
        break;
      }
      // 「ダメージを受ける時」の防御能力は特殊ダメージにも発揮する
      // (公式Q158: 「ダメージ」はアーツダメージ・特殊ダメージの両方を指す。
      //  公式Q55 は〈ベスティア・ゼータ〉のギフトを特殊ダメージへ使う前提)。
      // アーツダメージと同じく、確認を挟む間はダメージ適用を保留する。
      if (
        !apply.interruptChecked &&
        !apply.negate &&
        // 1.3.2.2: 選択・適用済みの軽減で0になった事象に追加防御は使えない。
        // 未選択の常時軽減は先に確定せず、置換効果の適用順は残す。
        calculateSpecialDamage(s, ctx, entry, apply, true) >
          (apply.extraReduce ?? 0)
      ) {
        const diceDone = [...(apply.diceReduceDone ?? [])];
        const replacementDone = [...(apply.replacementDone ?? [])];
        // applyToStack から return しても呼び出し元の runOps は残りのopを進めて
        // しまうので、残りごと退避して中断する
        const resumeCtx: EffectContextData = { ...ctx, rest: [] };
        const defer = () => {
          resumeCtx.rest = [
            {
              t: "specialToStack",
              dmg: apply.dmg,
              targetStackId: entry.stack.id,
              noLife: apply.noLife,
              interruptChecked: true,
              extraReduce: apply.extraReduce,
              negate: apply.negate,
              diceReduceDone: diceDone,
              replacementDone,
            },
            ...ctx.rest,
          ];
          ctx.rest.length = 0;
          // 再開先が待機能力・ダメージ処理を引き継ぐ。中断元にも残すと、
          // 防御の入力待ち中にチェックタイミングへ進み、誘発を二重に解決する。
          ctx.pendingTriggers = undefined;
          ctx.pendingRuleCauses = undefined;
          ctx.pendingLifeDamage = undefined;
          ctx.specialDamageBatch = undefined;
        };
        if (
          interceptIncomingDamage(s, resumeCtx, entry, {
            art: false,
            attacker: ctx.player,
            defer,
            diceDone,
            replacementDone,
          })
        )
          return;
      }
      if (apply.negate) {
        log(s, ctx.player, `${targetName}は特殊ダメージを受けません`, {
          ...specialCombat,
          blocked: true,
        });
        break;
      }
      const dmg = calculateSpecialDamage(s, ctx, entry, apply);
      if (ctx.specialDamageBatch) {
        ctx.specialDamageBatch.push({
          targetStackId: entry.stack.id,
          damage: dmg,
          noLife: apply.noLife,
        });
      } else {
        entry.stack.damage += dmg;
        recordSpecialDamage(s, ctx, entry, dmg, apply.noLife);
      }
      break;
    }
    case "heal": {
      const before = entry.stack.damage;
      const healBonus = giftOf(topCard(s, entry.stack)).healBonus;
      let healAmount = apply.value;
      const sourceUid = ctx.sourceSupportUid ?? ctx.sourceCardUid;
      const healKey = `giftHeal:${entry.stack.cards[0]}`;
      if (
        before > 0 &&
        typeof apply.value === "number" &&
        apply.value > 0 &&
        healBonus &&
        sourceUid &&
        cardHasName(s, sourceUid, [healBonus.name]) &&
        (s.usedTriggersThisTurn[healKey] ?? 0) < healBonus.timesPerTurn
      ) {
        healAmount = apply.value + healBonus.value;
        s.usedTriggersThisTurn[healKey] =
          (s.usedTriggersThisTurn[healKey] ?? 0) + 1;
      }
      entry.stack.damage =
        healAmount === "all" ? 0 : Math.max(0, entry.stack.damage - healAmount);
      const healed = before - entry.stack.damage;
      ctx.healed = (ctx.healed ?? 0) + healed;
      // HPが減っていないホロメンも選べる (公式QA Q60・Q67)。その場合は
      // 「回復した扱いにはならない」ので、0回復と書かずに理由を示す。
      log(
        s,
        entry.player,
        healed > 0
          ? `${targetName}のHPを${healed}回復`
          : `${targetName}はHPが減っていないため回復しませんでした`,
      );
      if (healed > 0)
        ctx.rest.unshift({
          t: "runTriggerAbilities",
          player: entry.player,
          abilities: collectTriggerAbilities(s, entry, ["healed"]),
          // 回復を含む元の能力を解決してからチェックタイミングでプレイする。
          defer: true,
        });
      break;
    }
    case "turnArtPlus":
      s.turnModifiers.push({
        stackId: entry.stack.id,
        artPlus: apply.value,
        expiresTurn: apply.expiresTurn,
        nextOpponentTurn: apply.nextOpponentTurn,
      });
      ctx.boundStackId = entry.stack.id;
      log(
        s,
        entry.player,
        `${apply.nextOpponentTurn || (apply.expiresTurn && apply.expiresTurn > s.turn) ? "次の相手のターン終了時まで" : "このターンの間"}、${targetName}のアーツ+${apply.value}`,
      );
      break;
    case "toDeckBottom": {
      const ownerP = s.players[entry.player];
      // 付属エールの退場時アーカイブは11.4.1のルール処理。能力によるアーカイブではない。
      const yellAbilities =
        entry.stack.yells.length > 0
          ? collectYellArchivedTriggerAbilities(s, entry.player)
          : [];
      removeStack(s, ownerP, entry.pos);
      // ステージを離れる場合、移動するのは一番上のカードだけ。下のホロメンと付属カードはアーカイブ (4.4.7)
      ownerP.deck.push(entry.stack.cards[0]);
      ownerP.archive.push(
        ...entry.stack.cards.slice(1),
        ...entry.stack.yells,
        ...entry.stack.supports,
      );
      if (entry.stack.yells.length > 0)
        s.stageYellArchivedThisTurn[entry.player] = true;
      s.turnModifiers = s.turnModifiers.filter(
        (m) => m.stackId !== entry.stack.id,
      );
      s.stageToDeckThisTurn[entry.player] = true;
      log(s, entry.player, `${targetName}をデッキの下に戻しました`);
      // 同じ移動で待機した「エールがアーカイブ」「デッキに戻った」能力をまとめる
      const returnedAbilities = collectReturnedToDeckAbilities(
        s,
        entry.player,
        entry.stack,
      );
      const abilities = [...yellAbilities, ...returnedAbilities];
      if (abilities.length > 0)
        ctx.rest.unshift({
          t: "runTriggerAbilities",
          player: entry.player,
          abilities,
          label: "ステージを離れた時の能力",
          defer: true,
        });
      break;
    }
    case "turnCostMod":
      s.turnModifiers.push({
        stackId: entry.stack.id,
        artPlus: 0,
        artCostless: apply.artCostless,
        artColorCostless: apply.artColorCostless,
        artsFree: apply.artsFree,
        batonDelta: apply.batonDelta,
        expiresTurn: apply.expiresTurn,
        nextOpponentTurn: apply.nextOpponentTurn,
      });
      log(
        s,
        entry.player,
        `${targetName}のコストを修正しました` +
          (apply.artCostless ? ` (アーツ無色-${apply.artCostless})` : "") +
          (apply.artColorCostless
            ? ` (アーツ${apply.artColorCostless.color}-${apply.artColorCostless.n})`
            : "") +
          (apply.artsFree ? " (アーツはエールを必要とせずに使える)" : "") +
          (apply.batonDelta
            ? ` (バトンタッチ${apply.batonDelta > 0 ? "+" : ""}${apply.batonDelta})`
            : ""),
      );
      break;
    case "changeArtTarget": {
      const restriction = opponentArtTargetError(s, ctx.player, entry.pos);
      if (restriction) throw new Error(restriction);
      const pending = ctx.rest.find(
        (candidate): candidate is Extract<Op, { t: "artDamage" }> =>
          candidate.t === "artDamage",
      );
      if (!pending) {
        log(s, ctx.player, `${ctx.label}: 変更するアーツ対象がありません`);
        break;
      }
      pending.targetStackId = entry.stack.id;
      ctx.artTargetStackId = entry.stack.id;
      ctx.artPrimaryTargetStackId = entry.stack.id;
      log(s, ctx.player, `アーツの対象を${targetName}に変更しました`);
      break;
    }
    case "setHp": {
      if (isProtectedFrom(s, entry, ctx.player)) {
        log(
          s,
          entry.player,
          `${targetName}は保護されているためHPが変動しません`,
        );
        break;
      }
      const max = effectiveMaxHp(s, entry.stack);
      entry.stack.damage = Math.max(0, max - apply.value);
      log(s, entry.player, `${targetName}の残りHPを${apply.value}にしました`);
      deferRuleDown(ctx, {
        player: ctx.player,
        sourceStackId: ctx.sourceStackId,
        targetStackId: entry.stack.id,
      });
      break;
    }
    case "bind":
      ctx.boundStackId = entry.stack.id;
      (ctx.boundStackIds ??= []).push(entry.stack.id);
      log(s, ctx.player, `${name}(${posLabel(entry.pos)})を選びました`);
      break;
    case "turnAllColors":
      s.turnModifiers.push({
        stackId: entry.stack.id,
        artPlus: 0,
        allColors: true,
      });
      log(
        s,
        entry.player,
        `このターンの間、${targetName}はすべての色を持つホロメンとして扱われます`,
      );
      break;
    case "devolve": {
      const ownerP = s.players[entry.player];
      const top = topCard(s, entry.stack);
      const debutIndex = entry.stack.cards
        .map((uid) => {
          const card = cardOf(s, uid);
          return card.cardType === "holomen" && card.bloomLevel === "Debut";
        })
        .lastIndexOf(true);
      // 一番上がすでにDebut、または重なりにDebutがなければ何もしない (5.15.2-5.15.3)
      if (top.bloomLevel === "Debut" || debutIndex < 0) {
        log(s, entry.player, `${targetName}はDebutホロメンに戻せません`);
        break;
      }
      const debut = entry.stack.cards[debutIndex];
      const toHand = [
        ...entry.stack.cards.filter((_, i) => i !== debutIndex),
        ...entry.stack.supports,
      ];
      entry.stack.cards = [debut];
      entry.stack.supports = [];
      entry.stack.damage = 0;
      ownerP.hand.push(...toHand);
      log(
        s,
        entry.player,
        `${targetName}をDebutホロメンに戻しました (${cardOf(s, debut).name}とエールを残し、${toHand.length}枚を手札へ)`,
      );
      break;
    }
    case "turnNoSwitch":
      s.turnModifiers.push({
        stackId: entry.stack.id,
        artPlus: 0,
        noSwitch: true,
        expiresTurn: apply.expiresTurn,
        nextOpponentTurn: apply.nextOpponentTurn,
      });
      log(
        s,
        entry.player,
        `次の相手のターンの間、${targetName}はバトンタッチ・移動・交代できません`,
      );
      break;
    case "swapCenter": {
      const p = s.players[entry.player];
      if (typeof entry.pos === "string" || !p.center) break;
      if (hasNoSwitch(s, p.center) || hasNoSwitch(s, entry.stack)) {
        log(s, entry.player, "効果により交代できません");
        break;
      }
      const backSt = p.back[entry.pos.back];
      p.back[entry.pos.back] = p.center;
      p.center = backSt;
      // 「バックポジションに移動したホロメン」を後続効果が参照できるよう束縛
      ctx.boundStackId = p.back[entry.pos.back].id;
      log(s, entry.player, `センターホロメンと${targetName}を交代しました`);
      break;
    }
    case "swapCollab": {
      const p = s.players[entry.player];
      if (typeof entry.pos === "string" || !p.collab) break;
      if (hasNoSwitch(s, p.collab) || hasNoSwitch(s, entry.stack)) {
        log(s, entry.player, "効果により交代できません");
        break;
      }
      const backSt = p.back[entry.pos.back];
      p.back[entry.pos.back] = p.collab;
      p.collab = backSt;
      log(s, entry.player, `コラボホロメンと${targetName}を交代しました`);
      ctx.rest.unshift({
        t: "emitTriggers",
        stackId: backSt.id,
        events: ["collabMoved"],
      });
      break;
    }
    case "moveToCollab": {
      const p = s.players[entry.player];
      if (typeof entry.pos === "string" || p.collab) break;
      if (hasNoSwitch(s, entry.stack)) {
        log(s, entry.player, "効果により移動できません");
        break;
      }
      const st = p.back.splice(entry.pos.back, 1)[0];
      p.collab = st;
      log(
        s,
        entry.player,
        `${targetName}をコラボポジションに移動しました (コラボとしては扱わない)`,
      );
      ctx.rest.unshift({
        t: "emitTriggers",
        stackId: st.id,
        events: ["collabMoved"],
      });
      break;
    }
    case "activate": {
      if (entry.stack.resting) {
        entry.stack.resting = false;
        if (ctx.originOshiSkill && entry.player === ctx.player) {
          entry.stack.activatedByOshiSkills = [
            ...(entry.stack.activatedByOshiSkills ?? []).filter(
              (activation) => activation.turn === s.turn,
            ),
            {
              turn: s.turn,
              name: ctx.originOshiSkill.name,
              sp: ctx.originOshiSkill.sp,
            },
          ];
        }
        log(s, entry.player, `${targetName}をアクティブにしました`);
      }
      break;
    }
    case "rest": {
      if (!entry.stack.resting) {
        entry.stack.resting = true;
        log(s, entry.player, `${targetName}をお休みにしました`);
      }
      break;
    }
    case "down": {
      log(s, entry.player, `${targetName}は効果によりダウンしました`);
      entry.stack.damage = Math.max(
        entry.stack.damage,
        effectiveMaxHp(s, entry.stack),
      );
      deferRuleDown(ctx, {
        player: ctx.player,
        sourceStackId: ctx.sourceStackId,
        targetStackId: entry.stack.id,
        noLifeTargetStackId: apply.noLife ? entry.stack.id : undefined,
      });
      break;
    }
  }
}

/** 相手のメインステップ中、相手の能力でHPが変動しない保護があるか */
/**
 * 「このターンに自分のデッキからアーカイブしたカード」の枚数を数える。
 * hBP08-020〈響咲リオナ〉のアーツが参照する (`milledFromDeckThisTurnAtLeast`)。
 *
 * **デッキ→アーカイブの経路は3つある** ので、必ずここを通す。
 * `millDeck` (上からX枚アーカイブ) / `revealedTo dest:"archive"` (公開したカードを
 * アーカイブ) / `resolveEffectPickCard` (`from:"deck"` の選択結果と残りのアーカイブ)。
 * デッキ→手札→アーカイブ (`drawThenArchive` 等) は手札からのアーカイブなので数えない。
 */
export function countDeckArchived(
  s: GameState,
  pid: PlayerId,
  n: number,
): void {
  if (n > 0) s.deckArchivedThisTurn[pid] += n;
}

function isProtectedFrom(
  s: GameState,
  entry: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  effectController: PlayerId,
): boolean {
  if (effectController === entry.player) return false;
  if (s.turnPlayer !== effectController || s.step !== "main") return false;
  // 付与サポートの保護
  for (const uid of entry.stack.supports) {
    const c = cardOf(s, uid);
    if (c.cardType !== "support") continue;
    const b = passiveOf(c);
    if (!b.protection) continue;
    if (
      b.protection.requiresCond &&
      !passiveCondMatches(s, entry.stack, b.cond)
    )
      continue;
    return true;
  }
  // ギフトの保護
  const g = giftOf(topCard(s, entry.stack));
  if (g.protection && giftPositionOk(entry.pos, g.protection.positions))
    return true;
  // 味方のギフトによるHP保護オーラ (「自分の(F)のHPは相手の能力で減らず、変動しない」)
  const entryPosName: "center" | "collab" | "back" =
    entry.pos === "center"
      ? "center"
      : entry.pos === "collab"
        ? "collab"
        : "back";
  for (const e of allStacks(s.players[entry.player])) {
    const auras = giftOf(topCard(s, e.stack)).protectionAuras;
    if (!auras) continue;
    for (const aura of auras) {
      if (!giftPositionOk(e.pos, aura.positions)) continue;
      if (aura.targetPos && aura.targetPos !== entryPosName) continue;
      if (aura.filter && !stackMatchesFilter(s, entry.stack, aura.filter))
        continue;
      return true;
    }
  }
  return false;
}

/** 誘発後に他の能力で変わり得るコスト・使用回数は、プレイする時点で確認する。 */
function reactiveSkillPlayableCost(
  s: GameState,
  pid: PlayerId,
  ability: { sp: boolean; skillName: string; cost: number },
): number | null {
  const p = s.players[pid];
  const adj = oshiSkillAdjustments(s, pid, ability.skillName);
  const oshi = cardOf(s, p.oshiUid) as OshiCard;
  const skill = ability.sp ? oshi.spOshiSkill : oshi.oshiSkill;
  const cost =
    skill?.name === ability.skillName && typeof skill.cost === "number"
      ? Math.max(0, skill.cost + adj.costDelta)
      : ability.cost;
  if (
    (ability.sp
      ? p.usedSpOshiSkill
      : oshiSkillUseCount(s, pid) >= 1 + adj.usesBonus) ||
    p.holoPower.length < cost
  )
    return null;
  return cost;
}

/** ダメージ後の推しスキルも、他の自動能力と同じチェックタイミングで解決する。 */
function deferDamageReactive(
  ctx: EffectContextData,
  ur: UsableOshiReactive,
  ops: Op[],
  event?: { boundStackId?: number; damage: number },
): void {
  (ctx.pendingTriggers ??= []).push({
    player: ctx.player,
    abilities: captureTriggerContexts(
      {
        // 推しスキルが参照するのは、この誘発を起こしたダメージと対象だけ。
        // 元のアーツ等が選んだ味方・複数対象の束縛を持ち越さない。
        player: ctx.player,
        rest: [],
        label: ur.skill.name,
        boundStackId: event?.boundStackId,
        boundStackIds:
          event?.boundStackId !== undefined ? [event.boundStackId] : undefined,
        triggerDamage: event?.damage,
      },
      [
        {
          id: `damageReactive:${ur.skill.name}:${event?.boundStackId ?? "front"}:${ctx.pendingTriggers?.length ?? 0}`,
          label: `${ur.sp ? "SP" : ""}推しスキル「${ur.skill.name}」${ur.reactive.when === "dealtDamageToOppFront" && event ? `（${event.damage}ダメージ）` : ""}`,
          ops: [
            {
              t: "offerReactiveSkill",
              sp: ur.sp,
              skillName: ur.skill.name,
              description: ur.skill.description,
              cost: ur.cost,
              ops,
            },
          ],
        },
      ],
    ),
  });
}

/** リアクティブ推しスキルの使用確認プロンプトの解決 */
export function resolveReactiveSkill(
  s: GameState,
  pid: PlayerId,
  use: boolean,
): void {
  const prompt = s.prompts[0];
  if (!prompt || prompt.type !== "reactiveSkill" || prompt.player !== pid)
    throw new Error("現在この操作はできません");
  s.prompts.shift();
  finishIncomingDamageReplacement(prompt.ctx, prompt.damageReplacementId);
  if (use) {
    const p = s.players[pid];
    p.archive.push(...p.holoPower.splice(0, prompt.cost));
    if (prompt.sp) {
      p.usedSpOshiSkill = true;
      p.usedSpOshiSkillThisTurn = true;
      p.usedSpOshiSkillInfo = {
        name: prompt.skillName,
        oshiName: cardOf(s, p.oshiUid).name,
        turn: s.turn,
        ownMainStep: s.turnPlayer === pid && s.step === "main",
      };
    } else {
      p.usedOshiSkillThisTurn = true;
      (p.usedOshiSkillNamesThisTurn ??= []).push(prompt.skillName);
      const key = `oshiSkillUse:${pid}`;
      s.usedTriggersThisTurn[key] = (s.usedTriggersThisTurn[key] ?? 0) + 1;
    }
    log(
      s,
      pid,
      `${prompt.sp ? "SP推しスキル" : "推しスキル"}「${prompt.skillName}」を使用しました (ホロパワー-${prompt.cost})`,
    );
    queueFxWaitMarker(s, prompt.sp ? "spOshiSkill" : "oshiSkill");
    if (prompt.kind === "reduce") {
      // 保留中のアーツダメージ / 特殊ダメージのどちらも軽減できる (公式Q158)
      reduceIncomingDamage(
        s,
        prompt.ctx,
        pid,
        prompt.reduce ?? 0,
        prompt.reduceAll,
      );
    }
    // 位置条件を使用宣言時に固定せず、本文を解決した盤面で誘発させる。
    prompt.ctx.rest.unshift(
      ...(prompt.kind !== "reduce" && prompt.ops
        ? (structuredClone(prompt.ops) as Op[])
        : []),
      {
        t: "emitOshiSkillUsed",
        player: pid,
        sp: !!prompt.sp,
        name: prompt.skillName,
      },
    );
  } else {
    log(s, pid, `「${prompt.skillName}」の使用を見送りました`);
  }
  runOps(s, prompt.ctx);
  advance(s);
}

/** 送付先が一意に決まる場合はエールを直接付ける。付けたら true */
function attachCheerDirect(
  s: GameState,
  ctx: EffectContextData,
  yellUid: string,
  target: StackTarget,
  filter?: TargetFilter,
): boolean {
  // 対象が一意に決まる場合のみ直接送付する
  const singleTargets: StackTarget[] = ["self", "bound", "ownCenter"];
  const isChoice = target === "chooseOwnFront";
  if (!singleTargets.includes(target) && !isChoice) return false;
  const candidates = targetCandidates(s, ctx, target, filter);
  if (candidates.length === 0) return false;
  if (isChoice && candidates.length > 1) return false; // 複数候補は選択させる
  const { pos, stack: st } = candidates[0];
  st.yells.push(yellUid);
  const yell = cardOf(s, yellUid) as YellCard;
  log(
    s,
    ctx.player,
    `${yell.name}を${posLabel(pos)}の${topCard(s, st).name}に送りました`,
  );
  // 「このホロメンにエールが付いた時」付与トリガー
  ctx.rest.unshift({
    t: "runTriggerAbilities",
    player: ctx.player,
    abilities: collectTriggerAbilities(
      s,
      { player: ctx.player, pos, stack: st },
      ["yellAttached"],
    ),
    defer: true,
  });
  return true;
}

function cheerAssignTargetFilter(
  target: StackTarget,
  filter: TargetFilter | undefined,
): TargetFilter | undefined {
  if (target === "bound") return { ...(filter ?? {}), boundOnly: true };
  if (target === "self") return { ...(filter ?? {}), sourceOnly: true };
  if (target === "ownCenter") return { ...(filter ?? {}), position: "center" };
  if (target === "ownCollab") return { ...(filter ?? {}), position: "collab" };
  if (target === "chooseOwnBack")
    return { ...(filter ?? {}), position: "back" };
  if (target === "chooseOwnFront")
    return { ...(filter ?? {}), position: "front" };
  return filter;
}

/** 特殊ダメージの倍率に使う盤面/履歴上の枚数・人数を返す。 */
function specialScaleCount(
  s: GameState,
  ctx: EffectContextData,
  scale: NonNullable<Extract<Op, { t: "special" }>["scaleBy"]>,
): number {
  const p = s.players[ctx.player];
  switch (scale.kind) {
    case "stageYell":
      return stageYellCount(s, ctx.player);
    case "stageTagDistinct":
      return distinctHolomenNameCount(
        s,
        allStacks(p)
          .filter(({ stack }) => topCard(s, stack).tags.includes(scale.tag))
          .map(({ stack }) => stack),
      );
    case "stageTag":
      return allStacks(p).filter(({ stack }) => {
        const c = topCard(s, stack);
        return (
          c.tags.includes(scale.tag) &&
          (!scale.bloomLevel ||
            stackBloomLevels(s, stack).includes(scale.bloomLevel))
        );
      }).length;
    case "backTag":
      return p.back.filter((stack) =>
        topCard(s, stack).tags.includes(scale.tag),
      ).length;
    case "backTagDistinct":
      return distinctHolomenNameCount(
        s,
        p.back.filter((stack) => topCard(s, stack).tags.includes(scale.tag)),
      );
    case "milled":
      return (ctx.milled ?? []).length;
    case "diceRolls":
      return Object.values(s.diceRollsThisTurn[ctx.player]).reduce(
        (a, b) => a + b,
        0,
      );
    case "archiveFilter":
      return p.archive.filter((uid) =>
        scale.filters.some((filter) =>
          cardMatchesFilter(s, ctx.player, uid, filter),
        ),
      ).length;
    case "centerNameStacked":
      return p.center && scale.names.includes(topCard(s, p.center).name)
        ? p.center.cards.length - 1
        : 0;
  }
}

/** 比例回復も、対象を選ぶ前に総回復量を確定し、1回の回復として扱う。 */
function scaledHealValue(
  s: GameState,
  ctx: EffectContextData,
  op: Extract<Op, { t: "heal" }>,
): number | "all" {
  if (op.value !== "all" && op.perArchiveNames)
    return (
      op.value *
      s.players[ctx.player].archive.filter((u) =>
        cardHasName(s, u, op.perArchiveNames!),
      ).length
    );
  if (op.value === "all" || !op.scaleBy) return op.value;
  let count: number;
  switch (op.scaleBy) {
    case "stageYellColors": {
      const colors = new Set<string>();
      for (const { stack } of allStacks(s.players[ctx.player]))
        for (const uid of stack.yells)
          for (const color of yellColorsOn(s, stack, uid)) colors.add(color);
      count = colors.size;
      break;
    }
    case "oppOshiDiffColor":
      count = allStacks(s.players[other(ctx.player)]).filter(({ stack }) =>
        hasDiffColorFromOwnerOshi(s, stack),
      ).length;
      break;
    case "stageNamedCards":
      count = stageNamedCardCount(s, ctx.player, op.scaleNames ?? []);
      break;
    case "revealedHolomen":
      count = (ctx.revealed ?? []).filter(
        (uid) => cardOf(s, uid).cardType === "holomen",
      ).length;
      break;
  }
  return op.value * count;
}

/** 振る側・回数・能力の発生源に適用できる出目修正を選ぶ。 */
function diceModifiersFor(
  s: GameState,
  player: PlayerId,
  rolls: number,
  rollerName: string,
  fromOshi: boolean,
) {
  const oshiName = cardOf(s, s.players[player].oshiUid).name;
  return s.diceMods.filter(
    (dm) =>
      dm.player === player &&
      dm.expiresTurn >= s.turn &&
      (!dm.rollsAtLeast || rolls >= dm.rollsAtLeast) &&
      (!dm.rollsExactly || rolls === dm.rollsExactly) &&
      (!dm.names ||
        dm.names.includes(rollerName) ||
        (fromOshi && dm.names.includes(oshiName))),
  );
}

/** 出目の合計と条件に合う回数を混同しないよう、能力が参照する集計を記録する。 */
function diceResultSummaries(
  op: DiceOp,
  results: number[],
  life: number,
): DiceResultSummary[] {
  const summaries = new Map<string, DiceResultSummary>();
  const count = (label: string, matches: (result: number) => boolean) =>
    summaries.set(label, {
      label,
      value: results.filter(matches).length,
      unit: "回",
    });
  if (
    op.sumArtPlus ||
    op.branches.some((branch) => branch.cond === "eqBothLife")
  )
    summaries.set("合計", {
      label: "合計",
      value: results.reduce((sum, result) => sum + result, 0),
    });
  if (op.aggOdd) count("奇数", (result) => result % 2 === 1);
  const countsOdd =
    !!op.aggOdd || op.branches.some(({ cond }) => cond === "odd");
  for (const { cond } of op.branches) {
    if (cond === "eqBothLife") continue;
    if (cond === "odd") count("奇数", (result) => result % 2 === 1);
    else if (cond === "even") {
      // 奇偶の両方で分岐する効果では、奇数0回／1回などの集計にまとめる。
      if (!countsOdd) count("偶数", (result) => result % 2 === 0);
    } else if (cond === "geLife")
      count(`自分のライフ（${life}）以上の出目`, (result) => result >= life);
    else if (cond === "leLife")
      count(`自分のライフ（${life}）以下の出目`, (result) => result <= life);
    else if ("eq" in cond)
      count(`${cond.eq.join("・")}が出た回数`, (result) =>
        cond.eq.includes(result),
      );
    else if ("ne" in cond)
      count(
        `${cond.ne.join("・")}以外が出た回数`,
        (result) => !cond.ne.includes(result),
      );
    else if ("ge" in cond)
      count(`${cond.ge}以上が出た回数`, (result) => result >= cond.ge);
    else if ("le" in cond)
      count(`${cond.le}以下が出た回数`, (result) => result <= cond.le);
    else
      summaries.set(`出目${cond.perValue}ごとの効果`, {
        label: `出目${cond.perValue}ごとの効果`,
        value: results.reduce(
          (sum, result) => sum + Math.floor(result / cond.perValue),
          0,
        ),
        unit: "回",
      });
  }
  return [...summaries.values()];
}

function diceModifierLabel(mod: GameState["diceMods"][number]): string {
  const scope = mod.once ? "次の出目1つ" : "出目すべて";
  return `${scope}を${mod.double ? "倍の数" : `【${mod.value}】`}として扱う効果`;
}

/** 同じ置換効果を再適用しないよう、未適用の一覧から取り除く。 */
function applyPendingDiceModifier(
  s: GameState,
  ctx: EffectContextData,
  dice: DiceOp,
  index: number,
): void {
  const mod = dice.pendingDiceMods?.splice(index, 1)[0];
  if (!mod || !dice.pendingRolls) return;
  const before = [...dice.pendingRolls];
  for (let i = 0; i < dice.pendingRolls.length; i++) {
    if (mod.once && i > 0) break;
    dice.pendingRolls[i] = mod.double
      ? dice.pendingRolls[i] * 2
      : (mod.value ?? dice.pendingRolls[i]);
  }
  log(
    s,
    ctx.player,
    `サイコロの目の修正: 【${before.join("、")}】を【${dice.pendingRolls.join("、")}】として扱います`,
  );
}

/**
 * コスト不払い等で「この効果の残り」を打ち切る。
 *
 * アーツの Op 列は「効果 → artDamage → ダメージ後効果」と1本に連なっているため、
 * 単純に ctx.rest を空にするとアーツダメージまで消えてしまう (支払えない任意
 * コストのせいで攻撃自体が不発になる)。artDamage 以降はアーツ本体の処理なので残す。
 * 誘発能力の終了処理・呼び出し元への復帰も、コスト不払いで捨ててはいけない。
 */
function abortEffectRest(ctx: EffectContextData): void {
  const boundary = ctx.rest.findIndex(
    (op) =>
      op.t === "artDamage" ||
      op.t === "checkRuleTiming" ||
      op.t === "resume" ||
      op.t === "finishSupportCard" ||
      op.t === "emitOshiSkillUsed",
  );
  ctx.rest.splice(0, boundary < 0 ? ctx.rest.length : boundary);
}

function captureTriggerContexts(
  ctx: EffectContextData,
  abilities: TriggerAbility[],
): TriggerAbility[] {
  const {
    rest: _rest,
    pendingTriggers: _pending,
    pendingRuleCauses: _causes,
    pendingLifeDamage: _life,
    specialDamageBatch: _batch,
    ...eventContext
  } = ctx;
  const snapshot = structuredClone(eventContext);
  return abilities.map((ability) =>
    ability.eventContext ? ability : { ...ability, eventContext: snapshot },
  );
}

/**
 * 中断した解決列で待機している能力も、次のチェックタイミングの選択肢に含める。
 * 実際の効果Opに達したら止め、その効果が終わる前に後続の能力を取り出さない。
 */
function takeScheduledTriggerGroups(
  ctx: EffectContextData,
): NonNullable<EffectContextData["pendingTriggers"]> {
  const groups: NonNullable<EffectContextData["pendingTriggers"]> = [];
  while (ctx.rest.length) {
    const op = ctx.rest[0];
    if (op.t === "continueTriggerAbilities" || op.t === "runTriggerAbilities") {
      ctx.rest.shift();
      groups.push({
        player: op.t === "runTriggerAbilities" ? op.player : ctx.player,
        abilities: captureTriggerContexts(ctx, op.abilities),
      });
    } else if (op.t === "resume") {
      groups.push(...takeScheduledTriggerGroups(op.inner));
      break;
    } else break;
  }
  return groups;
}

/** 能力ごとに発生源と一時データを分離し、完了後に元の効果を再開する。 */
export function runTriggerAbility(
  s: GameState,
  ctx: EffectContextData,
  ability: TriggerAbility,
): void {
  // アーツの公開結果・Bloom前のレベル等は誘発条件の参照に必要。
  // 独立したコピーにし、選択結果や発生源の変更を呼び出し元へ持ち越さない。
  const eventContext = {
    ...(ability.eventContext ?? ctx),
    rest: [],
    pendingTriggers: undefined,
  };
  runOps(s, {
    ...structuredClone(eventContext),
    player: ctx.player,
    sourceStackId: ability.sourceStackId,
    sourceSupportUid: ability.sourceSupportUid,
    grantedSupportAbility: undefined,
    sourceCardUid: undefined,
    originOshiSkill: undefined,
    rest: [
      ...(structuredClone(ability.ops) as Op[]),
      { t: "checkRuleTiming" },
      { t: "resume", inner: ctx },
    ],
    label: ability.label,
  });
}

/** 選択条件の判定に非公開のカード情報が必要か（総合ルール10.7.2.3.5）。 */
function hiddenPickNeedsCardInfo(
  filter: CardFilter,
  source: "deck" | "cheer" | "holo",
): boolean {
  if (filter.alt)
    return filter.alt.every((f) => hiddenPickNeedsCardInfo(f, source));
  return Object.entries(filter).some(([key, value]) => {
    if (value === undefined || value === false || key === "any") return false;
    // エールデッキのカードがエールであることは、内容を見なくても分かる。
    return !(source === "cheer" && key === "kind" && value === "yell");
  });
}

function millCountChoice(
  op: Extract<Op, { t: "millDeck" | "millCheer" }>,
  count: number,
): Op {
  const fixed = { ...op, n: count, max: undefined };
  if (count <= op.n) return fixed;
  const zone = op.t === "millDeck" ? "デッキ" : "エールデッキ";
  return {
    t: "chooseOps",
    label: `${zone}の上からアーカイブする枚数を${count}枚にしますか？`,
    thenOps: [fixed],
    elseOps: [millCountChoice(op, count - 1)],
  };
}

/** 枚数指定と全手札のアーカイブで、同じ肩代わりの選択を提示する。 */
function offerHandArchiveReplacement(
  s: GameState,
  ctx: EffectContextData,
  op: Extract<Op, { t: "archiveHand" }>,
  declined: Op = { ...op, replacementChecked: true },
): boolean {
  if (op.replacementChecked || op.n === 0) return false;
  const replacement = archiveHandHoloReplacement(s, ctx, op);
  if (!replacement) return false;
  const minHolo = archiveHandMinHoloForReplacement(
    s,
    ctx,
    op,
    archiveHandEligible(s, ctx.player, op),
    replacement.maxHolo,
  );
  if (minHolo === null) return false;
  pushPrompt(s, {
    type: "effectConfirm",
    player: ctx.player,
    label: `推しスキル「${replacement.skillName}」で手札のかわりにホロパワーをアーカイブしますか？`,
    thenOps: [
      { t: "markOshiSkillUsed", name: replacement.skillName },
      {
        t: "archiveHoloPowerAny",
        min: minHolo,
        max: replacement.maxHolo,
        forHandReplacement: true,
      },
      {
        t: "archiveRemainingHand",
        total: op.n,
        original: { ...op, replacementChecked: true },
      },
      {
        t: "emitOshiSkillUsed",
        player: ctx.player,
        sp: false,
        name: replacement.skillName,
      },
    ],
    elseOps: [declined],
    ctx,
  });
  return true;
}

export function runOps(s: GameState, ctx: EffectContextData): void {
  while (
    ctx.rest.length > 0 ||
    (ctx.pendingTriggers?.length ?? 0) > 0 ||
    ctx.pendingRuleCauses !== undefined ||
    ctx.pendingLifeDamage !== undefined
  ) {
    if (s.phase !== "playing") return;
    // 入力待ちや部分処理の途中では解決せず、能力の終わりで待機能力を処理する。
    // resume先へ戻る前と、次のアーツを再使用する前にもチェックが必要。
    if (
      (ctx.pendingTriggers?.length ||
        ctx.pendingRuleCauses ||
        ctx.pendingLifeDamage) &&
      (!ctx.rest.length ||
        ctx.rest[0].t === "resume" ||
        ctx.rest[0].t === "repeatArtCheck")
    )
      ctx.rest.unshift({ t: "checkRuleTiming" });
    // 発動演出 (バナー・推しスキル) の待機予約があれば、次のopの前に一時停止する
    if (consumeFxWait(s, ctx)) return;
    const op = ctx.rest.shift()!;
    const p = s.players[ctx.player];
    engineObserver?.op?.(op.t);
    switch (op.t) {
      case "turnBloomLevel": {
        if (ctx.boundStackId && findStackById(s, ctx.boundStackId))
          s.turnModifiers.push({
            stackId: ctx.boundStackId,
            artPlus: 0,
            additionalBloomLevel: op.level,
            expiresTurn: s.turn,
          });
        break;
      }
      case "turnArtReduceFrom": {
        for (const { stack } of allStacks(p))
          if (op.names.some((n) => stackNames(s, stack).includes(n)))
            s.turnModifiers.push({
              stackId: stack.id,
              artPlus: 0,
              artReduceFrom: { level: op.level, value: op.value },
              ...turnEffectDuration(s, ctx.player, true, true),
            });
        break;
      }
      case "swapOppCollabWithBound": {
        const opponent = s.players[other(ctx.player)];
        const index = opponent.back.findIndex((x) => x.id === ctx.boundStackId);
        if (index < 0) break;
        const incoming = opponent.back[index],
          outgoing = opponent.collab;
        opponent.collab = incoming;
        if (outgoing) opponent.back[index] = outgoing;
        else opponent.back.splice(index, 1);
        const abilities = collectTriggerAbilities(
          s,
          { player: other(ctx.player), pos: "collab", stack: incoming },
          ["collabMoved"],
        );
        if (abilities.length)
          ctx.rest.unshift({
            t: "runTriggerAbilities",
            player: other(ctx.player),
            abilities,
            defer: true,
          });
        break;
      }
      case "boundStackToHand": {
        const e = ctx.boundStackId ? findStackById(s, ctx.boundStackId) : null;
        if (!e) break;
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: "選んだホロメンと重なりをすべて手札に戻しますか？",
            thenOps: [{ ...op, optional: false }],
            ctx,
          });
          return;
        }
        const owner = s.players[e.player];
        owner.hand.push(...e.stack.cards);
        // 付属エールの退場時アーカイブは11.4.1のルール処理。能力によるアーカイブではない。
        const abilities = e.stack.yells.length
          ? collectYellArchivedTriggerAbilities(s, e.player)
          : [];
        removeStack(s, owner, e.pos);
        owner.archive.push(...e.stack.yells, ...e.stack.supports);
        if (e.stack.yells.length) s.stageYellArchivedThisTurn[e.player] = true;
        s.turnModifiers = s.turnModifiers.filter(
          (m) => m.stackId !== e.stack.id,
        );
        if (abilities.length)
          ctx.rest.unshift({
            t: "runTriggerAbilities",
            player: e.player,
            abilities,
            defer: true,
          });
        ctx.pickedCards = [...e.stack.cards];
        ctx.pickedCardsOwnerOnly = false;
        ctx.pickedCardsOwner = ctx.player;
        break;
      }
      case "bothRefreshArchive": {
        for (const pid of [0, 1] as PlayerId[]) {
          const owner = s.players[pid];
          const moved = owner.archive.filter(
            (u) => cardOf(s, u).cardType !== "yell",
          );
          owner.archive = owner.archive.filter((u) => !moved.includes(u));
          owner.deck = shuffle([...owner.deck, ...owner.hand, ...moved]);
          owner.hand = [];
        }
        ctx.rest.unshift(
          { t: "draw", n: op.draw },
          { t: "oppDraw", n: op.draw },
        );
        break;
      }
      case "highestHpArtPlus": {
        const stacks = allStacks(p).map((x) => x.stack),
          highest = Math.max(
            ...stacks.map((st) => effectiveMaxHp(s, st) - st.damage),
          );
        for (const st of stacks)
          if (effectiveMaxHp(s, st) - st.damage === highest)
            s.turnModifiers.push({
              stackId: st.id,
              artPlus: op.value,
              expiresTurn: s.turn,
            });
        break;
      }
      case "oppCenterAllYellReturn": {
        const pid = other(ctx.player),
          center = s.players[pid].center;
        if (!center?.yells.length) break;
        pushPrompt(s, {
          type: "effectPickCard",
          player: pid,
          uids: [...center.yells],
          pickMin: center.yells.length,
          pickMax: center.yells.length,
          dest: "cheerDeck",
          restTo: "none",
          from: "stageYells",
          ctx,
          yellOwner: pid,
          orderLabel: "エールデッキの下に戻す順に選んでください",
        });
        return;
      }
      case "drawPerArtTag": {
        ctx.rest.unshift({
          t: "draw",
          n: s.artUsesThisTurn[ctx.player].filter((x) =>
            x.tags?.includes(op.tag),
          ).length,
        });
        break;
      }
      case "turnThirdArtBackTarget": {
        for (const { stack } of allStacks(p))
          if (op.names.some((n) => stackNames(s, stack).includes(n)))
            s.turnModifiers.push({
              stackId: stack.id,
              artPlus: 0,
              thirdArtBackTarget: true,
              expiresTurn: s.turn,
            });
        break;
      }
      case "draw": {
        if (op.optional) {
          if (p.deck.length === 0) {
            log(
              s,
              ctx.player,
              `${ctx.label}: デッキにカードがないため引けません`,
            );
            break;
          }
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: `${ctx.label}: デッキを${op.n}枚引きますか？`,
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        let n = 0;
        for (let i = 0; i < op.n && p.deck.length > 0; i++) {
          p.hand.push(op.fromBottom ? p.deck.pop()! : p.deck.shift()!);
          n++;
        }
        if (
          n > 0 &&
          ctx.sourceCardUid &&
          cardOf(s, ctx.sourceCardUid).cardType === "support"
        )
          ctx.supportChangedState = true;
        logDraw(s, ctx.player, `${ctx.label}: ${n}枚ドローしました`, n);
        break;
      }
      case "oppDraw": {
        const oppP = s.players[other(ctx.player)];
        if (op.optional) {
          if (oppP.deck.length === 0) {
            log(
              s,
              other(ctx.player),
              `${ctx.label}: デッキにカードがないため引けません`,
            );
            break;
          }
          // 「引ける」: 相手が引くかどうかを選ぶ
          pushPrompt(s, {
            type: "effectConfirm",
            player: other(ctx.player),
            label: `${ctx.label}: デッキを${op.n}枚引きますか？`,
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        let n = 0;
        for (let i = 0; i < op.n && oppP.deck.length > 0; i++) {
          oppP.hand.push(oppP.deck.shift()!);
          n++;
        }
        if (
          n > 0 &&
          ctx.sourceCardUid &&
          cardOf(s, ctx.sourceCardUid).cardType === "support"
        )
          ctx.supportChangedState = true;
        logDraw(
          s,
          other(ctx.player),
          `${ctx.label}: 相手は${n}枚ドローしました`,
          n,
        );
        break;
      }
      case "oppArchiveHand": {
        const oppId = other(ctx.player);
        const oppP = s.players[oppId];
        if (oppP.hand.length === 0) {
          log(s, ctx.player, `${ctx.label}: 相手の手札がないため効果なし`);
          break;
        }
        pushPrompt(s, {
          type: "effectArchiveHand",
          player: oppId,
          count: Math.min(op.n, oppP.hand.length),
          ctx,
        });
        return;
      }
      case "scheduleEndArchiveStageYell":
        s.turnModifiers.push({
          stackId: -1 - ctx.player,
          artPlus: 0,
          archiveStageYellAtEnd: op.n,
        });
        break;
      case "stageYellToCheerBottom": {
        const uids = allStacks(p).flatMap(({ stack }) => stack.yells);
        if (op.cost && uids.length < op.n) {
          log(
            s,
            ctx.player,
            `${ctx.label}: ステージのエールが${op.n}枚に足りずコストを支払えません`,
          );
          abortEffectRest(ctx);
          break;
        }
        // 1.3.2: 通常効果の不足は、その移動だけを可能な限り行う。
        // 「戻したなら」やコロン前のコストは、解析時に cost を指定する。
        const count = Math.min(op.n, uids.length);
        if (count <= 0) break;
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids,
          pickMin: count,
          pickMax: count,
          dest: "cheerDeck",
          restTo: "none",
          from: "stageYells",
          ctx,
        });
        return;
      }
      case "selfYellToCheerBottom": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        if (!src) break;
        const yells = [...src.stack.yells];
        ctx.returnedYell = yells.length;
        if (yells.length === 0) break;
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: yells,
          pickMin: yells.length,
          pickMax: yells.length,
          dest: "cheerDeck",
          restTo: "none",
          from: "stageYells",
          orderMatters: true,
          orderLabel: "エールデッキの下へ置く順に選んでください",
          ctx,
        });
        return;
      }
      case "drawUntilReturnedYell": {
        const target = ctx.returnedYell ?? 0;
        let n = 0;
        while (p.hand.length < target && p.deck.length > 0) {
          p.hand.push(p.deck.shift()!);
          n++;
        }
        if (n > 0)
          logDraw(
            s,
            ctx.player,
            `${ctx.label}: 手札が${target}枚になるまで${n}枚引きました`,
            n,
          );
        break;
      }
      case "turnArtPlusPerCount": {
        const srcEntry = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        let count =
          op.per === "centerYell"
            ? (p.center?.yells.length ?? 0)
            : op.per === "selfYell"
              ? (srcEntry?.stack.yells.length ?? 0)
              : op.per === "selfYellColor"
                ? (srcEntry?.stack.yells.filter((u) =>
                    yellOnIs(s, srcEntry.stack, u, op.color!),
                  ).length ?? 0)
                : op.per === "ownBack"
                  ? p.back.length
                  : op.per === "stageNames"
                    ? allStacks(p).reduce(
                        (acc, { stack }) =>
                          acc +
                          [...stack.cards, ...stack.supports].filter((u) =>
                            cardHasName(s, u, op.names ?? []),
                          ).length,
                        0,
                      )
                    : op.per === "milled"
                      ? (ctx.milled ?? []).length
                      : op.per === "picked"
                        ? (ctx.pickedCards ?? []).length
                        : op.per === "stageTag"
                          ? op.distinctNames
                            ? distinctHolomenNameCount(
                                s,
                                allStacks(p)
                                  .filter(({ stack }) =>
                                    topCard(s, stack).tags.includes(
                                      op.tag ?? "",
                                    ),
                                  )
                                  .map(({ stack }) => stack),
                              )
                            : allStacks(p).filter(({ stack }) =>
                                topCard(s, stack).tags.includes(op.tag ?? ""),
                              ).length
                          : op.per === "usedSupport"
                            ? s.usedSupportTypesThisTurn[ctx.player].length
                            : op.per === "stageYell"
                              ? allStacks(p).reduce(
                                  (acc, { stack }) => acc + stack.yells.length,
                                  0,
                                )
                              : (ctx.revealed ?? []).filter(
                                  (u) => cardOf(s, u).cardType === "support",
                                ).length;
        if (op.per === "archiveFilter")
          count = p.archive.filter((uid) =>
            cardMatchesFilter(s, ctx.player, uid, op.countFilter ?? {}),
          ).length;
        if (op.max !== undefined) count = Math.min(count, op.max);
        if (op.holoPowerCount) count = p.holoPower.length;
        if (op.milledSupportCount)
          count = (ctx.milled ?? []).filter(
            (u) => cardOf(s, u).cardType === "support",
          ).length;
        const total = op.value * count;
        if (total <= 0) {
          log(s, ctx.player, `${ctx.label}: 対象の枚数が0のため効果なし`);
          break;
        }
        ctx.rest.unshift({
          t: "turnArtPlus",
          value: total,
          target: op.target,
          count: op.count,
          filter: op.filter,
        });
        break;
      }
      case "shuffleDeck":
        p.deck = shuffle(p.deck);
        log(s, ctx.player, "デッキをシャッフルしました");
        break;
      case "shuffleCheer":
        p.cheerDeck = shuffle(p.cheerDeck);
        log(s, ctx.player, "エールデッキをシャッフルしました");
        break;
      case "millDeck": {
        if (op.optional) {
          ctx.milled = [];
          if (p.deck.length === 0) break;
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: `${ctx.label}: デッキの上から${op.n}枚をアーカイブしますか？`,
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        if (op.max && Math.min(op.max, p.deck.length) > op.n) {
          ctx.rest.unshift(
            millCountChoice(op, Math.min(op.max, p.deck.length)),
          );
          break;
        }
        const n = Math.min(op.n, p.deck.length);
        const milled = p.deck.splice(0, n);
        p.archive.push(...milled);
        ctx.milled = milled;
        countDeckArchived(s, ctx.player, n);
        log(
          s,
          ctx.player,
          `デッキの上から${n}枚をアーカイブしました` +
            (n > 0
              ? ` (${milled.map((u) => cardLogLabel(s, u)).join("、")})`
              : ""),
        );
        break;
      }
      case "revealTop": {
        const baseN =
          op.nFrom === "stageYell" ? stageYellCount(s, ctx.player) : op.n;
        const n = Math.min(baseN + revealCountBonus(s, ctx), p.deck.length);
        const revealed = p.deck.slice(0, n);
        ctx.revealed = revealed;
        ctx.revealedOwnerOnly = !!op.ownerOnly;
        ctx.revealedOwner = ctx.player;
        ctx.revealedHistory = false;
        const names =
          n > 0
            ? ` (${revealed.map((u) => cardLogLabel(s, u)).join("、")})`
            : "";
        if (op.ownerOnly)
          logPrivate(
            s,
            ctx.player,
            `デッキの上から${n}枚を見ました${names}`,
            `デッキの上から${n}枚を見ました`,
          );
        else log(s, ctx.player, `デッキの上から${n}枚を公開しました${names}`);
        break;
      }
      case "revealHoloTop": {
        const n = Math.min(op.n, p.holoPower.length);
        const revealed = p.holoPower.slice(0, n);
        ctx.revealed = revealed;
        ctx.revealedOwnerOnly = false;
        ctx.revealedOwner = ctx.player;
        ctx.revealedHistory = false;
        log(
          s,
          ctx.player,
          `ホロパワーの上から${n}枚を公開しました (${revealed.map((u) => cardLogLabel(s, u)).join("、")})`,
        );
        break;
      }
      case "revealedTo": {
        ctx.revealedHistory = true;
        // ホロパワーから公開したカードをホロパワーの下に戻す
        if (op.dest === "holoBottom") {
          const movableH = (ctx.revealed ?? []).filter((u) =>
            p.holoPower.includes(u),
          );
          if (movableH.length === 0) break;
          p.holoPower = p.holoPower.filter((u) => !movableH.includes(u));
          p.holoPower.push(...movableH);
          log(
            s,
            ctx.player,
            `公開した${movableH.length}枚を裏向きにしてホロパワーの下に戻しました`,
          );
          break;
        }
        // まだデッキに残っている公開カードだけ移動する (二重移動防止)。
        // ctx.revealed 自体は後続の条件参照 (revealedSome等) のため保持する
        const movable = (ctx.revealed ?? []).filter((u) => p.deck.includes(u));
        if (movable.length === 0) break;
        if (
          op.dest === "archive" &&
          !op.replacementChecked &&
          ctx.artIndex !== undefined
        ) {
          const source = findStackById(
            s,
            ctx.artSourceStackId ?? ctx.sourceStackId ?? -1,
          );
          const abilities =
            source && source.player === ctx.player
              ? collectTriggerAbilities(
                  s,
                  source,
                  ["artUsed"],
                  undefined,
                  undefined,
                  undefined,
                  {
                    ...artTriggerEventData(ctx, 0),
                    revealedArchiveReplacement: true,
                  },
                )
              : [];
          if (abilities.length) {
            ctx.rest.unshift({ ...op, replacementChecked: true });
            // 元の公開結果・待機能力は親に残す。置換のために独立した
            // チェックタイミングを挟まず、選択後に未移動の公開札を処理する。
            const context = captureTriggerContexts(ctx, abilities)[0]
              .eventContext!;
            runOps(s, {
              ...structuredClone(context),
              sourceSupportUid: undefined,
              grantedSupportAbility: undefined,
              sourceCardUid: undefined,
              originOshiSkill: undefined,
              rest: [
                ...abilities.flatMap((ability) => structuredClone(ability.ops)),
                { t: "resume", inner: ctx },
              ],
              label: abilities[0].label,
            });
            return;
          }
        }
        if (
          op.orderMatters &&
          movable.length > 1 &&
          (op.dest === "deckTop" || op.dest === "deckBottom")
        ) {
          pushPrompt(s, {
            type: "effectPickCard",
            player: ctx.player,
            uids: movable,
            pickMin: movable.length,
            pickMax: movable.length,
            dest: op.dest,
            restTo: "none",
            from: "deck",
            orderOnly: op.dest === "deckTop" ? "top" : "bottom",
            orderMatters: true,
            orderLabel: `デッキの${op.dest === "deckTop" ? "上" : "下"}へ置く順に選んでください`,
            preservePickedCards: true,
            revealAll: !ctx.revealedOwnerOnly,
            ctx,
          });
          return;
        }
        p.deck = p.deck.filter((u) => !movable.includes(u));
        if (op.dest === "archive") {
          p.archive.push(...movable);
          countDeckArchived(s, ctx.player, movable.length);
          log(s, ctx.player, `公開した${movable.length}枚をアーカイブしました`);
        } else if (op.dest === "hand") {
          p.hand.push(...movable);
          log(s, ctx.player, `公開した${movable.length}枚を手札に加えました`);
        } else if (op.dest === "deckBottom") {
          p.deck.push(...movable);
          log(
            s,
            ctx.player,
            `公開した${movable.length}枚をデッキの下に戻しました`,
          );
        } else {
          p.deck.unshift(...movable);
          log(
            s,
            ctx.player,
            `公開した${movable.length}枚をデッキの上に戻しました`,
          );
        }
        break;
      }
      case "archiveStageYell": {
        const uids = archiveStageYellCandidates(s, ctx.player, op);
        // 「アーカイブするエール1枚のかわりに、この付与サポートをアーカイブできる」
        // 肩代わり。エールが別のホロメンに付いていても、能力の発生源に付いている
        // カードで代替できる (総合ルール10.11.4)
        if (op.n > 0) {
          const holder = ctx.sourceStackId
            ? findStackById(s, ctx.sourceStackId)
            : null;
          const skip = op.subSkipUids ?? [];
          const subUid = holder
            ? yellArchiveSubUids(
                s,
                holder.stack,
                (color) => (op.yellColor ? op.yellColor === color : true),
                skip,
              )[0]
            : undefined;
          if (subUid !== undefined && holder) {
            const sc = cardOf(s, subUid);
            pushPrompt(s, {
              type: "effectConfirm",
              player: ctx.player,
              label: `「${sc.name}」をアーカイブしてエール1枚分のコストにしますか？`,
              thenOps: [
                {
                  t: "setSource",
                  stackId: holder.stack.id,
                  supportUid: subUid,
                },
                { t: "archiveSelfSupport" },
                { t: "setSource", stackId: holder.stack.id },
                { ...op, n: op.n - 1, subSkipUids: [...skip] },
              ],
              elseOps: [{ ...op, subSkipUids: [...skip, subUid] }],
              ctx,
            });
            return;
          }
        }
        if (op.n === 0) break;
        if (uids.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 条件に合うエールがないためアーカイブできません`,
          );
          abortEffectRest(ctx);
          break;
        }
        const pick = Math.min(op.n, uids.length);
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids,
          pickMin: pick,
          pickMax: pick,
          dest: "archive",
          restTo: "none",
          from: "stageYells",
          ctx,
        });
        return;
      }
      case "specialPerOppCenterYell": {
        const oppP = s.players[other(ctx.player)];
        const yells = oppP.center?.yells.length ?? 0;
        const dmg = op.per * yells;
        ctx.rest.unshift({ t: "special", dmg, target: op.target });
        break;
      }
      case "drawPerStageNamesYell": {
        const count = allStacks(p)
          .filter(({ stack }) =>
            stackNames(s, stack).some((n) => op.names.includes(n)),
          )
          .reduce(
            (sum, { stack }) =>
              sum +
              stack.yells.filter(
                (u) => !op.color || yellOnIs(s, stack, u, op.color),
              ).length,
            0,
          );
        const n = Math.min(count * op.n, p.deck.length);
        p.hand.push(...p.deck.splice(0, n));
        logDraw(s, ctx.player, `${ctx.label}: ${n}枚ドローしました`, n);
        break;
      }
      case "holoPowerPerStageNamesYell": {
        const count = allStacks(p)
          .filter(({ stack }) =>
            stackNames(s, stack).some((n) => op.names.includes(n)),
          )
          .reduce(
            (sum, { stack }) =>
              sum +
              stack.yells.filter(
                (u) => !op.color || yellOnIs(s, stack, u, op.color),
              ).length,
            0,
          );
        const n = Math.min(count * op.n, p.deck.length);
        for (let i = 0; i < n; i++) p.holoPower.unshift(p.deck.shift()!);
        log(s, ctx.player, `デッキの上から${n}枚をホロパワーにしました`);
        break;
      }
      case "archiveHoloPowerAny": {
        if (p.holoPower.length < op.min) {
          log(
            s,
            ctx.player,
            `${ctx.label}: ホロパワーが足りずコストを支払えません`,
          );
          abortEffectRest(ctx);
          break;
        }
        const limit = Math.min(
          op.max ?? p.holoPower.length,
          p.holoPower.length,
        );
        // 10.7.2.4: 支払う枚数を決定してから、非公開のカードをまとめて移す。
        // 途中で1枚ずつ公開すると、その内容を見てXや範囲コストを変更できてしまう。
        if (op.min < limit) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: `ホロパワーを${op.min + 1}枚以上アーカイブしますか？（いいえ：${op.min}枚）`,
            thenOps: [{ ...op, min: op.min + 1 }],
            elseOps: [{ ...op, max: op.min }],
            ctx,
          });
          return;
        }
        const archived = p.holoPower.splice(0, op.min);
        p.archive.push(...archived);
        ctx.pickedCards = [
          ...(op.accumulate ? (ctx.pickedCards ?? []) : []),
          ...archived,
        ];
        ctx.pickedCardsOwnerOnly = false;
        ctx.pickedCardsOwner = ctx.player;
        // Xコストの実支払いを、枚数比例と「N枚以上」の条件へ引き継ぐ。
        ctx.milled = [...ctx.pickedCards];
        if (op.forHandReplacement) {
          ctx.replacementArchived = [
            ...(op.accumulate ? (ctx.replacementArchived ?? []) : []),
            ...archived,
          ];
          ctx.milled = [...ctx.replacementArchived];
        }
        log(s, ctx.player, `ホロパワーの上から${op.min}枚をアーカイブしました`);
        break;
      }
      case "archiveRemainingHand": {
        const holoCount = ctx.replacementArchived?.length ?? 0;
        const eligibleCount = archiveHandEligible(
          s,
          ctx.player,
          op.original,
        ).length;
        const totalMax = op.original.max ?? op.original.n;
        const handMin = Math.max(0, op.original.n - holoCount);
        const handMax = Math.min(
          eligibleCount,
          Math.max(0, totalMax - holoCount),
        );
        if (handMax < handMin) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 手札とホロパワーが足りず必要枚数をアーカイブできません`,
          );
          abortEffectRest(ctx);
          break;
        }
        if (handMax > 0)
          ctx.rest.unshift({
            ...op.original,
            n: handMin,
            max: handMax,
            replacementChecked: true,
          });
        else {
          ctx.milled = [...(ctx.replacementArchived ?? [])];
          ctx.replacementArchived = undefined;
        }
        break;
      }
      case "markOshiSkillUsed": {
        p.usedOshiSkillThisTurn = true;
        (p.usedOshiSkillNamesThisTurn ??= []).push(op.name);
        const key = `oshiSkillUse:${ctx.player}`;
        s.usedTriggersThisTurn[key] = (s.usedTriggersThisTurn[key] ?? 0) + 1;
        log(s, ctx.player, `推しスキル「${op.name}」を使用しました`);
        queueFxWaitMarker(s, "oshiSkill");
        break;
      }
      case "emitOshiSkillUsed": {
        const abilities = collectOshiSkillUsedAbilities(
          s,
          op.player,
          op.sp,
          op.name,
        );
        if (abilities.length)
          (ctx.pendingTriggers ??= []).push({ player: op.player, abilities });
        break;
      }
      case "markOncePerGameUsed": {
        const used = (s.usedEffectsOncePerGame ??= [[], []])[ctx.player];
        if (!used.includes(op.key)) used.push(op.key);
        break;
      }
      case "holoPowerFromDeck": {
        const n = Math.min(op.n, p.deck.length);
        for (let i = 0; i < n; i++) p.holoPower.unshift(p.deck.shift()!);
        log(s, ctx.player, `デッキの上から${n}枚をホロパワーにしました`);
        break;
      }
      case "archiveHoloPower": {
        if (p.holoPower.length < op.n) {
          log(
            s,
            ctx.player,
            `${ctx.label}: ホロパワーが足りずコストを支払えません`,
          );
          abortEffectRest(ctx);
          break;
        }
        p.archive.push(...p.holoPower.splice(0, op.n));
        log(s, ctx.player, `ホロパワーの上から${op.n}枚をアーカイブしました`);
        break;
      }
      case "activateCheerRecipients": {
        for (const id of new Set(ctx.attachedToStackIds ?? [])) {
          const e = findStackById(s, id);
          if (e) applyToStack(s, ctx, e, { t: "activate" });
        }
        break;
      }
      case "activate":
      case "rest":
      case "down":
      case "special":
      case "heal":
      case "turnArtPlus":
      case "turnCostMod":
      case "turnAllColors":
      case "devolve":
      case "turnNoSwitch":
      case "setHp": {
        if (
          op.t === "special" &&
          op.scaleBy &&
          (op.scaleMax !== undefined || op.scaleBy.kind === "stageYell")
        ) {
          op.dmg *= Math.min(
            specialScaleCount(s, ctx, op.scaleBy),
            op.scaleMax ?? Number.POSITIVE_INFINITY,
          );
          op.scaleBy = undefined;
        }
        const apply =
          op.t === "devolve"
            ? ({ t: "devolve" } as const)
            : op.t === "turnNoSwitch"
              ? ({
                  t: "turnNoSwitch",
                  ...turnEffectDuration(
                    s,
                    ctx.player,
                    op.untilNextOppTurn,
                    true,
                  ),
                } as const)
              : op.t === "activate"
                ? ({ t: "activate" } as const)
                : op.t === "rest"
                  ? ({ t: "rest" } as const)
                  : op.t === "down"
                    ? ({ t: "down", noLife: op.noLife } as const)
                    : op.t === "special"
                      ? ({
                          t: "special",
                          dmg:
                            op.dmgFrom === "boundDamage"
                              ? ctx.boundStackId
                                ? (findStackById(s, ctx.boundStackId)?.stack
                                    .damage ?? 0)
                                : 0
                              : op.dmgFrom === "oppCenterDamage"
                                ? (s.players[other(ctx.player)].center
                                    ?.damage ?? 0)
                                : op.dmgFrom === "artTargetDamage"
                                  ? ctx.artTargetStackId
                                    ? (findStackById(s, ctx.artTargetStackId)
                                        ?.stack.damage ?? 0)
                                    : 0
                                  : op.dmgFrom === "overkill"
                                    ? (ctx.lastOverkill ?? 0)
                                    : op.dmgFrom === "triggerDamage"
                                      ? (ctx.triggerDamage ?? 0)
                                      : op.dmgFrom === "oppBackDamageSum"
                                        ? s.players[
                                            other(ctx.player)
                                          ].back.reduce(
                                            (acc, st) => acc + st.damage,
                                            0,
                                          )
                                        : op.dmgFrom === "healed"
                                          ? Math.floor(
                                              (ctx.healed ?? 0) /
                                                (op.dmgFromPer ?? 1),
                                            ) * op.dmg
                                          : op.scaleBy?.kind ===
                                              "stageTagDistinct"
                                            ? op.dmg *
                                              distinctHolomenNameCount(
                                                s,
                                                allStacks(p)
                                                  .filter(({ stack }) =>
                                                    topCard(
                                                      s,
                                                      stack,
                                                    ).tags.includes(
                                                      (
                                                        op.scaleBy as {
                                                          kind: "stageTagDistinct";
                                                          tag: string;
                                                        }
                                                      ).tag,
                                                    ),
                                                  )
                                                  .map(({ stack }) => stack),
                                              )
                                            : op.scaleBy?.kind === "stageTag"
                                              ? op.dmg *
                                                allStacks(p).filter(
                                                  ({ stack }) => {
                                                    const sb = op.scaleBy as {
                                                      kind: "stageTag";
                                                      tag: string;
                                                      bloomLevel?:
                                                        | "Debut"
                                                        | "1st"
                                                        | "2nd"
                                                        | "Spot";
                                                    };
                                                    const c = topCard(s, stack);
                                                    return (
                                                      c.tags.includes(sb.tag) &&
                                                      (!sb.bloomLevel ||
                                                        stackBloomLevels(
                                                          s,
                                                          stack,
                                                        ).includes(
                                                          sb.bloomLevel,
                                                        ))
                                                    );
                                                  },
                                                ).length
                                              : op.scaleBy?.kind === "backTag"
                                                ? op.dmg *
                                                  p.back.filter((stack) =>
                                                    topCard(
                                                      s,
                                                      stack,
                                                    ).tags.includes(
                                                      (
                                                        op.scaleBy as {
                                                          kind: "backTag";
                                                          tag: string;
                                                        }
                                                      ).tag,
                                                    ),
                                                  ).length
                                                : op.scaleBy?.kind ===
                                                    "backTagDistinct"
                                                  ? op.dmg *
                                                    distinctHolomenNameCount(
                                                      s,
                                                      p.back.filter((stack) =>
                                                        topCard(
                                                          s,
                                                          stack,
                                                        ).tags.includes(
                                                          (
                                                            op.scaleBy as {
                                                              kind: "backTagDistinct";
                                                              tag: string;
                                                            }
                                                          ).tag,
                                                        ),
                                                      ),
                                                    )
                                                  : op.scaleBy?.kind ===
                                                      "milled"
                                                    ? op.dmg *
                                                      (ctx.milled ?? []).length
                                                    : op.scaleBy?.kind ===
                                                        "diceRolls"
                                                      ? op.dmg *
                                                        Object.values(
                                                          s.diceRollsThisTurn[
                                                            ctx.player
                                                          ],
                                                        ).reduce(
                                                          (a, b) => a + b,
                                                          0,
                                                        )
                                                      : op.scaleBy?.kind ===
                                                          "archiveFilter"
                                                        ? op.dmg *
                                                          p.archive.filter(
                                                            (u) =>
                                                              (
                                                                op.scaleBy as {
                                                                  kind: "archiveFilter";
                                                                  filters: CardFilter[];
                                                                }
                                                              ).filters.some(
                                                                (f) =>
                                                                  cardMatchesFilter(
                                                                    s,
                                                                    ctx.player,
                                                                    u,
                                                                    f,
                                                                  ),
                                                              ),
                                                          ).length
                                                        : op.scaleBy?.kind ===
                                                            "centerNameStacked"
                                                          ? op.dmg *
                                                            (p.center &&
                                                            (
                                                              op.scaleBy as {
                                                                kind: "centerNameStacked";
                                                                names: string[];
                                                              }
                                                            ).names.includes(
                                                              topCard(
                                                                s,
                                                                p.center,
                                                              ).name,
                                                            )
                                                              ? p.center.cards
                                                                  .length - 1
                                                              : 0)
                                                          : op.dmg,
                          noLife: op.noLife,
                          includeOppCenter: op.includeOppCenter,
                        } as const)
                      : op.t === "heal"
                        ? ({
                            t: "heal",
                            value: scaledHealValue(s, ctx, op),
                          } as const)
                        : op.t === "turnArtPlus"
                          ? ({
                              t: "turnArtPlus",
                              value: op.value,
                              ...turnEffectDuration(
                                s,
                                ctx.player,
                                op.untilNextOppTurn,
                              ),
                            } as const)
                          : op.t === "turnCostMod"
                            ? ({
                                t: "turnCostMod",
                                artCostless: op.artCostless,
                                artColorCostless: op.artColorCostless,
                                artsFree: op.artsFree,
                                batonDelta: op.batonDelta,
                                ...(op.permanent
                                  ? { expiresTurn: Number.MAX_SAFE_INTEGER }
                                  : turnEffectDuration(
                                      s,
                                      ctx.player,
                                      op.untilNextOppTurn,
                                    )),
                              } as const)
                            : op.t === "turnAllColors"
                              ? ({ t: "turnAllColors" } as const)
                              : ({ t: "setHp", value: op.value } as const);
        if (apply.t === "heal" && apply.value === 0) break;
        const restrictSupportTargets =
          (apply.t === "heal" || apply.t === "special") &&
          op.target.startsWith("choose") &&
          !ctx.supportChangedState &&
          !!ctx.sourceCardUid &&
          cardOf(s, ctx.sourceCardUid).cardType === "support";
        const candidates = targetCandidates(
          s,
          ctx,
          op.target,
          "filter" in op ? op.filter : undefined,
        ).filter((entry) => {
          if (!restrictSupportTargets) return true;
          const boundEffect: Op =
            apply.t === "heal"
              ? { t: "heal", target: "bound", value: apply.value }
              : ({ ...op, target: "bound" } as Op);
          return supportBoundTargetCanChangeState(s, ctx.player, entry.stack, [
            boundEffect,
            ...ctx.rest,
          ]);
        });
        if (apply.t === "special" && apply.dmg <= 0) {
          const damageTargets = [...candidates];
          const center = s.players[other(ctx.player)].center;
          if (apply.includeOppCenter && center)
            damageTargets.push({
              player: other(ctx.player),
              pos: "center",
              stack: center,
            });
          if (
            !damageTargets.some(
              (entry) => calculateSpecialDamage(s, ctx, entry, apply, true) > 0,
            )
          ) {
            log(
              s,
              ctx.player,
              `${ctx.label}: ダメージが0のため効果は発揮されません`,
            );
            break;
          }
        }
        if (
          candidates.length === 0 &&
          !(
            apply.t === "special" &&
            apply.includeOppCenter &&
            s.players[other(ctx.player)].center
          )
        ) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象がいないため効果は発揮されません`,
          );
          break;
        }
        const isAll = op.target.startsWith("all") || op.target === "bound";
        if (op.t === "special" && op.allocationCount && apply.t === "special") {
          if (candidates.length === 1) {
            queueSpecialDamage(s, ctx, [candidates[0].stack.id], {
              ...apply,
              dmg: apply.dmg * op.allocationCount,
            });
          } else {
            pushPrompt(s, {
              type: "effectTarget",
              player: ctx.player,
              target: op.target,
              count: op.allocationCount,
              filter: op.filter,
              apply,
              chosen: [],
              damageAllocation: true,
              eligibleStackIds: restrictSupportTargets
                ? candidates.map((entry) => entry.stack.id)
                : undefined,
              ctx,
            });
            return;
          }
          break;
        }
        const count = isAll
          ? candidates.length
          : "count" in op
            ? (op.count ?? 1)
            : 1;
        const needsChoice =
          op.target === "chooseOwn" ||
          op.target === "chooseOwnBack" ||
          op.target === "chooseOpp" ||
          op.target === "chooseOppFront" ||
          op.target === "chooseOppAny" ||
          op.target === "chooseOppBack" ||
          op.target === "chooseOppCenterOrBack";
        if (!needsChoice || candidates.length <= count) {
          if (apply.t === "special")
            queueSpecialDamage(
              s,
              ctx,
              candidates.slice(0, count).map((e) => e.stack.id),
              apply,
            );
          else
            for (const e of candidates.slice(0, count))
              applyToStack(s, ctx, e, apply);
        } else {
          pushPrompt(s, {
            type: "effectTarget",
            player: ctx.player,
            target: op.target,
            count,
            filter: "filter" in op ? op.filter : undefined,
            apply,
            chosen: [],
            eligibleStackIds: restrictSupportTargets
              ? candidates.map((entry) => entry.stack.id)
              : undefined,
            ctx,
          });
          return; // 中断
        }
        break;
      }
      case "chooseBind": {
        const target: StackTarget =
          op.scope === "ownBack"
            ? "chooseOwnBack"
            : op.scope === "opp"
              ? "chooseOppAny"
              : op.scope === "oppFront"
                ? "chooseOpp"
                : "chooseOwn";
        // 「ホロメンを選ぶ→選んだホロメンを回復」は、回復できる=HPが減っている
        // ホロメンしか選べない (Q285)。次opがheal(bound)なら候補をダメージ済みに絞る。
        // (プレイ可否 supportOpsCanChangeState と同じ規則を、実際の選択にも適用する)
        const nextOp = ctx.rest[0];
        const needsDamagedTarget =
          nextOp?.t === "heal" &&
          nextOp.target === "bound" &&
          !boundFollowupCanSendArchiveYell(s, ctx.player, ctx.rest.slice(1));
        const effFilter = needsDamagedTarget
          ? {
              ...(op.filter ?? {}),
              damagedAtLeast: Math.max(op.filter?.damagedAtLeast ?? 0, 1),
            }
          : op.filter;
        const allCandidates =
          op.scope === "ownCenter"
            ? targetCandidates(s, ctx, "ownCenter", effFilter)
            : op.scope === "ownCollab"
              ? (() => {
                  const c = s.players[ctx.player].collab;
                  return c && stackMatchesFilter(s, c, effFilter)
                    ? [
                        {
                          player: ctx.player,
                          pos: "collab" as StagePosition,
                          stack: c,
                        },
                      ]
                    : [];
                })()
              : targetCandidates(s, ctx, target, effFilter);
        // 「[〈A〉と〈B〉]1人ずつを選ぶ」の2人目は1人目と別のホロメンでなければ
        // ならない (〈ラムダック〉のように両方の名称として扱えるカードがある)
        const boundCandidates = op.append
          ? allCandidates.filter(
              (e) => !(ctx.boundStackIds ?? []).includes(e.stack.id),
            )
          : allCandidates;
        const candidates = maximalBindCandidates(
          s,
          ctx,
          op,
          ctx.sourceCardUid &&
            cardOf(s, ctx.sourceCardUid).cardType === "support"
            ? boundCandidates.filter(({ stack }) =>
                supportBoundTargetCanChangeState(
                  s,
                  ctx.player,
                  stack,
                  ctx.rest,
                ),
              )
            : boundCandidates,
        );
        // 前回の選択をリセット (複数 chooseBind の混在防止。append指定時は追加束縛)
        if (!op.append) {
          ctx.boundStackId = undefined;
          ctx.boundStackIds = [];
        }
        if (candidates.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象がいないため効果は発揮されません`,
          );
          // 束縛対象がいない場合、以降の bound 参照は空振りする
          break;
        }
        const count =
          op.countFrom === "milled"
            ? (ctx.milled ?? []).length
            : op.countFrom === "picked"
              ? (ctx.pickedCards ?? []).length
              : (op.count ?? 1);
        if (count === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 選ぶ人数が0のため効果は発揮されません`,
          );
          break;
        }
        if (candidates.length <= count) {
          for (const e of candidates) applyToStack(s, ctx, e, { t: "bind" });
          break;
        }
        pushPrompt(s, {
          type: "effectTarget",
          player: ctx.player,
          target,
          count,
          filter: effFilter,
          apply: { t: "bind" },
          chosen: [],
          distinctColors: op.distinctColors,
          eligibleStackIds: candidates.map(({ stack }) => stack.id),
          ctx,
        });
        return;
      }
      case "turnArtTargetExtend": {
        const targets = targetCandidates(s, ctx, op.target, op.filter);
        if (targets.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象がいないため効果は発揮されません`,
          );
          break;
        }
        for (const e of targets.slice(0, op.count ?? targets.length))
          s.turnModifiers.push({
            stackId: e.stack.id,
            artPlus: 0,
            artTargetExtend: op.extendFilter ?? {},
          });
        log(
          s,
          ctx.player,
          `${ctx.label}: このターンの間、アーツは相手のバックホロメンも対象にできます`,
        );
        break;
      }
      case "effectBloom": {
        const candidates = effectBloomCandidates(
          s,
          ctx.player,
          op,
          ctx.sourceStackId,
          ctx.boundStackId,
        );
        if (candidates.length === 0) {
          log(s, ctx.player, `${ctx.label}: Bloomできる組み合わせがありません`);
          break;
        }
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: "この効果でBloomしますか？",
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        ctx.rest.unshift({
          t: "effectBloomPick",
          source: op.source,
          cardFilter: op.cardFilter,
          rebloom: op.rebloom || op.filter?.bloomedThisTurn,
          allowFirstTurn: op.allowFirstTurn,
          ignoreEntered: op.filter?.enteredThisTurn,
          ignoreLevel: op.ignoreLevel,
        });
        if (op.targetBound) break;
        ctx.boundStackId = undefined;
        ctx.boundStackIds = [];
        if (candidates.length === 1) {
          applyToStack(s, ctx, candidates[0], { t: "bind" });
          break;
        }
        pushPrompt(s, {
          type: "effectTarget",
          player: ctx.player,
          target: op.targetPos === "back" ? "chooseOwnBack" : "chooseOwn",
          count: 1,
          filter: op.filter,
          apply: { t: "bind" },
          chosen: [],
          eligibleStackIds: candidates.map(({ stack }) => stack.id),
          ctx,
        });
        return;
      }
      case "effectBloomPick": {
        const bound = ctx.boundStackId
          ? findStackById(s, ctx.boundStackId)
          : null;
        if (!bound) {
          log(
            s,
            ctx.player,
            `${ctx.label}: Bloom対象がいないため効果は発揮されません`,
          );
          break;
        }
        const opts = {
          ignoreFirstTurns: op.allowFirstTurn,
          ignoreEntered: op.ignoreEntered,
          ignoreBloomed: op.rebloom,
          ignoreLevel: op.ignoreLevel,
        };
        const sourceStack = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)?.stack
          : undefined;
        const pool = (
          op.source === "hand"
            ? p.hand
            : op.source === "archive"
              ? p.archive
              : op.source === "deck"
                ? p.deck
                : (sourceStack?.cards.slice(1) ?? [])
        ).filter(
          (u) =>
            (!op.cardFilter ||
              cardMatchesFilter(s, ctx.player, u, op.cardFilter)) &&
            canBloomOnto(s, u, bound.stack, opts).ok,
        );
        if (pool.length === 0) {
          log(s, ctx.player, `${ctx.label}: Bloomできるホロメンがありません`);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: pool,
          // 10.7.2.3.5: 未公開のデッキからは、同名・レベル・HP等の条件を
          // 満たすカードがあっても選ばず、後続の効果へ進める。
          pickMin: op.source === "deck" ? 0 : 1,
          pickMax: 1,
          dest: "bloom",
          restTo: "none",
          from:
            op.source === "hand"
              ? "hand"
              : op.source === "archive"
                ? "archive"
                : op.source === "deck"
                  ? "deck"
                  : "stacked",
          ctx,
        });
        return;
      }
      case "swapCenter": {
        const sidePid = op.side === "own" ? ctx.player : other(ctx.player);
        const sp = s.players[sidePid];
        if (!sp.center) {
          log(
            s,
            ctx.player,
            `${ctx.label}: センターホロメンがいないため交代できません`,
          );
          break;
        }
        const backs = swapCenterCandidates(s, ctx.player, op);
        if (backs.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 交代できるバックホロメンがいません`,
          );
          break;
        }
        if (backs.length === 1) {
          applyToStack(s, ctx, backs[0], { t: "swapCenter" });
          break;
        }
        pushPrompt(s, {
          type: "effectTarget",
          player: ctx.player,
          target: op.side === "own" ? "chooseOwnBack" : "chooseOppBack",
          count: 1,
          filter: op.filter,
          eligibleStackIds: backs.map(({ stack }) => stack.id),
          apply: { t: "swapCenter" },
          chosen: [],
          ctx,
        });
        return;
      }
      case "drawUntil": {
        let n = 0;
        while (p.hand.length < op.n && p.deck.length > 0) {
          p.hand.push(p.deck.shift()!);
          n++;
        }
        if (n > 0)
          logDraw(
            s,
            ctx.player,
            `${ctx.label}: 手札が${op.n}枚になるまで${n}枚引きました`,
            n,
          );
        break;
      }
      case "drawUntilStageNames": {
        // ステージの指定名カード (ホロメン+重なり+付与サポート) の枚数まで引く
        const target = allStacks(p).reduce(
          (acc, { stack }) =>
            acc +
            [...stack.cards, ...stack.supports].filter((u) =>
              cardHasName(s, u, op.names),
            ).length,
          0,
        );
        const cap = op.cap ?? Infinity;
        let n = 0;
        while (p.hand.length < target && p.deck.length > 0 && n < cap) {
          p.hand.push(p.deck.shift()!);
          n++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: ステージの〈${op.names.join("・")}〉${target}枚に合わせて${n}枚引きました`,
          n,
        );
        break;
      }
      case "drawThenArchive": {
        let n = 0;
        for (let i = 0; i < op.draw && p.deck.length > 0; i++) {
          p.hand.push(op.fromBottom ? p.deck.pop()! : p.deck.shift()!);
          n++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: ${op.fromBottom ? "デッキの下から" : ""}${n}枚ドローしました`,
          n,
        );
        ctx.rest.unshift({ t: "archiveHand", n: op.archive });
        break;
      }
      case "millCheer": {
        if (op.max && Math.min(op.max, p.cheerDeck.length) > op.n) {
          ctx.rest.unshift(
            millCountChoice(op, Math.min(op.max, p.cheerDeck.length)),
          );
          break;
        }
        const n = Math.min(op.n, p.cheerDeck.length);
        const milled = p.cheerDeck.splice(0, n);
        p.archive.push(...milled);
        ctx.milled = milled;
        log(
          s,
          ctx.player,
          `エールデッキの上から${n}枚をアーカイブしました` +
            (n > 0
              ? ` (${milled.map((uid) => cardLogLabel(s, uid)).join("、")})`
              : ""),
        );
        if (milled.length > 0) {
          queueYellArchivedReactive(s, ctx, milled);
          ctx.rest.unshift(...collectYellArchivedTriggerOps(s, ctx.player));
        }
        break;
      }
      case "bothMillCheer": {
        const milled: string[] = [];
        const triggerOps: Op[] = [];
        for (const pid of [ctx.player, other(ctx.player)] as PlayerId[]) {
          const pp = s.players[pid];
          const n = Math.min(op.n, pp.cheerDeck.length);
          const cards = pp.cheerDeck.splice(0, n);
          pp.archive.push(...cards);
          milled.push(...cards);
          if (cards.length > 0)
            triggerOps.push(...collectYellArchivedTriggerOps(s, pid));
          log(
            s,
            pid,
            `エールデッキの上から${n}枚をアーカイブしました` +
              (n > 0
                ? ` (${cards.map((u) => cardLogLabel(s, u)).join("、")})`
                : ""),
          );
        }
        ctx.milled = milled;
        queueYellArchivedReactive(s, ctx, milled);
        ctx.rest.unshift(...triggerOps);
        break;
      }
      case "drawPerMilledYellColor": {
        const colors = new Set<string>();
        for (const u of ctx.milled ?? []) {
          const c = cardOf(s, u);
          if (c.cardType === "yell") colors.add((c as YellCard).color);
        }
        const total = Math.floor(colors.size / op.per) * op.draw;
        let drawn = 0;
        for (let i = 0; i < total && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: アーカイブしたエール${colors.size}色分、${drawn}枚ドローしました`,
          drawn,
        );
        break;
      }
      case "limitedLimit": {
        p.limitedLimit = op.n;
        log(
          s,
          ctx.player,
          `このターンの間、使えるLIMITEDのサポートカードの枚数は${op.n}枚になります`,
        );
        break;
      }
      case "turnArtPlusEachYellColor": {
        for (const { pos, stack } of allStacks(p)) {
          if (!stackMatchesFilter(s, stack, op.filter)) continue;
          const colors = new Set(
            stack.yells.flatMap((u) => yellColorsOn(s, stack, u)),
          );
          if (colors.size === 0) continue;
          const value = op.value * colors.size;
          s.turnModifiers.push({ stackId: stack.id, artPlus: value });
          log(
            s,
            ctx.player,
            `このターンの間、${positionedHolomenName(s, pos, stack)}のアーツ+${value} (エール${colors.size}色)`,
          );
        }
        break;
      }
      case "downReward": {
        const stackId = op.boundSubject ? ctx.boundStackId : undefined;
        if (op.boundSubject && stackId === undefined) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 選んだホロメンがいないため効果は発揮されません`,
          );
          break;
        }
        (s.downRewards ??= []).push({
          player: ctx.player,
          sourceLabel: ctx.label,
          tag: op.tag,
          stackId,
          anyHolomen: op.anyHolomen,
          artDamageOnly: op.artDamageOnly,
          oppLifeMinus: op.oppLifeMinus,
          draw: op.draw,
          expiresTurn: s.turn,
        });
        const subject = op.boundSubject
          ? "選んだホロメン"
          : `自分の${op.tag ? `#${op.tag}を持つ` : ""}ホロメン`;
        const targetLabel = op.anyHolomen ? "ホロメン" : "センターホロメン";
        const reward = [
          op.oppLifeMinus ? `相手のライフ-${op.oppLifeMinus}` : "",
          op.draw ? `自分のデッキを${op.draw}枚引く` : "",
        ]
          .filter(Boolean)
          .join("、");
        log(
          s,
          ctx.player,
          `このターンの間、${subject}が${op.artDamageOnly ? "アーツダメージで" : ""}相手の${targetLabel}をダウンさせた時、${reward}`,
        );
        break;
      }
      case "turnSpecialPlus": {
        const boundId = ctx.boundStackId;
        const bound = boundId !== undefined ? findStackById(s, boundId) : null;
        if (!bound) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 選んだホロメンがいないため効果は発揮されません`,
          );
          break;
        }
        s.turnModifiers.push({
          stackId: bound.stack.id,
          artPlus: 0,
          specialPlus: op.value,
        });
        log(
          s,
          ctx.player,
          `このターンの間、${positionedHolomenName(s, bound.pos, bound.stack)}が相手に与える特殊ダメージ+${op.value}`,
        );
        break;
      }
      case "janken": {
        // 効果使用者→相手の順に入力する。先の手はgameViewForで相手から隠す。
        pushPrompt(s, {
          type: "jankenHand",
          player: ctx.player,
          initiator: ctx.player,
          winOps: structuredClone(op.winOps) as Op[],
          ctx,
        });
        return;
      }
      case "turnSpecialAttack": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        if (!src) break;
        s.turnModifiers.push({
          stackId: src.stack.id,
          artPlus: 0,
          specialAttack: { color: op.color, value: op.value },
        });
        log(
          s,
          ctx.player,
          `このターンの間、${positionedHolomenName(s, src.pos, src.stack)}は${op.color}特攻+${op.value}を得ます`,
        );
        break;
      }
      case "repeatArtGrant": {
        const boundId =
          op.target === "self" ? ctx.sourceStackId : ctx.boundStackId;
        const bound = boundId !== undefined ? findStackById(s, boundId) : null;
        if (!bound) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 選んだホロメンがいないため効果は発揮されません`,
          );
          break;
        }
        s.turnModifiers.push({
          stackId: bound.stack.id,
          artPlus: 0,
          repeatArt: 1,
          repeatArtOptional: op.optional,
        });
        log(
          s,
          ctx.player,
          `このターンの間、${positionedHolomenName(s, bound.pos, bound.stack)}はアーツを使った後、同じアーツをもう1回使${op.optional ? "える" : "う"}`,
        );
        break;
      }
      case "changeArtTargetToOppBack": {
        const candidates = targetCandidates(s, ctx, "chooseOppBack");
        if (candidates.length === 0) {
          log(s, ctx.player, `${ctx.label}: 相手のバックホロメンがいません`);
          break;
        }
        const restriction = opponentArtTargetError(
          s,
          ctx.player,
          candidates[0].pos,
        );
        if (restriction) {
          log(s, ctx.player, `${ctx.label}: ${restriction}`);
          break;
        }
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: "アーツの対象を相手のバックホロメンに変更しますか？",
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        pushPrompt(s, {
          type: "effectTarget",
          player: ctx.player,
          target: "chooseOppBack",
          count: 1,
          apply: { t: "changeArtTarget" },
          chosen: [],
          ctx,
        });
        return;
      }
      case "moveSelfSupport": {
        const uid = ctx.sourceSupportUid;
        if (!uid) break;
        const holder = allStacks(p).find(({ stack }) =>
          stack.supports.includes(uid),
        );
        if (!holder) {
          log(s, ctx.player, `${ctx.label}: 付け替えるカードがありません`);
          break;
        }
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: `${cardOf(s, uid).name}を付け替えますか？`,
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        holder.stack.supports = holder.stack.supports.filter((u) => u !== uid);
        const preview: Extract<Prompt, { type: "effectAttach" }> = {
          type: "effectAttach",
          player: ctx.player,
          uid,
          targetFilter: op.targetFilter,
          ctx,
        };
        if (!hasAttachTarget(s, preview)) {
          holder.stack.supports.push(uid);
          log(s, ctx.player, `${ctx.label}: 付け替え先がありません`);
          break;
        }
        pushPrompt(s, preview);
        return;
      }
      case "repeatArtCheck": {
        const sourceStackId = ctx.artSourceStackId ?? ctx.sourceStackId;
        const src = sourceStackId ? findStackById(s, sourceStackId) : null;
        if (!src || ctx.artIndex === undefined) break;

        // 「同じホロメンに」と明記されたアーツ自身の繰り返しを先に消費する。
        if ((ctx.repeatSameTargetPending ?? 0) > 0) {
          ctx.repeatSameTargetPending!--;
          const targetStackId =
            ctx.artPrimaryTargetStackId ?? ctx.artTargetStackId;
          const target = targetStackId ? findStackById(s, targetStackId) : null;
          if (!target) {
            log(
              s,
              ctx.player,
              "アーツの対象がダウンしたため、繰り返しを終了します",
            );
            break;
          }
          ctx.rest.unshift({ t: "repeatArtNow", sameTarget: true });
          break;
        }

        // 対象固定でない予約は、新しいアーツ使用として合法な対象を選び直す。
        if ((ctx.repeatPending ?? 0) > 0) {
          ctx.repeatPending!--;
          ctx.rest.unshift({ t: "repeatArtNow" });
          break;
        }

        const tm = s.turnModifiers.find(
          (m) =>
            m.stackId === src.stack.id &&
            (m.repeatArt ?? 0) > 0 &&
            (m.expiresTurn ?? s.turn) >= s.turn,
        );
        if (!tm) {
          const oshi = cardOf(s, p.oshiUid) as OshiCard,
            key = `stageOshi:${ctx.player}:魔弾の射手`;
          if (
            oshi.stageOshiSkill?.name !== "魔弾の射手" ||
            src.pos !== "center" ||
            src.stack.resting ||
            !stackNames(s, src.stack).includes("常闇トワ") ||
            (s.usedTriggersThisTurn[key] ?? 0) >= 1
          )
            break;
          const choices = availableArtRefs(s, src.stack).filter(
            (ref) =>
              ref.art.name !== ctx.artName &&
              canPayArtCost(s, src.stack, ref.art.cost, ref.art.description) &&
              legalArtTargets(s, ctx.player, src.stack, ref.art).length > 0,
          );
          let next: Op[] = [];
          for (const ref of choices.reverse())
            next = [
              {
                t: "chooseOps",
                label: `異なるアーツ「${ref.art.name}」をもう1回使いますか？`,
                thenOps: [
                  { t: "markTriggerUsed", key },
                  {
                    t: "repeatDifferentArtNow",
                    cardId: ref.cardId,
                    index: ref.index,
                  },
                ],
                elseOps: next,
              },
            ];
          ctx.rest.unshift(...next);
          break;
        }
        tm.repeatArt!--;
        if (tm.repeatArtOptional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: "同じアーツをもう1回使いますか？",
            thenOps: [{ t: "repeatArtNow" }],
            ctx,
          });
          return;
        }
        ctx.rest.unshift({ t: "repeatArtNow" });
        break;
      }
      case "repeatArtNow": {
        // アーツ効果の途中なら、ダメージ解決後のrepeatArtCheckまで予約する。
        if (ctx.rest.some((o) => o.t === "artDamage")) {
          if (op.sameTarget)
            ctx.repeatSameTargetPending =
              (ctx.repeatSameTargetPending ?? 0) + 1;
          else ctx.repeatPending = (ctx.repeatPending ?? 0) + 1;
          break;
        }

        const sourceStackId = ctx.artSourceStackId ?? ctx.sourceStackId;
        const src = sourceStackId ? findStackById(s, sourceStackId) : null;
        if (!src || ctx.artIndex === undefined) {
          log(
            s,
            ctx.player,
            `${ctx.label}: アーツの使用者がいないため、もう1回使えません`,
          );
          break;
        }
        const art = artFromContext(s, ctx, src.stack);
        if (!art) {
          log(
            s,
            ctx.player,
            `${ctx.label}: アーツが見つからないため、もう1回使えません`,
          );
          break;
        }

        // 再使用も新しいアーツのプレイ。直前の被弾時能力などで
        // エールが失われた場合は、対象を選ぶ前に現在のコストを再確認する。
        if (!canPayArtCost(s, src.stack, art.cost, art.description)) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 必要なエールが足りないため、もう1回使えません`,
          );
          break;
        }

        if (!op.targetChosen) {
          const previousTarget =
            ctx.artPrimaryTargetStackId ?? ctx.artTargetStackId;
          resetArtTransientContext(
            ctx,
            src.stack.id,
            op.sameTarget ? previousTarget : undefined,
            art.name,
          );

          if (!op.sameTarget) {
            const candidates = legalArtTargets(s, ctx.player, src.stack, art);
            if (candidates.length === 0) {
              log(
                s,
                ctx.player,
                `${ctx.label}: 対象がいないため、もう1回使えません`,
              );
              break;
            }
            if (candidates.length === 1) {
              ctx.artTargetStackId = candidates[0].stack.id;
              ctx.artPrimaryTargetStackId = candidates[0].stack.id;
            } else {
              ctx.rest.unshift({ t: "repeatArtNow", targetChosen: true });
              pushPrompt(s, {
                type: "effectTarget",
                player: ctx.player,
                target: "chooseOppAny",
                count: 1,
                apply: { t: "bind" },
                chosen: [],
                eligibleStackIds: candidates.map((entry) => entry.stack.id),
                ctx,
              });
              return;
            }
          }
        } else {
          ctx.artTargetStackId = ctx.boundStackId;
          ctx.artPrimaryTargetStackId = ctx.boundStackId;
          ctx.boundStackId = undefined;
          ctx.boundStackIds = undefined;
        }

        const target = ctx.artTargetStackId
          ? findStackById(s, ctx.artTargetStackId)
          : null;
        if (!target) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象がいなくなったため、もう1回使えません`,
          );
          break;
        }
        if (!op.sameTarget) {
          const targetError = artTargetError(
            s,
            ctx.player,
            src.stack,
            art,
            target,
          );
          if (targetError) {
            log(s, ctx.player, `${ctx.label}: ${targetError}`);
            break;
          }
        }

        log(
          s,
          ctx.player,
          `${positionedHolomenName(s, src.pos, src.stack)}のアーツ「${art.name}」をもう1回使います → ${positionedHolomenName(s, target.pos, target.stack)}`,
        );
        recordArtUse(s, ctx.player, src.pos, src.stack);
        ctx.rest.unshift(...buildArtOps(s, art, target.stack, src.pos));
        break;
      }
      case "repeatDifferentArtNow": {
        ctx.artRef = { cardId: op.cardId, index: op.index };
        ctx.artIndex = op.index;
        ctx.rest.unshift({ t: "repeatArtNow" });
        break;
      }
      case "artDamageToFronts": {
        // 保留中のアーツダメージを、対象のかわりに相手のセンター+コラボへの2つに置き換える
        const idx = ctx.rest.findIndex((o) => o.t === "artDamage");
        if (idx < 0) break;
        const ad = ctx.rest[idx] as Extract<Op, { t: "artDamage" }>;
        const opp = s.players[other(ctx.player)];
        const targets = [opp.center, opp.collab].filter(
          (x): x is HolomenStack => !!x,
        );
        if (targets.length === 0) break;
        const repl = targets.map((t) => ({
          ...(structuredClone(ad) as Extract<Op, { t: "artDamage" }>),
          targetStackId: t.id,
        }));
        ctx.rest.splice(idx, 1, ...repl);
        log(
          s,
          ctx.player,
          `${ctx.label}: アーツダメージは、対象のかわりに相手のセンターホロメンとコラボホロメンに与えます`,
        );
        break;
      }
      case "handToDeckBottom": {
        if (p.hand.length === 0) break;
        const eligible = op.filter
          ? p.hand.filter((u) =>
              cardMatchesFilter(s, ctx.player, u, op.filter!),
            )
          : [...p.hand];
        if (eligible.length === 0) break;
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: eligible,
          pickMin: Math.min(op.n, eligible.length),
          pickMax: Math.min(op.n, eligible.length),
          dest: op.top ? "deckTop" : "deckBottom",
          revealSelection: op.reveal,
          orderLabel: "デッキに置く順に選んでください",
          restTo: "none",
          from: "hand",
          ctx,
        });
        return;
      }
      case "handToDeckBottomAny": {
        if (p.hand.length === 0) break;
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: [...p.hand],
          pickMin: 0,
          pickMax: p.hand.length,
          dest: "deckBottom",
          restTo: "none",
          from: "hand",
          orderMatters: true,
          orderLabel: "デッキの下へ置く順に選んでください",
          ctx,
        });
        return;
      }
      case "shuffleHandIntoDeck": {
        p.deck = shuffle([...p.deck, ...p.hand]);
        p.hand = [];
        log(
          s,
          ctx.player,
          `${ctx.label}: 手札すべてをデッキに戻してシャッフルしました`,
        );
        // 文ごとの解析では、後続のdraw命令が別に入る (thenDraw=0)。
        // 手札を戻しただけの処理から余分な「0枚ドロー」を作らない。
        if (op.thenDraw > 0) ctx.rest.unshift({ t: "draw", n: op.thenDraw });
        break;
      }
      case "diceVs": {
        // クロスインパクトはサポートの能力。両者の履歴と出目修正を反映する。
        const roll = (player: PlayerId) => {
          const raw = Math.floor(gameRandom() * 6) + 1;
          const history = s.diceRollsThisTurn[player];
          history["(サポート)"] = (history["(サポート)"] ?? 0) + 1;
          const mod = diceModifiersFor(s, player, 1, "(サポート)", false)[0];
          if (mod?.once) s.diceMods = s.diceMods.filter((dm) => dm !== mod);
          return {
            raw,
            result: mod ? (mod.double ? raw * 2 : (mod.value ?? raw)) : raw,
          };
        };
        const mine = roll(ctx.player);
        const theirs = roll(other(ctx.player));
        logDice(
          s,
          ctx.player,
          `${ctx.label}: お互いにサイコロを振りました → 自分【${mine.result}】 相手【${theirs.result}】`,
          ctx.label,
          [mine.result, theirs.result],
          {
            sourceStackId: ctx.sourceStackId,
            sourceUid: ctx.sourceSupportUid ?? ctx.sourceCardUid,
            sourceOshi: false,
          },
          { versus: true, rolledResults: [mine.raw, theirs.raw] },
        );
        ctx.rest.unshift(
          ...(structuredClone(
            mine.result >= theirs.result ? op.geOps : op.ltOps,
          ) as Op[]),
        );
        if (queueDiceAnimationDelay(s, ctx, s.log.at(-1)!.id, true, 2)) return;
        break;
      }
      case "boundToDeckBottom": {
        const ids =
          ctx.boundStackIds && ctx.boundStackIds.length > 0
            ? ctx.boundStackIds
            : ctx.boundStackId
              ? [ctx.boundStackId]
              : [];
        let any = false;
        for (const id of ids) {
          const entry = findStackById(s, id);
          if (!entry) continue;
          applyToStack(s, ctx, entry, { t: "toDeckBottom" });
          any = true;
        }
        if (!any)
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象がいないため効果は発揮されません`,
          );
        break;
      }
      case "boundStackAllToDeckBottom": {
        const id =
          ctx.boundStackId ??
          (ctx.boundStackIds && ctx.boundStackIds.length > 0
            ? ctx.boundStackIds.at(-1)
            : undefined);
        const entry = id === undefined ? null : findStackById(s, id);
        if (!entry) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象がいないため効果は発揮されません`,
          );
          break;
        }
        const owner = s.players[entry.player];
        const cards = [...entry.stack.cards];
        // 付属エールの退場時アーカイブは11.4.1のルール処理。能力によるアーカイブではない。
        const yellAbilities =
          entry.stack.yells.length > 0
            ? collectYellArchivedTriggerAbilities(s, entry.player)
            : [];
        const returnedAbilities = collectReturnedToDeckAbilities(
          s,
          entry.player,
          entry.stack,
        );
        const targetName = positionedHolomenName(s, entry.pos, entry.stack);
        removeStack(s, owner, entry.pos);
        owner.archive.push(...entry.stack.yells, ...entry.stack.supports);
        if (entry.stack.yells.length > 0)
          s.stageYellArchivedThisTurn[entry.player] = true;
        s.turnModifiers = s.turnModifiers.filter(
          (modifier) => modifier.stackId !== entry.stack.id,
        );
        s.stageToDeckThisTurn[entry.player] = true;
        const abilities = [...yellAbilities, ...returnedAbilities];
        if (abilities.length > 0)
          ctx.rest.unshift({
            t: "runTriggerAbilities",
            player: entry.player,
            abilities,
            label: "ステージを離れた時の能力",
            defer: true,
          });
        if (cards.length <= 1) {
          owner.deck.push(...cards);
          ctx.pickedCards = [...cards];
          ctx.pickedCardsOwnerOnly = false;
          ctx.pickedCardsOwner = ctx.player;
          log(
            s,
            entry.player,
            `${targetName}のホロメン${cards.length}枚をデッキの下に戻しました`,
          );
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: entry.player,
          uids: cards,
          pickMin: cards.length,
          pickMax: cards.length,
          dest: "deckBottom",
          restTo: "none",
          from: "stacked",
          orderMatters: true,
          orderLabel:
            "重なっているホロメンをデッキの下へ置く順に選んでください",
          revealAll: true,
          ctx,
        });
        return;
      }
      case "boundRestToBack": {
        const ids =
          ctx.boundStackIds && ctx.boundStackIds.length > 0
            ? ctx.boundStackIds
            : ctx.boundStackId
              ? [ctx.boundStackId]
              : [];
        for (const id of ids) {
          const e = findStackById(s, id);
          if (!e) continue;
          const owner = s.players[e.player];
          const sourceName = positionedHolomenName(s, e.pos, e.stack);
          if (hasNoSwitch(s, e.stack)) {
            log(s, ctx.player, `${ctx.label}: 効果により移動できません`);
            continue;
          }
          if (typeof e.pos === "string") {
            if (owner.back.length >= 5) {
              e.stack.resting = true;
              log(
                s,
                ctx.player,
                `${ctx.label}: バックが満杯のため${sourceName}はその場でお休みしました`,
              );
              continue;
            }
            removeStack(s, owner, e.pos);
            owner.back.push(e.stack);
          }
          e.stack.resting = true;
          log(
            s,
            ctx.player,
            `${ctx.label}: ${sourceName}をお休みさせてバックポジションに移動しました`,
          );
        }
        break;
      }
      case "noActivateNextReset": {
        const ids =
          ctx.boundStackIds && ctx.boundStackIds.length > 0
            ? ctx.boundStackIds
            : ctx.boundStackId
              ? [ctx.boundStackId]
              : [];
        for (const id of ids) {
          if (!s.skipResetActivate.includes(id)) s.skipResetActivate.push(id);
          const e = findStackById(s, id);
          if (e)
            log(
              s,
              ctx.player,
              `${ctx.label}: ${positionedHolomenName(s, e.pos, e.stack)}は次のリセットステップでアクティブになりません`,
            );
        }
        break;
      }
      case "selfToBack": {
        const e = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        if (!e || typeof e.pos !== "string") break; // 既にバックにいる
        const owner = s.players[e.player];
        if (hasNoSwitch(s, e.stack)) {
          log(s, ctx.player, `${ctx.label}: 効果により移動できません`);
          break;
        }
        if (owner.back.length >= 5) {
          log(s, ctx.player, `${ctx.label}: バックが満杯のため移動できません`);
          break;
        }
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: "このホロメンをバックポジションに移動しますか？",
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        removeStack(s, owner, e.pos);
        owner.back.push(e.stack);
        log(
          s,
          ctx.player,
          `${ctx.label}: ${positionedHolomenName(s, e.pos, e.stack)}をバック${owner.back.length}に移動しました`,
        );
        break;
      }
      case "selfSwapWithCollab": {
        const e = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        const owner = e ? s.players[e.player] : null;
        const collab = owner?.collab ?? null;
        if (!e || !owner || !collab || typeof e.pos === "string") {
          log(s, ctx.player, `${ctx.label}: 交代できる対象がいません`);
          break;
        }
        if (hasNoSwitch(s, e.stack) || hasNoSwitch(s, collab)) {
          log(s, ctx.player, `${ctx.label}: 効果により交代できません`);
          break;
        }
        if (op.maxRemainingHp !== undefined) {
          const remaining = effectiveMaxHp(s, collab) - collab.damage;
          if (remaining > op.maxRemainingHp) {
            log(
              s,
              ctx.player,
              `${ctx.label}: コラボホロメンの残りHPが${op.maxRemainingHp}を超えているため交代できません`,
            );
            break;
          }
        }
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: "コラボホロメンとこのホロメンを交代しますか？",
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        const backIdx = e.pos.back;
        owner.back[backIdx] = collab;
        owner.collab = e.stack;
        log(
          s,
          ctx.player,
          `${ctx.label}: バック${backIdx + 1}の${topCard(s, e.stack).name}とコラボの${topCard(s, collab).name}を交代しました`,
        );
        ctx.rest.unshift({
          t: "emitTriggers",
          stackId: e.stack.id,
          events: ["collabMoved"],
        });
        break;
      }
      case "chooseOps": {
        // 10.7.2.2.1 / 10.7.2.3.7: 選択しなかった段落は存在しないものとして
        // 扱うため、サポートでは状態を変えられる能力だけを選べる。
        if (
          ctx.sourceCardUid &&
          cardOf(s, ctx.sourceCardUid).cardType === "support"
        ) {
          const thenUsable = supportOpsCanChangeState(
            s,
            ctx.player,
            op.thenOps,
            ctx.sourceStackId,
            true,
          );
          const elseUsable = supportOpsCanChangeState(
            s,
            ctx.player,
            op.elseOps,
            ctx.sourceStackId,
            true,
          );
          if (!thenUsable || !elseUsable) {
            if (thenUsable) ctx.rest.unshift(...op.thenOps);
            else if (elseUsable) ctx.rest.unshift(...op.elseOps);
            break;
          }
        }
        pushPrompt(s, {
          type: "effectConfirm",
          player: ctx.player,
          label: op.label,
          thenOps: op.thenOps,
          elseOps: op.elseOps,
          ctx,
        });
        return;
      }
      case "finishSupportCard": {
        if (p.resolvingSupports?.includes(op.uid)) {
          const abilities = collectOshiStageActionAbilities(
            s,
            ctx.player,
            "supportUsed",
            undefined,
            op.uid,
          );
          if (abilities.length)
            ctx.rest.unshift({
              t: "runTriggerAbilities",
              player: ctx.player,
              abilities,
              defer: true,
            });
          p.resolvingSupports = p.resolvingSupports.filter(
            (uid) => uid !== op.uid,
          );
          p.archive.push(op.uid);
        }
        break;
      }
      case "selfCardToDeck": {
        const uid = ctx.sourceCardUid;
        if (
          uid &&
          (p.resolvingSupports?.includes(uid) || p.archive.includes(uid))
        ) {
          if (p.resolvingSupports)
            p.resolvingSupports = p.resolvingSupports.filter((u) => u !== uid);
          p.archive = p.archive.filter((u) => u !== uid);
          p.deck.push(uid);
          p.deck = shuffle(p.deck);
          log(
            s,
            ctx.player,
            `${ctx.label}: このカードをデッキに戻してシャッフルしました`,
          );
        }
        break;
      }
      case "turnFirstArtReduce": {
        const targets = targetCandidates(s, ctx, op.target);
        if (targets.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象がいないため効果は発揮されません`,
          );
          break;
        }
        for (const e of targets) {
          s.turnModifiers.push({
            stackId: e.stack.id,
            artPlus: 0,
            firstArtDamageReduce: op.value,
            firstArtDamagePos: op.pos,
            ...turnEffectDuration(s, ctx.player, op.untilNextOppTurn, true),
          });
          log(
            s,
            ctx.player,
            `${ctx.label}: ${positionedHolomenName(s, e.pos, e.stack)}が${op.pos === "center" ? "センターポジションで" : ""}最初に受けるアーツダメージ-${op.value}`,
          );
        }
        break;
      }
      case "bothShuffleHandIntoDeck": {
        for (const pid of [ctx.player, other(ctx.player)] as PlayerId[]) {
          const pl = s.players[pid];
          pl.deck = shuffle([...pl.deck, ...pl.hand]);
          pl.hand = [];
        }
        log(
          s,
          ctx.player,
          `${ctx.label}: お互いの手札すべてをデッキに戻してシャッフルしました`,
        );
        if (op.thenDraw > 0) {
          for (const pid of [ctx.player, other(ctx.player)] as PlayerId[]) {
            const pl = s.players[pid];
            let n = 0;
            for (let i = 0; i < op.thenDraw && pl.deck.length > 0; i++) {
              pl.hand.push(pl.deck.shift()!);
              n++;
            }
            logDraw(s, pid, `${playerName(s, pid)}は${n}枚ドローしました`, n);
          }
        }
        break;
      }
      case "searchCheer": {
        // 後続に明示的なシャッフルがあれば、検索時には重複して行わない。
        let followingSearches = 0;
        while (ctx.rest[followingSearches]?.t === "searchCheer")
          followingSearches++;
        const deferCheerShuffle =
          ctx.rest[0]?.t === "searchCheer" ||
          ctx.rest[followingSearches]?.t === "shuffleCheer";
        let filter = op.filter;
        if (filter.sameColorAsBound) {
          const b = ctx.boundStackId
            ? findStackById(s, ctx.boundStackId)
            : null;
          if (!b) {
            log(
              s,
              ctx.player,
              `${ctx.label}: 対象がいないため効果は発揮されません`,
            );
            break;
          }
          const colors = stackRealColors(s, b.stack);
          filter = {
            alt: colors.map((color) => ({ color, kind: "yell" as const })),
          };
        }
        const matches = p.cheerDeck.filter((u) =>
          cardMatchesFilter(s, ctx.player, u, filter),
        );
        // 色などに合う候補の有無を、非公開のエールデッキ外へ伝えない。
        if (p.cheerDeck.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: エールデッキに対象カードがありませんでした`,
          );
          if (!deferCheerShuffle) {
            p.cheerDeck = shuffle(p.cheerDeck);
            log(s, ctx.player, "エールデッキをシャッフルしました");
          }
          break;
        }
        // エールデッキにはエールだけがある。色などの条件がなければ、
        // 送り先が存在する限り指定枚数（範囲指定なら下限）を選ぶ。
        const sendable = matches.filter(
          (yellUid) =>
            cheerAssignCapacity(s, {
              type: "cheerAssign",
              player: ctx.player,
              yellUid,
              reason: "effect",
              ctx,
              filter: op.targetFilter,
            }) > 0,
        ).length;
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: matches,
          pickMin: hiddenPickNeedsCardInfo(filter, "cheer")
            ? 0
            : Math.min(op.min ?? op.n, sendable),
          pickMax: Math.min(op.n, matches.length),
          dest: "cheerAssign",
          restTo: "none",
          from: "cheer",
          shuffleAfter: deferCheerShuffle ? undefined : "cheer",
          pickFilter: filter,
          targetFilter: op.targetFilter,
          ctx,
        });
        return;
      }
      case "moveArchive": {
        // 登場に失敗した場合、後続の「そのホロメン」が以前の対象を参照しない。
        if (op.dest === "stage") {
          ctx.boundStackId = undefined;
          ctx.boundStackIds = [];
        }
        // 「付けたなら」は、以前の付与ではなくこのOpの実際の成功枚数を参照する。
        if (op.dest === "attach") ctx.lastAttachedCount = 0;
        let archiveFilter = op.filter;
        if (archiveFilter.sameNameAsAttachedTo) {
          const attached = ctx.attachedToStackId
            ? findStackById(s, ctx.attachedToStackId)
            : null;
          if (!attached) {
            log(
              s,
              ctx.player,
              `${ctx.label}: エールを送ったホロメンがいないため効果は発揮されません`,
            );
            break;
          }
          archiveFilter = {
            ...archiveFilter,
            sameNameAsAttachedTo: undefined,
            names: stackNames(s, attached.stack),
          };
        }
        const matches = p.archive.filter((u) =>
          cardMatchesFilter(s, ctx.player, u, archiveFilter),
        );
        if (matches.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: アーカイブに対象カードがありません`,
          );
          break;
        }
        // 指定枚数に足りなくても「できる限り」戻す (公式Q88/Q461)。
        // 任意効果の下限は、アーカイブにある枚数で頭打ちにする。
        const archiveRequired = Math.min(op.min, matches.length);
        // 「アーカイブしたカードper枚につきn枚」の動的枚数
        if (op.maxPerMilled) {
          const dyn =
            Math.floor((ctx.milled ?? []).length / op.maxPerMilled.per) *
            op.maxPerMilled.n;
          if (dyn <= 0) {
            log(
              s,
              ctx.player,
              `${ctx.label}: アーカイブした枚数が0のため効果なし`,
            );
            break;
          }
          const pick = Math.min(dyn, matches.length);
          pushPrompt(s, {
            type: "effectPickCard",
            player: ctx.player,
            uids: matches,
            pickMin: op.optional ? 0 : pick,
            pickMax: pick,
            dest: op.dest,
            restTo: "none",
            from: "archive",
            ctx,
            pickFilter: archiveFilter,
            orderMatters: op.orderMatters,
            zeroOrMin: op.optional && pick > 0 ? pick : undefined,
            orderLabel: op.orderMatters
              ? `${op.dest === "cheerDeck" ? "エールデッキ" : "デッキ"}へ置く順に選んでください`
              : undefined,
          });
          return;
        }
        {
          let attachTf: TargetFilter | undefined;
          if (op.dest === "attach") {
            if (op.attachTargetFilter) attachTf = op.attachTargetFilter;
            else if (op.attachTargetNames)
              attachTf = { names: op.attachTargetNames };
            else if (op.attachToSelf) attachTf = { sourceOnly: true };
            if (op.attachExcludeSource)
              attachTf = { ...(attachTf ?? {}), excludeSource: true };
          }
          pushPrompt(s, {
            type: "effectPickCard",
            player: ctx.player,
            uids: matches,
            pickMin: op.optional ? 0 : archiveRequired,
            pickMax: Math.min(op.max, matches.length),
            dest: op.dest,
            restTo: "none",
            from: "archive",
            targetFilter: attachTf,
            sameTarget: op.attachSameTarget,
            pickFilter: archiveFilter,
            orderMatters: op.orderMatters,
            zeroOrMin:
              op.optional && archiveRequired > 0 ? archiveRequired : undefined,
            orderLabel: op.orderMatters
              ? `${op.dest === "cheerDeck" ? "エールデッキ" : "デッキ"}へ置く順に選んでください`
              : undefined,
            ctx,
          });
        }
        return;
      }
      case "artPlus":
        ctx.artBonus = (ctx.artBonus ?? 0) + op.value;
        log(s, ctx.player, `${ctx.label}: このアーツ+${op.value}`);
        break;
      case "artPlusPer": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        if (!src) break;
        let count = 0;
        if (op.per === "selfYell") count = src.stack.yells.length;
        else if (op.per === "selfYellColor")
          count = src.stack.yells.filter((u) =>
            yellOnIs(s, src.stack, u, op.color!),
          ).length;
        else if (op.per === "attachedName")
          count = src.stack.supports.filter((u) =>
            cardHasName(s, u, op.names ?? []),
          ).length;
        else if (op.per === "stageTag") {
          const entries = allStacks(p).filter(
            ({ stack }) =>
              (!op.excludeSelf || stack.id !== src.stack.id) &&
              topCard(s, stack).tags.includes(op.tag ?? "") &&
              (!op.bloomLevel ||
                stackBloomLevels(s, stack).includes(op.bloomLevel)),
          );
          if (op.distinctNames) {
            count = distinctHolomenNameCount(
              s,
              entries.map(({ stack }) => stack),
            );
          } else count = entries.length;
        } else if (op.per === "stacked") count = src.stack.cards.length - 1;
        else if (op.per === "stageMascot")
          count = allStacks(p).reduce(
            (acc, { stack }) =>
              acc +
              stack.supports.filter((u) => {
                const c = cardOf(s, u);
                return (
                  c.cardType === "support" && c.supportType === "マスコット"
                );
              }).length,
            0,
          );
        else if (op.per === "ownBack") count = p.back.length;
        else if (op.per === "archiveNamed")
          count = p.archive.filter((u) =>
            cardHasName(s, u, op.names ?? []),
          ).length;
        else if (op.per === "stageNamed")
          count = allStacks(p).filter((x) =>
            (op.names ?? []).some((n) => stackNames(s, x.stack).includes(n)),
          ).length;
        else if (op.per === "centerNamedYell")
          count =
            p.center &&
            (op.names ?? []).some((n) => stackNames(s, p.center!).includes(n))
              ? p.center.yells.length
              : 0;
        else if (op.per === "downsPrevTurn")
          count = s.downsPrevTurn[ctx.player];
        else if (op.per === "stageNonDebut")
          count = allStacks(p).filter(
            (x) => topCard(s, x.stack).bloomLevel !== "Debut",
          ).length;
        else if (op.per === "revealedHolomen")
          count = (ctx.revealed ?? []).filter(
            (u) => cardOf(s, u).cardType === "holomen",
          ).length;
        else if (op.per === "milled") count = (ctx.milled ?? []).length;
        else if (op.per === "stageYell")
          count = allStacks(p).reduce(
            (acc, { stack }) => acc + stack.yells.length,
            0,
          );
        else if (op.per === "stageFan")
          count = allStacks(p).reduce(
            (acc, { stack }) =>
              acc +
              stack.supports.filter((u) => {
                const c = cardOf(s, u);
                return c.cardType === "support" && c.supportType === "ファン";
              }).length,
            0,
          );
        else if (op.per === "archiveHolomen")
          count = p.archive.filter(
            (u) => cardOf(s, u).cardType === "holomen",
          ).length;
        else if (op.per === "archiveCard") count = p.archive.length;
        else if (op.per === "archiveColorYell")
          count = p.archive.filter((u) => {
            const c = cardOf(s, u);
            return c.cardType === "yell" && (c as YellCard).color === op.color;
          }).length;
        else if (op.per === "handCount") count = p.hand.length;
        else if (op.per === "oppDamagedBack") {
          const opp = s.players[other(ctx.player)];
          count = opp.back.filter((st) => st.damage > 0).length;
        } else if (op.per === "oppResting") {
          const opp = s.players[other(ctx.player)];
          count = allStacks(opp).filter(({ stack }) => stack.resting).length;
        } else if (op.per === "oppArchiveYell") {
          const opp = s.players[other(ctx.player)];
          count = opp.archive.filter(
            (u) => cardOf(s, u).cardType === "yell",
          ).length;
        } else if (op.per === "oppOshiDiffColor") {
          const opp = s.players[other(ctx.player)];
          count = allStacks(opp).filter(({ stack }) =>
            hasDiffColorFromOwnerOshi(s, stack),
          ).length;
        } else if (op.per === "bothStageYell") {
          count = 0;
          for (const pid of [0, 1] as PlayerId[])
            for (const { stack } of allStacks(s.players[pid]))
              count += stack.yells.length;
        } else if (op.per === "bothArchiveYell") {
          count = 0;
          for (const pid of [0, 1] as PlayerId[])
            count += s.players[pid].archive.filter(
              (u) => cardOf(s, u).cardType === "yell",
            ).length;
        } else if (op.per === "lifeLost") {
          const oshi = cardOf(s, p.oshiUid) as OshiCard;
          count = Math.max(0, oshi.life - p.life.length);
        } else if (op.per === "movedHolomen") {
          count = (ctx.pickedCards ?? []).filter(
            (u) => cardOf(s, u).cardType === "holomen",
          ).length;
        } else if (op.per === "stageYellColors") {
          const colors = new Set<string>();
          for (const { stack } of allStacks(p))
            for (const u of stack.yells)
              for (const c of yellColorsOn(s, stack, u)) colors.add(c);
          count = colors.size;
        } else if (op.per === "usedEvent") {
          count = op.tag
            ? (s.usedSupportTagTypesThisTurn[ctx.player] ?? []).filter(
                (e) => e === `${op.tag}|イベント`,
              ).length
            : (s.usedSupportTypesThisTurn[ctx.player] ?? []).filter(
                (k) => k === "イベント",
              ).length;
        } else if (op.per === "oppHandCount") {
          count = s.players[other(ctx.player)].hand.length;
        } else if (op.per === "archiveYell") {
          count = p.archive.filter(
            (u) => cardOf(s, u).cardType === "yell",
          ).length;
        } else if (op.per === "stageYellDiff") {
          let mine = 0;
          let oppYell = 0;
          for (const { stack } of allStacks(p)) mine += stack.yells.length;
          for (const { stack } of allStacks(s.players[other(ctx.player)]))
            oppYell += stack.yells.length;
          count = Math.max(0, mine - oppYell);
        } else if (op.per === "usedLimited") {
          count = p.limitedUsedCount ?? (p.usedLimitedThisTurn ? 1 : 0);
        } else if (op.per === "stageTagYell") {
          count = 0;
          for (const { stack } of allStacks(p))
            if (topCard(s, stack).tags.includes(op.tag ?? ""))
              count += stack.yells.length;
        }
        if (op.perN && op.perN > 1) count = Math.floor(count / op.perN);
        if (op.max !== undefined) count = Math.min(count, op.max);
        if (count > 0) {
          const add = op.value * count;
          ctx.artBonus = (ctx.artBonus ?? 0) + add;
          log(s, ctx.player, `${ctx.label}: このアーツ+${add} (${count}個分)`);
        }
        break;
      }
      case "dice": {
        // ダウン時の推しスキルのコンテキストには、誘発元ホロメンも残る。
        // サイコロを振る能力の発生源は推しホロメンとして扱う。
        const srcEntry =
          !ctx.originOshiSkill && ctx.sourceStackId
            ? findStackById(s, ctx.sourceStackId)
            : null;
        const fromSupport = isSupportAbilitySource(s, ctx);
        const fromOshi = !srcEntry && !fromSupport;
        let rolls = op.rolls ?? 1;
        if (op.rollsFrom) {
          const countAttached = (kinds: string[]) =>
            allStacks(p).reduce(
              (acc, { stack }) =>
                acc +
                stack.supports.filter((u) => {
                  const c = cardOf(s, u);
                  return (
                    c.cardType === "support" && kinds.includes(c.supportType)
                  );
                }).length,
              0,
            );
          rolls =
            op.rollsFrom.per === "stacked"
              ? srcEntry
                ? srcEntry.stack.cards.length - 1
                : 0
              : op.rollsFrom.per === "stageMascotFan"
                ? countAttached(["マスコット", "ファン"])
                : op.rollsFrom.per === "stageMascot"
                  ? countAttached(["マスコット"])
                  : distinctHolomenNameCount(
                      s,
                      allStacks(p)
                        .filter(({ stack }) =>
                          topCard(s, stack).tags.includes(
                            op.rollsFrom!.tag ?? "",
                          ),
                        )
                        .map(({ stack }) => stack),
                    );
          if (op.rollsFrom.perN !== undefined && op.rollsFrom.perN > 1)
            rolls = Math.floor(rolls / op.rollsFrom.perN);
          if (op.rollsFrom.max !== undefined)
            rolls = Math.min(rolls, op.rollsFrom.max);
        }
        if (rolls <= 0) {
          log(s, ctx.player, `${ctx.label}: 振れる回数が0のため効果なし`);
          break;
        }
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: `${ctx.label}: サイコロを${rolls}回振りますか？`,
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        // 「自分の(F)の能力でサイコロを振る時」リアクティブ (目の宣言。振る前に確認)
        if (!op.reactChecked) {
          op.reactChecked = true;
          if (
            srcEntry &&
            !fromSupport &&
            srcEntry.player === ctx.player &&
            s.phase === "playing"
          ) {
            const ur = usableOshiReactive(
              s,
              ctx.player,
              "diceRolling",
              srcEntry.stack,
            );
            if (ur && ur.reactive.when === "diceRolling") {
              ctx.rest.unshift(op); // サイコロを保留
              pushPrompt(s, {
                type: "reactiveSkill",
                player: ctx.player,
                sp: ur.sp,
                skillName: ur.skill.name,
                description: ur.skill.description,
                cost: ur.cost,
                kind: "ops",
                ops: ur.reactive.ops,
                ctx,
              });
              return;
            }
          }
        }
        const matched: Op[] = [];
        let rollSum = 0;
        let oddCount = 0;
        let latestDiceLogId: number | undefined;
        const freshDiceLogs: GameState["log"] = [];
        const rollerName = fromSupport
          ? "(サポート)"
          : srcEntry
            ? topCard(s, srcEntry.stack).name
            : "(推し)";
        // サイコロの目の修正 (「目の数すべてをXとして扱う/倍として扱う」)
        const diceMods = diceModifiersFor(
          s,
          ctx.player,
          rolls,
          rollerName,
          fromOshi,
        );
        // 振り直しの判断前に全回数を振り、効果の適用は最終結果が決まるまで待つ。
        // Q394/Q419: 振り直し前の結果は無くなるため、履歴の回数は増えない。
        const results =
          op.pendingRolls ??
          (op.forcedRoll !== undefined ? [op.forcedRoll] : undefined) ??
          Array.from({ length: rolls }, () => Math.floor(gameRandom() * 6) + 1);
        const resumed =
          op.pendingRolls !== undefined || op.forcedRoll !== undefined;
        if (!resumed) {
          const rollId = (s.log.at(-1)?.id ?? 0) + 1;
          const summaries = diceResultSummaries(op, results, p.life.length);
          if (!op.rollCounted) {
            const dr = s.diceRollsThisTurn[ctx.player];
            dr[rollerName] = (dr[rollerName] ?? 0) + rolls;
          }
          for (let r = 0; r < results.length; r++) {
            const roll = results[r];
            logDice(
              s,
              ctx.player,
              `${ctx.label}: サイコロを振りました → 出た目は【${roll}】` +
                (rolls > 1 ? ` (${r + 1}/${rolls}回目)` : ""),
              ctx.label,
              [roll],
              {
                sourceStackId: srcEntry?.stack.id,
                sourceUid: ctx.sourceSupportUid ?? ctx.sourceCardUid,
                sourceOshi: fromOshi,
              },
              { rollId, summaries },
            );
            latestDiceLogId = s.log.at(-1)?.id;
            freshDiceLogs.push(s.log.at(-1)!);
          }
        }
        op.rollCounted = true;
        op.rolls = rolls;
        op.rollsFrom = undefined;
        // 「自分の(F)の能力でサイコロを振った時」リアクティブ (振り直し。複数回なら全結果を置換)
        if (!op.rerollChecked) {
          op.rerollChecked = true;
          if (
            !op.rerollsFinished &&
            srcEntry &&
            !fromSupport &&
            srcEntry.player === ctx.player &&
            s.phase === "playing"
          ) {
            if (!op.rerollOshiChecked) {
              op.rerollOshiChecked = true;
              const ur = usableOshiReactive(
                s,
                ctx.player,
                "diceRolled",
                srcEntry.stack,
              );
              if (ur && ur.reactive.when === "diceRolled") {
                op.pendingRolls = results; // 見送った場合はこの出目で続行
                op.animationWaited = true;
                ctx.rest.unshift(op);
                queueDiceAnimationDelay(
                  s,
                  ctx,
                  latestDiceLogId!,
                  false,
                  results.length,
                );
                pushPrompt(s, {
                  type: "reactiveSkill",
                  player: ctx.player,
                  sp: ur.sp,
                  skillName: ur.skill.name,
                  description: ur.skill.description,
                  cost: ur.cost,
                  kind: "ops",
                  ops: ur.reactive.ops,
                  ctx,
                });
                return;
              }
            }
            // 装着ファンの「能力でサイコロを振った時、アーカイブして振り直す」
            for (const uid of srcEntry.stack.supports) {
              const sc = cardOf(s, uid);
              if (sc.cardType !== "support") continue;
              const pb = passiveOf(sc);
              if (!pb.diceReroll) continue;
              if (
                pb.diceReroll.requiresCond &&
                !passiveCondMatches(s, srcEntry.stack, pb.cond)
              )
                continue;
              op.pendingRolls = results; // 見送った場合はこの出目で続行
              op.animationWaited = true;
              ctx.rest.unshift(op);
              queueDiceAnimationDelay(
                s,
                ctx,
                latestDiceLogId!,
                false,
                results.length,
              );
              pushPrompt(s, {
                type: "effectConfirm",
                player: ctx.player,
                label: `「${sc.name}」をアーカイブしてサイコロを振り直しますか？`,
                thenOps: [
                  {
                    t: "setSource",
                    stackId: srcEntry.stack.id,
                    supportUid: uid,
                  },
                  { t: "archiveSelfSupport" },
                  {
                    t: "setSource",
                    stackId: srcEntry.stack.id,
                    supportUid: ctx.sourceSupportUid,
                  },
                  { t: "rerollDice" },
                ],
                ctx,
              });
              return;
            }
          }
          op.rerollsFinished = true;
        }
        // 5.24.4 / 10.11.2: 振り直しを終えてから、出目の置換を選んだ順に全て適用する。
        // 一度きりの修正もここで確保し、入力待ちのJSON往復後に消費し直さない。
        if (op.pendingDiceMods === undefined) {
          op.pendingDiceMods = structuredClone(diceMods);
          s.diceMods = s.diceMods.filter(
            (mod) => !mod.once || !diceMods.includes(mod),
          );
        }
        op.pendingRolls = results;
        const replacements: { label: string; ops: Op[] }[] =
          op.pendingDiceMods.map((mod, index) => ({
            label: diceModifierLabel(mod),
            ops: [{ t: "applyDiceModifier", index }],
          }));
        const subjectOk =
          !fromSupport &&
          (srcEntry
            ? topCard(s, srcEntry.stack).tags.includes("1期生")
            : fromOshi);
        if (subjectOk) {
          const offeredFans = new Set<string>();
          for (const { stack: fanHolder } of allStacks(p)) {
            for (const uid of fanHolder.supports) {
              if (op.declinedDiceFans?.includes(uid)) continue;
              const sc = cardOf(s, uid);
              if (sc.cardType !== "support") continue;
              const pb = passiveOf(sc);
              const mod = pb.diceOneToValue;
              if (!mod) continue;
              if (
                srcEntry &&
                mod.subjectTag &&
                !topCard(s, srcEntry.stack).tags.includes(mod.subjectTag)
              )
                continue;
              if (!srcEntry && !mod.includeOshi) continue;
              if (
                mod.requiresCond &&
                !passiveCondMatches(s, fanHolder, pb.cond)
              )
                continue;
              // 同じ装着先の同一カードは順番を変えても結果が同じ。1枚使用後に次を提示する。
              const fanKey = `${fanHolder.id}:${sc.id}`;
              if (offeredFans.has(fanKey)) continue;
              offeredFans.add(fanKey);
              // 変更するのは1個だけ。最後の候補まで見送ったら、その出目を選ぶ。
              let selectResult: Op[] = [
                {
                  t: "forceDiceResult",
                  value: mod.value,
                  index: results.length - 1,
                },
              ];
              for (let index = results.length - 2; index >= 0; index--) {
                selectResult = [
                  {
                    t: "chooseOps",
                    label: `${index + 1}個目の【${results[index]}】を【${mod.value}】にしますか？（いいえ：次の出目を選ぶ）`,
                    thenOps: [
                      { t: "forceDiceResult", value: mod.value, index },
                    ],
                    elseOps: selectResult,
                  },
                ];
              }
              replacements.push({
                label: `「${sc.name}」の出目変更`,
                ops: [
                  {
                    t: "chooseOps",
                    label: `「${sc.name}」をアーカイブして出た目1つを【${mod.value}】として扱いますか？`,
                    thenOps: [
                      {
                        t: "setSource",
                        stackId: fanHolder.id,
                        supportUid: uid,
                      },
                      { t: "archiveSelfSupport" },
                      {
                        t: "setSource",
                        stackId: srcEntry?.stack.id ?? 0,
                        supportUid: ctx.sourceSupportUid,
                      },
                      ...selectResult,
                    ],
                    elseOps: [{ t: "skipDiceFan", uid }],
                  },
                ],
              });
            }
          }
        }
        if (
          replacements.length === 1 &&
          replacements[0].ops[0].t === "applyDiceModifier"
        ) {
          applyPendingDiceModifier(s, ctx, op, 0);
        } else if (replacements.length > 0) {
          // 二択を連ね、複数あるときだけ先に適用する効果を選択する。
          let choices = replacements.at(-1)!.ops;
          for (let i = replacements.length - 2; i >= 0; i--)
            choices = [
              {
                t: "chooseOps",
                label: `${replacements[i].label}を先に適用しますか？（いいえ：次の効果を選ぶ）`,
                thenOps: replacements[i].ops,
                elseOps: choices,
              },
            ];
          op.animationWaited = true;
          ctx.rest.unshift(...choices, op);
          if (
            latestDiceLogId !== undefined &&
            queueDiceAnimationDelay(
              s,
              ctx,
              latestDiceLogId,
              true,
              results.length,
            )
          )
            return;
          break;
        }
        op.pendingRolls = undefined;
        op.forcedRoll = undefined;
        // 選択待ちを挟まず確定した出目は、従来どおり修正後の値をまとめて演出する。
        // 振り直し・適用順を選ぶ前に公開したログには、未確定の修正値を混ぜない。
        const summaries = diceResultSummaries(op, results, p.life.length);
        freshDiceLogs.forEach((entry, index) => {
          if (entry.animation?.kind === "dice")
            entry.animation.summaries = summaries;
          if (
            entry.animation?.kind === "dice" &&
            entry.animation.results[0] !== results[index]
          ) {
            entry.animation.results = [results[index]];
            entry.text += `（【${results[index]}】として扱います）`;
          }
        });
        const branchCounts = op.branches.map(() => 0);
        for (let r = 0; r < results.length; r++) {
          const roll = results[r];
          rollSum += roll;
          if (roll % 2 === 1) oddCount++;
          if (op.drawUntilRoll) matched.push({ t: "drawUntil", n: roll });
          for (const [branchIndex, br] of op.branches.entries()) {
            if (br.cond === "eqBothLife") continue;
            if (typeof br.cond === "object" && "perValue" in br.cond) {
              // 出た目に比例して効果を繰り返す
              const times = Math.floor(roll / br.cond.perValue);
              for (let i = 0; i < times; i++)
                matched.push(...(structuredClone(br.ops) as Op[]));
              continue;
            }
            const hit = diceBranchMatches(br.cond, roll, p.life.length);
            if (hit) {
              if (br.countBased) branchCounts[branchIndex]++;
              else matched.push(...(structuredClone(br.ops) as Op[]));
            }
          }
        }
        for (const [branchIndex, br] of op.branches.entries()) {
          const count = branchCounts[branchIndex];
          if (count === 0) continue;
          // 数量に比例するダメージは一度に与え、軽減・無効・ダウンも一度だけ判定する。
          // 複数の処理がある本文は、全枚数のドロー等を終えてから次の処理へ進む。
          for (const branchOp of br.ops) {
            if (branchOp.t === "special")
              matched.push({
                ...structuredClone(branchOp),
                dmg: branchOp.dmg * count,
              });
            else if (branchOp.t === "draw")
              matched.push({
                ...structuredClone(branchOp),
                n: branchOp.n * count,
              });
            else
              for (let i = 0; i < count; i++)
                matched.push(structuredClone(branchOp));
          }
        }
        // このアーツで振った出た目の合計を累積 (「そのアーツでサイコロを振って出た目の合計数」参照用)
        ctx.artDiceSum = (ctx.artDiceSum ?? 0) + rollSum;
        for (const branch of op.branches)
          if (
            branch.cond === "eqBothLife" &&
            rollSum === p.life.length + s.players[other(ctx.player)].life.length
          )
            matched.push(...structuredClone(branch.ops));
        // 出た目の合計に比例したアーツ+
        if (op.sumArtPlus && rollSum > 0) {
          const add = op.sumArtPlus * rollSum;
          ctx.artBonus = (ctx.artBonus ?? 0) + add;
          log(
            s,
            ctx.player,
            `${ctx.label}: 出た目の合計${rollSum} → このアーツ+${add}`,
          );
        }
        // 集計分岐: 「奇数がX回以上出たなら」
        if (op.aggOdd) {
          if (oddCount >= op.aggOdd.atLeast) {
            log(
              s,
              ctx.player,
              `${ctx.label}: 奇数が${oddCount}回出たため効果が発揮されます`,
            );
            matched.push(...(structuredClone(op.aggOdd.ops) as Op[]));
          } else {
            log(
              s,
              ctx.player,
              `${ctx.label}: 奇数が${op.aggOdd.atLeast}回以上出ませんでした`,
            );
          }
        }
        if (matched.length === 0 && !op.sumArtPlus && !op.aggOdd)
          log(s, ctx.player, `${ctx.label}: 条件に合わず効果は発揮されません`);
        ctx.rest.unshift(...matched);
        if (
          !op.animationWaited &&
          latestDiceLogId !== undefined &&
          queueDiceAnimationDelay(s, ctx, latestDiceLogId, true, results.length)
        )
          return;
        break;
      }
      case "searchDeck": {
        // 「それぞれ選んだホロメンと同色」: 選んだホロメンの色で実行時に解決
        let searchGroups = op.groups;
        let searchFilter = op.filter;
        if (searchFilter.sameBloomAsBound) {
          const bound = ctx.boundStackId
            ? findStackById(s, ctx.boundStackId)
            : null;
          if (!bound) break;
          const levels = stackBloomLevels(s, bound.stack);
          searchFilter = {
            alt: levels.map((level) => ({
              ...searchFilter,
              sameBloomAsBound: undefined,
              bloomLevel: level,
            })),
          };
        }
        if (
          searchGroups?.some(
            (g) => g.filter.sameColorAsBoundIndex !== undefined,
          )
        ) {
          const boundIds =
            ctx.boundStackIds && ctx.boundStackIds.length > 0
              ? ctx.boundStackIds
              : ctx.boundStackId !== undefined
                ? [ctx.boundStackId]
                : [];
          searchGroups = searchGroups
            .map((g) => {
              if (g.filter.sameColorAsBoundIndex === undefined) return g;
              const id = boundIds[g.filter.sameColorAsBoundIndex];
              const e = id !== undefined ? findStackById(s, id) : null;
              if (!e) return null;
              const color = stackColors(s, e.stack)[0];
              return {
                ...g,
                filter: {
                  ...g.filter,
                  sameColorAsBoundIndex: undefined,
                  color,
                },
              };
            })
            .filter(
              (g): g is { filter: CardFilter; max: number } => g !== null,
            );
          if (searchGroups.length === 0) {
            log(
              s,
              ctx.player,
              `${ctx.label}: 選んだホロメンがいないため効果は発揮されません`,
            );
            break;
          }
          // 検索プールは各枠のいずれかに一致するカード
          searchFilter = { alt: searchGroups.map((g) => g.filter) };
        }
        // 「戻したホロメンと同じカード名」: 直前に戻したカード名で実行時に解決
        if (searchFilter.sameNameAsReturned) {
          const names = (ctx.pickedCards ?? []).map((u) => cardOf(s, u).name);
          if (names.length === 0) {
            log(
              s,
              ctx.player,
              `${ctx.label}: 戻したカードがないため効果は発揮されません`,
            );
            break;
          }
          searchFilter = {
            ...searchFilter,
            sameNameAsReturned: undefined,
            names,
          };
        }
        // searchDeck 自体は、カード本文から末尾のシャッフル文を省略して組み立てる
        // 専用パーサーでも使うため、後続に明示的な shuffleDeck がなければ自身で
        // シャッフルする。一方、通常の効果文は searchDeck, shuffleDeck の順に解析
        // されるので、ここでもシャッフルすると同じ解決で2回実行・記録されてしまう。
        // 1文から複数の searchDeck が並ぶ形も、最後の検索後に1回だけ行う。
        let followingSearches = 0;
        while (ctx.rest[followingSearches]?.t === "searchDeck")
          followingSearches++;
        const deferDeckShuffle =
          ctx.rest[0]?.t === "searchDeck" ||
          ctx.rest[followingSearches]?.t === "shuffleDeck";
        const shuffleAfterSearch = () => {
          if (deferDeckShuffle) return;
          p.deck = shuffle(p.deck);
          log(s, ctx.player, "デッキをシャッフルしました");
        };
        const matches = p.deck.filter((u) =>
          cardMatchesFilter(s, ctx.player, u, searchFilter),
        );
        // 候補数は非公開情報。候補0でも、選ばず終える場合と同じ入力を経由する。
        // 公開されているデッキ枚数が0の場合だけ、検索を即座に終えてよい。
        if (p.deck.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: デッキに対象カードがありませんでした`,
          );
          shuffleAfterSearch();
          break;
        }
        const stageCapacity =
          op.dest === "stage"
            ? Math.max(0, Math.min(6 - stageCount(p), 5 - p.back.length))
            : Number.POSITIVE_INFINITY;
        if (stageCapacity === 0) {
          log(s, ctx.player, `${ctx.label}: ステージが満杯です`);
          shuffleAfterSearch();
          break;
        }
        // 空でない非公開デッキの検索は、0枚を選んでも後続のシャッフルまで行う。
        // 先に状態を変えたサポートの後続対象を、効果なしだけを理由に除外しない。
        if (
          ctx.sourceCardUid &&
          cardOf(s, ctx.sourceCardUid).cardType === "support"
        )
          ctx.supportChangedState = true;
        let searchTf: TargetFilter | undefined;
        if (op.dest === "attach") {
          if (op.attachTargetFilter) searchTf = op.attachTargetFilter;
          else if (op.attachTargetNames)
            searchTf = { names: op.attachTargetNames };
          else if (op.attachToSelf) searchTf = { sourceOnly: true };
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: matches,
          pickMax: Math.min(op.nMax, matches.length, stageCapacity),
          // Q265: カードの条件がない検索では、非公開領域でも指定枚数を選ぶ。
          pickMin: hiddenPickNeedsCardInfo(searchFilter, "deck")
            ? 0
            : Math.min(op.nMax, matches.length, stageCapacity),
          dest: op.dest,
          revealThenPick: op.revealThenPick,
          restTo: "none",
          from: "deck",
          // 「公開し」を伴わない検索は、加えたカードの名称を相手に見せない
          revealSelection: op.noReveal ? false : undefined,
          shuffleAfter: deferDeckShuffle ? undefined : "deck",
          // モーダルの案内表示とdistinctPick等の選択セット検証に使う
          pickFilter: searchFilter,
          pickGroups: searchGroups,
          sameNameGroups: op.sameNameGroups,
          targetFilter: searchTf,
          sameTarget: op.attachSameTarget,
          ctx,
        });
        return;
      }
      case "lookTop": {
        const zone =
          op.source === "deck"
            ? p.deck
            : op.source === "cheer"
              ? p.cheerDeck
              : p.holoPower;
        const baseN =
          op.nFrom === "oppHand"
            ? s.players[other(ctx.player)].hand.length
            : op.nFrom === "stageYell"
              ? stageYellCount(s, ctx.player)
              : op.n;
        // 「上から公開する枚数」の追加は、見る処理や他の領域には適用しない。
        const revealBonus =
          op.source === "deck" && op.revealAll ? revealCountBonus(s, ctx) : 0;
        const n = Math.min(baseN + revealBonus, zone.length);
        const top = zone.slice(0, n);
        ctx.revealed = [...top];
        ctx.revealedOwnerOnly = !op.revealAll;
        ctx.revealedOwner = ctx.player;
        ctx.revealedHistory = false;
        if (n === 0) {
          // Q751: 見る／加える処理ができなくても、本文末尾のシャッフルは必須。
          // 通常は選択プロンプトの解決時に行うが、0枚なら入力なしで実行する。
          if (op.rest === "shuffle")
            ctx.rest.unshift({
              t:
                op.source === "cheer"
                  ? "shuffleCheer"
                  : op.source === "holo"
                    ? "shuffleHolo"
                    : "shuffleDeck",
            });
          break;
        }
        const pickable = top.filter((u) =>
          cardMatchesFilter(s, ctx.player, u, op.pickFilter),
        );
        const sendable =
          op.pickDest === "cheerAssign"
            ? pickable.filter(
                (yellUid) =>
                  cheerAssignCapacity(s, {
                    type: "cheerAssign",
                    player: ctx.player,
                    yellUid,
                    reason: "effect",
                    ctx,
                    filter: op.pickTargetFilter,
                  }) > 0,
              ).length
            : pickable.length;
        const zoneName =
          op.source === "deck"
            ? "デッキ"
            : op.source === "cheer"
              ? "エールデッキ"
              : "ホロパワー";
        log(
          s,
          ctx.player,
          op.revealAll
            ? `${ctx.label}: ${zoneName}の上から${n}枚を公開しました (${top.map((uid) => cardLogLabel(s, uid)).join("、")})`
            : `${ctx.label}: ${zoneName}の上から${n}枚を見ています`,
        );
        // Q342/Q368: 条件付きの非公開検索は、該当カードがあっても選ばなくてよい。
        // 全公開、または単なる「カード1枚」は従来どおり可能な限り選ぶ。
        const requiredGroups = op.pickGroups?.filter(
          (group) =>
            op.revealAll || !hiddenPickNeedsCardInfo(group.filter, op.source),
        );
        const canSkipPick =
          !op.revealAll && hiddenPickNeedsCardInfo(op.pickFilter, op.source);
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: top,
          pickMin: requiredGroups
            ? maxGroupPick(s, ctx.player, pickable, requiredGroups)
            : canSkipPick
              ? 0
              : op.pickAllMatching
                ? pickable.length
                : Math.min(op.pickMin ?? 0, sendable),
          pickMax: Math.min(op.pickMax, pickable.length),
          pickFilter: op.pickFilter,
          pickGroups: op.pickGroups,
          dest: op.pickDest,
          revealSelection: op.revealPick ?? false,
          revealAll: op.revealAll,
          restTo: op.rest === "shuffle" ? "none" : op.rest,
          restOrder: op.restOrder,
          from:
            op.source === "deck"
              ? "deck"
              : op.source === "cheer"
                ? "cheer"
                : "holo",
          shuffleAfter: op.rest === "shuffle" ? op.source : undefined,
          targetFilter: op.pickTargetFilter,
          ctx,
        });
        return;
      }
      case "shuffleHolo":
        p.holoPower = shuffle(p.holoPower);
        break;
      case "archiveOppYell": {
        const oppP = s.players[other(ctx.player)];
        const uids = op.fromCenter
          ? (oppP.center?.yells ?? [])
          : allStacks(oppP).flatMap(({ stack }) => stack.yells);
        if (uids.length === 0) {
          log(s, ctx.player, `${ctx.label}: 相手のエールがありません`);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: [...uids],
          pickMin: Math.min(op.n, uids.length),
          pickMax: Math.min(op.n, uids.length),
          dest: "archive",
          restTo: "none",
          from: "stageYells",
          yellOwner: other(ctx.player),
          ctx,
        });
        return;
      }
      case "archiveHandAll": {
        const n = p.hand.length;
        if (
          offerHandArchiveReplacement(
            s,
            ctx,
            {
              t: "archiveHand",
              n,
              requireFullPayment: true,
              replacementChecked: op.replacementChecked,
            },
            { ...op, replacementChecked: true },
          )
        )
          return;
        ctx.milled = [...p.hand];
        p.archive.push(...p.hand);
        p.hand = [];
        log(
          s,
          ctx.player,
          `${ctx.label}: 手札${n}枚すべてをアーカイブしました`,
        );
        break;
      }
      case "handArchiveHolomenToDeckShuffle": {
        const handCount = p.hand.length;
        const archHolomen = p.archive.filter(
          (u) => cardOf(s, u).cardType === "holomen",
        );
        p.archive = p.archive.filter(
          (u) => cardOf(s, u).cardType !== "holomen",
        );
        p.deck.push(...p.hand, ...archHolomen);
        p.hand = [];
        p.deck = shuffle(p.deck);
        const counts = ctx.returnedBoth ?? [0, 0];
        counts[ctx.player] = handCount;
        ctx.returnedBoth = counts;
        log(
          s,
          ctx.player,
          `手札${handCount}枚とアーカイブのホロメン${archHolomen.length}枚をデッキに戻してシャッフルしました`,
        );
        break;
      }
      case "revealOppHand": {
        const oppP = s.players[other(ctx.player)];
        const names = oppP.hand.map((u) => cardLogLabel(s, u)).join("、");
        // 「その中に〜があるなら」を後続の条件が参照できるようにする
        // (記録していないと revealedSome が常に false になる)
        ctx.revealed = [...oppP.hand];
        ctx.revealedOwnerOnly = true;
        ctx.revealedOwner = ctx.player;
        ctx.revealedHistory = true;
        logPrivate(
          s,
          ctx.player,
          `${ctx.label}: 相手の手札を見ました (${oppP.hand.length}枚: ${names || "なし"})`,
          `${ctx.label}: 相手の手札${oppP.hand.length}枚を確認しました`,
        );
        break;
      }
      case "drawPerBothStageYell": {
        let yells = 0;
        for (const pid of [0, 1] as PlayerId[])
          for (const { stack } of allStacks(s.players[pid]))
            yells += stack.yells.length;
        const total = Math.floor(yells / op.per) * op.draw;
        let drawn = 0;
        for (let i = 0; i < total && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: お互いのエール${yells}枚分、${drawn}枚ドローしました`,
          drawn,
        );
        break;
      }
      case "drawPerOppCenterBaton": {
        const oppCenter = s.players[other(ctx.player)].center;
        const baton = oppCenter ? batonCostOf(s, oppCenter) : 0;
        const total = Math.floor(baton / op.per) * op.draw;
        let drawn = 0;
        for (let i = 0; i < total && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: 相手センターのバトンコスト${baton}個分、${drawn}枚ドローしました`,
          drawn,
        );
        break;
      }
      case "specialPerArtTargetBaton": {
        const target = ctx.artTargetStackId
          ? findStackById(s, ctx.artTargetStackId)
          : null;
        if (!target) {
          log(
            s,
            ctx.player,
            `${ctx.label}: アーツの対象がいないため効果は発揮されません`,
          );
          break;
        }
        const baton = batonCostOf(s, target.stack);
        const dmg = Math.floor(baton / op.per) * op.dmg;
        applyToStack(s, ctx, target, { t: "special", dmg });
        break;
      }
      case "healSelfPerArtDealt": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        if (!src) break;
        const dealt = ctx.lastArtDealt ?? 0;
        const value = Math.floor(dealt / op.per) * op.heal;
        if (value <= 0) break;
        applyToStack(s, ctx, src, { t: "heal", value });
        break;
      }
      case "drawPerOppOshiDiff": {
        const cnt = allStacks(s.players[other(ctx.player)]).filter(
          ({ stack }) => hasDiffColorFromOwnerOshi(s, stack),
        ).length;
        const total = Math.floor(cnt / op.per) * op.draw;
        let drawn = 0;
        for (let i = 0; i < total && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: 相手の推しと異なる色のホロメン${cnt}人分、${drawn}枚ドローしました`,
          drawn,
        );
        break;
      }
      case "drawPerHandReturned": {
        const returned = (ctx.returnedBoth ?? [0, 0])[ctx.player];
        const total = Math.floor(returned / op.per) * op.draw;
        let drawn = 0;
        for (let i = 0; i < total && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: 手札から戻した${returned}枚分、${drawn}枚ドローしました`,
          drawn,
        );
        break;
      }
      case "bothHandToDeckBottom": {
        const counts: [number, number] = [0, 0];
        for (const pid of [0, 1] as PlayerId[]) {
          const pp = s.players[pid];
          counts[pid] = pp.hand.length;
        }
        ctx.returnedBoth = counts;
        const participants = (
          [ctx.player, other(ctx.player)] as PlayerId[]
        ).filter((pid) => counts[pid] > 0);
        if (participants.length === 0) break;
        participants.forEach((pid, index) => {
          const emptyCtx: EffectContextData = { ...ctx, rest: [] };
          pushPrompt(s, {
            type: "effectPickCard",
            player: pid,
            uids: [...s.players[pid].hand],
            pickMin: counts[pid],
            pickMax: counts[pid],
            dest: "deckBottom",
            restTo: "none",
            from: "hand",
            orderMatters: true,
            orderLabel: "手札をデッキの下へ置く順に選んでください",
            ctx: index === participants.length - 1 ? ctx : emptyCtx,
          });
        });
        return;
      }
      case "bothDrawPerReturned": {
        const counts = ctx.returnedBoth ?? [0, 0];
        for (const pid of [0, 1] as PlayerId[]) {
          const pp = s.players[pid];
          const total = Math.floor(counts[pid] / op.per) * op.draw;
          let drawn = 0;
          for (let i = 0; i < total && pp.deck.length > 0; i++) {
            pp.hand.push(pp.deck.shift()!);
            drawn++;
          }
          logDraw(
            s,
            pid,
            `デッキに戻した${counts[pid]}枚分、${drawn}枚ドローしました`,
            drawn,
          );
        }
        break;
      }
      case "drawPerMilled": {
        const count = Math.floor((ctx.milled ?? []).length / op.per) * op.draw;
        let drawn = 0;
        for (let i = 0; i < count && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: アーカイブした${(ctx.milled ?? []).length}枚分、${drawn}枚ドローしました`,
          drawn,
        );
        break;
      }
      case "drawPerAttachedName": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        const attached = src
          ? src.stack.supports.filter((u) => cardHasName(s, u, op.names)).length
          : 0;
        const count = Math.floor(attached / op.per) * op.draw;
        let drawn = 0;
        for (let i = 0; i < count && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: 付いている${op.names.join("/")}${attached}枚分、${drawn}枚ドローしました`,
          drawn,
        );
        break;
      }
      case "handToDeckBottomNamed": {
        const eligible = p.hand.filter((u) => cardHasName(s, u, op.names));
        if (eligible.length < op.n) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 手札に対象カードが足りずコストを支払えません`,
          );
          abortEffectRest(ctx);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: eligible,
          pickMin: op.n,
          pickMax: op.n,
          dest: "deckBottom",
          revealSelection: true,
          restTo: "none",
          from: "hand",
          ctx,
        });
        return;
      }
      case "handRevealToDeckBottom": {
        const eligible = p.hand.filter((u) =>
          cardMatchesFilter(s, ctx.player, u, op.filter),
        );
        if (eligible.length < op.n) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 手札に対象カードがないため効果は発揮されません`,
          );
          abortEffectRest(ctx);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: eligible,
          pickMin: op.n,
          pickMax: op.n,
          dest: "deckBottom",
          revealSelection: true,
          restTo: "none",
          from: "hand",
          ctx,
        });
        return;
      }
      case "stackedToHand": {
        const bound = ctx.boundStackId
          ? findStackById(s, ctx.boundStackId)
          : null;
        const stacked = bound ? bound.stack.cards.slice(1) : [];
        if (stacked.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 重なっているホロメンがいないため効果は発揮されません`,
          );
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: stacked,
          pickMin: Math.min(op.min, stacked.length),
          pickMax: Math.min(op.max, stacked.length),
          dest: "hand",
          restTo: "none",
          from: "stacked",
          ctx,
        });
        return;
      }
      case "backToDeckBottom": {
        const candidates = p.back.filter(
          (stack) => !op.filter || stackMatchesFilter(s, stack, op.filter),
        );
        if (op.cost && candidates.length < op.n) {
          log(
            s,
            ctx.player,
            `${ctx.label}: バックに対象ホロメンがおらずコストを支払えません`,
          );
          abortEffectRest(ctx);
          break;
        }
        // 1.3.2: 必須の帰還が不可能でも、独立した後続の強化は解決する。
        const count = Math.min(op.n, candidates.length);
        if (count <= 0) break;
        pushPrompt(s, {
          type: "effectTarget",
          player: ctx.player,
          target: "chooseOwnBack",
          count,
          filter: op.filter,
          apply: { t: "toDeckBottom" },
          chosen: [],
          ctx,
        });
        return;
      }
      case "oppYellToCheerBottom": {
        const oppP = s.players[other(ctx.player)];
        const uids =
          op.scope === "center"
            ? [...(oppP.center?.yells ?? [])]
            : op.scope === "collab"
              ? [...(oppP.collab?.yells ?? [])]
              : op.scope === "front"
                ? [...(oppP.center?.yells ?? []), ...(oppP.collab?.yells ?? [])]
                : allStacks(oppP).flatMap(({ stack }) => stack.yells);
        if (uids.length === 0) {
          log(s, ctx.player, `${ctx.label}: 対象のエールがありません`);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids,
          pickMin: Math.min(op.n, uids.length),
          pickMax: Math.min(op.n, uids.length),
          dest: "cheerDeck",
          restTo: "none",
          from: "stageYells",
          yellOwner: other(ctx.player),
          ctx,
        });
        return;
      }
      case "oppFrontYellsToCheerBottom": {
        const opponent = other(ctx.player);
        const oppP = s.players[opponent];
        const centerYells = [...(oppP.center?.yells ?? [])];
        const collabYells = [...(oppP.collab?.yells ?? [])];
        const centerPick = Math.min(op.nEach, centerYells.length);
        const collabPick = Math.min(op.nEach, collabYells.length);
        const total = centerPick + collabPick;
        if (total === 0) {
          log(s, ctx.player, `${ctx.label}: 対象のエールがありません`);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: [...centerYells, ...collabYells],
          pickMin: total,
          pickMax: total,
          uidPickGroups: [
            {
              uids: centerYells,
              pickMin: centerPick,
              pickMax: centerPick,
            },
            {
              uids: collabYells,
              pickMin: collabPick,
              pickMax: collabPick,
            },
          ],
          dest: "cheerDeck",
          restTo: "none",
          from: "stageYells",
          yellOwner: opponent,
          orderMatters: true,
          orderLabel:
            "センターとコラボから各指定枚数を、エールデッキの下へ置く順に選んでください",
          ctx,
        });
        return;
      }
      case "oppArchiveYellToOppCenter": {
        const oppP = s.players[other(ctx.player)];
        const yells = oppP.archive.filter(
          (uid) => cardOf(s, uid).cardType === "yell",
        );
        if (yells.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 相手のアーカイブにエールがありません`,
          );
          break;
        }
        if (!oppP.center) {
          log(s, ctx.player, `${ctx.label}: 相手のセンターホロメンがいません`);
          break;
        }
        const pick = Math.min(op.n, yells.length);
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: yells,
          pickMin: pick,
          pickMax: pick,
          dest: "cheerAssign",
          restTo: "none",
          from: "archive",
          archiveOwner: other(ctx.player),
          cheerTargetPlayer: other(ctx.player),
          targetFilter: { position: "center" },
          ctx,
        });
        return;
      }
      case "lifeMinus": {
        loseLife(s, ctx.player, op.n, ctx);
        break;
      }
      case "oppLifeMinus": {
        loseLifeByOppAbility(s, other(ctx.player), op.n, ctx);
        break;
      }
      case "artDiceParityBranch": {
        const sum = ctx.artDiceSum ?? 0;
        const odd = sum % 2 === 1;
        log(
          s,
          ctx.player,
          `そのアーツで振った出た目の合計は${sum} (${odd ? "奇数" : "偶数"})`,
        );
        ctx.rest.unshift(
          ...(structuredClone(odd ? op.oddOps : op.evenOps) as Op[]),
        );
        break;
      }
      case "lifeImmuneFromOpp": {
        (s.lifeImmuneFromOppTurn ??= [0, 0])[ctx.player] = s.turn;
        log(
          s,
          ctx.player,
          "このターンの間、自分のライフは相手の能力で減らなくなりました",
        );
        break;
      }
      case "resume": {
        // 中断していた別ctx (保留したアーツダメージ等) の実行を再開する
        runOps(s, op.inner);
        break;
      }
      case "continueRuleProcessing": {
        // アーツ後の誘発を収集し終えてから、再開コンテキストをルール処理へ渡す。
        // 渡した同じctxを演出待ちでも進めると、JSON復元で共有参照が切れて分岐する。
        if (!s.ruleResolution || ctx.pendingRuleCauses)
          beginRuleProcessing(s, ctx);
        if (s.ruleResolution) {
          // ダウン中のスキルやライフ送付で誘発した能力は、ルール処理後に解決する。
          if (
            (ctx.downedStackId !== undefined || op.deferTriggers) &&
            ctx.pendingTriggers?.length
          ) {
            (s.ruleResolution.resume.pendingTriggers ??= []).push(
              ...ctx.pendingTriggers,
            );
            ctx.pendingTriggers = undefined;
          }
          continueRuleProcessing(s);
          return;
        }
        break;
      }
      case "checkRuleTiming": {
        const pending = [
          ...(ctx.pendingTriggers ?? []),
          ...takeScheduledTriggerGroups(ctx),
        ];
        ctx.pendingTriggers = undefined;
        // 10.6.3: ルール処理を終えてから、ターンプレイヤーの自動能力を先に解決。
        for (const player of [other(s.turnPlayer), s.turnPlayer]) {
          const abilities = pending
            .filter((group) => group.player === player)
            .flatMap((group) => group.abilities);
          if (abilities.length)
            ctx.rest.unshift({ t: "runTriggerAbilities", player, abilities });
        }
        beginRuleProcessing(s, ctx);
        if (s.ruleResolution) {
          continueRuleProcessing(s);
          return;
        }
        break;
      }
      case "finishPerformanceStep": {
        ctx.rest.unshift(...performanceEndOps(s));
        break;
      }
      case "beginEndStep": {
        beginEndStep(s, ctx);
        break;
      }
      case "offerReactiveSkill": {
        const cost = reactiveSkillPlayableCost(s, ctx.player, op);
        if (cost === null) break;
        // 自動能力用の独立コンテキストで、特殊ダメージの発生源を推しにする。
        ctx.originOshiSkill = { name: op.skillName, sp: op.sp };
        pushPrompt(s, {
          type: "reactiveSkill",
          player: ctx.player,
          sp: op.sp,
          skillName: op.skillName,
          description: op.description,
          cost,
          kind: "ops",
          ops: op.ops,
          ctx,
        });
        return;
      }
      case "enforceSupportLimits": {
        const entry = findStackById(s, op.stackId);
        if (!entry) break;
        const wearerNames = stackNames(s, entry.stack);
        const invalid = entry.stack.supports.filter((uid) => {
          const c = cardOf(s, uid);
          if (c.cardType !== "support") return false;
          const allowed = passiveOf(c).attachOnlyNames;
          return (
            !!allowed && !allowed.some((name) => wearerNames.includes(name))
          );
        });
        if (invalid.length > 0) {
          entry.stack.supports = entry.stack.supports.filter(
            (uid) => !invalid.includes(uid),
          );
          s.players[entry.player].archive.push(...invalid);
          log(
            s,
            entry.player,
            `${invalid.map((uid) => cardOf(s, uid).name).join("、")}は付与条件を満たさなくなったためアーカイブしました`,
          );
        }
        const gift = giftOf(topCard(s, entry.stack));
        for (const kind of ["マスコット", "ツール", "ファン"] as const) {
          let limit =
            gift.supportLimits?.[kind] ??
            (kind === "ファン" ? Number.POSITIVE_INFINITY : 1);
          const candidates = entry.stack.supports.filter((uid) => {
            const c = cardOf(s, uid);
            return c.cardType === "support" && c.supportType === kind;
          });
          if (
            kind === "ツール" &&
            gift.extraToolTag &&
            candidates.some((uid) =>
              (cardOf(s, uid) as SupportCard).tags.includes(gift.extraToolTag!),
            )
          )
            limit = 2;
          // 追加枠は指定タグのツール1枚分。通常枠のツールを2枚残せない。
          const ordinary =
            kind === "ツール" && gift.extraToolTag
              ? candidates.filter(
                  (uid) =>
                    !(cardOf(s, uid) as SupportCard).tags.includes(
                      gift.extraToolTag!,
                    ),
                )
              : [];
          if (ordinary.length > 1) {
            ctx.rest.unshift({
              t: "enforceSupportLimits",
              stackId: op.stackId,
            });
            pushPrompt(s, {
              type: "effectPickCard",
              player: entry.player,
              from: "stageSupports",
              uids: ordinary,
              pickMin: ordinary.length - 1,
              pickMax: ordinary.length - 1,
              dest: "archive",
              restTo: "none",
              supportOwner: entry.player,
              ctx,
            });
            return;
          }
          if (candidates.length <= limit) continue;
          ctx.rest.unshift({ t: "enforceSupportLimits", stackId: op.stackId });
          pushPrompt(s, {
            type: "effectPickCard",
            player: entry.player,
            from: "stageSupports",
            uids: candidates,
            pickMin: candidates.length - limit,
            pickMax: candidates.length - limit,
            dest: "archive",
            restTo: "none",
            supportOwner: entry.player,
            ctx,
          });
          return;
        }
        break;
      }
      case "runTriggerAbilities": {
        if (op.abilities.length === 0) break;
        if (op.defer) {
          (ctx.pendingTriggers ??= []).push({
            player: op.player,
            abilities: captureTriggerContexts(ctx, op.abilities),
            label: op.label,
          });
          break;
        }
        if (op.player === ctx.player) {
          ctx.rest.unshift({
            t: "continueTriggerAbilities",
            abilities: op.abilities,
          });
          break;
        }
        runOps(s, {
          player: op.player,
          rest: [
            { t: "continueTriggerAbilities", abilities: op.abilities },
            { t: "resume", inner: ctx },
          ],
          label: op.label ?? "誘発能力",
        });
        return;
      }
      case "continueTriggerAbilities": {
        if (op.abilities.length === 0) break;
        const playable = op.abilities.filter((ability) => {
          const offer = ability.ops[0];
          return (
            offer?.t !== "offerReactiveSkill" ||
            reactiveSkillPlayableCost(s, ctx.player, offer) !== null
          );
        });
        if (playable.length === 0) break;
        const blocked = op.abilities.filter(
          (ability) => !playable.includes(ability),
        );
        // 今は支払えなくても、先に解決する能力で支払えるようになる場合がある。
        if (blocked.length)
          ctx.rest.unshift({
            t: "continueTriggerAbilities",
            abilities: blocked,
          });
        if (playable.length === 1) {
          runTriggerAbility(s, ctx, playable[0]);
          return;
        }
        // 同じ能力でも、別の事象で誘発した待機は別々に選ぶ。
        // 入れ子の解決から同じIDが合流した場合だけ、選択肢ごとに区別する。
        const distinctIds = new Set(playable.map((ability) => ability.id));
        const choices =
          distinctIds.size === playable.length
            ? playable
            : playable.map((ability, index) => ({
                ...ability,
                id: `${ability.id}:pending:${index}`,
              }));
        pushPrompt(s, {
          type: "triggerAbilityChoice",
          player: ctx.player,
          abilities: choices,
          ctx,
        });
        return;
      }
      case "declareDice": {
        pushPrompt(s, { type: "declareDice", player: ctx.player, ctx });
        return;
      }
      case "turnBackSpecialImmune": {
        for (const st of p.back)
          s.turnModifiers.push({
            stackId: st.id,
            artPlus: 0,
            specialImmune: true,
            expiresTurn: s.turn,
          });
        log(
          s,
          ctx.player,
          `${ctx.label}: このターン、自分のバック全員は特殊ダメージを受けません`,
        );
        break;
      }
      case "finishSpecialDamageBatch": {
        const hits = ctx.specialDamageBatch ?? [];
        ctx.specialDamageBatch = undefined;
        // 全対象のHPを同時に変動させてからダウン判定・誘発能力へ進む。
        for (const hit of hits) {
          const target = findStackById(s, hit.targetStackId);
          if (!target) continue;
          // 後の対象の確認で全員防護を使った場合も、まだ未適用の同時ダメージへ反映する。
          // 防御確認の順番で「全員」の適用範囲を変えない (5.22.4)。
          if (isSpecialImmune(s, target, ctx.player)) hit.damage = 0;
          target.stack.damage += hit.damage;
        }
        // Q752: 「相手のホロメン1人に」は、同時に実ダメージが通った人数で判定する。
        // 防護・軽減で0になった相手と、自分へのダメージは人数へ含めない。
        const opponentTargetCount = new Set(
          hits
            .filter(
              (hit) =>
                hit.damage > 0 &&
                findStackById(s, hit.targetStackId)?.player ===
                  other(ctx.player),
            )
            .map((hit) => hit.targetStackId),
        ).size;
        // 全対象の被ダメージ時能力を、最初のダウンで発生源が消える前に収集する。
        for (const hit of hits) {
          const target = findStackById(s, hit.targetStackId);
          if (target)
            recordSpecialDamage(
              s,
              ctx,
              target,
              hit.damage,
              hit.noLife,
              opponentTargetCount,
            );
        }
        break;
      }
      case "specialToStack": {
        const target = findStackById(s, op.targetStackId);
        if (target)
          applyToStack(s, ctx, target, {
            t: "special",
            dmg: op.dmg,
            noLife: op.noLife,
            interruptChecked: op.interruptChecked,
            extraReduce: op.extraReduce,
            negate: op.negate,
            diceReduceDone: op.diceReduceDone,
            replacementDone: op.replacementDone,
          });
        break;
      }
      case "forceDiceResult": {
        const d = ctx.rest.find((o) => o.t === "dice");
        if (d && d.t === "dice") {
          if (d.pendingRolls) d.pendingRolls[op.index ?? 0] = op.value;
          else d.forcedRoll = op.value;
          // まつりすを複数枚付けていれば、残りのファンでも別の出目を変更できる。
          d.rerollsFinished = true;
          log(
            s,
            ctx.player,
            `${ctx.label}: サイコロの目1つを【${op.value}】として扱います`,
          );
        }
        break;
      }
      case "applyDiceModifier": {
        const dice = ctx.rest.find((o): o is DiceOp => o.t === "dice");
        if (dice) applyPendingDiceModifier(s, ctx, dice, op.index);
        break;
      }
      case "skipDiceFan": {
        const dice = ctx.rest.find((o): o is DiceOp => o.t === "dice");
        if (dice) (dice.declinedDiceFans ??= []).push(op.uid);
        log(s, ctx.player, `「${cardOf(s, op.uid).name}」の使用を見送りました`);
        break;
      }
      case "recoverRevealedSupport": {
        const eligible = (ctx.revealed ?? []).filter((uid) => {
          const c = cardOf(s, uid);
          return c.cardType === "support" && p.deck.includes(uid);
        });
        if (eligible.length === 0) break;
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: eligible,
          pickMin: 0,
          pickMax: 1,
          dest: "hand",
          restTo: "none",
          from: "deck",
          ctx,
        });
        return;
      }
      case "rerollDice": {
        // 保留中のサイコロ (forcedRoll付きdice) をクリアして振り直させる
        const d = ctx.rest.find((o) => o.t === "dice");
        if (
          d &&
          d.t === "dice" &&
          (d.forcedRoll !== undefined || d.pendingRolls !== undefined)
        ) {
          d.forcedRoll = undefined;
          d.pendingRolls = undefined;
          d.rollCounted = true;
          d.rerollChecked = false; // 振り直し後の出目にも再度リアクティブ(別ファン等)を許可
          d.animationWaited = false;
          log(s, ctx.player, `${ctx.label}: サイコロを振り直します`);
        }
        break;
      }
      case "turnArtPlusAttachedTo": {
        const entry =
          ctx.attachedToStackId !== undefined
            ? findStackById(s, ctx.attachedToStackId)
            : null;
        if (!entry) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 付けた先のホロメンがいないため効果なし`,
          );
          break;
        }
        applyToStack(s, ctx, entry, { t: "turnArtPlus", value: op.value });
        break;
      }
      case "redirectDamage": {
        // 保留中のアーツダメージ (resume内) の対象を bound に付け替える (身代わり)
        const resumeOp = ctx.rest.find((o) => o.t === "resume");
        const boundId = ctx.boundStackId;
        if (resumeOp && resumeOp.t === "resume" && boundId !== undefined) {
          const ad = resumeOp.inner.rest.find((o) => o.t === "artDamage");
          const bound = findStackById(s, boundId);
          if (ad && ad.t === "artDamage" && bound) {
            ad.originalTargetStackId ??= ad.targetStackId;
            ad.targetStackId = boundId;
            log(
              s,
              ctx.player,
              `${ctx.label}: ダメージは${positionedHolomenName(s, bound.pos, bound.stack)}がかわりに受けます`,
            );
          }
        }
        break;
      }
      case "reduceReceivedDamage": {
        // 保留中のダメージ (resume内) の被ダメージを軽減する。
        // アーツダメージと特殊ダメージの両方が対象 (公式Q158)
        const resumeOp = ctx.rest.find((o) => o.t === "resume");
        if (resumeOp && resumeOp.t === "resume") {
          const pending = resumeOp.inner.rest.find(
            (o) => o.t === "artDamage" || o.t === "specialToStack",
          );
          if (
            pending &&
            (pending.t === "artDamage" || pending.t === "specialToStack")
          ) {
            if (op.negate) {
              pending.negate = true;
              pending.interruptChecked = false;
              log(s, ctx.player, `${ctx.label}: そのダメージを受けません`);
            } else {
              pending.extraReduce = (pending.extraReduce ?? 0) + op.value;
              // 別の付与サポートによる追加軽減を許可
              pending.interruptChecked = false;
              log(s, ctx.player, `${ctx.label}: 受けるダメージ-${op.value}`);
            }
          }
        }
        break;
      }
      case "markGiftUsed":
      case "markTriggerUsed": {
        s.usedTriggersThisTurn[op.key] =
          (s.usedTriggersThisTurn[op.key] ?? 0) + 1;
        break;
      }
      case "swapCollabBack": {
        const collab = p.collab;
        if (!collab || !stackMatchesFilter(s, collab, op.collabFilter)) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象のコラボホロメンがいないため効果は発揮されません`,
          );
          break;
        }
        const backs = p.back
          .map((stack, i) => ({
            player: ctx.player,
            pos: { back: i } as StagePosition,
            stack,
          }))
          .filter((e) => stackMatchesFilter(s, e.stack, op.backFilter));
        if (backs.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 交代できるバックホロメンがいないため効果は発揮されません`,
          );
          break;
        }
        if (backs.length === 1) {
          applyToStack(s, ctx, backs[0], { t: "swapCollab" });
          break;
        }
        pushPrompt(s, {
          type: "effectTarget",
          player: ctx.player,
          target: "chooseOwnBack",
          count: 1,
          filter: op.backFilter,
          apply: { t: "swapCollab" },
          chosen: [],
          ctx,
        });
        return;
      }
      case "lifeLossMinus": {
        // ギフトと推しスキルは同じ保留中のダウンライフを減らす。
        // 全てのダウン時能力が終わるまでライフダメージを確定しない。
        const current = s.ruleResolution?.current;
        if (
          current &&
          !current.lifeAccounted &&
          current.player === ctx.player &&
          current.stackId === ctx.downedStackId &&
          current.lifeLoss > 0
        ) {
          const cut = Math.min(op.n, current.lifeLoss);
          current.lifeLoss -= cut;
          log(s, ctx.player, `${ctx.label}: 減るライフ-${cut}`);
        } else {
          log(s, ctx.player, `${ctx.label}: 減るライフがないため効果なし`);
        }
        break;
      }
      case "downedYellMove": {
        const live = ctx.downedStackId
          ? findStackById(s, ctx.downedStackId)
          : null;
        // 先に解決したダウン時能力で新たに送ったエールも選べる。
        // 付け替えはステージ上の移動なので、保持者が離れた後の
        // アーカイブや、既に付け替えたエールは候補に含めない (5.17.4)。
        const yells = live
          ? live.stack.yells.filter((u) => {
              const c = cardOf(s, u);
              if (c.cardType !== "yell") return false;
              if (!op.color) return true;
              return yellOnIs(s, live.stack, u, op.color);
            })
          : [];
        const hasTarget = allStacks(p).some(
          ({ stack }) => stack.id !== ctx.downedStackId,
        );
        if (yells.length === 0 || !hasTarget) {
          log(s, ctx.player, `${ctx.label}: 付け替える対象がないため効果なし`);
          break;
        }
        const n = op.n === "all" ? yells.length : Math.min(op.n, yells.length);
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: yells,
          pickMin: Math.min(op.min ?? n, n),
          pickMax: n,
          dest: "cheerAssign",
          restTo: "none",
          from: "downed",
          ctx,
        });
        return;
      }
      case "downedToHand": {
        const pool =
          op.what === "holomen" ? ctx.downedCards : ctx.downedSupports;
        const live = ctx.downedStackId
          ? findStackById(s, ctx.downedStackId)
          : null;
        const uids = (pool ?? []).filter((u) => {
          const available = live
            ? live.stack.cards.includes(u) || live.stack.supports.includes(u)
            : p.archive.includes(u);
          if (!available) return false;
          if (op.what === "fan") {
            const c = cardOf(s, u);
            return (
              c.cardType === "support" &&
              (c as SupportCard).supportType === "ファン"
            );
          }
          if (op.what === "support") {
            const c = cardOf(s, u);
            return (
              c.cardType === "support" &&
              (!op.filter || cardMatchesFilter(s, ctx.player, u, op.filter))
            );
          }
          return true;
        });
        if (uids.length === 0) {
          log(s, ctx.player, `${ctx.label}: 手札に戻す対象がないため効果なし`);
          break;
        }
        const n = op.n === "all" ? uids.length : Math.min(op.n, uids.length);
        if (n >= uids.length) {
          const yellAbilities =
            live &&
            live.stack.yells.length > 0 &&
            live.stack.cards.every((u) => uids.includes(u))
              ? collectYellArchivedTriggerAbilities(s, live.player)
              : [];
          if (live) rememberHolomen(s, live.player, live.pos, live.stack);
          for (const u of uids) {
            if (live) {
              // まだ場にあるスタックから戻す場合は取り除いてから手札へ入れる
              live.stack.cards = live.stack.cards.filter((x) => x !== u);
              live.stack.supports = live.stack.supports.filter((x) => x !== u);
            } else {
              const i = p.archive.indexOf(u);
              if (i >= 0) p.archive.splice(i, 1);
            }
            p.hand.push(u);
          }
          if (live) dropIfEmptyStack(s, live.stack.id, ctx, yellAbilities);
          log(
            s,
            ctx.player,
            `${ctx.label}: ${uids.map((u) => cardOf(s, u).name).join("、")}を手札に戻しました`,
          );
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids,
          pickMin: n,
          pickMax: n,
          dest: "hand",
          restTo: "none",
          from: live ? "downed" : "archive",
          ctx,
        });
        return;
      }
      case "restSelf": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        if (src) {
          src.stack.resting = true;
          log(
            s,
            ctx.player,
            `${positionedHolomenName(s, src.pos, src.stack)}をお休みさせました`,
          );
        }
        break;
      }
      case "drawPerStageTag": {
        const entries = allStacks(p).filter(({ stack }) =>
          topCard(s, stack).tags.includes(op.tag),
        );
        const count = op.distinct
          ? distinctHolomenNameCount(
              s,
              entries.map(({ stack }) => stack),
            )
          : entries.length;
        const total = count * op.draw;
        let drawn = 0;
        for (let i = 0; i < total && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        if (drawn > 0)
          logDraw(
            s,
            ctx.player,
            `${ctx.label}: #${op.tag}持ち${count}人分、${drawn}枚ドローしました`,
            drawn,
          );
        break;
      }
      case "turnArtPlusPerBoundYell": {
        const b = ctx.boundStackId ? findStackById(s, ctx.boundStackId) : null;
        if (!b) break;
        const counted = Math.min(
          b.stack.yells.length,
          op.max ?? Number.POSITIVE_INFINITY,
        );
        const add = op.value * counted;
        if (add > 0) {
          s.turnModifiers.push({ stackId: b.stack.id, artPlus: add });
          log(
            s,
            ctx.player,
            `このターンの間、${positionedHolomenName(s, b.pos, b.stack)}のアーツ+${add} (エール${counted}枚分)`,
          );
        }
        break;
      }
      case "handToHoloPower": {
        if (p.hand.length === 0) break;
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: [...p.hand],
          pickMin: Math.min(op.n, p.hand.length),
          pickMax: Math.min(op.n, p.hand.length),
          dest: "holoPower",
          restTo: "none",
          from: "hand",
          ctx,
        });
        return;
      }
      case "archiveSelfYell": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        if (!src) break;
        // 「アーカイブするエール1枚のかわりに、この付与サポートをアーカイブできる」肩代わり (SSRB/おかにゃん)
        if (!op.all && op.n > 0) {
          const skip = op.subSkipUids ?? [];
          for (const uid of src.stack.supports) {
            if (skip.includes(uid)) continue;
            const sc = cardOf(s, uid);
            if (sc.cardType !== "support") continue;
            const pb = passiveOf(sc);
            if (!pb.yellArchiveSub) continue;
            if (
              pb.yellArchiveSub.requiresCond &&
              !passiveCondMatches(s, src.stack, pb.cond)
            )
              continue;
            // 色指定(おかにゃん=青)がある肩代わりは、その色のエールをアーカイブする時のみ有効
            if (pb.yellArchiveSub.color) {
              const subColor = pb.yellArchiveSub.color;
              const archivesThatColor =
                op.color === subColor ||
                op.colors?.includes(subColor) ||
                (!op.color &&
                  !op.colors &&
                  op.excludeColor !== subColor &&
                  src.stack.yells.some((u) =>
                    yellOnIs(s, src.stack, u, subColor),
                  ));
              if (!archivesThatColor) continue;
            }
            pushPrompt(s, {
              type: "effectConfirm",
              player: ctx.player,
              label: `「${sc.name}」をアーカイブしてエール1枚分のコストにしますか？`,
              thenOps: [
                { t: "setSource", stackId: src.stack.id, supportUid: uid },
                { t: "archiveSelfSupport" },
                { t: "setSource", stackId: src.stack.id },
                { ...op, n: op.n - 1, subSkipUids: [...skip] },
              ],
              elseOps: [{ ...op, subSkipUids: [...skip, uid] }],
              ctx,
            });
            return;
          }
        }
        const matching = src.stack.yells.filter((u) => {
          const cols = yellColorsOn(s, src.stack, u);
          if (op.excludeColor) return !cols.includes(op.excludeColor);
          if (op.colors) return op.colors.some((c) => cols.includes(c));
          return !op.color || cols.includes(op.color);
        });
        if (!op.all && matching.length < op.n) {
          log(s, ctx.player, `${ctx.label}: アーカイブするエールが足りません`);
          // コスト不払い: 以降の効果は実行しない
          abortEffectRest(ctx);
          break;
        }
        if (!op.all && op.n > 0 && matching.length > op.n) {
          pushPrompt(s, {
            type: "effectPickCard",
            player: ctx.player,
            uids: matching,
            pickMin: op.n,
            pickMax: op.n,
            dest: "archive",
            restTo: "none",
            from: "stageYells",
            ctx,
          });
          return;
        }
        const pay = op.all ? matching : matching.slice(0, op.n);
        src.stack.yells = src.stack.yells.filter((u) => !pay.includes(u));
        p.archive.push(...pay);
        if (pay.length > 0) {
          s.stageYellArchivedThisTurn[ctx.player] = true;
          queueYellArchivedReactive(s, ctx, pay);
          ctx.rest.unshift(...collectYellArchivedTriggerOps(s, ctx.player));
        }
        log(
          s,
          ctx.player,
          `${ctx.label}: エール${pay.length}枚をアーカイブしました`,
        );
        break;
      }
      case "archiveSelfYellAny": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        const uids = src ? [...src.stack.yells] : [];
        if (uids.length < (op.min ?? 1)) {
          log(
            s,
            ctx.player,
            `${ctx.label}: エールがないためコストを支払えません`,
          );
          abortEffectRest(ctx);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids,
          pickMin: op.min ?? 1,
          pickMax: Math.min(op.max ?? uids.length, uids.length),
          dest: "archive",
          restTo: "none",
          from: "stageYells",
          ctx,
        });
        return;
      }
      case "oppHoloPowerToHand": {
        const oppP = s.players[other(ctx.player)];
        const n = Math.min(op.n, oppP.holoPower.length);
        oppP.hand.push(...oppP.holoPower.splice(0, n));
        log(
          s,
          ctx.player,
          `${ctx.label}: 相手はホロパワーの上から${n}枚を手札に加えました`,
        );
        break;
      }
      case "cheerFromTopPerOverkill": {
        const total = Math.floor((ctx.lastOverkill ?? 0) / op.per) * op.n;
        if (total <= 0) {
          log(s, ctx.player, `${ctx.label}: オーバーしたダメージが足りません`);
          break;
        }
        ctx.rest.unshift({
          t: "cheerFromTop",
          n: total,
          target: op.target,
          filter: op.filter,
          sameTarget: op.sameTarget,
        });
        break;
      }
      case "turnCostModPerUsedEvent": {
        const used = op.tag
          ? (s.usedSupportTagTypesThisTurn[ctx.player] ?? []).filter(
              (e) => e === `${op.tag}|イベント`,
            ).length
          : (s.usedSupportTypesThisTurn[ctx.player] ?? []).filter(
              (k) => k === "イベント",
            ).length;
        const total = Math.floor(used / op.per) * op.costless;
        if (total <= 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象のイベントを使っていないため効果なし`,
          );
          break;
        }
        ctx.rest.unshift({
          t: "turnCostMod",
          target: op.target,
          count: op.count,
          filter: op.filter,
          artCostless: total,
        });
        break;
      }
      case "archiveStacked": {
        // 先頭(現在のホロメン)を除いた重なりカードから、支払うカードを選ぶ
        const candidates = stackedCostCandidates(s, ctx, op);
        const stacked = candidates.map(({ uid }) => uid);
        const required = op.all ? stacked.length : op.n;
        if (required < 1 || stacked.length < required) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 重なっている${op.level ?? ""}ホロメンが足りません`,
          );
          abortEffectRest(ctx);
          break;
        }
        if (stacked.length === required) {
          for (const { stack, uid } of candidates)
            stack.cards = stack.cards.filter((u) => u !== uid);
          p.archive.push(...stacked);
          ctx.milled = [...(ctx.milled ?? []), ...stacked];
          log(
            s,
            ctx.player,
            `${ctx.label}: 重なっている${op.level ?? ""}ホロメン${required}枚をアーカイブしました`,
          );
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: stacked,
          pickMin: required,
          pickMax: required,
          dest: "archive",
          restTo: "none",
          from: "stacked",
          ctx,
        });
        return;
      }
      case "stageSupportToDeckBottom": {
        const found: { stack: HolomenStack; uid: string }[] = [];
        for (const { stack } of allStacks(p)) {
          for (const uid of stack.supports) {
            if (cardHasName(s, uid, op.names)) found.push({ stack, uid });
          }
        }
        if (found.length < op.n) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 戻せる〈${op.names.join("〉か〈")}〉が足りません`,
          );
          abortEffectRest(ctx);
          break;
        }
        if (found.length === op.n) {
          for (const { stack, uid } of found) {
            stack.supports = stack.supports.filter(
              (cardUid) => cardUid !== uid,
            );
            p.deck.push(uid);
          }
          log(
            s,
            ctx.player,
            `${ctx.label}: 〈${op.names[0]}〉${op.n}枚をデッキの下に戻しました`,
          );
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: found.map(({ uid }) => uid),
          pickMin: op.n,
          pickMax: op.n,
          dest: "deckBottom",
          restTo: "none",
          from: "stageSupports",
          ctx,
        });
        return;
      }
      case "archiveAttached": {
        const src = ctx.sourceStackId
          ? findStackById(s, ctx.sourceStackId)
          : null;
        const matching = src
          ? src.stack.supports.filter((u) => {
              const c = cardOf(s, u);
              return (
                c.cardType === "support" &&
                (!op.kind || c.supportType === op.kind)
              );
            })
          : [];
        if (!src || matching.length < op.n) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 付いている${op.kind ?? "サポート"}が足りません`,
          );
          abortEffectRest(ctx);
          break;
        }
        if (matching.length === op.n) {
          src.stack.supports = src.stack.supports.filter(
            (uid) => !matching.includes(uid),
          );
          p.archive.push(...matching);
          log(
            s,
            ctx.player,
            `${ctx.label}: 付いている${op.kind ?? "サポート"}${op.n}枚をアーカイブしました`,
          );
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: matching,
          pickMin: op.n,
          pickMax: op.n,
          dest: "archive",
          restTo: "none",
          from: "stageSupports",
          ctx,
        });
        return;
      }
      case "moveMascot": {
        // ステージ上の全マスコットを集め、1枚選んで別ホロメンへ付け替える
        const mascots = allStacks(p).flatMap(({ stack }) =>
          stack.supports.filter((u) => {
            const c = cardOf(s, u);
            return c.cardType === "support" && c.supportType === "マスコット";
          }),
        );
        if (mascots.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 付け替えられるマスコットがありません`,
          );
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: mascots,
          pickMin: op.optional ? 0 : 1,
          pickMax: 1,
          dest: "attach",
          restTo: "none",
          from: "stageSupports",
          ctx,
        });
        return;
      }
      case "moveYell": {
        const yellOwner = op.side === "opp" ? other(ctx.player) : ctx.player;
        const ownerPlayer = s.players[yellOwner];
        const srcStacks = op.fromSelf
          ? (() => {
              const e = ctx.sourceStackId
                ? findStackById(s, ctx.sourceStackId)
                : null;
              return e ? [e.stack] : [];
            })()
          : allStacks(ownerPlayer)
              .map(({ stack }) => stack)
              .filter(
                (stack) =>
                  !op.sourceFilter ||
                  stackMatchesFilter(s, stack, op.sourceFilter),
              );
        const uids = srcStacks
          .flatMap((stack) => stack.yells.map((uid) => ({ stack, uid })))
          .filter(
            ({ stack, uid }) => !op.color || yellOnIs(s, stack, uid, op.color),
          )
          .filter(
            ({ stack, uid }) =>
              !op.colors || op.colors.some((c) => yellOnIs(s, stack, uid, c)),
          )
          .map(({ uid }) => uid);
        if (uids.length === 0) {
          log(s, ctx.player, `${ctx.label}: 移動できるエールがありません`);
          break;
        }
        const cheerTargetPlayer =
          op.side === "opp" ? other(ctx.player) : undefined;
        // 必須枚数をそのまま要求すると、強制選択のプロンプトが解決不能になる
        // (どの組み合わせを選んでも resolveEffectPickCard が弾く) ので、
        // 実際に送れる枚数まで下げる。送り先の「数」だけでなく perTargetMax
        // による1体あたりの上限も見る。
        // 例: 「バックのホロメンにエール2枚、ただし1人につき1枚まで」で
        //     バックが1体しかいない場合、容量1 < 必要2 なので1枚を送る。
        // 判定は解決時 (resolveEffectPickCard) の容量計算と同じ式にする。
        // (選ぶエールによって送り先は変わらないので代表1枚で判定できる)
        const cheerCapacity = cheerAssignCapacity(s, {
          type: "cheerAssign",
          player: ctx.player,
          yellUid: uids[0],
          reason: "effect",
          filter: op.targetFilter,
          targetPlayer: cheerTargetPlayer,
          perTargetMax: op.perTargetMax,
          sameTarget: op.sameTarget,
          ctx,
        });
        if (cheerCapacity <= 0) {
          log(s, ctx.player, `${ctx.label}: エールを付け替える先がありません`);
          break;
        }
        // 指定枚数に足りなくても「できる限り」送る (公式Q461)。
        // エールの数と送り先の容量で頭打ちにした枚数を、そのまま必要枚数にする。
        const movePickMax = Math.min(op.max, uids.length, cheerCapacity);
        const moveRequired = Math.min(op.min, movePickMax);
        const threshold =
          op.optional &&
          op.targetFilter?.boundOnly &&
          ctx.sourceCardUid &&
          cardOf(s, ctx.sourceCardUid).cardType === "support"
            ? boundYellArtBonusMinimum(ctx.rest)
            : undefined;
        const bound = ctx.boundStackId
          ? findStackById(s, ctx.boundStackId)?.stack
          : undefined;
        // Q429: 加算できない場合は、少なくとも1枚を実際に付け替える必要がある。
        const requireTransfer =
          threshold !== undefined && !!bound && bound.yells.length < threshold;
        const movePickMin = requireTransfer
          ? Math.max(1, moveRequired)
          : op.optional
            ? 0
            : moveRequired;
        if (movePickMax <= 0) {
          log(s, ctx.player, `${ctx.label}: エールを付け替える先が足りません`);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids,
          pickMin: movePickMin,
          pickMax: movePickMax,
          dest: "cheerAssign",
          restTo: "none",
          from: "stageYells",
          yellOwner,
          cheerTargetPlayer,
          targetFilter: op.targetFilter,
          perTargetMax: op.perTargetMax,
          sameTarget: op.sameTarget,
          zeroOrMin:
            op.optional && !requireTransfer && moveRequired > 0
              ? moveRequired
              : undefined,
          uidPickGroups: requireTransfer
            ? [
                {
                  uids: uids.filter((uid) => !bound!.yells.includes(uid)),
                  pickMin: 1,
                  pickMax: movePickMax,
                },
              ]
            : undefined,
          ctx,
        });
        return;
      }
      case "cheerFromTop": {
        // 「#tag持ちがBloomした回数per回につきn枚」: 実行時に回数で倍化して展開
        if (op.perBloomTag) {
          const cnt = s.bloomedCardUidsThisTurn[ctx.player].filter((u) => {
            const c = cardOf(s, u);
            return "tags" in c && c.tags.includes(op.perBloomTag!.tag);
          }).length;
          const total = Math.floor(cnt / op.perBloomTag.per) * op.n;
          if (total <= 0) {
            log(
              s,
              ctx.player,
              `${ctx.label}: このターンにBloomしていないため効果なし`,
            );
            break;
          }
          ctx.rest.unshift({ ...op, n: total, perBloomTag: undefined });
          break;
        }
        // 「このホロメンのエール1枚につきn枚」: 実行時にエール数で倍化して展開
        if (op.perSelfYell) {
          const src = ctx.sourceStackId
            ? findStackById(s, ctx.sourceStackId)
            : null;
          const yellCount = src?.stack.yells.length ?? 0;
          const total = op.n * yellCount;
          if (total <= 0) {
            log(
              s,
              ctx.player,
              `${ctx.label}: エールが付いていないため効果なし`,
            );
            break;
          }
          ctx.rest.unshift({ ...op, n: total, perSelfYell: undefined });
          break;
        }
        if (p.cheerDeck.length === 0 || op.n <= 0) break;
        const topAssign: Extract<Prompt, { type: "cheerAssign" }> = {
          type: "cheerAssign",
          player: ctx.player,
          yellUid: p.cheerDeck[0],
          reason: "effect",
          filter: cheerAssignTargetFilter(op.target, op.filter),
          frontOnly: op.target === "chooseOwnFront" || undefined,
          requiredTargetStackId: op.requiredTargetStackId,
          nextTopCheer:
            op.sameTarget && op.n > 1 ? { ...op, n: op.n - 1 } : undefined,
          ctx,
        };
        // 10.7.2.3.4: 送り先がいない送付は無視し、エールを山札から動かさない。
        // ライフダメージによるエールの移動とは異なり、アーカイブする指示はない。
        if (cheerAssignCandidates(s, topAssign).length === 0) {
          log(s, ctx.player, `${ctx.label}: エールを送れるホロメンがいません`);
          break;
        }
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: `${ctx.label}: エールデッキの上から${op.n}枚を送りますか？`,
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        const yellUid = p.cheerDeck.shift()!;
        log(
          s,
          ctx.player,
          `${ctx.label}: エールデッキから${cardLogLabel(s, yellUid)}を公開しました`,
        );
        if (attachCheerDirect(s, ctx, yellUid, op.target, op.filter)) {
          if (op.n > 1) ctx.rest.unshift({ ...op, n: op.n - 1 });
          break;
        }
        if (op.n > 1 && !op.sameTarget)
          ctx.rest.unshift({ ...op, n: op.n - 1 });
        pushPrompt(s, topAssign);
        return;
      }
      case "cheerFromArchive": {
        // 「アーカイブの〈N〉per枚につき、エールn枚を送る」: 実行時に枚数を確定して展開
        if (op.perArchiveNamed) {
          const cnt = p.archive.filter((u) =>
            cardHasName(s, u, op.perArchiveNamed!.names),
          ).length;
          const total = Math.floor(cnt / op.perArchiveNamed.per) * op.n;
          if (total <= 0) {
            log(
              s,
              ctx.player,
              `${ctx.label}: アーカイブに対象カードがないため効果なし`,
            );
            break;
          }
          ctx.rest.unshift({
            ...op,
            n: total,
            max: total,
            perArchiveNamed: undefined,
          });
          break;
        }
        const yells = p.archive.filter((u) => {
          const c = cardOf(s, u);
          return (
            c.cardType === "yell" &&
            (!op.colors || op.colors.includes((c as YellCard).color))
          );
        });
        if (yells.length === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: アーカイブに対象のエールがありません`,
          );
          break;
        }
        const targetFilter = cheerAssignTargetFilter(op.target, op.filter);
        const assignLimit = op.perTargetMax ?? (op.each ? 1 : undefined);
        const preview: Extract<Prompt, { type: "cheerAssign" }> = {
          type: "cheerAssign",
          player: ctx.player,
          yellUid: yells[0],
          reason: "effect",
          filter: targetFilter,
          perTargetMax: assignLimit,
          sameTarget: op.sameTarget,
          ctx,
        };
        const candidates = cheerAssignCandidates(s, preview);
        const capacity = cheerAssignCapacity(s, preview);
        if (candidates.length === 0) {
          log(s, ctx.player, `${ctx.label}: エールを送れるホロメンがいません`);
          break;
        }
        // 固定枚数の「送れる」は、実行を選ぶなら選んだ分を部分的には減らせない。
        // ただし枚数や送り先の容量が足りない時は「できる限り」送る (公式Q461)。
        if (op.optional && op.max === undefined && !op.each) {
          const sendable = Math.min(op.n, yells.length, capacity);
          if (sendable <= 0) {
            log(
              s,
              ctx.player,
              `${ctx.label}: 指定枚数のエールを送れないため効果なし`,
            );
            break;
          }
          const colorLabel = op.colors ? op.colors.join("か") : "";
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: `${ctx.label}: アーカイブの${colorLabel}エール${sendable}枚を送りますか？`,
            thenOps: [{ ...op, n: sendable, optional: undefined }],
            ctx,
          });
          return;
        }
        // 「n〜max枚」「好きな枚数」「全員に1枚ずつ」: 選択プロンプトで送るエールを選ぶ
        if (op.max !== undefined || op.each) {
          let pickMin: number;
          let pickMax: number;
          if (op.each) {
            // 対象1人につき1枚 (エールが足りなければその分だけ)。
            // 「1〜2人に1枚ずつ」のように人数上限があれば、そこまでに絞る
            pickMax = Math.min(candidates.length, yells.length, op.max ?? 99);
            // 上限が書かれている形は「1人〜上限」の範囲選択なので下限は1
            pickMin = op.max === undefined ? pickMax : Math.min(1, pickMax);
          } else {
            pickMax = Math.min(op.max ?? op.n, yells.length);
            // 対象が「エールが付いていない」条件の場合、送れる枚数は対象数まで
            if (op.filter?.noYell)
              pickMax = Math.min(pickMax, candidates.length);
            // 「ホロメン1人にX枚まで」の場合、送れる総数は 上限×対象数 まで
            if (Number.isFinite(capacity))
              pickMax = Math.min(pickMax, capacity);
            pickMin = Math.min(op.n, pickMax);
          }
          if (pickMax <= 0) {
            log(s, ctx.player, `${ctx.label}: エールを送れる対象がありません`);
            break;
          }
          let zeroOrMin: number | undefined;
          if (op.optional) {
            // 「できる」は効果全体を断れるだけで、固定された下限は減らせない。
            // 下限に届かない時は、送れるだけ送る (公式Q461の「できる限り」)。
            const required = Math.min(
              op.each && op.max === undefined ? pickMax : op.n,
              pickMax,
            );
            pickMin = 0;
            zeroOrMin = required > 0 ? required : undefined;
          }
          pushPrompt(s, {
            type: "effectPickCard",
            player: ctx.player,
            uids: yells,
            pickMin,
            pickMax,
            dest: "cheerAssign",
            restTo: "none",
            from: "archive",
            targetFilter,
            // each (「全員に1枚ずつ」) は1体につき1枚が上限。総数だけでなく分配も
            // 強制しないと、対象人数分のエールを同じホロメンにまとめて送れてしまう。
            perTargetMax: assignLimit,
            sameTarget: op.sameTarget,
            zeroOrMin,
            ctx,
          });
          return;
        }
        const pick = Math.min(op.n, yells.length, capacity);
        if (pick <= 0) break;
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: yells,
          pickMin: pick,
          pickMax: pick,
          dest: "cheerAssign",
          restTo: "none",
          from: "archive",
          targetFilter,
          perTargetMax: assignLimit,
          sameTarget: op.sameTarget,
          ctx,
        });
        return;
      }
      case "cheerFromArchiveToGroups": {
        const yells = p.archive.filter(
          (uid) => cardOf(s, uid).cardType === "yell",
        );
        // 「できる限り」(公式Q461): 送り先がいないグループとエール不足の分を
        // 落とし、送れる対象にだけ送る。
        let groups = op.targetGroups
          .flatMap((filter) => Array.from({ length: op.nEach }, () => filter))
          .filter(
            (filter) =>
              cheerAssignCandidates(s, {
                type: "cheerAssign",
                player: ctx.player,
                yellUid: yells[0] ?? "",
                reason: "effect",
                filter,
                ctx,
              }).length > 0,
          );
        // 名称別に1枚ずつ送る効果でも、エールが1枚ならいずれの名称を
        // 選んでもよい (1.3.2)。先頭グループだけを残すと、hBP03-024で
        // すいせいに送れなくなる。追加条件があるグループは合併しない。
        if (
          yells.length === 1 &&
          groups.length > 1 &&
          groups.every(
            (filter) =>
              filter.names &&
              Object.keys(filter).every((key) => key === "names"),
          )
        ) {
          ctx.rest.unshift({
            t: "cheerFromArchive",
            n: 1,
            target: "chooseOwn",
            filter: { names: [...new Set(groups.flatMap((g) => g.names!))] },
            optional: op.optional,
          });
          break;
        }
        // 異なる対象へ1枚ずつ送る形は、対象が重なって足りなければ組数を減らす
        while (
          groups.length > 1 &&
          !distinctCheerTargetsPayable(s, ctx.player, groups, ctx)
        )
          groups = groups.slice(0, -1);
        if (groups.length > yells.length)
          groups = groups.slice(0, yells.length);
        const total = groups.length;
        const distinctTargets = total > 1;
        if (total === 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 各対象へ指定枚数のエールを送れないため効果なし`,
          );
          break;
        }
        if (op.optional) {
          pushPrompt(s, {
            type: "effectConfirm",
            player: ctx.player,
            label: `${ctx.label}: アーカイブのエールを各対象へ${op.nEach}枚ずつ送りますか？`,
            thenOps: [{ ...op, optional: undefined }],
            ctx,
          });
          return;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: yells,
          pickMin: total,
          pickMax: total,
          dest: "cheerAssign",
          restTo: "none",
          from: "archive",
          cheerTargetGroups: groups,
          distinctCheerTargets: distinctTargets,
          orderMatters: true,
          orderLabel: "表示された対象グループの順に送るエールを選んでください",
          ctx,
        });
        return;
      }
      case "archiveHand": {
        const eligible = archiveHandEligible(s, ctx.player, op);
        if (offerHandArchiveReplacement(s, ctx, op)) return;
        // 任意コストを引き受けた後に肩代わりだけを辞退しても、
        // 本来の支払いを省略して後続の効果を解決してはいけない。
        if (op.requireFullPayment && eligible.length < op.n) {
          log(s, ctx.player, `${ctx.label}: 手札が足りずコストを支払えません`);
          abortEffectRest(ctx);
          break;
        }
        // 絞り込み対象の手札 (タグ/ホロメン限定)
        if (eligible.length === 0) break;
        // 「同じタグを持つホロメンX枚」: 共通タグでn枚揃わなければコスト不成立
        if (op.sameTag && !sameTagPayable(s, eligible, op.n)) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 同じタグを持つカードが揃わずコストを支払えません`,
          );
          abortEffectRest(ctx);
          break;
        }
        const min = Math.min(op.n, eligible.length);
        const max = Math.min(op.max ?? op.n, eligible.length);
        pushPrompt(s, {
          type: "effectArchiveHand",
          player: ctx.player,
          count: min,
          countMax: max,
          eligible:
            op.tag || op.holomenOnly || op.supportOnly ? eligible : undefined,
          sameTag: op.sameTag,
          ctx,
        });
        return;
      }
      case "repeatPerStage": {
        const count = allStacks(p).filter(
          ({ pos, stack }) =>
            (!op.pos ||
              (op.pos === "back" ? typeof pos !== "string" : pos === op.pos)) &&
            stackMatchesFilter(s, stack, op.filter),
        ).length;
        if (count <= 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象がいないため効果は発揮されません`,
          );
          break;
        }
        const repeated: typeof op.ops = [];
        for (let i = 0; i < count; i++)
          repeated.push(...op.ops.map((o) => structuredClone(o)));
        ctx.rest.unshift(...repeated);
        break;
      }
      case "if": {
        if (evalCond(s, ctx, op.cond)) ctx.rest.unshift(...op.then);
        break;
      }
      case "ifElse": {
        if (evalCond(s, ctx, op.cond)) ctx.rest.unshift(...op.then);
        else ctx.rest.unshift(...op.else);
        break;
      }
      case "boundArtPlusReplace": {
        const b = ctx.boundStackId ? findStackById(s, ctx.boundStackId) : null;
        if (!b) break;
        const c = topCard(s, b.stack);
        if (
          op.levels &&
          !op.levels.some((lv) =>
            lv === "Buzz" ? c.buzz : stackBloomLevels(s, b.stack).includes(lv),
          )
        )
          break;
        if (op.tag && !c.tags.includes(op.tag)) break;
        if (op.color && !stackColors(s, b.stack).includes(op.color)) break;
        if (
          op.yellAtLeast !== undefined &&
          b.stack.yells.length < op.yellAtLeast
        )
          break;
        if (
          op.yellColor &&
          !b.stack.yells.some((u) => yellOnIs(s, b.stack, u, op.yellColor!))
        )
          break;
        // 直近の同スタック向けターン修正値を置き換える (add時は加算)
        for (let i = s.turnModifiers.length - 1; i >= 0; i--) {
          const m = s.turnModifiers[i];
          if (m.stackId === b.stack.id && m.artPlus > 0) {
            if (op.add) {
              log(
                s,
                ctx.player,
                `${positionedHolomenName(s, b.pos, b.stack)}は条件を満たすため、さらにアーツ+${op.value}`,
              );
              m.artPlus += op.value;
            } else {
              log(
                s,
                ctx.player,
                `${positionedHolomenName(s, b.pos, b.stack)}は条件を満たすため、かわりにアーツ+${op.value}になります`,
              );
              m.artPlus = op.value;
            }
            break;
          }
        }
        break;
      }
      case "forceOppCollab": {
        const oppId = other(ctx.player);
        const oppP = s.players[oppId];
        if (oppP.collab || oppP.back.length === 0) {
          log(s, ctx.player, `${ctx.label}: 相手はコラボ移動できません`);
          break;
        }
        if (oppP.back.length === 1) {
          const st = oppP.back[0];
          if (hasNoSwitch(s, st)) {
            log(s, oppId, "効果によりコラボポジションへ移動できません");
            break;
          }
          oppP.back.splice(0, 1);
          oppP.collab = st;
          log(
            s,
            oppId,
            `バック1の${topCard(s, st).name}をコラボポジションに移動しました (コラボとしては扱わない)`,
          );
          ctx.rest.unshift({
            t: "emitTriggers",
            stackId: st.id,
            events: ["collabMoved"],
          });
          break;
        }
        pushPrompt(s, {
          type: "effectTarget",
          player: oppId,
          target: "chooseOwnBack",
          count: 1,
          apply: { t: "moveToCollab" },
          chosen: [],
          perspective: oppId,
          ctx,
        });
        return;
      }
      case "artNoReduce": {
        ctx.artNoReduce = true;
        log(s, ctx.player, `${ctx.label}: このアーツダメージは軽減されません`);
        break;
      }
      case "extraTurn": {
        s.extraTurns.push(ctx.player);
        log(
          s,
          ctx.player,
          `${ctx.label}: このターンの後に、もう1回自分のターンを開始します`,
        );
        break;
      }
      case "archiveOppAttached": {
        const oppId = other(ctx.player);
        const oppP = s.players[oppId];
        const eligible = (
          op.allStage
            ? allStacks(oppP).map((x) => x.stack)
            : [oppP.center, oppP.collab]
        )
          .filter((st): st is HolomenStack => st !== null)
          .flatMap((st) =>
            st.supports.filter((u) => {
              const c = cardOf(s, u);
              return c.cardType === "support" && c.supportType === op.kind;
            }),
          );
        if (eligible.length === 0) {
          log(s, ctx.player, `${ctx.label}: 対象の${op.kind}がありません`);
          break;
        }
        if (op.optional && eligible.length < op.n) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 指定枚数の${op.kind}をアーカイブできないため効果なし`,
          );
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: eligible,
          pickMin: op.optional ? 0 : Math.min(op.n, eligible.length),
          pickMax: Math.min(op.n, eligible.length),
          dest: "archive",
          restTo: "none",
          from: "stageSupports",
          supportOwner: oppId,
          zeroOrMin: op.optional ? op.n : undefined,
          ctx,
        });
        return;
      }
      case "archiveStageSupports": {
        const eligible = allStacks(p).flatMap(({ stack }) =>
          stack.supports.filter((u) =>
            op.filter
              ? cardMatchesFilter(s, ctx.player, u, op.filter)
              : cardHasName(s, u, op.names),
          ),
        );
        if (eligible.length < op.n && !op.partial) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 対象カードが足りずコストを支払えません`,
          );
          abortEffectRest(ctx);
          break;
        }
        pushPrompt(s, {
          type: "effectPickCard",
          player: ctx.player,
          uids: eligible,
          pickMin: Math.min(op.n, eligible.length),
          pickMax: Math.min(op.max ?? op.n, eligible.length),
          dest: "archive",
          restTo: "none",
          from: "stageSupports",
          ctx,
        });
        return;
      }
      case "cheerFromTopPerMilled": {
        const k = Math.floor((ctx.milled ?? []).length / op.per) * op.n;
        if (k <= 0) {
          log(
            s,
            ctx.player,
            `${ctx.label}: アーカイブした枚数が0のため効果なし`,
          );
          break;
        }
        ctx.rest.unshift({
          t: "cheerFromTop",
          n: k,
          target: op.target,
          filter: op.filter,
          sameTarget: op.sameTarget,
        });
        break;
      }
      case "revealedTopOrBottom": {
        if ((ctx.revealed ?? []).length === 0) break;
        pushPrompt(s, {
          type: "effectConfirm",
          player: ctx.player,
          label: "公開したカードをデッキの上に戻しますか？ (いいえ: 下に戻す)",
          thenOps: [{ t: "revealedTo", dest: "deckTop" }],
          elseOps: [{ t: "revealedTo", dest: "deckBottom" }],
          ctx,
        });
        return;
      }
      case "revealedArchiveOrTop": {
        if ((ctx.revealed ?? []).length === 0) break;
        pushPrompt(s, {
          type: "effectConfirm",
          player: ctx.player,
          label: `${ctx.revealedOwnerOnly ? "見た" : "公開した"}カードをすべてアーカイブしますか？ (いいえ: 好きな順でデッキの上に戻す)`,
          thenOps: [{ t: "revealedTo", dest: "archive" }],
          elseOps: [{ t: "revealedTo", dest: "deckTop", orderMatters: true }],
          ctx,
        });
        return;
      }
      case "diceMod": {
        s.diceMods.push({
          player: ctx.player,
          value: op.value,
          double: op.double,
          names: op.names,
          rollsAtLeast: op.rollsAtLeast,
          rollsExactly: op.rollsExactly,
          expiresTurn: s.turn,
        });
        log(
          s,
          ctx.player,
          `このターンの間、${op.names ? `${op.names.join("/")}の` : ""}サイコロの目を${op.double ? "倍の数" : `すべて${op.value}`}として扱います`,
        );
        break;
      }
      case "noRestReset": {
        // 10.10.2: 永続能力以外の継続効果は、使用後の登場・再登場へ適用しない。
        for (const { stack } of allStacks(p))
          if (
            op.names.some((name) => stackNames(s, stack).includes(name)) &&
            !s.noRestResetStackIds[ctx.player].includes(stack.id)
          )
            s.noRestResetStackIds[ctx.player].push(stack.id);
        log(
          s,
          ctx.player,
          `このゲームの間、${op.names.join("/")}はリセットステップでお休みしません`,
        );
        break;
      }
      case "drawPerPicked": {
        const count =
          Math.floor((ctx.pickedCards ?? []).length / op.per) * op.draw;
        let drawn = 0;
        for (let i = 0; i < count && p.deck.length > 0; i++) {
          p.hand.push(p.deck.shift()!);
          drawn++;
        }
        logDraw(
          s,
          ctx.player,
          `${ctx.label}: 戻した${(ctx.pickedCards ?? []).length}枚分、${drawn}枚ドローしました`,
          drawn,
        );
        break;
      }
      case "swapOppCenterCollab": {
        const oppP = s.players[other(ctx.player)];
        if (!oppP.center || !oppP.collab) {
          log(
            s,
            ctx.player,
            `${ctx.label}: 相手のセンターとコラボが揃っていないため入れ替えられません`,
          );
          break;
        }
        if (hasNoSwitch(s, oppP.center) || hasNoSwitch(s, oppP.collab)) {
          log(s, ctx.player, `${ctx.label}: 効果により入れ替えられません`);
          break;
        }
        const tmp = oppP.center;
        oppP.center = oppP.collab;
        oppP.collab = tmp;
        log(
          s,
          ctx.player,
          `相手のセンターホロメンとコラボホロメンを入れ替えました (現在: センターの${topCard(s, oppP.center).name}／コラボの${topCard(s, oppP.collab).name})`,
        );
        ctx.rest.unshift({
          t: "emitTriggers",
          stackId: tmp.id,
          events: ["collabMoved"],
        });
        break;
      }
      case "returnDownedToHand": {
        const current = s.ruleResolution?.current;
        if (current && current.stackId === ctx.downedStackId) {
          // 能力解決時は移動せず、11.3.1.2のアーカイブを置き換える。
          // 他のダウン時能力は引き続き場のホロメンを参照できる。
          current.returnToHandUids = op.uids.filter((u) =>
            current.cards.includes(u),
          );
          break;
        }
        const returned = op.uids.filter((u) => p.archive.includes(u));
        p.archive = p.archive.filter((u) => !returned.includes(u));
        p.hand.push(...returned);
        log(
          s,
          ctx.player,
          `ダウンしたホロメン${returned.length}枚をアーカイブのかわりに手札に戻しました`,
        );
        break;
      }
      case "optionalCost": {
        if (!canPayOptionalCost(s, ctx, op.cost)) {
          log(s, ctx.player, `${ctx.label}: 必要な枚数のコストを支払えません`);
          break;
        }
        pushPrompt(s, {
          type: "effectConfirm",
          player: ctx.player,
          label: op.label,
          thenOps: [
            ...op.cost.map((cost) =>
              cost.t === "archiveHand"
                ? { ...cost, requireFullPayment: true }
                : cost,
            ),
            ...op.then,
          ],
          ctx,
        });
        return;
      }
      case "artDamage": {
        const target = findStackById(s, op.targetStackId);
        if (!target) {
          log(
            s,
            ctx.player,
            "アーツの対象がいなくなったためダメージは与えられません",
          );
          // 対象がステージ外へ移動した場合でも、アーツを使った事実は残る。
          // HPを超えただけならQ538により、この時点では対象は場に残る。
          // ダメージは与えられなくても、
          // 免疫で0ダメージの場合と同じく使用時処理へ進む
          ctx.lastOverkill = 0;
          ctx.lastArtDealt = 0;
          ctx.lastArtDowned = false;
          ctx.rest.unshift({
            t: "afterArtDamage",
            targetStackId: op.targetStackId,
            targetPlayer: other(ctx.player),
            targetPos: "center",
            damage: 0,
            targetLost: true,
          });
          break;
        }
        const sourceStackId = ctx.artSourceStackId ?? ctx.sourceStackId;
        const src = sourceStackId ? findStackById(s, sourceStackId) : null;
        const noReduce = artDamageIgnoresReduction(
          s,
          ctx,
          originalArtDamageTarget(s, op, target),
          src,
        );
        // 「相手からダメージを受けない」付与、または味方ギフトのアーツダメージ免疫オーラの対象には
        // アーツダメージを与えられない
        if (
          !noReduce &&
          target.player !== ctx.player &&
          (isDamageImmune(s, target) || isArtImmune(s, target))
        ) {
          log(
            s,
            ctx.player,
            `${positionedHolomenName(s, target.pos, target.stack)}は相手からアーツダメージを受けません`,
            {
              kind: "art",
              sourceStackId: src?.stack.id,
              targetStackId: target.stack.id,
              blocked: true,
            },
          );
          ctx.lastOverkill = 0;
          ctx.lastArtDealt = 0;
          ctx.lastArtDowned = false;
          // ダメージが0でもアーツを使った事実は残るため、通常の使用時処理へ進む。
          ctx.rest.unshift({
            t: "afterArtDamage",
            targetStackId: op.targetStackId,
            targetPlayer: target.player,
            targetPos: target.pos,
            damage: 0,
          });
          break;
        }
        // ダメージを受ける側の「ダメージを受ける時」リアクティブを確認する。
        // 軽減不可の場合も、軽減以外の能力は候補に残す。
        // 特殊ダメージ側と同じ interceptIncomingDamage を通す (公式Q158)
        // 1.3.2.2 / 5.22.2 / Q227: アーツ値の修正後から0以下なら、
        // 「ダメージを受ける時」自体が発生しない。受けるダメージの加算は含める。
        // ただし軽減・無効化による0を先に確定すると、Q681の防御順を失うため、
        // この有無の判定では軽減を適用しない。実際のダメージ計算は後で行う。
        if (
          !op.interruptChecked &&
          !op.negate &&
          // 適用済みの置換による0は、まだ選んでいない防御の順序とは区別する。
          calculateArtDamage(s, ctx, op, target, src, true).damage >
            (noReduce ? 0 : (op.extraReduce ?? 0)) &&
          (!op.thresholdOrderResolved ||
            calculateArtDamage(s, ctx, op, target, src, noReduce).damage > 0)
        ) {
          op.interruptChecked = true;
          let artOrder:
            | { raw: number; reduced: number; firstReduction: number }
            | undefined;
          if (
            !noReduce &&
            !op.thresholdOrderResolved &&
            giftOf(topCard(s, target.stack)).noArtDamageAtLeast
          ) {
            const current = calculateArtDamage(s, ctx, op, target, src, false);
            artOrder = {
              raw: Math.max(
                0,
                calculateArtDamage(s, ctx, op, target, src, true).damage -
                  (op.extraReduce ?? 0),
              ),
              reduced: current.damage,
              firstReduction: current.firstMods.reduce(
                (sum, mod) => sum + mod.firstArtDamageReduce!,
                0,
              ),
            };
          }
          if (
            interceptIncomingDamage(s, ctx, target, {
              art: true,
              noReduce,
              artOrder,
              attacker: ctx.player,
              defer: () => ctx.rest.unshift(op),
              diceDone: op.diceReduceDone ?? [],
              replacementDone: op.replacementDone ?? [],
            })
          )
            return;
        }
        const calculated = calculateArtDamage(
          s,
          ctx,
          op,
          target,
          src,
          noReduce,
        );
        let damage = calculated.damage;
        const { specialApplied, taken, reduced, firstMods } = calculated;
        // 「そのダメージを受けない」で既に0になった場合は「最初に受ける」
        // 軽減を適用・消費しない (Q681)。redirect 後は新しい対象だけを見る (Q680)。
        if (firstMods.length > 0 && damage > 0) {
          // 複数の「最初に受ける」修正も同じ最初のアーツに適用する。
          // 途中で0になっても、同じ事象を参照する修正を次の攻撃へ持ち越さない。
          const reduce = firstMods.reduce(
            (sum, mod) => sum + mod.firstArtDamageReduce!,
            0,
          );
          // 軽減不可でも、実際に受けたダメージが「最初」であることは変わらない。
          // 軽減の適用と初回の消費を分け、後続のアーツへ持ち越さない。
          if (!noReduce) damage = Math.max(0, damage - reduce);
          s.turnModifiers = s.turnModifiers.filter(
            (tm) => !firstMods.includes(tm),
          );
          if (!noReduce)
            log(s, ctx.player, `効果により受けるアーツダメージ-${reduce}`);
        }
        damage = applyArtDamageImmunity(s, target, damage, noReduce);
        const remainingBefore = Math.max(
          0,
          effectiveMaxHp(s, target.stack) - target.stack.damage,
        );
        ctx.lastOverkill = Math.max(0, damage - remainingBefore);
        ctx.lastArtDealt = damage;
        target.stack.damage += damage;
        log(
          s,
          ctx.player,
          `アーツ「${op.artName}」で${positionedHolomenName(s, target.pos, target.stack)}に${damage}ダメージ` +
            (specialApplied ? " (特攻適用)" : "") +
            (taken !== 0
              ? ` (受けるダメージ${taken > 0 ? "+" : ""}${taken})`
              : "") +
            (reduced > 0 ? ` (スキルで-${reduced})` : ""),
          {
            kind: "art",
            sourceStackId: src?.stack.id,
            targetStackId: target.stack.id,
          },
        );
        ctx.rest.unshift(
          {
            t: "afterArtDamage",
            targetStackId: op.targetStackId,
            targetPlayer: target.player,
            targetPos: target.pos,
            damage,
            dealtOps: op.dealtOps,
          },
          { t: "continueRuleProcessing" },
        );
        const artDownAbility = op.downedOps?.length
          ? {
              ops: op.downedOps,
              artName: op.artName,
              damage,
              overkill: ctx.lastOverkill,
            }
          : undefined;
        // 本文の特殊ダメージで既に致死でも、0アーツダメージで発生源やライフ免除を上書きしない。
        const pendingCause = ctx.pendingRuleCauses?.[op.targetStackId];
        if (
          damage === 0 &&
          artDownAbility &&
          pendingCause?.player === ctx.player &&
          pendingCause.sourceStackId === sourceStackId
        )
          pendingCause.artDownAbility = artDownAbility;
        // 1.3.2.2 / 5.22.4: 0ダメージは与えた事象にならない。
        if (damage > 0)
          deferRuleDown(ctx, {
            player: ctx.player,
            artDamage: true,
            sourceStackId,
            targetStackId: op.targetStackId,
            artDownAbility,
          });
        break;
      }
      case "afterArtDamage": {
        const targetAfter = findStackById(s, op.targetStackId);
        const sourceStackId = ctx.artSourceStackId ?? ctx.sourceStackId;
        const src = sourceStackId ? findStackById(s, sourceStackId) : null;
        ctx.artTargetStackId = op.targetStackId;
        // 対象が消えていたのがこのアーツのダメージによるものでない場合は、
        // 「このアーツでダウンさせた」に数えない
        ctx.lastArtDowned =
          !op.targetLost &&
          !!targetAfter &&
          targetAfter.stack.damage >= effectiveMaxHp(s, targetAfter.stack);
        // ダウンさせたのがどのポジションのホロメンかを残す
        // (「相手のセンターホロメンをダウンさせた時」の判定に使う)
        ctx.lastArtDownedPos = ctx.lastArtDowned ? op.targetPos : undefined;
        const attackerAbilities: TriggerAbility[] = [];
        if (
          op.damage > 0 &&
          op.dealtOps?.length &&
          sourceStackId !== undefined
        ) {
          // 10.1.1.2.1・10.8：回復を先に確定せず、使用時の自傷等と
          // 同じ待機列へ置く。別の能力が先に解決しても与ダメージ値は保持する。
          attackerAbilities.push(
            ...captureTriggerContexts({ ...ctx, lastArtDealt: op.damage }, [
              {
                id: `artDealt:${sourceStackId}:${s.log.at(-1)?.id ?? 0}`,
                label: `アーツ「${ctx.artName ?? ""}」の能力`,
                sourceStackId,
                ops: [
                  { t: "setSource", stackId: sourceStackId },
                  ...structuredClone(op.dealtOps),
                ],
              },
            ]),
          );
        }
        const firstArtUse =
          !!src && src.player === ctx.player && !ctx.artUsedEmitted;
        if (firstArtUse) {
          ctx.artUsedEmitted = true;
          attackerAbilities.push(
            ...collectOshiStageTriggerAbilities(
              s,
              ctx.player,
              "artUsed",
              src.stack,
            ),
            ...collectTriggerAbilities(
              s,
              src,
              ["artUsed"],
              undefined,
              undefined,
              undefined,
              artTriggerEventData(ctx, op.damage),
            ),
            ...collectAllyArtUsedAbilities(s, ctx.player, src),
          );
        }
        if (
          src &&
          src.player === ctx.player &&
          op.targetPlayer !== ctx.player &&
          op.damage > 0
        )
          attackerAbilities.push(
            ...collectTriggerAbilities(s, src, ["dealtArt"]),
          );
        const emits: Op[] = [];
        if (attackerAbilities.length > 0)
          emits.push({
            t: "runTriggerAbilities",
            player: ctx.player,
            abilities: attackerAbilities,
            label: "アーツ使用時能力",
            defer: true,
          });
        // 0ダメージでは「ダメージを与える/受ける」が行われていないため、
        // 被ダメージ時能力は誘発しない (総合ルール1.3.2.2・5.22.2。
        // 「ダメージを受けない」で全量軽減された場合も5.22.4より0になる)
        if (targetAfter && op.damage > 0) {
          const defenderAbilities = [
            ...collectTriggerAbilities(
              s,
              targetAfter,
              ["damaged"],
              undefined,
              undefined,
              undefined,
              { value: op.damage, art: true },
            ),
            ...collectAllyDamagedAbilities(
              s,
              targetAfter.player,
              targetAfter,
              true,
            ),
          ];
          if (defenderAbilities.length > 0)
            emits.push({
              t: "runTriggerAbilities",
              player: targetAfter.player,
              abilities: defenderAbilities,
              label: "被ダメージ時能力",
              defer: true,
            });
        }
        ctx.rest.unshift(...emits);
        if (op.targetPlayer !== ctx.player && op.damage > 0) {
          const isBack = typeof op.targetPos !== "string";
          const ur = usableOshiReactive(
            s,
            ctx.player,
            isBack ? "dealtDamageToOppBack" : "dealtDamageToOppFront",
            src?.stack ?? null,
            undefined,
            true,
          );
          if (
            ur &&
            (ur.reactive.when === "dealtDamageToOppBack" ||
              ur.reactive.when === "dealtDamageToOppFront")
          ) {
            deferDamageReactive(ctx, ur, ur.reactive.ops, {
              boundStackId: isBack ? op.targetStackId : undefined,
              damage: op.damage,
            });
          }
        }
        if (firstArtUse && src.pos === "center") {
          const ur = usableOshiReactive(
            s,
            ctx.player,
            "artUsedByCenter",
            src.stack,
            undefined,
            true,
          );
          if (ur && ur.reactive.when === "artUsedByCenter") {
            deferDamageReactive(ctx, ur, ur.reactive.ops);
          }
        }
        break;
      }
      case "afterSpecialDamage": {
        const targetAfter = findStackById(s, op.targetStackId);
        const fromSupport = isSupportAbilitySource(s, ctx);
        const src =
          !fromSupport && !ctx.originOshiSkill && ctx.sourceStackId
            ? findStackById(s, ctx.sourceStackId)
            : null;
        const fromOshi = !fromSupport && !!ctx.originOshiSkill;
        const subject =
          !fromSupport && !fromOshi && ctx.sourceStackId !== undefined
            ? sourceHolomen(s, ctx.sourceStackId)
            : null;
        const emits: Op[] = [];
        if (op.targetPlayer !== ctx.player && op.damage > 0) {
          const dealtAbilities = [
            ...(src ? collectTriggerAbilities(s, src, ["dealtSpecial"]) : []),
            ...(subject || fromOshi
              ? collectAllyDealtSpecialAbilities(
                  s,
                  ctx.player,
                  subject ?? null,
                  op.damage,
                )
              : []),
          ];
          if (dealtAbilities.length > 0)
            emits.push({
              t: "runTriggerAbilities",
              player: ctx.player,
              abilities: dealtAbilities,
              label: "特殊ダメージ時能力",
              defer: true,
            });
        }
        // 0ダメージでは被ダメージ時能力は誘発しない (1.3.2.2・5.22.2)
        if (targetAfter && op.damage > 0) {
          const damagedAbilities = [
            ...collectTriggerAbilities(s, targetAfter, ["damaged"]),
            ...collectAllyDamagedAbilities(
              s,
              targetAfter.player,
              targetAfter,
              false,
            ),
          ];
          if (damagedAbilities.length > 0)
            emits.push({
              t: "runTriggerAbilities",
              player: targetAfter.player,
              abilities: damagedAbilities,
              label: "被ダメージ時能力",
              defer: true,
            });
        }
        ctx.rest.unshift(...emits);
        if (op.targetPlayer !== ctx.player && op.damage > 0) {
          const isBack = typeof op.targetPos !== "string";
          const specialReactive = usableOshiReactive(
            s,
            ctx.player,
            "dealtSpecial",
            null,
            undefined,
            true,
          );
          const ur =
            (specialReactive?.reactive.when === "dealtSpecial" &&
            (specialReactive.reactive.targetCount ?? 1) ===
              (op.opponentTargetCount ?? 1)
              ? specialReactive
              : null) ??
            (subject || fromOshi
              ? usableOshiReactive(
                  s,
                  ctx.player,
                  isBack ? "dealtDamageToOppBack" : "dealtDamageToOppFront",
                  subject ?? null,
                  undefined,
                  true,
                )
              : null);
          if (
            ur &&
            (ur.reactive.when === "dealtSpecial" ||
              ur.reactive.when === "dealtDamageToOppBack" ||
              ur.reactive.when === "dealtDamageToOppFront")
          ) {
            deferDamageReactive(ctx, ur, ur.reactive.ops, {
              boundStackId:
                ur.reactive.when === "dealtDamageToOppBack"
                  ? op.targetStackId
                  : undefined,
              damage: op.damage,
            });
          }
        }
        break;
      }
      case "setSource": {
        ctx.sourceStackId = op.stackId;
        ctx.sourceSupportUid = op.supportUid;
        ctx.grantedSupportAbility = op.grantedSupportAbility;
        break;
      }
      case "attachPlayedSupport": {
        // 使用コストの支払い後に、手札から抜いてあった付与サポートを付ける。
        const pending = ctx.pendingAttach;
        if (!pending) break;
        ctx.pendingAttach = undefined;
        // 付与/アーカイブへ移す前に解決中領域から外し、同じ実体を二重配置しない。
        p.resolvingSupports = (p.resolvingSupports ?? []).filter(
          (uid) => uid !== pending.uid,
        );
        const st = getStack(s.players[ctx.player], pending.pos);
        const c = cardOf(s, pending.uid);
        // コストの支払いで付け先が消えた/付けられなくなった場合はアーカイブへ送る
        if (!st || (c.cardType === "support" && attachError(s, st, c))) {
          s.players[ctx.player].archive.push(pending.uid);
          log(
            s,
            ctx.player,
            `${c.name}の付け先がなくなったためアーカイブに置きました`,
          );
          break;
        }
        completePlayedAttach(s, ctx.player, st, pending.uid, pending.pos);
        break;
      }
      case "archiveRedirect": {
        const attachPrompt: Extract<Prompt, { type: "effectAttach" }> = {
          type: "effectAttach",
          player: op.owner,
          uid: op.uid,
          targetFilter: { names: op.targetNames, position: "back" },
          ctx,
        };
        const canAttach = hasAttachTarget(s, attachPrompt);
        if (op.choice === "archive" || !canAttach) {
          s.players[op.owner].archive.push(op.uid);
          if (op.recordArchived) (ctx.milled ??= []).push(op.uid);
          log(s, op.owner, `${cardOf(s, op.uid).name}をアーカイブしました`);
          break;
        }
        if (op.choice === "attach") {
          pushPrompt(s, attachPrompt);
          return;
        }
        pushPrompt(s, {
          type: "effectConfirm",
          player: op.owner,
          label: `${cardOf(s, op.uid).name}をアーカイブするかわりに、バックの${op.targetNames.join("/")}に付け替えますか？`,
          thenOps: [{ ...op, choice: "attach" }],
          elseOps: [{ ...op, choice: "archive" }],
          ctx,
        });
        return;
      }
      case "selfSupportToHand":
      case "selfSupportToDeckTop":
      case "selfSupportToDeckBottom":
      case "archiveSelfSupport": {
        const uid = ctx.sourceSupportUid;
        if (!uid) break;
        const cName = cardOf(s, uid).name;
        const toHand = op.t === "selfSupportToHand";
        const toDeckTop = op.t === "selfSupportToDeckTop";
        const toDeckBottom = op.t === "selfSupportToDeckBottom";
        // ステージの付与から探す
        let owner: PlayerId | null = null;
        let fromPos: StagePosition | undefined;
        for (const pid of [0, 1] as PlayerId[]) {
          for (const e of allStacks(s.players[pid])) {
            const i = e.stack.supports.indexOf(uid);
            if (i >= 0) {
              e.stack.supports.splice(i, 1);
              owner = pid;
              fromPos = e.pos;
              break;
            }
          }
          if (owner !== null) break;
        }
        // アーカイブ置換 (公式Q520: このカード自身の能力でアーカイブする時も
        // 「アーカイブするかわりに付け替える」が働く)
        if (owner !== null && !toHand && !toDeckTop && !toDeckBottom) {
          const targetNames = archiveRedirectTargets(s, owner, uid, fromPos);
          if (targetNames) {
            ctx.rest.unshift({ t: "archiveRedirect", owner, uid, targetNames });
            break;
          }
        }
        // ダウン処理などでアーカイブ済みの場合はアーカイブから探す
        if (owner === null) {
          for (const pid of [0, 1] as PlayerId[]) {
            const i = s.players[pid].archive.indexOf(uid);
            if (i >= 0) {
              if (!toHand && !toDeckTop && !toDeckBottom) {
                owner = pid; // すでにアーカイブにあるので移動不要
                break;
              }
              s.players[pid].archive.splice(i, 1);
              owner = pid;
              break;
            }
          }
          if (owner !== null && !toHand && !toDeckTop && !toDeckBottom) {
            log(
              s,
              ctx.player,
              `${ctx.label}: ${cName}はすでにアーカイブにあります`,
            );
            break;
          }
        }
        if (owner === null) break;
        if (toHand) {
          s.players[owner].hand.push(uid);
          log(s, ctx.player, `${ctx.label}: ${cName}を手札に戻しました`);
        } else if (toDeckTop) {
          s.players[owner].deck.unshift(uid);
          log(s, ctx.player, `${ctx.label}: ${cName}をデッキの上に戻しました`);
        } else if (toDeckBottom) {
          s.players[owner].deck.push(uid);
          log(s, ctx.player, `${ctx.label}: ${cName}をデッキの下に戻しました`);
        } else {
          s.players[owner].archive.push(uid);
          log(s, ctx.player, `${ctx.label}: ${cName}をアーカイブしました`);
        }
        break;
      }
      case "emitTriggers": {
        const f = findStackById(s, op.stackId);
        if (!f) break;
        const abilities = collectTriggerAbilities(
          s,
          f,
          op.events,
          op.onlyUid,
          undefined,
          undefined,
          op.events.includes("artUsed")
            ? artTriggerEventData(ctx, 0)
            : undefined,
        );
        ctx.rest.unshift({
          t: "runTriggerAbilities",
          player: f.player,
          abilities,
        });
        break;
      }
    }
  }
  if (s.phase === "playing" && s.prompts.length === 0 && !s.ruleResolution)
    checkDowns(s);
}

/** 見たカードを複数の選択枠へ割り当てられる最大枚数。 */
function maxGroupPick(
  s: GameState,
  pid: PlayerId,
  uids: string[],
  groups: { filter: CardFilter; max: number }[],
): number {
  const slots = groups.flatMap((group) =>
    Array.from({ length: group.max }, () => group.filter),
  );
  const assigned = new Array<number>(slots.length).fill(-1);
  const match = (cardIndex: number, seen: Set<number>): boolean => {
    for (let slot = 0; slot < slots.length; slot++) {
      if (
        seen.has(slot) ||
        !cardMatchesFilter(s, pid, uids[cardIndex], slots[slot])
      )
        continue;
      seen.add(slot);
      if (assigned[slot] < 0 || match(assigned[slot], seen)) {
        assigned[slot] = cardIndex;
        return true;
      }
    }
    return false;
  };
  let count = 0;
  for (let i = 0; i < uids.length; i++) if (match(i, new Set())) count++;
  return count;
}

export function effectAttachTargetError(
  s: GameState,
  prompt: Extract<Prompt, { type: "effectAttach" }>,
  pos: StagePosition,
  stack: HolomenStack,
  card: SupportCard,
): string | null {
  const attachErr = attachError(s, stack, card);
  if (attachErr) return attachErr;
  if (
    prompt.targetNames &&
    !prompt.targetNames.some((name) => stackNames(s, stack).includes(name))
  )
    return `${prompt.targetNames.join("/")}にしか付けられません`;
  if (
    prompt.targetFilter &&
    (!stackMatchesFilter(s, stack, prompt.targetFilter) ||
      !matchesPosition(pos, prompt.targetFilter.position))
  )
    return "この効果の付け先条件を満たしていません";
  if (prompt.excludeStackId !== undefined && stack.id === prompt.excludeStackId)
    return "このホロメン以外に付けてください";
  if (prompt.targetFilter?.sourceOnly && stack.id !== prompt.ctx?.sourceStackId)
    return "この効果の発生源のホロメンに付けてください";
  if (
    prompt.sameTarget &&
    (prompt.ctx?.lastAttachedCount ?? 0) > 0 &&
    stack.id !== prompt.ctx?.attachedToStackId
  )
    return "最初に付けたホロメンにまとめて付けてください";
  if (prompt.targetFilter?.boundOnly && prompt.ctx) {
    const ids =
      prompt.ctx.boundStackIds && prompt.ctx.boundStackIds.length > 0
        ? prompt.ctx.boundStackIds
        : prompt.ctx.boundStackId !== undefined
          ? [prompt.ctx.boundStackId]
          : [];
    if (!ids.includes(stack.id))
      return "この効果で選んだホロメンに付けてください";
  }
  return null;
}

/** effectAttachプロンプトの付け先が1つでもあるか */
export function hasAttachTarget(
  s: GameState,
  prompt: Extract<Prompt, { type: "effectAttach" }>,
): boolean {
  const c = cardOf(s, prompt.uid);
  if (c.cardType !== "support") return false;
  return allStacks(s.players[prompt.player]).some(
    ({ pos, stack }) =>
      effectAttachTargetError(s, prompt, pos, stack, c) === null,
  );
}

// ------------------------------------------------------------
// ダウン処理・ライフ処理・勝敗 (11章)
// ------------------------------------------------------------

function finishGame(
  s: GameState,
  winner: PlayerId | null,
  reason: string,
): void {
  if (s.phase === "finished") return;
  s.phase = "finished";
  s.winner = winner;
  s.winReason = reason;
  // phase="finished" かつ winner=null が引き分け。終局後の入力待ちは破棄する。
  s.prompts = [];
  if (winner === null) log(s, null, "ゲーム終了: 引き分け (" + reason + ")");
  else
    log(
      s,
      null,
      "ゲーム終了: " + playerName(s, winner) + "の勝利 (" + reason + ")",
    );
}

export function setWinner(
  s: GameState,
  winner: PlayerId,
  reason: string,
): void {
  finishGame(s, winner, reason);
}

function setDraw(s: GameState, reason: string): void {
  finishGame(s, null, reason);
}

export function checkDowns(s: GameState): void {
  if (s.phase !== "playing") return;
  const resume: EffectContextData = {
    player: s.turnPlayer,
    rest: [],
    label: "ルール処理",
  };
  beginRuleProcessing(s, resume);
  if (s.ruleResolution) continueRuleProcessing(s);
}

function ruleDownCandidates(
  s: GameState,
): { player: PlayerId; pos: StagePosition; stack: HolomenStack }[] {
  const candidates: {
    player: PlayerId;
    pos: StagePosition;
    stack: HolomenStack;
  }[] = [];
  for (const pid of [s.turnPlayer, other(s.turnPlayer)] as PlayerId[]) {
    for (const entry of allStacks(s.players[pid])) {
      if (
        // ダウン時能力で重なりを全部手札に戻すと、撤去されるまでの間だけ
        // ホロメンのいないスタックが残る
        entry.stack.cards.length > 0 &&
        !entry.stack.downResolving &&
        entry.stack.damage >= effectiveMaxHp(s, entry.stack)
      )
        candidates.push({ player: pid, pos: entry.pos, stack: entry.stack });
    }
  }
  return candidates;
}

function entryRuleAbilities(
  s: GameState,
  entry: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  events: import("../effects").TriggerEvent[],
  prefix: string,
  downedPos?: StagePosition,
): RuleDownAbility[] {
  const abilities: RuleDownAbility[] = [];
  for (const uid of entry.stack.supports) {
    const ops = collectTriggerOps(s, entry, events, uid, downedPos);
    if (ops.length === 0) continue;
    abilities.push({
      id: `${prefix}:support:${uid}`,
      player: entry.player,
      label: `「${cardOf(s, uid).name}」の能力`,
      sourceStackId: entry.stack.id,
      sourceSupportUid: uid,
      ops,
    });
  }
  const giftEntry = {
    ...entry,
    stack: { ...entry.stack, supports: [] },
  };
  const giftOps = collectTriggerOps(s, giftEntry, events, undefined, downedPos);
  if (giftOps.length > 0) {
    const top = topCard(s, entry.stack);
    abilities.push({
      id: `${prefix}:gift:${entry.stack.cards[0]}`,
      player: entry.player,
      label: `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, entry.pos, entry.stack)})`,
      sourceStackId: entry.stack.id,
      ops: giftOps,
    });
  }
  return abilities;
}

function allyDownedRuleAbilities(
  s: GameState,
  downed: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
): RuleDownAbility[] {
  const abilities: RuleDownAbility[] = [];
  for (const entry of allStacks(s.players[downed.player])) {
    const isSelf = entry.stack.id === downed.stack.id;
    const top = topCard(s, entry.stack);
    const gift = giftOf(top);
    const sharedUseLimit = gift.sharedUseLimit
      ? {
          key: `namedGift:${downed.player}:${gift.sharedUseLimit.name}`,
          n: gift.sharedUseLimit.n,
        }
      : undefined;
    const key = sharedUseLimit?.key ?? `giftAlly:${entry.stack.cards[0]}`;
    const ops: Op[] = [];
    for (const def of gift.triggers) {
      if (def.event !== "allyDowned") continue;
      // 「自分の(条件)ホロメンがダウンした時」は保持者自身のダウンでも誘発する。
      // 「このホロメン以外の」と書かれている時だけ自身を除く
      // (公式Q451/Q452: センターとコラボが同名なら両方が発揮する。
      //  公式Q570: 自身がダウンした場合もエールを送ってからアーカイブする)
      if (isSelf && def.excludeSelf) continue;
      if (
        def.subjectFilter &&
        !stackMatchesFilter(s, downed.stack, def.subjectFilter)
      )
        continue;
      if (!matchesPosition(downed.pos, def.subjectFilter?.position)) continue;
      // 同名能力が同時に待機する場合、どの保持者を使うかは解決順で選べる。
      // 収集時には消費せず、選ばれた能力の解決開始時に共有回数を消費する。
      if (!triggerFires(s, downed.player, entry.pos, def, key, !sharedUseLimit))
        continue;
      ops.push(
        ...triggerDefOps(def, key, `ギフト「${top.gift?.name ?? ""}」`, [
          { t: "setSource", stackId: entry.stack.id },
          ...(structuredClone(def.ops) as Op[]),
        ]),
      );
    }
    if (ops.length === 0) continue;
    if (!sharedUseLimit)
      logEffect(
        s,
        downed.player,
        `▶ ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, entry.pos, entry.stack)})が発動します`,
        `ギフト「${top.gift?.name ?? ""}」`,
        { sourceStackId: entry.stack.id },
      );
    abilities.push({
      id: `allyDowned:${downed.stack.id}:${entry.stack.id}`,
      player: downed.player,
      label: `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, entry.pos, entry.stack)})`,
      sourceStackId: entry.stack.id,
      sharedUseLimit,
      ops,
    });
  }
  return abilities;
}

function downRewardRuleAbilities(
  s: GameState,
  cause: RuleDownCause | undefined,
  downed: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
): RuleDownAbility[] {
  if (!cause || cause.player === downed.player) return [];
  // 待機能力の発生源は先に離脱していても、最終情報で対象の個体・所属を判定する。
  const source =
    cause.sourceStackId !== undefined
      ? sourceHolomen(s, cause.sourceStackId)
      : null;
  const abilities: RuleDownAbility[] = [];
  for (const [index, reward] of (s.downRewards ?? []).entries()) {
    if (reward.player !== cause.player || reward.expiresTurn < s.turn) continue;
    if (reward.artDamageOnly && !cause.artDamage) continue;
    if (!reward.anyHolomen && downed.pos !== "center") continue;
    if (reward.tag && !(source && topCard(s, source).tags.includes(reward.tag)))
      continue;
    if (reward.stackId !== undefined && source?.id !== reward.stackId) continue;
    const ops: Op[] = [];
    if (reward.oppLifeMinus)
      ops.push({ t: "oppLifeMinus", n: reward.oppLifeMinus });
    if (reward.draw) ops.push({ t: "draw", n: reward.draw });
    if (ops.length === 0) continue;
    abilities.push({
      id: `downReward:${downed.stack.id}:${index}`,
      player: cause.player,
      label: reward.sourceLabel
        ? `${reward.sourceLabel}のダウン時効果`
        : `相手ホロメンのダウン時に発揮する効果（${index + 1}）`,
      sourceStackId: source?.id,
      ops,
    });
  }
  return abilities;
}

function downRuleAbilities(
  s: GameState,
  downed: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
  cause: RuleDownCause | undefined,
): RuleDownAbility[] {
  const abilities: RuleDownAbility[] = [
    ...entryRuleAbilities(s, downed, ["downed"], `downed:${downed.stack.id}`),
    ...allyDownedRuleAbilities(s, downed),
  ];
  const top = topCard(s, downed.stack);
  const gift = giftOf(top);
  if (
    gift.downToHand &&
    !(gift.downToHand.oppTurnOnly && s.turnPlayer === downed.player)
  ) {
    const label = `ギフト「${top.gift?.name ?? ""}」(${positionedHolomenName(s, downed.pos, downed.stack)})`;
    abilities.push({
      id: `downed:${downed.stack.id}:returnGift:${downed.stack.cards[0]}`,
      player: downed.player,
      sourceStackId: downed.stack.id,
      label,
      ops: [
        {
          t: "optionalCost",
          label: `${label}: アーカイブのかわりに手札に戻しますか？`,
          cost: gift.downToHand.limitedArchiveToDeckBottom
            ? [
                {
                  t: "moveArchive",
                  filter: { kind: "サポート", limited: true },
                  min: 1,
                  max: 1,
                  dest: "deckBottom",
                },
              ]
            : [],
          // Q604: 「このホロメン」は一番上のカードのみ。
          then: [{ t: "returnDownedToHand", uids: [downed.stack.cards[0]] }],
        },
      ],
    });
  }
  const ownOshi = usableOshiReactive(
    s,
    downed.player,
    "downedOwn",
    downed.stack,
    undefined,
    true,
  );
  if (ownOshi && ownOshi.reactive.when === "downedOwn") {
    abilities.push({
      id: `oshi:downedOwn:${downed.stack.id}`,
      player: downed.player,
      label: `${ownOshi.sp ? "SP推しスキル" : "推しスキル"}「${ownOshi.skill.name}」`,
      sourceStackId: downed.stack.id,
      ops: structuredClone(ownOshi.reactive.ops) as Op[],
      reactive: {
        sp: ownOshi.sp,
        skillName: ownOshi.skill.name,
        description: ownOshi.skill.description,
        cost: ownOshi.cost,
      },
    });
  }

  const opponent = other(downed.player);
  if (typeof downed.pos !== "string") {
    for (const entry of allStacks(s.players[opponent])) {
      abilities.push(
        ...entryRuleAbilities(
          s,
          { player: opponent, pos: entry.pos, stack: entry.stack },
          ["oppBackDowned"],
          `oppBackDowned:${downed.stack.id}:${entry.stack.id}`,
        ),
      );
    }
  }

  if (cause && cause.player !== downed.player) {
    const attacker = cause.player;
    const artDown = cause.artDownAbility;
    const artOps = artDown?.ops.filter(
      (op) =>
        op.t === "if" &&
        op.cond.c === "artDowned" &&
        (!op.cond.pos || op.cond.pos === downed.pos),
    );
    if (artDown && artOps?.length)
      abilities.push({
        id: `artDowned:${downed.stack.id}:${cause.sourceStackId}`,
        player: attacker,
        label: `アーツ「${artDown.artName}」のダウン時能力`,
        sourceStackId: cause.sourceStackId,
        ops: artOps,
        artDownAbility: artDown,
      });
    const src = cause.sourceStackId
      ? findStackById(s, cause.sourceStackId)
      : null;
    if (src) {
      abilities.push(
        ...entryRuleAbilities(
          s,
          src,
          ["downedOpponent"],
          `downedOpponent:${downed.stack.id}:${src.stack.id}`,
          downed.pos,
        ),
      );
    }
    const subject =
      cause.sourceStackId !== undefined
        ? sourceHolomen(s, cause.sourceStackId)
        : null;
    abilities.push(
      ...collectAllyDownedOpponentAbilities(
        s,
        attacker,
        subject,
        downed.stack.id,
      ),
    );
    const oppOshi =
      cause.sourceStackId !== undefined
        ? usableOshiReactive(
            s,
            attacker,
            "downedOpp",
            subject,
            downed.pos,
            true,
          )
        : null;
    if (oppOshi && oppOshi.reactive.when === "downedOpp") {
      abilities.push({
        id: `oshi:downedOpp:${downed.stack.id}`,
        player: attacker,
        label: `${oppOshi.sp ? "SP推しスキル" : "推しスキル"}「${oppOshi.skill.name}」`,
        sourceStackId: src?.stack.id,
        ops: structuredClone(oppOshi.reactive.ops) as Op[],
        reactive: {
          sp: oppOshi.sp,
          skillName: oppOshi.skill.name,
          description: oppOshi.skill.description,
          cost: oppOshi.cost,
        },
      });
    }
    abilities.push(...downRewardRuleAbilities(s, cause, downed));
  }
  return abilities;
}

function startRuleDown(
  s: GameState,
  entry: { player: PlayerId; pos: StagePosition; stack: HolomenStack },
): void {
  const state = s.ruleResolution!;
  state.downBeforeLife = undefined;
  entry.stack.downResolving = true;
  const top = topCard(s, entry.stack);
  const cause = state.causes[entry.stack.id];
  const noLife = cause?.noLifeTargetStackId === entry.stack.id;
  state.current = {
    player: entry.player,
    stackId: entry.stack.id,
    pos: entry.pos,
    cards: [...entry.stack.cards],
    yells: [...entry.stack.yells],
    supports: [...entry.stack.supports],
    lifeLoss: noLife ? 0 : top.lifeOnDown,
    lifeAccounted: false,
    wasCenter: entry.pos === "center",
    abilities: downRuleAbilities(s, entry, cause),
  };
}

function executeRuleAbility(s: GameState, ability: RuleDownAbility): void {
  const state = s.ruleResolution;
  const current = state?.current;
  if (!state || !current) return;
  current.abilities = current.abilities.filter((a) => a.id !== ability.id);
  if (ability.sharedUseLimit) {
    const { key, n } = ability.sharedUseLimit;
    const used = s.usedTriggersThisTurn[key] ?? 0;
    if (used >= n)
      throw new Error("このターンは同名ギフトを既に使用しています");
    s.usedTriggersThisTurn[key] = used + 1;
    logEffect(
      s,
      ability.player,
      `▶ ${ability.label}が発動します`,
      ability.label,
      {
        sourceStackId: ability.sourceStackId,
      },
    );
  }
  // 11.3.1.1.2: 全てのダウン時能力を解決してから、11.3.1.2で
  // ライフダメージを確定する。推しスキルの後にもギフトが残り得る。
  const rest: Op[] = [{ t: "continueRuleProcessing" }];
  const ctx: EffectContextData = {
    player: ability.player,
    sourceStackId: ability.sourceStackId,
    sourceSupportUid: ability.sourceSupportUid,
    downedStackId: current.stackId,
    downedCards: [...current.cards],
    downedYells: [...current.yells],
    downedSupports: [...current.supports],
    rest,
    label: ability.label,
  };
  if (ability.artDownAbility) {
    ctx.artSourceStackId = ability.sourceStackId;
    ctx.artTargetStackId = current.stackId;
    ctx.artName = ability.artDownAbility.artName;
    ctx.lastArtDowned = true;
    ctx.lastArtDownedPos = current.pos;
    ctx.lastArtDealt = ability.artDownAbility.damage;
    ctx.lastOverkill = ability.artDownAbility.overkill;
  }
  if (ability.reactive) {
    ctx.rest.unshift({
      t: "offerReactiveSkill",
      ...ability.reactive,
      ops: ability.ops,
    });
    runOps(s, ctx);
    return;
  }
  ctx.rest.unshift(...(structuredClone(ability.ops) as Op[]));
  runOps(s, ctx);
}

function finishRuleDown(s: GameState): void {
  const state = s.ruleResolution;
  const current = state?.current;
  if (!state || !current) return;
  const live = findStackById(s, current.stackId);
  const p = s.players[current.player];
  const top = cardOf(s, current.cards[0]) as HolomenCard;
  let cards = [...(live?.stack.cards ?? current.cards)];
  let yells = [...(live?.stack.yells ?? current.yells)];
  let supports = [...(live?.stack.supports ?? current.supports)];
  // ダウン時能力で手札へ戻ったホロメンや、別のホロメンへ付け替えたエールは
  // アーカイブしない。スタックが先に撤去されているとスナップショットが古く
  // なるため、「今どこかに置かれているか」で判定する
  const placed = new Set<string>();
  for (const pl of s.players) {
    for (const uid of [
      ...pl.hand,
      ...pl.deck,
      ...pl.cheerDeck,
      ...pl.archive,
      ...pl.holoPower,
      ...pl.life,
    ])
      placed.add(uid);
    for (const { stack } of allStacks(pl)) {
      if (stack.id === current.stackId) continue;
      for (const uid of [...stack.cards, ...stack.yells, ...stack.supports])
        placed.add(uid);
    }
  }
  cards = cards.filter((u) => !placed.has(u));
  yells = yells.filter((u) => !placed.has(u));
  supports = supports.filter((u) => !placed.has(u));
  // 回収でスタックが消えた場合も、付け替え済みのエールを誘発に数えない。
  // 実際にアーカイブするエールで判定し、ダウンする保持者の能力も撤去前に収集する。
  const yellAbilities =
    yells.length > 0
      ? collectYellArchivedTriggerAbilities(s, current.player)
      : [];
  if (live) removeStack(s, p, live.pos);
  // アーカイブ置換 (公式Q521: 付いていたホロメンがダウンしてアーカイブされる
  // 場合も「アーカイブするかわりに付け替える」が働く)。スタックは撤去済みなので
  // 位置はダウン処理のスナップショットから渡す
  const redirected: { uid: string; targetNames: string[] }[] = [];
  for (const uid of supports) {
    const targetNames = archiveRedirectTargets(
      s,
      current.player,
      uid,
      current.pos,
    );
    if (targetNames) redirected.push({ uid, targetNames });
  }
  if (redirected.length > 0) {
    const moved = new Set(redirected.map((r) => r.uid));
    supports = supports.filter((u) => !moved.has(u));
  }
  const returned = cards.filter((uid) =>
    current.returnToHandUids?.includes(uid),
  );
  p.hand.push(...returned);
  p.archive.push(
    ...cards.filter((uid) => !returned.includes(uid)),
    ...yells,
    ...supports,
  );
  if (returned.length > 0)
    log(
      s,
      current.player,
      `ダウンしたホロメン${returned.length}枚をアーカイブのかわりに手札に戻しました`,
    );
  if (yells.length > 0) s.stageYellArchivedThisTurn[current.player] = true;
  s.turnModifiers = s.turnModifiers.filter(
    (m) => m.stackId !== current.stackId,
  );
  s.downsThisTurn[current.player]++;
  s.downedUidsThisTurn[current.player].push(current.cards[0]);
  if (!current.lifeAccounted)
    state.lifeDamage[current.player] += current.lifeLoss;
  log(
    s,
    current.player,
    `${posLabel(current.pos)}の${top.name}がダウンしました` +
      (current.lifeLoss === 0
        ? " (ライフは減らない)"
        : ` (ライフ-${current.lifeLoss})`) +
      (top.buzz ? " [Buzz]" : ""),
  );
  state.current = undefined;
  delete state.causes[current.stackId];
  if (yellAbilities.length > 0)
    // ライフ送付などで待機した能力と同じ列で解決順を選ぶ (10.6.3)。
    (state.resume.pendingTriggers ??= []).push({
      player: current.player,
      abilities: captureTriggerContexts(
        {
          player: current.player,
          rest: [],
          label: "ダウンによるエールアーカイブ時能力",
        },
        yellAbilities,
      ),
      label: "ダウンによるエールアーカイブ時能力",
    });

  const afterArchive: Op[] = redirected.map((r) => ({
    t: "archiveRedirect",
    ...r,
    owner: current.player,
  }));
  afterArchive.push({ t: "continueRuleProcessing" });
  if (redirected.length > 0)
    runOps(s, {
      player: current.player,
      rest: afterArchive,
      label: "アーカイブ置換",
    });
}

function applyOneLifeDamage(s: GameState, pid: PlayerId): void {
  const state = s.ruleResolution!;
  state.lifeDamage[pid]--;
  const p = s.players[pid];
  if (p.life.length === 0) {
    state.lifeDamage[pid] = 0;
    state.lifeDepleted[pid] = true;
    return;
  }
  const yellUid = p.life.shift()!;
  if (p.life.length === 0) {
    p.archive.push(yellUid);
    state.lifeDamage[pid] = 0;
    state.lifeDepleted[pid] = true;
    return;
  }
  if (allStacks(p).length === 0) {
    p.archive.push(yellUid);
    return;
  }
  pushPrompt(s, {
    type: "cheerAssign",
    player: pid,
    yellUid,
    reason: "life",
    ctx: {
      player: pid,
      rest: [{ t: "continueRuleProcessing", deferTriggers: true }],
      label: "ライフダメージ",
    },
  });
}

function continueRuleProcessing(s: GameState): void {
  while (s.phase === "playing" && s.ruleResolution) {
    const state = s.ruleResolution;
    const current = state.current;
    if (current) {
      // 支払い不能の推しスキルも、他の能力でホロパワーが増える可能性があるため
      // 待機中の一覧には残し、次の能力を選ぶたびに使用可能か再判定する。
      const playable = current.abilities.filter(
        (a) =>
          (!a.sharedUseLimit ||
            (s.usedTriggersThisTurn[a.sharedUseLimit.key] ?? 0) <
              a.sharedUseLimit.n) &&
          (!a.reactive ||
            reactiveSkillPlayableCost(s, a.player, a.reactive) !== null),
      );
      const controller = (
        playable.some((a) => a.player === s.turnPlayer)
          ? s.turnPlayer
          : other(s.turnPlayer)
      ) as PlayerId;
      const abilities = playable.filter((a) => a.player === controller);
      if (abilities.length > 1) {
        pushPrompt(s, {
          type: "ruleAbilityChoice",
          player: controller,
          choices: abilities.map((a) => ({ id: a.id, label: a.label })),
        });
        return;
      }
      if (abilities.length === 1) {
        executeRuleAbility(s, abilities[0]);
        return;
      }
      finishRuleDown(s);
      if (s.prompts.length > 0) return;
      continue;
    }

    const candidates = ruleDownCandidates(s);
    if (candidates.length === 0) state.downBeforeLife = undefined;
    const lifePlayer = (
      state.downBeforeLife
        ? null
        : state.lifeDamage[s.turnPlayer] > 0
          ? s.turnPlayer
          : state.lifeDamage[other(s.turnPlayer)] > 0
            ? other(s.turnPlayer)
            : null
    ) as PlayerId | null;
    if (lifePlayer !== null) {
      applyOneLifeDamage(s, lifePlayer);
      if (s.prompts.length > 0 || s.phase !== "playing") return;
      continue;
    }

    if (candidates.length > 0) {
      const controller = (
        candidates.some((e) => e.player === s.turnPlayer)
          ? s.turnPlayer
          : other(s.turnPlayer)
      ) as PlayerId;
      const own = candidates.filter((e) => e.player === controller);
      if (own.length > 1) {
        pushPrompt(s, {
          type: "ruleDownChoice",
          player: controller,
          choices: own.map((e) => ({
            stackId: e.stack.id,
            label: positionedHolomenName(s, e.pos, e.stack),
          })),
        });
        return;
      }
      startRuleDown(s, own[0]);
      continue;
    }

    const defeatReasons = ([0, 1] as PlayerId[]).map((pid) => {
      if (state.lifeDepleted[pid])
        return s.players[pid].name + "のライフが0になりました";
      if (allStacks(s.players[pid]).length === 0)
        return s.players[pid].name + "のステージにホロメンがいません";
      return null;
    });
    if (defeatReasons[0] || defeatReasons[1]) {
      delete s.ruleResolution;
      if (defeatReasons[0] && defeatReasons[1])
        setDraw(s, "お互いの敗北条件が同時に満たされました");
      else {
        const loser = (defeatReasons[0] ? 0 : 1) as PlayerId;
        setWinner(s, other(loser), defeatReasons[loser]!);
      }
      return;
    }
    const resume = state.resume;
    delete s.ruleResolution;
    runOps(s, resume);
    return;
  }
}

/** 11.1.2：能力の途中ではダウンを実行せず、次のチェックタイミングまで原因を残す。 */
function deferRuleDown(ctx: EffectContextData, cause: RuleDownCause): void {
  if (cause.targetStackId !== undefined)
    (ctx.pendingRuleCauses ??= {})[cause.targetStackId] = cause;
}

function beginRuleProcessing(
  s: GameState,
  resume: EffectContextData,
  cause?: RuleDownCause,
): void {
  if (s.phase !== "playing") return;
  // Q538 / 12.3.4：アーツ本文のダメージでHPを超えても、アーツダメージまで解決する。
  // 中断中の状態はctxへ保存し、JSON往復後に古い再開位置へ戻らないようにする。
  if (resume.rest.some((op) => op.t === "artDamage")) {
    if (cause) deferRuleDown(resume, cause);
    return;
  }
  const pendingCauses = resume.pendingRuleCauses ?? {};
  const pendingLife = resume.pendingLifeDamage ?? [0, 0];
  resume.pendingRuleCauses = undefined;
  resume.pendingLifeDamage = undefined;
  if (s.ruleResolution) {
    s.ruleResolution.lifeDamage[0] += pendingLife[0];
    s.ruleResolution.lifeDamage[1] += pendingLife[1];
    Object.assign(s.ruleResolution.causes, pendingCauses);
    if (cause?.targetStackId !== undefined)
      s.ruleResolution.causes[cause.targetStackId] = cause;
    return;
  }
  if (ruleDownCandidates(s).length === 0 && pendingLife.every((n) => n === 0))
    return;
  const causes: Record<number, RuleDownCause> = { ...pendingCauses };
  if (cause?.targetStackId !== undefined) causes[cause.targetStackId] = cause;
  s.ruleResolution = {
    resume,
    causes,
    lifeDamage: [pendingLife[0], pendingLife[1]],
    // 保留中のアーツ能力より先に致死対象を処理し、その後はQ160の1人ずつの順序を守る。
    downBeforeLife:
      pendingLife.some((n) => n > 0) && ruleDownCandidates(s).length > 0,
    lifeDepleted: [false, false],
  };
}

export function resolveRuleAbilityChoice(
  s: GameState,
  pid: PlayerId,
  id: string,
): void {
  const prompt = s.prompts[0];
  if (
    !prompt ||
    prompt.type !== "ruleAbilityChoice" ||
    prompt.player !== pid ||
    !prompt.choices.some((choice) => choice.id === id)
  )
    throw new Error("現在この能力は選べません");
  const ability = s.ruleResolution?.current?.abilities.find((a) => a.id === id);
  if (!ability || ability.player !== pid)
    throw new Error("選んだ能力が見つかりません");
  s.prompts.shift();
  executeRuleAbility(s, ability);
  advance(s);
}

export function resolveRuleDownChoice(
  s: GameState,
  pid: PlayerId,
  stackId: number,
): void {
  const prompt = s.prompts[0];
  if (
    !prompt ||
    prompt.type !== "ruleDownChoice" ||
    prompt.player !== pid ||
    !prompt.choices.some((choice) => choice.stackId === stackId)
  )
    throw new Error("現在このホロメンは選べません");
  const entry = findStackById(s, stackId);
  if (
    !entry ||
    entry.player !== pid ||
    entry.stack.damage < effectiveMaxHp(s, entry.stack)
  )
    throw new Error("選んだホロメンはダウン条件を満たしていません");
  s.prompts.shift();
  startRuleDown(s, entry);
  continueRuleProcessing(s);
  advance(s);
}

// 11.1.2 / 11.5: 能力ではライフダメージを増やし、カードの送付はチェック時に行う。
function loseLife(
  s: GameState,
  pid: PlayerId,
  n: number,
  ctx: EffectContextData,
) {
  if (n <= 0) return;
  if (s.ruleResolution) s.ruleResolution.lifeDamage[pid] += n;
  else (ctx.pendingLifeDamage ??= [0, 0])[pid] += n;
}

// 相手の能力によるライフ減少。対象がこのターン「ライフは相手の能力で減らない」なら無効化する
function loseLifeByOppAbility(
  s: GameState,
  targetPid: PlayerId,
  n: number,
  ctx: EffectContextData,
) {
  if (s.lifeImmuneFromOppTurn?.[targetPid] === s.turn) {
    log(s, targetPid, `相手の能力によるライフ減少 (-${n}) を無効にしました`);
    return;
  }
  loseLife(s, targetPid, n, ctx);
}
