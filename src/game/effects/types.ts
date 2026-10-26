// カード本文の解析：types。
import type { Color } from "../../data/types";
import type { EffectContextData, GameState } from "../types";

// ------------------------------------------------------------
// カードフィルタ (サーチ・選択対象の条件)
// ------------------------------------------------------------
export interface CardFilter {
  kind?:
    | "holomen"
    | "yell"
    | "ファン"
    | "マスコット"
    | "ツール"
    | "アイテム"
    | "イベント"
    | "スタッフ"
    | "サポート";
  bloomLevel?: "Debut" | "1st" | "2nd" | "Spot";
  /** 指定Bloomレベルを除外 */
  excludeBloomLevel?: "Debut" | "1st" | "2nd" | "Spot";
  /** Bloomレベルの下限 (1st以上 / 2nd以上) */
  minBloom?: "1st" | "2nd";
  buzz?: boolean;
  excludeBuzz?: boolean;
  color?: Color;
  /** 推しホロメンと同色 (実行時に解決) */
  sameColorAsOshi?: boolean;
  /** 選んだホロメンと同色 (実行時に解決) */
  sameColorAsBound?: boolean;
  sameBloomAsBound?: boolean;
  /** 選んだホロメン(boundStackIds)のindex番目と同色 (searchDeck実行時に解決) */
  sameColorAsBoundIndex?: number;
  tag?: string;
  names?: string[];
  nameContains?: string;
  /** LIMITEDを持つサポート */
  limited?: boolean;
  /** LIMITED以外に限定 */
  excludeLimited?: boolean;
  unlimitedOnly?: boolean;
  /** コラボエフェクトを持つホロメン */
  hasCollabEffect?: boolean;
  /** ブルームエフェクトを持つホロメン */
  hasBloomEffect?: boolean;
  /** ギフトを持つホロメン */
  hasGift?: boolean;
  batonCost?: number;
  /** 推しホロメン/コラボホロメンと同じカード名 (実行時に解決) */
  sameNameAs?: "oshi" | "collab";
  /** この効果で(手札から)戻したカードと同じカード名 (実行時にctx.pickedCardsから解決) */
  sameNameAsReturned?: boolean;
  /** この効果で最後にエール/サポートを送ったホロメンと同じカード名 */
  sameNameAsAttachedTo?: boolean;
  /** 自分のステージのホロメン全員と異なるカード名 */
  diffFromStage?: boolean;
  /** 選択するカード同士が異なるカード名であること (選択時に検証) */
  distinctPick?: boolean;
  /** [AかB] の選択肢 (いずれかに一致) */
  alt?: CardFilter[];
  /** 特定インスタンスuidのみ */
  uids?: string[];
  /**
   * 「カード」= カード種別を問わない (ホロメン/サポート/エールのどれでもよい)。
   * **他の条件を無効にするフラグではない**。「#Tを持つカード」のように
   * タグ等と併記されるため、種別以外の条件はそのまま適用する
   */
  any?: boolean;
}

// ------------------------------------------------------------
// 対象指定
// ------------------------------------------------------------
export type StackTarget =
  | "self"
  | "ownCenter"
  | "ownCollab"
  | "oppCenter"
  | "oppCollab"
  | "chooseOwn"
  | "chooseOwnBack"
  | "chooseOpp"
  | "chooseOppFront"
  | "chooseOppAny"
  | "chooseOppBack"
  | "chooseOppCenterOrBack" // 相手のセンターかバックから選択 (コラボ除く)
  | "allOppBack"
  | "allOwn"
  | "allOpp" // 相手のステージ全員
  | "allBoth" // お互いのステージ全員
  | "allOwnFront" // 自分のセンター+コラボ
  | "chooseOwnFront" // 自分のセンター/コラボから1体選択 (エール送付先等)
  | "allOppFront" // 相手のセンター+コラボ
  | "allFrontBoth" // お互いのセンター+コラボ
  | "artTarget" // 実行中のアーツの対象
  | "bound";

// chooseBind で選んだホロメン (複数可)

export interface TargetFilter {
  color?: Color;
  tag?: string;
  names?: string[];
  bloomLevel?: "Debut" | "1st" | "2nd" | "Spot";
  /** 指定Bloomレベルを除外 (「Debut以外の」) */
  excludeBloomLevel?: "Debut" | "1st" | "2nd" | "Spot";
  minBloom?: "1st" | "2nd";
  buzz?: boolean;
  /** 指定名称のカードが付いている */
  hasAttachedNames?: string[];
  /** いずれかの色のエールが付いている (「CエールかCエールが付いている」) */
  hasColorYell?: Color[];
  /** 指定種類のサポートが付いている */
  hasAttachedType?: "マスコット" | "ファン" | "ツール";
  /** 何らかのサポートカードが付いている */
  hasAttachedSupport?: boolean;
  hasAttachedFilter?: CardFilter;
  /** 効果の発生源自身を除く */
  excludeSource?: boolean;
  /** 付け替えるエールの元の保持者を除く (発生源と異なる場合もある) */
  excludeYellOrigin?: boolean;
  /** 指定名称のホロメンを除く (「〈X〉以外の」) */
  excludeNames?: string[];
  /** お休み状態で絞る (true=お休みしている / false=お休みしていない) */
  resting?: boolean;
  /** このターンにBloomしたホロメンに限定 */
  bloomedThisTurn?: boolean;
  /** このターンにステージに出たホロメンに限定 */
  enteredThisTurn?: boolean;
  /** ポジション限定 (back=バック / center=センター / collab=コラボ / front=センターかコラボ) */
  position?: "back" | "center" | "collab" | "front";
  /** 持ち主側の推しホロメンと異なる色を持つ (「相手の推しホロメンと異なる色を持つ相手の〜」) */
  diffColorFromOwnerOshi?: boolean;
  /** HPがn以上減っている (被ダメージがn以上) */
  damagedAtLeast?: number;
  /** 指定名称または#タグ持ちのいずれか (「[〈N〉か#Tを持つホロメン]」) */
  nameOrTag?: { names: string[]; tag: string };
  /** 効果の発生源自身のみ (「このホロメンに付け替える」等) */
  sourceOnly?: boolean;
  /** エールが1枚も付いていない */
  noYell?: boolean;
  hasYell?: boolean;
  /** 複数Bloomレベルのいずれか (「[Debutホロメンと1stホロメン]全員」) */
  bloomLevels?: ("Debut" | "1st" | "2nd" | "Spot")[];
  /** chooseBind で選んだホロメンのみ (「選んだホロメンに付け替える」等、実行時にctxで検証) */
  boundOnly?: boolean;
  /** このターンに指定レベルのホロメンからBloomした (直下のカードのレベルで判定) */
  bloomedFromLevelThisTurn?: "Debut" | "1st" | "2nd";
  /** BuzzホロメンからBloomしている (重なりにBuzzがある) */
  bloomedFromBuzz?: boolean;
  /** 色が1色のホロメンのみ */
  monoColor?: boolean;
  /** いずれかのフィルタを満たす (「[AかB]」のOR選択肢) */
  anyOf?: TargetFilter[];
}

// ------------------------------------------------------------
// 条件
// ------------------------------------------------------------
export type Cond =
  | { c: "oppHandAtLeast"; n: number }
  | { c: "oppHoloPowerAtLeast"; n: number }
  | { c: "oshiHasStageSkill" }
  | { c: "batonTouchedThisTurn" }
  | { c: "artUseNumber"; n: number }
  | { c: "archiveBloomedThisTurn" }
  | { c: "selfRemainingHpAtLeast"; n: number }
  | { c: "stageAttachedCount"; filter: CardFilter; n: number }
  | { c: "stageYellHasColors"; colors: Color[] }
  | { c: "milledHas"; filter: CardFilter; negate?: boolean }
  | { c: "not"; inner: Cond }
  | { c: "and"; inner: Cond[] } // 「Aで、B」複合条件
  | { c: "or"; inner: Cond[] } // 「AかB」選択条件
  | { c: "centerHasTag"; tag: string }
  | { c: "stageHasNamedCard"; names: string[] } // 自分のステージの指定名カード (付与サポートも含む)
  | {
      c: "stageHas";
      filter: TargetFilter;
      excludeSelf?: boolean;
      /** X人以上 */
      n?: number;
      /** ポジション限定 */
      pos?: "back" | "collab" | "center";
      /** 異なるカード名で数える */
      distinctNames?: boolean;
    }
  | { c: "selfHasYell"; color: Color; n: number }
  | { c: "selfHasYellExcept"; color: Color; n: number } // このホロメンに(色)以外のエールがn枚以上
  | { c: "selfYellCount"; n: number } // このホロメンにエールがn枚以上付いている (色不問)
  | { c: "centerDamaged" } // 自分のセンターホロメンのHPが減っている
  | { c: "oppBackDamaged" } // 相手のバックホロメンのHPが減っている
  | { c: "oppBackDamagedCount"; n: number } // 相手のHPが減っているバックホロメンがn人以上いる
  | { c: "oppBackDamageSumAtLeast"; n: number } // 相手のバックホロメン全員のHPが合計n以上減っている
  | { c: "oppBackDamagedByAtLeast"; n: number } // 相手にHPがn以上減っているバックホロメンがいる
  | { c: "bloomedOwnThisTurn" } // このターンに自分のホロメンがBloomしていた
  | { c: "archiveCountAtLeast"; n: number } // 自分のアーカイブがn枚以上ある
  | { c: "archiveHasHolomen" } // 自分のアーカイブにホロメンがある
  | { c: "archiveHasYell"; color?: Color } // 自分のアーカイブにエール(指定色エール)がある
  | { c: "milledFromDeckThisTurnAtLeast"; n: number } // このターンにデッキからn枚以上アーカイブ
  | { c: "stageYellCountAtLeast"; n: number } // 自分のステージにエールがn枚以上ある
  | { c: "oppStageYellCountAtLeast"; n: number } // 相手のステージにエールがn枚以上ある
  | { c: "bothStageYellSumAtLeast"; n: number } // お互いのステージのエールが合計n枚以上ある
  | { c: "selfHasAttachedName"; names: string[]; n?: number }
  | { c: "lifeAtMost"; n: number }
  | { c: "lifeAtLeast"; n: number }
  | { c: "lifeEq"; n: number } // 自分のライフがちょうどn
  | { c: "lifeLessThanOpp" }
  | { c: "handLessThanOpp" }
  | { c: "handAtMost"; n: number }
  | { c: "handAtLeast"; n: number }
  | { c: "downedLastOppTurn"; filter?: { tag?: string; names?: string[] } }
  | { c: "bloomedFromDebut" }
  | { c: "bloomedFromBuzz" }
  | { c: "selfActivatedByOshiSkill"; name: string } // このホロメンが指定の推しスキルでアクティブになった
  | { c: "selfBloomedBySpOshiSkill"; name: string } // このホロメンが指定のSP推しスキルでBloomした
  | { c: "oshiIs"; names: string[] }
  | { c: "centerIs"; names: string[] }
  | { c: "centerColorIs"; color: Color }
  | { c: "oppStageHas"; filter: TargetFilter; pos?: "collab" | "center" }
  | { c: "usedSpSkill"; name?: string; oshiNames?: string[] }
  | { c: "usedSpSkillThisTurn"; name?: string; ownMainStep?: boolean }
  | { c: "selfDamaged" }
  | { c: "lifeReducedThisPerformance" }
  | { c: "oshiColorIs"; color: Color }
  | {
      c: "usedSupportTypeThisTurn";
      kind: "サポート" | "イベント" | "アイテム" | "スタッフ";
    }
  | { c: "usedCardNameThisTurn"; names: string[] }
  | {
      c: "usedTaggedSupportThisTurn";
      tag: string;
      kind: "イベント" | "アイテム" | "スタッフ" | "サポート";
      n?: number;
    }
  | { c: "lastMilledAllSupport" }
  | { c: "lastMilledAllHolomen" }
  | { c: "lastMilledAny" }
  | { c: "selfHasAttachedType"; kinds: ("マスコット" | "ファン" | "ツール")[] }
  | { c: "selfHasAttachedTag"; tag: string } // このホロメンに#Tを持つサポートが付いている
  | { c: "selfHasAttachedSupport" } // このホロメンにサポートカードが付いている
  | { c: "centerHasYell"; n: number } // 自分のセンターにエールがn枚以上付いている
  | { c: "stageHasColorYell"; color: Color; n?: number } // 自分のステージに指定色エールがある(n枚以上)
  | { c: "stageAllYellColor"; color: Color } // 自分のステージのエールがすべて指定色 (エール0枚は不成立)
  | { c: "stageYellColorsAtLeast"; n: number } // 自分のステージのエールがn色以上
  | { c: "stackedEq"; n: number; atLeast?: boolean }
  | { c: "centerStackedAtLeast"; n: number }
  | { c: "stageCountAtMost"; n: number }
  | { c: "artDowned"; pos?: "center" | "collab" } // このアーツで相手の(指定ポジションの)ホロメンをダウンさせた (ダウン時能力の解決中)
  | { c: "artOverkillAtLeast"; n: number } // このアーツの与ダメが残りHPをn以上オーバー
  | { c: "secondPlayerFirstTurn" }
  | { c: "revealedMatches"; filter: CardFilter } // 公開したカードがすべて条件を満たす
  | { c: "allyUsedArtThisTurn"; names: string[]; pos?: "center" | "collab" } // このターンに指定名のホロメンがアーツを使った
  | { c: "archiveHas"; filter: CardFilter; n: number } // 自分のアーカイブに(F)がX枚以上ある
  | { c: "revealedSome"; filter: CardFilter } // 公開したカードの中に(F)がある
  | { c: "revealedCountAtLeast"; filter: CardFilter; n: number }
  | { c: "frontBothMatch"; filter: TargetFilter }
  | {
      c: "artTargetIs";
      pos?: "collab" | "center";
      filter?: TargetFilter;
      batonAtLeast?: number;
    } // このアーツの対象が相手の(条件)ホロメン
  | { c: "stageAll"; filter: TargetFilter } // 自分のステージのホロメン全員が(条件)
  | { c: "usedOshiSkillThisTurn"; name?: string } // 名称指定があれば使用履歴の名前も照合
  | { c: "artNameIs"; name: string } // 実行中のアーツ名
  | { c: "revealedSameBloom"; n: number } // 公開カードが同じBloomレベルのホロメンn枚
  | { c: "oppCenterBatonAtLeast"; n: number } // 相手のセンターのバトンタッチに必要な無色がn以上
  | { c: "stageHasDiffColorFromSelf" } // 自分のステージにこのホロメンと異なる色のホロメンがいる
  | { c: "tagCenterCollabDiffYell"; tag: string } // 自分の#Tを持つ[センターとコラボ]に異なる色のエールが付いている
  | { c: "movedHolomenAtLeast"; n: number } // この効果で戻した(移動した)ホロメンがn枚以上
  | { c: "diceRolledByName"; names: string[]; n: number } // このターンに自分の〈N〉の能力でサイコロをn回以上振っていた
  | { c: "stageToDeckThisTurn" } // このターンに自分のホロメンがステージからデッキに戻っていた
  | { c: "pickedHasTag"; tag: string } // この効果で選んだ(戻した)カードが#Tを持つ
  | { c: "boundIs"; filter: TargetFilter } // 選んだホロメンが(条件)を満たす
  | { c: "cheerDeckCountAtMost"; n: number } // 自分のエールデッキの枚数がn枚以下
  | { c: "selfBloomedFromBuzz" } // このホロメンの真下のカードがBuzzである (Q501)
  | { c: "deckCountAtMost"; n: number } // 自分のデッキの枚数がn枚以下
  | { c: "stageYellVsOpp"; mode: "more" | "less" | "atMost"; margin?: number } // 自分のステージのエール枚数が相手より多い(margin枚以上)/少ない/以下
  | { c: "lifeAtMostOpp" } // 自分のライフが相手以下
  | { c: "centerBloomLevelIs"; level: "Debut" | "1st" | "2nd" } // 自分のセンターホロメンがXstホロメン
  | { c: "usedLimitedThisTurn"; kind?: "イベント" | "アイテム" | "スタッフ" } // このターンに自分がLIMITEDの(種別)を使っていた
  | { c: "holoPowerAtLeast"; n: number } // 自分のホロパワーがn枚以上
  | { c: "handEq"; n: number } // 自分の手札がちょうどn枚
  | { c: "stageYellArchivedThisTurn" } // このターンに自分のステージのエールがアーカイブされていた
  | {
      c: "oppCenterHasAttachedType";
      kinds: ("マスコット" | "ファン" | "ツール")[];
    } // 相手のセンターにツール等が付いている
  | { c: "selfYellExactlyOneOf"; colors: Color[] } // このホロメンに指定色のうちどちらか1色しか付いていない
  | {
      c: "stageAttachedCountAtLeast";
      kinds: ("マスコット" | "ファン" | "ツール")[];
      n: number;
    } // 自分のステージの付与サポートが合計n枚以上
  | { c: "boundYellCount"; n: number } // 選んだホロメンにエールがn枚以上付いている
  | { c: "stageCountVsOpp"; mode: "less" | "more" } // 自分のステージのホロメン人数が相手より少ない/多い
  | { c: "bothCenterBloomLevelIs"; level: "Debut" | "1st" | "2nd" } // お互いのセンターホロメンが指定レベル
  | { c: "downedIs"; buzz?: boolean; levels?: ("Debut" | "1st" | "2nd")[] } // ダウンしたホロメンがBuzz/指定レベル (downedOwnリアクティブ内)
  | { c: "pickedAtLeast"; n: number } // この効果で選んだ(移動した)カードがn枚以上
  | { c: "attachedAtLeast"; n: number } // 直前の付与効果で実際にサポートをn枚以上付けた
  | { c: "milledAtLeast"; n: number } // この能力でアーカイブしたカードがn枚以上
  | { c: "oncePerGameUnused"; key: string } // プレイヤーごとのゲーム中1回効果が未使用
  | { c: "stageMonoDistinct"; n: number };

// 自分のステージに色が1色で互いに異なる色のホロメンがn人以上いる

// ------------------------------------------------------------
// 実行 Op
// ------------------------------------------------------------
/** 同じタイミングで誘発した能力1つ分。コントローラーが解決順を選ぶ。 */
export interface TriggerAbility {
  id: string;
  label: string;
  sourceStackId?: number;
  sourceSupportUid?: string;
  /** 待機能力を別の解決列へまとめても、元のアーツ/Bloom等の結果を参照する。 */
  eventContext?: Omit<EffectContextData, "rest" | "pendingTriggers">;
  ops: Op[];
}

export type Op =
  | { t: "repeatDifferentArtNow"; cardId: string; index: number }
  | { t: "turnBloomLevel"; level: "2nd" }
  | { t: "turnArtReduceFrom"; names: string[]; level: "1st"; value: number }
  | { t: "swapOppCollabWithBound" }
  | { t: "boundStackToHand"; optional?: boolean }
  | { t: "bothRefreshArchive"; draw: number }
  | { t: "highestHpArtPlus"; value: number }
  | { t: "oppCenterAllYellReturn" }
  | { t: "drawPerArtTag"; tag: string }
  | { t: "turnThirdArtBackTarget"; names: string[] }
  | { t: "draw"; n: number; optional?: boolean; fromBottom?: boolean }
  | { t: "oppDraw"; n: number; optional?: boolean }
  | { t: "oppArchiveHand"; n: number } // 相手は自身の手札n枚を(選んで)アーカイブする
  | { t: "drawUntil"; n: number }
  | { t: "drawUntilStageNames"; names: string[]; cap?: number } // 手札がステージの〈N〉の枚数と同じになるまで引く (capは上限)
  | {
      t: "drawThenArchive";
      draw: number;
      archive: number;
      fromBottom?: boolean;
    }
  | { t: "shuffleDeck" }
  | { t: "shuffleCheer" }
  | {
      t: "special";
      dmg: number;
      /** 動的ダメージ (boundDamage=選んだホロメンの被ダメージ, overkill=直前アーツの超過ダメージ, oppBackDamageSum=相手バック全員の被ダメージ合計, healed=この効果で回復した量, triggerDamage=この誘発のきっかけになったダメージ) */
      dmgFrom?:
        | "boundDamage"
        | "artTargetDamage"
        | "oppCenterDamage"
        | "overkill"
        | "oppBackDamageSum"
        | "healed"
        | "triggerDamage";
      /** dmgFrom の「Xにつき」のX (dmg × floor(量/dmgFromPer) にする。省略時は量そのまま) */
      dmgFromPer?: number;
      /** dmg を実行時の数量で倍化する (stageTagDistinct=自分のステージの異なるカード名の#tag持ち人数, stageTag=自分のステージの#tag持ちホロメン人数, backTag=自分の#tag持ちバックホロメン人数, backTagDistinct=自分の異なるカード名の#tag持ちバックホロメン人数, milled=直前にアーカイブしたカード枚数, diceRolls=このターンに能力でサイコロを振った回数) */
      scaleBy?:
        | { kind: "stageTagDistinct"; tag: string }
        | {
            kind: "stageTag";
            tag: string;
            bloomLevel?: "Debut" | "1st" | "2nd" | "Spot";
          }
        | { kind: "backTag"; tag: string }
        | { kind: "backTagDistinct"; tag: string }
        | { kind: "stageYell" }
        | { kind: "milled" }
        | { kind: "diceRolls" }
        | { kind: "archiveFilter"; filters: CardFilter[] } // 自分のアーカイブの(F)枚数 (いずれかに一致)
        | { kind: "centerNameStacked"; names: string[] }; // 自分のセンターの〈N〉に重なっているホロメン枚数
      /** scaleBy で数える枚数・人数の上限 */
      scaleMax?: number;
      target: StackTarget;
      /** 選択したバックと同じ特殊ダメージで相手センターも対象にする。 */
      includeOppCenter?: boolean;
      count?: number;
      /** 同じ対象へ繰り返し割り振り、選択完了後に対象別の合計を一度に与える回数。 */
      allocationCount?: number;
      filter?: TargetFilter;
      noLife?: boolean;
    }
  | {
      t: "heal";
      value: number | "all";
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
      /** value を実行時の枚数で倍化する (例: ステージのエール色数) */
      scaleBy?:
        | "stageYellColors"
        | "oppOshiDiffColor"
        | "stageNamedCards"
        | "revealedHolomen";
      scaleNames?: string[];
      perArchiveNames?: string[];
    }
  | { t: "artPlus"; value: number }
  | {
      t: "artPlusPer";
      value: number;
      per:
        | "selfYell"
        | "selfYellColor"
        | "attachedName"
        | "stageTag"
        | "stacked"
        | "stageMascot"
        | "ownBack"
        | "revealedHolomen"
        | "milled"
        | "stageYell" // ステージのエール総数
        | "stageFan" // ステージに付いているファン総数
        | "archiveHolomen" // アーカイブのホロメン数
        | "archiveCard" // アーカイブのカード総数
        | "archiveColorYell" // アーカイブの特定色エール数
        | "handCount" // 自分の手札枚数
        | "oppDamagedBack" // 相手のHPが減っているバックホロメン数
        | "oppResting" // 相手のお休みしているホロメン数
        | "oppArchiveYell" // 相手のアーカイブのエール数
        | "movedHolomen" // この効果で移動(戻した等)したホロメン数
        | "stageYellColors" // ステージのエールの色数
        | "usedEvent" // このターンに使ったイベント数 (tag指定で絞り込み)
        | "oppHandCount" // 相手の手札枚数
        | "archiveNamed"
        | "stageNamed"
        | "centerNamedYell"
        | "downsPrevTurn"
        | "stageNonDebut"
        | "oppOshiDiffColor" // 相手の推しと異なる色を持つ相手のステージのホロメン数
        | "bothStageYell" // お互いのステージのエール総数
        | "bothArchiveYell" // お互いのアーカイブのエール総数
        | "lifeLost" // 自分の初期ライフから減っているライフ数
        | "archiveYell" // 自分のアーカイブのエール数 (色不問)
        | "stageYellDiff" // 自分のステージのエールが相手より多い枚数 (差分、負なら0)
        | "usedLimited" // このターンに使ったLIMITEDのサポートカード数
        | "stageTagYell"; // 自分の#tag持ちホロメン全員に付いているエール総数
      color?: Color;
      names?: string[];
      tag?: string;
      bloomLevel?: "Debut" | "1st" | "2nd" | "Spot";
      distinctNames?: boolean;
      excludeSelf?: boolean;
      max?: number;
      /** 「X枚につき」のX (規定値1)。count を perN で割った商を係数にする */
      perN?: number;
    }
  | {
      t: "turnArtPlus";
      value: number;
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
      untilNextOppTurn?: boolean;
    }
  | {
      t: "dice";
      optional?: boolean;
      rolls?: number;
      /** 振る回数を実行時に決める (「(参照)X枚につき、サイコロを1回振る」) */
      rollsFrom?: {
        per: "stacked" | "stageMascotFan" | "stageTagDistinct" | "stageMascot";
        tag?: string;
        /** 「(参照)X枚につき」のX (省略時1。stageMascot「マスコット2枚につき」等) */
        perN?: number;
        /** 「ただし、振れる回数はX回まで」 */
        max?: number;
      };
      branches: DiceBranch[];
      /** 修正後の出目ごとに、その枚数になるまで手札を引く */
      drawUntilRoll?: boolean;
      /** 出た目の合計1につきアーツ+X */
      sumArtPlus?: number;
      /** 集計分岐: 奇数がX回以上出たなら (全ロール終了後に評価) */
      aggOdd?: { atLeast: number; ops: Op[] };
      /** engine内部: 「振る時」リアクティブ(目の宣言)を確認済み */
      reactChecked?: boolean;
      /** engine内部: 現在の出目で振り直し系リアクティブを確認済み */
      rerollChecked?: boolean;
      /** engine内部: このdice解決中に推しの振り直し能力を確認済み (同じ誘発の再確認防止) */
      rerollOshiChecked?: boolean;
      /** engine内部: 振り直し確認で保留した出目 (再開時にこの値を使う。rerollDiceでクリア) */
      forcedRoll?: number;
      /** engine内部: 一括で振った出目。振り直しの選択中は結果を適用せず保持する */
      pendingRolls?: number[];
      /** engine内部: 振り直しは同じ試行の置換なので履歴へ追加しない */
      rollCounted?: boolean;
      /** engine内部: 出目変更を始めた後は振り直しの確認に戻らない (5.24.4) */
      rerollsFinished?: boolean;
      /** engine内部: 現在の出目についてサイコロ演出の完了を待機済み */
      animationWaited?: boolean;
      /** 振り直し後に確定した、まだ適用していない出目置換効果 */
      pendingDiceMods?: GameState["diceMods"];
      /** この出目に対して使用を見送ったファン */
      declinedDiceFans?: string[];
    }
  | {
      t: "searchDeck";
      filter: CardFilter;
      nMax: number;
      /** 種別ごとの選択枠 (「[AとB]X枚ずつとCX枚」) */
      groups?: { filter: CardFilter; max: number }[];
      /** groups内で同じカード名でなければならないグループのindex */
      sameNameGroups?: number[];
      dest: "hand" | "stage" | "attach" | "archive";
      /** 検索札を公開してから、この枚数を手札へ、残りを指定領域へ移す。 */
      revealThenPick?: { n: number; restTo: "archive" };
      /**
       * テキストに「公開し」が無い検索。デッキは非公開領域なので、
       * 手札に加えたカードの名称を相手のログに出してはいけない。
       */
      noReveal?: boolean;
      /** attach時の付け先制限 (名称) */
      attachTargetNames?: string[];
      /** attach時の付け先制限 (色/タグ等の汎用フィルタ) */
      attachTargetFilter?: TargetFilter;
      /** attach時に発生源自身に付ける */
      attachToSelf?: boolean;
      /** 選んだ複数カードを1人に付ける */
      attachSameTarget?: boolean;
    }
  | {
      t: "lookTop";
      source: "deck" | "cheer" | "holo";
      n: number;
      /** 動的枚数 (相手の手札と同じ枚数) */
      nFrom?: "oppHand" | "stageYell";
      pickFilter: CardFilter;
      /** 「N枚を加える」など、候補がある限り選ぶ枚数 */
      pickMin?: number;
      pickMax: number; // 「好きな枚数」は大きな値
      /** 条件を満たすカードを任意選択ではなくすべて選ぶ */
      pickAllMatching?: boolean;
      /** 種別ごとの選択枠 (「ホロメンX枚と(F)X枚」)。指定時はpickFilter/pickMaxより優先して選択セットを検証 */
      pickGroups?: { filter: CardFilter; max: number }[];
      /** 選んだカードの行き先 */
      pickDest: "hand" | "cheerAssign" | "archive";
      /** 選んだカードを相手にも公開する */
      revealPick?: boolean;
      /** 最初に見た全カードを相手にも公開する */
      revealAll?: boolean;
      pickTargetFilter?: TargetFilter;
      rest: "bottom" | "top" | "archive" | "shuffle";
      /** 残りを戻す順番をプレイヤーが指定する */
      restOrder?: boolean;
    }
  | { t: "millDeck"; n: number; max?: number; optional?: boolean } // max指定で「n〜max枚」。アーカイブ前に枚数を決める
  | { t: "drawPerMilled"; per: number; draw: number } // アーカイブしたカードper枚につきdraw枚引く
  // このホロメンに付いている〈N〉per枚につきdraw枚引く (公式Q598)
  | { t: "drawPerAttachedName"; names: string[]; per: number; draw: number }
  | { t: "handToDeckBottomNamed"; n: number; names: string[] } // 手札の指定名カードを公開しデッキの下に戻す (コスト)
  | {
      t: "backToDeckBottom";
      n: number;
      filter?: TargetFilter;
      /** 支払いコストなら全人数を要求する。必須効果の対象不足では後続を止めない。 */
      cost?: boolean;
    } // 自分のバックホロメンをデッキの下に戻す (エール/サポートはアーカイブ)
  | { t: "millCheer"; n: number; max?: number } // max指定で「n〜max枚」。アーカイブ前に枚数を決める
  | {
      t: "revealTop";
      n: number;
      /** 動的枚数 (自分のステージのエール枚数) */
      nFrom?: "stageYell";
      /** 「見る」効果。カード名と候補は効果の使用者にだけ見せる */
      ownerOnly?: boolean;
    }
  | { t: "revealHoloTop"; n: number } // ホロパワーの上からn枚を公開 (ctx.revealedに記録)
  | {
      t: "revealedTo";
      /** 公開札のアーカイブ置換を確認済み。選択後の再開で二重に適用しない */
      replacementChecked?: boolean;
      dest: "archive" | "hand" | "deckTop" | "deckBottom" | "holoBottom";
      /** デッキへ戻す順番をプレイヤーが指定する */
      orderMatters?: boolean;
    }
  | {
      t: "archiveStageYell";
      n: number;
      pos?: "back";
      stackFilter?: TargetFilter;
      yellColor?: Color;
      /** 肩代わり (yellArchiveSub) を断った付与サポート。同じ確認を繰り返さない */
      subSkipUids?: string[];
    }
  | {
      t: "specialPerOppCenterYell";
      per: number;
      target: StackTarget;
    }
  | {
      t: "cheerFromTop";
      n: number;
      target: StackTarget;
      filter?: TargetFilter;
      optional?: boolean;
      /** この送付で複数枚すべてを同じ1人へ送る */
      sameTarget?: boolean;
      /** 分割実行時に最初の送付で確定した送り先 */
      requiredTargetStackId?: number;
      /** このホロメンのエール1枚につきn枚送る (実行時にエール数で倍化) */
      perSelfYell?: boolean;
      /** このターンに#tagを持つホロメンがBloomした回数per回につきn枚送る */
      perBloomTag?: { tag: string; per: number };
    }
  | {
      t: "cheerFromArchive";
      n: number;
      target: StackTarget;
      filter?: TargetFilter;
      optional?: boolean;
      /** アーカイブから送るエールの色制限 (指定色のいずれか) */
      colors?: Color[];
      /** 「n〜max枚」/「好きな枚数」: 選択プロンプトで枚数と対象を選ぶ */
      max?: number;
      /** 「(対象)全員に1枚ずつ送る」: 対象人数分のエールを選んで割り振る */
      each?: boolean;
      /** 「アーカイブの〈N〉per枚につき、エールn枚を送る」(実行時にn/maxを倍化) */
      perArchiveNamed?: { names: string[]; per: number };
      /** 「ただし、ホロメン1人に送る枚数はX枚まで」 */
      perTargetMax?: number;
      /** 複数枚すべてを同じ1人へ送る */
      sameTarget?: boolean;
    }
  | {
      t: "cheerFromArchiveToGroups";
      nEach: number;
      targetGroups: TargetFilter[];
      optional?: boolean;
    }
  | {
      t: "searchCheer";
      filter: CardFilter;
      n: number;
      /** 範囲指定の下限。省略時はn枚（非公開カードの条件付き検索は0枚も可）。 */
      min?: number;
      targetFilter?: TargetFilter;
    }
  | {
      t: "moveArchive";
      filter: CardFilter;
      min: number;
      max: number;
      dest:
        | "hand"
        | "cheerDeck"
        | "deck"
        | "deckTop"
        | "deckBottom"
        | "attach"
        | "stage";
      /** attach時の付け先制限 (名称) / 発生源自身に付ける */
      attachTargetNames?: string[];
      /** attach時の付け先制限 (色/タグ等の汎用フィルタ) */
      attachTargetFilter?: TargetFilter;
      attachToSelf?: boolean;
      /** 選んだ複数カードを1人に付ける */
      attachSameTarget?: boolean;
      /** attach時に発生源自身を付け先から除外する (「他の」) */
      attachExcludeSource?: boolean;
      optional?: boolean;
      /** 枚数を「アーカイブしたカードper枚につきn枚」で動的に決める (min/maxを上書き) */
      maxPerMilled?: { per: number; n: number };
      /** 移動先へ置く順番を選択順で指定する */
      orderMatters?: boolean;
    }
  | { t: "holoPowerFromDeck"; n: number }
  | { t: "drawPerStageNamesYell"; names: string[]; color?: Color; n: number }
  | {
      t: "holoPowerPerStageNamesYell";
      names: string[];
      color?: Color;
      n: number;
    }
  | {
      t: "archiveHoloPowerAny";
      min: number;
      max?: number;
      /** 旧保存の逐次支払いから再開する場合、既に支払った枚数を保持する */
      accumulate?: boolean;
      /** 手札アーカイブの置換として支払い、元能力のアーカイブ枚数へ合算する */
      forHandReplacement?: boolean;
    }
  | {
      t: "archiveRemainingHand";
      total: number;
      original: Extract<Op, { t: "archiveHand" }>;
    }
  | { t: "markOshiSkillUsed"; name: string }
  /** 10.7.2.5.4: 本文解決後の盤面で推しスキル使用時の能力を待機させる。 */
  | { t: "emitOshiSkillUsed"; player: 0 | 1; sp: boolean; name: string }
  | { t: "markOncePerGameUsed"; key: string }
  | { t: "archiveHoloPower"; n: number }
  | { t: "handToHoloPower"; n: number }
  | {
      t: "archiveSelfYell";
      color?: Color;
      colors?: Color[];
      excludeColor?: Color;
      n: number;
      all?: boolean;
      subSkipUids?: string[];
    }
  | { t: "archiveSelfYellAny"; min?: number; max?: number } // このホロメンのエールを好きな枚数アーカイブ (選択プロンプト、ctx.milledに記録)
  | {
      t: "archiveStacked";
      n: number;
      level?: "Debut" | "1st" | "2nd";
      /** 指定した名前を持つ自分のホロメン全員の重なりから支払う。省略時は発生源のみ。 */
      holderNames?: string[];
      /** 枚数指定ではなく、重なっている対象すべてをアーカイブ */
      all?: boolean;
    } // このホロメンに重なっている(レベル)ホロメンをアーカイブ
  | {
      t: "archiveAttached";
      n: number;
      kind?: "ツール" | "マスコット" | "ファン";
    } // 付いているサポートをアーカイブ
  | {
      t: "moveYell";
      min: number;
      max: number;
      targetFilter?: TargetFilter;
      /** 同一ホロメンに送れる枚数の上限 (「X人にX枚ずつ」) */
      perTargetMax?: number;
      /** 複数枚すべてを同じ1人へ付け替える */
      sameTarget?: boolean;
      optional?: boolean;
      /** 発生源ホロメンに付いているエールのみ移動元にする */
      fromSelf?: boolean;
      /** 移動元ホロメンの条件 (「#Tを持つホロメンのエール」等) */
      sourceFilter?: TargetFilter;
      /** 移動元エールの色制限 */
      color?: Color;
      /** 移動元エールの色制限 (いずれかの色。「[CエールかCエール]」) */
      colors?: Color[];
      /** 相手のステージのエールを相手のホロメンに付け替える */
      side?: "opp";
    }
  | {
      t: "turnCostMod";
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
      artCostless?: number;
      /** アーツに必要な特定色コストの軽減 */
      artColorCostless?: { color: Color; n: number };
      /** アーツをエールを必要とせずに使える */
      artsFree?: boolean;
      batonDelta?: number;
      /** 次の相手ターン終了まで有効 */
      untilNextOppTurn?: boolean;
      /** このゲームの間ずっと有効 */
      permanent?: boolean;
    }
  | { t: "setHp"; target: StackTarget; value: number; filter?: TargetFilter }
  | {
      t: "archiveHand";
      n: number;
      /** 任意コストの支払い。肩代わりを辞退しても最低枚数を満たす必要がある。 */
      requireFullPayment?: boolean;
      max?: number;
      tag?: string;
      holomenOnly?: boolean;
      supportOnly?: boolean;
      limited?: boolean;
      sameTag?: boolean;
      replacementChecked?: boolean;
    }
  | {
      t: "handToDeckBottom";
      n: number;
      top?: boolean;
      filter?: CardFilter;
      reveal?: boolean;
    }
  | { t: "handToDeckBottomAny" }
  | { t: "shuffleHandIntoDeck"; thenDraw: number }
  | { t: "bothShuffleHandIntoDeck"; thenDraw: number } // お互いの手札すべてをデッキに戻してシャッフルし、それぞれthenDraw枚引く
  | { t: "stackedToHand"; min: number; max: number } // 選んだホロメンに重なっているホロメンを手札に戻す (ctx.pickedCardsに記録)
  | { t: "handRevealToDeckBottom"; n: number; filter: CardFilter } // 手札の(F)n枚を公開しデッキの下に戻す (ctx.pickedCardsに記録)
  | { t: "diceVs"; geOps: Op[]; ltOps: Op[] } // お互いにサイコロを振り、自分の目が相手以上ならgeOps、小さいならltOps
  | { t: "boundToDeckBottom" } // 選んだホロメンのトップをデッキの下へ、下札/エール/サポートをアーカイブ (4.4.7)
  | { t: "boundStackAllToDeckBottom" } // 明記された効果: 選んだスタックの全ホロメンを好きな順でデッキ下へ (付属カードは4.4.7でアーカイブ)
  | { t: "boundRestToBack" } // 選んだホロメンをお休みさせてバックポジションに移動させる
  | { t: "noActivateNextReset" } // 選んだホロメンは次のリセットステップでアクティブにならない
  | { t: "selfCardToDeck" } // このカード(使用したサポート)をデッキに戻してシャッフルする
  | { t: "finishSupportCard"; uid: string } // engine内部op: 解決中のサポートをアーカイブへ置く
  | { t: "selfToBack"; optional?: boolean } // このホロメン(発生源)をバックポジションに移動する
  | { t: "selfSwapWithCollab"; maxRemainingHp?: number; optional?: boolean } // (バックの)このホロメンとコラボホロメンを交代する
  | { t: "chooseOps"; label: string; thenOps: Op[]; elseOps: Op[] } // 二択の効果選択 (effectConfirmプロンプト)
  | {
      /** 「次の相手のターンの間、(対象)が(位置で)最初に受けるアーツダメージ-X」(消費型ターン修正) */
      t: "turnFirstArtReduce";
      value: number;
      target: StackTarget;
      pos?: "center";
      untilNextOppTurn?: boolean;
    }
  | { t: "turnArtPlusPerBoundYell"; value: number; max?: number }
  | { t: "shuffleHolo" }
  | { t: "restSelf" }
  | {
      t: "activate";
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
    }
  | { t: "activateCheerRecipients" }
  | { t: "rest"; target: StackTarget; count?: number; filter?: TargetFilter } // 対象をお休みさせる
  | {
      t: "down";
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
      noLife?: boolean;
    } // 対象をダウンさせる
  | { t: "archiveOppYell"; n: number; fromCenter?: boolean }
  | {
      t: "oppYellToCheerBottom";
      n: number;
      scope?: "center" | "collab" | "front";
    } // 相手のステージのエールをエールデッキの下に戻す (scope未指定=ステージ全体)
  | { t: "oppFrontYellsToCheerBottom"; nEach: number } // 相手センター/コラボから各n枚を選び、全体を好きな順で相手エールデッキ下へ
  | { t: "oppArchiveYellToOppCenter"; n: number } // 相手のアーカイブのエールを相手のセンターホロメンに送る
  | { t: "archiveHandAll"; replacementChecked?: boolean } // 手札すべてをアーカイブ (ctx.milledに記録)
  | { t: "handArchiveHolomenToDeckShuffle" } // 手札すべて+アーカイブのホロメンすべてをデッキに戻してシャッフル (手札枚数をctx.returnedBothに記録)
  | { t: "drawPerHandReturned"; per: number; draw: number } // 手札からデッキに戻した枚数per枚につきdraw枚引く
  | { t: "revealOppHand" } // 相手の手札すべてを見る (詳細は効果使用者にだけ表示)
  | { t: "drawPerBothStageYell"; per: number; draw: number } // お互いのステージのエールper枚につきdraw枚引く
  | { t: "drawPerOppOshiDiff"; per: number; draw: number } // 相手の推しと異なる色を持つ相手のホロメンper人につきdraw枚引く
  | { t: "drawPerOppCenterBaton"; per: number; draw: number } // 相手のセンターのバトンタッチに必要な無色per個につきdraw枚引く
  | { t: "specialPerArtTargetBaton"; per: number; dmg: number } // このアーツの対象に、そのバトンコストper個につき特殊ダメージdmg
  | { t: "healSelfPerArtDealt"; per: number; heal: number } // このアーツで与えたダメージper につきこのホロメンのHPheal回復 (与ダメージ時の自動能力)
  | { t: "oppHoloPowerToHand"; n: number } // 相手は自身のホロパワーの上からn枚を手札に加える
  | {
      t: "cheerFromTopPerOverkill";
      per: number;
      n: number;
      target: StackTarget;
      filter?: TargetFilter;
      sameTarget?: boolean;
    } // オーバーしたダメージperにつきエールデッキの上からn枚送る
  | {
      t: "turnCostModPerUsedEvent";
      tag?: string;
      per: number;
      costless: number;
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
    } // 使ったイベントper枚につきアーツ無色-costless
  | { t: "bothHandToDeckBottom" } // お互い手札すべてをデッキの下に戻す (ctx.returnedBothに記録)
  | { t: "bothDrawPerReturned"; per: number; draw: number } // お互い、戻した枚数per枚につきdraw枚引く
  | { t: "lifeMinus"; n: number }
  | { t: "oppLifeMinus"; n: number }
  | { t: "lifeImmuneFromOpp" } // このターンの間、自分のライフは相手の能力で減らない
  | { t: "artDiceParityBranch"; oddOps: Op[]; evenOps: Op[] } // そのアーツで振った出た目の合計が奇数ならoddOps/偶数ならevenOps
  | { t: "lifeLossMinus"; n: number } // 自分の減るライフ-X (全ダウン時能力の解決まで保留中のライフを減らす)
  | { t: "downedYellMove"; n: number | "all"; min?: number; color?: Color } // ダウンしたホロメンに付いているエールを自分の他のホロメンに付け替える
  | {
      t: "downedToHand";
      what: "holomen" | "fan" | "support";
      n: number | "all";
      filter?: CardFilter;
    } // ダウンしたホロメンの重なり/付いていたサポートをアーカイブから手札に戻す
  | { t: "limitedLimit"; n: number } // このターンの間、使えるLIMITEDのサポートカードの枚数はn枚になる
  | { t: "bothMillCheer"; n: number } // お互いのエールデッキの上からn枚をアーカイブ (ctx.milledに記録)
  | { t: "drawPerMilledYellColor"; per: number; draw: number } // アーカイブしたエールper色につきdraw枚引く
  | { t: "turnArtPlusEachYellColor"; value: number; filter?: TargetFilter } // ステージの(F)全員に、各自のエールの色数×valueのターンアーツ修正
  | {
      t: "downReward";
      tag?: string;
      oppLifeMinus?: number;
      draw?: number;
      boundSubject?: boolean;
      anyHolomen?: boolean;
      artDamageOnly?: boolean;
    } // このターンの間、自分の(#tag/選んだ)ホロメンが相手の(センター)ホロメンをダウンさせた時、相手のライフ-X/自分がX枚引く
  | { t: "artNoReduce" } // このアーツダメージは軽減されない (ctx.artNoReduce)
  | {
      t: "archiveOppAttached";
      kind: "ツール" | "マスコット" | "ファン";
      n: number;
      optional?: boolean;
      allStage?: boolean;
    } // 相手の[センターかコラボ]に付いている(種別)X枚をアーカイブ
  | { t: "extraTurn" } // このターンの後に、もう1回自分のターンを開始する
  | { t: "devolve"; target: StackTarget; count?: number; filter?: TargetFilter } // 対象をDebutホロメンに戻す (ダメージ0、Debut+エール以外を持ち主の手札へ)
  | {
      t: "turnNoSwitch";
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
      untilNextOppTurn?: boolean;
    } // 対象はバトンタッチ・移動・交代できない
  | { t: "drawPerStageTag"; tag: string; distinct?: boolean; draw: number }
  | {
      t: "swapCenter";
      side: "own" | "opp";
      requireActive?: boolean;
      filter?: TargetFilter;
    } // filter=交代先バックホロメンの条件
  | { t: "resume"; inner: EffectContextData } // engine内部op: 中断していた別ctxの実行を再開する (リアクティブ挿入用)
  | { t: "continueRuleProcessing"; deferTriggers?: boolean } // engine内部op: ルール処理へ進む。独立したライフ送付ctxの誘発を引き継げる
  | { t: "checkRuleTiming" } // engine内部op: 能力1つの解決後にルール処理を行う
  | { t: "continueTriggerAbilities"; abilities: TriggerAbility[] } // engine内部op: 同じプレイヤーの同時誘発能力を選択順に解決
  | { t: "finishPerformanceStep" } // engine内部op: 開始時能力を終えてから、アーツを使わず終了時能力へ進む
  | { t: "beginEndStep" } // engine内部op: パフォーマンス終了時能力の解決後にエンドステップを開始
  | {
      t: "offerReactiveSkill";
      sp: boolean;
      skillName: string;
      description: string;
      cost: number;
      ops: Op[];
    } // engine内部op: 誘発能力の順序選択に含めた任意の推しスキルを確認
  | { t: "enforceSupportLimits"; stackId: number } // Bloom等で上限能力を失った直後のルール処理
  | {
      t: "runTriggerAbilities";
      player: 0 | 1;
      abilities: TriggerAbility[];
      label?: string;
      defer?: boolean; // 解決中の効果を終えてから、チェックタイミングでプレイする
    } // engine内部op: 指定プレイヤーの同時誘発能力を解決して元ctxへ戻る
  | {
      t: "afterArtDamage";
      /** このアーツの正の与ダメージで待機する自動能力の本文。 */
      dealtOps?: Op[];
      targetStackId: number;
      targetPlayer: 0 | 1;
      targetPos: "center" | "collab" | { back: number };
      damage: number;
      /**
       * アーツダメージを与える前に対象がいなくなっていた。
       * 「アーツを使った時」は発揮するが、このアーツのダメージでダウンさせては
       * いないので `artDowned` は立てない。
       */
      targetLost?: boolean;
    } // engine内部op: ダウン処理の前に誘発能力とアーツ結果を記録する
  | {
      t: "afterSpecialDamage";
      targetStackId: number;
      targetPlayer: 0 | 1;
      targetPos: "center" | "collab" | { back: number };
      damage: number;
      /** 同じ処理で正の特殊ダメージを受けた相手ホロメンの人数 (Q752)。 */
      opponentTargetCount?: number;
    } // engine内部op: ダウン処理の前に特殊ダメージの誘発能力を記録する
  | {
      t: "swapCollabBack";
      collabFilter?: TargetFilter;
      backFilter?: TargetFilter;
    } // 自分のコラボホロメンとバックホロメンを交代させる
  | { t: "redirectDamage" } // engine内部op: 保留中のアーツダメージ(resume内)の対象を bound に付け替える (身代わり)
  | { t: "reduceReceivedDamage"; value: number; negate?: boolean } // engine内部op: 保留中のアーツダメージ(resume内)の被ダメージを-X (負値/negateで無効) (付与サポート/ギフトの振り込みリアクティブ)
  | { t: "markGiftUsed"; key: string } // engine内部op: 板面ギフトの[ターンにX回]使用回数を1消費する
  | { t: "markTriggerUsed"; key: string } // engine内部op: 任意コスト確定後など、能力を実際に使用した時点で回数を1消費する
  | { t: "declareDice" } // サイコロの目の数1つを宣言し、次に出る目を宣言した目として扱う (AZKi推し)
  | { t: "rerollDice" } // 保留中のサイコロ(ctx.rest内のforcedRoll付きdice)を振り直す (紫咲シオン推し)
  | { t: "turnArtPlusAttachedTo"; value: number } // このターンの間、直前の効果で付けた先のホロメンのアーツ+X
  | { t: "turnSpecialPlus"; value: number } // このターンの間、選んだホロメンが相手に与える特殊ダメージ+X (bound対象)
  | { t: "artDamageToFronts" } // このアーツダメージを、対象のかわりに相手のセンターホロメンとコラボホロメンに与える (保留中のartDamageを置換)
  | { t: "janken"; winOps: Op[] } // 相手と勝敗が決まるまで両者が手を選び、効果使用者が勝ったらwinOpsを実行
  | { t: "turnSpecialAttack"; color: Color; value: number } // このターンの間、このホロメンは(色)特攻+Xを得る
  | {
      t: "repeatArtNow";
      /** 「同じホロメンに」の明記がある場合だけ、直前と同じ対象へ固定する */
      sameTarget?: boolean;
      /** 再使用対象の選択プロンプトを解決済み */
      targetChosen?: boolean;
    } // このアーツをもう1回使う (アーツのopsを再構築してctxに積む)
  | { t: "repeatArtCheck" } // engine内部op: アーツ解決後にrepeatArtターン修正を確認し、あればもう1回使う (useArtsが末尾に積む)
  | { t: "repeatArtGrant"; optional?: boolean; target?: "bound" | "self" } // このターンの間、対象はアーツを使った後、同じアーツをもう1回使う(使える)
  | {
      t: "chooseBind";
      filter?: TargetFilter;
      scope: "own" | "ownBack" | "ownCollab" | "ownCenter" | "opp" | "oppFront";
      /** 選ぶ人数 (省略時1) */
      count?: number;
      /** 選ぶ人数を実行時に決める (「この能力でアーカイブしたカードX枚につき、X人を選ぶ」) */
      countFrom?: "milled" | "picked";
      /** 既存の束縛をリセットせず追加する (「[〈A〉と〈B〉]1人ずつを選ぶ」の2つ目以降) */
      append?: boolean;
      /** 選ぶホロメン同士は異なる色でなければならない (「異なる色のホロメンX人を選ぶ」) */
      distinctColors?: boolean;
    }
  | {
      t: "turnAllColors";
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
    }
  | {
      /** このターンの間、対象のアーツは相手の(条件)バックホロメンも対象にできる */
      t: "turnArtTargetExtend";
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
      /** 対象にできるバックホロメンの条件 (省略=バック全員) */
      extendFilter?: TargetFilter;
    }
  | { t: "moveMascot"; optional?: boolean } // ステージのマスコット1枚を別ホロメンへ付け替え
  | {
      /** このターンの間、(枚数参照)1枚につき対象のアーツ+X (実行時に枚数を確定) */
      t: "turnArtPlusPerCount";
      value: number;
      per:
        | "centerYell"
        | "selfYell"
        | "selfYellColor"
        | "revealedSupport"
        | "ownBack"
        | "stageNames" // 自分のステージの〈N〉X枚 (ホロメン+付与サポートを名称で数える)
        | "milled" // この能力でアーカイブしたカード枚数
        | "stageTag" // 自分のステージの#tag持ちホロメン人数 (distinctNames=異なるカード名のみ)
        | "usedSupport" // このターンに自分が使っていたサポートカード枚数
        | "stageYell" // 自分のステージのエール総数
        | "picked" // 戻した(選んで移動した)カード枚数 (ctx.pickedCards)
        | "archiveFilter";
      countFilter?: CardFilter;
      holoPowerCount?: boolean;
      milledSupportCount?: boolean;
      color?: Color;
      names?: string[];
      tag?: string;
      distinctNames?: boolean;
      /** per で数える枚数・人数の上限 */
      max?: number;
      target: StackTarget;
      count?: number;
      filter?: TargetFilter;
    }
  | {
      t: "stageYellToCheerBottom";
      n: number;
      /** 支払いコストだけは全枚数を要求する。通常の効果は可能な枚数を戻して続行。 */
      cost?: boolean;
    }
  | { t: "scheduleEndArchiveStageYell"; n: number }
  | { t: "selfYellToCheerBottom" } // このホロメンのエールすべてをエールデッキの下に戻す (枚数をctx.returnedYellに記録)
  | { t: "drawUntilReturnedYell" } // 手札がctx.returnedYellと同じ枚数になるまで引く
  /** 自分の(F)ホロメンX人につき、内側の効果をその人数分繰り返す */
  | { t: "repeatPerStage"; filter: TargetFilter; pos?: "back"; ops: Op[] }
  | { t: "if"; cond: Cond; then: Op[] }
  | { t: "ifElse"; cond: Cond; then: Op[]; else: Op[] }
  | {
      /** 選んだホロメンが条件を満たす時、直前のターンアーツ修正を置換/加算する */
      t: "boundArtPlusReplace";
      levels?: ("Debut" | "1st" | "2nd" | "Buzz")[];
      tag?: string;
      color?: Color;
      yellAtLeast?: number;
      yellColor?: Color;
      value: number;
      /** 置換ではなく加算 (「さらに、そのアーツ+X」) */
      add?: boolean;
    }
  | { t: "applyDiceModifier"; index: number }
  | { t: "skipDiceFan"; uid: string }
  | { t: "forceOppCollab" }
  | { t: "swapOppCenterCollab" } // 相手のセンターとコラボのホロメンを入れ替える
  | { t: "drawPerPicked"; per: number; draw: number } // この効果で手札に戻したカードper枚につきdraw枚引く
  | {
      /** このターンの間、サイコロの目の数を修正する (Xとして扱う / 倍として扱う) */
      t: "diceMod";
      value?: number;
      double?: boolean;
      /** 発生源ホロメン名の限定 (推し能力含む) */
      names?: string[];
      /** 1度にこの回数以上振る時のみ適用 */
      rollsAtLeast?: number;
      /** 1度にちょうどこの回数振る時のみ適用 */
      rollsExactly?: number;
    }
  | { t: "noRestReset"; names: string[] } // このゲームの間、指定名はリセットステップでお休みしない
  | {
      t: "archiveStageSupports";
      partial?: boolean;
      names: string[];
      n: number;
      max?: number;
      filter?: CardFilter;
    } // ステージの指定名サポートをアーカイブ (ctx.milledに記録)
  | {
      t: "cheerFromTopPerMilled";
      per: number;
      n: number;
      target: StackTarget;
      filter?: TargetFilter;
      sameTarget?: boolean;
    } // アーカイブしたper枚につきエールデッキ上からn枚送る
  | { t: "revealedTopOrBottom" } // 公開したカードをデッキの上か下に戻す (選択)
  | { t: "revealedArchiveOrTop" } // 公開したカードをすべてアーカイブするか、好きな順でデッキの上に戻す (選択)
  | { t: "returnDownedToHand"; uids: string[] }
  | {
      /** 手札/アーカイブのホロメンを使って対象をBloomさせる */
      t: "effectBloom";
      /** Bloom先(ステージ側)のポジション限定 */
      targetPos?: "center" | "back";
      /** 発生源自身をBloom先にする */
      targetSelf?: boolean;
      /** 直前のchooseBindで選んだホロメンだけをBloom先にする */
      targetBound?: boolean;
      /** Bloom先の条件 */
      filter?: TargetFilter;
      /** Bloomに使うカードの供給源 */
      source: "hand" | "archive" | "stacked" | "deck";
      /** Bloomに使うカードの条件 */
      cardFilter?: CardFilter;
      /** 「もう1回Bloomできる」: このターンにBloom済みでもよい */
      rebloom?: boolean;
      /** 「この能力では最初のターンでもBloomできる」 */
      allowFirstTurn?: boolean;
      /** Bloomレベルの順番を無視 */
      ignoreLevel?: boolean;
      optional?: boolean;
    }
  | {
      /** effectBloom の後段: ctx.boundStackId のホロメンへ使うカードを選ぶ (engine内部) */
      t: "effectBloomPick";
      source: "hand" | "archive" | "stacked" | "deck";
      cardFilter?: CardFilter;
      rebloom?: boolean;
      allowFirstTurn?: boolean;
      ignoreEntered?: boolean;
      ignoreLevel?: boolean;
    }
  | { t: "recoverRevealedSupport" } // 公開したサポート1枚をアーカイブするかわりに任意で手札へ
  | { t: "forceDiceResult"; value: number; index?: number } // 保留中のサイコロ1個の目を指定値として扱う
  | { t: "turnBackSpecialImmune" } // このターン中、自分のバック全員は特殊ダメージを受けない
  // リアクティブ確認後の特殊ダメージ再開 (確定した軽減・無効を持ち回る)
  | {
      t: "finishSpecialDamageBatch";
    }
  | {
      t: "specialToStack";
      dmg: number;
      targetStackId: number;
      noLife?: boolean;
      interruptChecked?: boolean;
      extraReduce?: number;
      negate?: boolean;
      diceReduceDone?: number[];
      /** このダメージに対して使用/辞退済みの置換効果ID */
      replacementDone?: string[];
    }
  | { t: "optionalCost"; cost: Op[]; then: Op[]; label: string }
  // ---- engine内部op (パーサーは生成しない) ----
  | {
      t: "artDamage";
      base: number;
      specialColor?: Color;
      specialDmg: number;
      targetStackId: number;
      /** 身代わり前の対象。特攻と「アーツの対象」の条件は受け先変更で変わらない。 */
      originalTargetStackId?: number;
      artName: string;
      /** アーツでダウンさせた時、11.3.1.1の能力プールで解決する本文。 */
      downedOps?: Op[];
      /** 与ダメージ時の自動能力。通常の使用時能力と同時に待機する。 */
      dealtOps?: Op[];
      /** リアクティブスキルの確認済みフラグ */
      interruptChecked?: boolean;
      /** リアクティブスキルによる軽減量 */
      extraReduce?: number;
      /** 閾値無効と通常軽減の適用順を選択済み。 */
      thresholdOrderResolved?: boolean;
      /** ダメージ無効化 (「そのダメージを受けない」) */
      negate?: boolean;
      /** この被弾インスタンスで既にサイコロ軽減を確認したギフト保持者のスタックid (再確認防止) */
      diceReduceDone?: number[];
      /** この被弾インスタンスで使用/辞退済みの置換効果ID */
      replacementDone?: string[];
    }
  | {
      t: "setSource";
      stackId: number;
      supportUid?: string;
      grantedSupportAbility?: boolean;
    }
  | { t: "selfSupportToHand" } // トリガー元の付与サポート自身を手札に戻す (アーカイブ済みでも可)
  | { t: "selfSupportToDeckTop" } // トリガー元の付与サポート自身をデッキの上に戻す
  | { t: "selfSupportToDeckBottom" } // トリガー元の付与サポート自身をデッキの下に戻す
  | { t: "stageSupportToDeckBottom"; names: string[]; n: number } // ステージの指定サポートをデッキ下へ戻すコスト
  | { t: "archiveSelfSupport" } // トリガー元の付与サポート自身をアーカイブする
  | {
      t: "archiveRedirect";
      uid: string;
      owner: 0 | 1;
      targetNames: string[];
      choice?: "attach" | "archive";
      recordArchived?: boolean;
    } // engine内部op: アーカイブ置換の選択と、選択後の元の処理再開
  | {
      t: "moveSelfSupport";
      targetFilter?: TargetFilter;
      optional?: boolean;
    } // トリガー元の付与サポートを別の自分のホロメンへ付け替える
  | { t: "changeArtTargetToOppBack"; optional?: boolean }
  // engine内部op: 使用コストの支払いを終えた付与サポートを ctx.pendingAttach の位置へ付ける
  | { t: "attachPlayedSupport" }
  | {
      t: "emitTriggers";
      stackId: number;
      events: TriggerEvent[];
      onlyUid?: string;
    };

export interface DiceBranch {
  cond:
    | "odd"
    | "even"
    | "geLife" // 出た目の数が自分のライフ以上
    | "leLife" // 出た目の数が自分のライフ以下
    | "eqBothLife"
    | { eq: number[] }
    | { ne: number[] } // 「X以外」
    | { ge: number }
    | { le: number }
    | { perValue: number }; // 「出た目の数Xにつき」: opsを floor(出た目/X) 回繰り返す
  ops: Op[];
  /** 「出た回数1回につき」の数量効果。該当する出目の回数を集計して解決する。 */
  countBased?: boolean;
}

export interface EffectProgram {
  ops: Op[];
  text: string;
  /**
   * 「[センターポジション限定]」等のヘッダから読んだ発動位置。
   * 未指定なら位置を問わない。発動可否の判定は呼び出し側が行う。
   */
  positions?: ("center" | "collab" | "back")[];
}

// ------------------------------------------------------------
// 付与型サポートの常時効果
// ------------------------------------------------------------
export interface PassiveCondition {
  anyOf?: PassiveCondition[];
  names?: string[];
  minBloom?: "1st" | "2nd";
  bloomLevels?: ("Debut" | "1st" | "2nd" | "Spot")[];
  buzz?: boolean;
  tag?: string;
}

/** トリガーイベントの種類 */
export type TriggerEvent =
  | "artUsed" // このホロメンがアーツを使った時
  | "dealtArt" // このホロメンが相手のホロメンにアーツダメージを与えた時
  | "downedOpponent" // このホロメンが相手のホロメンをダウンさせた時
  | "damaged" // このホロメンがダメージを受けた時
  | "incomingDamage" // このホロメンがダメージを受ける時（適用前）
  | "downed" // このホロメンがダウンした時
  | "allyDowned" // 自分の他のホロメンがダウンした時
  | "allyPlayed" // 自分のホロメンがステージに出た時
  | "allyCollabed" // 自分のホロメンがコラボした時 (主語が味方)
  | "allyArtUsed" // 自分のホロメンがアーツを使った時 (主語が味方)
  | "allyDownedOpponent" // 自分のホロメンが相手のホロメンをダウンさせた時
  | "handArchived" // 装着者の能力で自分の手札をアーカイブした時
  | "allyDealtSpecial" // 推し/味方が相手に特殊ダメージを与えた時
  | "allyDamaged" // 自分のホロメンが(アーツ)ダメージを受けた時 (主語が味方)
  | "batonTouched" // このホロメンがバトンタッチでバックに移動した時
  | "healed" // このホロメンが回復した時
  | "attachedFromHand" // このカードを手札から付けた時
  | "collabed" // このホロメンがコラボした時
  | "collabMoved" // このホロメンがコラボポジションに移動した時（交代も含む）
  | "bloomed" // このホロメンがBloomした時（同レベルも含む）
  | "bloomLevelUp" // このホロメンのBloomレベルが上がった時
  | "oppBackDowned" // 相手のバックホロメンがダウンした時 (保持者は自分側)
  | "dealtSpecial" // このホロメンが相手のホロメンに特殊ダメージを与えた時
  | "yellAttached" // このホロメンにエールが付いた時
  | "supportAttached" // このホロメンに〈X〉(付与サポート)が付いた時
  | "spSkillUsed" // 自分がSP推しスキルを使った時 (保持者自身は問わない板面トリガー)
  | "oshiSkillUsed" // 自分が推しスキルを使った時 (同上)
  | "yellArchived" // 自分のエールがアーカイブに置かれた時 (保持者自身は問わない板面トリガー)
  | "returnedToDeck" // 自分の(subjectFilter)ホロメンがステージからデッキに戻った時 (板面トリガー)
  | "oppPerfStepEnd" // 相手のパフォーマンスステップが終了する時 (保持者=防御側の板面トリガー)
  | "selfPerfStepEnd" // 自分のパフォーマンスステップが終了する時
  | "selfPerfStepStart" // 自分のパフォーマンスステップが開始する時 (保持者=ターンプレイヤーの板面トリガー)
  | "selfEndStepStart" // 自分のエンドステップが開始する時
  | "oppPerfStepStart";

// 相手のパフォーマンスステップが開始する時 (保持者=防御側の板面トリガー)

export interface TriggerDef {
  event: TriggerEvent;
  /** 推しスキル使用時の誘発に指定されたスキル名。省略時は名称を問わない。 */
  skillName?: string;
  ops: Op[];
  /** 「〜時に使える」等、誘発時に使用を見送れる能力 */
  optional?: boolean;
  /** allyDowned: ダウンしたホロメンが満たすべき条件 */
  subjectFilter?: TargetFilter;
  /**
   * allyDowned: 「このホロメン以外の」が書かれている。
   * 無い場合は保持者自身のダウンでも誘発する (公式Q451/Q452/Q570)。
   */
  excludeSelf?: boolean;
  /** [ターンにX回] 制限 */
  timesPerTurn?: number;
  /** 「相手のターンで、」の限定 */
  oppTurnOnly?: boolean;
  /** 「自分のターンで、」の限定 */
  selfTurnOnly?: boolean;
  /** ポジション限定 */
  positions?: ("center" | "collab")[];
  /** ◆条件部に書かれたトリガー (付与先が条件を満たす時のみ) */
  requiresCond?: boolean;
  /** 付与先ホロメンの条件 (「手札から1st以上の〈X〉に付けた時」等) */
  wearerFilter?: TargetFilter;
  /** attachedFromHand: アーカイブから付けた場合も発火する */
  attachedFromArchive?: boolean;
  /** このホロメンが指定レベルからBloomしている時のみ発火 (「1stホロメンからBloomしているこのホロメンが〜」) */
  selfBloomedFrom?: "Debut" | "1st" | "2nd";
  /** supportAttached: 付いた付与サポートがこの名称の時のみ発火 (「このホロメンに〈X〉が付いた時」) */
  attachedSupportNames?: string[];
  /** allyDamaged: アーツダメージに限定して発火 (「〜がアーツダメージを受けた時」) */
  artDamageOnly?: boolean;
  /** 指定されたアーツで実際にカードを公開した時のみ誘発する。 */
  revealedByArt?: string;
  /** 通常の使用時誘発と分離し、公開札をアーカイブする直前に適用する置換 */
  revealedArchiveReplacement?: boolean;
  /** エンドステップ開始時: 装着者がこのターンにアーツを使っていること */
  subjectUsedArtThisTurn?: boolean;
  /** 特殊ダメージ閾値トリガー */
  minDamage?: number;
  includeOshiSubject?: boolean;
  /** oppPerfStepEnd: 発火条件 (そのパフォーマンスステップに自分のライフが減った / このホロメンのHPが減っていない) */
  perfCond?: "selfLifeReduced" | "selfHpNotReduced";
  /**
   * downedOpponent: ダウンさせた相手ホロメンのポジション限定
   * (「相手の**センター**ホロメンをダウンさせた時」。アーツはコラボも対象にできるので、
   *  これが無いとコラボをダウンさせただけで誘発してしまう)
   */
  downedPos?: "center" | "collab";
}

/** 「受けるダメージ±X」の常時修正 */
export interface DamageTakenMod {
  delta: number;
  /** 装着者がこのタグを持つ場合は無効 */
  excludeTag?: string;
  /** このポジションにいる時のみ */
  positions?: ("center" | "collab")[];
  /** ◆条件部由来 */
  requiresCond?: boolean;
}

export interface PassiveBonus {
  yellAlias?: { from: Color; to: Color; requiresCond?: boolean };
  hpPlus: number;
  artPlus: number;
  /** artPlus/hpPlus が特定名称の時のみ有効 (「付いている〈X〉のアーツ+Y」) */
  baseCondNames?: string[];
  /** ◆条件付き追加ボーナス */
  cond?: PassiveCondition;
  condHpPlus: number;
  condArtPlus: number;
  /** condArtPlus/condHpPlus が有効なポジション (「[センターポジション限定]このホロメンのアーツ+X」) */
  condPositions?: ("center" | "collab")[];
  attachOnlyNames?: string[];
  /** トリガー能力 */
  triggers: TriggerDef[];
  /** 受けるダメージの常時修正 */
  damageTaken: DamageTakenMod[];
  /** 与える特殊ダメージ+X (◆条件付き含む。centerOnly=相手のセンターホロメンのみ) */
  specialDealtPlus?: {
    value: number;
    centerOnly?: boolean;
    requiresCond?: boolean;
  };
  /** アーツに必要な無色-X (◆条件付き含む) */
  artCostless?: { value: number; requiresCond?: boolean };
  /** アーツに必要なエールの色すべてを無色/◇にする (どの色のエールでも支払える) */
  allColorless?: { requiresCond?: boolean };
  /** アーツを使う時、このカードを指定色のエールとしても扱う (oshiNames=推しが指定名の時のみ) */
  asYell?: { color: Color; oshiNames?: string[]; requiresCond?: boolean };
  /** 装着者のバトンタッチに必要な◇±X */
  batonSelf?: { delta: number; requiresCond?: boolean };
  /** 相手のセンターホロメンのバトンタッチに必要な無色+X (装着者のポジション限定付き) */
  oppCenterBaton?: {
    delta: number;
    positions?: ("center" | "collab")[];
    requiresCond?: boolean;
  };
  /** 相手からダメージを受けない (ポジション限定付き) */
  noDamage?: {
    positions?: ("center" | "collab" | "back")[];
    requiresCond?: boolean;
  };
  /** 装着者のアーツダメージは軽減されない */
  artNoReduce?: { requiresCond?: boolean };
  /** 指定推しスキルのターン中使用回数を増やす */
  oshiSkillUsesBonus?: {
    skillName: string;
    value: number;
    requiresCond?: boolean;
    positions?: ("center" | "collab")[];
  };
  /** 相手のセンター/コラボホロメンをすべての色を持つホロメンとして扱う */
  oppFrontAllColors?: {
    positions?: ("center" | "collab")[];
    requiresCond?: boolean;
  };
  /** 自分のステージの指定名カード1枚につきアーツ+X */
  artPlusPerStage?: { names: string[]; value: number; requiresCond?: boolean };
  /** 相手のメインステップの間、HPが相手の能力で変動しない */
  protection?: { requiresCond?: boolean };
  /** 相手からの特殊ダメージを受けない (◆条件部由来ならrequiresCond) */
  noSpecialDamage?: { requiresCond?: boolean };
  /** 装着者が能力でサイコロを振った時、このカードをアーカイブして1回振り直せる (ファンの振り直し) */
  diceReroll?: { requiresCond?: boolean };
  /** 条件に合う能力のサイコロ1個を指定値として扱い、自身をアーカイブする */
  diceOneToValue?: {
    value: number;
    includeOshi?: boolean;
    subjectTag?: string;
    requiresCond?: boolean;
  };
  /** 相手のターンで装着者がダメージを受ける時、このカードをアーカイブして受けるダメージ-X (マスコット/ファンの振り込み軽減) */
  damageReduce?: { value: number; requiresCond?: boolean };
  /** 装着者の能力でエールをアーカイブする時、(指定色の)エール1枚のかわりにこのカードをアーカイブできる (SSRB/おかにゃん) */
  yellArchiveSub?: { color?: Color; requiresCond?: boolean };
  /** 実行時条件付きの常時ボーナス (「〜なら/〜間、このホロメンのアーツ/HP+X」) */
  condBonuses: {
    artPlus?: number;
    hpPlus?: number;
    cond: Cond;
    requiresCond?: boolean;
  }[];
  /** メインステップで使える起動型能力 (「[ターンにX回][ポジション限定]自分のメインステップで、<効果>」)。
   * requiresCond=◆条件部由来 (装着先が◆条件を満たす時のみ使える) */
  activated?: {
    ops: Op[];
    timesPerTurn?: number;
    positions?: ("center" | "collab")[];
    requiresCond?: boolean;
  }[];
  /** テキストを完全解析できたか */
  full: boolean;
}

// ============================================================
// アーツ自身のコスト軽減 (使用可否判定の前に適用)
// ============================================================

/**
 * アーツを使う時に必要なエールを軽減する修正。
 * costless: 減らす無色(=任意色)エール枚数。cond があればその条件成立時のみ、
 * per があれば数量に比例して costless 倍する。
 */
export type ArtCostMod = {
  costless: number;
  cond?: Cond;
  /** アーツ本文の位置限定。コストを払うホロメンの位置で判定する。 */
  positions?: ("center" | "collab" | "back")[];
  /** 指定時はその色の必要エールを減らす (省略時は無色扱いの軽減) */
  color?: Color;
  /** 「かわりに」: このmodの条件成立時、直前のmodを打ち消す */
  replacePrev?: boolean;
  per?:
    | { kind: "centerAttachedName"; names: string[] } // センターに付いている〈N〉1枚につき
    | { kind: "archiveYellColorsBoth" }; // お互いのアーカイブのエール1色につき
};

/** アーツの使用条件ゲート (使用可否を useArts が検証する) */
export interface ArtGate {
  /** このホロメンに指定名のカードが付いていないと使えない */
  requireAttachedNames?: string[];
  /** 自分のアーカイブにサポートカードがn枚以上ないと使えない */
  requireArchiveSupport?: number;
  /** この条件を満たさなければコラボポジションでは使えない */
  collabRequires?: Cond;
}

// ============================================================
// ギフト (ホロメンの常時/トリガー能力) の解析
// ============================================================

export interface GiftAura {
  value: number;
  filter?: TargetFilter;
  /** 対象からこのホロメン自身を除く */
  excludeSelf?: boolean;
  /** コラボポジションのホロメンのみ対象 */
  targetCollabOnly?: boolean;
  /** センターポジションのホロメンのみ対象 */
  targetCenterOnly?: boolean;
  /** ギフト保持者側で評価する発動条件 (「〜が付いている間、」等) */
  cond?: Cond;
  /** ギフト保持者がこのポジションにいる時のみ有効 */
  positions?: ("center" | "collab")[];
}

export interface GiftDef {
  /** 「自分のギフト『名称』はターンにN回」: 同名の保持者全員で共有する。 */
  sharedUseLimit?: { name: string; n: number };
  selfBatonMods?: { delta: number; cond?: Cond }[];
  colorlessAuras?: {
    filter: TargetFilter;
    targetPos: "collab";
    positions: ("center" | "collab")[];
  }[];
  healBonus?: { name: string; value: number; timesPerTurn: number };
  extraToolTag?: string;
  noArtDamageAtLeast?: { n: number; cond: Cond };
  triggers: TriggerDef[];
  /** このホロメンに付けられる付与型サポートの枚数上限 */
  supportLimits?: Partial<Record<"マスコット" | "ツール" | "ファン", number>>;
  /** 上限内でも同名カードを複数付けられない種類 */
  supportLimitDistinctNames?: ("マスコット" | "ツール" | "ファン")[];
  /** エール1枚につきHP+X */
  hpPerYell?: number;
  /** 重なっているホロメン1枚につきHP+X */
  hpPerStacked?: number;
  /** このホロメンに付いている指定名サポート1枚につきHP+X */
  hpPerAttachedName?: { names: string[]; value: number };
  /** 条件付きの自身HP+X */
  selfHpPlus: { value: number; cond?: Cond }[];
  /** 受けるアーツダメージ± (負=軽減) */
  artDamageTaken?: number;
  /** 条件付きの自身アーツ+X */
  selfArtPlus: {
    value: number;
    cond?: Cond;
    positions?: ("center" | "collab")[];
  }[];
  /** 条件付きの自身アーツコスト軽減 (「このホロメンのアーツに必要な{色/無色}-X」) */
  selfArtCostMods?: {
    /** 特定色の必要枚数を減らす (未指定なら無色/総数から減らす) */
    color?: Color;
    delta: number;
    cond?: Cond;
    positions?: ("center" | "collab")[];
  }[];
  /** このホロメンに付いている指定名サポート1枚につき無色コスト-X */
  artCostlessPerAttachedName?: { names: string[]; value: number };
  /** 味方へのアーツコスト軽減オーラ (「自分の〈X〉が付いている(F)ホロメンの〈Y〉のアーツに必要な(色)-Z」) */
  artCostAuras?: {
    /** 特定色の必要枚数を減らす (未指定なら無色/総数から減らす) */
    color?: Color;
    delta: number;
    /** 対象となる味方ホロメンのフィルタ (名称・装着名等) */
    filter?: TargetFilter;
    /** 対象がこのポジションにいる時のみ */
    targetPos?: "center" | "collab";
    /** ギフト保持者のポジション制限 */
    positions?: ("center" | "collab")[];
    /** ギフト保持者側で評価する発動条件 */
    cond?: Cond;
  }[];
  /** 味方へのオーラ (アーツ+X) */
  auras: GiftAura[];
  /** 味方への被ダメージ修正オーラ */
  damageAuras: {
    delta: number;
    filter?: TargetFilter;
    /** 対象がこのポジションにいる時のみ */
    targetPos?: "center" | "collab";
    /** ギフト保持者のポジション制限 */
    positions?: ("center" | "collab")[];
    /** このホロメン自身のみ (「このホロメンが受けるダメージ-X」) */
    selfOnly?: boolean;
    /** アーツダメージのみに適用 */
    artOnly?: boolean;
    /** 相手のホロメンを発生源とし、このフィルタに合致する時のみ (「相手の1stホロメンから受けるダメージ-X」) */
    fromSource?: TargetFilter;
    /** ギフト保持者側で評価する発動条件 (「自分の推しホロメンが〈X〉なら、」等) */
    cond?: Cond;
  }[];
  /** このホロメン自身が相手からダメージを受けない (「[バック限定]このホロメンは相手からダメージを受けない」) */
  noDamageSelf?: { positions?: ("center" | "collab" | "back")[] };
  /** 味方への特殊ダメージ免疫オーラ (「自分の(F)全員は相手から特殊ダメージを受けない」) */
  specialImmuneAuras?: {
    filter?: TargetFilter;
    targetPos?: "center" | "collab" | "back";
    positions?: ("center" | "collab")[];
  }[];
  /** 味方へのアーツダメージ免疫オーラ (「(条件なら、)自分の(F)全員は相手からアーツダメージを受けない」) */
  artImmuneAuras?: {
    filter?: TargetFilter;
    targetPos?: "center" | "collab" | "back";
    /** ギフト保持者に対して評価する発動条件 */
    cond?: Cond;
    positions?: ("center" | "collab")[];
  }[];
  /** 味方が与える特殊ダメージ+X オーラ (「自分のステージの〈X〉全員が相手の(センター)ホロメンに与える特殊ダメージ+Y」) */
  specialDealtAuras?: {
    value: number;
    /** どのホロメンが与える特殊ダメージに加算するか (発生源側で判定) */
    filter?: TargetFilter;
    /** 相手のセンターホロメンに与える時のみ */
    centerOnly?: boolean;
    /** 推しホロメンの〈X〉も対象 (「自分の推しホロメンの〈X〉と〜」) */
    includeOshi?: boolean;
    /** ギフト保持者のポジション制限 */
    positions?: ("center" | "collab")[];
  }[];
  /** 挑発: 相手のアーツはコラボしか対象にできない (特殊ダメージを除く) */
  taunt?: { cond?: Cond; positions?: ("center" | "collab")[] };
  /** このホロメンのアーツが相手のバックホロメンも対象にできる (「(条件なら、)このホロメンのアーツは、相手の(F)バックホロメンも対象にできる」) */
  selfArtTargetExtend?: { cond?: Cond; filter?: TargetFilter };
  /** 相手のメインステップの間、HPが相手の能力で変動しない */
  protection?: { positions?: ("center" | "collab")[] };
  /** 味方へのHP保護オーラ (「相手のメインステップの間、自分の(F)のHPは相手の能力で減らず、変動しない」) */
  protectionAuras?: {
    filter?: TargetFilter;
    targetPos?: "center" | "collab" | "back";
    positions?: ("center" | "collab")[];
  }[];
  /** 味方が相手からダメージを受ける時、サイコロを振って軽減できる (「サイコロを1回振れる：奇/偶で軽減/無効」) */
  allyDamageDiceReduce?: {
    /** 「このホロメン以外の」= 保持者自身は対象外 */
    excludeSelf?: boolean;
    /** 対象となる味方ホロメンのフィルタ (未指定なら全員) */
    filter?: TargetFilter;
    /** ギフト保持者のポジション制限 */
    positions?: ("center" | "collab")[];
    /** [ターンにX回] */
    timesPerTurn?: number;
    /** 奇数の時の軽減量 */
    oddReduce?: number;
    /** 偶数の時の軽減量 */
    evenReduce?: number;
    /** 奇数の時に無効化 (「そのダメージを受けない」) */
    oddNegate?: boolean;
  };
  /** メインステップで使える起動型ギフト能力 (「[ターンにX回][ポジション限定]自分のメインステップで(に使える)、(条件)?<効果>」) */
  activated?: {
    ops: Op[];
    /** 発動条件 (「このホロメンに〈X〉が付いている」「自分の推しホロメンが〈X〉」等。保持者側で評価) */
    cond?: Cond;
    timesPerTurn?: number;
    positions?: ("center" | "collab")[];
  }[];
  /** 相手のセンターホロメンのアーツに必要な無色+X (妨害オーラ。保持者=自分側) */
  oppCenterArtCostPlus?: {
    delta: number;
    /** 保持者側で評価する発動条件 (「相手のセンターのバトンタッチに必要な無色が5つ以上なら」等) */
    cond?: Cond;
    /** ギフト保持者のポジション制限 */
    positions?: ("center" | "collab")[];
  };
  /** ダウン時、アーカイブのかわりに手札に戻せる */
  downToHand?: { oppTurnOnly?: boolean; limitedArchiveToDeckBottom?: boolean };
  /** リセットステップでバックに移動してもお休みしない (「(条件の時、)このホロメンはバックポジションに移動してもお休みしない」) */
  noRestOnMove?: { cond?: Cond };
  /** 推しスキルのホロパワーコスト修正 */
  oshiSkillCostMod?: {
    skillName: string;
    delta: number;
    positions?: ("center" | "collab")[];
  };
  /** 対象と同色のエールがアーカイブにある時、アーツダメージは軽減されない */
  artNoReduceArchiveTargetColor?: boolean;
  /** 指定サポートをアーカイブするかわりにバックの指定名へ付け替える */
  archiveRedirect?: {
    supportNames: string[];
    targetNames: string[];
    oppTurnOnly?: boolean;
  };
  /** 自分のステージの指定タグ持ち全員のアーツを使える */
  borrowArtsTag?: string;
  /** アーカイブにある時のみ使えるBloom能力 */
  archiveBloom?: { minArchiveHolomen: number };
  /** バックへの特殊ダメージ前に重なりをアーカイブしてターン中無効化 */
  backSpecialShield?: { oppTurnOnly?: boolean };
  /** すべてのセクションを解析できたか */
  full: boolean;
}

// ============================================================
// 推しスキルの特殊タイミング (リアクティブ) 解析
// ============================================================

/** 「〜時に使える」推しスキルの定義 */
export type OshiReactive =
  | {
      when: "damagedByOpp";
      oppTurnOnly?: boolean;
      /** ダメージを受ける自分のホロメンの条件 */
      filter?: TargetFilter;
      /** 軽減量 (reduce形) */
      reduce?: number;
      /** 同じ事象で同時にダメージを受ける全員を軽減する条件 */
      reduceAll?: TargetFilter;
      /** ダメージ適用前に実行する効果 (ops形。被弾ホロメンは ctx.sourceStackId で参照) */
      ops?: Op[];
      /** 身代わり: この条件のホロメンを選び、そのホロメンがかわりにダメージを受ける (redirect形) */
      redirect?: TargetFilter;
    }
  | {
      when: "downedOwn";
      oppTurnOnly?: boolean;
      /** ダウンした自分のホロメンの条件 */
      filter?: TargetFilter;
      ops: Op[];
    }
  | {
      when: "downedOpp";
      oppTurnOnly?: boolean;
      /** ダウンさせた自分のホロメンの条件 */
      filter?: TargetFilter;
      /** ダウンした相手ホロメンのポジション限定 (「相手のセンターホロメンをダウンさせた時」) */
      downedPos?: "center" | "collab";
      /** 追加の前提条件 (「自分のデッキの枚数がX枚以下で、」等) */
      extraCond?: Cond;
      ops: Op[];
    }
  | {
      /** 自分の(F)が相手のバックホロメンにダメージを与えた時 (被弾バックを bound で参照) */
      when: "dealtDamageToOppBack";
      /** ダメージを与えた自分のホロメンの条件 */
      filter?: TargetFilter;
      /** 「この推しホロメンか〜」: 推しスキル起点のダメージでも発火する */
      includeOshi?: boolean;
      ops: Op[];
    }
  | {
      /** 自分の(F)が相手のセンターホロメンかコラボホロメンにダメージを与えた時 */
      when: "dealtDamageToOppFront";
      filter?: TargetFilter;
      ops: Op[];
    }
  | {
      /** 相手のホロメンに特殊ダメージを与えた時 */
      when: "dealtSpecial";
      /** 同時に特殊ダメージを与えた相手の人数。旧保存形式では1人。 */
      targetCount?: number;
      ops: Op[];
    }
  | {
      /** 自分の(F)の能力でエールをアーカイブした時 (アーカイブしたエールは ctx.milled で参照) */
      when: "yellArchivedByAbility";
      filter?: TargetFilter;
      ops: Op[];
    }
  | {
      /** 自分の(条件)センターホロメンがアーツを使った時 */
      when: "artUsedByCenter";
      filter?: TargetFilter;
      ops: Op[];
    }
  | {
      /** 自分の(F)の能力でサイコロを振る時 (振る前。目の宣言) */
      when: "diceRolling";
      filter?: TargetFilter;
      ops: Op[];
    }
  | {
      /** 自分の(F)の能力でサイコロを振った時 (出目確認後。振り直し) */
      when: "diceRolled";
      filter?: TargetFilter;
      ops: Op[];
    }
  | { when: "handArchiveByRedAbility" }
  | { when: "selfEndStepStart"; extraCond: Cond; ops: Op[] }
  | { when: "selfPerfStepEnd"; ops: Op[] };

/** 条件付きで使える推しスキル (「(条件)の時に使える：効果」) */
export interface OshiConditional {
  cond: Cond;
  ops: Op[];
}

// ============================================================
// 使用条件
// ============================================================

export type PlayCondition =
  | { c: "handAtMost"; n: number }
  | { c: "handAtLeast"; n: number }
  | { c: "oshiIs"; names: string[] }
  | { c: "archiveYellCost"; n: number }
  | { c: "holoPowerCost"; n: number }
  /** 「自分の手札N枚か自分のステージの〈X〉M枚をアーカイブ」のOR形コスト */
  | { c: "archiveHandOrStageNamed"; n: number; names: string[]; stageN: number }
  | { c: "stageAll"; filter: TargetFilter }
  | { c: "lifeAtMost"; n: number }
  | { c: "cond"; cond: Cond; text: string } // 汎用の実行時条件 (parseCondで解析)
  | { c: "unsupported"; text: string };

/**
 * カード自身に書かれた使用回数制限。
 * LIMITED (種別を問わずターンに1枚) とは別枠で、対象カードは LIMITED を持たない。
 *
 * - 「自分の〈X〉はターンにN回しか使えない」        → 同名カードでN回
 * - 「自分の#Tを持つイベントはターンにN回しか使えない」→ 同タグ・同種別でN回
 */
export interface SupportUseLimit {
  /** 同名で数える場合のカード名 */
  name?: string;
  /** タグ+種別で数える場合 */
  tag?: string;
  supportType?: string;
  /** 1ターンに使える回数 */
  n: number;
}
