// カード本文の解析：oshi。
import type { Color } from "../../data/types";
import { parseEffect } from "./compound";
import { parseCond } from "./conditions";
import { parseSubjectFilter } from "./filters";
import { normalizeText, num, COLOR_RE } from "./normalization";
import type { OshiReactive, TargetFilter, OshiConditional, Op } from "./types";

const SUPPORTED_OSHI_STAGE_SKILLS = new Set([
  "ドドドライブ",
  "Justiceの古代自動人形",
  "はあちゃまなう",
  "準備は出来てるよね!",
  "ETERNiTY FRONTiER",
  "もう金曜だねルイ姉",
  "WORLD DOMINATION",
  "浜辺のヴィーナス",
  "魔性の再演",
  "助手くん限定の『こよ色観測』",
  "秩序を守る署長",
  "目指せ、宇宙一の番長！",
  "鉄の胃袋大魔神",
  "TO THE FORGE NOW",
  "魔弾の射手",
  "至福のひととき",
]);

export function isOshiStageSkillSupported(name: string): boolean {
  return SUPPORTED_OSHI_STAGE_SKILLS.has(name);
}

/**
 * リアクティブ推しスキルの解析。該当しない/未対応なら null。
 */
export function parseOshiReactive(
  text: string | undefined,
): OshiReactive | null {
  if (!text) return null;
  text = normalizeText(text);
  // ヘッダ等の [] を除去する。ただし [〈A〉と〈B〉] のような名称選択括弧や
  // [Buzzか2nd] のようなレベル選択括弧は効果本文なので残す
  const t = text
    .replace(/\[(?![^\]]*〈)(?![^\]]*(?:Buzz|Debut|1st|2nd|Spot))[^\]]*\]/g, "")
    .trim();

  if (
    /^自分のパフォーマンスステップが終了する時に使える[:：]このターンに自分の#歌を持つホロメンがアーツを使った回数1回につき、自分のデッキを1枚引く。?$/.test(
      t,
    )
  )
    return {
      when: "selfPerfStepEnd",
      ops: [{ t: "drawPerArtTag", tag: "歌" }],
    };

  if (
    /^自分の赤ホロメンの能力で手札をアーカイブする時に使える[:：]アーカイブする手札1枚につき自分のホロパワー1枚を、かわりにアーカイブできる。?$/.test(
      t,
    )
  )
    return { when: "handArchiveByRedAbility" };
  if (
    /^自分のターンが終了する時、このターンに自分の〈音乃瀬奏〉がセンターポジションでアーツを使っていたなら使える[:：]自分のセンターホロメンと自分の#ReGLOSSを持つバックホロメン1人を交代させる。?$/.test(
      t,
    )
  )
    return {
      when: "selfEndStepStart",
      extraCond: {
        c: "allyUsedArtThisTurn",
        names: ["音乃瀬奏"],
        pos: "center",
      },
      ops: [{ t: "swapCenter", side: "own", filter: { tag: "ReGLOSS" } }],
    };

  // ダメージ軽減: 相手のターンで、自分の(F)が相手からダメージを受ける時に使える：
  let m = t.match(
    /^(相手のターンで、)?(自分の.+?)が相手からダメージを受ける時に使える[:：](?:自分の)?.+?(?:(\d+)人|全員)が受けるダメージ-(\d+)。?$/,
  );
  if (m) {
    const filter = parseSubjectFilter(m[2]);
    if (filter === null) return null;
    return {
      when: "damagedByOpp",
      oppTurnOnly: !!m[1],
      filter,
      reduce: num(m[4]),
      ...(m[3] === undefined ? { reduceAll: filter } : {}),
    };
  }

  // アーツダメージの身代わり (redirect形):
  // 自分のホロメン1人が相手からアーツダメージを受ける時、自分のステージの[AかB]の(色)ホロメン1人を選べる：そのダメージを、選んだホロメンがかわりに受ける。
  m = t.match(
    new RegExp(
      `^自分のホロメン1人が相手からアーツダメージを受ける時、自分のステージの\\[([^\\]]+)\\]の${COLOR_RE}?ホロメン1人を選べる[:：]そのダメージを、選んだホロメンがかわりに受ける。?$`,
    ),
  );
  if (m) {
    const branch = (x: string): TargetFilter | null => {
      x = x.trim().replace(/ホロメン$/, "");
      if (x === "Buzz") return { buzz: true };
      if (x === "Debut" || x === "1st" || x === "2nd" || x === "Spot")
        return { bloomLevel: x };
      return null;
    };
    const parts = m[1].split("か").map(branch);
    if (parts.every((x): x is TargetFilter => x !== null)) {
      const redirect: TargetFilter = { anyOf: parts };
      if (m[2]) redirect.color = m[2] as Color;
      return { when: "damagedByOpp", redirect };
    }
  }

  // ダメージを受ける時 (ops形): 相手のターンで、自分の(F)が相手からダメージを受ける時に使える：(効果)
  m = t.match(
    /^(相手のターンで、)?(自分の.+?)が相手からダメージを受ける時に使える[:：](.+)$/,
  );
  if (m) {
    const filter = parseSubjectFilter(m[2]);
    const program = parseEffect(m[3]);
    if (filter !== null && program && program.ops.length > 0)
      return {
        when: "damagedByOpp",
        oppTurnOnly: !!m[1],
        filter,
        ops: program.ops,
      };
  }

  // 自分のホロメンがダウンした時に使える：(効果)
  m = t.match(
    /^(相手のターンで、)?(自分の.+?)(?:ホロメン)?がダウンした時に使える[:：](.+)$/,
  );
  if (m) {
    const filter = parseSubjectFilter(m[2]);
    const program = parseEffect(m[3]);
    if (filter === null || !program || program.ops.length === 0) return null;
    return { when: "downedOwn", oppTurnOnly: !!m[1], filter, ops: program.ops };
  }

  // 自分のホロメンが相手のホロメンをダウンさせた時に使える：(効果)
  // (「(前提条件)で、」の前置きに対応: 「自分のデッキの枚数がX枚以下で、〜」)
  m = t.match(
    /^(?:(.+?)で、)?(自分の.+?)が相手の(センター|コラボ)?ホロメンをダウンさせた時に使える[:：](.+)$/,
  );
  if (m) {
    const extraCond = m[1] ? parseCond(m[1]) : undefined;
    if (m[1] && !extraCond) return null;
    const filter = parseSubjectFilter(m[2]);
    const program = parseEffect(m[4]);
    if (filter === null || !program || program.ops.length === 0) return null;
    return {
      when: "downedOpp",
      filter,
      downedPos: m[3] === "コラボ" ? "collab" : m[3] ? "center" : undefined,
      ops: program.ops,
      extraCond: extraCond ?? undefined,
    };
  }

  // 「に使える」を伴わないダウンさせた時形: 自分の(F)が相手のホロメンをダウンさせた時、(効果) (白上フブキSP)
  m = t.match(
    /^(自分の.+?)が相手の(センター|コラボ)?ホロメンをダウンさせた時、(.+)$/,
  );
  if (m) {
    const filter = parseSubjectFilter(m[1]);
    const program = parseEffect(m[3]);
    if (filter !== null && program && program.ops.length > 0)
      return {
        when: "downedOpp",
        filter,
        downedPos: m[2] === "コラボ" ? "collab" : m[2] ? "center" : undefined,
        ops: program.ops,
      };
  }

  // (この推しホロメンか)自分の(F)が相手のバックホロメンにダメージを与えた時に使える：(効果)
  m = t.match(
    /^(この推しホロメンか)?(自分の(?:ステージの)?.+?)が相手のバックホロメンにダメージを与えた時に使える[:：](.+)$/,
  );
  if (m) {
    const filter = parseSubjectFilter(m[2].replace("ステージの", ""));
    const program = parseEffect(m[3]);
    if (filter === null || !program || program.ops.length === 0) return null;
    return {
      when: "dealtDamageToOppBack",
      filter,
      includeOshi: m[1] ? true : undefined,
      ops: program.ops,
    };
  }

  // 自分の(F)が相手のセンターホロメンかコラボホロメンにダメージを与えた時に使える：(効果)
  m = t.match(
    /^(自分の.+?)が相手のセンターホロメンかコラボホロメンにダメージを与えた時に使える[:：](.+)$/,
  );
  if (m) {
    const filter = parseSubjectFilter(m[1]);
    const program = parseEffect(m[2]);
    if (filter === null || !program || program.ops.length === 0) return null;
    return { when: "dealtDamageToOppFront", filter, ops: program.ops };
  }

  // 相手のホロメンX人に特殊ダメージを与えた時に使える：(効果)
  m = t.match(
    /^相手のホロメン(\d+)人に特殊ダメージを与えた時に使える[:：](.+)$/,
  );
  if (m) {
    const program = parseEffect(m[2]);
    if (!program || program.ops.length === 0) return null;
    return { when: "dealtSpecial", ops: program.ops };
  }

  // 自分の(F)の能力でサイコロを振る時に使える：目の宣言 (AZKi推し)
  m = t.match(
    /^(自分の.+?)の能力でサイコロを振る時に使える[:：]サイコロの目の数1つを宣言し、次に出る目の数を宣言した目として扱う。?$/,
  );
  if (m) {
    const filter = parseSubjectFilter(m[1]);
    if (filter !== null)
      return { when: "diceRolling", filter, ops: [{ t: "declareDice" }] };
  }

  // 自分の(F)の能力でサイコロを振った時に使える：振り直し (紫咲シオン推し)
  m = t.match(
    /^(自分の.+?)の能力でサイコロを振った時に使える[:：]サイコロを1回振り直す。?$/,
  );
  if (m) {
    const filter = parseSubjectFilter(m[1]);
    if (filter !== null)
      return { when: "diceRolled", filter, ops: [{ t: "rerollDice" }] };
  }

  // 自分の(F)の能力でエールをアーカイブした時に使える：(効果)
  m = t.match(/^(自分の.+?)の能力でエールをアーカイブした時に使える[:：](.+)$/);
  if (m) {
    const filter = parseSubjectFilter(m[1]);
    const program = parseEffect(m[2]);
    if (filter === null || !program || program.ops.length === 0) return null;
    return { when: "yellArchivedByAbility", filter, ops: program.ops };
  }

  // 自分の(色)センターホロメンがアーツを使った時に使える：(効果)
  m = t.match(
    new RegExp(
      `^自分の${COLOR_RE}センターホロメンがアーツを使った時に使える[:：](.+)$`,
    ),
  );
  if (m) {
    const program = parseEffect(m[2]);
    if (!program || program.ops.length === 0) return null;
    return {
      when: "artUsedByCenter",
      filter: { color: m[1] as Color },
      ops: program.ops,
    };
  }

  return null;
}

export function parseOshiConditional(
  text: string | undefined,
): OshiConditional | null {
  if (!text) return null;
  text = normalizeText(text);
  const t = text.replace(/\[[^\]]*\]/g, "").trim();
  const m = t.match(/^(.+?)(?:の時に|なら)使える[:：](.+)$/);
  if (!m) return null;
  // リアクティブ系 (受ける時/した時) は除外
  if (/(受ける|した|する)$/.test(m[1])) return null;
  const cond = parseCond(m[1]);
  const program = parseEffect(m[2]);
  if (!cond || !program || program.ops.length === 0) return null;
  return { cond, ops: program.ops };
}

/** 条件付き使用・任意効果と区別して、本文先頭の必須追加コストを取り出す。 */
export function parseOshiAdditionalCost(text: string): Op[] {
  const body = normalizeText(text)
    .replace(/\[[^\]]*\]/g, "")
    .trim();
  const prefix = body.match(/^([^：]+)：/);
  if (!prefix || /(使える|できる|選べる|振れる)$/.test(prefix[1])) return [];
  return parseEffect(prefix[1])?.ops ?? [];
}
