// カード本文の解析：limits。
import { parseCond } from "./conditions";
import { normalizeText, parseNames, num } from "./normalization";
import type { SupportUseLimit, PlayCondition } from "./types";

export function parseSupportUseLimit(
  description: string,
): SupportUseLimit | null {
  const text = normalizeText(description);
  let m = text.match(/自分の〈([^〉]+)〉はターンに(\d+)回しか使えない/);
  if (m) return { name: m[1], n: parseInt(m[2], 10) };
  m = text.match(
    /自分の#([^\s、]+?)を持つ(イベント|アイテム|スタッフ|ツール|マスコット|ファン)はターンに(\d+)回しか使えない/,
  );
  if (m) return { tag: m[1], supportType: m[2], n: parseInt(m[3], 10) };
  return null;
}

/**
 * ブルームエフェクトの自己制限。
 * 「自分のブルームエフェクト「X」はターンにN回しか使えない」は、そのカードの
 * スタックごとではなく**プレイヤーごと・ブルームエフェクト名ごと**に数える。
 */
export function parseBloomEffectUseLimit(
  description: string,
): { name: string; n: number } | null {
  const m = normalizeText(description).match(
    /自分のブルームエフェクト「([^」]+)」はターンに(\d+)回しか使えない/,
  );
  return m ? { name: m[1], n: parseInt(m[2], 10) } : null;
}

export function parsePlayConditions(description: string): {
  conditions: PlayCondition[];
  rest: string;
  allowFirstPlayerFirstTurnOshiNames?: string[];
} {
  const conditions: PlayCondition[] = [];
  description = normalizeText(description);
  let rest = description;
  let allowFirstPlayerFirstTurnOshiNames: string[] | undefined;
  rest = rest.replace(
    /このカードは、自分の推しホロメンが((?:〈[^〉]+〉)+)なら、自分が先攻で最初のターンでも使える。?/,
    (_all, rawNames: string) => {
      allowFirstPlayerFirstTurnOshiNames = parseNames(rawNames);
      return "";
    },
  );
  const condRe =
    /このカードは、([^。]+?)(?:でなければ|しなければ|になければ|なければ|にしか)使えない。?/g;
  for (const m of description.matchAll(condRe)) {
    const body = m[1];
    let matched = false;
    for (const part of body.split(/で、|、かつ/)) {
      let mm = part.match(/自分の手札がこのカードを含まずに(\d+)枚以下/);
      if (mm) {
        conditions.push({ c: "handAtMost", n: num(mm[1]) });
        matched = true;
        continue;
      }
      mm = part.match(/自分の手札がこのカードを含まずに(\d+)枚以上/);
      if (mm) {
        conditions.push({ c: "handAtLeast", n: num(mm[1]) });
        matched = true;
        continue;
      }
      mm = part.match(/自分の推しホロメンが((?:〈[^〉]+〉)(?:か〈[^〉]+〉)*)/);
      if (mm) {
        conditions.push({ c: "oshiIs", names: parseNames(mm[1]) });
        matched = true;
        continue;
      }
      // OR形コストはエール単体のコストより先に判定する (「〜か〜をアーカイブ」)
      mm = part.match(
        /自分の手札(\d+)枚か自分のステージの((?:〈[^〉]+〉)+)(\d+)枚をアーカイブ/,
      );
      if (mm) {
        conditions.push({
          c: "archiveHandOrStageNamed",
          n: num(mm[1]),
          names: parseNames(mm[2]),
          stageN: num(mm[3]),
        });
        matched = true;
        continue;
      }
      mm = part.match(/自分のステージのエール(\d+)枚をアーカイブ/);
      if (mm) {
        conditions.push({ c: "archiveYellCost", n: num(mm[1]) });
        matched = true;
        continue;
      }
      mm = part.match(/自分のホロパワー(\d+)枚をアーカイブ/);
      if (mm) {
        conditions.push({ c: "holoPowerCost", n: num(mm[1]) });
        matched = true;
        continue;
      }
      mm = part.match(
        /自分のステージのホロメン全員が#([^、を]+?)を持つホロメン/,
      );
      if (mm) {
        conditions.push({ c: "stageAll", filter: { tag: mm[1] } });
        matched = true;
        continue;
      }
      mm = part.match(/自分のステージのホロメン全員が((?:〈[^〉]+〉)+)/);
      if (mm) {
        conditions.push({
          c: "stageAll",
          filter: { names: parseNames(mm[1]) },
        });
        matched = true;
        continue;
      }
      mm = part.match(/自分のライフが(\d+)以下/);
      if (mm) {
        conditions.push({ c: "lifeAtMost", n: num(mm[1]) });
        matched = true;
        continue;
      }
      mm = part.match(
        /自分のセンターホロメンとコラボホロメンが#([^、を]+?)を持つホロメン/,
      );
      if (mm) {
        conditions.push({
          c: "cond",
          cond: { c: "frontBothMatch", filter: { tag: mm[1] } },
          text: part,
        });
        matched = true;
        continue;
      }
      // 汎用条件 (parseCondで解析できるものは実行時評価)
      {
        const cond = parseCond(part.replace(/の?時$/, ""));
        if (cond) {
          conditions.push({ c: "cond", cond, text: part });
          matched = true;
          continue;
        }
      }
      conditions.push({ c: "unsupported", text: part });
      matched = true;
    }
    if (!matched) conditions.push({ c: "unsupported", text: body });
    rest = rest.replace(m[0], "");
  }
  return { conditions, rest, allowFirstPlayerFirstTurnOshiNames };
}
