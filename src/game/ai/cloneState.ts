import type { GameState } from "../types";

declare const simulationOwner: unique symbol;
/** 呼び出し元が占有し、他の枝や実局面と共有しないコピー。 */
export type OwnedSimulationState = GameState & {
  readonly [simulationOwner]: true;
};

/**
 * 探索用の状態コピー。GameState はプレーンなオブジェクト・配列・プリミティブで
 * 構成される。ネイティブの構造化転送より軽く、同じオブジェクトへの参照も保つ。
 * 状態型に他のオブジェクトが加わった場合は structuredClone へ委ねる。
 * どの可変領域も共有しないので、失敗した仮想操作は入力を汚さない。
 */
export function cloneSimulationState(state: GameState): OwnedSimulationState {
  const seen = new Map<object, unknown>();
  const needsNativeClone = Symbol();
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const result: unknown[] = new Array(value.length);
      seen.set(value, result);
      for (let index = 0; index < value.length; index++)
        if (index in value) result[index] = copy(value[index]);
      return result;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw needsNativeClone;
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const key of Object.keys(value)) {
      const item = copy((value as Record<string, unknown>)[key]);
      if (key === "__proto__")
        Object.defineProperty(result, key, {
          value: item,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      else result[key] = item;
    }
    return result;
  };
  try {
    return copy(state) as OwnedSimulationState;
  } catch (error) {
    if (error !== needsNativeClone) throw error;
    return structuredClone(state) as OwnedSimulationState;
  }
}
