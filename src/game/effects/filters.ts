// カード本文の解析：filters。
import type { Color } from "../../data/types";
import { num, COLOR_RE, parseNames, normalizeText } from "./normalization";
import type { CardFilter, StackTarget, TargetFilter } from "./types";

/**
 * カードフィルタの解析。
 * 前置修飾の連鎖 (#Xを持つ / 色 / Buzz以外の / 2nd以上の 等) + 名詞。
 */
export function parseCardFilter(text: string): CardFilter | null {
  text = text.trim().replace(/、$/, "");
  if (!text) return null;

  // コラボエフェクト複合フィルタ (「コラボエフェクトと#Tを持つホロメン」= AND条件。
  //  bracket分割(と/か をORとして扱う)より前に処理する)
  {
    const stripped = text.replace(/^\[/, "").replace(/\]$/, "");
    const cm = stripped.match(/^コラボエフェクトと(.+)$/);
    if (cm) {
      const inner = parseCardFilter(cm[1]);
      if (inner) return { ...inner, hasCollabEffect: true };
      return null;
    }
    if (/^コラボエフェクトを持つホロメン$/.test(stripped))
      return { kind: "holomen", hasCollabEffect: true };
    if (/^ブルームエフェクトを持つホロメン$/.test(stripped))
      return { kind: "holomen", hasBloomEffect: true };
  }

  // [AかB] / [AとB] の選択肢
  const bracket = text.match(/^(.*?)\[([^\]]+)\](.*)$/);
  if (bracket) {
    const parts = bracket[2].split(/か|と/);
    const alts: CardFilter[] = [];
    for (const part of parts) {
      const f = parseCardFilter(bracket[1] + part + bracket[3]);
      if (!f) return null;
      alts.push(f);
    }
    return { alt: alts };
  }

  const f: CardFilter = {};
  let rest = text;
  let progress = true;
  while (progress) {
    progress = false;
    const baton = rest.match(/^バトンタッチに必要な無色が(\d+)つの(.*)$/);
    if (baton) {
      f.batonCost = num(baton[1]);
      rest = baton[2];
      progress = true;
      continue;
    }
    const collab = rest.match(/^コラボエフェクトを持つ、?(.*)$/);
    if (collab) {
      f.hasCollabEffect = true;
      rest = collab[1];
      progress = true;
      continue;
    }
    let m = rest.match(/^#([^、を]+?)を持つ(.*)$/);
    if (m) {
      f.tag = m[1];
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^Buzz以外の(.*)$/);
    if (m) {
      f.excludeBuzz = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^(Debut|1st|2nd|Spot)以外の(.*)$/);
    if (m) {
      f.excludeBloomLevel = m[1] as CardFilter["excludeBloomLevel"];
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^(1st|2nd)以上の(.*)$/);
    if (m) {
      f.minBloom = m[1] as "1st" | "2nd";
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^(Debut|1st|2nd|Spot)の(.*)$/);
    if (m) {
      f.bloomLevel = m[1] as CardFilter["bloomLevel"];
      rest = m[2];
      progress = true;
      continue;
    }
    // 「1stホロメンの〈X〉」形式 (名称の前置修飾)
    m = rest.match(/^(Debut|1st|2nd|Spot)ホロメンの(?=〈)(.*)$/);
    if (m) {
      f.bloomLevel = m[1] as CardFilter["bloomLevel"];
      rest = m[2];
      progress = true;
      continue;
    }
    // 「Buzzホロメンの〈X〉」形式
    m = rest.match(/^Buzzホロメンの(?=〈)(.*)$/);
    if (m) {
      f.buzz = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^LIMITEDの(.*)$/);
    if (m) {
      f.limited = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^LIMITED以外の(.*)$/);
    if (m) {
      f.excludeLimited = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^自分の推しホロメンと同色の(.*)$/);
    if (m) {
      f.sameColorAsOshi = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^自分の(推し|コラボ)ホロメンと同じカード名の(.*)$/);
    if (m) {
      f.sameNameAs = m[1] === "推し" ? "oshi" : "collab";
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^自分のステージのホロメン全員と異なるカード名の(.*)$/);
    if (m) {
      f.diffFromStage = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^戻した(?:ホロメン|カード)と同じカード名の(.*)$/);
    if (m) {
      f.sameNameAsReturned = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^異なるカード名の(.*)$/);
    if (m) {
      f.distinctPick = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^カード名に「([^」]+)」を含む(.*)$/);
    if (m) {
      f.nameContains = m[1];
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(
      /^エクストラ「このホロメンはデッキに何枚でも入れられる」を持つ(.*)$/,
    );
    if (m) {
      f.unlimitedOnly = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^エクストラを持つ(.*)$/);
    if (m) {
      f.unlimitedOnly = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^ブルームエフェクトを持つ(.*)$/);
    if (m) {
      f.hasBloomEffect = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(new RegExp(`^${COLOR_RE}(?=(ホロメン|エール))(.*)$`));
    if (m) {
      f.color = m[1] as Color;
      rest = m[3];
      progress = true;
      continue;
    }
  }

  // 名詞部分
  const names = parseNames(rest);
  if (names.length > 0) {
    const directLevel = rest.match(/^(Debut|1st|2nd|Spot)(?=〈)/);
    if (directLevel) f.bloomLevel = directLevel[1] as CardFilter["bloomLevel"];
    // 「〈A〉と〈B〉」形式のみ許容 (残りが名称と接続詞だけであること)
    const stripped = rest
      .replace(/^(Debut|1st|2nd|Spot)/, "")
      .replace(/〈[^〉]+〉/g, "")
      .replace(/と|や/g, "")
      .trim();
    if (stripped !== "") return null;
    f.names = names;
    return f;
  }
  let m = rest.match(/^(Debut|1st|2nd|Spot)ホロメン$/);
  if (m) {
    f.bloomLevel = m[1] as CardFilter["bloomLevel"];
    f.kind = "holomen";
    return f;
  }
  if (/^Buzzホロメン$/.test(rest)) {
    f.buzz = true;
    f.kind = "holomen";
    return f;
  }
  if (/^ホロメン$/.test(rest)) {
    f.kind = "holomen";
    return f;
  }
  if (/^(ファン|マスコット|ツール|アイテム|イベント|スタッフ)$/.test(rest)) {
    f.kind = rest as CardFilter["kind"];
    return f;
  }
  if (/^サポートカード$/.test(rest) || /^サポート$/.test(rest)) {
    f.kind = "サポート";
    return f;
  }
  if (/^エール$/.test(rest)) {
    f.kind = "yell";
    return f;
  }
  if (/^カード$/.test(rest)) {
    f.any = true;
    return f;
  }
  return null;
}

/** ホロメン対象表現の解析 */
export function parseStackTarget(
  text: string,
): { target: StackTarget; count?: number; filter?: TargetFilter } | null {
  text = text.trim();
  // 「#Tを持つ自分のホロメン」の語順を「自分の#Tを持つホロメン」に正規化
  {
    const tf = text.match(/^(#[^、を]+?を持つ)自分の(.+)$/);
    if (tf) return parseStackTarget(`自分の${tf[1]}${tf[2]}`);
  }
  // 自分の(センターホロメンの)[〈N〉か#Tを持つホロメン] (名称またはタグのいずれか)
  {
    const nt = text.match(
      /^自分の(センターホロメンの)?\[((?:〈[^〉]+〉)+)か#([^、を]+?)を持つホロメン\](?:(\d+)人)?$/,
    );
    if (nt)
      return {
        target: nt[1] ? "ownCenter" : "chooseOwn",
        count: nt[4] ? num(nt[4]) : undefined,
        filter: { nameOrTag: { names: parseNames(nt[2]), tag: nt[3] } },
      };
  }
  // 「相手の推しホロメンと異なる色を持つ」前置修飾 (内側の対象にフィルタを重ねる)
  {
    const md = text.match(/^相手の推しホロメンと異なる色を持つ(相手の.+)$/);
    if (md) {
      const inner = parseStackTarget(md[1]);
      if (inner)
        return {
          ...inner,
          filter: { ...(inner.filter ?? {}), diffColorFromOwnerOshi: true },
        };
      return null;
    }
  }
  if (/^このホロメン$/.test(text)) return { target: "self" };
  {
    const me = text.match(/^このホロメン以外の自分のホロメン(\d+)人$/);
    if (me)
      return {
        target: "chooseOwn",
        count: num(me[1]),
        filter: { excludeSource: true },
      };
  }
  if (/^選んだホロメン$/.test(text)) return { target: "bound" };
  if (/^そのホロメン$/.test(text)) return { target: "bound" };
  if (/^相手のセンターホロメン$/.test(text)) return { target: "oppCenter" };
  if (/^相手のコラボホロメン$/.test(text)) return { target: "oppCollab" };
  // 相手の(センター|コラボ)ポジションの(修飾)ホロメン
  {
    const mc = text.match(/^相手の(センター|コラボ)ポジションの(.*?)ホロメン$/);
    if (mc) {
      const filter = parseTargetFilterMods(mc[2]);
      if (filter !== null)
        return {
          target: mc[1] === "センター" ? "oppCenter" : "oppCollab",
          filter: filter ?? undefined,
        };
    }
  }
  if (
    /^相手のセンターホロメンかコラボホロメン(?:どちらか)?(?:1人)?$/.test(text)
  )
    return { target: "chooseOpp", count: 1 };
  // 相手の(修飾)センターホロメン (「相手のDebut以外のセンターホロメン」等)
  {
    const mc = text.match(/^相手の(.+?)センターホロメン$/);
    if (mc) {
      const filter = parseTargetFilterMods(mc[1]);
      if (filter !== null && filter !== undefined)
        return { target: "oppCenter", filter };
    }
  }
  {
    const mcb = text.match(
      /^相手のセンターホロメンかバックホロメン(\d+)人(?:どちらか)?$/,
    );
    if (mcb) return { target: "chooseOppCenterOrBack", count: num(mcb[1]) };
  }
  if (/^お互いのセンターホロメンとコラボホロメン$/.test(text))
    return { target: "allFrontBoth" };
  if (/^お互いのステージのホロメン全員$/.test(text))
    return { target: "allBoth" };
  if (/^相手のセンターホロメンとコラボホロメン$/.test(text))
    return { target: "allOppFront" };
  // 自分の(修飾)[センターホロメンとコラボホロメン]
  {
    const mf = text.match(/^自分の(.*?)\[センターホロメンとコラボホロメン\]$/);
    if (mf) {
      const filter = parseTargetFilterMods(mf[1]);
      if (filter !== null) return { target: "allOwnFront", filter };
      return null;
    }
  }
  if (/^自分のセンターホロメンとコラボホロメン$/.test(text))
    return { target: "allOwnFront" };
  // 自分の(色)センターホロメン
  {
    const mc = text.match(new RegExp(`^自分の${COLOR_RE}センターホロメン$`));
    if (mc) return { target: "ownCenter", filter: { color: mc[1] as Color } };
  }
  // 自分の(修飾)センターホロメン (#タグ等)
  {
    const mc = text.match(/^自分の(.+?)センターホロメン$/);
    if (mc) {
      const filter = parseTargetFilterMods(mc[1]);
      if (filter !== null && filter !== undefined)
        return { target: "ownCenter", filter };
    }
  }
  let m = text.match(/^相手のバックホロメン(\d+)人$/);
  if (m) return { target: "chooseOppBack", count: num(m[1]) };
  if (/^相手のバックホロメン全員$/.test(text)) return { target: "allOppBack" };
  m = text.match(/^相手のホロメン(\d+)人$/);
  if (m) return { target: "chooseOppAny", count: num(m[1]) };
  if (/^相手の(?:ステージの)?ホロメン全員$/.test(text))
    return { target: "allOpp" };
  // 相手の(修飾)ホロメンX人 (「相手の2ndホロメン1人」等)
  m = text.match(/^相手の(?:ステージの)?(.+?)ホロメン(\d+)人$/);
  if (m) {
    const filter = parseTargetFilterMods(m[1]);
    if (filter !== null && filter !== undefined)
      return { target: "chooseOppAny", count: num(m[2]), filter };
  }
  if (/^自分のセンターホロメン$/.test(text)) return { target: "ownCenter" };
  // 自分の(センター|コラボ)ポジションの(修飾)ホロメン
  {
    const mp = text.match(/^自分の(センター|コラボ)ポジションの(.*?)ホロメン$/);
    if (mp) {
      const filter = parseTargetFilterMods(mp[2]);
      if (filter !== null)
        return {
          target: mp[1] === "センター" ? "ownCenter" : "ownCollab",
          filter: filter ?? undefined,
        };
    }
  }
  // 自分の(センター|コラボ)ホロメンの〈N〉 (名称が位置語の後ろに付く形)
  {
    const mc = text.match(
      /^自分の(センター|コラボ)ホロメンの((?:〈[^〉]+〉)+)$/,
    );
    if (mc)
      return {
        target: mc[1] === "センター" ? "ownCenter" : "ownCollab",
        filter: { names: parseNames(mc[2]) },
      };
  }
  // 自分の〈N〉 (ステージ上の名称指定ホロメン。名称は通常一意)
  {
    const mn = text.match(/^自分の((?:〈[^〉]+〉)+)$/);
    if (mn) return { target: "allOwn", filter: { names: parseNames(mn[1]) } };
  }
  // 自分の(修飾)〈N〉 (「自分の1stホロメンの〈N〉」等)
  {
    const mn = text.match(/^自分の(.+?)((?:〈[^〉]+〉)+)$/);
    if (mn) {
      const mods = parseTargetFilterMods(mn[1]);
      if (mods !== null && mods !== undefined)
        return {
          target: "chooseOwn",
          filter: { ...mods, names: parseNames(mn[2]) },
        };
    }
  }
  // 自分の(修飾)コラボホロメン
  {
    const mc = text.match(/^自分の(.*?)コラボホロメン$/);
    if (mc) {
      const filter = parseTargetFilterMods(mc[1]);
      if (filter !== null) return { target: "ownCollab", filter };
    }
  }

  // 自分の(ステージの)(修飾)ホロメンX人 / 全員
  m = text.match(
    /^自分の(?:ステージの)?(.*?)(?:ホロメン)?(?:(\d+)(?:〜(\d+))?人|全員)$/,
  );
  if (m !== null && (m[2] !== undefined || text.endsWith("全員"))) {
    const mod = m[1] ?? "";
    const filter = parseTargetFilterMods(mod);
    if (filter === null) return null;
    if (text.endsWith("全員")) return { target: "allOwn", filter };
    return { target: "chooseOwn", count: num(m[3] ?? m[2]), filter };
  }
  return null;
}

/** 対象修飾 (色 / #タグ / 〈名〉 / レベル) の解析。空文字はフィルタなし */
export function parseTargetFilterMods(
  mod: string,
): TargetFilter | null | undefined {
  mod = mod.trim();
  if (!mod) return undefined;
  const f: TargetFilter = {};
  let rest = mod;
  let progress = true;
  while (progress && rest) {
    progress = false;
    let m = rest.match(/^((?:〈[^〉]+〉)+)以外の(.*)$/);
    if (m) {
      f.excludeNames = parseNames(m[1]);
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^(Debut|1st|2nd|Spot)(?:ホロメン)?以外の(.*)$/);
    if (m) {
      f.excludeBloomLevel = m[1] as TargetFilter["excludeBloomLevel"];
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^(?:このホロメン以外の|他の)(.*)$/);
    if (m) {
      f.excludeSource = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^このターンにBloomした(.*)$/);
    if (m) {
      f.bloomedThisTurn = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^このターンに(Debut|1st|2nd)ホロメンからBloomした(.*)$/);
    if (m) {
      f.bloomedFromLevelThisTurn = m[1] as "Debut" | "1st" | "2nd";
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^このターンに出した(.*)$/);
    if (m) {
      f.enteredThisTurn = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^HPが(\d+)以上減っている(.*)$/);
    if (m) {
      f.damagedAtLeast = num(m[1]);
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^HPが減っている(.*)$/);
    if (m) {
      f.damagedAtLeast = 1;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^お休みしている(.*)$/);
    if (m) {
      f.resting = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^お休みしていない(.*)$/);
    if (m) {
      f.resting = false;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^\[#([^\]]+?)か#([^\]]+?)\]を持つ(.*)$/);
    if (m) {
      f.anyOf = [...(f.anyOf ?? []), { tag: m[1] }, { tag: m[2] }];
      rest = m[3];
      progress = true;
      continue;
    }
    m = rest.match(
      /^#([^、を]+?)を持つ(マスコット|ファン|ツール|サポートカード)が付いている(.*)$/,
    );
    if (m) {
      f.hasAttachedFilter = {
        tag: m[1],
        kind:
          m[2] === "サポートカード"
            ? "サポート"
            : (m[2] as "マスコット" | "ファン" | "ツール"),
      };
      rest = m[3];
      progress = true;
      continue;
    }
    m = rest.match(/^#([^、を]+?)を持つ(.*)$/);
    if (m) {
      f.tag = m[1];
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^(バック|コラボ|センター)$/);
    if (m) {
      f.position =
        m[1] === "バック" ? "back" : m[1] === "コラボ" ? "collab" : "center";
      rest = "";
      progress = true;
      continue;
    }
    m = rest.match(/^(マスコット|ファン|ツール)が付いている(.*)$/);
    if (m) {
      f.hasAttachedType = m[1] as "マスコット" | "ファン" | "ツール";
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^エールが付いていない(.*)$/);
    if (m) {
      f.noYell = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(/^((?:〈[^〉]+〉)+)が付いている(.*)$/);
    if (m) {
      f.hasAttachedNames = parseNames(m[1]);
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(
      /^\[(Debut|1st|2nd|Spot)ホロメンと(Debut|1st|2nd|Spot)ホロメン\](?:の)?(.*)$/,
    );
    if (m) {
      f.bloomLevels = [m[1], m[2]] as ("Debut" | "1st" | "2nd" | "Spot")[];
      rest = m[3];
      progress = true;
      continue;
    }
    // [<L>ホロメンか<L>ホロメン] (か=OR。tag等と併用可なので anyOf に積む)
    m = rest.match(
      /^\[(Debut|1st|2nd|Spot)ホロメンか(Debut|1st|2nd|Spot)ホロメン\](?:の)?(.*)$/,
    );
    if (m) {
      f.anyOf = [
        ...(f.anyOf ?? []),
        { bloomLevel: m[1] as TargetFilter["bloomLevel"] },
        { bloomLevel: m[2] as TargetFilter["bloomLevel"] },
      ];
      rest = m[3];
      progress = true;
      continue;
    }
    m = rest.match(/^サポートカードが付いている(.*)$/);
    if (m) {
      f.hasAttachedSupport = true;
      rest = m[1];
      progress = true;
      continue;
    }
    m = rest.match(new RegExp(`^${COLOR_RE}(.*)$`));
    if (m) {
      f.color = m[1] as Color;
      rest = m[2];
      progress = true;
      continue;
    }
    m = rest.match(/^(1st|2nd)以上の(.*)$/);
    if (m) {
      f.minBloom = m[1] as "1st" | "2nd";
      rest = m[2];
      progress = true;
      continue;
    }
    if (rest === "Buzz") {
      f.buzz = true;
      rest = "";
      progress = true;
      continue;
    }
    m = rest.match(/^(Debut|1st|2nd|Spot)(?:ホロメンの)?(.*)$/);
    if (m) {
      f.bloomLevel = m[1] as TargetFilter["bloomLevel"];
      rest = m[2];
      progress = true;
      continue;
    }
    const names = parseNames(rest);
    if (names.length > 0) {
      const stripped = rest
        .replace(/〈[^〉]+〉/g, "")
        .replace(/と|や|か/g, "")
        .replace(/[[\]]/g, "")
        .trim();
      if (stripped === "") {
        f.names = names;
        rest = "";
        progress = true;
        continue;
      }
    }
  }
  if (rest) return null; // 解析しきれない修飾
  return f;
}

/** 「自分の#Xを持つホロメン」等、送付先のゆるい対象解析 */
/** 付け先対象の解析 (「自分のホロメン」「自分の〈N〉」「このホロメン」「自分の緑ホロメン」等) */
export function parseAttachTarget(text: string): {
  attachTargetNames?: string[];
  attachTargetFilter?: TargetFilter;
  attachToSelf?: boolean;
  attachSameTarget?: boolean;
  attachExcludeSource?: boolean;
} | null {
  text = text.trim();
  if (text.endsWith("1人")) {
    const inner = parseAttachTarget(text.slice(0, -2));
    return inner ? { ...inner, attachSameTarget: true } : null;
  }
  if (text === "このホロメン") return { attachToSelf: true };
  if (text === "自分のホロメン") return {};
  const excl = text.match(/^自分の他の(.+)$/);
  if (excl) {
    const inner = parseAttachTarget("自分の" + excl[1]);
    if (!inner) return null;
    return { ...inner, attachExcludeSource: true };
  }
  const nm = text.match(/^自分の((?:〈[^〉]+〉)+)$/);
  if (nm) return { attachTargetNames: parseNames(nm[1]) };
  // 汎用フィルタ (自分の緑ホロメン / 自分の#Tを持つホロメン 等)
  const tgt = parseStackTarget(text) ?? parseCheerTargetLoose(text);
  if (
    tgt &&
    (tgt.target === "chooseOwn" || tgt.target === "allOwn") &&
    tgt.filter
  ) {
    const keys = Object.keys(tgt.filter);
    if (tgt.filter.names && keys.length === 1)
      return { attachTargetNames: tgt.filter.names };
    return { attachTargetFilter: tgt.filter };
  }
  return null;
}

/** StackTargetを持たないエール処理でも、位置・発生源・選択済み対象を失わない。 */
export function cheerTargetFilter(tgt: {
  target: StackTarget;
  filter?: TargetFilter;
}): TargetFilter | undefined {
  switch (tgt.target) {
    case "self":
      return { ...tgt.filter, sourceOnly: true };
    case "bound":
      return { ...tgt.filter, boundOnly: true };
    case "ownCenter":
      return { ...tgt.filter, position: "center" };
    case "ownCollab":
      return { ...tgt.filter, position: "collab" };
    case "chooseOwnBack":
      return { ...tgt.filter, position: "back" };
    case "chooseOwnFront":
    case "allOwnFront":
      return { ...tgt.filter, position: "front" };
    default:
      return tgt.filter;
  }
}

export function parseCheerTargetLoose(
  text: string,
): { target: StackTarget; count?: number; filter?: TargetFilter } | null {
  text = text.trim();
  // 「このホロメン以外の / 他の」前置きを剥がし excludeSource を付ける
  const ex = text.match(/^(?:このホロメン以外の|他の)(.+)$/);
  if (ex) {
    const inner = parseCheerTargetLoose(ex[1]);
    if (!inner) return null;
    return {
      ...inner,
      filter: { ...(inner.filter ?? {}), excludeSource: true },
    };
  }
  // 「自分の[AかB]」ブラケットOR (各選択肢を anyOf フィルタに)
  {
    const br = text.match(/^自分の\[(.+)\](?:1人)?$/);
    if (br) {
      const branch = (t: string): TargetFilter | null => {
        t = t.trim();
        if (/^Buzzホロメン$/.test(t)) return { buzz: true };
        const bb = t.match(/^BuzzホロメンからBloomしている((?:〈[^〉]+〉)+)$/);
        if (bb) return { bloomedFromBuzz: true, names: parseNames(bb[1]) };
        const f = parseTargetFilterMods(t.replace(/ホロメン$/, ""));
        if (f) return f;
        const names = parseNames(t);
        if (names.length > 0 && t.replace(/〈[^〉]+〉/g, "").trim() === "")
          return { names };
        return null;
      };
      const inner = br[1];
      for (
        let i = inner.indexOf("か");
        i >= 0;
        i = inner.indexOf("か", i + 1)
      ) {
        const a = branch(inner.slice(0, i));
        const b = a ? branch(inner.slice(i + 1)) : null;
        if (a && b) return { target: "chooseOwn", filter: { anyOf: [a, b] } };
      }
    }
  }
  if (/^自分のバックホロメン(?:1人)?$/.test(text))
    return { target: "chooseOwnBack" };
  if (/^自分のセンターホロメン$/.test(text)) return { target: "ownCenter" };
  if (/^自分のセンターホロメンかコラボホロメン(?:1人)?$/.test(text))
    return { target: "chooseOwnFront" };
  {
    const bm = text.match(/^自分のバックホロメンの〈([^〉]+)〉(?:1人)?$/);
    if (bm) return { target: "chooseOwnBack", filter: { names: [bm[1]] } };
  }
  let m = text.match(/^自分の(.*?)ホロメン(?:1人)?$/);
  if (m) {
    const filter = parseTargetFilterMods(m[1]);
    if (filter !== null) return { target: "chooseOwn", filter };
  }
  m = text.match(
    /^自分の((?:〈[^〉]+〉)+)が付いている((?:〈[^〉]+〉)+)(?:1人)?$/,
  );
  if (m)
    return {
      target: "chooseOwn",
      filter: { names: parseNames(m[2]), hasAttachedNames: parseNames(m[1]) },
    };
  m = text.match(/^自分の((?:〈[^〉]+〉)(?:か〈[^〉]+〉)*)(?:1人)?$/);
  if (m) {
    const names = parseNames(m[1]);
    if (names.length > 0) return { target: "chooseOwn", filter: { names } };
  }
  if (/^このホロメン$/.test(text)) return { target: "self" };
  if (/^選んだホロメン$/.test(text)) return { target: "bound" };
  return null;
}

/** 「公開したカードが〜」の〜部分のカードフィルタ解析 */
export function parseRevealedFilter(text: string): CardFilter | null {
  text = text.trim();
  const direct = parseCardFilter(text);
  if (direct) return direct;
  // 名詞なしのタグ単独 (「#Xを持つ」)
  const tagOnly = text.match(/^#([^、を]+?)を持つ$/);
  if (tagOnly) return { tag: tagOnly[1] };
  // 「AかB」の選択肢 (括弧なし)
  if (text.includes("か")) return parseCardFilter(`[${text}]`);
  return null;
}

/**
 * 効果テキスト全体を解析する。1文でも解析不能なら null。
 */
/**
 * 「[センターポジション限定]」「[センターポジション・コラボポジション限定]」
 * 「[バックポジション限定]」から発動位置を読む。
 */
export function parsePositionHeader(
  text: string,
): ("center" | "collab" | "back")[] | undefined {
  const m = normalizeText(text).match(/\[([^\]]*)ポジション限定\]/);
  if (!m) return undefined;
  const body = m[1];
  const positions: ("center" | "collab" | "back")[] = [];
  if (body.includes("センター")) positions.push("center");
  if (body.includes("コラボ")) positions.push("collab");
  if (body.includes("バック")) positions.push("back");
  return positions.length > 0 ? positions : undefined;
}

/** ホロメン主語のフィルタ解析 (「自分の〈A〉が付いている〈B〉」等も対応) */
/** オーラ対象の前置修飾 (「ファンが付いている」「#Tを持つ」等) を TargetFilter に変換。空文字は {} */
export function parseAuraPrefixFilter(pre: string): TargetFilter | null {
  pre = pre.trim();
  if (!pre) return {};
  let mm = pre.match(/^(マスコット|ファン|ツール)が付いている$/);
  if (mm)
    return { hasAttachedType: mm[1] as "マスコット" | "ファン" | "ツール" };
  mm = pre.match(/^((?:〈[^〉]+〉)+)が付いている$/);
  if (mm) return { hasAttachedNames: parseNames(mm[1]) };
  const f = parseSubjectFilter("自分の" + pre + "ホロメン");
  if (f === null) return null;
  return f ?? {};
}

export function parseSubjectFilter(
  text: string,
): TargetFilter | null | undefined {
  text = text.trim().replace(/^自分の/, "");
  if (!text || text === "ホロメン") return undefined;
  const attached = text.match(/^((?:〈[^〉]+〉)+)が付いている(.+)$/);
  if (attached) {
    const inner = parseSubjectFilter("自分の" + attached[2]);
    if (inner === null) return null;
    return { ...(inner ?? {}), hasAttachedNames: parseNames(attached[1]) };
  }
  const f = parseTargetFilterMods(text.replace(/ホロメン$/, ""));
  if (f !== null) return f;
  const names = parseNames(text);
  if (names.length > 0 && text.replace(/〈[^〉]+〉/g, "").trim() === "")
    return { names };
  return null;
}
