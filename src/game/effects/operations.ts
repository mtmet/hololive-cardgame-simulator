// カード本文の解析：operations。
import type { Op } from "./types";

/** ops 内の最後の effectBloom を探す (if/ifElse/optionalCost の中も再帰的に見る) */
export function findLastEffectBloom(
  ops: Op[],
): Extract<Op, { t: "effectBloom" }> | null {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.t === "effectBloom") return op;
    if (op.t === "if" || op.t === "ifElse" || op.t === "optionalCost") {
      const inner = findLastEffectBloom(op.then);
      if (inner) return inner;
    }
  }
  return null;
}

/** 条件分岐や任意コスト内を含め、効果のOpを再帰的に走査する。 */
function visitEffectOps(ops: Op[], visit: (op: Op) => void): void {
  for (const op of ops) {
    visit(op);
    switch (op.t) {
      case "if":
        visitEffectOps(op.then, visit);
        break;
      case "ifElse":
        visitEffectOps(op.then, visit);
        visitEffectOps(op.else, visit);
        break;
      case "optionalCost":
        visitEffectOps(op.cost, visit);
        visitEffectOps(op.then, visit);
        break;
      case "dice":
        for (const branch of op.branches) visitEffectOps(branch.ops, visit);
        if (op.aggOdd) visitEffectOps(op.aggOdd.ops, visit);
        break;
      case "diceVs":
        visitEffectOps(op.geOps, visit);
        visitEffectOps(op.ltOps, visit);
        break;
      case "chooseOps":
        visitEffectOps(op.thenOps, visit);
        visitEffectOps(op.elseOps, visit);
        break;
      case "artDiceParityBranch":
        visitEffectOps(op.oddOps, visit);
        visitEffectOps(op.evenOps, visit);
        break;
      case "janken":
        visitEffectOps(op.winOps, visit);
        break;
      case "repeatPerStage":
      case "offerReactiveSkill":
        visitEffectOps(op.ops, visit);
        break;
    }
  }
}

/** 「ダウンしてもライフは減らない」を内側のダメージ/ダウンにも適用する。 */
export function applyNoLifeRider(ops: Op[]): void {
  visitEffectOps(ops, (op) => {
    if (op.t === "special" || op.t === "down") op.noLife = true;
  });
}

/** 「数える枚数/人数はXまで」を内側の比例効果にも適用する。 */
export function applyCountCapRider(ops: Op[], max: number): void {
  visitEffectOps(ops, (op) => {
    if (op.t === "artPlusPer") op.max = max;
    else if (op.t === "special" && op.scaleBy) op.scaleMax = max;
    else if (op.t === "turnArtPlusPerBoundYell") op.max = max;
    else if (op.t === "turnArtPlusPerCount") op.max = max;
  });
}
