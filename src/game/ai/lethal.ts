// ============================================================
// 確定リーサルソルバー
// パフォーマンスステップの「センター/コラボから各1回」のアーツ列を
// 深さ2まで全列挙する。サイコロ等の上振れは数えず、防御側の公開軽減は
// 最大限使われる前提にするため、返すのは保守的な確定勝ち筋だけとなる。
// ============================================================
import type { OshiCard } from "../../data/types";
import { applyGameAction, type GameAction } from "../actions";
import { parseOshiReactive } from "../effects";
import {
  availableArts,
  cardOf,
  damageTakenDeltaOf,
  effectiveMaxHp,
  getStack,
  giftOf,
  passiveOf,
  stackColors,
  topCard,
} from "../engine";
import type {
  GameState,
  HolomenStack,
  PlayerId,
  StagePosition,
} from "../types";
import { enumerateTurnActions, tryAction } from "./legalMoves";

const MAX_ATTACKS = 2;

function other(seat: PlayerId): PlayerId {
  return (1 - seat) as PlayerId;
}

function posKey(pos: StagePosition): string {
  return typeof pos === "string" ? pos : `back:${pos.back}`;
}

function stageEntries(s: GameState, seat: PlayerId) {
  const p = s.players[seat];
  const entries: { pos: StagePosition; stack: HolomenStack }[] = [];
  if (p.center) entries.push({ pos: "center", stack: p.center });
  if (p.collab) entries.push({ pos: "collab", stack: p.collab });
  p.back.forEach((stack, back) => entries.push({ pos: { back }, stack }));
  return entries;
}

/** 公開情報から分かる、1回のアーツが必ず与える最小ダメージ。 */
export function minimumGuaranteedArtDamage(
  s: GameState,
  seat: PlayerId,
  action: Extract<GameAction, { type: "useArts" }>,
): number {
  const attacker = getStack(s.players[seat], action.fromPos);
  const targetEntry = stageEntries(s, other(seat)).find(
    (entry) => posKey(entry.pos) === posKey(action.targetPos),
  );
  if (!attacker || !targetEntry) return 0;
  const art = availableArts(s, attacker)[action.artIndex];
  if (!art) return 0;

  // 印刷された基本打点と特攻だけを加点する。常時アーツ加算も、アーツ効果が
  // 先にエール/付与カードを動かして値を失わせる可能性があるため数えない。
  // 説明中のサイコロや条件分岐で加わる打点も一切足さない。
  let damage = parseInt(art.power, 10) || 0;
  if (
    art.special_attack.target &&
    stackColors(s, targetEntry.stack).includes(art.special_attack.target)
  )
    damage += parseInt(art.special_attack.power ?? "0", 10) || 0;
  // 受けるダメージ修正は減少分だけを採用し、公開されている増加分には頼らない。
  damage += Math.min(
    0,
    damageTakenDeltaOf(s, targetEntry, {
      art: true,
      source: { pos: action.fromPos, stack: attacker },
    }),
  );
  damage += Math.min(
    0,
    giftOf(topCard(s, targetEntry.stack)).artDamageTaken ?? 0,
  );

  // 公開されている「最初のアーツ軽減」は、この攻撃で未消費と仮定する。
  for (const modifier of s.turnModifiers)
    if (
      modifier.stackId === targetEntry.stack.id &&
      modifier.firstArtDamageReduce !== undefined
    )
      damage -= modifier.firstArtDamageReduce;

  // 装着カードの任意軽減は、条件が不成立かもしれなくても使用可能とみなす。
  for (const uid of targetEntry.stack.supports) {
    const card = cardOf(s, uid);
    if (card.cardType !== "support") continue;
    const passive = passiveOf(card);
    if (passive.noDamage) return 0;
    damage -= passive.damageReduce?.value ?? 0;
  }

  const defender = s.players[other(seat)];
  const oshi = cardOf(s, defender.oshiUid) as OshiCard;
  let reactiveReduce = 0;
  for (const skill of [oshi.oshiSkill, oshi.spOshiSkill]) {
    const reactive = parseOshiReactive(skill?.description);
    if (!reactive || reactive.when !== "damagedByOpp") continue;
    // 効果型・身代わり型の下限を一般に証明できないため確定打点を0とする。
    if (reactive.ops || reactive.redirect) return 0;
    reactiveReduce = Math.max(reactiveReduce, reactive.reduce ?? 0);
  }
  damage -= reactiveReduce;

  // 盤面のサイコロ軽減は最良の目が出る前提。無効化の目があれば0。
  for (const { stack } of stageEntries(s, other(seat))) {
    const gift = giftOf(topCard(s, stack));
    if (gift.artImmuneAuras && gift.artImmuneAuras.length > 0) return 0;
    const reduce = gift.allyDamageDiceReduce;
    if (!reduce) continue;
    if (reduce.oddNegate) return 0;
    damage -= Math.max(reduce.oddReduce ?? 0, reduce.evenReduce ?? 0);
  }
  if (giftOf(topCard(s, targetEntry.stack)).noDamageSelf) return 0;

  return Math.max(0, damage);
}

interface AbstractTarget {
  pos: StagePosition;
  stack: HolomenStack;
  remainingHp: number;
}

interface SearchState {
  targets: AbstractTarget[];
  life: number;
  usedSources: Set<"center" | "collab">;
}

/**
 * このターンにアーツだけで確実に勝てる列を返す。mainでは
 * goPerformanceを適用して即座にperformanceへ入れる時だけ、その操作を先頭に置く。
 */
export function findLethalPlan(
  state: GameState,
  seat: PlayerId,
): GameAction[] | null {
  if (
    state.phase !== "playing" ||
    state.turnPlayer !== seat ||
    state.prompts.length > 0
  )
    return null;

  let s = state;
  const prefix: GameAction[] = [];
  if (s.step === "main") {
    const goPerformance: GameAction = { type: "goPerformance" };
    try {
      s = applyGameAction(s, seat, goPerformance, () => 0.5);
    } catch {
      return null;
    }
    if (s.phase === "finished")
      return s.winner === seat ? [goPerformance] : null;
    if (s.step !== "performance" || s.prompts.length > 0) return null;
    prefix.push(goPerformance);
  }
  if (s.step !== "performance") return null;

  const initial: SearchState = {
    targets: stageEntries(s, other(seat)).map(({ pos, stack }) => ({
      pos,
      stack,
      remainingHp: Math.max(0, effectiveMaxHp(s, stack) - stack.damage),
    })),
    life: s.players[other(seat)].life.length,
    usedSources: new Set(),
  };

  const attacks = enumerateTurnActions(s, seat)
    .map((candidate) => candidate.action)
    .filter(
      (action): action is Extract<GameAction, { type: "useArts" }> =>
        action.type === "useArts" && tryAction(s, seat, action),
    );

  const dfs = (current: SearchState, depth: number): GameAction[] | null => {
    if (depth >= MAX_ATTACKS) return null;
    for (const action of attacks) {
      if (current.usedSources.has(action.fromPos)) continue;
      const targetIndex = current.targets.findIndex(
        (target) => posKey(target.pos) === posKey(action.targetPos),
      );
      if (targetIndex < 0) continue;
      const damage = minimumGuaranteedArtDamage(s, seat, action);
      if (damage <= 0) continue;

      const nextTargets = current.targets.map((target) => ({ ...target }));
      const target = nextTargets[targetIndex];
      target.remainingHp -= damage;
      const usedSources = new Set(current.usedSources).add(action.fromPos);
      if (target.remainingHp <= 0) {
        const life = current.life - topCard(s, target.stack).lifeOnDown;
        nextTargets.splice(targetIndex, 1);
        if (life <= 0 || nextTargets.length === 0) return [action];
        // センターダウン後は相手がバックから新センターを選ぶため、その先の
        // 具体的なtargetPosを確定できない。次の決定時に再探索する。
        if (target.pos === "center") continue;
        const tail = dfs(
          { targets: nextTargets, life, usedSources },
          depth + 1,
        );
        if (tail) return [action, ...tail];
      } else {
        const tail = dfs(
          { targets: nextTargets, life: current.life, usedSources },
          depth + 1,
        );
        if (tail) return [action, ...tail];
      }
    }
    return null;
  };

  const plan = dfs(initial, 0);
  return plan ? [...prefix, ...plan] : null;
}
