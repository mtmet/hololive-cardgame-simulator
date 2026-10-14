// カード本文の解析：costs。
import type { Color } from "../../data/types";
import { parseCond } from "./conditions";
import { parsePositionHeader } from "./filters";
import { num, parseNames, COLOR_RE, normalizeText } from "./normalization";
import type { ArtCostMod, ArtGate } from "./types";

/** 1文がアーツ自身のコスト軽減文ならその修正を、そうでなければ null を返す */
export function matchArtCostMod(s: string): ArtCostMod | null {
  // このアーツは、<条件>、エールN枚を必要とせずに使える
  let m = s.match(/^このアーツは、(.+?)、エール(\d+)枚を必要とせずに使える$/);
  if (m) {
    const cond = parseCond(m[1]);
    return cond ? { costless: num(m[2]), cond } : null;
  }
  // このアーツは、エールN枚を必要とせずに使える (無条件)
  m = s.match(/^このアーツは、エール(\d+)枚を必要とせずに使える$/);
  if (m) return { costless: num(m[1]) };
  // 自分のセンターホロメンに付いている〈N〉1枚につき、このアーツに必要な無色-N
  m = s.match(
    /^自分のセンターホロメンに付いている((?:〈[^〉]+〉)+)(\d+)枚につき、このアーツに必要な無色-(\d+)$/,
  );
  if (m && num(m[2]) === 1)
    return {
      costless: num(m[3]),
      per: { kind: "centerAttachedName", names: parseNames(m[1]) },
    };
  // お互いのアーカイブのエール1色につき、このアーツに必要な無色-N
  m = s.match(
    /^お互いのアーカイブのエール(\d+)色につき、このアーツに必要な無色-(\d+)$/,
  );
  if (m && num(m[1]) === 1)
    return { costless: num(m[2]), per: { kind: "archiveYellColorsBoth" } };
  // <条件>、このアーツに必要な無色-N / このアーツに必要な無色-N (無条件)
  m = s.match(/^(?:(.+?)、)?このアーツに必要な無色-(\d+)$/);
  if (m) {
    if (!m[1]) return { costless: num(m[2]) };
    const cond = parseCond(m[1]);
    return cond ? { costless: num(m[2]), cond } : null;
  }
  // <条件>、(かわりに、)このアーツに必要な(色)-N (特定色コストの軽減)
  m = s.match(
    new RegExp(
      `^(?:(.+?)、)?(かわりに、)?このアーツに必要な${COLOR_RE}-(\\d+)$`,
    ),
  );
  if (m) {
    const color = m[3] as Color;
    const n = num(m[4]);
    if (!m[1]) return { costless: n, color, replacePrev: !!m[2] || undefined };
    const cond = parseCond(m[1]);
    return cond
      ? { costless: n, color, cond, replacePrev: !!m[2] || undefined }
      : null;
  }
  return null;
}

/** アーツの説明文からコスト軽減修正をすべて抽出する (engine の canPayArtCost が使用) */
export function parseArtCostMods(
  description: string | undefined,
): ArtCostMod[] {
  if (!description) return [];
  const t = normalizeText(description)
    .replace(/\[[^\]]*\]/g, "")
    .trim();
  const mods: ArtCostMod[] = [];
  for (const part of t.split("。")) {
    const s = part.trim();
    if (!s) continue;
    const mod = matchArtCostMod(s);
    if (mod) mods.push(mod);
  }
  const positions = parsePositionHeader(description);
  return positions ? mods.map((mod) => ({ ...mod, positions })) : mods;
}

/** 「このアーツは、〜と使えない」形式の使用ゲートを1文から解析する */
export function matchArtGate(s: string): ArtGate | null {
  let m = s.match(
    /^このアーツは、このホロメンに((?:〈[^〉]+〉)+)が付いていないと使えない$/,
  );
  if (m) return { requireAttachedNames: parseNames(m[1]) };
  m = s.match(
    /^このアーツは、自分のアーカイブにサポートカードが(\d+)枚以上なければ使えない$/,
  );
  if (m) return { requireArchiveSupport: num(m[1]) };
  m = s.match(/^このアーツは、(.+?)でなければコラボポジションでは使えない$/);
  if (m) {
    const cond = parseCond(m[1]);
    if (cond) return { collabRequires: cond };
  }
  return null;
}

export function parseArtGates(description: string | undefined): ArtGate[] {
  if (!description) return [];
  const t = normalizeText(description)
    .replace(/\[[^\]]*\]/g, "")
    .trim();
  const gates: ArtGate[] = [];
  for (const part of t.split("。")) {
    const g = matchArtGate(part.trim());
    if (g) gates.push(g);
  }
  return gates;
}
