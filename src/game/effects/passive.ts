// カード本文の解析：passive。
import type { SupportCard, Color } from "../../data/types";
import { parseEffect } from "./compound";
import { parseCond } from "./conditions";
import { parseNames, num, normalizeText, COLOR_RE } from "./normalization";
import type {
  PassiveCondition,
  TriggerDef,
  TriggerEvent,
  TargetFilter,
  PassiveBonus,
} from "./types";

// ============================================================
// 付与型サポートの常時効果解析
// ============================================================

/** ◆条件部の解析 */
function parsePassiveCondition(text: string): PassiveCondition | null {
  text = text.trim();
  const cond: PassiveCondition = {};
  const names = parseNames(text);
  if (names.length > 0) cond.names = names;
  // 「#Tを持つ1st以上のホロメン」のように前置修飾の後に来る場合もある
  let m = text.match(/(1st|2nd)以上の/);
  if (m) cond.minBloom = m[1] as "1st" | "2nd";
  // 「2ndの〈X〉」は"以上"が付かない = そのレベルちょうどの指定
  // (〈角巻わための〉ハンマー hBP07-102 / Thorn hBP07-104)
  if (!cond.minBloom) {
    m = text.match(/(?:^|を持つ)(Debut|1st|2nd|Spot)の(?=〈|ホロメン)/);
    if (m) cond.bloomLevels = [m[1] as "Debut" | "1st" | "2nd" | "Spot"];
  }
  if (/^Buzzホロメン$/.test(text)) cond.buzz = true;
  m = text.match(/^#([^、を]+?)を持つ/);
  if (m) cond.tag = m[1];
  m = text.match(
    /^(Debut|1st|2nd|Spot)ホロメンか(Debut|1st|2nd|Spot)ホロメン$/,
  );
  if (m)
    cond.bloomLevels = [m[1], m[2]] as ("Debut" | "1st" | "2nd" | "Spot")[];
  if (
    !cond.names &&
    !cond.minBloom &&
    !cond.buzz &&
    !cond.tag &&
    !cond.bloomLevels
  )
    return null;
  return cond;
}

/** トリガーセクションの解析 */
function parseTriggerSection(
  sec: string,
  kindWord: string,
  isCond: boolean,
): TriggerDef | null {
  let timesPerTurn: number | undefined;
  let positions: ("center" | "collab")[] | undefined;
  let oppTurnOnly = false;
  sec = sec
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
  const m = sec.match(/^相手のターンで、/);
  if (m) {
    oppTurnOnly = true;
    sec = sec.replace(m[0], "");
  }

  // 付与先ホロメンの主語表記。◆条件部では「このホロメン」と略される場合がある
  const H = `(?:この${kindWord}が付いているホロメン|このホロメン)`;
  const pats: [RegExp, TriggerEvent][] = [
    [
      new RegExp(
        `^${H}が(センターポジション(?:かコラボポジション)?で)?アーツを使った時、`,
      ),
      "artUsed",
    ],
    [
      new RegExp(`^${H}が相手の(センター|コラボ)?ホロメンをダウンさせた時、`),
      "downedOpponent",
    ],
    [new RegExp(`^${H}がダメージを受けた時、`), "damaged"],
    [new RegExp(`^${H}が(?:相手から)?ダメージを受ける時、`), "incomingDamage"],
    [new RegExp(`^${H}がダウンした時、`), "downed"],
    [new RegExp(`^相手のバックホロメンがダウンした時、`), "oppBackDowned"],
    [
      new RegExp(`^${H}が相手のホロメンに特殊ダメージを与えた時、`),
      "dealtSpecial",
    ],
    [new RegExp(`^${H}にエールが付いた時、`), "yellAttached"],
    [
      new RegExp(
        `^この${kindWord}を(?:ホロメンに手札(?:かアーカイブ)?から|手札(?:かアーカイブ)?から(?:ホロメンに|(?:1st|2nd)以上の(?:〈[^〉]+〉)+に|(?:〈[^〉]+〉)+に)?)付けた時、`,
      ),
      "attachedFromHand",
    ],
    [new RegExp(`^${H}がコラボした時、`), "collabed"],
    [new RegExp(`^自分の能力で、${H}が回復した時、`), "healed"],
    [
      new RegExp(`^${H}(?:のBloomレベルが上がった|がBloomした)時、`),
      "bloomLevelUp",
    ],
  ];
  for (const [re, event] of pats) {
    const mm = sec.match(re);
    if (!mm) continue;
    // 「手札から(1st以上の)〈X〉に付けた時」の付与先条件
    let wearerFilter: TargetFilter | undefined;
    if (event === "attachedFromHand") {
      const wm = mm[0].match(
        /から(?:(1st|2nd)以上の)?((?:〈[^〉]+〉)+)に付けた時、$/,
      );
      if (wm) {
        wearerFilter = { names: parseNames(wm[2]) };
        if (wm[1]) wearerFilter.minBloom = wm[1] as "1st" | "2nd";
      }
    }
    // 効果文中の「この(ツール)が付いている/いたホロメン」は「このホロメン」に正規化する
    const rest = sec
      .slice(mm[0].length)
      .replace(
        new RegExp(`この${kindWord}が付いてい(?:る|た)ホロメン`, "g"),
        "このホロメン",
      );
    const program = parseEffect(rest);
    if (!program || program.ops.length === 0) return null;
    // 文中のポジション指定 (「センターポジションでアーツを使った時」=装着先 /
    // 「相手のセンターホロメンをダウンさせた時」=ダウンした側) を落とさない
    const sentencePositions: TriggerDef["positions"] | undefined =
      event === "artUsed" && mm[1]
        ? mm[1].includes("コラボ")
          ? ["center", "collab"]
          : ["center"]
        : undefined;
    const downedPos: TriggerDef["downedPos"] =
      event === "downedOpponent" && mm[1]
        ? mm[1] === "コラボ"
          ? "collab"
          : "center"
        : undefined;
    return {
      event,
      ops: program.ops,
      timesPerTurn,
      oppTurnOnly,
      positions: positions ?? sentencePositions,
      downedPos,
      requiresCond: isCond || undefined,
      wearerFilter,
      attachedFromArchive:
        event === "attachedFromHand" && mm[0].includes("アーカイブ")
          ? true
          : undefined,
    };
  }
  return null;
}

export function parsePassive(
  card: Omit<SupportCard, "imageVariants">,
): PassiveBonus {
  const b: PassiveBonus = {
    hpPlus: 0,
    artPlus: 0,
    condHpPlus: 0,
    condArtPlus: 0,
    triggers: [],
    damageTaken: [],
    condBonuses: [],
    full: true,
  };
  if (card.id === "hBP09-106" || card.id === "hBP09-107") {
    b.cond = {
      names: ["カエラ・コヴァルスキア"],
      anyOf: [{ buzz: true }, { bloomLevels: ["2nd"] }],
    };
    if (card.id === "hBP09-106") b.condHpPlus = 40;
    else b.condArtPlus = 40;
    return b;
  }
  if (card.id === "hBP09-108") {
    b.artPlus = 20;
    b.baseCondNames = ["常闇トワ"];
    b.cond = { names: ["常闇トワ"], bloomLevels: ["2nd"] };
    b.yellAlias = { from: "青", to: "紫", requiresCond: true };
    return b;
  }
  if (card.id === "hBP09-109") {
    b.artPlus = 20;
    b.baseCondNames = ["綺々羅々ヴィヴィ"];
    b.cond = { names: ["綺々羅々ヴィヴィ"], minBloom: "1st" };
    b.triggers = [
      {
        event: "selfPerfStepEnd",
        positions: ["center"],
        requiresCond: true,
        ops: [
          {
            t: "effectBloom",
            source: "hand",
            filter: { tag: "FLOW GLOW", bloomedThisTurn: true },
            rebloom: true,
            optional: true,
          },
        ],
      },
    ];
    return b;
  }
  if (card.id === "hBP09-110") {
    b.cond = { names: ["雪花ラミィ"] };
    b.triggers = [
      {
        event: "selfPerfStepEnd",
        requiresCond: true,
        subjectUsedArtThisTurn: true,
        ops: [{ t: "archiveSelfSupport" }, { t: "draw", n: 1 }],
      },
    ];
    return b;
  }
  const kindWord = card.supportType;
  let t = normalizeText(card.description);

  // 付け替え・パフォーマンス終了時ツール。付け替えは手札からの
  // 新規装着ではないため、専用Opとして扱う。
  if (card.id === "hEB01-033") {
    b.condArtPlus = 10;
    b.cond = { tag: "サマー" };
    b.triggers.push({
      event: "artUsed",
      optional: true,
      ops: [
        {
          t: "moveSelfSupport",
          targetFilter: { tag: "サマー", position: "front" },
        },
      ],
    });
    return b;
  }
  if (card.id === "hEB01-034") {
    b.artPlus = 10;
    b.cond = { names: ["博衣こより"], bloomLevels: ["2nd"] };
    b.triggers.push({
      event: "selfPerfStepEnd",
      positions: ["center", "collab"],
      requiresCond: true,
      optional: true,
      ops: [
        { t: "archiveSelfSupport" },
        { t: "special", dmg: 30, target: "oppCenter" },
      ],
    });
    return b;
  }

  // 使用条件文 (「このカードは、〜なければ使えない。」) は付与時に別途処理されるため常時効果解析からは除外
  t = t.replace(
    /このカードは、[^。]+?(?:でなければ|しなければ|になければ|なければ|にしか)使えない。?/g,
    "",
  );

  // 付け先制限
  let m = t.match(
    /この(?:ファン|ツール|マスコット)は、自分の((?:〈[^〉]+〉か?)+)だけに付けられ[^。]*。?/,
  );
  if (m) {
    b.attachOnlyNames = parseNames(m[1]);
    t = t.replace(m[0], "");
  }

  // 定型文除去
  t = t
    .replace(
      /(マスコット|ツール|ファン)は、自分のホロメン\d+人につき\d+枚だけ付けられる。?/g,
      "",
    )
    .replace(/LIMITED[:：]ターンに\d+枚しか使えない。?/g, "");

  // ◆条件付き能力追加
  m = t.match(/◆(.+?)に付いていたら能力追加\s*(.+)$/s);
  let condPart = "";
  if (m) {
    b.cond = parsePassiveCondition(m[1]) ?? undefined;
    if (!b.cond) b.full = false;
    condPart = m[2];
    t = t.replace(m[0], "");
  }

  /** ■区切りのセクション単位で常時ボーナスかトリガーとして解析する。
   * セクション全体で解析できない複文は先頭1文を切り出して再試行する */
  const process = (src: string, isCond: boolean) => {
    const queue = src
      .split("■")
      .map((x) => x.trim())
      .filter(Boolean);
    while (queue.length > 0) {
      const sec = queue.shift()!;
      // 長尾の付与サポート能力
      if (
        new RegExp(
          `^自分の\\[推しホロメンか#1期生を持つホロメン\\]の能力でサイコロを振った時、この${kindWord}をアーカイブできる：そのサイコロの目の数1つを4として扱う。?$`,
        ).test(sec)
      ) {
        b.diceOneToValue = {
          value: 4,
          includeOshi: true,
          subjectTag: "1期生",
          requiresCond: isCond || undefined,
        };
        continue;
      }
      {
        const sm = sec.match(
          new RegExp(
            `^この${kindWord}が付いているホロメンがセンターホロメンの時、自分の推しスキル「([^」]+)」の\\[ターンに(\\d+)回\\]を\\[ターンに(\\d+)回\\]に変更する。?$`,
          ),
        );
        if (sm) {
          b.oshiSkillUsesBonus = {
            skillName: sm[1],
            value: num(sm[3]) - num(sm[2]),
            positions: ["center"],
            requiresCond: isCond || undefined,
          };
          continue;
        }
      }
      {
        const hm = sec.match(
          new RegExp(
            `^\\[センターポジション・コラボポジション限定\\]\\[ターンに(\\d+)回\\]この${kindWord}が付いているホロメンの能力で自分の手札をアーカイブした時、相手のセンターホロメンかコラボホロメンに特殊ダメージ(\\d+)を与える。?$`,
          ),
        );
        if (hm) {
          b.triggers.push({
            event: "handArchived",
            timesPerTurn: num(hm[1]),
            positions: ["center", "collab"],
            requiresCond: isCond || undefined,
            ops: [{ t: "special", dmg: num(hm[2]), target: "chooseOppFront" }],
          });
          continue;
        }
      }
      {
        const em = sec.match(
          new RegExp(
            `^自分のエンドステップが開始する時、このターンに(?:この${kindWord}が付いているホロメン|このホロメン)がアーツを使っていたなら使える：自分のデッキから、#FLOW GLOWを持つ\\[DebutホロメンかSpotホロメン\\]1枚を公開し、ステージに出す。そしてデッキをシャッフルする。その後、(?:この${kindWord}|このホロメンに付いている〈([^〉]+)〉1枚)をデッキの下に戻す。?$`,
          ),
        );
        if (em && (!em[1] || em[1] === card.name)) {
          b.triggers.push({
            event: "selfEndStepStart",
            optional: true,
            requiresCond: isCond || undefined,
            subjectUsedArtThisTurn: true,
            ops: [
              {
                t: "searchDeck",
                filter: {
                  alt: [
                    { kind: "holomen", bloomLevel: "Debut", tag: "FLOW GLOW" },
                    { kind: "holomen", bloomLevel: "Spot", tag: "FLOW GLOW" },
                  ],
                },
                nMax: 1,
                dest: "stage",
              },
              { t: "selfSupportToDeckBottom" },
            ],
          });
          continue;
        }
      } // メインステップで使える起動型能力
      // 「[ターンにX回][ポジション限定]自分のメインステップで、<効果>」
      {
        let hdr = sec;
        let timesPerTurn: number | undefined;
        let positions: ("center" | "collab")[] | undefined;
        hdr = hdr.replace(/\[ターンに(\d+)回\]/, (_a, v: string) => {
          timesPerTurn = num(v);
          return "";
        });
        hdr = hdr
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
        const am = hdr.match(/^自分のメインステップで、(.+)$/);
        if (am) {
          // 「この{ツール/マスコット/ファン}が付いているホロメン」を「このホロメン」に正規化
          const body = am[1].replace(
            new RegExp(`この${kindWord}が付いているホロメン`, "g"),
            "このホロメン",
          );
          const program = parseEffect(body);
          if (program && program.ops.length > 0) {
            (b.activated ??= []).push({
              ops: program.ops,
              timesPerTurn,
              positions,
              requiresCond: isCond || undefined,
            });
            continue;
          }
          b.full = false;
          continue;
        }
      }
      // 常時ボーナス
      const hpRe = new RegExp(
        `^この${kindWord}が付いている(?:ホロメン|〈[^〉]+〉)のHP\\+(\\d+)。?$`,
      );
      let mm = sec.match(hpRe);
      if (mm) {
        if (isCond) b.condHpPlus += num(mm[1]);
        else b.hpPlus += num(mm[1]);
        continue;
      }
      const artRe = new RegExp(
        `^この${kindWord}が付いている(〈[^〉]+〉|(?:#[^、を]+?を持つ)?ホロメン)のアーツ([+-]\\d+)。?$`,
      );
      mm = sec.match(artRe);
      if (mm) {
        const names = parseNames(mm[1]);
        if (isCond) b.condArtPlus += num(mm[2]);
        else if (names.length > 0) {
          b.artPlus += num(mm[2]);
          b.baseCondNames = names;
        } else if (mm[1].startsWith("#")) {
          // タグ条件付きの基本ボーナスは条件側として扱う
          b.cond = b.cond ?? { tag: mm[1].match(/^#([^、を]+?)を持つ/)?.[1] };
          b.condArtPlus += num(mm[2]);
        } else {
          b.artPlus += num(mm[2]);
        }
        continue;
      }
      // 条件側の単純表記「このホロメンのアーツ+X」
      // ポジション限定が付く場合があるので、捨てずに condPositions へ残す
      if (isCond) {
        mm = sec.match(
          /^(\[(?:センターポジション・コラボポジション|センターポジション|コラボポジション)限定\])?このホロメンのアーツ\+(\d+)。?$/,
        );
        if (mm) {
          if (mm[1])
            b.condPositions = mm[1].includes("・")
              ? ["center", "collab"]
              : mm[1].includes("センター")
                ? ["center"]
                : ["collab"];
          b.condArtPlus += num(mm[2]);
          continue;
        }
      }
      // 受けるダメージ±X
      mm = sec.match(
        new RegExp(
          `^この${kindWord}が付いている(?:#([^、を]+?)を持たない)?ホロメンが(センターポジションかコラボポジションで|センターポジションで|コラボポジションで)?受けるダメージ([+-]\\d+)。?$`,
        ),
      );
      if (mm) {
        b.damageTaken.push({
          delta: num(mm[3]),
          excludeTag: mm[1] || undefined,
          positions: mm[2]
            ? mm[2].startsWith("センターポジションか")
              ? ["center", "collab"]
              : mm[2].startsWith("センター")
                ? ["center"]
                : ["collab"]
            : undefined,
          requiresCond: isCond || undefined,
        });
        continue;
      }
      // 特殊ダメージ無効
      if (
        new RegExp(
          `^この${kindWord}が付いているホロメンは相手から特殊ダメージを受けない。?$`,
        ).test(sec)
      ) {
        b.noSpecialDamage = { requiresCond: isCond || undefined };
        continue;
      }
      // 与える特殊ダメージ+X
      mm = sec.match(
        new RegExp(
          `^この${kindWord}が付いているホロメンが、?相手の(センター)?ホロメン(?:\\d+人)?に与える特殊ダメージ\\+(\\d+)。?$`,
        ),
      );
      if (mm) {
        b.specialDealtPlus = {
          value: num(mm[2]),
          centerOnly: mm[1] ? true : undefined,
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // 装着者のバトンタッチに必要な◇±X
      mm = sec.match(
        new RegExp(
          `^この${kindWord}が付いているホロメンのバトンタッチに必要な(?:◇|無色)([+-]\\d+)。?$`,
        ),
      );
      if (mm) {
        b.batonSelf = { delta: num(mm[1]), requiresCond: isCond || undefined };
        continue;
      }
      // 相手のセンターホロメンのバトンタッチに必要な無色+X
      mm = sec.match(
        /^(\[センターポジション・コラボポジション限定\]|\[センターポジション限定\]|\[コラボポジション限定\])?相手のセンターホロメンのバトンタッチに必要な(?:◇|無色)\+(\d+)。?$/,
      );
      if (mm) {
        b.oppCenterBaton = {
          delta: num(mm[2]),
          positions: mm[1]
            ? mm[1].includes("・")
              ? ["center", "collab"]
              : mm[1].includes("センター")
                ? ["center"]
                : ["collab"]
            : undefined,
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // 相手からダメージを受けない
      mm = sec.match(
        new RegExp(
          `^(\\[バックポジション限定\\])?この${kindWord}が付いているホロメンは相手からダメージを受けない。?$`,
        ),
      );
      if (mm) {
        b.noDamage = {
          positions: mm[1] ? ["back"] : undefined,
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // 装着者のアーツダメージは軽減されない
      if (
        new RegExp(
          `^(?:このホロメン|この${kindWord}が付いているホロメン)のアーツダメージは軽減されない。?$`,
        ).test(sec)
      ) {
        b.artNoReduce = { requiresCond: isCond || undefined };
        continue;
      }
      // 相手のセンター/コラボホロメンを全色扱い
      mm = sec.match(
        /^(\[センターポジション限定\])?相手のセンターホロメンとコラボホロメンは、すべての色を持つホロメンとして扱う。?$/,
      );
      if (mm) {
        b.oppFrontAllColors = {
          positions: mm[1] ? ["center"] : undefined,
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // 自分のステージの〈X〉1枚につき、アーツ+Y
      mm = sec.match(
        new RegExp(
          `^自分のステージの((?:〈[^〉]+〉)+)1枚につき、この${kindWord}が付いているホロメンのアーツ\\+(\\d+)。?$`,
        ),
      );
      if (mm) {
        b.artPlusPerStage = {
          names: parseNames(mm[1]),
          value: num(mm[2]),
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // アーツに必要な無色-X
      mm = sec.match(/^このホロメンのアーツに必要な(?:◇|無色)-(\d+)。?$/);
      if (mm) {
        b.artCostless = {
          value: num(mm[1]),
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // アーツに必要なエールの色すべてを無色/◇にする
      if (
        new RegExp(
          `^この${kindWord}が付いているホロメンのアーツに必要なエールの色すべてを(?:無色|◇)にする。?$`,
        ).test(sec)
      ) {
        b.allColorless = { requiresCond: isCond || undefined };
        continue;
      }
      // アーツを使う時、エールとして扱う (推しホロメン条件付きあり)
      mm = sec.match(
        new RegExp(
          `^この${kindWord}が付いているホロメンがアーツを使う時、(?:自分の推しホロメンが((?:〈[^〉]+〉)+)なら、)?この${kindWord}を(白|緑|赤|青|紫|黄)エールとしても扱う。?$`,
        ),
      );
      if (mm) {
        b.asYell = {
          color: mm[2] as Color,
          oshiNames: mm[1] ? parseNames(mm[1]) : undefined,
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // HP保護 (相手のメインステップの間)
      mm = sec.match(
        new RegExp(
          `^相手のメインステップの間、この${kindWord}が付いているホロメンのHPは相手の能力で減らず、変動しない。?$`,
        ),
      );
      if (mm) {
        b.protection = { requiresCond: isCond || undefined };
        continue;
      }
      // 実行時条件付きの常時ボーナス「〜なら/〜間、このホロメンのアーツ/HP+X」
      mm = sec.match(
        new RegExp(
          `^(.+?)(?:なら|間)、(?:この${kindWord}が付いているホロメン|このホロメン)の(アーツ|HP)\\+(\\d+)。?$`,
        ),
      );
      if (mm) {
        // 条件文中の「このツールが付いているホロメン」を「このホロメン」に正規化
        const condText = mm[1].replace(
          new RegExp(`この${kindWord}が付いているホロメン`, "g"),
          "このホロメン",
        );
        const cond = parseCond(condText);
        if (cond) {
          b.condBonuses.push({
            [mm[2] === "アーツ" ? "artPlus" : "hpPlus"]: num(mm[3]),
            cond,
            requiresCond: isCond || undefined,
          });
          continue;
        }
      }
      // 装着者が能力でサイコロを振った時、このカードをアーカイブして振り直せる (ファンの振り直し)
      if (
        new RegExp(
          `^この${kindWord}が付いているホロメンが能力でサイコロを振った時、この${kindWord}をアーカイブできる[:：](?:サイコロを1回振り直す|そのサイコロの結果をすべて無くし、はじめからサイコロを振り直す)。?$`,
        ).test(sec)
      ) {
        b.diceReroll = { requiresCond: isCond || undefined };
        continue;
      }
      // 相手のターンで装着者がダメージを受ける時、このカードをアーカイブして受けるダメージ-X (振り込み軽減)
      mm = sec.match(
        new RegExp(
          `^相手のターンで、この${kindWord}が付いているホロメンがダメージを受ける時、この${kindWord}をアーカイブできる[:：]この${kindWord}が付いていたホロメン(?:が|の)受けるダメージ-(\\d+)。?$`,
        ),
      );
      if (mm) {
        b.damageReduce = {
          value: num(mm[1]),
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // 装着者の能力でエールをアーカイブする時、(色)エール1枚のかわりにこのカードをアーカイブできる (肩代わり)
      mm = sec.match(
        new RegExp(
          `^この${kindWord}が付いて(?:い)?るホロメンの能力でエールをアーカイブする時、アーカイブする${COLOR_RE}?エール1枚のかわりに、この${kindWord}をアーカイブできる。?$`,
        ),
      );
      if (mm) {
        b.yellArchiveSub = {
          color: (mm[1] as Color) || undefined,
          requiresCond: isCond || undefined,
        };
        continue;
      }
      // トリガー能力
      const trig = parseTriggerSection(sec, kindWord, isCond);
      if (trig) {
        b.triggers.push(trig);
        continue;
      }
      // 複文セクション: 先頭の1文と残りに分けて再試行する
      const split = sec.match(/^([^。]+。)\s*(.+)$/s);
      if (split) {
        queue.unshift(split[1].trim(), split[2].trim());
        continue;
      }
      b.full = false;
    }
  };

  process(t, false);
  process(condPart, true);
  return b;
}
