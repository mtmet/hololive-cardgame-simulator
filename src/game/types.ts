// ============================================================
// ゲーム状態の型定義
// ============================================================
import type { Color } from "../data/types";
import type {
  CardFilter,
  Op,
  StackTarget,
  TargetFilter,
  TriggerAbility,
} from "./effects";

export type PlayerId = 0 | 1;

/** じゃんけんで選ぶ手。通信時にもそのまま扱える安定した識別子。 */
export type JankenHand = "rock" | "scissors" | "paper";

/** ステージ上のホロメン1人 (Bloomで重なったカード群 + 付いているカード) */
export interface HolomenStack {
  /** 移動しても変わらない安定ID (修正値の追跡に使う) */
  id: number;
  /** ホロメンカードのuid列。先頭が一番上のカード */
  cards: string[];
  /** 付いているエールのuid */
  yells: string[];
  /** 付いているサポート(ツール/マスコット/ファン)のuid */
  supports: string[];
  /** 負っているダメージ */
  damage: number;
  /** お休み状態 (横向き) */
  resting: boolean;
  /** ゲーム準備中の裏向き状態 */
  faceDown: boolean;
  /** ステージに出たグローバルターン番号 (0 = ゲーム準備中) */
  enteredTurn: number;
  /** このターンにBloomしたか */
  bloomedThisTurn: boolean;
  /** このターン最初にBloomした時の、直前のBloomレベル（重なりが移動しても履歴として残る） */
  bloomedFromLevelThisTurn?: "Debut" | "1st" | "2nd" | "Spot";
  /** このパフォーマンスステップでアーツを使用したか */
  usedArtsThisTurn: boolean;
  /** 11.3 のダウン時能力を解決中 (同じホロメンへのダウン処理の再入を防ぐ) */
  downResolving?: boolean;
  /** 指定ターンに推しスキルで実際にアクティブになった履歴 */
  activatedByOshiSkills?: { turn: number; name: string; sp: boolean }[];
}

export type StagePosition = "center" | "collab" | { back: number };

export interface PlayerState {
  name: string;
  /** 推しホロメンのuid */
  oshiUid: string;
  /** 各領域のuidリスト。deck/cheerDeck/life は先頭が一番上 */
  deck: string[];
  cheerDeck: string[];
  hand: string[];
  archive: string[];
  /** 使用中のサポート。本文の解決が終わるまでアーカイブには数えない。 */
  resolvingSupports?: string[];
  holoPower: string[];
  /** 先頭が一番上（最後に置いたカード）。ライフ減少時は先頭から公開する。 */
  life: string[];
  center: HolomenStack | null;
  collab: HolomenStack | null;
  back: HolomenStack[];
  // ターン中フラグ
  usedOshiSkillThisTurn: boolean;
  /** このターンに使用した通常推しスキルの名前。名称指定の条件で参照する。 */
  usedOshiSkillNamesThisTurn?: string[];
  usedSpOshiSkill: boolean;
  /** ゲーム中に使用したSPスキルの出所とタイミング。ターン終了後も保持する。 */
  usedSpOshiSkillInfo?: {
    name: string;
    oshiName: string;
    turn: number;
    ownMainStep: boolean;
  };
  /** このターンにSP推しスキルを使ったか (「このターンに自分のSP推しスキルを使っていた時」条件用) */
  usedSpOshiSkillThisTurn?: boolean;
  usedLimitedThisTurn: boolean;
  /** このターンに使用したLIMITEDカードの枚数 */
  limitedUsedCount?: number;
  /** このターンに使えるLIMITEDカードの上限 (効果による変更。省略時1) */
  limitedLimit?: number;
  usedBatonTouchThisTurn: boolean;
  usedCollabThisTurn: boolean;
  /** このパフォーマンスステップ中にセンターポジションからアーツを使用したか (9.2.1.3) */
  usedCenterArtThisTurn: boolean;
  /** このパフォーマンスステップ中にコラボポジションからアーツを使用したか (9.2.1.4) */
  usedCollabArtThisTurn: boolean;
  // 準備中の引き直し管理
  mulliganCount: number;
  voluntaryMulliganDone: boolean;
}

export type Step = "reset" | "draw" | "cheer" | "main" | "performance" | "end";

/** 追加ターンを考慮した継続効果の期間。入力待ちの間も保持する。 */
export interface TurnEffectDuration {
  /** このグローバルターン番号まで有効 (省略時は現在ターンのみ) */
  expiresTurn?: number;
  /** 発生後、指定プレイヤーの最初のターン終了まで保持する。 */
  nextOpponentTurn?: {
    player: PlayerId;
    afterTurn: number;
    /** 「次の相手のターンの間」だけ有効。「終了まで」は即時から有効。 */
    onlyDuring?: boolean;
  };
}

/** ターン中の修正値 (このターンの間 アーツ+X / コスト修正) */
export interface TurnModifier extends TurnEffectDuration {
  additionalBloomLevel?: "2nd";
  artReduceFrom?: { level: "1st"; value: number };
  thirdArtBackTarget?: boolean;
  stackId: number;
  artPlus: number;
  /** アーツに必要な無色コストの軽減数 */
  artCostless?: number;
  /** アーツに必要な特定色コストの軽減 */
  artColorCostless?: { color: string; n: number };
  /** アーツをエールを必要とせずに使える */
  artsFree?: boolean;
  /** バトンタッチ・移動・交代できない */
  noSwitch?: boolean;
  /** バトンタッチに必要な無色コストの増減 */
  batonDelta?: number;
  /** すべての色を持つホロメンとして扱う */
  allColors?: boolean;
  /** このホロメンが相手に与える特殊ダメージ+X */
  specialPlus?: number;
  /** アーツを使った後、同じアーツをもう1回使える残り回数 */
  repeatArt?: number;
  /** repeatArt が任意 (「もう1回使える」。確認プロンプトを出す) */
  repeatArtOptional?: boolean;
  /** このホロメンのアーツに(色)特攻+Xを追加する */
  specialAttack?: { color: Color; value: number };
  /** アーツの対象拡張: この条件を満たす相手のバックホロメンも対象にできる ({}=バック全員) */
  artTargetExtend?: TargetFilter;
  /** 最初に受けるアーツダメージ-X (消費型: 1回適用したら削除される) */
  firstArtDamageReduce?: number;
  /** firstArtDamageReduce がこのポジションにいる時のみ適用 */
  firstArtDamagePos?: "center";
  /** このターン中、対象は特殊ダメージを受けない */
  specialImmune?: boolean;
  /** 自分のエンドステップ開始時にアーカイブするステージのエール枚数 */
  archiveStageYellAtEnd?: number;
}

/** 効果実行の中断点 (対象選択などの入力待ち) */
export interface EffectContextData {
  /** 効果のコントローラー */
  player: PlayerId;
  /** 発生源ホロメンのスタックID (アーツ等) */
  sourceStackId?: number;
  /**
   * 実行中のアーツを使ったホロメンのスタックID。
   * 誘発能力の解決で sourceStackId が一時的に能力の保持者へ変わっても、
   * 再使用するアーツの発生源を見失わないために保持する。
   */
  artSourceStackId?: number;
  /**
   * 初回使用時に確定した印刷上のアーツ定義。
   * 共有元の移動・消滅で availableArts の並びが変わっても、同じアーツを再使用する。
   */
  artRef?: { cardId: string; index: number };
  /** 発生源のサポートカードuid (「このカードをデッキに戻す」等が参照) */
  sourceCardUid?: string;
  /** トリガー元の付与サポートuid (「このツールを手札に戻す」等が参照) */
  sourceSupportUid?: string;
  /** 「能力追加」で付与先ホロメンが得た能力。サポートUIDは自身の移動等の参照用に残す。 */
  grantedSupportAbility?: boolean;
  /** 現在処理中のアーツダメージ対象 (複数対象では各対象へ切り替わる) */
  artTargetStackId?: number;
  /** この1回のアーツ使用で最初に選んだ対象 (「同じホロメンに」の固定用) */
  artPrimaryTargetStackId?: number;
  /** 実行中のアーツのindex (「このアーツをもう1回使う」の再構築用) */
  artIndex?: number;
  /** 実行中のアーツ名 (共有アーツを含む) */
  artName?: string;
  /** アーツ効果(サイコロ等)で予約された「もう1回使う」の回数 (ダメージ解決後のrepeatArtCheckで消費) */
  repeatPending?: number;
  /** 「同じホロメンに」と指定されたアーツ再使用の予約回数 */
  repeatSameTargetPending?: number;
  /** このアーツダメージは軽減されない */
  artNoReduce?: boolean;
  /** 同時に与える特殊ダメージ。全対象の防御を確認してから一括適用する。 */
  specialDamageBatch?: {
    targetStackId: number;
    damage: number;
    noLife?: boolean;
  }[];
  /** 能力終了のチェックタイミングまで、対象ごとのダウン原因を保持する。 */
  pendingRuleCauses?: Record<number, RuleDownCause>;
  /** 実行中のアーツダメージ累積 (アーツ効果のみ) */
  artBonus?: number;
  /** chooseBind で選択したホロメンのスタックID (直近) */
  boundStackId?: number;
  /** chooseBind で選択したホロメンのスタックID (複数選択の累積) */
  boundStackIds?: number[];
  /** ブルームエフェクト用: DebutからBloomしたか */
  bloomedFromDebut?: boolean;
  /** ブルームエフェクト用: BuzzホロメンからBloomしたか */
  bloomedFromBuzz?: boolean;
  /** この効果列を開始した推しスキル。対象固有の結果を記録するために使う */
  originOshiSkill?: { name: string; sp: boolean };
  /** この効果列で指定の推しスキルによりBloomしたスタック */
  bloomedByOshiSkill?: { name: string; sp: boolean; stackId: number };
  /** アーツ解決後: このアーツで相手をダウンさせたか */
  lastArtDowned?: boolean;
  /** アーツ解決後: ダウンさせた対象がいたポジション (「相手のセンターホロメンをダウンさせた時」の判定用) */
  lastArtDownedPos?: "center" | "collab" | { back: number };
  /** この1回のアーツ使用について使用時能力を発火済みか (分散ダメージの二重発火防止) */
  artUsedEmitted?: boolean;
  /** アーツ解決後: 与えたダメージが残りHPを超過した量 */
  lastOverkill?: number;
  /** アーツ解決後: このアーツで与えたダメージ (「与えたダメージXにつき」参照用) */
  lastArtDealt?: number;
  /** ダメージ時の推しスキル用: この誘発のきっかけになったダメージ量 */
  triggerDamage?: number;
  /** このアーツ実行中に振ったサイコロの出た目の合計 (「そのアーツでサイコロを振って出た目の合計数」参照用) */
  artDiceSum?: number;
  /** revealTop で公開したカードのuid */
  revealed?: string[];
  /** revealed は「公開」ではなく使用者だけが「見た」非公開カード */
  revealedOwnerOnly?: boolean;
  /** millDeck でアーカイブしたカードのuid */
  milled?: string[];
  /** 手札アーカイブを置換してアーカイブしたホロパワーのuid */
  replacementArchived?: string[];
  /** effectPickCard で選んで移動したカードのuid (「戻したホロメンX枚につき」等が参照) */
  pickedCards?: string[];
  /** bothHandToDeckBottom で両者がデッキに戻した枚数 [P0, P1] */
  returnedBoth?: [number, number];
  /** selfYellToCheerBottom でエールデッキに戻したエール枚数 */
  returnedYell?: number;
  /** この効果でここまでに回復したダメージの累計 (「回復したダメージXにつき」参照用) */
  healed?: number;
  /** downedOwnリアクティブ用: ダウンしたホロメンのカードuid (先頭がトップ。アーカイブ内) */
  downedCards?: string[];
  /** downedOwnリアクティブ用: ダウンしたホロメンに付いていたエールuid (アーカイブ内) */
  downedYells?: string[];
  /** downedOwnリアクティブ用: ダウンしたホロメンに付いていたサポートuid (アーカイブ内) */
  downedSupports?: string[];
  /** downedOwnリアクティブ用: 11.3.1.1 の解決中にステージ上に残っているホロメンのID */
  downedStackId?: number;
  /** 使用コストの支払い待ちで手札から抜いてある付与サポートと、その付け先 (attachPlayedSupportが消費) */
  pendingAttach?: { uid: string; pos: StagePosition };
  /** この効果で最後にサポートを付けた先のスタックID (「付けたなら、そのホロメンの〜」参照用) */
  attachedToStackId?: number;
  /** この効果でエール/サポートを付けた全スタックID */
  attachedToStackIds?: number[];
  /** 直前の付与Opで実際に付けられたサポートの枚数 */
  lastAttachedCount?: number;
  /** 解決中に誘発し、次のチェックタイミングまで待機する自動能力 */
  pendingTriggers?: {
    player: PlayerId;
    abilities: TriggerAbility[];
    label?: string;
  }[];
  /** 残りの Op 列 */
  rest: Op[];
  /** ログ用の効果名 */
  label: string;
}

/** プレイヤーの入力待ち */
/** 発動演出の後に差し込む待機の種別 */
export type FxWaitKind = "effect" | "oshiSkill" | "spOshiSkill";

export type Prompt =
  | { type: "mulliganChoice"; player: PlayerId }
  | {
      /** 両者の配置完了後、LIVE START演出が終わるまで公開を待機する */
      type: "liveStart";
      player: PlayerId;
      duration: number;
    }
  | {
      /** 全ホロメンの表向きアニメーションが終わるまで第1ターンを待機する */
      type: "setupReveal";
      player: PlayerId;
      duration: number;
    }
  | {
      /** 演出が完了するまで後続の効果解決を待機する内部プロンプト */
      type: "animationDelay";
      player: PlayerId;
      duration: number;
      animationLogId: number;
      /** 待機対象の演出種別 (未指定はサイコロ) */
      kind?: FxWaitKind;
      resume: boolean;
      ctx: EffectContextData;
    }
  | {
      /** 11.3.1.1.1: 同じプレイヤーがコントローラーであるダウン時能力の解決順選択 */
      type: "ruleAbilityChoice";
      player: PlayerId;
      choices: { id: string; label: string }[];
    }
  | {
      /** 11.3.2: 同じプレイヤーの複数ホロメンが同時にダウンする場合の処理順選択 */
      type: "ruleDownChoice";
      player: PlayerId;
      choices: { stackId: number; label: string }[];
    }
  | {
      /** 同じタイミングで誘発した能力の解決順選択 */
      type: "triggerAbilityChoice";
      player: PlayerId;
      abilities: TriggerAbility[];
      ctx: EffectContextData;
    }
  | {
      /** 10.11.2: 同時に適用可能な被ダメージ置換効果の適用順選択 */
      type: "damageReplacementChoice";
      player: PlayerId;
      choices: DamageReplacementChoice[];
      ctx: EffectContextData;
    }
  | { type: "placeCenter"; player: PlayerId }
  | { type: "mulliganPenalty"; player: PlayerId; count: number }
  | { type: "placeBack"; player: PlayerId }
  | {
      type: "cheerAssign";
      player: PlayerId;
      yellUid: string;
      reason: "cheerStep" | "life" | "effect";
      /** 効果による送付の場合の続き */
      ctx?: EffectContextData;
      /** 一括送付の途中ではコンテキストを後続へ渡し、最後だけ再開する */
      resume?: boolean;
      filter?: TargetFilter;
      /** 送付先のプレイヤー (省略時は操作プレイヤー自身。相手ホロメンへの付け替え用) */
      targetPlayer?: PlayerId;
      /** センター/コラボ(前列)のみ送付可 */
      frontOnly?: boolean;
      /** 同一ホロメンに送れる枚数の上限 (「ただし、ホロメン1人に送る枚数はX枚まで」) */
      perTargetMax?: number;
      /** この効果で送る全エールを同じホロメンへ送る */
      sameTarget?: boolean;
      /** sameTarget用: 最初の送付で確定した送り先 */
      requiredTargetStackId?: number;
      /** エールデッキ上からの同一送付の続き。送り先決定後に再開する */
      nextTopCheer?: Extract<Op, { t: "cheerFromTop" }>;
      /** 同じ一括効果の他の送付とは別のホロメンを選ぶ */
      distinctTargets?: boolean;
      /** distinctTargets用: 先行する送付で既に選ばれた送り先 */
      excludedTargetStackIds?: number[];
      /** perTargetMax用: この効果で既に送った枚数 (stackId→枚数)。解決時に後続プロンプトへ引き継ぐ */
      sentCounts?: Record<number, number>;
      /**
       * 付け替えで取り外す前に付いていたホロメン。同じホロメンを選び直した
       * 場合は「何もしない」(総合ルール5.17.4.1・1.3.2.1) 判定に使う。
       */
      originStackId?: number;
    }
  | { type: "chooseCenter"; player: PlayerId; reason: "reset" | "end" }
  // ---- 効果解決用 ----
  | {
      type: "effectTarget";
      player: PlayerId;
      /** 特殊ダメージの割り振りでは同じ対象を繰り返し選べる。 */
      damageAllocation?: boolean;
      /** 選択させる対象 */
      target: StackTarget;
      count: number;
      filter?: TargetFilter;
      /** 選択後に対象へ適用する Op */
      apply:
        | {
            t: "special";
            dmg: number;
            noLife?: boolean;
            /** 選択したバックと相手センターへの同時ダメージ。 */
            includeOppCenter?: boolean;
            /** 被弾側のリアクティブ確認を済ませたか (アーツダメージと同じ once ガード) */
            interruptChecked?: boolean;
            /** リアクティブで確定した軽減量 */
            extraReduce?: number;
            /** リアクティブで「そのダメージを受けない」が確定したか */
            negate?: boolean;
            /** 既にサイコロ軽減を提案したホルダーのスタックid */
            diceReduceDone?: number[];
            /** このダメージに対して使用/辞退済みの置換効果ID */
            replacementDone?: string[];
          }
        | { t: "heal"; value: number | "all" }
        | ({ t: "turnArtPlus"; value: number } & TurnEffectDuration)
        | { t: "setHp"; value: number }
        | { t: "bind" }
        | { t: "turnAllColors" }
        | { t: "swapCenter" }
        | { t: "swapCollab" }
        | { t: "moveToCollab" }
        | { t: "activate" }
        | { t: "rest" }
        | { t: "down"; noLife?: boolean }
        | { t: "changeArtTarget" }
        | { t: "toDeckBottom" }
        | { t: "devolve" }
        | ({ t: "turnNoSwitch" } & TurnEffectDuration)
        | ({
            t: "turnCostMod";
            artCostless?: number;
            artColorCostless?: { color: string; n: number };
            artsFree?: boolean;
            batonDelta?: number;
          } & TurnEffectDuration);
      /** 選択済みの対象 (複数選択用) */
      chosen: { player: PlayerId; stackId: number }[];
      /** filter だけでは表せない合法対象 (effectBloom のカード×対象組合せ等) */
      eligibleStackIds?: number[];
      /** 選ぶホロメン同士は異なる色でなければならない */
      distinctColors?: boolean;
      /** 候補列挙の視点プレイヤー (省略時はctx.player。相手に選ばせる効果用) */
      perspective?: PlayerId;
      ctx: EffectContextData;
    }
  | {
      type: "effectPickCard";
      player: PlayerId;
      /** 選択肢のuid */
      uids: string[];
      pickMin: number;
      pickMax: number;
      /** 選択可能なカードの条件 (uids内でもこれを満たすものだけ選べる) */
      pickFilter?: CardFilter;
      /** 種別ごとの選択枠 (「ホロメンX枚と(F)X枚」等。選択セットを枠に割り当てられるか検証) */
      pickGroups?: { filter: CardFilter; max: number }[];
      /** pickGroups内で同じカード名でなければならないグループのindex */
      sameNameGroups?: number[];
      /** UID集合ごとの選択枚数制約 (同じカード種別で出所だけが異なる選択用) */
      uidPickGroups?: {
        uids: string[];
        pickMin: number;
        pickMax: number;
      }[];
      /** 選んだカードの行き先 */
      dest:
        | "hand"
        | "stage"
        | "cheerDeck"
        | "deck"
        | "deckBottom"
        | "deckTop"
        | "cheerAssign"
        | "attach"
        | "holoPower"
        | "archive"
        | "bloom";
      /** 選択したカード名を全プレイヤーへ公開する。false は選択者だけに表示 */
      revealSelection?: boolean;
      /** 選択中の候補すべてが公開情報 */
      revealAll?: boolean;
      /** 残り(未選択)カードの扱い: none=元の場所に残す */
      restTo: "none" | "bottom" | "top" | "archive";
      /** restTo のカードを別プロンプトで好きな順に並べる */
      restOrder?: boolean;
      /** このプロンプト自体が順番指定専用 */
      orderOnly?: "bottom" | "top";
      /** UIで選択順が意味を持つことを明示する */
      orderMatters?: boolean;
      /** 任意効果で0枚、またはこの枚数以上だけを許可する */
      zeroOrMin?: number;
      /** UIに表示する順番指定の案内 */
      orderLabel?: string;
      /** 選択元 (uidsをそこから取り除く。stacked=ホロメンスタックの重なり) */
      from:
        | "deck"
        | "archive"
        | "cheer"
        | "hand"
        | "stageYells"
        | "stageSupports"
        | "holo"
        | "stacked"
        | "downed";
      /** 解決後にシャッフルする山 */
      shuffleAfter?: "deck" | "cheer";
      /** cheerAssign用: 送付先の条件 */
      targetFilter?: TargetFilter;
      /** from=stageYells の場合のエール所持プレイヤー (省略時はplayer) */
      yellOwner?: PlayerId;
      /** from=stageSupports の場合のサポート所持プレイヤー (省略時はplayer。アーカイブ先も同じ) */
      supportOwner?: PlayerId;
      /** from=archive の場合のアーカイブ所持プレイヤー (省略時はplayer) */
      archiveOwner?: PlayerId;
      /** dest=cheerAssign用: 送付先のホロメンを持つプレイヤー (相手ホロメンへの付け替え用) */
      cheerTargetPlayer?: PlayerId;
      /** dest=cheerAssign用: 選択順ごとに異なる送付先条件 */
      cheerTargetGroups?: TargetFilter[];
      /** cheerTargetGroupsごとに別のホロメンへ送る */
      distinctCheerTargets?: boolean;
      /** dest=cheerAssign用: 同一ホロメンに送れる枚数の上限 */
      perTargetMax?: number;
      /** dest=cheerAssign/attach用: 選んだカードをすべて同じホロメンへ送る */
      sameTarget?: boolean;
      /** ctx.pickedCards を更新しない (順番指定専用) */
      preservePickedCards?: boolean;
      ctx: EffectContextData;
    }
  | {
      type: "effectArchiveHand";
      player: PlayerId;
      count: number;
      /** 範囲選択の上限 (「X〜Y枚」)。未指定なら count 枚固定 */
      countMax?: number;
      /** 選択可能な手札を限定 (タグ/ホロメン限定コスト用)。未指定なら手札全体 */
      eligible?: string[];
      /** 選んだカード同士が同じタグを1つ以上共有すること (「同じタグを持つホロメンX枚」) */
      sameTag?: boolean;
      ctx: EffectContextData;
    }
  | {
      type: "effectAttach";
      player: PlayerId;
      /** この付与群のカードを全て同じホロメンに付ける */
      sameTarget?: boolean;
      /** 付けるカードのuid */
      uid: string;
      /** 付与成功までカードを保持する領域。未指定なら解決領域。 */
      source?: { player: PlayerId; zone: "deck" | "hand" | "archive" };
      /** 付け先の名称制限 */
      targetNames?: string[];
      /** 付け先の汎用フィルタ (色/タグ等) */
      targetFilter?: TargetFilter;
      /** この発生源ホロメンには付けられない (「他の」) */
      excludeStackId?: number;
      /** falseなら共有ctxを更新するだけで、後続Opの再開は後続プロンプトに任せる */
      resume?: boolean;
      /** 手札/アーカイブから付けた時の付与カード自身の誘発を発火する */
      attachedFromHand?: boolean;
      /** attachedFromHand の付与元がアーカイブである */
      attachedFromArchive?: boolean;
      ctx?: EffectContextData;
    }
  | {
      type: "effectConfirm";
      player: PlayerId;
      label: string;
      /** はい選択時に実行する Op 列 */
      thenOps: Op[];
      /** いいえ選択時に実行する Op 列 (二択の効果用) */
      elseOps?: Op[];
      /** 被ダメージ置換。可否にかかわらず同じダメージには再提示しない。 */
      damageReplacementId?: string;
      ctx: EffectContextData;
    }
  | {
      type: "reactiveSkill";
      /** 使用を確認されるプレイヤー */
      player: PlayerId;
      sp: boolean;
      skillName: string;
      description: string;
      cost: number;
      /** reduce: 保留中のアーツダメージを軽減 / ops: 効果を実行 */
      kind: "reduce" | "ops";
      reduce?: number;
      /** 全員軽減は同時ダメージの対象のうちこの条件に合う実体へ適用 */
      reduceAll?: TargetFilter;
      ops?: Op[];
      /** 被ダメージ置換。可否にかかわらず同じダメージには再提示しない。 */
      damageReplacementId?: string;
      /** reduce の場合は保留中の artDamage を含む実行コンテキスト */
      ctx: EffectContextData;
    }
  | {
      /** サイコロの目の宣言 (1〜6を選ぶ。次に出る目を宣言した目として扱う) */
      type: "declareDice";
      player: PlayerId;
      ctx: EffectContextData;
    }
  | {
      /** つのまきじゃんけん。先手の選択は相手向けビューでは伏せる。 */
      type: "jankenHand";
      /** 現在、手を選ぶプレイヤー */
      player: PlayerId;
      /** 効果を使ったプレイヤー (勝利時にwinOpsを受ける側) */
      initiator: PlayerId;
      /** 先手が選択済みの場合だけ保持。相手・観戦者向けビューでは除去する。 */
      initiatorHand?: JankenHand;
      winOps: Op[];
      ctx: EffectContextData;
    };

export type GamePhase = "setup" | "playing" | "finished";

export interface DiceResultSummary {
  label: string;
  value: number;
  unit?: "回";
}

export interface LogEntry {
  /** ログ件数を上限管理しても新着を判定できる単調増加ID */
  id: number;
  turn: number;
  player: PlayerId | null;
  text: string;
  /** プレイヤーの操作ログから独立して表示するターン開始の区切り */
  turnStart?: true;
  /** 指定プレイヤーだけに見せる詳細ログ。その他の視点では publicText に差し替える */
  privateTo?: PlayerId;
  publicText?: string;
  /** 戦闘演出で発生元・対象を同名カードでも正確に特定するための補助情報 */
  combat?: {
    kind: "art" | "special";
    sourceStackId?: number;
    targetStackId: number;
    blocked?: boolean;
  };
  /** サイコロ・能力発動演出を同期画面でも同じ発動元から再生するための補助情報 */
  animation?:
    | {
        kind: "effect";
        label: string;
        sourceStackId?: number;
        sourceUid?: string;
        /** 記録時点でsourceUidが全視点に公開されていた (視点ビューで残せる) */
        sourcePublic?: boolean;
        sourceOshi?: boolean;
        sourceCardId?: string;
      }
    | {
        kind: "dice";
        label: string;
        results: number[];
        /** 効果による変更前の実際の出目。古い保存データでは未指定。 */
        rolledResults?: number[];
        /** 同じ効果内の複数個をまとめるID。別の振り直しとは区別する。 */
        rollId?: number;
        /** この能力が参照する集計だけを表示する。 */
        summaries?: DiceResultSummary[];
        versus?: boolean;
        sourceStackId?: number;
        sourceUid?: string;
        sourcePublic?: boolean;
        sourceOshi?: boolean;
        sourceCardId?: string;
      };
  /** 実際に引いたカード。同じ実体を引き直す場合もドロー演出を同期する。 */
  draw?: {
    kind: "mulligan" | "draw";
    uids: string[];
  };
}

/** 11.3.1.1 の能力1つ分。自動能力と任意の推しスキルを同じプールで扱う。 */
export interface RuleDownAbility {
  id: string;
  player: PlayerId;
  label: string;
  sourceStackId?: number;
  sourceSupportUid?: string;
  ops: Op[];
  /** 同名ギフト全体の制限。待機時ではなく選ばれた能力の解決開始時に消費する。 */
  sharedUseLimit?: { key: string; n: number };
  reactive?: {
    sp: boolean;
    skillName: string;
    description: string;
    cost: number;
  };
}

/** ダウンを発生させた効果。連鎖したダウンでも対象ごとに発生源を保持する。 */
export interface RuleDownCause {
  player: PlayerId;
  /** アーツダメージによるダウン。アーツ本文の特殊ダメージは含まない。 */
  artDamage?: boolean;
  sourceStackId?: number;
  targetStackId?: number;
  noLifeTargetStackId?: number;
}

/** 10.11.2 に従って適用順を選ぶ、被ダメージ時の置換効果1つ分。 */
export type DamageReplacementChoice =
  | {
      id: string;
      label: string;
      kind: "backSpecialShield";
      holderStackId: number;
      holderName: string;
    }
  | {
      id: string;
      label: string;
      kind: "oshi";
      sp: boolean;
      skillName: string;
      description: string;
      cost: number;
      promptKind: "reduce" | "ops";
      reduce?: number;
      reduceAll?: TargetFilter;
      ops?: Op[];
      /** opsを防御側ctxで実行し、保留中ダメージへresumeする */
      wrapResume?: boolean;
      targetStackId: number;
    }
  | {
      id: string;
      label: string;
      kind: "support";
      supportUid: string;
      targetStackId: number;
      reduce: number;
    }
  | {
      id: string;
      label: string;
      kind: "gift";
      holderStackId: number;
      holderName: string;
      key?: string;
      branches: Extract<Op, { t: "dice" }>["branches"];
    };

/** 総合ルール11.3/11.5の途中状態。入力待ちをまたいで同期できる純データ。 */
export interface RuleResolutionState {
  /** ルール処理完了後に再開する元の効果 */
  resume: EffectContextData;
  /** 対象スタックIDごとのダウン発生源 */
  causes: Record<number, RuleDownCause>;
  /** 保留中のライフダメージ (11.5) */
  lifeDamage: [number, number];
  /** この一連のルール処理でライフが0になったプレイヤー */
  lifeDepleted: [boolean, boolean];
  current?: {
    player: PlayerId;
    stackId: number;
    pos: StagePosition;
    cards: string[];
    yells: string[];
    supports: string[];
    /** ダウン時能力で設定した、アーカイブする際の手札への置換対象。 */
    returnToHandUids?: string[];
    lifeLoss: number;
    lifeAccounted: boolean;
    wasCenter: boolean;
    abilities: RuleDownAbility[];
  };
}

export interface GameState {
  /** ステージを離れる直前の公開情報。カード参照は実カードと相関しない履歴専用UID。 */
  lastKnownHolomen?: Record<
    number,
    {
      player: PlayerId;
      pos: StagePosition;
      stack: HolomenStack;
      colors: Color[];
      cardIds: string[];
    }
  >;
  /** 状態のリビジョン (画面間同期用) */
  rev: number;
  phase: GamePhase;
  /** グローバルターン番号 (1始まり。1=先攻の第1ターン, 2=後攻の第1ターン) */
  turn: number;
  turnPlayer: PlayerId;
  firstPlayer: PlayerId;
  /** 各プレイヤーが開始したターン数 (8.3.2.1 の「各プレイヤーの最初のターン」判定用) */
  turnsStarted: [number, number];
  step: Step;
  players: [PlayerState, PlayerState];
  /** uid → カードID */
  uidToCard: Record<string, string>;
  /** uid → 既定以外のカード画像キー。未登録なら既定画像 */
  uidToArtwork?: Record<string, string>;
  /** 入力待ちキュー (先頭がアクティブ) */
  prompts: Prompt[];
  /**
   * 発動演出 (エフェクトバナー・推しスキル) 直後の待機予約。
   * logEffect等で立ち、runOpsが次のopの前に消費してanimationDelayへ変換する。
   * revが進んだ後に残った予約は手遅れなので破棄される。
   */
  pendingFxWait?: { logId: number; anim: FxWaitKind; rev: number };
  /** 11.3/11.5 のルール処理状態 */
  ruleResolution?: RuleResolutionState;
  /** ターン中のアーツ修正値 */
  turnModifiers: TurnModifier[];
  /** スタックIDの採番 */
  nextStackId: number;
  /** このターンにダウンしたホロメン数 (プレイヤー別) */
  downsThisTurn: [number, number];
  /** 各プレイヤーの直前の相手ターンに、自身のホロメンがダウンした数 */
  downsPrevTurn: [number, number];
  /** トリガー能力の使用回数 (サポートuid別、ターンごとにリセット) */
  usedTriggersThisTurn: Record<string, number>;
  /** [ゲームに1回] のカード効果をプレイヤー別に記録 */
  usedEffectsOncePerGame?: [string[], string[]];
  /** このターンに使用したサポートのカード名 (プレイヤー別) */
  usedSupportNamesThisTurn: [string[], string[]];
  /** このターンに使用したサポートの種類 (プレイヤー別) */
  usedSupportTypesThisTurn: [string[], string[]];
  /** このターンに使用したサポートのタグ+種類の組 (プレイヤー別、「#Tを持つイベント」条件用) */
  usedSupportTagTypesThisTurn: [string[], string[]];
  /** このターンに自分のデッキからアーカイブしたカード枚数 (プレイヤー別) */
  deckArchivedThisTurn: [number, number];
  /** このターンに能力でサイコロを振った回数 (プレイヤー別、発生源ホロメン名→回数。推しは「(推し)」、サポートは「(サポート)」) */
  diceRollsThisTurn: [Record<string, number>, Record<string, number>];
  /** このターンに自分のホロメンがステージからデッキに戻ったか (プレイヤー別) */
  stageToDeckThisTurn: [boolean, boolean];
  /** このターンにステージのエールがアーカイブされたか (エールの持ち主別) */
  stageYellArchivedThisTurn: [boolean, boolean];
  /** パフォーマンスステップ開始時のライフ枚数 (プレイヤー別。「そのパフォーマンスステップに自分のライフが減っていたら」判定用) */
  lifeAtPerfStart?: [number, number];
  /** ライフが相手の能力で減らない有効ターン (プレイヤー別。値=そのグローバルターン番号の間だけ有効) */
  lifeImmuneFromOppTurn?: [number, number];
  /** このターンにダウンしたホロメンのuid (持ち主別。名前/タグ条件の参照用) */
  downedUidsThisTurn: [string[], string[]];
  /** 各プレイヤーの直前の相手ターンにダウンした、自身のホロメンのuid */
  downedUidsPrevTurn: [string[], string[]];
  /** サイコロの目の修正 (「目の数すべてをXとして扱う/倍として扱う」) */
  diceMods: {
    player: PlayerId;
    value?: number;
    double?: boolean;
    /** 発生源ホロメン名の限定 (推し能力の場合も名前一致で判定) */
    names?: string[];
    /** 1度にこの回数以上振る時のみ適用 */
    rollsAtLeast?: number;
    /** 1度にちょうどこの回数振る時のみ適用 */
    rollsExactly?: number;
    /** 次の1回の出目にのみ適用 (適用したら削除。「次に出る目の数を宣言した目として扱う」) */
    once?: boolean;
    expiresTurn: number;
  }[];
  /** リセットステップでお休みしないホロメン名 (プレイヤー別、ゲーム間有効) */
  noRestResetNames: [string[], string[]];
  /** 次のリセットステップでアクティブにならないホロメンのスタックID (適用時に消費) */
  skipResetActivate: number[];
  /** アーツ使用時のカード名と位置。移動・ダウン後も履歴条件を参照する。 */
  artUsesThisTurn: [
    { names: string[]; pos: StagePosition; tags?: string[] }[],
    { names: string[]; pos: StagePosition; tags?: string[] }[],
  ];
  /** このターンにBloomしたカードのuid (プレイヤー別。「Bloomした回数」参照用) */
  bloomedCardUidsThisTurn: [string[], string[]];
  archiveBloomedThisTurn?: [boolean, boolean];
  /** 予約された追加ターン。最後に適用されたものから実行する (5.26.2-5.26.3) */
  extraTurns: PlayerId[];
  /** ターン中のダウン報酬 (「自分の(#tag)ホロメンが相手のセンターホロメンをダウンさせた時、相手のライフ-X」) */
  downRewards?: {
    player: PlayerId;
    tag?: string;
    /** ダウンさせた側のホロメンをこのスタックに限定 (「選んだホロメンが〜」) */
    stackId?: number;
    /** 相手のセンターに限らず、相手のどのホロメンのダウンでも発火する */
    anyHolomen?: boolean;
    /** アーツダメージでダウンさせた場合に限定する。 */
    artDamageOnly?: boolean;
    oppLifeMinus?: number;
    /** 発火時に自分のデッキをX枚引く */
    draw?: number;
    expiresTurn: number;
  }[];
  log: LogEntry[];
  /** 勝者。phase="finished" かつ null は引き分けを表す。 */
  winner: PlayerId | null;
  winReason: string | null;
}

/** デッキ構成 (ロビー/デッキ構築画面が生成する) */
export interface DeckArtworkSelection {
  /** 既定画像以外を選んだ推しホロメンの画像キー */
  oshi?: string;
  /** カードID → 画像キー → 枚数（既定画像分は省略） */
  main?: Record<string, Record<string, number>>;
  /** エールID → 画像キー → 枚数（既定画像分は省略） */
  cheer?: Record<string, Record<string, number>>;
}

export interface DeckList {
  name: string;
  oshiId: string;
  /** カードID → 枚数。合計ちょうど50 */
  main: Record<string, number>;
  /** エールカードID → 枚数。合計ちょうど20 */
  cheer: Record<string, number>;
  /** 同一カードID内で選択した別イラスト。未指定分は先頭画像を使う */
  artworks?: DeckArtworkSelection;
}

export type CostColor = Color;
