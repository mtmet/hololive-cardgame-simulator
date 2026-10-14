import type {
  GameState,
  PlayerId,
  Prompt,
  StagePosition,
} from "../../game/types";
import * as E from "../../game/engine";
import { getCard } from "../../data/loader";

export function actionPhaseReason(
  game: GameState,
  seat: PlayerId,
  step: "main" | "performance",
): string | null {
  if (game.phase !== "playing") return "ゲームが進行中ではありません";
  if (game.turnPlayer !== seat) return "相手のターンです";
  if (game.prompts.length) return "カードの選択・効果の処理を完了してください";
  if (game.step !== step)
    return `${step === "main" ? "メイン" : "パフォーマンス"}ステップに使用できます`;
  return null;
}

/** 選択不可の付与先・Bloom先について、盤面の位置と実際の判定理由を表示する。 */
export function handTargetFailures(
  game: GameState,
  seat: PlayerId,
  uid: string,
  kind: "bloom" | "attach",
): { stackId: number; label: string; reason: string }[] {
  if (
    actionPhaseReason(game, seat, "main") ||
    !game.players[seat].hand.includes(uid)
  )
    return [];
  return E.allStacks(game.players[seat]).flatMap(({ stack, pos }) => {
    const result =
      kind === "bloom"
        ? E.canBloom(game, uid, pos)
        : E.canAttachSupportFromHand(game, uid, pos);
    return result.ok || !result.reason || stack.faceDown
      ? []
      : [
          {
            stackId: stack.id,
            label: `${E.posLabel(pos)}：${E.topCard(game, stack).name}`,
            reason: result.reason,
          },
        ];
  });
}

/** 手札で選んだ実カードだけの使用不可理由。閲覧中や付与カードには表示しない。 */
export function supportPlayabilityReason(
  game: GameState,
  handUid: string | undefined,
  canAct: boolean,
): string | null {
  if (
    !canAct ||
    !handUid ||
    !game.players[game.turnPlayer].hand.includes(handUid)
  )
    return null;
  const result = E.canPlaySupport(game, handUid);
  return result.ok ? null : (result.reason ?? null);
}

export interface AttachedSupportSelection {
  uid: string;
  from: { player: PlayerId; pos: StagePosition };
}

/**
 * 選択時と同じスタックに今も付いていて、現在の視点でカードを解決できる時だけ返す。
 * Online viewで非公開領域へ移った実UIDをgetCardへ渡さないための描画境界。
 */
export function attachedSupportCardId(
  game: GameState,
  selection: AttachedSupportSelection,
): string | undefined {
  const player = game.players[selection.from.player];
  const pos = selection.from.pos;
  const stack =
    pos === "center"
      ? player.center
      : pos === "collab"
        ? player.collab
        : player.back[pos.back];
  if (!stack || stack.faceDown || !stack.supports.includes(selection.uid))
    return undefined;
  return game.uidToCard[selection.uid];
}

export type HandTargetMode = { kind: "bloom" | "attach"; uid: string };
export type ArtTargetMode = { fromPos: "center" | "collab"; artIndex: number };

/** 候補の強調とタップ受付で共用し、見た目と実際の選択先を一致させる。 */
export function selectableStackIds(
  game: GameState,
  seat: PlayerId,
  mode: {
    art?: ArtTargetMode | null;
    baton?: boolean;
    hand?: HandTargetMode | null;
    prompt?: Prompt;
  },
): Set<number> {
  const own = game.players[seat];
  if (mode.art) {
    const source = E.getStack(own, mode.art.fromPos);
    const art = source && E.availableArts(game, source)[mode.art.artIndex];
    return new Set(
      source && art
        ? E.legalArtTargets(game, seat, source, art).map(
            ({ stack }) => stack.id,
          )
        : [],
    );
  }
  if (mode.baton)
    return new Set(
      own.back.filter((_, i) => E.canBatonTouch(game, i).ok).map((st) => st.id),
    );
  if (mode.hand) {
    const hand = mode.hand;
    if (
      game.phase !== "playing" ||
      game.step !== "main" ||
      game.turnPlayer !== seat ||
      game.prompts.length > 0 ||
      !own.hand.includes(hand.uid)
    )
      return new Set();
    return new Set(
      E.allStacks(own)
        .filter(({ pos }) =>
          hand.kind === "bloom"
            ? E.canBloom(game, hand.uid, pos).ok
            : E.canAttachSupportFromHand(game, hand.uid, pos).ok,
        )
        .map(({ stack }) => stack.id),
    );
  }
  const prompt = mode.prompt;
  if (!prompt || prompt.player !== seat) return new Set();
  if (prompt.type === "cheerAssign")
    return new Set(
      E.cheerAssignCandidates(game, prompt).map(({ stack }) => stack.id),
    );
  if (prompt.type === "chooseCenter") {
    const movable = own.back.filter((st) => !E.hasNoSwitch(game, st));
    const hasActive = movable.some((st) => !st.resting);
    return new Set(
      movable.filter((st) => !hasActive || !st.resting).map((st) => st.id),
    );
  }
  if (prompt.type === "effectAttach") {
    const card = getCard(game.uidToCard[prompt.uid]);
    return new Set(
      card.cardType === "support"
        ? E.allStacks(own)
            .filter(
              ({ pos, stack }) =>
                E.effectAttachTargetError(game, prompt, pos, stack, card) ===
                null,
            )
            .map(({ stack }) => stack.id)
        : [],
    );
  }
  if (prompt.type === "effectTarget") {
    const ctx =
      prompt.perspective === undefined
        ? prompt.ctx
        : { ...prompt.ctx, player: prompt.perspective };
    return new Set(
      E.targetCandidates(game, ctx, prompt.target, prompt.filter)
        .filter(({ stack }) => {
          if (
            !prompt.damageAllocation &&
            prompt.chosen.some((chosen) => chosen.stackId === stack.id)
          )
            return false;
          if (
            prompt.eligibleStackIds &&
            !prompt.eligibleStackIds.includes(stack.id)
          )
            return false;
          if (!prompt.distinctColors) return true;
          const colors = E.stackColors(game, stack);
          return !prompt.chosen.some((chosen) => {
            const previous = E.findStackById(game, chosen.stackId);
            return (
              previous &&
              E.stackColors(game, previous.stack).some((color) =>
                colors.includes(color),
              )
            );
          });
        })
        .map(({ stack }) => stack.id),
    );
  }
  return new Set();
}
