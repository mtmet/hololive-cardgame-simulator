// カード本文の解析：gifts。
import type { Color } from "../../data/types";
import { parseEffect } from "./compound";
import { parseCond } from "./conditions";
import {
  parseCardFilter,
  parseSubjectFilter,
  parseTargetFilterMods,
  parseAuraPrefixFilter,
} from "./filters";
import { num, normalizeText, parseNames, COLOR_RE } from "./normalization";
import type {
  TriggerEvent,
  GiftDef,
  Op,
  TriggerDef,
  TargetFilter,
  Cond,
} from "./types";

/** セクション先頭のヘッダ ([ターンにX回]/[ポジション限定]) を抽出 */
function stripGiftHeaders(sec: string): {
  rest: string;
  timesPerTurn?: number;
  positions?: ("center" | "collab")[];
} {
  let timesPerTurn: number | undefined;
  let positions: ("center" | "collab")[] | undefined;
  const rest = sec
    .replace(/\[ターンに(\d+)回\]/, (_a, v: string) => {
      timesPerTurn = num(v);
      return "";
    })
    .replace(/\[センターポジション・コラボポジション限定\]/, () => {
      positions = ["center", "collab"];
      return "";
    })
    .replace(/\[センターポジション限定\]/, () => {
      positions = ["center"];
      return "";
    })
    .replace(/\[コラボポジション限定\]/, () => {
      positions = ["collab"];
      return "";
    })
    .trim();
  return { rest, timesPerTurn, positions };
}

const GIFT_TRIGGER_PATS: [RegExp, TriggerEvent][] = [
  [
    /^このホロメンが(センターポジション(?:かコラボポジション)?で)?アーツを使った時、/,
    "artUsed",
  ],
  [
    /^このホロメンが相手の(センター|コラボ)?ホロメンをダウンさせた時、/,
    "downedOpponent",
  ],
  [/^このホロメンが(?:アーツ)?ダメージを受けた時、/, "damaged"],
  [/^このホロメンがダウンした時、/, "downed"],
  [/^このホロメンがコラボした時、/, "collabed"],
  [/^このホロメンがコラボポジションに移動した時、/, "collabMoved"],
  [
    /^このホロメンがバトンタッチしてバックポジションに移動した時、/,
    "batonTouched",
  ],
  [/^自分のSP推しスキル(?:「([^」]+)」)?を使った時、/, "spSkillUsed"],
  [/^自分の推しスキル(?:「([^」]+)」)?を使った時、/, "oshiSkillUsed"],
];

export function parseGift(text: string | undefined): GiftDef {
  const g: GiftDef = {
    triggers: [],
    selfHpPlus: [],
    selfArtPlus: [],
    auras: [],
    damageAuras: [],
    full: true,
  };
  if (!text) return g;
  text = normalizeText(text);
  const threshold = text.match(
    /^\[ターンに1回\]相手のターンで、このホロメンが1回に(\d+)以上のアーツダメージを受けた時、(.+)$/,
  );
  if (threshold) {
    const ops = threshold[2].startsWith(
      "相手は、自身のセンターホロメンのエールすべて",
    )
      ? [{ t: "oppCenterAllYellReturn" } as Op]
      : parseEffect(threshold[2])?.ops;
    if (ops) {
      g.triggers.push({
        event: "damaged",
        oppTurnOnly: true,
        timesPerTurn: 1,
        artDamageOnly: true,
        minDamage: num(threshold[1]),
        ops,
      });
      return g;
    }
  }
  if (
    /^自分のステージにホロメンが3人以上いるなら、このホロメンのバトンタッチに必要な無色-1。?$/.test(
      text,
    )
  ) {
    g.selfBatonMods = [
      { delta: -1, cond: { c: "stageHas", filter: {}, n: 3 } },
    ];
    return g;
  }
  if (/^このホロメンはリセットステップでお休みしない。?$/.test(text)) {
    g.noRestOnMove = {};
    return g;
  }
  if (
    /^\[センターポジション限定\]自分の#FLOW GLOWを持つコラボホロメンのアーツに必要なエールの色すべてを無色にする。?$/.test(
      text,
    )
  ) {
    g.colorlessAuras = [
      {
        filter: { tag: "FLOW GLOW" },
        targetPos: "collab",
        positions: ["center"],
      },
    ];
    return g;
  }
  if (
    /^\[ターンに1回\]このホロメンが〈牛丼〉の能力で回復するHP\+100。?$/.test(
      text,
    )
  ) {
    g.healBonus = { name: "牛丼", value: 100, timesPerTurn: 1 };
    return g;
  }
  if (
    /^このホロメンにツールが付いているなら、このホロメンは、#カエラ'sアームズを持つツールをもう1枚まで付けられる。?$/.test(
      text,
    )
  ) {
    g.extraToolTag = "カエラ'sアームズ";
    return g;
  }
  if (
    /^自分の推しホロメンが〈桃鈴ねね〉なら、このホロメンは1回に200以上のアーツダメージを受けない。?$/.test(
      text,
    )
  ) {
    g.noArtDamageAtLeast = {
      n: 200,
      cond: { c: "oshiIs", names: ["桃鈴ねね"] },
    };
    return g;
  }
  if (
    /^このホロメンが相手のホロメンをダウンさせた時、自分の推しホロメンが〈ベスティア・ゼータ〉なら、サイコロを2回振る。出た目の合計数がお互いのライフの合計数と同じなら、相手のライフ-1。?$/.test(
      text,
    )
  ) {
    g.triggers.push({
      event: "downedOpponent",
      ops: [
        {
          t: "if",
          cond: { c: "oshiIs", names: ["ベスティア・ゼータ"] },
          then: [
            {
              t: "dice",
              rolls: 2,
              branches: [
                { cond: "eqBothLife", ops: [{ t: "oppLifeMinus", n: 1 }] },
              ],
            },
          ],
        },
      ],
    });
    return g;
  }
  if (
    /^このホロメンが相手のホロメンをダウンさせた時、自分の#FLOW GLOWを持つバックホロメン1人を選ぶ。選んだホロメンを含め重なっているホロメンすべてを手札に戻せる。?$/.test(
      text,
    )
  ) {
    g.triggers.push({
      event: "downedOpponent",
      ops: [
        { t: "chooseBind", scope: "ownBack", filter: { tag: "FLOW GLOW" } },
        { t: "boundStackToHand", optional: true },
      ],
    });
    return g;
  }
  if (
    /^\[センターポジション限定\]自分の推しスキルを使った時、このターンの間、自分のコラボの〈ネリッサ・レイヴンクロフト〉のアーツに必要な紫-1。?$/.test(
      text,
    )
  ) {
    g.triggers.push({
      event: "oshiSkillUsed",
      positions: ["center"],
      ops: [
        {
          t: "turnCostMod",
          target: "ownCollab",
          filter: { names: ["ネリッサ・レイヴンクロフト"] },
          artColorCostless: { color: "紫", n: 1 },
        },
      ],
    });
    return g;
  }
  const archiveMax = text.match(
    /^自分のアーカイブの(.+?)が(\d+)枚以下なら、このホロメンのアーツに必要な無色\+(\d+)。?$/,
  );
  if (archiveMax) {
    const filter = parseCardFilter(archiveMax[1]);
    if (filter) {
      g.selfArtCostMods = [
        {
          delta: -num(archiveMax[3]),
          cond: {
            c: "not",
            inner: { c: "archiveHas", filter, n: num(archiveMax[2]) + 1 },
          },
        },
      ];
      return g;
    }
  }
  const guarded = text.match(
    /^(.+?)なら、このホロメンが(?:(1st)ホロメンから)?受けるアーツダメージ-(\d+)。?$/,
  );
  if (guarded) {
    const cond = parseCond(guarded[1]);
    if (cond) {
      g.damageAuras.push({
        delta: -num(guarded[3]),
        selfOnly: true,
        artOnly: true,
        fromSource: guarded[2] ? { bloomLevel: "1st" } : undefined,
        cond,
      });
      return g;
    }
  }
  if (
    /^\[センターポジション限定\]自分のホロパワーが2枚以上なら、自分の〈ネリッサ・レイヴンクロフト〉全員が受けるアーツダメージ-30。?$/.test(
      text,
    )
  ) {
    g.damageAuras.push({
      delta: -30,
      filter: { names: ["ネリッサ・レイヴンクロフト"] },
      positions: ["center"],
      artOnly: true,
      cond: { c: "holoPowerAtLeast", n: 2 },
    });
    return g;
  }
  if (
    /^相手のターンで、このホロメンがダウンした時、このホロメンに付いているサポートカード1枚を手札に戻せる。?$/.test(
      text,
    )
  ) {
    g.triggers.push({
      event: "downed",
      oppTurnOnly: true,
      optional: true,
      ops: [{ t: "downedToHand", what: "support", n: 1 }],
    });
    return g;
  }
  {
    const downSupport = text.match(
      /^相手のターンで、このホロメンがダウンした時、このホロメンに付いている#([^、を]+?)を持つサポートカード1枚を手札に戻せる。?$/,
    );
    if (downSupport) {
      g.triggers.push({
        event: "downed",
        oppTurnOnly: true,
        optional: true,
        ops: [
          {
            t: "downedToHand",
            what: "support",
            n: 1,
            filter: { kind: "サポート", tag: downSupport[1] },
          },
        ],
      });
      return g;
    }
  }
  {
    const attached = text.match(
      /^このホロメンに付いている((?:〈[^〉]+〉)+)1枚につき、このホロメンのHP\+(\d+)し、このホロメンのアーツに必要な無色-(\d+)。?$/,
    );
    if (attached) {
      const names = parseNames(attached[1]);
      g.hpPerAttachedName = { names, value: num(attached[2]) };
      g.artCostlessPerAttachedName = { names, value: num(attached[3]) };
      return g;
    }
  }
  // 保持者ごとの[ターンにX回]とは異なり、能力名で使用回数を共有する。
  let giftTimesLimit: number | undefined;
  text = text.replace(
    /自分のギフト「([^」]+)」はターンに(\d+)回しか使えない。?/,
    (_a, name: string, v: string) => {
      giftTimesLimit = parseInt(v, 10);
      g.sharedUseLimit = { name, n: giftTimesLimit };
      return "";
    },
  );

  for (const rawSec of text.split("■")) {
    const secRaw = rawSec.trim();
    if (!secRaw) continue;
    const { rest, timesPerTurn, positions } = stripGiftHeaders(secRaw);
    let sec = rest;
    let oppTurnOnly = false;
    let selfTurnOnly = false;
    const ot = sec.match(/^相手のターンで、/);
    if (ot) {
      oppTurnOnly = true;
      sec = sec.slice(ot[0].length);
    } else {
      const st = sec.match(/^自分のターンで、/);
      if (st) {
        selfTurnOnly = true;
        sec = sec.slice(st[0].length);
      }
    }

    // 長尾の付与型ギフト: 既存Opで表現できる盤面トリガー/起動型/常時効果
    if (
      /^自分のホロメンが相手のホロメンをダウンさせた時、自分のホロメン1人を選ぶ。このターンの間、選んだホロメン1人のアーツに必要な無色-2。?$/.test(
        sec,
      )
    ) {
      g.triggers.push({
        event: "allyDownedOpponent",
        positions,
        timesPerTurn,
        oppTurnOnly: oppTurnOnly || undefined,
        selfTurnOnly: selfTurnOnly || undefined,
        ops: [
          { t: "chooseBind", scope: "own" },
          { t: "turnCostMod", target: "bound", artCostless: 2 },
        ],
      });
      continue;
    }
    if (
      /^自分の〈水宮枢〉がコラボした時、相手のセンターホロメンを選ぶ。次の相手のターンが終了するまで、選んだホロメンのバトンタッチに必要な無色\+1。?$/.test(
        sec,
      )
    ) {
      g.triggers.push({
        event: "allyCollabed",
        subjectFilter: { names: ["水宮枢"] },
        positions,
        timesPerTurn,
        oppTurnOnly: oppTurnOnly || undefined,
        selfTurnOnly: selfTurnOnly || undefined,
        ops: [
          {
            t: "turnCostMod",
            target: "oppCenter",
            batonDelta: 1,
            untilNextOppTurn: true,
          },
        ],
      });
      continue;
    }
    if (
      /^自分のステージの〈ゆび〉1枚をデッキの下に戻せる：このターンの間、このホロメンのアーツに必要な無色-2。?$/.test(
        sec,
      )
    ) {
      (g.activated ??= []).push({
        positions,
        timesPerTurn,
        ops: [
          {
            t: "optionalCost",
            cost: [{ t: "stageSupportToDeckBottom", names: ["ゆび"], n: 1 }],
            then: [{ t: "turnCostMod", target: "self", artCostless: 2 }],
            label: "〈ゆび〉1枚をデッキの下に戻して効果を使いますか？",
          },
        ],
      });
      continue;
    }
    if (
      /^このホロメンのアーツの対象が自分のアーカイブのエールと同色の相手のホロメンなら、このホロメンのアーツダメージは軽減されない。?$/.test(
        sec,
      )
    ) {
      g.artNoReduceArchiveTargetColor = true;
      continue;
    }
    {
      const fm = sec.match(
        /^自分の推しスキル「([^」]+)」の\[ホロパワー[:：]-([0-9]+)\]を\[ホロパワー[:：]-([0-9]+)\]に変更する。?$/,
      );
      if (fm) {
        g.oshiSkillCostMod = {
          skillName: fm[1],
          delta: num(fm[3]) - num(fm[2]),
          positions,
        };
        continue;
      }
    }
    if (
      /^このホロメンがアーツを使った時、このホロメンのエール2枚を自分のバックホロメン1人に送れる。その後、自分のアーカイブの、エールを送られたホロメンと同じカード名の1stホロメン1枚を手札に戻す。?$/.test(
        sec,
      )
    ) {
      g.triggers.push({
        event: "artUsed",
        positions,
        timesPerTurn,
        oppTurnOnly: oppTurnOnly || undefined,
        selfTurnOnly: selfTurnOnly || undefined,
        ops: [
          {
            t: "moveYell",
            min: 2,
            max: 2,
            fromSelf: true,
            targetFilter: { position: "back" },
            optional: true,
            sameTarget: true,
          },
          {
            t: "moveArchive",
            filter: {
              kind: "holomen",
              bloomLevel: "1st",
              sameNameAsAttachedTo: true,
            },
            min: 1,
            max: 1,
            dest: "hand",
          },
        ],
      });
      continue;
    }
    if (
      /^このホロメンが相手のホロメンにアーツダメージを与えた時に使える：その相手のホロメンに、そのホロメンが受けているダメージと同じ数値の特殊ダメージを与える。?$/.test(
        sec,
      )
    ) {
      g.triggers.push({
        event: "dealtArt",
        optional: true,
        positions,
        timesPerTurn,
        oppTurnOnly: oppTurnOnly || undefined,
        selfTurnOnly: selfTurnOnly || undefined,
        ops: [
          {
            t: "special",
            dmg: 0,
            dmgFrom: "artTargetDamage",
            target: "artTarget",
          },
        ],
      });
      continue;
    }
    if (
      /^自分のパフォーマンスステップが開始する時、このホロメン以外の自分の〈オーロ・クロニー〉1人を、このホロメンに重なっているホロメンを使ってBloomできる。?$/.test(
        sec,
      )
    ) {
      g.triggers.push({
        event: "selfPerfStepStart",
        positions,
        timesPerTurn,
        oppTurnOnly: oppTurnOnly || undefined,
        selfTurnOnly: selfTurnOnly || undefined,
        ops: [
          {
            t: "effectBloom",
            source: "stacked",
            filter: { names: ["オーロ・クロニー"], excludeSource: true },
            cardFilter: { kind: "holomen" },
            optional: true,
          },
        ],
      });
      continue;
    }
    if (
      /^このホロメンがダウンした時、自分のアーカイブのLIMITEDのサポートカード1枚をデッキの下に戻せる。戻したなら、このホロメンをアーカイブするかわりに手札に戻す。?$/.test(
        sec,
      )
    ) {
      g.downToHand = {
        oppTurnOnly: oppTurnOnly || undefined,
        limitedArchiveToDeckBottom: true,
      };
      continue;
    }
    if (
      /^自分のライフが3以下の間、このホロメンは、自分の手札の2nd〈AZKi〉に、Bloomレベルを無視してBloomできる。?$/.test(
        sec,
      )
    ) {
      (g.activated ??= []).push({
        cond: { c: "lifeAtMost", n: 3 },
        ops: [
          {
            t: "effectBloom",
            source: "hand",
            targetSelf: true,
            cardFilter: { kind: "holomen", bloomLevel: "2nd", names: ["AZKi"] },
            ignoreLevel: true,
            optional: true,
          },
        ],
      });
      continue;
    }
    if (
      /^自分の推しホロメンが〈輪堂千速〉で、相手のステージに1stホロメンがいるなら、このターンにBloomしたこのホロメンは、自分の手札の2ndホロメンを使ってもう1回Bloomできる。?$/.test(
        sec,
      )
    ) {
      (g.activated ??= []).push({
        cond: {
          c: "and",
          inner: [
            { c: "oshiIs", names: ["輪堂千速"] },
            { c: "oppStageHas", filter: { bloomLevel: "1st" } },
          ],
        },
        ops: [
          {
            t: "effectBloom",
            source: "hand",
            targetSelf: true,
            filter: { bloomedThisTurn: true },
            cardFilter: { kind: "holomen", bloomLevel: "2nd" },
            rebloom: true,
            optional: true,
          },
        ],
      });
      continue;
    }
    if (
      /^自分の推しホロメンの〈獅白ぼたん〉か自分のステージの〈獅白ぼたん〉が相手のホロメンに30以上の特殊ダメージを与えた時、自分のデッキを1枚引く。?$/.test(
        sec,
      )
    ) {
      g.triggers.push({
        event: "allyDealtSpecial",
        subjectFilter: { names: ["獅白ぼたん"] },
        includeOshiSubject: true,
        minDamage: 30,
        positions,
        timesPerTurn,
        oppTurnOnly: oppTurnOnly || undefined,
        selfTurnOnly: selfTurnOnly || undefined,
        ops: [{ t: "draw", n: 1 }],
      });
      continue;
    }
    {
      const cm = sec.match(
        /^このホロメンのアーツ「([^」]+)」でカードを公開した時、公開したサポートカード1枚を、アーカイブするかわりに手札に加えられる。?$/,
      );
      if (cm) {
        g.triggers.push({
          event: "artUsed",
          revealedByArt: cm[1],
          revealedArchiveReplacement: true,
          positions,
          timesPerTurn,
          oppTurnOnly: oppTurnOnly || undefined,
          selfTurnOnly: selfTurnOnly || undefined,
          ops: [
            {
              t: "if",
              cond: { c: "artNameIs", name: cm[1] },
              then: [{ t: "recoverRevealedSupport" }],
            },
          ],
        });
        continue;
      }
    }
    {
      const cm = sec.match(
        /^このホロメンのアーツ「([^」]+)」でカードを公開した時、公開したカード3枚が同じBloomレベルのホロメンなら、相手のライフ-1。?$/,
      );
      if (cm) {
        g.triggers.push({
          event: "artUsed",
          revealedByArt: cm[1],
          positions,
          timesPerTurn,
          oppTurnOnly: oppTurnOnly || undefined,
          selfTurnOnly: selfTurnOnly || undefined,
          ops: [
            {
              t: "if",
              cond: {
                c: "and",
                inner: [
                  { c: "artNameIs", name: cm[1] },
                  { c: "revealedSameBloom", n: 3 },
                ],
              },
              then: [{ t: "oppLifeMinus", n: 1 }],
            },
          ],
        });
        continue;
      }
    }
    if (
      /^自分のセンターホロメンに付いている〈ルーナイト〉をアーカイブする時、アーカイブするかわりに、自分のバックホロメンの〈姫森ルーナ〉に付け替えられる。?$/.test(
        sec,
      )
    ) {
      g.archiveRedirect = {
        supportNames: ["ルーナイト"],
        targetNames: ["姫森ルーナ"],
        oppTurnOnly: oppTurnOnly || undefined,
      };
      continue;
    }
    if (
      /^このホロメンは、自分のステージの#ENを持つホロメン全員のアーツを、すべて使える（アーツを使うためのエールは必要）。?$/.test(
        sec,
      )
    ) {
      g.borrowArtsTag = "EN";
      continue;
    }
    if (
      /^自分のメインステップで、自分のアーカイブにホロメンが10枚以上あるなら、自分のホロメンを、アーカイブのこのホロメンを使ってBloomできる（この能力は、アーカイブにある時のみ使える）。?$/.test(
        sec,
      )
    ) {
      g.archiveBloom = { minArchiveHolomen: 10 };
      continue;
    }
    if (
      /^自分のバックホロメンが相手から特殊ダメージを受ける時、このホロメンに重なっているホロメン1枚をアーカイブできる：このターンの間、自分のバックホロメン全員は特殊ダメージを受けない。?$/.test(
        sec,
      )
    ) {
      g.backSpecialShield = { oppTurnOnly: oppTurnOnly || undefined };
      continue;
    }
    // ダウン時「アーカイブのかわりに手札に戻せる」は 'downed' トリガーより先に判定する
    // (GIFT_TRIGGER_PATS の 'downed' が本文を吸い取ると parseEffect 失敗になるため)
    if (
      /^このホロメンがダウンした時、このホロメンをアーカイブするかわりに手札に戻せる。?$/.test(
        sec,
      )
    ) {
      g.downToHand = { oppTurnOnly: oppTurnOnly || undefined };
      continue;
    }

    // メインステップで使える起動型ギフト能力
    // A: 「(cond)なら、自分のメインステップに使える：<効果>」
    // B: 「自分のメインステップで、((cond)(の時|なら)、)?<効果>」
    {
      let condText: string | undefined;
      let body: string | null = null;
      const a = sec.match(/^(.+?)なら、自分のメインステップに使える[:：](.+)$/);
      if (a) {
        condText = a[1];
        body = a[2];
      } else {
        const b = sec.match(
          /^自分のメインステップ(?:で|に使える[:：])、?(.+)$/,
        );
        if (b) {
          // 先頭の条件節「(cond)(の時|時|なら)、」を剥がす (parseCondが成立する時のみ)
          const cm = b[1].match(/^(.+?)(?:の時|時|なら)、(.+)$/);
          if (cm && parseCond(cm[1])) {
            condText = cm[1];
            body = cm[2];
          } else {
            body = b[1];
          }
        }
      }
      if (body !== null) {
        const cond = condText ? parseCond(condText) : undefined;
        const program = parseEffect(body);
        if ((!condText || cond) && program && program.ops.length > 0) {
          (g.activated ??= []).push({
            ops: program.ops,
            cond: cond ?? undefined,
            timesPerTurn,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // 「自分のリセットステップで、(条件の時、)このホロメンはバックポジションに移動してもお休みしない」
    {
      const rm = sec.match(
        /^自分のリセットステップで、(?:(.+?)の時、)?このホロメンはバックポジションに移動してもお休みしない。?$/,
      );
      if (rm) {
        const cond = rm[1] ? parseCond(rm[1]) : undefined;
        if (!rm[1] || cond) {
          g.noRestOnMove = { cond: cond ?? undefined };
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // 味方が相手からダメージを受ける時、サイコロを振って軽減できる (板面リアクティブ)
    // 「(このホロメン以外の)自分の(F)が相手からダメージを受ける時、サイコロを1回振れる：奇/偶で軽減/無効」
    {
      const m = sec.match(
        /^(このホロメン以外の)?(自分の.+?)が相手からダメージを受ける時、サイコロを1回振れる[:：](.+)$/,
      );
      if (m) {
        const filter = parseSubjectFilter(m[2]);
        const branchText = m[3];
        const def: NonNullable<GiftDef["allyDamageDiceReduce"]> = {
          excludeSelf: m[1] ? true : undefined,
          filter: filter ?? undefined,
          positions,
          timesPerTurn,
        };
        let ok = filter !== null;
        if (/奇数(?:の時|なら)、そのダメージを受けない/.test(branchText)) {
          def.oddNegate = true;
        } else {
          const odd = branchText.match(
            /奇数(?:の時|なら)、(?:その)?ホロメン(?:1人)?が受けるダメージ-(\d+)/,
          );
          if (odd) def.oddReduce = num(odd[1]);
          else ok = false;
        }
        const even = branchText.match(
          /偶数(?:の時|なら)、(?:その)?ホロメン(?:1人)?が受けるダメージ-(\d+)/,
        );
        if (even) def.evenReduce = num(even[1]);
        if (ok && (def.oddNegate || def.oddReduce !== undefined)) {
          g.allyDamageDiceReduce = def;
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // 「(Debut|1st|2nd)ホロメンからBloomしているこのホロメンが〜」の発火条件プレフィックスを剥がす
    let selfBloomedFrom: "Debut" | "1st" | "2nd" | undefined;
    {
      const bf = sec.match(
        /^(Debut|1st|2nd)ホロメンからBloomしている(?=このホロメンが)/,
      );
      if (bf) {
        selfBloomedFrom = bf[1] as "Debut" | "1st" | "2nd";
        sec = sec.slice(bf[0].length);
      }
    }

    // --- トリガー ---
    let matched = false;
    for (const [re, event] of GIFT_TRIGGER_PATS) {
      const m = sec.match(re);
      if (!m) continue;
      const body = sec.slice(m[0].length);
      const program = parseEffect(body);
      if (program && program.ops.length > 0) {
        // Q515: ダウン時の任意アーカイブを条件に使うギフトは全枚数の支払いが必要。
        // アーツ内で可能な枚数をアーカイブする任意処理 (Q529) とは区別する。
        const archiveCost = body.match(
          /^自分のデッキの上から(\d+)枚をアーカイブできる。アーカイブしたなら、/,
        );
        if (event === "downed" && archiveCost) {
          program.ops = [
            {
              t: "optionalCost",
              cost: [{ t: "millDeck", n: num(archiveCost[1]) }],
              then: program.ops.slice(1),
              label: `デッキの上から${archiveCost[1]}枚をアーカイブ`,
            },
          ];
        }
        // 文中のポジション指定 (「センターポジションでアーツを使った時」=保持者側 /
        // 「相手のセンターホロメンをダウンさせた時」=ダウンした側) を落とさない
        const sentencePositions: TriggerDef["positions"] | undefined =
          event === "artUsed" && m[1]
            ? m[1].includes("コラボ")
              ? ["center", "collab"]
              : ["center"]
            : undefined;
        const downedPos: TriggerDef["downedPos"] =
          event === "downedOpponent" && m[1]
            ? m[1] === "コラボ"
              ? "collab"
              : "center"
            : undefined;
        g.triggers.push({
          event,
          ops: program.ops,
          timesPerTurn,
          oppTurnOnly,
          selfTurnOnly: selfTurnOnly || undefined,
          positions: positions ?? sentencePositions,
          ...((event === "spSkillUsed" || event === "oshiSkillUsed") && m[1]
            ? { skillName: m[1] }
            : {}),
          downedPos,
          selfBloomedFrom,
        });
      } else {
        g.full = false;
      }
      matched = true;
      break;
    }
    if (matched) continue;

    // --- 自分のエールがアーカイブに置かれた時 (板面トリガー。保持者が発揮) ---
    {
      const m = sec.match(/^自分のエールがアーカイブに置かれた時、(.+)$/);
      if (m) {
        const program = parseEffect(m[1]);
        if (program && program.ops.length > 0) {
          g.triggers.push({
            event: "yellArchived",
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 自分の(subjectFilter)がステージからデッキに戻った時 (板面トリガー) ---
    {
      const m = sec.match(/^(自分の.+?)がステージからデッキに戻った時、(.+)$/);
      if (m) {
        const subjectFilter = parseSubjectFilter(m[1]);
        const program = parseEffect(m[2]);
        if (subjectFilter !== null && program && program.ops.length > 0) {
          g.triggers.push({
            event: "returnedToDeck",
            subjectFilter: subjectFilter ?? undefined,
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 自分のパフォーマンスステップが開始する時 (保持者=ターンプレイヤーの板面トリガー) ---
    {
      const m = sec.match(/^自分のパフォーマンスステップが開始する時、(.+)$/);
      if (m) {
        const program = parseEffect(m[1]);
        if (program && program.ops.length > 0) {
          g.triggers.push({
            event: "selfPerfStepStart",
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly: oppTurnOnly || undefined,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 相手のパフォーマンスステップが開始する時 (保持者=防御側の板面トリガー) ---
    {
      const m = sec.match(
        /^相手のパフォーマンスステップが開始する時(?:に使える：|、)(.+)$/,
      );
      if (m) {
        const program = parseEffect(m[1]);
        if (program && program.ops.length > 0) {
          g.triggers.push({
            event: "oppPerfStepStart",
            optional: /時に使える：/.test(sec) || undefined,
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly: oppTurnOnly || undefined,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 相手のパフォーマンスステップが終了する時 (保持者=防御側の板面トリガー) ---
    {
      const m = sec.match(
        /^相手のパフォーマンスステップが終了する時、(そのパフォーマンスステップに自分のライフが減っていたら、|このホロメンのHPが減っていないなら、)?(.+)$/,
      );
      if (m) {
        const program = parseEffect(m[2]);
        if (program && program.ops.length > 0) {
          const perfCond: TriggerDef["perfCond"] = m[1]
            ? m[1].startsWith("そのパフォーマンスステップに自分のライフ")
              ? "selfLifeReduced"
              : "selfHpNotReduced"
            : undefined;
          g.triggers.push({
            event: "oppPerfStepEnd",
            ops: program.ops,
            perfCond,
            timesPerTurn,
            oppTurnOnly: oppTurnOnly || undefined,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 味方ダウン時トリガー (主語が自分の他ホロメン) ---
    {
      const m = sec.match(
        /^(このホロメン以外の)?(自分の.+?)(?:ホロメン)?がダウンした時(?:に使える[:：]|、)(.+)$/,
      );
      if (m) {
        const subjectFilter = parseSubjectFilter(m[2]);
        const program = parseEffect(m[3]);
        if (subjectFilter !== null && program && program.ops.length > 0) {
          g.triggers.push({
            event: "allyDowned",
            optional: /時に使える[:：]/.test(sec) || undefined,
            subjectFilter: subjectFilter ?? undefined,
            // 「このホロメン以外の」が無ければ、保持者自身のダウンでも誘発する
            // (公式Q451/Q452/Q570)
            excludeSelf: m[1] ? true : undefined,
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 味方登場時トリガー ---
    {
      const m = sec.match(/^(自分の.+?)(?:ホロメン)?がステージに出た時、(.+)$/);
      if (m) {
        const subjectFilter = parseSubjectFilter(m[1]);
        const program = parseEffect(m[2]);
        if (subjectFilter !== null && program && program.ops.length > 0) {
          g.triggers.push({
            event: "allyPlayed",
            subjectFilter: subjectFilter ?? undefined,
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 味方アーツ使用時トリガー (主語が自分のホロメン) ---
    {
      const m = sec.match(/^(自分の.+?)(?:ホロメン)?がアーツを使った時、(.+)$/);
      if (m) {
        const subjectFilter = parseSubjectFilter(m[1] + "ホロメン");
        const program = parseEffect(m[2]);
        if (subjectFilter !== null && program && program.ops.length > 0) {
          g.triggers.push({
            event: "allyArtUsed",
            subjectFilter: subjectFilter ?? undefined,
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 味方被弾時トリガー (主語が自分のホロメン。「このホロメン」自身は self damaged 扱い) ---
    {
      const m = sec.match(
        /^(自分の.+?)(?:ホロメン)?が(アーツ)?ダメージを受けた時、(.+)$/,
      );
      if (m) {
        const subjectFilter = parseSubjectFilter(m[1] + "ホロメン");
        const program = parseEffect(m[3]);
        if (subjectFilter !== null && program && program.ops.length > 0) {
          g.triggers.push({
            event: "allyDamaged",
            subjectFilter: subjectFilter ?? undefined,
            artDamageOnly: m[2] ? true : undefined,
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- このホロメンに〈X〉(付与サポート)が付いた時トリガー ---
    {
      const m = sec.match(/^このホロメンに((?:〈[^〉]+〉)+)が付いた時、(.+)$/);
      if (m) {
        const program = parseEffect(m[2]);
        if (program && program.ops.length > 0) {
          g.triggers.push({
            event: "supportAttached",
            attachedSupportNames: parseNames(m[1]),
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- 味方コラボ時トリガー (主語が自分のホロメン。「このホロメン」自身は self collabed 扱い) ---
    {
      const m = sec.match(/^(自分の.+?)(?:ホロメン)?がコラボした時、(.+)$/);
      if (m) {
        const subjectFilter = parseSubjectFilter(m[1]);
        const program = parseEffect(m[2]);
        if (subjectFilter !== null && program && program.ops.length > 0) {
          g.triggers.push({
            event: "allyCollabed",
            subjectFilter: subjectFilter ?? undefined,
            ops: program.ops,
            timesPerTurn,
            oppTurnOnly,
            selfTurnOnly: selfTurnOnly || undefined,
            positions,
          });
        } else {
          g.full = false;
        }
        continue;
      }
    }

    // --- パッシブ ---
    let m = sec.match(
      /^このホロメンのエール(\d+)枚につき、このホロメンのHP\+(\d+)。?$/,
    );
    if (m && num(m[1]) === 1) {
      g.hpPerYell = num(m[2]);
      continue;
    }
    m = sec.match(
      /^このホロメンに重なっているホロメン(\d+)枚につき、このホロメンのHP\+(\d+)。?$/,
    );
    if (m && num(m[1]) === 1) {
      g.hpPerStacked = num(m[2]);
      continue;
    }
    m = sec.match(/^(.+?)(?:の間|間|なら)、このホロメンのHP\+(\d+)。?$/);
    if (m) {
      const cond = parseCond(m[1]);
      if (cond) {
        g.selfHpPlus.push({ value: num(m[2]), cond });
        continue;
      }
      g.full = false;
      continue;
    }
    // 被ダメージ修正オーラ (装着名+前列): (条件なら、)自分の〈X〉が付いている[センターホロメンとコラボホロメン]が受ける(アーツ)ダメージ±Y
    m = sec.match(
      /^(?:(自分の推しホロメンが(?:〈[^〉]+〉)+)なら、)?自分の((?:〈[^〉]+〉)+)が付いている\[センターホロメンとコラボホロメン\]が受ける(アーツ)?ダメージ([+-]\d+)。?$/,
    );
    if (m) {
      const cond = m[1] ? parseCond(m[1]) : undefined;
      if (m[1] && !cond) {
        g.full = false;
        continue;
      }
      const base = {
        delta: num(m[4]),
        filter: { hasAttachedNames: parseNames(m[2]) } as TargetFilter,
        artOnly: m[3] ? true : undefined,
        cond: cond ?? undefined,
        positions,
      };
      g.damageAuras.push({ ...base, targetPos: "center" });
      g.damageAuras.push({ ...base, targetPos: "collab" });
      continue;
    }
    // 被ダメージ修正オーラ: 自分の(F)(センター|コラボ)?ホロメンが(センターポジションで)?受けるダメージ±X
    m = sec.match(
      /^(自分の.+?)(センターホロメン|コラボホロメン|ホロメン)が(センターポジションで|コラボポジションで)?受けるダメージ([+-]\d+)。?$/,
    );
    if (m) {
      const f = parseSubjectFilter(m[1] + "ホロメン");
      if (f !== null) {
        g.damageAuras.push({
          delta: num(m[4]),
          filter: f,
          targetPos:
            m[2] === "センターホロメン" || m[3] === "センターポジションで"
              ? "center"
              : m[2] === "コラボホロメン" || m[3] === "コラボポジションで"
                ? "collab"
                : undefined,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    // HP保護 (相手のメインステップの間)
    if (
      /^相手のメインステップの間、このホロメンのHPは相手の能力で減らず、変動しない。?$/.test(
        sec,
      )
    ) {
      g.protection = { positions };
      continue;
    }
    // 味方へのHP保護オーラ (相手のメインステップの間、自分の(F)のHPは相手の能力で減らず、変動しない)
    m = sec.match(
      /^相手のメインステップの間、自分の(?:(バック|センター|コラボ)(?:ポジション|ホロメン)の)?(.+?)(?:全員)?のHPは相手の能力で減らず、変動しない。?$/,
    );
    if (m) {
      const f = parseTargetFilterMods(m[2].replace(/ホロメン$/, ""));
      if (f !== null) {
        const pm = {
          センター: "center",
          コラボ: "collab",
          バック: "back",
        } as const;
        (g.protectionAuras ??= []).push({
          filter: f ?? undefined,
          targetPos: m[1]
            ? pm[m[1] as "センター" | "コラボ" | "バック"]
            : undefined,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    // 付与枚数の上限緩和
    m = sec.match(
      /^このホロメンは、(異なるカード名の)?(マスコット|ツール|ファン)を(\d+)枚まで付けられる。?$/,
    );
    if (m) {
      const kind = m[2] as "マスコット" | "ツール" | "ファン";
      (g.supportLimits ??= {})[kind] = parseInt(m[3], 10);
      if (m[1]) (g.supportLimitDistinctNames ??= []).push(kind);
      continue;
    }
    // ダウン時、アーカイブのかわりに手札に戻せる
    {
      const dm = sec.match(
        /^このホロメンがダウンした時、このホロメンをアーカイブするかわりに手札に戻せる。?$/,
      );
      if (dm) {
        g.downToHand = { oppTurnOnly: oppTurnOnly || undefined };
        continue;
      }
    }
    // 挑発: 相手のアーツはコラボホロメンしか対象にできない (「〜がいる間、」「〜がいるなら、」の条件付き可)
    m = sec.match(
      /^(?:(.+?)がいる(?:間|なら)、)?相手のホロメンのアーツは、自分のコラボホロメンしか対象にできない。ただし、特殊ダメージは除く。?$/,
    );
    if (m) {
      let cond: Cond | undefined;
      if (m[1]) {
        const parsed = parseCond(m[1] + "がいる");
        if (!parsed) {
          g.full = false;
          continue;
        }
        cond = parsed;
      }
      g.taunt = { cond, positions };
      continue;
    }
    // このホロメンのアーツが相手のバックホロメンも対象にできる (条件/フィルタ付き可)
    m = sec.match(
      /^(?:(.+?)なら、)?このホロメンのアーツは、相手の(.*?)バックホロメンも対象にできる。?$/,
    );
    if (m) {
      const cond = m[1] ? parseCond(m[1]) : undefined;
      const f = parseTargetFilterMods(m[2].replace(/ホロメン$/, ""));
      if ((!m[1] || cond) && f !== null) {
        g.selfArtTargetExtend = {
          cond: cond ?? undefined,
          filter: f ?? undefined,
        };
        continue;
      }
      g.full = false;
      continue;
    }
    // 相手のセンターホロメンのアーツに必要な無色+X (妨害オーラ。条件付き可)
    m = sec.match(
      /^(?:(.+?)なら、)?相手のセンターホロメンのアーツに必要な無色\+(\d+)。?$/,
    );
    if (m) {
      const cond = m[1] ? parseCond(m[1]) : undefined;
      if (!m[1] || cond) {
        g.oppCenterArtCostPlus = {
          delta: num(m[2]),
          cond: cond ?? undefined,
          positions,
        };
      } else {
        g.full = false;
      }
      continue;
    }
    m = sec.match(
      /^このホロメンが相手のホロメンから受けるアーツダメージ([+-]\d+)。?$/,
    );
    if (m) {
      g.artDamageTaken = num(m[1]);
      continue;
    }
    m = sec.match(/^このホロメンのアーツ\+(\d+)。?$/);
    if (m) {
      g.selfArtPlus.push({ value: num(m[1]), positions });
      continue;
    }
    m = sec.match(/^(.+?)(?:の間|間|なら)、このホロメンのアーツ\+(\d+)。?$/);
    if (m) {
      const cond = parseCond(m[1]);
      if (cond) {
        g.selfArtPlus.push({ value: num(m[2]), cond, positions });
        continue;
      }
      g.full = false;
      continue;
    }
    // 味方アーツコスト軽減オーラ: 「自分の〈X〉が付いている(センター|コラボ)ホロメンの〈Y〉のアーツに必要な{色/無色}-Z」
    m = sec.match(
      new RegExp(
        `^自分の((?:〈[^〉]+〉)+)が付いている(センター|コラボ)?ホロメンの((?:〈[^〉]+〉)+)のアーツに必要な(無色|${COLOR_RE})-(\\d+)。?$`,
      ),
    );
    if (m) {
      (g.artCostAuras ??= []).push({
        color: m[4] === "無色" ? undefined : (m[4] as Color),
        delta: num(m[6]),
        filter: {
          names: parseNames(m[3]),
          hasAttachedNames: parseNames(m[1]),
        },
        targetPos:
          m[2] === "センター"
            ? "center"
            : m[2] === "コラボ"
              ? "collab"
              : undefined,
        positions,
      });
      continue;
    }
    // 自身アーツコスト軽減 (任意で条件付き): 「(〜なら、)このホロメンのアーツ(「名」)?に必要な{色/無色}-X」
    m = sec.match(
      new RegExp(
        `^(?:(.+?)(?:の間|間|なら)、)?このホロメンのアーツ(?:「[^」]+」)?に必要な(無色|${COLOR_RE})-(\\d+)。?$`,
      ),
    );
    if (m) {
      const cond = m[1] ? parseCond(m[1]) : undefined;
      if (!m[1] || cond) {
        (g.selfArtCostMods ??= []).push({
          color: m[2] === "無色" ? undefined : (m[2] as Color),
          delta: num(m[4]),
          cond: cond ?? undefined,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    m = sec.match(/^自分のコラボポジションの(.+?)のアーツ\+(\d+)。?$/);
    if (m) {
      const f = parseSubjectFilter("自分の" + m[1]);
      if (f !== null) {
        g.auras.push({
          value: num(m[2]),
          filter: f,
          targetCollabOnly: true,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    // センター/コラボ限定オーラ (任意で保持者条件・対象名称付き):
    //  「(〜が付いている間、)自分の(#T/付与)センターホロメン(の〈N〉)?のアーツ+X」
    m = sec.match(
      /^(?:(.+?)(?:の間|間|なら)、)?自分の(.*?)(センター|コラボ)ホロメン(?:の((?:〈[^〉]+〉)+))?のアーツ\+(\d+)。?$/,
    );
    if (m) {
      const cond = m[1] ? parseCond(m[1]) : undefined;
      const preFilter = parseAuraPrefixFilter(m[2]);
      if ((!m[1] || cond) && preFilter !== null) {
        const filter: TargetFilter = { ...preFilter };
        if (m[4]) filter.names = parseNames(m[4]);
        g.auras.push({
          value: num(m[5]),
          filter: Object.keys(filter).length > 0 ? filter : undefined,
          ...(m[3] === "センター"
            ? { targetCenterOnly: true }
            : { targetCollabOnly: true }),
          cond: cond ?? undefined,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    m = sec.match(
      /^自分のステージのこのホロメン以外の(.+?)全員のアーツ\+(\d+)。?$/,
    );
    if (m) {
      const f = parseSubjectFilter("自分の" + m[1]);
      if (f !== null) {
        g.auras.push({
          value: num(m[2]),
          filter: f,
          excludeSelf: true,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    // 全員オーラ (自身含む): 自分の(ステージの)(F)ホロメン全員のアーツ+X
    m = sec.match(
      /^自分の(?:ステージの)?(.+?)(?:ホロメン)?全員のアーツ\+(\d+)。?$/,
    );
    if (m) {
      const f = parseSubjectFilter("自分の" + m[1]);
      if (f !== null) {
        g.auras.push({ value: num(m[2]), filter: f, positions });
        continue;
      }
      g.full = false;
      continue;
    }
    // 自身+コラボの被ダメージ修正: このホロメンと自分のコラボホロメンが受けるダメージ-X
    m = sec.match(
      /^このホロメンと自分のコラボホロメンが受けるダメージ([+-]\d+)。?$/,
    );
    if (m) {
      g.damageAuras.push({ delta: num(m[1]), selfOnly: true, positions });
      g.damageAuras.push({ delta: num(m[1]), targetPos: "collab", positions });
      continue;
    }
    // このホロメン自身の被ダメージ修正: このホロメンが(相手の(F)から)?受ける(アーツ)?ダメージ-X
    m = sec.match(
      /^このホロメンが(?:相手の(.+?)から)?受ける(アーツ)?ダメージ([+-]\d+)。?$/,
    );
    if (m) {
      const aura: (typeof g.damageAuras)[number] = {
        delta: num(m[3]),
        selfOnly: true,
        positions,
      };
      if (m[2]) aura.artOnly = true;
      if (m[1]) {
        const sf = parseTargetFilterMods(m[1].replace(/ホロメン$/, ""));
        if (sf === null) {
          g.full = false;
          continue;
        }
        aura.fromSource = sf ?? undefined;
      }
      g.damageAuras.push(aura);
      continue;
    }
    // このホロメン自身が相手からダメージを受けない ([バック限定]白上フブキ 等)
    m = sec.match(
      /^(?:\[(センター|コラボ|バック)ポジション限定\])?このホロメンは相手からダメージを受けない。?$/,
    );
    if (m) {
      const pm = {
        センター: "center",
        コラボ: "collab",
        バック: "back",
      } as const;
      g.noDamageSelf = {
        positions: m[1]
          ? [pm[m[1] as "センター" | "コラボ" | "バック"]]
          : positions,
      };
      continue;
    }
    // 味方への特殊ダメージ免疫オーラ: 自分の(バック/センター/コラボポジションの)?(F)全員は相手から特殊ダメージを受けない
    m = sec.match(
      /^自分の(?:(バック|センター|コラボ)ポジションの)?(.+?)全員は相手から特殊ダメージを受けない。?$/,
    );
    if (m) {
      const f = parseTargetFilterMods(m[2].replace(/ホロメン$/, ""));
      if (f !== null) {
        const pm = {
          センター: "center",
          コラボ: "collab",
          バック: "back",
        } as const;
        (g.specialImmuneAuras ??= []).push({
          filter: f ?? undefined,
          targetPos: m[1]
            ? pm[m[1] as "センター" | "コラボ" | "バック"]
            : undefined,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    // 味方へのアーツダメージ免疫オーラ: (条件なら、)自分の(バック/センター/コラボポジションの)?(F)全員は相手からアーツダメージを受けない
    m = sec.match(
      /^(?:(.+?)なら、)?自分の(?:(バック|センター|コラボ)ポジションの)?(.+?)全員は相手からアーツダメージを受けない。?$/,
    );
    if (m) {
      const cond = m[1] ? parseCond(m[1]) : undefined;
      const f = parseTargetFilterMods(m[3].replace(/ホロメン$/, ""));
      if ((!m[1] || cond) && f !== null) {
        const pm = {
          センター: "center",
          コラボ: "collab",
          バック: "back",
        } as const;
        (g.artImmuneAuras ??= []).push({
          filter: f ?? undefined,
          targetPos: m[2]
            ? pm[m[2] as "センター" | "コラボ" | "バック"]
            : undefined,
          cond: cond ?? undefined,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    // 味方が与える特殊ダメージ+X オーラ: 自分の(推しホロメンの〈X〉と)?(ステージの)?〈X〉全員が相手の(センター)?ホロメンに与える特殊ダメージ+Y
    m = sec.match(
      /^自分の(?:推しホロメンの(?:〈[^〉]+〉)+と自分の)?(?:ステージの)?((?:〈[^〉]+〉)+)全員が、?相手の(センター)?ホロメンに与える特殊ダメージ\+(\d+)。?$/,
    );
    if (m) {
      const f = parseTargetFilterMods(m[1]);
      if (f !== null) {
        (g.specialDealtAuras ??= []).push({
          value: num(m[3]),
          filter: f ?? undefined,
          centerOnly: m[2] ? true : undefined,
          includeOshi: /^自分の推しホロメンの/.test(sec) ? true : undefined,
          positions,
        });
        continue;
      }
      g.full = false;
      continue;
    }
    g.full = false;
  }
  if (giftTimesLimit !== undefined)
    for (const t of g.triggers)
      if (t.timesPerTurn === undefined) t.timesPerTurn = giftTimesLimit;
  return g;
}
