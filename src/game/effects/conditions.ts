// カード本文の解析：conditions。
import type { Color } from "../../data/types";
import {
  parseCardFilter,
  parseTargetFilterMods,
  parseSubjectFilter,
  parseRevealedFilter,
} from "./filters";
import { num, normalizeText, parseNames, COLOR_RE } from "./normalization";
import type { DiceBranch, Cond, TargetFilter, Op } from "./types";

export function parseDiceCond(text: string): DiceBranch["cond"] | null {
  text = text.trim();
  if (text === "奇数") return "odd";
  if (text === "偶数") return "even";
  if (/^出た目の数が自分のライフ以上$/.test(text)) return "geLife";
  if (/^出た目の数が自分のライフ以下$/.test(text)) return "leLife";
  let m = text.match(/^(\d+(?:か\d+)*)$/);
  if (m) return { eq: m[1].split("か").map(num) };
  m = text.match(/^(\d+(?:か\d+)*)以外$/);
  if (m) return { ne: m[1].split("か").map(num) };
  m = text.match(/^(\d+)以上$/);
  if (m) return { ge: num(m[1]) };
  m = text.match(/^(\d+)以下$/);
  if (m) return { le: num(m[1]) };
  return null;
}

export function parseCond(text: string): Cond | null {
  text = normalizeText(text);
  text = text
    .trim()
    .replace(/^(?:その後、|さらに、)/, "")
    .replace(/の時$/, "")
    .replace(/なら$/, "")
    .replace(/少なければ$/, "少ない")
    .replace(/多ければ$/, "多い")
    .replace(/^自分が/, "自分が");
  let extra = text.match(/^相手の手札が(\d+)枚以上$/);
  const requiredNames = text.match(
    /^自分のステージに(〈[^〉]+〉(?:と〈[^〉]+〉)+)がいる$/,
  );
  if (requiredNames)
    return {
      c: "and",
      inner: [...requiredNames[1].matchAll(/〈([^〉]+)〉/g)].map((m) => ({
        c: "stageHas",
        filter: { names: [m[1]] },
      })),
    };
  if (extra) return { c: "oppHandAtLeast", n: num(extra[1]) };
  extra = text.match(/^相手のホロパワーが(\d+)枚以上$/);
  if (extra) return { c: "oppHoloPowerAtLeast", n: num(extra[1]) };
  if (text === "自分の推しホロメンが推しステージスキルを持つ")
    return { c: "oshiHasStageSkill" };
  if (text === "このターンに自分のホロメンがバトンタッチしていた")
    return { c: "batonTouchedThisTurn" };
  if (text === "このターンに自分のホロメンがアーカイブからBloomしていた")
    return { c: "archiveBloomedThisTurn" };
  if (text === "このホロメンのHPが減っていない")
    return { c: "not", inner: { c: "selfDamaged" } };
  if (text === "自分のサポートが付いているホロメンがいる")
    return { c: "stageHas", filter: { hasAttachedSupport: true } };
  extra = text.match(/^このアーツがこのターンに使う(\d+)回目のアーツ$/);
  if (extra) return { c: "artUseNumber", n: num(extra[1]) };
  extra = text.match(/^このホロメンの残りHPが(\d+)以上$/);
  if (extra) return { c: "selfRemainingHpAtLeast", n: num(extra[1]) };
  extra = text.match(/^このアーツの対象が(1st|2nd)以上のホロメン$/);
  if (extra)
    return {
      c: "artTargetIs",
      filter: { minBloom: extra[1] as "1st" | "2nd" },
    };
  extra = text.match(/^アーカイブしたカードが(.+)$/);
  if (extra) {
    const f = parseCardFilter(extra[1]);
    if (f) return { c: "milledHas", filter: f };
    const tag = extra[1].match(/^#(.+?)を持たない$/);
    if (tag) return { c: "milledHas", filter: { tag: tag[1] }, negate: true };
  }
  extra = text.match(/^自分のエールが付いているホロメンが(\d+)人以上いる$/);
  if (extra)
    return { c: "stageHas", filter: { hasYell: true }, n: num(extra[1]) };
  extra = text.match(/^自分のステージに\[([緑青黄白赤紫と]+)\]エールがある$/);
  if (extra)
    return { c: "stageYellHasColors", colors: extra[1].split("と") as Color[] };
  extra = text.match(/^自分のステージに(.+?)が(\d+)枚以上(?:ある)?$/);
  if (extra) {
    const f = parseCardFilter(extra[1]);
    if (f?.kind === "ツール")
      return { c: "stageAttachedCount", filter: f, n: num(extra[2]) };
  }
  extra = text.match(/^このホロメンに(.+?)が付いている$/);
  if (extra) {
    const f = parseCardFilter(extra[1]);
    if (f && extra[1].startsWith("#"))
      return {
        c: "stageHas",
        filter: { sourceOnly: true, hasAttachedFilter: f },
      };
  }
  extra = text.match(/^自分のBuzzホロメンか2ndホロメンに(.+?)が付いている$/);
  if (extra) {
    const f = parseCardFilter(extra[1]);
    if (f)
      return {
        c: "stageHas",
        filter: {
          anyOf: [{ buzz: true }, { bloomLevel: "2nd" }],
          hasAttachedFilter: f,
        },
      };
  }
  extra = text.match(/^選んだホロメンがBuzzホロメンか2ndホロメン$/);
  if (extra)
    return {
      c: "boundIs",
      filter: { anyOf: [{ buzz: true }, { bloomLevel: "2nd" }] },
    };
  // 「直前の相手のターンに自分のホロメンがダウンしていて、(B)」= AND複合
  {
    const ad = text.match(
      /^(直前の相手のターンに自分のホロメンがダウンしてい)て、(.+)$/,
    );
    if (ad) {
      const b = parseCond(ad[2]);
      if (b) return { c: "and", inner: [{ c: "downedLastOppTurn" }, b] };
    }
  }
  // 「(A)か、(B)」= OR複合 (両側が条件として解析できる場合のみ)
  {
    const or = text.match(/^(.+?)か、(.+)$/);
    if (or) {
      const a = parseCond(or[1]);
      const b = a ? parseCond(or[2]) : null;
      if (a && b) return { c: "or", inner: [a, b] };
    }
  }
  // 「自分の[AかB]」= OR複合 (括弧内の各選択肢に「自分の」を前置して解析)
  {
    const br = text.match(/^自分の\[([^\]]+)\]$/);
    if (br) {
      const inner = br[1];
      for (
        let i = inner.indexOf("か");
        i >= 0;
        i = inner.indexOf("か", i + 1)
      ) {
        const a = parseCond("自分の" + inner.slice(0, i));
        const b = a ? parseCond("自分の" + inner.slice(i + 1)) : null;
        if (a && b) return { c: "or", inner: [a, b] };
      }
    }
  }
  // 自分のステージにこのホロメンと異なる色のホロメンがいる (汎用stageHasより先に判定)
  if (/^自分のステージにこのホロメンと異なる色のホロメンがいる$/.test(text))
    return { c: "stageHasDiffColorFromSelf" };
  let mm0 = text.match(
    /^自分の#([^、を]+?)を持つ\[センターホロメンとコラボホロメン\]に異なる色のエールが付いている$/,
  );
  if (mm0) return { c: "tagCenterCollabDiffYell", tag: mm0[1] };
  mm0 = text.match(/^ホロメン(\d+)枚をデッキに戻した$/);
  if (mm0) return { c: "movedHolomenAtLeast", n: num(mm0[1]) };
  // このターンに自分の〈N〉の能力でサイコロをn回以上振っていた
  mm0 = text.match(
    /^このターンに自分の((?:〈[^〉]+〉)+)の能力でサイコロを(\d+)回以上振っていた時?$/,
  );
  if (mm0)
    return { c: "diceRolledByName", names: parseNames(mm0[1]), n: num(mm0[2]) };
  // このターンにこのホロメンが自分の推しスキル「N」でアクティブになっていた
  mm0 = text.match(
    /^このターンにこのホロメンが自分の推しスキル「([^」]+)」でアクティブになっていた$/,
  );
  if (mm0) return { c: "selfActivatedByOshiSkill", name: mm0[1] };
  if (/^このターンに自分のホロメンがステージからデッキに戻っていた$/.test(text))
    return { c: "stageToDeckThisTurn" };
  // 戻したカードが#Tを持つ
  mm0 = text.match(/^戻したカードが#([^、を]+?)を持つ$/);
  if (mm0) return { c: "pickedHasTag", tag: mm0[1] };
  // 自分のステージに色が1色で異なる色のホロメンがn人以上いる (ツートンカラーパソコン)
  mm0 = text.match(
    /^自分のステージに色が1色で異なる色のホロメンが(\d+)人以上い(?:る)?$/,
  );
  if (mm0) return { c: "stageMonoDistinct", n: num(mm0[1]) };
  // そのホロメンが(Buzz|レベル)ホロメン(か…)* (downedOwnリアクティブ: ダウンしたホロメン参照)
  mm0 = text.match(
    /^その(?:ダウンした)?ホロメンが((?:Buzz|Debut|1st|2nd)ホロメン(?:か(?:Buzz|Debut|1st|2nd)ホロメン)*)$/,
  );
  if (mm0) {
    const parts = mm0[1].split("か").map((x) => x.replace(/ホロメン$/, ""));
    return {
      c: "downedIs",
      buzz: parts.includes("Buzz") || undefined,
      levels: parts.filter((x): x is "Debut" | "1st" | "2nd" => x !== "Buzz"),
    };
  }
  // このアーツの対象が相手のバトンタッチに必要な◇がXつ以上のホロメン
  mm0 = text.match(
    /^このアーツの対象が相手のバトンタッチに必要な(?:◇|無色)が(\d+)つ以上のホロメン$/,
  );
  if (mm0) return { c: "artTargetIs", batonAtLeast: num(mm0[1]) };
  // 自分の〈N〉以外の#Tを持つホロメンにCエールかCエールが付いている
  mm0 = text.match(
    new RegExp(
      `^自分の(?:((?:〈[^〉]+〉)+)以外の)?#([^、を]+?)を持つホロメンに(${COLOR_RE}エール(?:か${COLOR_RE}エール)*)が付いている$`,
    ),
  );
  if (mm0) {
    const colors = [...mm0[3].matchAll(/(白|緑|赤|青|紫|黄)エール/g)].map(
      (x) => x[1] as Color,
    );
    const filter: TargetFilter = { tag: mm0[2], hasColorYell: colors };
    if (mm0[1]) filter.excludeNames = parseNames(mm0[1]);
    return { c: "stageHas", filter };
  }
  let m = text.match(
    /^自分のセンターホロメンが#([^、を]+?)を持つ(?:ホロメン)?$/,
  );
  if (m) return { c: "centerHasTag", tag: m[1] };
  m = text.match(
    /^自分のステージに(異なるカード名の)?(.+?)が(?:(\d+)人以上)?いる$/,
  );
  if (m) {
    const distinctNames = !!m[1];
    const n = m[3] ? num(m[3]) : undefined;
    const inner = m[2].replace(/ホロメン$/, "");
    const filter = parseTargetFilterMods(inner);
    if (filter) return { c: "stageHas", filter, n, distinctNames };
    const names = parseNames(m[2]);
    if (names.length > 0)
      return { c: "stageHas", filter: { names }, n, distinctNames };
    return null;
  }
  m = text.match(/^相手のステージに(.+?)がいる$/);
  if (m) {
    const inner = m[1].replace(/ホロメン$/, "");
    const filter = parseTargetFilterMods(inner);
    if (filter) return { c: "oppStageHas", filter };
    const names = parseNames(m[1]);
    if (names.length > 0) return { c: "oppStageHas", filter: { names } };
    return null;
  }
  m = text.match(
    /^このゲーム中に、?自分の(?:((?:〈[^〉]+〉)+)の)?SP推しスキル(?:「([^」]+)」)?を使っていた$/,
  );
  if (m)
    return {
      c: "usedSpSkill",
      ...(m[1] ? { oshiNames: parseNames(m[1]) } : {}),
      ...(m[2] ? { name: m[2] } : {}),
    };
  m = text.match(
    /^このターンの(自分のメインステップに)?自分のSP推しスキル(?:「([^」]+)」)?を使っていた$/,
  );
  if (m)
    return {
      c: "usedSpSkillThisTurn",
      ...(m[1] ? { ownMainStep: true } : {}),
      ...(m[2] ? { name: m[2] } : {}),
    };
  m = text.match(/^このターンに自分の推しスキル(?:「([^」]+)」)?を使っていた$/);
  if (m) return { c: "usedOshiSkillThisTurn", ...(m[1] ? { name: m[1] } : {}) };
  m = text.match(
    /^相手のセンターホロメンのバトンタッチに必要な無色が(\d+)つ以上$/,
  );
  if (m) return { c: "oppCenterBatonAtLeast", n: num(m[1]) };
  // 自分の(F)(バック|コラボ)?ホロメンが(X人以上)いる / いない
  m = text.match(
    /^自分の(.*?)(バック|コラボ|センター)?ホロメンが(?:(\d+)人以上)?い(る|ない)$/,
  );
  if (m) {
    const filter = parseSubjectFilter("自分の" + m[1]);
    if (filter !== null) {
      const inner: Cond = {
        c: "stageHas",
        filter: filter ?? {},
        n: m[3] ? num(m[3]) : undefined,
        pos:
          m[2] === "バック"
            ? "back"
            : m[2] === "コラボ"
              ? "collab"
              : m[2] === "センター"
                ? "center"
                : undefined,
      };
      return m[4] === "ない" ? { c: "not", inner } : inner;
    }
  }
  m = text.match(
    /^自分の((?:〈[^〉]+〉)+)が付いている(.*?)ホロメンがい(る|ない)$/,
  );
  if (m) {
    const extra = parseTargetFilterMods(m[2]);
    if (extra !== null) {
      const inner: Cond = {
        c: "stageHas",
        filter: { ...(extra ?? {}), hasAttachedNames: parseNames(m[1]) },
      };
      return m[3] === "ない" ? { c: "not", inner } : inner;
    }
  }
  m = text.match(
    /^自分の((?:〈[^〉]+〉)+)が付いている((?:〈[^〉]+〉)+)がい(る|ない)$/,
  );
  if (m) {
    const inner: Cond = {
      c: "stageHas",
      filter: { names: parseNames(m[2]), hasAttachedNames: parseNames(m[1]) },
    };
    return m[3] === "ない" ? { c: "not", inner } : inner;
  }
  if (/^このホロメンのHPが減っている$/.test(text)) return { c: "selfDamaged" };
  if (/^自分のセンターホロメンのHPが減っている$/.test(text))
    return { c: "centerDamaged" };
  if (/^相手のバックホロメンのHPが減っている$/.test(text))
    return { c: "oppBackDamaged" };
  m = text.match(/^相手のHPが減っているバックホロメンが(\d+)人以上いる$/);
  if (m) return { c: "oppBackDamagedCount", n: num(m[1]) };
  m = text.match(/^相手のHPが(\d+)以上減っているバックホロメンがいる$/);
  if (m) return { c: "oppBackDamagedByAtLeast", n: num(m[1]) };
  m = text.match(/^相手のバックホロメン全員のHPが合計(\d+)以上減っている$/);
  if (m) return { c: "oppBackDamageSumAtLeast", n: num(m[1]) };
  if (/^このターンに自分のホロメンがBloomしていた$/.test(text))
    return { c: "bloomedOwnThisTurn" };
  m = text.match(/^自分のアーカイブが(\d+)枚以上ある$/);
  if (m) return { c: "archiveCountAtLeast", n: num(m[1]) };
  if (/^自分のアーカイブにホロメンがある$/.test(text))
    return { c: "archiveHasHolomen" };
  m = text.match(
    new RegExp(`^自分のアーカイブに${COLOR_RE}?(?:C)?エールがある$`),
  );
  if (m) return { c: "archiveHasYell", color: (m[1] as Color) || undefined };
  m = text.match(
    /^このターンに自分のデッキからカードを(\d+)枚以上アーカイブしていた$/,
  );
  if (m) return { c: "milledFromDeckThisTurnAtLeast", n: num(m[1]) };
  m = text.match(/^自分のステージにエールが(\d+)枚以上ある$/);
  if (m) return { c: "stageYellCountAtLeast", n: num(m[1]) };
  m = text.match(/^相手のステージにエールが(\d+)枚以上ある$/);
  if (m) return { c: "oppStageYellCountAtLeast", n: num(m[1]) };
  m = text.match(/^お互いのステージのエールが合計(\d+)枚以上ある$/);
  if (m) return { c: "bothStageYellSumAtLeast", n: num(m[1]) };
  m = text.match(/^自分のエールデッキの枚数が(\d+)枚(?:以下)?$/);
  if (m) return { c: "cheerDeckCountAtMost", n: num(m[1]) };
  m = text.match(/^自分のデッキの枚数が(\d+)枚以下$/);
  if (m) return { c: "deckCountAtMost", n: num(m[1]) };
  if (/^このホロメンがBuzzホロメンからBloomしている$/.test(text))
    return { c: "selfBloomedFromBuzz" };
  // 「自分のセンターホロメンが(レベル)の〈N〉」 (レベル+名称の複合)
  m = text.match(
    /^自分のセンターホロメンが(Debut|1st|2nd)の((?:〈[^〉]+〉)+)$/,
  );
  if (m)
    return {
      c: "and",
      inner: [
        { c: "centerBloomLevelIs", level: m[1] as "Debut" | "1st" | "2nd" },
        { c: "centerIs", names: parseNames(m[2]) },
      ],
    };
  m = text.match(/^自分のステージのエールの枚数が相手より(?:(\d+)枚)?多い$/);
  if (m)
    return {
      c: "stageYellVsOpp",
      mode: "more",
      margin: m[1] ? num(m[1]) : undefined,
    };
  if (/^自分のステージのエールの枚数が相手より少ない$/.test(text))
    return { c: "stageYellVsOpp", mode: "less" };
  if (/^自分のステージのエールの枚数が相手以下$/.test(text))
    return { c: "stageYellVsOpp", mode: "atMost" };
  // 「エールがX枚以上多い」(直前文の「相手より多い」比較を受けた省略形)
  m = text.match(/^エールが(\d+)枚以上多い$/);
  if (m) return { c: "stageYellVsOpp", mode: "more", margin: num(m[1]) };
  m = text.match(
    new RegExp(
      `^このホロメンに${COLOR_RE}以外のエールが(?:(\\d+)枚以上)?付いている$`,
    ),
  );
  if (m)
    return {
      c: "selfHasYellExcept",
      color: m[1] as Color,
      n: m[2] ? num(m[2]) : 1,
    };
  m = text.match(/^このホロメンにエールが(\d+)枚以上付いている$/);
  if (m) return { c: "selfYellCount", n: num(m[1]) };
  m = text.match(/^選んだホロメンにエールが(\d+)枚以上付いている$/);
  if (m) return { c: "boundYellCount", n: num(m[1]) };
  m = text.match(/^お互いのセンターホロメンが(Debut|1st|2nd)ホロメン$/);
  if (m)
    return {
      c: "bothCenterBloomLevelIs",
      level: m[1] as "Debut" | "1st" | "2nd",
    };
  // 「(Debut)ホロメンをX枚出した」(直前のサーチで出した枚数。レベルは近似で無視)
  m = text.match(/^(?:Debut|1st|2nd)?ホロメンを(\d+)枚出した$/);
  if (m) return { c: "movedHolomenAtLeast", n: num(m[1]) };
  m = text.match(/^自分のステージのホロメンが相手より(少ない|多い)$/);
  if (m)
    return { c: "stageCountVsOpp", mode: m[1] === "少ない" ? "less" : "more" };
  m = text.match(
    new RegExp(`^自分の推しホロメンの色が(${COLOR_RE}(?:か${COLOR_RE})*)$`),
  );
  if (m) {
    const colors = [...m[1].matchAll(/(白|緑|赤|青|紫|黄)/g)].map(
      (mm) => mm[1] as Color,
    );
    if (colors.length === 1) return { c: "oshiColorIs", color: colors[0] };
    return {
      c: "or",
      inner: colors.map((c) => ({ c: "oshiColorIs", color: c })),
    };
  }
  m = text.match(
    /^このターンに自分が#([^、を]+?)を持つ(イベント|アイテム|スタッフ|サポート)(?:カード)?を(\d+)枚以上使っていた$/,
  );
  if (m)
    return {
      c: "usedTaggedSupportThisTurn",
      tag: m[1],
      kind: m[2] as "イベント" | "アイテム" | "スタッフ" | "サポート",
      n: num(m[3]),
    };
  m = text.match(
    /^このターンに自分が#([^、を]+?)を持つ(イベント|アイテム|スタッフ|サポート)(?:カード)?を使っていた$/,
  );
  if (m)
    return {
      c: "usedTaggedSupportThisTurn",
      tag: m[1],
      kind: m[2] as "イベント" | "アイテム" | "スタッフ" | "サポート",
    };
  m = text.match(
    /^このターンに自分が(サポートカード|イベント|アイテム|スタッフ)を使っていた$/,
  );
  if (m)
    return {
      c: "usedSupportTypeThisTurn",
      kind:
        m[1] === "サポートカード"
          ? "サポート"
          : (m[1] as "イベント" | "アイテム" | "スタッフ"),
    };
  m = text.match(/^このターンに自分が((?:〈[^〉]+〉)+)を使っていた$/);
  if (m) return { c: "usedCardNameThisTurn", names: parseNames(m[1]) };
  // アーカイブしたカードの種別条件 (「アーカイブしたカードが、?ホロメン」/直前の文脈で主語省略の「ホロメン」「サポートカード」)
  if (/^(?:アーカイブしたカードが、?)?サポートカード$/.test(text))
    return { c: "lastMilledAllSupport" };
  if (/^(?:アーカイブしたカードが、?)?ホロメン$/.test(text))
    return { c: "lastMilledAllHolomen" };
  m = text.match(
    new RegExp(
      `^このホロメンに${COLOR_RE}エールと${COLOR_RE}エールが付いている$`,
    ),
  );
  if (m)
    return {
      c: "and",
      inner: [
        { c: "selfHasYell", color: m[1] as Color, n: 1 },
        { c: "selfHasYell", color: m[2] as Color, n: 1 },
      ],
    };
  m = text.match(
    new RegExp(`^このホロメンに${COLOR_RE}エールが(\\d+)枚以上付いている$`),
  );
  if (m) return { c: "selfHasYell", color: m[1] as Color, n: num(m[2]) };
  m = text.match(new RegExp(`^このホロメンに${COLOR_RE}エールが付いている$`));
  if (m) return { c: "selfHasYell", color: m[1] as Color, n: 1 };
  m = text.match(/^このホロメンに((?:〈[^〉]+〉)+)が(\d+)枚以上付いている$/);
  if (m)
    return { c: "selfHasAttachedName", names: parseNames(m[1]), n: num(m[2]) };
  m = text.match(/^このホロメンに(〈.+〉)が付いている$/);
  if (m) return { c: "selfHasAttachedName", names: parseNames(m[1]) };
  m = text.match(/^このホロメンに(〈.+〉)が付いていない$/);
  if (m)
    return {
      c: "not",
      inner: { c: "selfHasAttachedName", names: parseNames(m[1]) },
    };
  m = text.match(
    /^このホロメンに(マスコット|ファン|ツール)(?:か(マスコット|ファン|ツール))?が付いている$/,
  );
  if (m) {
    const kinds = [m[1]] as ("マスコット" | "ファン" | "ツール")[];
    if (m[2]) kinds.push(m[2] as "マスコット" | "ファン" | "ツール");
    return { c: "selfHasAttachedType", kinds };
  }
  m = text.match(
    /^その?相手のセンターホロメンに(マスコット|ファン|ツール)が付いている$/,
  );
  if (m)
    return {
      c: "oppCenterHasAttachedType",
      kinds: [m[1] as "マスコット" | "ファン" | "ツール"],
    };
  m = text.match(
    new RegExp(
      `^このホロメンに${COLOR_RE}エールと${COLOR_RE}エールのどちらか1色しか付いていない$`,
    ),
  );
  if (m)
    return {
      c: "selfYellExactlyOneOf",
      colors: [m[1] as Color, m[2] as Color],
    };
  m = text.match(
    /^自分のステージに\[((?:マスコット|ファン|ツール)(?:と(?:マスコット|ファン|ツール))*)\]が合計(\d+)枚以上ある$/,
  );
  if (m)
    return {
      c: "stageAttachedCountAtLeast",
      kinds: m[1].split("と") as ("マスコット" | "ファン" | "ツール")[],
      n: num(m[2]),
    };
  m = text.match(
    /^このホロメンに#([^、を]+?)を持つサポートカードが付いている$/,
  );
  if (m) return { c: "selfHasAttachedTag", tag: m[1] };
  if (/^このホロメンにサポートカードが付いている$/.test(text))
    return { c: "selfHasAttachedSupport" };
  m = text.match(/^自分のセンターホロメンにエールが(\d+)枚以上付いている$/);
  if (m) return { c: "centerHasYell", n: num(m[1]) };
  m = text.match(
    new RegExp(`^自分のステージに${COLOR_RE}エールが(?:(\\d+)枚以上)?ある$`),
  );
  if (m)
    return {
      c: "stageHasColorYell",
      color: m[1] as Color,
      n: m[2] ? num(m[2]) : undefined,
    };
  m = text.match(
    new RegExp(`^自分のステージのエールすべてが${COLOR_RE}エール$`),
  );
  if (m) return { c: "stageAllYellColor", color: m[1] as Color };
  m = text.match(/^自分のステージに((?:〈[^〉]+〉)+)がある$/);
  if (m) return { c: "stageHasNamedCard", names: parseNames(m[1]) };
  if (/^アーカイブした$/.test(text)) return { c: "lastMilledAny" };
  m = text.match(/^自分のライフが(\d+)以下$/);
  if (m) return { c: "lifeAtMost", n: num(m[1]) };
  m = text.match(/^自分のライフが(\d+)$/);
  if (m) return { c: "lifeEq", n: num(m[1]) };
  if (/^自分のライフが相手(のライフ)?より少ない$/.test(text))
    return { c: "lifeLessThanOpp" };
  if (/^自分のライフが相手(のライフ)?以下$/.test(text))
    return { c: "lifeAtMostOpp" };
  if (/^自分の手札(の枚数)?が相手(より少ない|の枚数?より少ない)$/.test(text))
    return { c: "handLessThanOpp" };
  m = text.match(/^自分の手札が(\d+)枚以下$/);
  if (m) return { c: "handAtMost", n: num(m[1]) };
  m = text.match(/^自分の手札が(?:このカードを含まずに)?(\d+)枚以上$/);
  if (m) return { c: "handAtLeast", n: num(m[1]) };
  m = text.match(/^自分の手札が(\d+)枚$/);
  if (m) return { c: "handEq", n: num(m[1]) };
  m = text.match(/^自分のホロパワーが(\d+)枚以上$/);
  if (m) return { c: "holoPowerAtLeast", n: num(m[1]) };
  if (/^このターンに自分のステージのエールがアーカイブされていた$/.test(text))
    return { c: "stageYellArchivedThisTurn" };
  m = text.match(/^相手の(コラボ|センター)ホロメンがい(る|ない)$/);
  if (m) {
    const inner: Cond = {
      c: "oppStageHas",
      filter: {},
      pos: m[1] === "コラボ" ? "collab" : "center",
    };
    return m[2] === "ない" ? { c: "not", inner } : inner;
  }
  m = text.match(
    new RegExp(
      `^自分の推しホロメンが(?:${COLOR_RE}の)?((?:〈[^〉]+〉)(?:か〈[^〉]+〉)*)$`,
    ),
  );
  if (m) {
    const nameCond: Cond = { c: "oshiIs", names: parseNames(m[2]) };
    return m[1]
      ? {
          c: "and",
          inner: [nameCond, { c: "oshiColorIs", color: m[1] as Color }],
        }
      : nameCond;
  }
  m = text.match(/^自分のセンターホロメンが((?:〈[^〉]+〉)+)$/);
  if (m) return { c: "centerIs", names: parseNames(m[1]) };
  m = text.match(/^自分のセンターホロメンが(Debut|1st|2nd)ホロメン$/);
  if (m)
    return { c: "centerBloomLevelIs", level: m[1] as "Debut" | "1st" | "2nd" };
  m = text.match(
    /^自分のセンターホロメンが(Debut|1st|2nd)ホロメンの((?:〈[^〉]+〉)+)$/,
  );
  if (m)
    return {
      c: "and",
      inner: [
        { c: "centerBloomLevelIs", level: m[1] as "Debut" | "1st" | "2nd" },
        { c: "centerIs", names: parseNames(m[2]) },
      ],
    };
  m = text.match(
    /^このターンに自分がLIMITEDの(イベント|アイテム|スタッフ|サポートカード)を使っていた$/,
  );
  if (m)
    return {
      c: "usedLimitedThisTurn",
      kind:
        m[1] === "サポートカード"
          ? undefined
          : (m[1] as "イベント" | "アイテム" | "スタッフ"),
    };
  m = text.match(new RegExp(`^自分のセンターホロメンの色が${COLOR_RE}$`));
  if (m) return { c: "centerColorIs", color: m[1] as Color };
  m = text.match(/^このホロメンに重なっているホロメンが(\d+)枚(以上)?$/);
  if (m) return { c: "stackedEq", n: num(m[1]), atLeast: !!m[2] };
  m = text.match(/^自分のステージのホロメンが(\d+)人以下$/);
  if (m) return { c: "stageCountAtMost", n: num(m[1]) };
  m = text.match(/^自分のステージにエールが(\d+)色以上ある$/);
  if (m) return { c: "stageYellColorsAtLeast", n: num(m[1]) };
  m = text.match(
    /^直前の相手のターンに自分の#([^、を]+?)を持つホロメンがダウンしていた$/,
  );
  if (m) return { c: "downedLastOppTurn", filter: { tag: m[1] } };
  m = text.match(
    /^直前の相手のターンにダウンしていた自分のホロメンが((?:〈[^〉]+〉)+)$/,
  );
  if (m) return { c: "downedLastOppTurn", filter: { names: parseNames(m[1]) } };
  if (/^直前の相手のターンに自分のホロメンがダウンしてい(?:て|た)?$/.test(text))
    return { c: "downedLastOppTurn" };
  if (/^自分が後攻で最初のターン$/.test(text))
    return { c: "secondPlayerFirstTurn" };
  // 「〈X〉とコラボした時」= センターが〈X〉 (コラボエフェクトの発動条件)
  m = text.match(/^((?:〈[^〉]+〉)+)とコラボした$/);
  if (m) return { c: "centerIs", names: parseNames(m[1]) };
  m = text.match(/^このターンに自分の((?:〈[^〉]+〉)+)がアーツを使っていた$/);
  if (m) return { c: "allyUsedArtThisTurn", names: parseNames(m[1]) };
  m = text.match(/^自分のアーカイブ[にの](.+?)が、?(\d+)枚(?:以上)?ある$/);
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f) return { c: "archiveHas", filter: f, n: num(m[2]) };
  }
  m = text.match(/^自分のアーカイブに(.+?)がある$/);
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f) return { c: "archiveHas", filter: f, n: 1 };
  }
  // 公開したカードの参照条件
  m = text.match(/^その中に(.+?)がある$/);
  if (m) {
    const f = parseRevealedFilter(m[1]);
    if (f) return { c: "revealedSome", filter: f };
  }
  m = text.match(/^(?:公開したカードが)?(.+?)以外$/);
  if (m) {
    const f = parseRevealedFilter(m[1]);
    if (f) return { c: "not", inner: { c: "revealedMatches", filter: f } };
  }
  m = text.match(/^公開したカードが(.+)$/);
  if (m) {
    const f = parseRevealedFilter(m[1]);
    if (f) return { c: "revealedMatches", filter: f };
  }
  // 自分のステージのホロメン全員が(条件)
  m = text.match(/^自分のステージのホロメン全員が(.+?)ホロメン$/);
  if (m) {
    const filter = parseTargetFilterMods(m[1]);
    if (filter) return { c: "stageAll", filter };
  }
  m = text.match(/^自分のステージのホロメン全員が((?:〈[^〉]+〉)+)$/);
  if (m) return { c: "stageAll", filter: { names: parseNames(m[1]) } };
  // このアーツの対象が相手の(修飾)(センター|コラボ)ホロメン
  m = text.match(
    /^このアーツの対象が、?相手の(.*?)(センター|コラボ)?ホロメン$/,
  );
  if (m) {
    const pos =
      m[2] === "コラボ" ? "collab" : m[2] === "センター" ? "center" : undefined;
    const filter = m[1] ? parseTargetFilterMods(m[1]) : undefined;
    if (filter !== null)
      return { c: "artTargetIs", pos, filter: filter ?? undefined };
  }
  // 複合条件「Aで、B」(両方が個別に解析できる場合のみ)
  m = text.match(/^(.+?)で、(.+)$/);
  if (m) {
    const a = parseCond(m[1]);
    const b = parseCond(m[2]);
    if (a && b) return { c: "and", inner: [a, b] };
  }
  // 複合条件「Aていて、B」(て形接続: 「〈N〉が付いていて、〜」)
  m = text.match(/^(.+?てい)て、(.+)$/);
  if (m) {
    const a = parseCond(m[1] + "る");
    const b = parseCond(m[2]);
    if (a && b) return { c: "and", inner: [a, b] };
  }
  // 複合条件「AがいてB」(いる の て形接続: 「自分のコラボホロメンがいて、相手の〜がいない」)
  m = text.match(/^(.+?がい)て、(.+)$/);
  if (m) {
    const a = parseCond(m[1] + "る");
    const b = parseCond(m[2]);
    if (a && b) return { c: "and", inner: [a, b] };
  }
  return null;
}

export function parsePerClause(
  text: string,
  value: number,
  max?: number,
): Op | null {
  let extra = text.match(/^自分のアーカイブの((?:〈[^〉]+〉)+)1枚につき$/);
  if (extra)
    return {
      t: "artPlusPer",
      per: "archiveNamed",
      names: parseNames(extra[1]),
      value,
      max,
    };
  extra = text.match(/^自分のステージの((?:〈[^〉]+〉)+)1人につき$/);
  if (extra)
    return {
      t: "artPlusPer",
      per: "stageNamed",
      names: parseNames(extra[1]),
      value,
      max,
    };
  extra = text.match(/^自分のセンターの((?:〈[^〉]+〉)+)のエール1枚につき$/);
  if (extra)
    return {
      t: "artPlusPer",
      per: "centerNamedYell",
      names: parseNames(extra[1]),
      value,
      max,
    };
  if (text === "自分のステージのDebut以外のホロメン1人につき")
    return { t: "artPlusPer", per: "stageNonDebut", value, max };
  // 「X枚につき」の X を perN として許容する (規定は1)
  const pn = (raw: string): number | undefined => {
    const n = num(raw);
    return n === 1 ? undefined : n;
  };
  let m = text.match(/^このホロメンのエール(\d+)枚につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "selfYell", max, perN: pn(m[1]) };
  m = text.match(new RegExp(`^このホロメンの${COLOR_RE}エール(\\d+)枚につき$`));
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "selfYellColor",
      color: m[1] as Color,
      max,
      perN: pn(m[2]),
    };
  m = text.match(/^自分のステージのエール(\d+)色につき$/);
  if (m && num(m[1]) === 1)
    return { t: "artPlusPer", value, per: "stageYellColors", max };
  m = text.match(/^自分のステージのエール(\d+)枚につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "stageYell", max, perN: pn(m[1]) };
  m = text.match(
    new RegExp(`^自分のアーカイブの${COLOR_RE}エール(\\d+)枚につき$`),
  );
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "archiveColorYell",
      color: m[1] as Color,
      max,
      perN: pn(m[2]),
    };
  m = text.match(/^自分のアーカイブのエール(\d+)枚につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "archiveYell", max, perN: pn(m[1]) };
  m = text.match(/^多い枚数(\d+)枚につき$/);
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "stageYellDiff",
      max,
      perN: pn(m[1]),
    };
  m = text.match(
    /^このターンに自分が使っていたLIMITEDのサポートカード(\d+)枚につき$/,
  );
  if (m)
    return { t: "artPlusPer", value, per: "usedLimited", max, perN: pn(m[1]) };
  m = text.match(/^自分の#([^、を]+?)を持つホロメン全員のエール(\d+)枚につき$/);
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "stageTagYell",
      tag: m[1],
      max,
      perN: pn(m[2]),
    };
  m = text.match(/^自分の手札(\d+)枚につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "handCount", max, perN: pn(m[1]) };
  m = text.match(/^相手のHPが減っているバックホロメン(\d+)人につき$/);
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "oppDamagedBack",
      max,
      perN: pn(m[1]),
    };
  m = text.match(/^相手のお休みしているホロメン(\d+)人につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "oppResting", max, perN: pn(m[1]) };
  m = text.match(
    /^相手の推しホロメンと異なる色を持つ相手のステージのホロメン(\d+)人につき$/,
  );
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "oppOshiDiffColor",
      max,
      perN: pn(m[1]),
    };
  m = text.match(/^お互いのステージのエール(\d+)枚につき$/);
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "bothStageYell",
      max,
      perN: pn(m[1]),
    };
  m = text.match(/^お互いのアーカイブのエール(\d+)枚につき$/);
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "bothArchiveYell",
      max,
      perN: pn(m[1]),
    };
  m = text.match(/^自分の初期ライフから減っているライフ(\d+)につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "lifeLost", max, perN: pn(m[1]) };
  m = text.match(/^このホロメンに付いている(〈.+〉)(\d+)枚につき$/);
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "attachedName",
      names: parseNames(m[1]),
      perN: pn(m[2]),
    };
  m = text.match(
    /^自分の(?:ステージの)?(このホロメン以外の)?(異なるカード名の)?#([^、を]+?)を持つ(Debut|1st|2nd|Spot)?ホロメン(\d+)人につき$/,
  );
  if (m && num(m[5]) === 1)
    return {
      t: "artPlusPer",
      value,
      per: "stageTag",
      tag: m[3],
      bloomLevel: m[4] as "Debut" | "1st" | "2nd" | "Spot" | undefined,
      excludeSelf: !!m[1],
      distinctNames: !!m[2],
    };
  m = text.match(/^相手のアーカイブのエール(\d+)枚につき$/);
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "oppArchiveYell",
      max,
      perN: pn(m[1]),
    };
  m = text.match(/^このホロメンに重なっているホロメン(\d+)枚につき$/);
  if (m) return { t: "artPlusPer", value, per: "stacked", perN: pn(m[1]) };
  m = text.match(/^自分のステージのマスコット(\d+)枚につき$/);
  if (m && num(m[1]) === 1)
    return { t: "artPlusPer", value, per: "stageMascot" };
  m = text.match(
    /^自分の(?:ステージの|ホロメン全員に付いている)ファン(\d+)枚につき$/,
  );
  if (m && num(m[1]) === 1) return { t: "artPlusPer", value, per: "stageFan" };
  m = text.match(/^自分のアーカイブのホロメン(\d+)枚につき$/);
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "archiveHolomen",
      max,
      perN: pn(m[1]),
    };
  m = text.match(/^自分のアーカイブのカード(\d+)枚につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "archiveCard", max, perN: pn(m[1]) };
  m = text.match(/^(?:この能力で)?公開したホロメン(\d+)枚につき$/);
  if (m && num(m[1]) === 1)
    return { t: "artPlusPer", value, per: "revealedHolomen" };
  m = text.match(/^アーカイブした(?:カード|エール)(\d+)枚につき$/);
  if (m && num(m[1]) === 1) return { t: "artPlusPer", value, per: "milled" };
  m = text.match(
    /^このターンに自分が使っていた(?:#([^、を]+?)を持つ)?イベント(\d+)枚につき$/,
  );
  if (m)
    return {
      t: "artPlusPer",
      value,
      per: "usedEvent",
      tag: m[1] || undefined,
      max,
      perN: pn(m[2]),
    };
  m = text.match(/^相手の手札(\d+)枚につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "oppHandCount", max, perN: pn(m[1]) };
  m = text.match(/^戻したホロメン(\d+)枚につき$/);
  if (m)
    return { t: "artPlusPer", value, per: "movedHolomen", max, perN: pn(m[1]) };
  return null;
}
