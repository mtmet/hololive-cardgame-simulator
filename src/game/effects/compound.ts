// カード本文の解析：compound。
import type { Color } from "../../data/types";
import { parseCond, parseDiceCond } from "./conditions";
import {
  parsePositionHeader,
  parseCardFilter,
  parseStackTarget,
  parseCheerTargetLoose,
} from "./filters";
import {
  normalizeText,
  ANY_COUNT,
  parseNames,
  COLOR_RE,
  num,
} from "./normalization";
import {
  applyNoLifeRider,
  applyCountCapRider,
  findLastEffectBloom,
} from "./operations";
import { NO_LIFE_RIDER, COUNT_CAP_RIDER, parseSentence } from "./sentences";
import type { EffectProgram, Op } from "./types";

/**
 * 効果テキストを解析する。
 * 本体 (parseEffectBody) は多数の早期returnを持つので、位置ヘッダの付与は
 * ここでまとめて行う。各returnへ個別に足すと付け忘れが起きるため。
 */
export function parseEffect(text: string): EffectProgram | null {
  const program = parseEffectBody(text);
  if (!program) return null;
  const positions = parsePositionHeader(text);
  return positions ? { ...program, positions } : program;
}

function parseEffectBody(text: string): EffectProgram | null {
  if (!text.trim()) return { ops: [], text };
  // 回数制限・ポジション限定ヘッダのみ除去 ([AかB]の選択肢括弧は残す)
  let t = normalizeText(text)
    .replace(
      /\[(ターンに\d+回|ゲームに\d+回|[^\]]*ポジション限定[^\]]*)\]/g,
      "",
    )
    .trim();

  const ops: Op[] = [];

  // 複数文にまたがる選択・条件・参照先を、他の効果と同じ解析経路で保持する。
  const compoundText = t
    .replace(/LIMITED[:：]ターンに1枚しか使えない。?/g, "")
    .replace(/：/g, ":")
    .replace(/～/g, "〜")
    .trim();
  const matchesCompoundText = (s: string) => {
    const actual = compoundText.replace(/\s/g, "");
    const expected = s.replace(/\s/g, "");
    return actual === expected || actual === expected + "。";
  };
  if (
    matchesCompoundText(
      "自分が後攻で最初のターンなら、次の相手のターンの間、自分の〈大空スバル〉全員が1stホロメンから受けるアーツダメージ-100",
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "secondPlayerFirstTurn" },
          then: [
            {
              t: "turnArtReduceFrom",
              names: ["大空スバル"],
              level: "1st",
              value: 100,
            },
          ],
        },
      ],
    };
  if (
    matchesCompoundText(
      "相手のステージのホロメン1人を選ぶ。自分のホロパワーが10枚以上なら、このターンの間、選んだホロメンは2ndホロメンとしても扱う",
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "opp" },
        {
          t: "if",
          cond: { c: "holoPowerAtLeast", n: 10 },
          then: [{ t: "turnBloomLevel", level: "2nd" }],
        },
      ],
    };
  if (
    matchesCompoundText(
      "自分のステージの〈AZKi〉1人を選ぶ。自分のエールデッキから、選んだホロメンと同色のエール1枚を選んだホロメンに送る。そしてエールデッキをシャッフルする",
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "own", filter: { names: ["AZKi"] } },
        {
          t: "searchCheer",
          filter: { kind: "yell", sameColorAsBound: true },
          n: 1,
          targetFilter: { boundOnly: true },
        },
        { t: "shuffleCheer" },
      ],
    };
  if (
    matchesCompoundText(
      "自分の推しホロメンが〈大空スバル〉なら、相手のバックホロメン1人を選ぶ。選んだホロメンと相手のコラボホロメンを交代させる。相手のコラボホロメンがいないなら、かわりに、選んだホロメンをコラボポジションに移動させる",
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "oshiIs", names: ["大空スバル"] },
          then: [
            { t: "chooseBind", scope: "opp", filter: { position: "back" } },
            { t: "swapOppCollabWithBound" },
          ],
        },
      ],
    };
  if (
    matchesCompoundText(
      "自分のステージの〈風真いろは〉1人を選ぶ。このターンの間、自分のホロパワー1枚につき、選んだホロメンのアーツ+10",
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "own", filter: { names: ["風真いろは"] } },
        {
          t: "turnArtPlusPerCount",
          per: "milled",
          holoPowerCount: true,
          target: "bound",
          value: 10,
        },
      ],
    };
  if (
    matchesCompoundText(
      "自分のホロパワー1〜3枚をアーカイブできる:アーカイブしたホロパワー1枚につき、このターンの間、自分のステージの#歌を持つホロメン全員のアーツ+30",
    )
  )
    return {
      text,
      ops: [
        {
          t: "optionalCost",
          label: "ホロパワー1〜3枚をアーカイブ",
          cost: [{ t: "archiveHoloPowerAny", min: 1, max: 3 }],
          then: [
            {
              t: "turnArtPlusPerCount",
              per: "milled",
              target: "allOwn",
              filter: { tag: "歌" },
              value: 30,
            },
          ],
        },
      ],
    };
  if (
    matchesCompoundText(
      "自分の推しホロメンが黄の〈夏色まつり〉で、自分のステージのホロメン全員が〈夏色まつり〉なら、自分のホロパワーの上から1枚をアーカイブできる:このターンの間、自分が使えるLIMITEDのサポートの枚数は2枚になる",
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: {
            c: "and",
            inner: [
              { c: "oshiIs", names: ["夏色まつり"] },
              { c: "oshiColorIs", color: "黄" },
              { c: "stageAll", filter: { names: ["夏色まつり"] } },
            ],
          },
          then: [
            {
              t: "optionalCost",
              label: "ホロパワーの上から1枚をアーカイブ",
              cost: [{ t: "archiveHoloPower", n: 1 }],
              then: [{ t: "limitedLimit", n: 2 }],
            },
          ],
        },
      ],
    };
  if (
    matchesCompoundText(
      "相手のステージのホロメン1人を選ぶ。自分のデッキから、選んだホロメンと同じBloomレベルの〈大空スバル〉1枚をステージに出す。そしてデッキをシャッフルする",
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "opp" },
        {
          t: "searchDeck",
          filter: {
            kind: "holomen",
            names: ["大空スバル"],
            sameBloomAsBound: true,
          },
          nMax: 1,
          dest: "stage",
        },
        { t: "shuffleDeck" },
      ],
    };
  if (
    matchesCompoundText(
      "自分のセンターの〈轟はじめ〉を選ぶ。このターンの間、この能力でアーカイブしたホロパワー1枚につき、選んだホロメンのアーツ+10。さらに、7枚以上なら、このターンの間、自分のステージの〈轟はじめ〉全員のアーツ+100",
    )
  )
    return {
      text,
      ops: [
        {
          t: "chooseBind",
          scope: "ownCenter",
          filter: { names: ["轟はじめ"] },
        },
        { t: "turnArtPlusPerCount", per: "milled", target: "bound", value: 10 },
        {
          t: "if",
          cond: { c: "milledAtLeast", n: 7 },
          then: [
            {
              t: "turnArtPlus",
              target: "allOwn",
              filter: { names: ["轟はじめ"] },
              value: 100,
            },
          ],
        },
      ],
    };
  if (
    matchesCompoundText(
      "自分のステージの#カエラ'sアームズを持つツール2枚をアーカイブする。この能力で2枚アーカイブしたなら、相手のDebut以外の[センターホロメンかコラボホロメン]に、特殊ダメージ100を与える",
    )
  )
    return {
      text,
      ops: [
        {
          t: "archiveStageSupports",
          partial: true,
          names: [],
          filter: { kind: "ツール", tag: "カエラ'sアームズ" },
          n: 2,
        },
        {
          t: "if",
          cond: { c: "milledAtLeast", n: 2 },
          then: [
            {
              t: "special",
              target: "chooseOppFront",
              filter: { excludeBloomLevel: "Debut" },
              dmg: 100,
            },
          ],
        },
      ],
    };
  if (
    matchesCompoundText(
      "自分のセンターホロメンが2nd〈綺々羅々ヴィヴィ〉なら、お互いの[手札すべてとアーカイブのホロメンとサポートすべて]をデッキに戻してシャッフルする。そしてそれぞれのデッキを7枚引く",
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: {
            c: "and",
            inner: [
              { c: "centerIs", names: ["綺々羅々ヴィヴィ"] },
              { c: "centerBloomLevelIs", level: "2nd" },
            ],
          },
          then: [{ t: "bothRefreshArchive", draw: 7 }],
        },
      ],
    };
  if (
    matchesCompoundText(
      "相手のバックホロメン1人を選ぶ。選んだホロメンをお休みさせる。そのホロメンは、次の相手のリセットステップでアクティブにならない",
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "opp", filter: { position: "back" } },
        { t: "rest", target: "bound" },
        { t: "noActivateNextReset" },
      ],
    };
  if (
    matchesCompoundText(
      "自分のステージの#ReGLOSSを持つホロメン1人を選ぶ。このターンの間、選んだホロメンのバトンタッチに必要な無色-1。その後、自分のアーカイブのエール1枚を自分のバックの〈轟はじめ〉に送る",
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "own", filter: { tag: "ReGLOSS" } },
        { t: "turnCostMod", target: "bound", batonDelta: -1 },
        {
          t: "cheerFromArchive",
          n: 1,
          target: "chooseOwnBack",
          filter: { names: ["轟はじめ"] },
        },
      ],
    };
  if (
    matchesCompoundText(
      "自分のデッキを2枚引く。その後、自分のステージのエール1枚をエールデッキの下に戻し、自分のエールデッキから、エール1枚を自分のホロメンに送る。そしてエールデッキをシャッフルする",
    )
  )
    return {
      text,
      ops: [
        { t: "draw", n: 2 },
        { t: "stageYellToCheerBottom", n: 1 },
        { t: "searchCheer", filter: { kind: "yell" }, n: 1 },
        { t: "shuffleCheer" },
      ],
    };
  if (
    matchesCompoundText(
      "相手のセンターホロメンに特殊ダメージ20を与える。その後、このターンの間、自分の〈常闇トワ〉の3回目のアーツは、相手のDebut以外のバックホロメンも対象にできる",
    )
  )
    return {
      text,
      ops: [
        { t: "special", target: "oppCenter", dmg: 20 },
        { t: "turnThirdArtBackTarget", names: ["常闇トワ"] },
      ],
    };
  if (
    matchesCompoundText(
      "自分のデッキの上から2枚をホロパワーにする。その後、自分のホロパワーを見る。その中から1〜2枚を手札に加える。そしてホロパワーをシャッフルする",
    )
  )
    return {
      text,
      ops: [
        { t: "holoPowerFromDeck", n: 2 },
        {
          t: "lookTop",
          source: "holo",
          n: 99,
          pickFilter: { any: true },
          pickMin: 1,
          pickMax: 2,
          pickDest: "hand",
          rest: "shuffle",
        },
      ],
    };
  if (
    matchesCompoundText(
      "自分のアーカイブの[〈白銀ノエル〉と〈牛丼〉]1枚ずつを手札に戻す",
    )
  )
    return {
      text,
      ops: [
        {
          t: "moveArchive",
          filter: { names: ["白銀ノエル"] },
          min: 1,
          max: 1,
          dest: "hand",
        },
        {
          t: "moveArchive",
          filter: { names: ["牛丼"] },
          min: 1,
          max: 1,
          dest: "hand",
        },
      ],
    };
  if (
    matchesCompoundText(
      "このターンの間、自分のステージの残りHPが最も高いホロメン全員のアーツ+30",
    )
  )
    return { text, ops: [{ t: "highestHpArtPlus", value: 30 }] };
  if (
    matchesCompoundText(
      "相手のセンターホロメンかコラボホロメンを選ぶ。選んだホロメンに特殊ダメージ10を与える。自分のアーカイブに〈君に乾杯〉が2枚以上あるなら、かわりに、選んだホロメンに特殊ダメージ40を与える。 自分の〈君に乾杯〉はターンに1回しか使えない",
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "oppFront" },
        {
          t: "ifElse",
          cond: { c: "archiveHas", filter: { names: ["君に乾杯"] }, n: 2 },
          then: [{ t: "special", target: "bound", dmg: 40 }],
          else: [{ t: "special", target: "bound", dmg: 10 }],
        },
      ],
    };

  // hBP07-083: 「さらに」の追加加算も、前文と同じ次の相手ターンまで続く。
  // 単文ごとに解析すると、期限を省略した+60だけがこのターン限りになる。
  if (
    /^次の相手のターン終了時まで、お互いのステージのホロメン全員のアーツ\+40。さらに、自分のステージの2ndホロメンの〈桃鈴ねね〉全員のアーツ\+60。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "turnArtPlus",
          target: "allBoth",
          value: 40,
          untilNextOppTurn: true,
        },
        {
          t: "turnArtPlus",
          target: "allOwn",
          filter: { bloomLevel: "2nd", names: ["桃鈴ねね"] },
          value: 60,
          untilNextOppTurn: true,
        },
      ],
    };

  // 複数文にまたがる条件・選択を、意味単位でコンパイルする。
  if (
    /^自分が後攻で最初のターンなら、自分のデッキから、エクストラを持つDebut〈ときのそら〉1〜3枚をステージに出す。そしてデッキをシャッフルする。3枚出したなら、自分の手札1枚をデッキの下に戻す。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "secondPlayerFirstTurn" },
          then: [
            {
              t: "searchDeck",
              filter: {
                kind: "holomen",
                bloomLevel: "Debut",
                names: ["ときのそら"],
                unlimitedOnly: true,
              },
              nMax: 3,
              dest: "stage",
            },
            { t: "shuffleDeck" },
            {
              t: "if",
              cond: { c: "pickedAtLeast", n: 3 },
              then: [{ t: "handToDeckBottom", n: 1 }],
            },
          ],
        },
      ],
    };
  if (/^このアーツの対象が1st以上のホロメンなら、このアーツ\+30。?$/.test(t))
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "artTargetIs", filter: { minBloom: "1st" } },
          then: [{ t: "artPlus", value: 30 }],
        },
      ],
    };
  if (/^自分のデッキを1枚引き、手札1枚をデッキの下に戻す。?$/.test(t))
    return {
      text,
      ops: [
        { t: "draw", n: 1 },
        { t: "handToDeckBottom", n: 1 },
      ],
    };
  if (
    /^自分のデッキから、2nd〈ときのそら〉1枚を公開し、手札に加える。そしてデッキをシャッフルする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "searchDeck",
          filter: { kind: "holomen", bloomLevel: "2nd", names: ["ときのそら"] },
          nMax: 1,
          dest: "hand",
        },
        { t: "shuffleDeck" },
      ],
    };
  if (
    /^サイコロを1回振れる。奇数なら、相手のバックホロメン1人を選ぶ。相手のセンターホロメンと選んだホロメンを交代させる。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "dice",
          optional: true,
          branches: [{ cond: "odd", ops: [{ t: "swapCenter", side: "opp" }] }],
        },
      ],
    };
  if (
    /^自分のバックのアクティブな2nd〈ときのそら〉1人をお休みさせることができる：このホロメンはアーツを使った後、同じアーツをもう1回使う。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "optionalCost",
          label: "バックのアクティブな2nd〈ときのそら〉をお休みさせますか？",
          cost: [
            {
              t: "rest",
              target: "chooseOwnBack",
              count: 1,
              filter: {
                names: ["ときのそら"],
                bloomLevel: "2nd",
                resting: false,
              },
            },
          ],
          then: [{ t: "repeatArtGrant", target: "self" }],
        },
      ],
    };
  if (
    /^自分が後攻で最初のターンなら、自分のデッキから、ブルームエフェクトを持つ〈宝鐘マリン〉1枚を公開し、手札に加える。そしてデッキをシャッフルする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "secondPlayerFirstTurn" },
          then: [
            {
              t: "searchDeck",
              filter: {
                kind: "holomen",
                names: ["宝鐘マリン"],
                hasBloomEffect: true,
              },
              nMax: 1,
              dest: "hand",
            },
            { t: "shuffleDeck" },
          ],
        },
      ],
    };
  if (
    /^このホロメンに重なっているホロメンが2枚以上あるなら、自分のステージのエール1枚をアーカイブできる：自分のエールデッキの上から1枚を自分のホロメンに送る。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "stackedEq", n: 2, atLeast: true },
          then: [
            {
              t: "optionalCost",
              label: "ステージのエール1枚をアーカイブして効果を使いますか？",
              cost: [{ t: "archiveStageYell", n: 1 }],
              then: [{ t: "cheerFromTop", n: 1, target: "chooseOwn" }],
            },
          ],
        },
      ],
    };
  if (
    /^このホロメンに重なっているホロメンが3枚以上あるなら、このアーツ\+50。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "stackedEq", n: 3, atLeast: true },
          then: [{ t: "artPlus", value: 50 }],
        },
      ],
    };
  if (
    /^自分の推しホロメンが〈宝鐘マリン〉なら、このホロメンに重なっているホロメンすべてをアーカイブできる：1枚以上アーカイブしたなら、このアーツ\+100。5枚以上アーカイブしたなら、さらに、相手のDebut以外のバックホロメン1人に特殊ダメージ100を与える。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "oshiIs", names: ["宝鐘マリン"] },
          then: [
            {
              t: "optionalCost",
              label: "重なっているホロメンすべてをアーカイブしますか？",
              cost: [{ t: "archiveStacked", n: 1, all: true }],
              then: [
                {
                  t: "if",
                  cond: { c: "milledAtLeast", n: 1 },
                  then: [{ t: "artPlus", value: 100 }],
                },
                {
                  t: "if",
                  cond: { c: "milledAtLeast", n: 5 },
                  then: [
                    {
                      t: "special",
                      dmg: 100,
                      target: "chooseOppBack",
                      filter: { excludeBloomLevel: "Debut" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  if (
    /^自分のデッキの上から、自分のステージのエールと同じ枚数を公開する。公開したホロメン1枚につき、このアーツ\+10。そして公開したカードをデッキに戻してシャッフルする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "revealTop", n: 0, nFrom: "stageYell" },
        { t: "artPlusPer", value: 10, per: "revealedHolomen" },
        { t: "revealedTo", dest: "deckTop" },
        { t: "shuffleDeck" },
      ],
    };
  if (
    /^自分のステージの〈こよりの助手くん〉1枚につき、自分のホロメン1人のHP20回復。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "heal",
          value: 20,
          target: "chooseOwn",
          scaleBy: "stageNamedCards",
          scaleNames: ["こよりの助手くん"],
        },
      ],
    };
  if (
    /^自分のアーカイブの〈博衣こより〉1〜4枚を好きな順でデッキの下に戻せる。4枚戻したなら、自分のアーカイブの#こよラボを持つサポートカード1枚を自分の〈博衣こより〉に付けられる。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "moveArchive",
          filter: { kind: "holomen", names: ["博衣こより"] },
          min: 1,
          max: 4,
          dest: "deckBottom",
          optional: true,
          orderMatters: true,
        },
        {
          t: "if",
          cond: { c: "pickedAtLeast", n: 4 },
          then: [
            {
              t: "moveArchive",
              filter: { kind: "サポート", tag: "こよラボ" },
              min: 1,
              max: 1,
              dest: "attach",
              attachTargetNames: ["博衣こより"],
              optional: true,
            },
          ],
        },
      ],
    };
  if (
    /^自分のデッキの上から、自分のステージのエールと同じ枚数を公開する。公開したホロメン1枚につき、このアーツ\+20し、自分のホロメン1人のHP20回復。そして公開したカードをデッキに戻してシャッフルする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "revealTop", n: 0, nFrom: "stageYell" },
        { t: "artPlusPer", value: 20, per: "revealedHolomen" },
        {
          t: "heal",
          value: 20,
          target: "chooseOwn",
          scaleBy: "revealedHolomen",
        },
        { t: "revealedTo", dest: "deckTop" },
        { t: "shuffleDeck" },
      ],
    };

  // 推しスキル
  if (
    /^自分のステージの〈ときのそら〉1人を選ぶ。選んだホロメンを、自分のデッキの〈ときのそら〉を使ってBloomさせる。そしてデッキをシャッフルする。このターンの間、選んだホロメンのアーツに必要な無色-1。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "chooseBind",
          scope: "own",
          filter: { names: ["ときのそら"] },
        },
        {
          t: "effectBloom",
          targetBound: true,
          source: "deck",
          cardFilter: { kind: "holomen", names: ["ときのそら"] },
        },
        { t: "shuffleDeck" },
        { t: "turnCostMod", target: "bound", artCostless: 1 },
      ],
    };
  if (
    /^相手のDebut以外のバックホロメン1人に特殊ダメージ50を与える。その後、自分のセンターホロメンに重なっているホロメンが3枚以上あるなら、相手のDebut以外のバックホロメン1人に特殊ダメージ50を与える。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "special",
          dmg: 50,
          target: "chooseOppBack",
          filter: { excludeBloomLevel: "Debut" },
        },
        {
          t: "if",
          cond: { c: "centerStackedAtLeast", n: 3 },
          then: [
            {
              t: "special",
              dmg: 50,
              target: "chooseOppBack",
              filter: { excludeBloomLevel: "Debut" },
            },
          ],
        },
      ],
    };
  if (
    /^自分のデッキの上から、自分のステージのエールと同じ枚数を公開する。その中にホロメンが3枚以上あるなら、このターンの間、自分のステージの〈博衣こより〉全員のアーツ\+30。そして公開したDebut以外のホロメンすべてを手札に加え、残ったカードをアーカイブする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "lookTop",
          source: "deck",
          n: 0,
          nFrom: "stageYell",
          pickFilter: { kind: "holomen", excludeBloomLevel: "Debut" },
          pickMax: ANY_COUNT,
          pickAllMatching: true,
          pickDest: "hand",
          revealPick: true,
          revealAll: true,
          rest: "archive",
        },
        {
          t: "if",
          cond: {
            c: "revealedCountAtLeast",
            filter: { kind: "holomen" },
            n: 3,
          },
          then: [
            {
              t: "turnArtPlus",
              value: 30,
              target: "allOwn",
              filter: { names: ["博衣こより"] },
            },
          ],
        },
      ],
    };

  // サポート
  if (
    /^自分のライフが2以上なら、自分のデッキから、#サマーを持つDebutホロメン1枚をステージに出す。そしてデッキをシャッフルする。自分のライフが1なら、自分のデッキから、#サマーを持つホロメン1枚を公開し、手札に加える。そしてデッキをシャッフルする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "lifeAtLeast", n: 2 },
          then: [
            {
              t: "searchDeck",
              filter: { kind: "holomen", bloomLevel: "Debut", tag: "サマー" },
              nMax: 1,
              dest: "stage",
            },
            { t: "shuffleDeck" },
          ],
        },
        {
          t: "if",
          cond: { c: "lifeEq", n: 1 },
          then: [
            {
              t: "searchDeck",
              filter: { kind: "holomen", tag: "サマー" },
              nMax: 1,
              dest: "hand",
            },
            { t: "shuffleDeck" },
          ],
        },
      ],
    };
  if (
    /^自分のデッキを2枚引く。その後、自分の手札の〈宝鐘マリン〉1枚を公開し、デッキの下に戻せる。戻したなら、自分のデッキを2枚引く。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "draw", n: 2 },
        {
          t: "optionalCost",
          label: "手札の〈宝鐘マリン〉1枚を公開してデッキの下に戻しますか？",
          cost: [
            {
              t: "handRevealToDeckBottom",
              n: 1,
              filter: { names: ["宝鐘マリン"] },
            },
          ],
          then: [{ t: "draw", n: 2 }],
        },
      ],
    };
  if (
    /^自分のステージの2ndホロメン1人を選ぶ。このターンの間、選んだホロメンのアーツ\+30し、そのホロメンがアーツダメージでホロメンをダウンさせた時、自分のデッキを2枚引く。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "own", filter: { bloomLevel: "2nd" } },
        { t: "turnArtPlus", value: 30, target: "bound" },
        {
          t: "downReward",
          boundSubject: true,
          anyHolomen: true,
          artDamageOnly: true,
          draw: 2,
        },
      ],
    };
  if (/^自分のデッキを3枚引き、手札1枚をデッキの下に戻す。?$/.test(t))
    return {
      text,
      ops: [
        { t: "draw", n: 3 },
        { t: "handToDeckBottom", n: 1 },
      ],
    };

  // Q205: 通常版の括弧注記と再録版の対象変更文は、どちらもコスト解決後に適用する。
  if (
    /^このホロメンの青エール2枚をアーカイブできる：このホロメンに重なっているホロメン1枚につき、このアーツ\+60(?:。その後、このアーツの対象を相手のバックホロメン1人に変更できる|（このアーツは相手のバックホロメンも対象にできる）)。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "optionalCost",
          label: "このホロメンの青エール2枚をアーカイブしますか？",
          cost: [{ t: "archiveSelfYell", color: "青", n: 2 }],
          then: [
            { t: "artPlusPer", value: 60, per: "stacked" },
            { t: "changeArtTargetToOppBack", optional: true },
          ],
        },
      ],
    };

  // 修正版データで追加・訂正された推しスキルの複合効果
  if (
    /^自分のステージのホロメン1人を選ぶ。このターンの間、選んだホロメンのアーツ\+20。選んだホロメンに紫エールが付いているなら、かわりに、そのホロメンのアーツ\+50。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "own" },
        { t: "turnArtPlus", value: 20, target: "bound" },
        { t: "boundArtPlusReplace", yellColor: "紫", value: 50 },
      ],
    };
  if (
    /^自分の〈IRyS〉全員のエール1枚につき、自分のデッキを1枚引く。その後、自分の〈IRyS〉全員の紫エール1枚につき、自分のデッキの上から1枚をホロパワーにする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "drawPerStageNamesYell", names: ["IRyS"], n: 1 },
        { t: "holoPowerPerStageNamesYell", names: ["IRyS"], color: "紫", n: 1 },
      ],
    };
  if (
    /^自分のエールデッキの上から2枚を自分のお休みしている〈セシリア・イマーグリーン〉に割り振って送る。その後、この能力でエールを送られたホロメン全員をアクティブにする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "cheerFromTop",
          n: 2,
          target: "chooseOwn",
          filter: { names: ["セシリア・イマーグリーン"], resting: true },
        },
        { t: "activateCheerRecipients" },
      ],
    };
  if (
    /^自分のステージに赤エールがあるなら、自分のアーカイブの#Adventを持つホロメン1枚を手札に戻す。青エールがあるなら、自分のアーカイブのエール1枚を自分の#Adventを持つホロメンに送る。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "if",
          cond: { c: "stageHasColorYell", color: "赤" },
          then: [
            {
              t: "moveArchive",
              filter: { kind: "holomen", tag: "Advent" },
              min: 1,
              max: 1,
              dest: "hand",
            },
          ],
        },
        {
          t: "if",
          cond: { c: "stageHasColorYell", color: "青" },
          then: [
            {
              t: "cheerFromArchive",
              n: 1,
              target: "chooseOwn",
              filter: { tag: "Advent" },
            },
          ],
        },
      ],
    };
  if (
    /^相手のセンターホロメンを選ぶ。次の相手のターンが終了するまで、選んだホロメンのバトンタッチに必要な無色\+3。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "opp", filter: { position: "center" } },
        {
          t: "turnCostMod",
          target: "bound",
          batonDelta: 3,
          untilNextOppTurn: true,
        },
      ],
    };
  if (
    /^相手のバックホロメン1人に、相手のセンターホロメンが受けているダメージと同じ数値の特殊ダメージを与える。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "special",
          dmg: 0,
          dmgFrom: "oppCenterDamage",
          target: "chooseOppBack",
        },
      ],
    };
  if (
    /^自分の手札2枚をアーカイブする。この能力で2枚アーカイブしたなら、相手のDebut以外の\[センターホロメンとコラボホロメン\]に特殊ダメージ50を与える。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "archiveHand", n: 2 },
        {
          t: "if",
          cond: { c: "milledAtLeast", n: 2 },
          then: [
            {
              t: "special",
              dmg: 50,
              target: "allOppFront",
              filter: { excludeBloomLevel: "Debut" },
            },
          ],
        },
      ],
    };
  if (
    /^この能力でアーカイブしたホロパワー1枚につき、相手のステージのホロメン1人を選ぶ。このターンの間、選んだホロメンは、すべての色を持つホロメンとして扱う。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        { t: "chooseBind", scope: "opp", countFrom: "picked" },
        { t: "turnAllColors", target: "bound" },
      ],
    };
  if (
    /^自分のエールデッキの上から3枚を自分のセンターホロメンの〈音乃瀬奏〉に送る。このターンが終了する時、自分のステージのエール3枚をアーカイブする。?$/.test(
      t,
    )
  )
    return {
      text,
      ops: [
        {
          t: "cheerFromTop",
          n: 3,
          target: "ownCenter",
          filter: { names: ["音乃瀬奏"] },
        },
        { t: "scheduleEndArchiveStageYell", n: 3 },
      ],
    };

  // ◆推し条件、能力変更可能 [ゲームに1回]A:
  // 条件を満たし未使用なら、通常能力と代替能力を解決時に選ぶ。
  {
    const changed = t.match(
      /^(.*?)\s*◆自分の推しホロメンが((?:〈[^〉]+〉)+)の時、能力変更可能\s*(.+)$/s,
    );
    if (changed) {
      const normal = parseEffect(changed[1].trim());
      const alternate = parseEffect(changed[3].trim());
      const names = parseNames(changed[2]);
      if (!normal || !alternate || alternate.ops.length === 0) return null;
      const key = `abilityChange:${names.join("/")}:${changed[3].trim()}`;
      return {
        text,
        ops: [
          {
            t: "ifElse",
            cond: {
              c: "and",
              inner: [
                { c: "oshiIs", names },
                { c: "oncePerGameUnused", key },
              ],
            },
            then: [
              {
                t: "chooseOps",
                label:
                  "「能力変更可能」のゲームに1回の代替能力を使いますか？（いいえ: 通常能力）",
                thenOps: [{ t: "markOncePerGameUsed", key }, ...alternate.ops],
                elseOps: normal.ops,
              },
            ],
            else: normal.ops,
          },
        ],
      };
    }
  }

  // 「（このアーツは相手のバックホロメンも対象にできる）」の括弧注記は useArts 側で検証する
  t = t.replace(/（このアーツは、?相手のバックホロメンも対象にできる）/g, "");

  // 「どちらか1色しか付いていないなら」を直前の「(A)エールと(B)エール」の色で展開する
  {
    const pair = t.match(
      new RegExp(
        `このホロメンに${COLOR_RE}エールと${COLOR_RE}エールが付いているなら`,
      ),
    );
    if (pair && t.includes("どちらか1色しか付いていないなら"))
      t = t.replace(
        "どちらか1色しか付いていないなら",
        `このホロメンに${pair[1]}エールと${pair[2]}エールのどちらか1色しか付いていないなら`,
      );
  }

  // 「DebutからBloomした時、」/「BuzzホロメンからBloomした時、」プレフィックス (ブルームエフェクト)
  let bloomFromDebut = false;
  let bloomFromBuzz = false;
  const bfd = t.match(/^DebutからBloomした時、(.+)$/s);
  if (bfd) {
    bloomFromDebut = true;
    t = bfd[1];
  }
  const bfb = t.match(/^BuzzホロメンからBloomした時、(.+)$/s);
  if (bfb) {
    bloomFromBuzz = true;
    t = bfb[1];
  }
  // 「自分のSP推しスキル「N」でBloomした時、」プレフィックス
  let bloomBySpSkillName: string | null = null;
  const bsp = t.match(/^自分のSP推しスキル「([^」]+)」でBloomした時、(.+)$/s);
  if (bsp) {
    bloomBySpSkillName = bsp[1];
    t = bsp[2];
  }

  // --- 「以下の能力から1つを選んで使う。■A ■B」のモーダル選択 (2択のみ対応) ---
  {
    const mm = t.match(/^以下の能力から1つを選んで使う。\s*■(.+)$/s);
    if (mm) {
      const parts = mm[1]
        .split("■")
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts.length !== 2) return null;
      const a = parseEffect(parts[0]);
      const b = parseEffect(parts[1]);
      if (!a || !b || a.ops.length === 0 || b.ops.length === 0) return null;
      const short = (x: string) => x.split("。")[0].slice(0, 40);
      return {
        ops: [
          {
            t: "chooseOps",
            label: `使う能力を選んでください — はい:「${short(parts[0])}」 / いいえ:「${short(parts[1])}」`,
            thenOps: a.ops,
            elseOps: b.ops,
          },
        ],
        text,
      };
    }
  }

  // --- 「そのアーツでサイコロを振って出た目の合計数が奇数なら、A。偶数なら、B。」(兎田ぺこら) ---
  {
    const dm = t.match(
      /^そのアーツでサイコロを振って出た目の合計数が奇数なら、(.+?)。偶数なら、(.+?)。?$/s,
    );
    if (dm) {
      const odd = parseEffect(dm[1]);
      const even = parseEffect(dm[2]);
      if (!odd || !even || odd.ops.length === 0 || even.ops.length === 0)
        return null;
      return {
        ops: [{ t: "artDiceParityBranch", oddOps: odd.ops, evenOps: even.ops }],
        text,
      };
    }
  }

  // 「デッキの上からX枚を見る/公開する」の逐次解析用の状態
  let pendingLook: Extract<Op, { t: "lookTop" }> | null = null;
  let pendingLookPicked = false;
  let pendingLookIsReveal = false; // 「公開する」由来 (revealTop に変換可能)
  let pendingLookContainer: Op[] = ops; // pendingLook を保持する配列 (条件付きの場合 if.then)
  // 「エールデッキの下に戻せる。戻したなら、〜」の2文パターン用
  let pendingYellReturn: number | null = null;
  // 「XかYを選ぶ。〜選んだ数として扱う」の2文パターン用
  let pendingNumChoice: [number, number] | null = null;

  const finalizeLook = (): boolean => {
    if (pendingLook && !pendingLookPicked) return false; // 選択の文がない
    pendingLook = null;
    pendingLookPicked = false;
    pendingLookIsReveal = false;
    return true;
  };

  for (const part of t.split("。")) {
    const s = part.trim().replace(/^その後、/, "");
    if (!s) continue;
    if (NO_LIFE_RIDER.test(s)) {
      applyNoLifeRider(ops);
      continue;
    }
    const countCap = s.match(COUNT_CAP_RIDER);
    if (countCap) {
      applyCountCapRider(ops, num(countCap[1]));
      continue;
    }

    // --- 「エールX枚を戻せる。戻したなら、〜」の2文パターン ---
    if (pendingYellReturn !== null) {
      const rm2 = s.match(/^戻したなら、(.+)$/);
      const then = rm2 ? parseSentence(rm2[1]) : null;
      if (!then) return null;
      ops.push({
        t: "optionalCost",
        cost: [{ t: "stageYellToCheerBottom", n: pendingYellReturn }],
        then,
        label: `ステージのエール${pendingYellReturn}枚をエールデッキの下に戻して効果を使いますか？`,
      });
      pendingYellReturn = null;
      continue;
    }
    {
      const ym = s.match(
        /^自分のステージのエール(\d+)枚をエールデッキの下に戻せる$/,
      );
      if (ym) {
        pendingYellReturn = num(ym[1]);
        continue;
      }
    }

    // --- 「XかYを選ぶ。(サイコロの目を)選んだ数として扱う」の2文パターン ---
    {
      const ncm = s.match(/^(\d+)か(\d+)を選ぶ$/);
      if (ncm) {
        pendingNumChoice = [num(ncm[1]), num(ncm[2])];
        continue;
      }
      if (pendingNumChoice) {
        const dm = s.match(
          /^このターンの間、自分の推しホロメンの((?:〈[^〉]+〉)+)と自分のステージの((?:〈[^〉]+〉)+)の能力でサイコロを振る時、そのサイコロの目の数すべてを選んだ数として扱う$/,
        );
        if (!dm) return null;
        const names = [
          ...new Set([...parseNames(dm[1]), ...parseNames(dm[2])]),
        ];
        const [a, b] = pendingNumChoice;
        ops.push({
          t: "chooseOps",
          label: `サイコロの目の宣言: 【${a}】として扱いますか？ (いいえ=【${b}】)`,
          thenOps: [{ t: "diceMod", value: a, names }],
          elseOps: [{ t: "diceMod", value: b, names }],
        });
        pendingNumChoice = null;
        continue;
      }
    }

    // --- 「上からX枚を見る/公開する」開始 (条件・動的枚数の前置き対応) ---
    const lm = s.match(
      /^(?:(.+?)なら、)?自分の(デッキ|エールデッキ)の上から、?(?:(\d+)枚|相手の手札と同じ枚数)を(見る|公開する)$/,
    );
    if (lm) {
      const lookCond = lm[1] ? parseCond(lm[1]) : null;
      if (lm[1] && !lookCond) return null;
      if (!finalizeLook()) return null;
      pendingLook = {
        t: "lookTop",
        source: lm[2] === "デッキ" ? "deck" : "cheer",
        n: lm[3] ? num(lm[3]) : 0,
        nFrom: lm[3] ? undefined : "oppHand",
        pickFilter: { any: true },
        pickMax: 0,
        pickDest: "hand",
        revealPick: lm[4] === "公開する",
        revealAll: lm[4] === "公開する",
        rest: "bottom",
      };
      pendingLookIsReveal = lm[4] === "公開する";
      if (lookCond) {
        const wrapper: Extract<Op, { t: "if" }> = {
          t: "if",
          cond: lookCond,
          then: [pendingLook],
        };
        ops.push(wrapper);
        pendingLookContainer = wrapper.then;
      } else {
        ops.push(pendingLook);
        pendingLookContainer = ops;
      }
      continue;
    }
    // --- ホロパワーを見る ---
    if (/^自分のホロパワーを見る$/.test(s)) {
      if (!finalizeLook()) return null;
      pendingLook = {
        t: "lookTop",
        source: "holo",
        n: 99,
        pickFilter: { any: true },
        pickMax: 0,
        pickDest: "hand",
        rest: "top",
      };
      ops.push(pendingLook);
      pendingLookContainer = ops;
      continue;
    }
    // 「そのカードをデッキの上か下に戻す」等の二択: revealTop+選択opに変換
    if (pendingLook && !pendingLookPicked && pendingLook.source === "deck") {
      const isTB = /^そのカードを、?デッキの上か下に戻す$/.test(s);
      const isAT =
        /^そのカードすべてを、?アーカイブするか、好きな順でデッキの上に戻す$/.test(
          s,
        );
      if (isTB || isAT) {
        pendingLookContainer[pendingLookContainer.indexOf(pendingLook)] = {
          t: "revealTop",
          n: pendingLook.n,
          ownerOnly: !pendingLookIsReveal || undefined,
        };
        pendingLookContainer.push({
          t: isTB ? "revealedTopOrBottom" : "revealedArchiveOrTop",
        });
        pendingLook = null;
        pendingLookIsReveal = false;
        continue;
      }
    }
    // 「公開する」の後続文が公開カードを参照する場合、lookTop ではなく revealTop として扱う
    if (
      pendingLook &&
      pendingLookIsReveal &&
      !pendingLookPicked &&
      pendingLook.source === "deck" &&
      /公開した(?:カード|ホロメン|サポートカード)|そのカード|その中に/.test(s)
    ) {
      pendingLookContainer[pendingLookContainer.indexOf(pendingLook)] = {
        t: "revealTop",
        n: pendingLook.n,
      };
      pendingLook = null;
      pendingLookIsReveal = false;
    }
    if (pendingLook) {
      // 選択の文 (角括弧内の各枠): [F1とF2]X枚ずつ
      {
        const gm = s.match(
          /^その中から、?\[(.+?)と(.+?)\](\d+)枚ずつを(?:公開し、)?(?:公開した[^、。]*?を)?手札に加える$/,
        );
        if (gm) {
          const f1 = parseCardFilter(gm[1]);
          const f2 = parseCardFilter(gm[2]);
          if (!f1 || !f2) return null;
          const max = num(gm[3]);
          pendingLook.pickGroups = [
            { filter: f1, max },
            { filter: f2, max },
          ];
          pendingLook.pickFilter = { alt: [f1, f2] };
          pendingLook.pickMax = max * 2;
          pendingLook.revealPick = pendingLookIsReveal || s.includes("公開");
          pendingLookPicked = true;
          continue;
        }
      }
      // 選択の文 (グループ): その中から、(F1)X枚と(F2)X枚を公開し、手札に加える
      {
        const gm = s.match(
          /^その中から、?(.+?)(\d+)枚と(.+?)(\d+)枚を(?:公開し、)?(?:公開した[^、。]*?を)?手札に加える$/,
        );
        if (gm) {
          const f1 = parseCardFilter(gm[1]);
          const f2 = parseCardFilter(gm[3]);
          if (!f1 || !f2) return null;
          pendingLook.pickGroups = [
            { filter: f1, max: num(gm[2]) },
            { filter: f2, max: num(gm[4]) },
          ];
          pendingLook.pickFilter = { alt: [f1, f2] };
          pendingLook.pickMax = num(gm[2]) + num(gm[4]);
          pendingLook.revealPick = pendingLookIsReveal || s.includes("公開");
          pendingLookPicked = true;
          continue;
        }
      }
      // 選択の文: その中から、(F)(N枚|好きな枚数)を(公開し、)手札に加える
      let pm = s.match(
        /^その中から、?(.+?)?(?:を)?(?:(\d+)(?:〜(\d+))?枚(?:ずつ)?|好きな枚数)を?(?:公開し、)?(?:公開した[^、。]*?を)?手札に加える$/,
      );
      if (pm) {
        const f = pm[1] ? parseCardFilter(pm[1]) : { any: true };
        if (!f) return null;
        pendingLook.pickFilter = f;
        pendingLook.pickMin = pm[2] ? num(pm[2]) : 0;
        pendingLook.pickMax = pm[2] ? num(pm[3] ?? pm[2]) : ANY_COUNT;
        pendingLook.revealPick = pendingLookIsReveal || s.includes("公開");
        pendingLookPicked = true;
        continue;
      }
      // 選択してアーカイブする
      pm = s.match(/^その中から、?(.+?)?(?:を)?(\d+)枚をアーカイブする$/);
      if (pm) {
        const f = pm[1] ? parseCardFilter(pm[1]) : { any: true };
        if (!f) return null;
        pendingLook.pickFilter = f;
        pendingLook.pickMin = num(pm[2]);
        pendingLook.pickMax = num(pm[2]);
        pendingLook.pickDest = "archive";
        pendingLook.revealPick = pendingLookIsReveal || s.includes("公開");
        pendingLookPicked = true;
        continue;
      }
      // 選択してエールとして送る (エールデッキの上から見る場合)
      pm = s.match(
        /^その中から、?(.+?)?(?:を)?(\d+)枚を?(?:公開し、)?(.+?)に送る$/,
      );
      if (pm && pendingLook.source === "cheer") {
        const f = pm[1] ? parseCardFilter(pm[1]) : { any: true };
        const tgt = pm[3]
          ? (parseStackTarget(pm[3]) ?? parseCheerTargetLoose(pm[3]))
          : null;
        if (f && tgt) {
          pendingLook.pickFilter = f;
          pendingLook.pickMin = num(pm[2]);
          pendingLook.pickMax = num(pm[2]);
          pendingLook.pickDest = "cheerAssign";
          pendingLook.revealPick = pendingLookIsReveal || s.includes("公開");
          pendingLook.pickTargetFilter = tgt.filter;
          pendingLookPicked = true;
          continue;
        }
        return null;
      }
      // 残りの処理
      const rm = s.match(
        /^そして残った(?:カード|エール)を(好きな順で)?(?:デッキ|エールデッキ)?の?(下|上)に戻す$/,
      );
      if (rm) {
        pendingLook.rest = rm[2] === "下" ? "bottom" : "top";
        pendingLook.restOrder = !!rm[1];
        if (!finalizeLook()) return null;
        continue;
      }
      if (/^そして残った(?:カード|エール)をアーカイブする$/.test(s)) {
        pendingLook.rest = "archive";
        if (!finalizeLook()) return null;
        continue;
      }
      if (/^そしてホロパワーをシャッフルする$/.test(s)) {
        pendingLook.rest = "top";
        if (!finalizeLook()) return null;
        ops.push({ t: "shuffleHolo" });
        continue;
      }
      if (
        /^そして残った(?:カード|エール)を(?:デッキ|エールデッキ)に戻してシャッフルする$/.test(
          s,
        )
      ) {
        pendingLook.rest = "shuffle";
        if (!finalizeLook()) return null;
        continue;
      }
    }

    // 「そのホロメンが(#Tを持つ)(レベル)なら、かわりに、そのホロメンのアーツ+X」 (選択後の置換)
    {
      const bm = s.match(
        /^(?:その|選んだ)ホロメンが(?:#([^、を]+?)を持つ)?((?:Buzzホロメン|Debutホロメン|1stホロメン|2ndホロメン)(?:か(?:Buzzホロメン|Debutホロメン|1stホロメン|2ndホロメン))*)なら、かわりに、その(?:ホロメンの)?アーツ\+(\d+)$/,
      );
      if (bm) {
        const levels = bm[2]
          .split("か")
          .map((w) =>
            w === "Buzzホロメン"
              ? ("Buzz" as const)
              : (w.replace("ホロメン", "") as "Debut" | "1st" | "2nd"),
          );
        ops.push({
          t: "boundArtPlusReplace",
          levels,
          tag: bm[1] || undefined,
          value: num(bm[3]),
        });
        continue;
      }
    }
    // 「そのホロメンの色が(色)の時、さらに、そのアーツ+X」 (選択後の条件付き加算)
    {
      const bm = s.match(
        new RegExp(
          `^(?:その|選んだ)ホロメンの色が${COLOR_RE}の時、さらに、その(?:ホロメンの)?アーツ\\+(\\d+)$`,
        ),
      );
      if (bm) {
        ops.push({
          t: "boundArtPlusReplace",
          color: bm[1] as Color,
          value: num(bm[2]),
          add: true,
        });
        continue;
      }
    }
    // 「そのホロメンに、エールがX枚以上付いているなら、かわりに、そのホロメンのアーツ+X」
    {
      const bm = s.match(
        /^(?:その|選んだ)ホロメンに、?エールが(\d+)枚以上付いているなら、かわりに、その(?:ホロメンの)?アーツ\+(\d+)$/,
      );
      if (bm) {
        ops.push({
          t: "boundArtPlusReplace",
          yellAtLeast: num(bm[1]),
          value: num(bm[2]),
        });
        continue;
      }
    }
    // 「そのホロメンが(レベル)ホロメンの〈N〉なら、かわりに、そのアーツに必要な無色-X」 (選択後のコスト置換)
    {
      const bm = s.match(
        /^(?:その|選んだ)ホロメンが(Debut|1st|2nd)ホロメンの((?:〈[^〉]+〉)+)なら、かわりに、その(?:ホロメンの)?アーツに必要な(?:◇|無色)-(\d+)$/,
      );
      const prev = ops[ops.length - 1];
      if (bm && prev?.t === "turnCostMod" && prev.target === "bound") {
        ops.pop();
        ops.push({
          t: "ifElse",
          cond: {
            c: "boundIs",
            filter: {
              bloomLevel: bm[1] as "Debut" | "1st" | "2nd",
              names: parseNames(bm[2]),
            },
          },
          then: [{ ...prev, artCostless: num(bm[3]) }],
          else: [prev],
        });
        continue;
      }
    }
    // 「(条件)なら/時、かわりに、(効果)」を条件付きの置換にする。
    // (「時」形は条件解析に成功した場合のみ適用し、失敗時は後続の解析に委ねる)
    {
      const im = s.match(/^(.+?)(なら|時)、かわりに、(.+)$/);
      if (im && ops.length > 0) {
        const cond = parseCond(im[1]);
        const altOps = cond ? parseSentence(im[3]) : null;
        if (cond && altOps) {
          const selectedBonus = ops.length === 1 ? ops[0] : undefined;
          // 発生元の条件で「そのホロメン」への値を置換しても、先行する対象選択は必要。
          // 分岐の成立側だけにboundを置くと、選択先が未設定のまま補正が失われる。
          if (
            selectedBonus?.t === "turnArtPlus" &&
            selectedBonus.target === "chooseOwn" &&
            (selectedBonus.count ?? 1) === 1 &&
            altOps.length === 1 &&
            altOps[0].t === "turnArtPlus" &&
            altOps[0].target === "bound"
          ) {
            ops.splice(
              0,
              ops.length,
              { t: "chooseBind", scope: "own", filter: selectedBonus.filter },
              {
                t: "ifElse",
                cond,
                then: altOps,
                else: [{ ...selectedBonus, target: "bound" }],
              },
            );
            continue;
          }
          // 独立した後続ドローの枚数変更は、そのドローだけに掛かる。
          // 先行する特殊ダメージ等まで置換すると、雪民3枚時の
          // 「有言実行！！」で特殊ダメージが消えてしまう。
          const drawOnly =
            altOps.length === 1 &&
            altOps[0].t === "draw" &&
            ops[ops.length - 1].t === "draw";
          const prev = ops.splice(drawOnly ? ops.length - 1 : 0);
          ops.push({ t: "ifElse", cond, then: altOps, else: prev });
          continue;
        }
        if (im[2] === "なら") return null;
      }
    }
    // 「X枚以上ある時、さらに、(効果)」: 直前の archiveHas 条件の枚数違いとして結合
    {
      const am = s.match(/^(\d+)枚以上ある時、さらに、(.+)$/);
      const prev = ops[ops.length - 1];
      if (am && prev?.t === "if" && prev.cond.c === "archiveHas") {
        const branchOps = parseSentence(am[2]);
        if (!branchOps) return null;
        ops.push({
          t: "if",
          cond: { c: "archiveHas", filter: prev.cond.filter, n: num(am[1]) },
          then: branchOps,
        });
        continue;
      }
    }
    // 直前がサイコロopなら、「Xの時、〜」形式の文を追加分岐として結合する。
    // 「条件なら、サイコロを振る」で if にラップされている場合は then 末尾の dice を対象にする
    // (間に挟まる「そしてデッキをシャッフルする」等は読み飛ばす)
    let lastIdx = ops.length - 1;
    while (
      lastIdx >= 0 &&
      (ops[lastIdx].t === "shuffleDeck" || ops[lastIdx].t === "shuffleCheer")
    )
      lastIdx--;
    const lastOp = ops[lastIdx];
    const diceOp: Extract<Op, { t: "dice" }> | null =
      lastOp?.t === "dice"
        ? lastOp
        : (lastOp?.t === "if" ||
              lastOp?.t === "ifElse" ||
              lastOp?.t === "optionalCost") &&
            lastOp.then[lastOp.then.length - 1]?.t === "dice"
          ? (lastOp.then[lastOp.then.length - 1] as Extract<Op, { t: "dice" }>)
          : null;
    if (diceOp) {
      // 「出た目の(合計)数1につき、このアーツ+X」を直前のサイコロに結合
      const sm = s.match(/^出た目の(?:合計)?数(\d+)につき、このアーツ\+(\d+)$/);
      if (sm && num(sm[1]) === 1) {
        diceOp.sumArtPlus = num(sm[2]);
        continue;
      }
      // 「出た目の数Xにつき、(効果)」を分岐として結合
      const pvm = s.match(/^出た目の数(\d+)につき、(.+)$/);
      if (pvm) {
        const pvOps = parseSentence(pvm[2]);
        if (pvOps) {
          diceOp.branches.push({ cond: { perValue: num(pvm[1]) }, ops: pvOps });
          continue;
        }
      }
      // 「奇数が出た回数X回につき、(効果)」を奇数分岐として結合
      const ocm = s.match(
        /^(?:このターンの間、)?(?:この能力で)?(?:(.+?)に、)?奇数が出た回数(\d+)回につき、(.+)$/,
      );
      if (ocm && num(ocm[2]) === 1) {
        const ocOps = parseSentence((ocm[1] ? `${ocm[1]}に` : "") + ocm[3]);
        if (ocOps) {
          diceOp.branches.push({ cond: "odd", ops: ocOps, countBased: true });
          continue;
        }
      }
      // 「X以上が出た回数X回につき、(効果)」をge分岐として結合
      const gcm = s.match(/^(\d+)以上が出た回数(\d+)回につき、(.+)$/);
      if (gcm && num(gcm[2]) === 1) {
        const gcOps = parseSentence(gcm[3]);
        if (gcOps) {
          diceOp.branches.push({
            cond: { ge: num(gcm[1]) },
            ops: gcOps,
            countBased: true,
          });
          continue;
        }
      }
      // 「ただし、振れる回数はX回まで」を回数上限として結合
      const capM = s.match(/^ただし、振れる回数は(\d+)回まで$/);
      if (capM && diceOp.rollsFrom) {
        diceOp.rollsFrom.max = num(capM[1]);
        continue;
      }
      // 出目修正で7以上にもなるため、実行時の出目をドロー目標にする。
      if (
        /^自分の手札が出た目の数と同じになるまで、自分のデッキを引く$/.test(s)
      ) {
        diceOp.drawUntilRoll = true;
        continue;
      }
      const bm = s.match(
        /^(?:出た目が)?(.+?)(?:の時|なら)、?(?:さらに、?)?(.+)$/,
      );
      if (bm) {
        const cond = parseDiceCond(bm[1]);
        const branchOps = cond ? parseSentence(bm[2]) : null;
        if (cond && branchOps) {
          diceOp.branches.push({ cond, ops: branchOps });
          continue;
        }
      }
    }
    // 「ただし、引ける枚数はX枚まで」を直前の drawUntilStageNames の上限として結合
    {
      const dcap = s.match(/^ただし、引ける枚数は(\d+)枚まで$/);
      const prev = ops[ops.length - 1];
      if (dcap && prev?.t === "drawUntilStageNames") {
        prev.cap = num(dcap[1]);
        continue;
      }
    }
    // 「自分の出た目の数が相手以上/より小さいなら、(効果)」を直前の diceVs に結合
    {
      const prev = ops[ops.length - 1];
      if (prev?.t === "diceVs") {
        let vm = s.match(/^自分の出た目の数が相手以上なら、(.+)$/);
        if (vm) {
          const b = parseSentence(vm[1]);
          if (!b) return null;
          prev.geOps.push(...b);
          continue;
        }
        vm = s.match(/^自分の出た目の数が相手より小さいなら、(.+)$/);
        if (vm) {
          const b = parseSentence(vm[1]);
          if (!b) return null;
          prev.ltOps.push(...b);
          continue;
        }
      }
    }
    // 「ただし、ホロメン1人に送る枚数はX枚まで」を直前の cheerFromArchive に結合
    {
      const tcap = s.match(/^ただし、ホロメン1人に送る枚数は(\d+)枚まで$/);
      const prev = ops[ops.length - 1];
      if (tcap && prev?.t === "cheerFromArchive") {
        prev.perTargetMax = num(tcap[1]);
        continue;
      }
    }
    // 「そしてそれぞれのデッキをX枚引く」を直前の bothShuffleHandIntoDeck に結合
    // (「かわりに」で ifElse にラップされている場合は then 側の末尾を対象にする)
    {
      const bd = s.match(/^(?:そして)?それぞれのデッキを(\d+)枚引く$/);
      if (bd) {
        const prev = ops[ops.length - 1];
        const both =
          prev?.t === "bothShuffleHandIntoDeck"
            ? prev
            : (prev?.t === "if" || prev?.t === "ifElse") &&
                prev.then[prev.then.length - 1]?.t === "bothShuffleHandIntoDeck"
              ? (prev.then[prev.then.length - 1] as Extract<
                  Op,
                  { t: "bothShuffleHandIntoDeck" }
                >)
              : null;
        if (!both) return null;
        both.thenDraw = num(bd[1]);
        continue;
      }
    }
    // 「この能力では最初のターンでもBloomできる」を直前の effectBloom に結合
    if (/^この能力では最初のターンでもBloomできる$/.test(s)) {
      const eb = findLastEffectBloom(ops);
      if (eb) {
        eb.allowFirstTurn = true;
        continue;
      }
      return null;
    }
    // 「そしてデッキをシャッフルする」は直前の効果に属する。任意コストを
    // 見送った・条件を満たさなかった等でその効果を実行しなかった時は、デッキを
    // 見ていないのでシャッフルも起きない。逆に実行したなら (目的のカードが
    // 無くても) シャッフルする — 公式QA Q46・Q97。
    {
      const sm = s.match(
        /^そして(?:自分の)?(デッキ|エールデッキ)をシャッフルする$/,
      );
      if (sm) {
        // 条件内の任意コストなど、直前の効果を包む条件をすべて辿る。
        // 出目条件の最後の分岐にも属し、後続の別分岐より先に処理する。
        let container = ops;
        while (true) {
          const prev = container[container.length - 1];
          if (prev?.t === "optionalCost" || prev?.t === "if")
            container = prev.then;
          else if (prev?.t === "dice" && prev.branches.length > 0)
            container = prev.branches[prev.branches.length - 1].ops;
          else break;
        }
        if (container !== ops) {
          container.push(
            sm[1] === "デッキ" ? { t: "shuffleDeck" } : { t: "shuffleCheer" },
          );
          continue;
        }
      }
    }
    const parsed = parseSentence(s);
    if (parsed === null) return null;
    ops.push(...parsed);
  }
  if (!finalizeLook()) return null;
  if (pendingYellReturn !== null) return null; // 「戻したなら」の文がない
  if (pendingNumChoice !== null) return null; // 「選んだ数として扱う」の文がない
  // 文頭の「〜なら」「〜時」は、句点の後の「その後」「さらに」にも及ぶ (公式Q691)。
  // ダウン成功時の後続処理も同じ条件内に置き、アーツダメージ後にまとめて評価する。
  // 後攻最初のターン限定能力は、それ以外の続き方でも全体を条件内に置く。
  // 「どちらか1色しか付いていないなら」等、別条件で始まる文は含めない。
  const sentences = t.split("。");
  // 加算の条件と、続く別条件による軽減不可は独立 (公式Q539)。
  // 能力の発揮条件で後段全体を制限するQ691の構文とは区別する。
  const independentArtDamageCondition =
    /^さらに、/.test(sentences[1]?.trim() ?? "") &&
    ops.length === 2 &&
    ops[0].t === "if" &&
    ops[0].then.length > 0 &&
    ops[0].then.every((op) => op.t === "artPlus") &&
    ops[1].t === "if" &&
    ops[1].then.length > 0 &&
    ops[1].then.every((op) => op.t === "artNoReduce");
  const hasConditionalContinuation =
    t.startsWith("自分が後攻で最初のターンなら、") ||
    (!independentArtDamageCondition &&
      /(?:なら|時)、/.test(sentences[0]) &&
      sentences
        .slice(1)
        .some((sentence) => /^(その後|さらに)、/.test(sentence.trim())));
  if (hasConditionalContinuation) {
    const first = ops[0];
    if (first?.t === "if" && ops.length > 1) {
      first.then.push(...ops.slice(1));
      ops.length = 1;
    }
  }
  // 10.4.1: コロンより後のテキスト全体は、その能力のコストを支払った時に解決する。
  // 句点で分かれた追加条件・選択対象への修正・公開カードの移動も同じ支払い内に置く。
  if (/[:：]/.test(sentences[0])) {
    const containers: Op[][] = [ops];
    let head = ops[0];
    while (head?.t === "if") {
      containers.push(head.then);
      head = head.then[0];
    }
    if (head?.t === "optionalCost") {
      for (const container of containers) {
        const first = container[0];
        if (first.t === "if" || first.t === "optionalCost") {
          first.then.push(...container.slice(1));
          container.length = 1;
        }
      }
    }
  }
  // 5.24.2: 「サイコロを振れる：」の後続テキスト全体は、振った時だけ実行する。
  // 出目分岐に属さない「その後」の条件等も、辞退時に実行しない。
  const firstDice = ops[0];
  if (
    /^(?:サイコロを)?\d+回振れる[:：]/.test(t) &&
    firstDice?.t === "dice" &&
    firstDice.optional &&
    ops.length > 1
  ) {
    const thenOps: Op[] = [
      { ...firstDice, optional: undefined },
      ...ops.slice(1),
    ];
    ops.splice(0, ops.length, {
      t: "chooseOps",
      label: `サイコロを${firstDice.rolls ?? 1}回振りますか？`,
      thenOps,
      elseOps: [],
    });
  }
  if (bloomFromDebut)
    return {
      ops: [{ t: "if", cond: { c: "bloomedFromDebut" }, then: ops }],
      text,
    };
  if (bloomFromBuzz)
    return {
      ops: [{ t: "if", cond: { c: "bloomedFromBuzz" }, then: ops }],
      text,
    };
  if (bloomBySpSkillName)
    return {
      ops: [
        {
          t: "if",
          cond: { c: "selfBloomedBySpOshiSkill", name: bloomBySpSkillName },
          then: ops,
        },
      ],
      text,
    };
  return { ops, text };
}
