// ============================================================
// CPUの合法手列挙
// - 手番アクション: engineの可否判定関数を使って正確に列挙する
// - プロンプト解決: 全20種を網羅し、解決候補のGameActionを作る
// verify=true の候補は列挙が近似のため、採用前にクローンへの
// 試行適用 (tryAction) で最終確認する。verifyなしの候補は
// engineの検証と同条件で列挙しており、そのまま適用できる。
// ============================================================
import { applyGameAction, type GameAction } from "../actions";
import type {
  GameState,
  HolomenStack,
  PlayerId,
  PlayerState,
  Prompt,
  StagePosition,
} from "../types";
import {
  canBatonTouch,
  canBloom,
  canPlaySupport,
  canUseOshiSkill,
  cardOf,
  mulliganRequired,
  cardMatchesFilter,
  cheerAssignCandidates,
  findStackById,
  stackColors,
  stageCount,
  targetCandidates,
  usableArts,
  usableGiftAbilities,
} from "../engine";
import { shuffledBy } from "./types";

export interface CandidateMove {
  action: GameAction;
  /** 列挙が近似のため、採用前にクローン検証が必要な候補 */
  verify?: boolean;
}

/** 現在行動すべき席 (プロンプト所有者、なければ手番プレイヤー) */
export function activeSeatOf(s: GameState): PlayerId | null {
  if (s.phase === "finished") return null;
  const prompt = s.prompts[0];
  if (prompt) return prompt.player;
  if (s.phase !== "playing") return null;
  return s.turnPlayer;
}

/** クローンに適用して合法かどうかだけを確かめる (元状態は変更しない) */
export function tryAction(
  s: GameState,
  seat: PlayerId,
  action: GameAction,
): boolean {
  try {
    // 合法性確認は結果を捨てる仮想適用なので、実対局の乱数を消費しない。
    applyGameAction(s, seat, action, () => 0.5);
    return true;
  } catch {
    return false;
  }
}

function stagePositions(p: PlayerState): StagePosition[] {
  const list: StagePosition[] = [];
  if (p.center) list.push("center");
  if (p.collab) list.push("collab");
  p.back.forEach((_, i) => list.push({ back: i }));
  return list;
}

/**
 * エールを cost 枚支払う選び方を、**中身が違うものだけ**列挙する。
 * 同じカードが複数付いていても選び分ける意味は無いので、カードIDの
 * 組合せで重複を潰し、CPUの分岐数を必要最小限に保つ。
 */
function distinctYellPayments(
  s: GameState,
  yells: string[],
  cost: number,
): string[][] {
  if (cost <= 0 || cost > yells.length) return [];
  const out: string[][] = [];
  const seen = new Set<string>();
  const pick = (start: number, chosen: string[]): void => {
    if (chosen.length === cost) {
      const key = chosen
        .map((u) => cardOf(s, u).id)
        .sort()
        .join("|");
      if (!seen.has(key)) {
        seen.add(key);
        out.push([...chosen]);
      }
      return;
    }
    for (let i = start; i <= yells.length - (cost - chosen.length); i++) {
      chosen.push(yells[i]!);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
}

// ------------------------------------------------------------
// 手番アクション (プロンプトなし・自分のターン)
// ------------------------------------------------------------

export function enumerateTurnActions(
  s: GameState,
  seat: PlayerId,
): CandidateMove[] {
  if (
    s.phase !== "playing" ||
    s.turnPlayer !== seat ||
    s.prompts.length > 0 ||
    (s.step !== "main" && s.step !== "performance")
  )
    return [];
  const moves: CandidateMove[] = [];
  const p = s.players[seat];

  if (s.step === "main") {
    // 手札のDebut/Spotをステージに出す
    if (stageCount(p) < 6 && p.back.length < 5)
      for (const uid of p.hand) {
        const c = cardOf(s, uid);
        if (
          c.cardType === "holomen" &&
          (c.bloomLevel === "Debut" || c.bloomLevel === "Spot")
        )
          moves.push({ action: { type: "playHolomen", handUid: uid } });
      }

    // Bloom (手札の1st/2nd × ステージ各スタック)
    for (const uid of p.hand) {
      const c = cardOf(s, uid);
      if (
        c.cardType !== "holomen" ||
        (c.bloomLevel !== "1st" && c.bloomLevel !== "2nd")
      )
        continue;
      for (const pos of stagePositions(p))
        if (canBloom(s, uid, pos).ok)
          moves.push({ action: { type: "bloom", handUid: uid, pos } });
    }

    // コラボ (hasNoSwitch等の内部条件はverifyで確認)
    if (!p.usedCollabThisTurn && !p.collab && p.deck.length > 0)
      p.back.forEach((st, backIndex) => {
        if (!st.resting)
          moves.push({ action: { type: "collab", backIndex }, verify: true });
      });

    // バトンタッチ。どのエールをアーカイブするかでセンターに残る色が変わり、
    // 交代後のアーツの支払い可否まで変わるので、支払い方ごとに列挙する。
    p.back.forEach((_, backIndex) => {
      const check = canBatonTouch(s, backIndex);
      if (!check.ok) return;
      const payments = distinctYellPayments(
        s,
        p.center?.yells ?? [],
        check.cost,
      );
      if (payments.length <= 1) {
        // 選択の余地が無ければエンジンの既定 (先頭から) に任せる
        moves.push({ action: { type: "batonTouch", backIndex } });
        return;
      }
      for (const yellUids of payments)
        moves.push({ action: { type: "batonTouch", backIndex, yellUids } });
    });

    // サポート使用 (付与型は付け先ごとに列挙)
    for (const uid of p.hand) {
      const c = cardOf(s, uid);
      if (c.cardType !== "support" || !canPlaySupport(s, uid).ok) continue;
      const attaching =
        c.supportType === "ツール" ||
        c.supportType === "マスコット" ||
        c.supportType === "ファン";
      if (attaching) {
        for (const pos of stagePositions(p))
          moves.push({
            action: { type: "playSupport", handUid: uid, pos },
            verify: true,
          });
      } else {
        // 「状態を変えられないサポートは使えない」等の残り条件をverifyで確認
        moves.push({
          action: { type: "playSupport", handUid: uid },
          verify: true,
        });
      }
    }

    // 推しスキル
    for (const sp of [false, true] as const)
      if (canUseOshiSkill(s, sp).ok)
        moves.push({ action: { type: "useOshiSkill", sp } });

    // 起動型ギフト能力
    for (const ref of usableGiftAbilities(s, seat))
      moves.push({
        action: {
          type: "useGiftAbility",
          stackId: ref.stackId,
          index: ref.index,
          ...(ref.supportUid !== undefined
            ? { supportUid: ref.supportUid }
            : {}),
          ...(ref.archiveUid !== undefined
            ? { archiveUid: ref.archiveUid }
            : {}),
        },
      });

    moves.push({ action: { type: "goPerformance" } });
    moves.push({ action: { type: "endTurn" } });
  }

  if (s.step === "performance") {
    const opp = s.players[seat === 0 ? 1 : 0];
    for (const fromPos of ["center", "collab"] as const) {
      const usable = usableArts(s, fromPos);
      // 対象制限 (挑発/バック対象拡張/センター限定) はverifyで確認
      for (const artIndex of usable)
        for (const targetPos of stagePositions(opp))
          moves.push({
            action: { type: "useArts", fromPos, artIndex, targetPos },
            verify: true,
          });
    }
    moves.push({ action: { type: "endTurn" } });
  }

  return moves;
}

// ------------------------------------------------------------
// プロンプト解決候補
// ------------------------------------------------------------

/** k枚選ぶ代表的な組合せを作る (先頭k・ランダム数個。重複は除去) */
function pickSamples(
  eligible: readonly string[],
  min: number,
  max: number,
  rng: () => number,
  preserveOrder = false,
): string[][] {
  const kMin = Math.max(0, Math.min(min, eligible.length));
  const kMax = Math.max(kMin, Math.min(max, eligible.length));
  const seen = new Set<string>();
  const results: string[][] = [];
  const push = (uids: string[]) => {
    const key = (preserveOrder ? uids : [...uids].sort()).join(",");
    if (seen.has(key)) return;
    seen.add(key);
    results.push(uids);
  };
  push(eligible.slice(0, kMin));
  push(eligible.slice(0, kMax));
  for (let attempt = 0; attempt < 6; attempt++) {
    const k = kMin + Math.floor(rng() * (kMax - kMin + 1));
    push(shuffledBy(eligible, rng).slice(0, k));
  }
  return results;
}

/** 同じタグを共有するk枚の組合せ (「同じタグを持つホロメンX枚」用) */
function sameTagSamples(
  s: GameState,
  eligible: readonly string[],
  count: number,
  rng: () => number,
): string[][] {
  const byTag = new Map<string, string[]>();
  for (const uid of eligible) {
    const c = cardOf(s, uid);
    const tags = "tags" in c ? c.tags : [];
    for (const tag of tags) {
      const list = byTag.get(tag) ?? [];
      list.push(uid);
      byTag.set(tag, list);
    }
  }
  const results: string[][] = [];
  for (const members of byTag.values())
    if (members.length >= count) {
      results.push(members.slice(0, count));
      results.push(shuffledBy(members, rng).slice(0, count));
    }
  return results;
}

function effectTargetCandidates(
  s: GameState,
  prompt: Extract<Prompt, { type: "effectTarget" }>,
): CandidateMove[] {
  const perspectiveCtx =
    prompt.perspective !== undefined
      ? { ...prompt.ctx, player: prompt.perspective }
      : prompt.ctx;
  const chosenIds = new Set(prompt.chosen.map((c) => c.stackId));
  const chosenColors = prompt.distinctColors
    ? prompt.chosen.flatMap((c) => {
        const entry = findStackById(s, c.stackId);
        return entry ? stackColors(s, entry.stack) : [];
      })
    : [];
  return targetCandidates(s, perspectiveCtx, prompt.target, prompt.filter)
    .filter(
      (entry) => prompt.damageAllocation || !chosenIds.has(entry.stack.id),
    )
    .filter(
      (entry) =>
        !prompt.eligibleStackIds ||
        prompt.eligibleStackIds.includes(entry.stack.id),
    )
    .filter(
      (entry) =>
        !prompt.distinctColors ||
        !stackColors(s, entry.stack).some((c) => chosenColors.includes(c)),
    )
    .map((entry) => ({
      action: {
        type: "resolveEffectTarget",
        targetPlayer: entry.player,
        pos: entry.pos,
      },
    }));
}

function effectPickCandidates(
  s: GameState,
  seat: PlayerId,
  prompt: Extract<Prompt, { type: "effectPickCard" }>,
  rng: () => number,
): CandidateMove[] {
  let eligible = prompt.uids.filter(
    (uid) =>
      !prompt.pickFilter || cardMatchesFilter(s, seat, uid, prompt.pickFilter),
  );
  if (prompt.pickFilter?.distinctPick) {
    const names = new Set<string>();
    eligible = eligible.filter((uid) => {
      const name = cardOf(s, uid).name;
      if (names.has(name)) return false;
      names.add(name);
      return true;
    });
  }
  const min = prompt.zeroOrMin !== undefined ? 0 : prompt.pickMin;
  const selections = pickSamples(
    eligible,
    min,
    prompt.pickMax,
    rng,
    !!prompt.orderMatters,
  ).filter(
    (uids) =>
      prompt.zeroOrMin === undefined ||
      uids.length === 0 ||
      uids.length >= prompt.zeroOrMin,
  );
  if (prompt.uidPickGroups) {
    const grouped = prompt.uidPickGroups.flatMap((group) =>
      group.uids
        .filter((uid) => eligible.includes(uid))
        .slice(0, group.pickMin),
    );
    if (
      new Set(grouped).size === grouped.length &&
      grouped.length >= prompt.pickMin &&
      grouped.length <= prompt.pickMax
    )
      selections.push(grouped);
  }
  // グループ割当・同名制約はverify (クローン試行) が最終判定する
  return selections.map((uids) => ({
    action: { type: "resolveEffectPickCard", uids },
    verify: true,
  }));
}

function stacksOf(p: PlayerState): { pos: StagePosition; st: HolomenStack }[] {
  const list: { pos: StagePosition; st: HolomenStack }[] = [];
  if (p.center) list.push({ pos: "center", st: p.center });
  if (p.collab) list.push({ pos: "collab", st: p.collab });
  p.back.forEach((st, i) => list.push({ pos: { back: i }, st }));
  return list;
}

export function promptCandidates(
  s: GameState,
  seat: PlayerId,
  rng: () => number,
): CandidateMove[] {
  const prompt = s.prompts[0];
  if (!prompt || prompt.player !== seat) return [];
  const p = s.players[seat];
  switch (prompt.type) {
    case "mulliganChoice":
      return [
        ...(!mulliganRequired(s, seat)
          ? [{ action: { type: "resolveMulligan" as const, redraw: false } }]
          : []),
        { action: { type: "resolveMulligan", redraw: true } },
      ];
    case "liveStart":
      return [{ action: { type: "resolveLiveStart" } }];
    case "setupReveal":
      return [{ action: { type: "resolveSetupReveal" } }];
    case "animationDelay":
      return [{ action: { type: "resolveAnimationDelay" } }];
    case "placeCenter":
      return p.hand
        .filter((uid) => {
          const c = cardOf(s, uid);
          return c.cardType === "holomen" && c.bloomLevel === "Debut";
        })
        .map((uid) => ({
          action: { type: "resolvePlaceCenter", handUid: uid },
        }));
    case "placeBack": {
      const moves: CandidateMove[] = [];
      if (stageCount(p) < 6 && p.back.length < 5)
        for (const uid of p.hand) {
          const c = cardOf(s, uid);
          if (
            c.cardType === "holomen" &&
            (c.bloomLevel === "Debut" || c.bloomLevel === "Spot")
          )
            moves.push({
              action: { type: "resolvePlaceBackOne", handUid: uid },
            });
        }
      moves.push({ action: { type: "resolvePlaceBackDone" } });
      return moves;
    }
    case "mulliganPenalty":
      return pickSamples(p.hand, prompt.count, prompt.count, rng).map(
        (uids) => ({ action: { type: "resolveMulliganPenalty", uids } }),
      );
    case "cheerAssign":
      return cheerAssignCandidates(s, prompt).map(({ pos }) => ({
        action: { type: "resolveCheerAssign", pos },
      }));
    case "chooseCenter":
      return p.back.map((_, backIndex) => ({
        action: { type: "resolveChooseCenter", backIndex },
        verify: true,
      }));
    case "ruleAbilityChoice":
      return prompt.choices.map((choice) => ({
        action: { type: "resolveRuleAbilityChoice", id: choice.id },
      }));
    case "ruleDownChoice":
      return prompt.choices.map((choice) => ({
        action: { type: "resolveRuleDownChoice", stackId: choice.stackId },
      }));
    case "triggerAbilityChoice":
      return prompt.abilities.map((ability) => ({
        action: { type: "resolveTriggerAbilityChoice", id: ability.id },
      }));
    case "damageReplacementChoice":
      return prompt.choices.map((choice) => ({
        action: { type: "resolveDamageReplacementChoice", id: choice.id },
      }));
    case "effectTarget":
      return effectTargetCandidates(s, prompt);
    case "effectPickCard":
      return effectPickCandidates(s, seat, prompt, rng);
    case "effectArchiveHand": {
      const eligible = prompt.eligible ?? p.hand;
      const max = prompt.countMax ?? prompt.count;
      const selections = prompt.sameTag
        ? [
            ...sameTagSamples(s, eligible, prompt.count, rng),
            ...pickSamples(eligible, prompt.count, max, rng),
          ]
        : pickSamples(eligible, prompt.count, max, rng);
      return selections.map((uids) => ({
        action: { type: "resolveEffectArchiveHand", uids },
        verify: true,
      }));
    }
    case "effectAttach": {
      const exclude = prompt.excludeStackId;
      return stacksOf(p)
        .filter(({ st }) => exclude === undefined || st.id !== exclude)
        .map(({ pos }) => ({
          action: { type: "resolveEffectAttach", pos },
          // 名称制限/汎用フィルタはverifyで確認
          verify: true,
        }));
    }
    case "effectConfirm": {
      const moves: CandidateMove[] = [
        { action: { type: "resolveEffectConfirm", yes: true }, verify: true },
        { action: { type: "resolveEffectConfirm", yes: false } },
      ];
      return moves;
    }
    case "reactiveSkill":
      return [
        { action: { type: "resolveReactiveSkill", use: true } },
        { action: { type: "resolveReactiveSkill", use: false } },
      ];
    case "declareDice":
      return [1, 2, 3, 4, 5, 6].map((value) => ({
        action: { type: "resolveDeclareDice", value },
      }));
    case "jankenHand":
      return (["rock", "scissors", "paper"] as const).map((hand) => ({
        action: { type: "resolveJankenHand", hand },
      }));
    default: {
      // プロンプト追加時にここでコンパイルエラーにする
      const exhaustive: never = prompt;
      throw new Error(`未対応のプロンプトです: ${(exhaustive as Prompt).type}`);
    }
  }
}

/** 現局面でCPU席が取れる候補一覧 (プロンプト優先) */
export function enumerateCandidates(
  s: GameState,
  seat: PlayerId,
  rng: () => number,
): CandidateMove[] {
  if (s.prompts.length > 0) return promptCandidates(s, seat, rng);
  return enumerateTurnActions(s, seat);
}
