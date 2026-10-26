// カード本文の解析：sentences。
import type { Color } from "../../data/types";
import { parseCond, parsePerClause, parseDiceCond } from "./conditions";
import { matchArtCostMod, matchArtGate } from "./costs";
import {
  parseStackTarget,
  parseCheerTargetLoose,
  parseCardFilter,
  parseTargetFilterMods,
  cheerTargetFilter,
  parseAttachTarget,
  parseSubjectFilter,
} from "./filters";
import { num, parseNames, COLOR_RE, ANY_COUNT } from "./normalization";
import { applyNoLifeRider } from "./operations";
import type { Op, TargetFilter, Cond, CardFilter, DiceBranch } from "./types";

/** 「ただし、数える枚数/人数はXまで」の但し書き */
export const COUNT_CAP_RIDER =
  /^ただし、数える(?:枚数|人数)は(\d+)(?:枚|人)まで$/;

const IGNORABLE = [
  /^マスコットは、自分のホロメン\d+人につき\d+枚だけ付けられる$/,
  /^ツールは、自分のホロメン\d+人につき\d+枚だけ付けられる$/,
  /^このファンは、.*付けられる$/,
  /^LIMITED[:：]ターンに\d+枚しか使えない$/,
  COUNT_CAP_RIDER,
  /^自分の〈[^〉]+〉はターンに\d+回しか使えない$/,
  /^自分の#[^\s、]+を持つイベントはターンに\d+回しか使えない$/,
  /^自分のブルームエフェクト「[^」]+」はターンに\d+回しか使えない$/,
];

/** ライフ非減少の但し書き */
export const NO_LIFE_RIDER =
  /^ただし、(この能力で)?ダウンしても(相手の)?ライフは減らない$/;

/**
 * デッキは非公開領域なので、テキストが「公開し」を伴わずに手札へ加える検索は、
 * 加えたカードの名称を相手に見せてはいけない (総合ルール4章の領域の公開性)。
 * 生成箇所が多いので、文単位で後から印を付ける。
 */
function markHiddenSearch(ops: Op[], sentence: string): Op[] {
  if (/公開/.test(sentence)) return ops;
  const visit = (items: Op[]): void => {
    for (const op of items) {
      if (op.t === "searchDeck" && op.dest === "hand") op.noReveal = true;
      const rec = op as unknown as Record<string, unknown>;
      for (const key of ["then", "else", "ops", "thenOps", "elseOps"]) {
        const inner = rec[key];
        if (Array.isArray(inner)) visit(inner as Op[]);
      }
      if (Array.isArray(rec.branches))
        for (const b of rec.branches as { ops?: Op[] }[])
          if (b.ops) visit(b.ops);
    }
  };
  visit(ops);
  return ops;
}

export function parseSentence(text: string): Op[] | null {
  const original = text;
  const parsed = parseSentenceInner(text);
  return parsed === null ? null : markHiddenSearch(parsed, original);
}

function parseSentenceInner(text: string): Op[] | null {
  text = text
    .trim()
    .replace(/^■/, "")
    .replace(/^さらに、/, "")
    .replace(/^その後、/, "")
    .trim();
  if (!text) return [];
  if (IGNORABLE.some((re) => re.test(text))) return [];

  // アーツの対象制限は useArts 側で検証するためここでは無視する
  if (
    /^このアーツは、相手の(センター|バック)ホロメンしか対象にできない$/.test(
      text,
    )
  )
    return [];
  // アーツの対象拡張 (バックも対象にできる) も useArts 側で検証する
  if (/^このアーツは、?相手のバックホロメンも対象にできる$/.test(text))
    return [];

  // アーツ自身のコスト軽減文は canPayArtCost が使用時に適用する (実行時は無処理)
  if (matchArtCostMod(text)) return [];

  // アーツの使用ゲート (「このアーツは、〜と使えない」) は useArts が検証する (実行時は無処理)
  if (matchArtGate(text)) return [];

  let m: RegExpMatchArray | null;
  m = text.match(/^自分のデッキを下から(\d+)枚引く$/);
  if (m) return [{ t: "draw", n: num(m[1]), fromBottom: true }];
  m = text.match(/^お互いそれぞれのデッキを(\d+)枚引く$/);
  if (m)
    return [
      { t: "draw", n: num(m[1]) },
      { t: "oppDraw", n: num(m[1]) },
    ];
  m = text.match(
    /^(?:自分の)?手札(\d+)枚を(?:好きな順で)?デッキの(上|下)に戻す$/,
  );
  if (m) return [{ t: "handToDeckBottom", n: num(m[1]), top: m[2] === "上" }];
  m = text.match(
    /^相手のステージの(ツール|マスコット|ファン)(\d+)枚をアーカイブする$/,
  );
  if (m)
    return [
      {
        t: "archiveOppAttached",
        kind: m[1] as "ツール",
        n: num(m[2]),
        allStage: true,
      },
    ];
  m = text.match(/^このアーツ-(\d+)$/);
  if (m) return [{ t: "artPlus", value: -num(m[1]) }];
  m = text.match(
    /^直前の相手のターンに、?ダウンしていた自分のホロメン1人につき、このアーツ\+(\d+)$/,
  );
  if (m) return [{ t: "artPlusPer", per: "downsPrevTurn", value: num(m[1]) }];
  m = text.match(
    /^自分のアーカイブの((?:〈[^〉]+〉)+)1枚につき、(.+?)のHP(\d+)回復$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "heal",
          value: num(m[3]),
          target: tgt.target,
          filter: tgt.filter,
          perArchiveNames: parseNames(m[1]),
        },
      ];
  }
  m = text.match(
    /^(?:この能力で)?アーカイブした(?:サポート|ホロパワー)1枚につき、このターンの間、(.+?)のアーツ\+(\d+)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          per: "milled",
          milledSupportCount: text.includes("サポート"),
          value: num(m[2]),
          target: tgt.target,
          filter: tgt.filter,
        },
      ];
  }

  // --- ドロー ---
  m = text.match(/^自分のデッキを(\d+)枚引(く|ける)$/);
  if (m)
    return [
      { t: "draw", n: num(m[1]), optional: m[2] === "ける" || undefined },
    ];
  m = text.match(/^相手は、?自身のデッキを(\d+)枚引(く|ける)$/);
  if (m)
    return [
      { t: "oppDraw", n: num(m[1]), optional: m[2] === "ける" || undefined },
    ];
  m = text.match(/^相手は、?自身の手札(\d+)枚をアーカイブする$/);
  if (m) return [{ t: "oppArchiveHand", n: num(m[1]) }];
  m = text.match(
    /^自分のデッキを(下から)?(\d+)枚引いた後、手札(\d+)枚をアーカイブする$/,
  );
  if (m)
    return [
      {
        t: "drawThenArchive",
        draw: num(m[2]),
        archive: num(m[3]),
        fromBottom: !!m[1],
      },
    ];
  m = text.match(
    /^自分のデッキを(\d+)枚引いた後、手札(\d+)枚をデッキの下に戻す$/,
  );
  if (m)
    return [
      { t: "draw", n: num(m[1]) },
      { t: "handToDeckBottom", n: num(m[2]) },
    ];
  m = text.match(/^手札が(\d+)枚になるまで、自分のデッキを引く$/);
  if (m) return [{ t: "drawUntil", n: num(m[1]) }];
  m = text.match(
    /^自分の手札が自分のステージの((?:〈[^〉]+〉)+)の枚数と同じになるまで、自分のデッキを引く$/,
  );
  if (m) return [{ t: "drawUntilStageNames", names: parseNames(m[1]) }];
  m = text.match(
    /^(?:この能力で)?アーカイブした(?:カード|エール)(\d+)枚につき、自分のデッキを(\d+)枚引く$/,
  );
  if (m) return [{ t: "drawPerMilled", per: num(m[1]), draw: num(m[2]) }];
  m = text.match(
    /^(?:この能力で)?アーカイブした(?:カード|エール)(\d+)枚につき、自分のエールデッキの上から(\d+)枚を、?(.+?)に送(?:る|れる)$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[3]) ?? parseCheerTargetLoose(m[3]);
    if (tgt)
      return [
        {
          t: "cheerFromTopPerMilled",
          per: num(m[1]),
          n: num(m[2]),
          target: tgt.target,
          filter: tgt.filter,
          sameTarget: tgt.count === 1 || undefined,
        },
      ];
  }
  m = text.match(
    /^自分の手札すべてをデッキに戻してシャッフルする。?そして自分のデッキを(\d+)枚引く$/,
  );
  if (m) return [{ t: "shuffleHandIntoDeck", thenDraw: num(m[1]) }];
  if (/^自分の手札すべてをデッキに戻してシャッフルする$/.test(text))
    return [{ t: "shuffleHandIntoDeck", thenDraw: 0 }];
  if (/^お互いの手札すべてをデッキに戻してシャッフルする$/.test(text))
    return [{ t: "bothShuffleHandIntoDeck", thenDraw: 0 }];
  if (
    /^(?:自分の手札を数えて、)?自分の\[手札すべてとアーカイブのホロメンすべて\]をデッキに戻してシャッフルする$/.test(
      text,
    )
  )
    return [{ t: "handArchiveHolomenToDeckShuffle" }];
  m = text.match(
    /^手札からデッキに戻したカード(\d+)枚につき、自分のデッキを(\d+)枚引く$/,
  );
  if (m) return [{ t: "drawPerHandReturned", per: num(m[1]), draw: num(m[2]) }];
  if (/^相手の手札すべてを見る$/.test(text)) return [{ t: "revealOppHand" }];
  m = text.match(
    /^お互いのステージのエール(\d+)枚につき、自分のデッキを(\d+)枚引く$/,
  );
  if (m)
    return [{ t: "drawPerBothStageYell", per: num(m[1]), draw: num(m[2]) }];

  // じゃんけんを必ず行い、勝った場合に続く本文だけを実行する。
  m = text.match(
    /^相手と勝敗が決まるまでじゃんけんする[:：]自分が勝ったなら、(.+)$/,
  );
  if (m) {
    const winOps = parseSentence(m[1]);
    return winOps ? [{ t: "janken", winOps }] : null;
  }

  // --- シャッフル ---
  if (/^そして(自分の)?デッキをシャッフルする$/.test(text))
    return [{ t: "shuffleDeck" }];
  if (/^そして(自分の)?エールデッキをシャッフルする$/.test(text))
    return [{ t: "shuffleCheer" }];

  // --- 公開したカードの移動 ---
  if (/^そして公開したカードをアーカイブする$/.test(text))
    return [{ t: "revealedTo", dest: "archive" }];
  if (/^(?:そして公開した|その)カードを手札に加える$/.test(text))
    return [{ t: "revealedTo", dest: "hand" }];
  m = text.match(
    /^(?:そして公開した|その)カードを(好きな順で)?デッキの(上|下)に戻す$/,
  );
  if (m)
    return [
      {
        t: "revealedTo",
        dest: m[2] === "上" ? "deckTop" : "deckBottom",
        orderMatters: !!m[1] || undefined,
      },
    ];
  if (/^そして公開したカードを裏向きにしてホロパワーの下に戻す$/.test(text))
    return [{ t: "revealedTo", dest: "holoBottom" }];

  m = text.match(
    /^(.+?)に、自分のステージのエール1枚につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m) {
    const target = parseStackTarget(m[1]);
    if (target)
      return [
        {
          t: "special",
          dmg: num(m[2]),
          ...target,
          scaleBy: { kind: "stageYell" },
        },
      ];
  }
  m = text.match(
    /^自分のアーカイブの(.+?)1枚につき、このターンの間、(.+?)のアーツ\+(\d+)$/,
  );
  if (m) {
    const filter = parseCardFilter(m[1]),
      target = parseStackTarget(m[2]);
    if (filter && target)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[3]),
          per: "archiveFilter",
          countFilter: filter,
          ...target,
        },
      ];
  }

  // --- 相手前列へのエール数比例特殊ダメージ ---
  m = text.match(
    /^相手のセンターホロメンとコラボホロメンに、相手のセンターホロメンのエール(\d+)枚につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[1]) === 1)
    return [
      { t: "specialPerOppCenterYell", per: num(m[2]), target: "allOppFront" },
    ];
  m = text.match(
    /^相手のセンターホロメンに、相手のセンターホロメンのエール(\d+)枚につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[1]) === 1)
    return [
      { t: "specialPerOppCenterYell", per: num(m[2]), target: "oppCenter" },
    ];

  // --- ターン中アーツ+X + 無色コスト-Y の複合 ---
  m = text.match(
    /^このターンの間、(.+?)のアーツ\+(\d+)し、そのホロメンのアーツに必要な(?:◇|無色)-(\d+)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "turnArtPlus",
          value: num(m[2]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
        {
          t: "turnCostMod",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          artCostless: num(m[3]),
        },
      ];
  }

  // --- 特殊ダメージ (複合対象: センター+バックX人) ---
  m = text.match(
    /^相手のセンターホロメンとバックホロメン(\d+)人に特殊ダメージ(\d+)を与える$/,
  );
  if (m)
    return [
      {
        t: "special",
        dmg: num(m[2]),
        target: "chooseOppBack",
        includeOppCenter: true,
        count: num(m[1]),
      },
    ];

  // --- 特殊ダメージ (自分のステージの異なるカード名#tag持ち人数に比例) ---
  m = text.match(
    /^相手のセンターホロメン(とコラボホロメン)?に、自分のステージの異なるカード名の#([^、を]+?)を持つホロメン(\d+)人につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[3]) === 1)
    return [
      {
        t: "special",
        dmg: num(m[4]),
        scaleBy: { kind: "stageTagDistinct", tag: m[2] },
        target: m[1] ? "allOppFront" : "oppCenter",
      },
    ];

  // --- 特殊ダメージ (自分の#tag持ちホロメン人数に比例, 対象は任意) ---
  m = text.match(
    /^(.+?)に、自分の(?:ステージの)?(異なるカード名の)?#([^、を]+?)を持つ(バック)?(Debut|1st|2nd|Spot)?ホロメン(\d+)人につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[6]) === 1) {
    const tgt = parseStackTarget(m[1]);
    const bloomLevel = m[5] as "Debut" | "1st" | "2nd" | "Spot" | undefined;
    if (tgt && !(bloomLevel && (m[2] || m[4]))) {
      const distinct = !!m[2];
      const tag = m[3];
      const backHolomen = !!m[4];
      const kind = backHolomen
        ? distinct
          ? "backTagDistinct"
          : "backTag"
        : distinct
          ? "stageTagDistinct"
          : "stageTag";
      return [
        {
          t: "special",
          dmg: num(m[7]),
          scaleBy:
            kind === "stageTag" ? { kind, tag, bloomLevel } : { kind, tag },
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
    }
  }

  // --- 特殊ダメージ (アーツ対象のバトンコストに比例) ---
  m = text.match(
    /^このアーツの対象のホロメンに、そのホロメンのバトンタッチに必要な(?:◇|無色)(\d+)つにつき、特殊ダメージ(\d+)を与える$/,
  );
  if (m)
    return [{ t: "specialPerArtTargetBaton", per: num(m[1]), dmg: num(m[2]) }];

  // --- このアーツで与えたダメージに比例した自己回復 (ダメージ適用後に実行) ---
  m = text.match(
    /^このアーツで相手のホロメンにダメージを与えた時、与えたダメージ(\d+)につき、このホロメンのHP(\d+)回復$/,
  );
  if (m) return [{ t: "healSelfPerArtDealt", per: num(m[1]), heal: num(m[2]) }];

  // --- ドロー + 相手センターのバトンコスト比例ドロー ---
  m = text.match(
    /^自分のデッキを(\d+)枚引き、相手のセンターホロメンのバトンタッチに必要な(?:◇|無色)(\d+)つにつき、自分のデッキを(\d+)枚引く$/,
  );
  if (m)
    return [
      { t: "draw", n: num(m[1]) },
      { t: "drawPerOppCenterBaton", per: num(m[2]), draw: num(m[3]) },
    ];

  // --- 特殊ダメージ (このターンに能力でサイコロを振った回数に比例) ---
  m = text.match(
    /^(.+?)に、このターンに自分が能力でサイコロを振った回数(\d+)回につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[2]) === 1) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "special",
          dmg: num(m[3]),
          scaleBy: { kind: "diceRolls" },
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- 特殊ダメージ (この効果で回復した量に比例) ---
  m = text.match(
    /^(?:その後、)?(.+?)に、回復したダメージ(\d+)につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "special",
          dmg: num(m[3]),
          dmgFrom: "healed",
          dmgFromPer: num(m[2]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- 特殊ダメージ (相手バック全員の被ダメージ合計と同値) ---
  if (
    /^相手のセンターホロメンに、相手のバックホロメン全員が受けているダメージの合計数と同じ数値の特殊ダメージを与える$/.test(
      text,
    )
  )
    return [
      {
        t: "special",
        dmg: 0,
        dmgFrom: "oppBackDamageSum",
        target: "oppCenter",
      },
    ];

  // --- 特殊ダメージ (アーカイブしたカード枚数に比例) ---
  m = text.match(
    /^(.+?)に、?アーカイブしたカード(\d+)枚につき、?特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[2]) === 1) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "special",
          dmg: num(m[3]),
          scaleBy: { kind: "milled" },
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- 特殊ダメージ (自分のセンターの〈N〉に重なっているホロメン枚数に比例) ---
  m = text.match(
    /^(.+?)に、自分のセンターホロメンの((?:〈[^〉]+〉)+)に重なっているホロメン(\d+)枚につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[3]) === 1) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "special",
          dmg: num(m[4]),
          scaleBy: { kind: "centerNameStacked", names: parseNames(m[2]) },
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- 特殊ダメージ (自分のアーカイブの(F)枚数に比例) ---
  m = text.match(
    /^(.+?)に、自分のアーカイブの(.+?)(\d+)枚につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[3]) === 1) {
    const tgt = parseStackTarget(m[1]);
    const f = parseCardFilter(m[2]);
    if (tgt && f)
      return [
        {
          t: "special",
          dmg: num(m[4]),
          scaleBy: { kind: "archiveFilter", filters: f.alt ?? [f] },
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- 特殊ダメージの割り振り (「特殊ダメージXをYずつ割り振って与える」) ---
  m = text.match(
    /^相手のバックホロメンに特殊ダメージ(\d+)を(\d+)ずつ割り振って与える$/,
  );
  if (m) {
    const total = num(m[1]);
    const per = num(m[2]);
    const k = Math.floor(total / per);
    if (k >= 1) {
      return [
        { t: "special", dmg: per, target: "chooseOppBack", allocationCount: k },
      ];
    }
  }

  // --- 特殊ダメージ (選んだホロメンの被ダメージと同値) ---
  if (
    /^選んだホロメンに、選んだホロメンが受けているダメージと同じ数値の特殊ダメージを与える$/.test(
      text,
    )
  )
    return [{ t: "special", dmg: 0, dmgFrom: "boundDamage", target: "bound" }];

  // --- 特殊ダメージ ---
  m = text.match(
    /^(.+?)に特殊ダメージ(\d+)を与える(?:（ダウンしても相手のライフは減らない）)?$/,
  );
  if (m) {
    const noLife = text.includes("ライフは減らない");
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "special",
          dmg: num(m[2]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          noLife,
        },
      ];
  }

  // --- 相手の推しと異なる色のホロメン数比例 (回復 / ドロー) ---
  m = text.match(
    /^相手の推しホロメンと異なる色を持つ相手のステージのホロメン(\d+)人につき、(.+?)のHP(\d+)回復$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "heal",
          value: num(m[3]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          scaleBy: "oppOshiDiffColor",
        },
      ];
  }
  m = text.match(
    /^相手の推しホロメンと異なる色を持つ相手のステージのホロメン(\d+)人につき、自分のデッキを(\d+)枚引く$/,
  );
  if (m && num(m[1]) === 1)
    return [{ t: "drawPerOppOshiDiff", per: num(m[1]), draw: num(m[2]) }];

  // --- 回復 (ステージのエール色数につき) ---
  m = text.match(/^自分のステージのエール(\d+)色につき、(.+?)のHP(\d+)回復$/);
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "heal",
          value: num(m[3]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          scaleBy: "stageYellColors",
        },
      ];
  }

  // --- 回復 ---
  m = text.match(/^(.+?)のHP(\d+)回復$/);
  if (m) {
    const tgt = parseStackTarget(m[1]) ?? parseCheerTargetLoose(m[1]);
    if (tgt)
      return [
        {
          t: "heal",
          value: num(m[2]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  m = text.match(/^(.+?)のHPを(\d+)回復する$/);
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "heal",
          value: num(m[2]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  m = text.match(/^(.+?)のHPすべて回復$/);
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "heal",
          value: "all",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- 残りHPをXにする ---
  m = text.match(/^(.+?)の残りHPを(\d+)にする$/);
  if (m) {
    const tgt = parseStackTarget(m[1]);
    // 対象の絞り込み (「センターポジションの2ndホロメン」等) を捨てない
    if (tgt)
      return [
        {
          t: "setHp",
          target: tgt.target,
          value: num(m[2]),
          ...(tgt.filter ? { filter: tgt.filter } : {}),
        },
      ];
  }

  // --- このアーツ+X ---
  m = text.match(/^このアーツ\+(\d+)$/);
  if (m) return [{ t: "artPlus", value: num(m[1]) }];
  m = text.match(/^(.+?)、このアーツ\+(\d+)(?:（エールは最大(\d+)枚まで）)?$/);
  if (m) {
    const cond = parseCond(m[1]);
    if (cond)
      return [{ t: "if", cond, then: [{ t: "artPlus", value: num(m[2]) }] }];
    const per = parsePerClause(m[1], num(m[2]), m[3] ? num(m[3]) : undefined);
    if (per) return [per];
    // 「条件なら、〜X枚につき」= 条件付きの比例加算
    const cm = m[1].match(/^(.+?)(?:なら|の時)、(.+)$/);
    if (cm) {
      const cCond = parseCond(cm[1]);
      const cPer = cCond
        ? parsePerClause(cm[2], num(m[2]), m[3] ? num(m[3]) : undefined)
        : null;
      if (cCond && cPer) return [{ t: "if", cond: cCond, then: [cPer] }];
    }
  }

  // --- (比例)X枚につき、このアーツ+X し、自分のデッキをY枚引く ---
  // 「〜につき」は後続のドローにも掛かる (公式Q598: 〈35P〉2枚なら2枚引く)。
  // 比例の対象を表現できる形だけ比例ドローにし、それ以外は素のドローに落とす。
  m = text.match(/^(.+?)、このアーツ\+(\d+)し、自分のデッキを(\d+)枚引く$/);
  if (m) {
    const per = parsePerClause(m[1], num(m[2]));
    if (per && per.t === "artPlusPer" && per.per === "attachedName")
      return [
        per,
        {
          t: "drawPerAttachedName",
          names: per.names ?? [],
          per: per.perN ?? 1,
          draw: num(m[3]),
        },
      ];
    if (per) return [per, { t: "draw", n: num(m[3]) }];
  }

  // --- このターンの間、自分のステージのエールX枚につき、(対象)のアーツ+X ---
  m = text.match(
    /^このターンの間、自分のステージのエール(\d+)枚につき、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[3]),
          per: "stageYell",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- このターンの間、選んだホロメンのエールX枚につきアーツ+X ---
  m = text.match(
    /^このターンの間、選んだホロメンのエール(\d+)枚につき、選んだホロメンのアーツ\+(\d+)$/,
  );
  if (m && num(m[1]) === 1)
    return [{ t: "turnArtPlusPerBoundYell", value: num(m[2]) }];

  // --- このターンの間、(枚数参照)X枚につき、(対象)のアーツ+X ---
  m = text.match(
    /^このターンの間、(自分のセンターホロメン|このホロメン)のエール(\d+)枚につき、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[2]) === 1) {
    const tgt = parseStackTarget(m[3]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[4]),
          per: m[1] === "このホロメン" ? "selfYell" : "centerYell",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  // このホロメンの(色)エールX枚につき
  m = text.match(
    new RegExp(
      `^このターンの間、このホロメンの${COLOR_RE}エール(\\d+)枚につき、(.+?)のアーツ\\+(\\d+)$`,
    ),
  );
  if (m && num(m[2]) === 1) {
    const tgt = parseStackTarget(m[3]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[4]),
          per: "selfYellColor",
          color: m[1] as Color,
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  // 自分のステージの〈N〉X枚につき (ホロメン+付与サポートを名称で数える)
  m = text.match(
    /^このターンの間、自分のステージの((?:〈[^〉]+〉)+)(\d+)枚につき、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[2]) === 1) {
    const tgt = parseStackTarget(m[3]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[4]),
          per: "stageNames",
          names: parseNames(m[1]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  // このホロメンと自分のコラボホロメンのアーツ+X (2対象へ同時付与)
  m = text.match(
    /^このターンの間、このホロメンと自分のコラボホロメンのアーツ\+(\d+)$/,
  );
  if (m)
    return [
      { t: "turnArtPlus", value: num(m[1]), target: "self" },
      { t: "turnArtPlus", value: num(m[1]), target: "ownCollab" },
    ];
  // このターンの間、アーカイブしたカードX枚につき、(対象)のアーツ+X (語順違い)
  m = text.match(
    /^このターンの間、(?:この能力で)?アーカイブしたカード(\d+)枚につき、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[3]),
          per: "milled",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  // 自分のステージの(異なるカード名の)#Tを持つホロメンX人につき
  m = text.match(
    /^このターンの間、自分のステージの(異なるカード名の)?#([^、を]+?)を持つホロメン(\d+)人につき、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[3]) === 1) {
    const tgt = parseStackTarget(m[4]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[5]),
          per: "stageTag",
          tag: m[2],
          distinctNames: !!m[1],
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  // このターンに自分が使っていたサポートカードX枚につき、このターンの間、〜のアーツ+X
  m = text.match(
    /^このターンに自分が使っていたサポートカード(\d+)枚につき、このターンの間、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[3]),
          per: "usedSupport",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  // この能力でアーカイブしたカードX枚につき、このターンの間、〜のアーツ+X
  m = text.match(
    /^(?:この能力で)?アーカイブしたカード(\d+)枚につき、このターンの間、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[3]),
          per: "milled",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }
  m = text.match(
    /^このターンの間、(?:この能力で)?公開したサポートカード(\d+)枚につき、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[3]),
          per: "revealedSupport",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- このターンの間、〜のアーツ+X (「次の相手のターン終了時まで」は次ターンまで持続) ---
  m = text.match(
    /^(このターンの間|次の相手のターン終了時まで)、(.+?)のアーツ\+(\d+)$/,
  );
  if (m) {
    // 付属条件は選んだ時点で評価する。条件を満たさないホロメンも選べるが、強化は付与しない。
    if (m[2] === "自分のファンが付いているホロメン1人")
      return [
        { t: "chooseBind", scope: "own" },
        {
          t: "if",
          cond: { c: "boundIs", filter: { hasAttachedType: "ファン" } },
          then: [
            {
              t: "turnArtPlus",
              value: num(m[3]),
              target: "bound",
              untilNextOppTurn:
                m[1] === "次の相手のターン終了時まで" || undefined,
            },
          ],
        },
      ];
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "turnArtPlus",
          value: num(m[3]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          untilNextOppTurn: m[1] === "次の相手のターン終了時まで" || undefined,
        },
      ];
  }
  // --- 「〜のアーツ+X」単文 (このターンの間が省略された継続文) ---
  m = text.match(
    /^(自分の.+?|選んだホロメン|そのホロメン|このホロメン)のアーツ\+(\d+)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "turnArtPlus",
          value: num(m[2]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- ステージのエールをエールデッキの下に戻すコスト ---
  m = text.match(
    /^自分のステージのエール(\d+)枚をエールデッキの下に戻せる[:：](.+)$/,
  );
  if (m) {
    const then = parseSentence(m[2]);
    if (then)
      return [
        {
          t: "optionalCost",
          cost: [{ t: "stageYellToCheerBottom", n: num(m[1]), cost: true }],
          then,
          label: `ステージのエール${m[1]}枚をエールデッキの下に戻して効果を使いますか？`,
        },
      ];
  }

  // --- #tag持ちホロメンのエールをアーカイブする (主効果形) ---
  m = text.match(
    /^自分の#([^、を]+?)を持つホロメンのエール(\d+)枚をアーカイブする$/,
  );
  if (m)
    return [
      { t: "archiveStageYell", n: num(m[2]), stackFilter: { tag: m[1] } },
    ];

  // --- このホロメンのエールをバックX人にY枚ずつ付け替えるコスト ---
  m = text.match(
    /^このホロメンのエール(\d+)枚を、自分のバックホロメン(\d+)人に(\d+)枚ずつ付け替えられる[:：](.+)$/,
  );
  if (m) {
    const then = parseSentence(m[4]);
    if (then)
      return [
        {
          t: "optionalCost",
          cost: [
            {
              t: "moveYell",
              min: num(m[1]),
              max: num(m[1]),
              fromSelf: true,
              targetFilter: { position: "back" },
              perTargetMax: num(m[3]),
            },
          ],
          then,
          label: `このホロメンのエール${m[1]}枚をバックホロメン${m[2]}人に${m[3]}枚ずつ付け替えて効果を使いますか？`,
        },
      ];
  }

  // --- このアーツダメージは軽減されない ---
  if (/^(?:さらに、)?このアーツダメージは軽減されない$/.test(text))
    return [{ t: "artNoReduce" }];

  // --- 相手の[センターかコラボ]に付いているサポートのアーカイブ ---
  m = text.match(
    /^相手の\[?センターホロメンかコラボホロメン\]?に付いている(ツール|マスコット|ファン)(\d+)枚をアーカイブ(できる|する)$/,
  );
  if (m)
    return [
      {
        t: "archiveOppAttached",
        kind: m[1] as "ツール" | "マスコット" | "ファン",
        n: num(m[2]),
        optional: m[3] === "できる" || undefined,
      },
    ];

  // --- このホロメンの移動/交代 ---
  m = text.match(/^このホロメンをバックポジションに移動(できる|する|させる)$/);
  if (m) return [{ t: "selfToBack", optional: m[1] === "できる" || undefined }];
  m = text.match(
    /^自分の残りHP(\d+)以下のコラボホロメンとこのホロメンを交代(できる|する|させる)$/,
  );
  if (m)
    return [
      {
        t: "selfSwapWithCollab",
        maxRemainingHp: num(m[1]),
        optional: m[2] === "できる" || undefined,
      },
    ];

  // --- このターンのBloom回数比例のエール送付 ---
  m = text.match(
    /^このターンに自分の#([^、を]+?)を持つホロメンがBloomした回数(\d+)回につき、自分のエールデッキの上から(\d+)枚をこのホロメンに送る$/,
  );
  if (m)
    return [
      {
        t: "cheerFromTop",
        n: num(m[3]),
        target: "self",
        perBloomTag: { tag: m[1], per: num(m[2]) },
      },
    ];

  // --- 選んだホロメン関連の追加op ---
  if (
    /^選んだホロメンを含め重なっているホロメンすべてを好きな順でデッキの下に戻す$/.test(
      text,
    )
  )
    return [{ t: "boundStackAllToDeckBottom" }];
  if (/^選んだホロメンをお休みさせてバックポジションに移動させる$/.test(text))
    return [{ t: "boundRestToBack" }];
  if (
    /^選んだホロメンは、次の相手のリセットステップでアクティブにならない$/.test(
      text,
    )
  )
    return [{ t: "noActivateNextReset" }];
  if (/^このカードをデッキに戻してシャッフルする$/.test(text))
    return [{ t: "selfCardToDeck" }];
  m = text.match(/^お互いにサイコロを(\d+)回振る$/);
  if (m && num(m[1]) === 1) return [{ t: "diceVs", geOps: [], ltOps: [] }];
  m = text.match(
    /^次の相手のターンの間、選んだホロメンが(センターポジションで)?最初に受けるアーツダメージ-(\d+)$/,
  );
  if (m)
    return [
      {
        t: "turnFirstArtReduce",
        value: num(m[2]),
        target: "bound",
        pos: m[1] ? "center" : undefined,
        untilNextOppTurn: true,
      },
    ];
  // --- コラボポジションの指定名を選ぶ ---
  m = text.match(/^自分のコラボポジションの((?:〈[^〉]+〉)+)を選ぶ$/);
  if (m)
    return [
      {
        t: "chooseBind",
        filter: { names: parseNames(m[1]) },
        scope: "ownCollab",
      },
    ];

  // --- [〈A〉と〈B〉]1人ずつを選ぶ (両方を束縛) ---
  m = text.match(
    /^自分の\[((?:〈[^〉]+〉)+)と((?:〈[^〉]+〉)+)\](\d+)人ずつを選ぶ$/,
  );
  if (m && num(m[3]) === 1)
    return [
      { t: "chooseBind", filter: { names: parseNames(m[1]) }, scope: "own" },
      {
        t: "chooseBind",
        filter: { names: parseNames(m[2]) },
        scope: "own",
        append: true,
      },
    ];

  // --- 選んだホロメンに重なっているホロメンを手札に戻す ---
  m = text.match(
    /^選んだホロメンに重なっているホロメン(\d+)(?:〜(\d+))?枚を手札に戻す$/,
  );
  if (m)
    return [{ t: "stackedToHand", min: num(m[1]), max: num(m[2] ?? m[1]) }];

  // --- このターンの間、この能力で戻したホロメンX枚につき、選んだホロメンのアーツ+X ---
  m = text.match(
    /^このターンの間、この能力で戻したホロメン(\d+)枚につき、選んだホロメンのアーツ\+(\d+)$/,
  );
  if (m && num(m[1]) === 1)
    return [
      {
        t: "turnArtPlusPerCount",
        value: num(m[2]),
        per: "picked",
        target: "bound",
      },
    ];

  // --- 手札の(F)X枚を公開し、デッキの下に戻す ---
  m = text.match(/^自分の手札の(.+?)(\d+)枚を公開し、デッキの下に戻す$/);
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f) return [{ t: "handRevealToDeckBottom", n: num(m[2]), filter: f }];
  }

  m = text.match(/^(?:その|選んだ)ホロメンのアーツに必要な(?:◇|無色)-(\d+)$/);
  if (m) return [{ t: "turnCostMod", target: "bound", artCostless: num(m[1]) }];

  // --- 選んだホロメン束縛 ---
  m = text.match(
    /^(このホロメン以外の|他の)?自分の(.*?)(?:ホロメン)?を?(\d+)人を?選ぶ$/,
  );
  if (m && num(m[3]) === 1) {
    let mod = m[2]
      .replace(/^ステージの/, "")
      .replace(/^このホロメン以外の/, "");
    const excludeSource = !!m[1] || m[2].includes("このホロメン以外の");
    let scope: "own" | "ownBack" | "ownCollab" | "ownCenter" = "own";
    const pm = mod.match(/^(.*?)(バック|コラボ|センター)$/);
    if (pm) {
      mod = pm[1];
      scope =
        pm[2] === "バック"
          ? "ownBack"
          : pm[2] === "コラボ"
            ? "ownCollab"
            : "ownCenter";
    }
    const filter = parseTargetFilterMods(mod);
    if (filter !== null)
      return [
        {
          t: "chooseBind",
          filter: excludeSource
            ? { ...(filter ?? {}), excludeSource: true }
            : filter,
          scope,
        },
      ];
  }
  m = text.match(/^自分のバックポジションの(.*?)(\d+)人を選ぶ$/);
  if (m && num(m[2]) === 1) {
    const filter = parseTargetFilterMods(m[1]);
    if (filter !== null) return [{ t: "chooseBind", filter, scope: "ownBack" }];
  }
  if (/^自分のセンターホロメンを選ぶ$/.test(text))
    return [{ t: "chooseBind", scope: "ownCenter" }];
  if (/^相手のセンターホロメンかコラボホロメン(?:1人)?を選ぶ$/.test(text))
    return [{ t: "chooseBind", scope: "oppFront" }];
  m = text.match(/^相手の(?:ステージの)?ホロメン(\d+)人を選ぶ$/);
  if (m) return [{ t: "chooseBind", scope: "opp", count: num(m[1]) }];
  // 「この能力でアーカイブしたカードX枚につき、相手のホロメンX人を選ぶ」 (実行時に人数確定)
  m = text.match(
    /^この能力でアーカイブしたカード(\d+)枚につき、相手のホロメン(\d+)人を選ぶ$/,
  );
  if (m && num(m[1]) === 1 && num(m[2]) === 1)
    return [{ t: "chooseBind", scope: "opp", countFrom: "milled" }];

  // --- このターンの間、(対象)のアーツは相手の(条件)バックホロメンも対象にできる ---
  m = text.match(
    /^このターンの間、(.+?)のアーツは、相手の(.*?)バックホロメンも対象にできる$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    const extend = parseTargetFilterMods(m[2].replace(/の$/, ""));
    if (tgt && extend !== null)
      return [
        {
          t: "turnArtTargetExtend",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          extendFilter: extend,
        },
      ];
  }

  // --- このターンの間、すべての色を持つホロメンとして扱う ---
  m = text.match(
    /^このターンの間、(.+?)は、?すべての色を持つホロメンとして扱う$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "turnAllColors",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- このホロメンのエールの付け替え ([CエールかCエール]の色選択対応) ---
  m = text.match(
    new RegExp(
      `^このホロメンの(?:\\[${COLOR_RE}エールか${COLOR_RE}エール\\]|${COLOR_RE}?エール)(?:(\\d+)(?:〜(\\d+))?枚|を好きな枚数)を?、?(?:選び、?)?(.+?)に付け替え(る|られる)$`,
    ),
  );
  if (m) {
    const tgt = parseStackTarget(m[6]) ?? parseCheerTargetLoose(m[6]);
    if (tgt)
      return [
        {
          t: "moveYell",
          min: m[4] ? num(m[4]) : 0,
          max: m[4] ? num(m[5] ?? m[4]) : ANY_COUNT,
          fromSelf: true,
          color: (m[3] as Color) || undefined,
          colors: m[1] ? [m[1] as Color, m[2] as Color] : undefined,
          targetFilter: cheerTargetFilter(tgt),
          optional: m[7] === "られる",
          sameTarget: tgt.count === 1 && (m[4] ? num(m[5] ?? m[4]) > 1 : true),
        },
      ];
  }

  // --- そのホロメン(=効果の発生源/被弾ホロメン)のエールを他のホロメンに付け替え ---
  m = text.match(
    /^そのホロメンのエール(\d+)枚を自分の他の(?:#([^、を]+?)を持つ)?ホロメンに付け替える$/,
  );
  if (m) {
    const tf: TargetFilter = { excludeSource: true };
    if (m[2]) tf.tag = m[2];
    return [
      {
        t: "moveYell",
        min: num(m[1]),
        max: num(m[1]),
        fromSelf: true,
        targetFilter: tf,
      },
    ];
  }

  // --- サーチして付ける ---
  m = text.match(
    /^自分のデッキから、?(.+?)(\d+)(?:〜(\d+))?枚を(?:公開し、)?(.+?)に(?:割り振って)?付ける$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    const attach = parseAttachTarget(m[4]);
    if (f && attach)
      return [
        {
          t: "searchDeck",
          filter: f,
          nMax: num(m[3] ?? m[2]),
          dest: "attach",
          ...attach,
        },
      ];
  }
  m = text.match(
    /^自分のアーカイブの(.+?)(?:を?(\d+)(?:〜(\d+))?枚|を好きな枚数)(?:選び)?を?、?(.+?)に(?:割り振って)?付け(る|られる)$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    const attach = parseAttachTarget(m[4]);
    if (f && attach)
      return [
        {
          t: "moveArchive",
          filter: f,
          min: m[2] ? num(m[2]) : 0,
          max: m[2] ? num(m[3] ?? m[2]) : ANY_COUNT,
          dest: "attach",
          ...attach,
          optional: m[5] === "られる",
        },
      ];
  }

  // --- サーチ ([AとB]X枚ずつ: 各グループの条件と括弧外の共通条件を保つ) ---
  m = text.match(
    /^自分のデッキから、?(.*?)\[((?:〈[^〉]+〉|[^〈〉\[\]])+?)と((?:〈[^〉]+〉|[^〈〉\[\]])+?)\](\d+)枚ずつを(?:公開し、)?(手札に加える|ステージに出す)$/,
  );
  if (m) {
    const fa = parseCardFilter(m[1] + m[2]);
    const fb = parseCardFilter(m[1] + m[3]);
    if (fa && fb) {
      const dest = m[5].startsWith("手札")
        ? ("hand" as const)
        : ("stage" as const);
      return [
        { t: "searchDeck", filter: fa, nMax: num(m[4]), dest },
        { t: "searchDeck", filter: fb, nMax: num(m[4]), dest },
      ];
    }
  }

  // --- サーチ (同じカード名の[AとB]X枚ずつとCX枚: グループ選択) ---
  m = text.match(
    /^自分のデッキから、同じカード名の\[(.+?)と(.+?)\](\d+)枚ずつと(.+?)(\d+)枚を公開し、(?:公開したカードを)?手札に加える$/,
  );
  if (m) {
    const fa = parseCardFilter(m[1]);
    const fb = parseCardFilter(m[2]);
    const fc = parseCardFilter(m[4]);
    if (fa && fb && fc) {
      const per = num(m[3]);
      return [
        {
          t: "searchDeck",
          filter: { alt: [fa, fb, fc] },
          nMax: per * 2 + num(m[5]),
          groups: [
            { filter: fa, max: per },
            { filter: fb, max: per },
            { filter: fc, max: num(m[5]) },
          ],
          sameNameGroups: [0, 1],
          dest: "hand",
        },
      ];
    }
  }

  // --- サーチ (公開して手札へ/ステージへ) ---
  m = text.match(
    /^自分のデッキから、?(.+?)(\d+)(?:〜(\d+))?枚(?:ずつ)?を公開し、(手札に加える|手札に加えられる|ステージに出す|ステージに出せる)$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f)
      return [
        {
          t: "searchDeck",
          filter: f,
          nMax: num(m[3] ?? m[2]),
          dest: m[4].startsWith("手札") ? "hand" : "stage",
        },
      ];
  }
  // デッキから公開してアーカイブ
  m = text.match(
    /^自分のデッキから、?(.+?)(\d+)(?:〜(\d+))?枚(?:ずつ)?を公開し、アーカイブ(?:する|できる)$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f)
      return [
        {
          t: "searchDeck",
          filter: f,
          nMax: num(m[3] ?? m[2]),
          dest: "archive",
        },
      ];
  }
  m = text.match(
    /^自分のデッキから、?(.+?)(\d+)(?:〜(\d+))?枚を(手札に加える|手札に加えられる|ステージに出す|ステージに出せる)$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f)
      return [
        {
          t: "searchDeck",
          filter: f,
          nMax: num(m[3] ?? m[2]),
          dest: m[4].startsWith("手札") ? "hand" : "stage",
        },
      ];
  }

  // --- 手札/アーカイブのホロメンを使ってBloomする ---
  m = text.match(
    /^自分の(.+?)を、自分の(手札|アーカイブ)の(.+?)(?:を使って、?(もう1回)?|に)Bloom(できる|させる)$/,
  );
  if (m) {
    const source = m[2] === "手札" ? ("hand" as const) : ("archive" as const);
    const cardFilter = parseCardFilter(m[3]);
    const rebloom = !!m[4] || undefined;
    const optional = m[5] === "できる" || undefined;
    if (cardFilter) {
      // (mods)センターホロメンの〈N〉/[〈A〉か〈B〉]
      let tm = m[1].match(
        /^(.*?)センターホロメンの\[?((?:〈[^〉]+〉)(?:か〈[^〉]+〉)*)\]?$/,
      );
      if (tm) {
        const mods = parseTargetFilterMods(tm[1]);
        if (mods !== null)
          return [
            {
              t: "effectBloom",
              targetPos: "center",
              filter: { ...(mods ?? {}), names: parseNames(tm[2]) },
              source,
              cardFilter,
              rebloom,
              optional,
            },
          ];
      }
      // (mods)(センター|バック)?ホロメン1人
      tm = m[1].match(
        /^(.*?)(センター|バック)?(?:ポジションの)?ホロメン(\d+)人$/,
      );
      if (tm && num(tm[3]) === 1) {
        const mods = parseTargetFilterMods(tm[1]);
        if (mods !== null)
          return [
            {
              t: "effectBloom",
              targetPos:
                tm[2] === "バック"
                  ? "back"
                  : tm[2] === "センター"
                    ? "center"
                    : undefined,
              filter: mods ?? undefined,
              source,
              cardFilter,
              rebloom,
              optional,
            },
          ];
      }
      // (mods)〈N〉(か〈N〉)*1人 (名称指定の対象。「このターンにBloomした〈風真いろは〉1人」等)
      tm = m[1].match(/^(.*?)((?:〈[^〉]+〉)(?:か〈[^〉]+〉)*)(\d+)人$/);
      if (tm && num(tm[3]) === 1) {
        const mods = parseTargetFilterMods(tm[1]);
        if (mods !== null)
          return [
            {
              t: "effectBloom",
              filter: { ...(mods ?? {}), names: parseNames(tm[2]) },
              source,
              cardFilter,
              rebloom,
              optional,
            },
          ];
      }
    }
  }

  // --- 同色エールサーチ (センターホロメン参照) ---
  m = text.match(
    /^自分のエールデッキから、自分の(.*?)センターホロメンと同色のエール(\d+)枚を公開し、(.+?)に送る$/,
  );
  if (m) {
    const mods = parseTargetFilterMods(m[1]);
    const tgt = parseStackTarget(m[3]) ?? parseCheerTargetLoose(m[3]);
    if (mods !== null && tgt)
      return [
        { t: "chooseBind", filter: mods ?? undefined, scope: "ownCenter" },
        {
          t: "searchCheer",
          filter: { sameColorAsBound: true },
          n: num(m[2]),
          targetFilter: cheerTargetFilter(tgt),
        },
      ];
  }

  // --- 同色エールサーチ (ホロメンを選んでから) ---
  m = text.match(
    /^自分のエールデッキから、自分の(?:ステージの)?(.*?)ホロメン(\d+)人と同色のエール(\d+)枚を公開し、(.+?)に送る$/,
  );
  if (m && num(m[2]) === 1) {
    const bindFilter = parseTargetFilterMods(m[1]);
    const tgt = parseStackTarget(m[4]) ?? parseCheerTargetLoose(m[4]);
    if (bindFilter !== null && tgt)
      return [
        { t: "chooseBind", filter: bindFilter, scope: "own" },
        {
          t: "searchCheer",
          filter: { sameColorAsBound: true },
          n: num(m[3]),
          targetFilter: cheerTargetFilter(tgt),
        },
      ];
  }

  // --- 同色エールサーチ (既に選んだホロメンを参照) ---
  m = text.match(
    /^自分のエールデッキから、選んだホロメンと同色のエール(\d+)枚を公開し、(.+?)に送る$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[2]) ?? parseCheerTargetLoose(m[2]);
    if (tgt)
      return [
        {
          t: "searchCheer",
          filter: { sameColorAsBound: true },
          n: num(m[1]),
          targetFilter: cheerTargetFilter(tgt),
        },
      ];
  }

  // --- エールデッキサーチ (範囲+割り振り: 「エールX〜Y枚を公開し、(対象)に割り振って送る」) ---
  m = text.match(
    /^自分のエールデッキから、?(.+?)(\d+)〜(\d+)枚を公開し、(.+?)に(?:割り振って)?送る$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    const tgt = parseStackTarget(m[4]) ?? parseCheerTargetLoose(m[4]);
    if (f && tgt)
      return [
        {
          t: "searchCheer",
          filter: f,
          n: num(m[3]),
          min: num(m[2]),
          targetFilter: cheerTargetFilter(tgt),
        },
      ];
  }

  // --- エールデッキサーチ ---
  m = text.match(
    /^自分のエールデッキから、?(.+?)(\d+)枚を公開し、(.+?)に送る$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    const tgt = parseStackTarget(m[3]) ?? parseCheerTargetLoose(m[3]);
    if (f && tgt)
      return [
        {
          t: "searchCheer",
          filter: f,
          n: num(m[2]),
          targetFilter: cheerTargetFilter(tgt),
        },
      ];
  }
  // 「公開し」なしのエールデッキサーチ (エールX枚を(対象)に送る)
  m = text.match(/^自分のエールデッキから、?(.+?)(\d+)枚を(.+?)に送る$/);
  if (m) {
    const f = parseCardFilter(m[1]);
    const tgt = parseStackTarget(m[3]) ?? parseCheerTargetLoose(m[3]);
    if (f && tgt)
      return [
        {
          t: "searchCheer",
          filter: f,
          n: num(m[2]),
          targetFilter: cheerTargetFilter(tgt),
        },
      ];
  }

  // --- アーカイブからステージに出す ---
  m = text.match(
    /^自分のアーカイブの(.+?)(\d+)(?:〜(\d+))?枚をステージに出(す|せる)$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f)
      return [
        {
          t: "moveArchive",
          filter: f,
          min: num(m[2]),
          max: num(m[3] ?? m[2]),
          dest: "stage",
          optional: m[4] === "せる",
        },
      ];
  }

  // --- アーカイブから移動 ---
  m = text.match(
    /^(?:自分の)?アーカイブの(.+?)(?:合計)?(\d+)(?:〜(\d+))?枚を(好きな順で)?(手札|エールデッキ|デッキ)(の上|の下)?に戻(す|せる)(?:てシャッフルする)?$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f)
      return [
        {
          t: "moveArchive",
          filter: f,
          min: num(m[2]),
          max: num(m[3] ?? m[2]),
          dest:
            m[5] === "手札"
              ? "hand"
              : m[5] === "エールデッキ"
                ? "cheerDeck"
                : m[6] === "の上"
                  ? "deckTop"
                  : "deck",
          optional: m[7] === "せる",
          orderMatters: !!m[4] || undefined,
        },
      ];
  }
  m = text.match(
    /^自分のアーカイブの(.+?)(?:合計)?(\d+)(?:〜(\d+))?枚をデッキに戻してシャッフルする$/,
  );
  if (m) {
    const f = parseCardFilter(m[1]);
    if (f)
      return [
        {
          t: "moveArchive",
          filter: f,
          min: num(m[2]),
          max: num(m[3] ?? m[2]),
          dest: "deck",
        },
        { t: "shuffleDeck" },
      ];
  }

  // --- デッキ/エールデッキの上からアーカイブ ---
  m = text.match(/^自分のデッキの上から(\d+)(?:〜(\d+))?枚をアーカイブする$/);
  if (m)
    return [
      {
        t: "millDeck",
        n: num(m[1]),
        max: m[2] ? num(m[2]) : undefined,
      },
    ];
  // 任意ミル (コロンなし: 続く文の条件が参照する)
  m = text.match(/^自分のデッキの上から(\d+)枚をアーカイブできる$/);
  if (m)
    // 独立した任意効果は不足分を飛ばして解決する。コロン前のコストとは区別する(Q529)。
    return [{ t: "millDeck", n: num(m[1]), optional: true }];
  m = text.match(
    /^自分のエールデッキの上から(\d+)(?:〜(\d+))?枚をアーカイブする$/,
  );
  if (m)
    return [
      { t: "millCheer", n: num(m[1]), max: m[2] ? num(m[2]) : undefined },
    ];

  // --- エールデッキの上からX枚を送る ---
  m = text.match(
    /^自分のエールデッキの上から(\d+)枚を、?(.+?)に送(る|れる)(ことができる)?$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[2]) ?? parseCheerTargetLoose(m[2]);
    if (tgt)
      return [
        {
          t: "cheerFromTop",
          n: num(m[1]),
          target: tgt.target,
          filter: tgt.filter,
          sameTarget: tgt.count === 1 || undefined,
          optional: m[3] === "れる" || !!m[4] || undefined,
        },
      ];
  }
  // --- このホロメンのエール1枚につき、エールデッキの上からX枚を送る ---
  m = text.match(
    /^このホロメンのエール(\d+)枚につき、自分のエールデッキの上から(\d+)枚を、?(.+?)に送(る|れる)(ことができる)?$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[3]) ?? parseCheerTargetLoose(m[3]);
    if (tgt)
      return [
        {
          t: "cheerFromTop",
          n: num(m[2]),
          target: tgt.target,
          filter: tgt.filter,
          perSelfYell: true,
          sameTarget: tgt.count === 1 || undefined,
          optional: m[4] === "れる" || !!m[5] || undefined,
        },
      ];
  }

  // --- アーカイブの〈N〉X枚につき、アーカイブのエールX枚を(対象)に送る ---
  m = text.match(
    /^自分のアーカイブの((?:〈[^〉]+〉)+)(\d+)枚につき、自分のアーカイブのエール(\d+)枚を(.+?)に送る$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[4]) ?? parseCheerTargetLoose(m[4]);
    if (tgt)
      return [
        {
          t: "cheerFromArchive",
          n: num(m[3]),
          target: tgt.target,
          filter: tgt.filter,
          perArchiveNamed: { names: parseNames(m[1]), per: num(m[2]) },
          sameTarget: tgt.count === 1 || undefined,
        },
      ];
  }

  // --- アーカイブのエールX枚を選び、センターとコラボに割り振って送る ---
  m = text.match(
    /^(?:自分の)?アーカイブのエール(\d+)枚を選び、自分のセンターホロメンとコラボホロメンに割り振って送る$/,
  );
  if (m)
    return [
      {
        t: "cheerFromArchive",
        n: num(m[1]),
        max: num(m[1]),
        target: "chooseOwnFront",
        filter: { position: "front" },
      },
    ];

  // --- アーカイブのエールX枚ずつを[〈A〉と〈B〉]1人ずつに送れる ---
  m = text.match(
    /^(?:自分の)?アーカイブのエール(\d+)枚ずつを、?自分の\[((?:〈[^〉]+〉)+)と((?:〈[^〉]+〉)+)\](\d+)人ずつに送(る|れる)$/,
  );
  if (m && num(m[4]) === 1) {
    const optional = m[5] === "れる";
    return [
      {
        t: "cheerFromArchiveToGroups",
        nEach: num(m[1]),
        targetGroups: [
          { names: parseNames(m[2]) },
          { names: parseNames(m[3]) },
        ],
        optional,
      },
    ];
  }

  // --- アーカイブの(色)エールを(対象X〜Y人)にX枚ずつ送る ---
  m = text.match(
    new RegExp(
      `^(?:自分の)?アーカイブの${COLOR_RE}エールを、?(.+?)に(\\d+)枚ずつ送(る|れる)$`,
    ),
  );
  if (m) {
    const tgt = parseStackTarget(m[2]) ?? parseCheerTargetLoose(m[2]);
    if (tgt) {
      const perEach = num(m[3]);
      return [
        {
          t: "cheerFromArchive",
          n: perEach,
          max: perEach * (tgt.count ?? 1),
          target: tgt.target,
          filter: tgt.filter,
          colors: [m[1] as Color],
          // 「X枚ずつ」は1人あたりの上限。総数だけ見ると1人にまとめて送れてしまう
          perTargetMax: perEach,
          optional: m[4] === "れる",
          sameTarget: tgt.count === 1 && perEach > 1,
        },
      ];
    }
  }

  // --- アーカイブからエールを対象全員に1枚ずつ / 好きな枚数送る (枚数語が対象の後ろに来る語順) ---
  m = text.match(
    /^(?:自分の)?アーカイブのエールを、?(.+?)に(1枚ずつ|好きな枚数)送(る|れる)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]) ?? parseCheerTargetLoose(m[1]);
    if (tgt) {
      if (m[2] === "1枚ずつ")
        return [
          {
            t: "cheerFromArchive",
            n: 1,
            // 「〈N〉1〜2人に1枚ずつ」のように人数上限が書かれていれば従う。
            // 省略時 (「全員に1枚ずつ」) は対象全員へ送る
            max: tgt.count,
            target: tgt.target,
            filter: tgt.filter,
            each: true,
            optional: m[3] === "れる" || undefined,
          },
        ];
      return [
        {
          t: "cheerFromArchive",
          n: 0,
          max: 99,
          target: tgt.target,
          filter: tgt.filter,
          optional: m[3] === "れる",
          sameTarget: tgt.count === 1 || undefined,
        },
      ];
    }
  }
  // --- アーカイブからエールを送る ---
  m = text.match(
    /^(?:自分の)?アーカイブのエール(?:を)?(\d+)(?:〜(\d+))?枚(ずつ)?を?、?(.+?)に(割り振って)?送(る|れる)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[4]) ?? parseCheerTargetLoose(m[4]);
    if (tgt) {
      const perN = num(m[1]);
      // 「X〜Y枚」の範囲指定は選択プロンプトで枚数と割り振り先を選ぶ
      if (m[2]) {
        // 「エールが付いていないホロメン1人に送る」は先に対象を確定してから送る
        // (送付後にエールが付くと対象条件を再判定できなくなるため)
        if (tgt.filter?.noYell)
          return [
            { t: "chooseBind", filter: tgt.filter, scope: "own" },
            {
              t: "cheerFromArchive",
              n: perN,
              max: num(m[2]),
              target: "bound",
              optional: m[6] === "れる" || undefined,
            },
          ];
        return [
          {
            t: "cheerFromArchive",
            n: perN,
            max: num(m[2]),
            target: tgt.target,
            filter: tgt.filter,
            optional: m[6] === "れる",
            sameTarget: tgt.count === 1,
          },
        ];
      }
      // 「X枚ずつを…N人に送る」= 対象人数分を配布する。
      // 「ずつ」は1人あたりの上限でもあるので、総数だけにすると
      // 1人へまとめて送れてしまう。
      // さらに「1〜3人に送る」は人数が範囲なので、下限 (1人分=perN枚) から
      // 上限 (perN×人数) までの範囲選択にする。総数だけを持つと人数が
      // そろわない時に不発になる (色指定ありの分岐と同じ扱い)。
      const each = !!m[3] && tgt.count !== undefined;
      const total = each ? perN * tgt.count! : perN;
      return [
        {
          t: "cheerFromArchive",
          n: each ? perN : total,
          max: each ? total : undefined,
          each: each || undefined,
          target: tgt.target,
          filter: tgt.filter,
          perTargetMax: m[3] ? perN : undefined,
          optional: m[6] === "れる",
          sameTarget: tgt.count === 1 && total > 1,
        },
      ];
    }
  }
  // --- アーカイブから色指定エールを送る ([青エールか緑エール] / 青エール) ---
  m = text.match(
    new RegExp(
      `^自分のアーカイブの\\[?(?<cols>(?:${COLOR_RE}エール)(?:か${COLOR_RE}エール)*)\\]?(?:を)?(?<n1>\\d+)(?:〜(?<n2>\\d+))?枚(?<each>ずつ)?(?:を選び)?を?、?(?<tgt>.+?)に(?:割り振って)?送(?<opt>る|れる)$`,
    ),
  );
  if (m?.groups) {
    const g = m.groups;
    const colors = [...g.cols.matchAll(/(白|緑|赤|青|紫|黄)エール/g)].map(
      (mm) => mm[1] as Color,
    );
    const minPerTarget = num(g.n1);
    const maxPerTarget = num(g.n2 ?? g.n1);
    const each = !!g.each;
    const targetText = g.tgt;
    const optional = g.opt === "れる";
    const tgt =
      parseStackTarget(targetText) ?? parseCheerTargetLoose(targetText);
    if (tgt && colors.length > 0) {
      const hasRange = g.n2 !== undefined || (each && tgt.count !== undefined);
      const max =
        each && tgt.count !== undefined
          ? maxPerTarget * tgt.count
          : maxPerTarget;
      return [
        {
          t: "cheerFromArchive",
          n: minPerTarget,
          max: hasRange ? max : undefined,
          target: tgt.target,
          filter: tgt.filter,
          optional,
          colors,
          perTargetMax: each ? maxPerTarget : undefined,
          sameTarget: tgt.count === 1 && max > 1,
        },
      ];
    }
  }

  // --- ホロパワー ---
  m = text.match(/^自分のデッキの上から(\d+)枚をホロパワーにする$/);
  if (m) return [{ t: "holoPowerFromDeck", n: num(m[1]) }];

  // --- サイコロの目の修正 ---
  m = text.match(
    /^このターンの間、自分のサイコロの目の数すべてを(\d+)として扱う$/,
  );
  if (m) return [{ t: "diceMod", value: num(m[1]) }];
  m = text.match(
    /^このターンの間、自分の推しホロメンの((?:〈[^〉]+〉)+)と自分のステージの((?:〈[^〉]+〉)+)の能力でサイコロを振る時、そのサイコロの目の数すべてを(倍の数|(\d+))として扱う$/,
  );
  if (m) {
    const names = [...new Set([...parseNames(m[1]), ...parseNames(m[2])])];
    if (m[3] === "倍の数") return [{ t: "diceMod", double: true, names }];
    return [{ t: "diceMod", value: num(m[4]), names }];
  }
  m = text.match(
    /^このターンの間、自分のホロメンの能力でサイコロを1度に(\d+)回振る時、そのサイコロの目の数すべてを(\d+)として扱う$/,
  );
  if (m) return [{ t: "diceMod", value: num(m[2]), rollsExactly: num(m[1]) }];

  // --- リセットステップでお休みしない (ゲーム間) ---
  m = text.match(
    /^このゲームの間、自分の((?:〈[^〉]+〉)+)全員は、リセットステップでお休みしない$/,
  );
  if (m) return [{ t: "noRestReset", names: parseNames(m[1]) }];

  // --- 手札に戻したカード比例ドロー ---
  m = text.match(
    /^そして手札に戻したカード(\d+)枚につき、自分のデッキを(\d+)枚引く$/,
  );
  if (m) return [{ t: "drawPerPicked", per: num(m[1]), draw: num(m[2]) }];

  // --- バックに移動したホロメンの回復 (swapCenter後の継続文) ---
  m = text.match(/^バックポジションに移動したホロメンのHP(\d+)回復$/);
  if (m) return [{ t: "heal", value: num(m[1]), target: "bound" }];

  // --- 手札 ---
  m = text.match(/^(?:自分の)?手札(\d+)枚をアーカイブする$/);
  if (m) return [{ t: "archiveHand", n: num(m[1]) }];
  m = text.match(/^(?:さらに、)?自分の手札(\d+)枚をデッキの下に戻す$/);
  if (m) return [{ t: "handToDeckBottom", n: num(m[1]) }];
  // --- バックのDebutホロメン(の〈N〉)をデッキの下に戻す (必須の主効果形) ---
  m = text.match(
    /^自分のバックポジションのDebutホロメン(?:の((?:〈[^〉]+〉)+))?(\d+)人をデッキの下に戻す$/,
  );
  if (m)
    return [
      {
        t: "backToDeckBottom",
        n: num(m[2]),
        filter: {
          bloomLevel: "Debut",
          ...(m[1] ? { names: parseNames(m[1]) } : {}),
        },
      },
    ];
  if (/^自分の手札を好きな枚数選んで好きな順でデッキの下に戻す$/.test(text))
    return [{ t: "handToDeckBottomAny" }];
  if (/^お互い、手札すべてを好きな順でデッキの下に戻す$/.test(text))
    return [{ t: "bothHandToDeckBottom" }];
  m = text.match(
    /^(?:次に、)?お互い、デッキに戻したカード(\d+)枚につき、それぞれのデッキを(\d+)枚引く$/,
  );
  if (m) return [{ t: "bothDrawPerReturned", per: num(m[1]), draw: num(m[2]) }];

  // --- 相手のエールをアーカイブ ---
  m = text.match(/^相手の(センター)?ホロメンのエール(\d+)枚をアーカイブする$/);
  if (m) return [{ t: "archiveOppYell", n: num(m[2]), fromCenter: !!m[1] }];

  // --- 相手のステージのエールをエールデッキの下に戻す ---
  m = text.match(/^相手のステージのエール(\d+)枚をエールデッキの下に戻す$/);
  if (m) return [{ t: "oppYellToCheerBottom", n: num(m[1]) }];
  m = text.match(
    /^相手の\[?(センター|コラボ)ホロメンか(?:センター|コラボ)ホロメン\]?のエール(\d+)枚をエールデッキの下に戻す$/,
  );
  if (m) return [{ t: "oppYellToCheerBottom", n: num(m[2]), scope: "front" }];
  m = text.match(
    /^相手の(センター|コラボ)ホロメンのエール(\d+)枚をエールデッキの下に戻す$/,
  );
  if (m)
    return [
      {
        t: "oppYellToCheerBottom",
        n: num(m[2]),
        scope: m[1] === "センター" ? "center" : "collab",
      },
    ];
  m = text.match(
    /^相手のセンターホロメンとコラボホロメンのエール(\d+)枚ずつを好きな順でエールデッキの下に戻す$/,
  );
  if (m) return [{ t: "oppFrontYellsToCheerBottom", nEach: num(m[1]) }];

  // --- 相手のアーカイブのエールを相手のセンターホロメンに送る ---
  m = text.match(
    /^相手のアーカイブのエール(\d+)枚を、?相手のセンターホロメンに送(る|れる)$/,
  );
  if (m) {
    const op: Op = { t: "oppArchiveYellToOppCenter", n: num(m[1]) };
    if (m[2] === "れる")
      return [
        {
          t: "optionalCost",
          cost: [],
          then: [op],
          label: `相手のアーカイブのエール${m[1]}枚を相手のセンターホロメンに送りますか？`,
        },
      ];
    return [op];
  }

  // --- このホロメンのエールすべてをアーカイブ ---
  m = text.match(
    new RegExp(`^このホロメンの${COLOR_RE}?エールすべてをアーカイブする$`),
  );
  if (m)
    return [
      {
        t: "archiveSelfYell",
        color: m[1] as Color | undefined,
        n: 0,
        all: true,
      },
    ];

  // --- このホロメンのエール全戻し + 戻した枚数と同じになるまでドロー ---
  if (
    /^このホロメンのエールを数えて、そのすべてを好きな順でエールデッキの下に戻す$/.test(
      text,
    )
  )
    return [{ t: "selfYellToCheerBottom" }];
  if (
    /^(?:その後、)?自分の手札がこの能力で戻したエールの枚数と同じになるまで、自分のデッキを引く$/.test(
      text,
    )
  )
    return [{ t: "drawUntilReturnedYell" }];

  // --- このターンの間、自分のライフは相手の能力で減らない ---
  if (/^このターンの間、自分のライフは相手の能力で減らない$/.test(text))
    return [{ t: "lifeImmuneFromOpp" }];

  // --- 自分のライフ-X ---
  m = text.match(/^自分のライフ-(\d+)$/);
  if (m) return [{ t: "lifeMinus", n: num(m[1]) }];

  // --- 自分の減るライフ-X (downedOwnリアクティブ: 保留中のダウンライフ減少を軽減) ---
  m = text.match(/^自分の減るライフ-(\d+)$/);
  if (m) return [{ t: "lifeLossMinus", n: num(m[1]) }];

  // --- ダウンしたホロメンの重なりすべてを手札に戻す ---
  if (
    /^(?:さらに、)?ダウンした1人を選び、そのホロメンを含め重なっているホロメンすべてを手札に戻す$/.test(
      text,
    ) ||
    /^そのホロメンを含め重なっているホロメンすべてを手札に戻す$/.test(text)
  )
    return [{ t: "downedToHand", what: "holomen", n: "all" }];

  // --- ダウンしたこのホロメンの重なりからX枚を手札に戻す (自身のdownedトリガー本文) ---
  m = text.match(
    /^このホロメンを含め重なっているホロメンの中から(\d+)枚を手札に戻す$/,
  );
  if (m) return [{ t: "downedToHand", what: "holomen", n: num(m[1]) }];

  // --- ダウンしたホロメンに付いていたファンを手札に戻す ---
  m = text.match(/^そのホロメンに付いているファン(\d+)枚を手札に戻す$/);
  if (m) return [{ t: "downedToHand", what: "fan", n: num(m[1]) }];

  // --- ダウンしたホロメンのエール付け替え + 重なりから1枚手札戻し (戌神ころね) ---
  m = text.match(
    /^そのホロメンのエール(\d+)枚を自分の他のホロメンに付け替え、そのダウンしたホロメンを含め重なっているホロメンの中から(\d+)枚を手札に戻す$/,
  );
  if (m)
    return [
      { t: "downedYellMove", n: num(m[1]) },
      { t: "downedToHand", what: "holomen", n: num(m[2]) },
    ];

  m = text.match(
    /^このホロメンのエール(\d+)〜(\d+)枚を選び、自分の他のホロメンに割り振って付け替えられる$/,
  );
  if (m)
    return [
      {
        t: "optionalCost",
        cost: [],
        then: [{ t: "downedYellMove", min: num(m[1]), n: num(m[2]) }],
        label: "ダウンしたホロメンのエールを付け替えますか？",
      },
    ];

  // --- ダウンしたホロメンの(色)エールすべてを割り振って付け替え (兎田ぺこら) ---
  m = text.match(
    new RegExp(
      `^自分のダウンしたホロメン1人の${COLOR_RE}エールすべてを、自分の他のホロメンに割り振って付け替える$`,
    ),
  );
  if (m) return [{ t: "downedYellMove", n: "all", color: m[1] as Color }];

  // --- 相手の強制コラボ移動 ---
  if (
    /^相手は、自身のバックホロメン1人をコラボポジションに移動させる（移動はコラボとしては扱わない）$/.test(
      text,
    )
  )
    return [{ t: "forceOppCollab" }];
  if (
    /^相手のセンターポジションとコラボポジションのホロメンを入れ替える$/.test(
      text,
    )
  )
    return [{ t: "swapOppCenterCollab" }];

  // --- アクティブにするかお休みさせる (二択) ---
  if (/^このホロメンをアクティブにするかお休みさせる$/.test(text))
    return [
      {
        t: "chooseOps",
        label: "このホロメンをアクティブにしますか？ (いいえ=お休みさせる)",
        thenOps: [{ t: "activate", target: "self" }],
        elseOps: [{ t: "rest", target: "self" }],
      },
    ];

  // --- トリガー元の付与サポート自身の移動 ---
  if (/^この(?:ツール|マスコット|ファン)を手札に戻す$/.test(text))
    return [{ t: "selfSupportToHand" }];
  if (/^この(?:ツール|マスコット|ファン)をアーカイブする$/.test(text))
    return [{ t: "archiveSelfSupport" }];

  // --- お休みからアクティブにする ---
  m = text.match(/^(.+?)を(?:選び、?)?アクティブにする$/);
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "activate",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- お休みさせる (自身) ---
  if (/^このホロメンをお休みさせる$/.test(text)) return [{ t: "restSelf" }];
  // --- お休みさせる (対象指定) ---
  m = text.match(/^(.+?)をお休みさせる$/);
  if (m && m[1] !== "このホロメン") {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        { t: "rest", target: tgt.target, count: tgt.count, filter: tgt.filter },
      ];
  }

  // --- ダウンさせる (対象指定) ---
  m = text.match(
    /^(.+?)をダウンさせる(?:（ダウンしても相手のライフは減らない）)?$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "down",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          ...(text.includes("ライフは減らない") ? { noLife: true } : {}),
        },
      ];
  }
  if (/^このホロメンをお休みさせることができる$/.test(text))
    return [
      {
        t: "optionalCost",
        cost: [{ t: "restSelf" }],
        then: [],
        label: "このホロメンをお休みさせる",
      },
    ];

  // --- ステージのタグ持ち1人につきX枚引く ---
  m = text.match(
    /^自分のステージの(異なるカード名の)?#([^、を]+?)を持つホロメン(\d+)人につき、自分のデッキを(\d+)枚引く$/,
  );
  if (m && num(m[3]) === 1)
    return [
      { t: "drawPerStageTag", tag: m[2], distinct: !!m[1], draw: num(m[4]) },
    ];

  // --- 交代 ---
  if (
    /^自分のセンターホロメンとお休みしていないバックホロメン1人を交代させる$/.test(
      text,
    )
  )
    return [{ t: "swapCenter", side: "own", requireActive: true }];
  if (/^相手のセンターホロメンとバックホロメン1人を交代させる$/.test(text))
    return [{ t: "swapCenter", side: "opp" }];
  // 「自分のコラボポジションの[DebutホロメンかXstホロメンかSpotホロメン]と、バックホロメンの〈N〉1人を交代させる」
  m = text.match(
    /^自分のコラボポジションの\[((?:Debut|1st|2nd|Spot)ホロメン(?:か(?:Debut|1st|2nd|Spot)ホロメン)*)\]と、バックホロメンの((?:〈[^〉]+〉)+)1人を交代させる$/,
  );
  if (m) {
    const levels = m[1].split("か").map((x) => x.replace(/ホロメン$/, "")) as (
      | "Debut"
      | "1st"
      | "2nd"
      | "Spot"
    )[];
    return [
      {
        t: "swapCollabBack",
        collabFilter: { bloomLevels: levels },
        backFilter: { names: parseNames(m[2]) },
      },
    ];
  }

  // 「相手のセンターホロメンとHPが減っているバックホロメン1人を交代できる/させる」
  m = text.match(
    /^相手のセンターホロメンとHPが減っているバックホロメン1人を交代(できる|させる)$/,
  );
  if (m) {
    const op: Op = {
      t: "swapCenter",
      side: "opp",
      filter: { damagedAtLeast: 1 },
    };
    if (m[1] === "できる")
      return [
        {
          t: "optionalCost",
          cost: [],
          then: [op],
          label:
            "相手のセンターホロメンとHPが減っているバックホロメン1人を交代しますか？",
        },
      ];
    return [op];
  }

  // --- 枚数比例のサイコロ (「(参照)X枚/人につき、サイコロを1回振る/振れる」) ---
  m = text.match(
    /^(このホロメンに重なっているホロメン|自分のステージの\[マスコットとファン\]|自分のステージのマスコット|自分のステージの異なるカード名の#([^、を]+?)を持つホロメン)(\d+)(?:枚|人)につき、サイコロを(\d+)回振(る|れる)(?:[:：](.+))?$/,
  );
  if (
    m &&
    (num(m[3]) === 1 || m[1] === "自分のステージのマスコット") &&
    num(m[4]) === 1
  ) {
    const rollsFrom: NonNullable<Extract<Op, { t: "dice" }>["rollsFrom"]> =
      m[1] === "このホロメンに重なっているホロメン"
        ? { per: "stacked" }
        : m[1] === "自分のステージのマスコット"
          ? { per: "stageMascot", perN: num(m[3]) }
          : m[2]
            ? { per: "stageTagDistinct", tag: m[2] }
            : { per: "stageMascotFan" };
    const optional = m[5] === "れる";
    if (!m[6]) return [{ t: "dice", optional, rollsFrom, branches: [] }];
    const sm = m[6].match(
      /^出た目の(?:合計)?数(\d+)につき、このアーツ\+(\d+)$/,
    );
    if (sm && num(sm[1]) === 1)
      return [
        {
          t: "dice",
          optional,
          rollsFrom,
          branches: [],
          sumArtPlus: num(sm[2]),
        },
      ];
    // 集計分岐: 「奇数がX回以上出たなら、(効果)」
    const am = m[6].match(/^奇数が(\d+)回以上出たなら、(.+)$/);
    if (am) {
      const inner = parseSentence(am[2]);
      if (inner)
        return [
          {
            t: "dice",
            optional,
            rollsFrom,
            branches: [],
            aggOdd: { atLeast: num(am[1]), ops: inner },
          },
        ];
      return null;
    }
    const branches = parseDiceBranches(m[6]);
    if (branches) return [{ t: "dice", optional, rollsFrom, branches }];
    return null;
  }

  // --- サイコロ (コロンなし: 分岐は後続文で結合される) ---
  m = text.match(/^サイコロを(\d+)回振る$/);
  if (m) return [{ t: "dice", rolls: num(m[1]), branches: [] }];
  // 「(対象)を選び、サイコロをX回振る」= chooseBind + dice
  m = text.match(/^(.+?\d+人)を選び、サイコロを(\d+)回振る$/);
  if (m) {
    const bind = parseSentence(m[1] + "を選ぶ");
    if (bind) return [...bind, { t: "dice", rolls: num(m[2]), branches: [] }];
  }

  // --- サイコロ: 出た目の(合計)数1につき、このアーツ+X ---
  m = text.match(
    /^サイコロを(\d+)回振(る|れる)[:：]出た目の(?:合計)?数(\d+)につき、このアーツ\+(\d+)$/,
  );
  if (m && num(m[3]) === 1)
    return [
      {
        t: "dice",
        optional: m[2] === "れる",
        rolls: num(m[1]),
        branches: [],
        sumArtPlus: num(m[4]),
      },
    ];

  // --- サイコロ ---
  // (「サイコロを」の省略形「1回振れる：」にも対応: ときのそら)
  m = text.match(/^(?:サイコロを)?(\d+)回振(る|れる)[:：](.+)$/);
  if (m) {
    const optional = m[2] === "れる";
    const branches = parseDiceBranches(m[3]);
    if (branches) return [{ t: "dice", optional, rolls: num(m[1]), branches }];
  }
  // ドロー付きサイコロ: 「自分のデッキを2枚引き、サイコロを1回振る：...」
  m = text.match(/^自分のデッキを(\d+)枚引き、サイコロを(\d+)回振る[:：](.+)$/);
  if (m) {
    const branches = parseDiceBranches(m[3]);
    if (branches)
      return [
        { t: "draw", n: num(m[1]) },
        { t: "dice", rolls: num(m[2]), branches },
      ];
  }
  // 汎用のドロー連用形: 「自分のデッキをX枚引き、(効果)」
  m = text.match(/^自分のデッキを(\d+)枚引き、(.+)$/);
  if (m) {
    const rest2 = parseSentence(m[2]);
    if (rest2) return [{ t: "draw", n: num(m[1]) }, ...rest2];
  }

  // --- このアーツでダウンさせた時 (ダウン処理で評価) ---
  // 「相手の**センター**ホロメンをダウンさせた時」のようにポジションが指定される
  // ことがある。アーツはコラボホロメンも対象にできるので、指定を落とすと
  // コラボをダウンさせただけで発揮してしまう
  m = text.match(
    /^このアーツで相手の(センター|コラボ)?ホロメンをダウンさせた時、(.+)$/,
  );
  if (m) {
    const downedPos =
      m[1] === "センター" || m[1] === "コラボ" ? m[1] : undefined;
    const downedCond: Cond =
      downedPos === "センター"
        ? { c: "artDowned", pos: "center" }
        : downedPos === "コラボ"
          ? { c: "artDowned", pos: "collab" }
          : { c: "artDowned" };
    // 「与えたダメージが残りHPを(X以上)オーバーしていれば/いたなら、〜」のネスト条件
    const ov = m[2].match(
      /^与えたダメージが残りHPを(?:(\d+)以上)?オーバーしてい(?:れば|たなら)、(.+)$/,
    );
    if (ov) {
      const then = parseSentence(ov[2]);
      if (then)
        return [
          {
            t: "if",
            cond: downedCond,
            then: [
              {
                t: "if",
                cond: { c: "artOverkillAtLeast", n: ov[1] ? num(ov[1]) : 1 },
                then,
              },
            ],
          },
        ];
    }
    const then = parseSentence(m[2]);
    if (then) return [{ t: "if", cond: downedCond, then }];
  }

  // --- 相手のライフ-X ---
  m = text.match(/^相手のライフ-(\d+)$/);
  if (m) return [{ t: "oppLifeMinus", n: num(m[1]) }];

  // --- 相手のホロパワー→相手の手札 ---
  m = text.match(/^相手は、自身のホロパワーの上から(\d+)枚を手札に加える$/);
  if (m) return [{ t: "oppHoloPowerToHand", n: num(m[1]) }];

  // --- オーバーキル量に比例したエール送付 ---
  m = text.match(
    /^オーバーしたダメージ(\d+)につき、自分のエールデッキの上から(\d+)枚を(.+?)に送る$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[3]) ?? parseCheerTargetLoose(m[3]);
    if (tgt)
      return [
        {
          t: "cheerFromTopPerOverkill",
          per: num(m[1]),
          n: num(m[2]),
          target: tgt.target,
          filter: tgt.filter,
          sameTarget: tgt.count === 1 || undefined,
        },
      ];
  }

  // --- アーカイブ枚数比例のアーカイブ回収 ---
  m = text.match(
    /^(?:この能力で)?アーカイブしたカード(\d+)枚につき、自分のアーカイブの((?:〈[^〉]+〉)+)(\d+)枚を手札に戻す$/,
  );
  if (m)
    return [
      {
        t: "moveArchive",
        filter: { names: parseNames(m[2]) },
        min: 0,
        max: 0,
        dest: "hand",
        maxPerMilled: { per: num(m[1]), n: num(m[3]) },
      },
    ];

  // --- 使ったイベント枚数比例のアーツコスト軽減 ---
  m = text.match(
    /^このターンに自分が使っていた(?:#([^、を]+?)を持つ)?イベント(\d+)枚につき、このターンの間、(.+?)のアーツに必要な(?:◇|無色)-(\d+)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[3]);
    if (tgt)
      return [
        {
          t: "turnCostModPerUsedEvent",
          tag: m[1] || undefined,
          per: num(m[2]),
          costless: num(m[4]),
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- 「その相手のバックホロメン」= 直前にダメージを与えたバック (bound参照) ---
  m = text.match(
    /^その相手のバックホロメン(\d+)人に特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[1]) === 1)
    return [{ t: "special", dmg: num(m[2]), target: "bound" }];

  // --- 誘発のきっかけになったダメージと同じ数値の特殊ダメージ ---
  m = text.match(
    /^相手のバックホロメン(\d+)人にそれと同じ数値の特殊ダメージを与える$/,
  );
  if (m)
    return [
      {
        t: "special",
        dmg: 0,
        dmgFrom: "triggerDamage",
        target: "chooseOppBack",
        count: num(m[1]),
      },
    ];

  // --- 相手の前列どちらかにアーカイブしたエール枚数比例の特殊ダメージ ---
  m = text.match(
    /^相手のセンターホロメンかコラボホロメン(?:どちらか)?に、(?:この能力で)?アーカイブしたエール(\d+)枚につき、特殊ダメージ(\d+)を与える$/,
  );
  if (m && num(m[1]) === 1)
    return [
      {
        t: "special",
        dmg: num(m[2]),
        scaleBy: { kind: "milled" },
        target: "chooseOpp",
      },
    ];

  // --- オーバーキル量を特殊ダメージに ---
  m = text.match(
    /^(.+?)に、オーバーしたダメージと同じ数値の特殊ダメージを与える$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "special",
          dmg: 0,
          dmgFrom: "overkill",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- アーツをエールを必要とせずに使える (ターン修正) ---
  m = text.match(
    /^このターンの間、(.+?)のアーツは、エールを必要とせずに使える$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "turnCostMod",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          artsFree: true,
        },
      ];
  }

  // --- LIMITED使用枚数の変更 ---
  m = text.match(
    /^このターンの間、自分が使えるLIMITEDのサポートカードの枚数は(\d+)枚になる$/,
  );
  if (m) return [{ t: "limitedLimit", n: num(m[1]) }];

  // --- お互いのエールデッキミル + アーカイブ色数比例ドロー ---
  m = text.match(/^お互いのエールデッキの上から(\d+)枚をアーカイブする$/);
  if (m) return [{ t: "bothMillCheer", n: num(m[1]) }];
  m = text.match(
    /^(?:この能力で)?アーカイブしたエール(\d+)色につき、自分のデッキを(\d+)枚引く$/,
  );
  if (m && num(m[1]) === 1)
    return [{ t: "drawPerMilledYellColor", per: num(m[1]), draw: num(m[2]) }];

  // --- ステージの#tag全員: 各自のエール色数比例のターンアーツ+X ---
  m = text.match(
    /^このターンの間、自分のステージの#([^、を]+?)を持つホロメン全員は、そのホロメンのエール(\d+)色につき、アーツ\+(\d+)$/,
  );
  if (m && num(m[2]) === 1)
    return [
      {
        t: "turnArtPlusEachYellColor",
        value: num(m[3]),
        filter: { tag: m[1] },
      },
    ];

  // --- じゃんけん (角巻わため: 勝ったら効果) ---
  m = text.match(
    /^相手と勝敗が決まるまでじゃんけんできる[:：]自分が勝った時、(.+)$/,
  );
  if (m) {
    const winOps = parseSentence(m[1]);
    if (winOps)
      return [
        {
          t: "optionalCost",
          cost: [],
          then: [{ t: "janken", winOps }],
          label: "相手とじゃんけんをしますか？",
        },
      ];
    return null;
  }

  // --- このターンの間、このホロメンは(色)特攻+Xを得る ---
  m = text.match(
    new RegExp(
      `^このターンの間、このホロメンは${COLOR_RE}特攻\\+(\\d+)を得る$`,
    ),
  );
  if (m)
    return [{ t: "turnSpecialAttack", color: m[1] as Color, value: num(m[2]) }];

  // --- 色が1色で異なる色のホロメンX人を選ぶ (ツートンカラーパソコン) ---
  m = text.match(/^自分のステージの色が1色で異なる色のホロメン(\d+)人を選ぶ$/);
  if (m)
    return [
      {
        t: "chooseBind",
        scope: "own",
        filter: { monoColor: true },
        count: num(m[1]),
        distinctColors: true,
      },
    ];

  // --- それぞれ選んだホロメンと同色のホロメンを1枚ずつサーチ (ツートンカラーパソコン) ---
  m = text.match(
    /^自分のデッキから、(Buzz以外の)?それぞれ選んだホロメンと同色の(Debut|1st|2nd)ホロメン(\d+)枚ずつを(?:公開し、)?手札に加える$/,
  );
  if (m && num(m[3]) === 1) {
    const base: CardFilter = {
      kind: "holomen",
      bloomLevel: m[2] as "Debut" | "1st" | "2nd",
      excludeBuzz: m[1] ? true : undefined,
    };
    return [
      {
        t: "searchDeck",
        filter: { ...base },
        nMax: 2,
        dest: "hand",
        groups: [
          { filter: { ...base, sameColorAsBoundIndex: 0 }, max: 1 },
          { filter: { ...base, sameColorAsBoundIndex: 1 }, max: 1 },
        ],
      },
    ];
  }

  // --- このアーツをもう1回使う (ときのそら: サイコロ分岐の中で使われる) ---
  m = text.match(
    /^同じホロメンに、このアーツをもう(\d+)回使う(?:（[^）]*）)?$/,
  );
  if (m && num(m[1]) === 1) return [{ t: "repeatArtNow", sameTarget: true }];

  // --- 選んだホロメンのアーツ再使用付与 (角巻わためコラボ/森カリオペSP) ---
  m = text.match(
    /^このターンの間、(?:選んだホロメンは|(自分の(?:〈[^〉]+〉)+)1人は、)アーツを使った後、同じアーツをもう(\d+)回使(える|う)$/,
  );
  if (m && num(m[2]) === 1) {
    const grant: Op = {
      t: "repeatArtGrant",
      optional: m[3] === "える" || undefined,
    };
    if (m[1]) {
      const names = parseNames(m[1]);
      if (names.length === 0) return null;
      return [{ t: "chooseBind", scope: "own", filter: { names } }, grant];
    }
    return [grant];
  }

  // --- 選んだホロメンの特殊ダメージ+X + ダウン報酬ドロー (雪花ラミィSP) ---
  m = text.match(
    /^このターンの間、選んだホロメンが、相手のホロメン1人に与える特殊ダメージ\+(\d+)し、選んだホロメンが相手のホロメンをダウンさせた時、自分のデッキを(\d+)枚引く$/,
  );
  if (m)
    return [
      { t: "turnSpecialPlus", value: num(m[1]) },
      {
        t: "downReward",
        boundSubject: true,
        anyHolomen: true,
        draw: num(m[2]),
      },
    ];

  // --- アーツダメージのセンター+コラボ分散 (桃鈴ねね) ---
  if (
    /^このアーツダメージは、アーツの対象のホロメンのかわりに、相手のセンターホロメンとコラボホロメンに与える$/.test(
      text,
    )
  )
    return [{ t: "artDamageToFronts" }];

  // --- ターン中のダウン報酬 (「#T持ちが相手のセンターをダウンさせた時、相手のライフ-X」) ---
  m = text.match(
    /^このターンの間、自分の#([^、を]+?)を持つホロメンが相手のセンターホロメンをダウンさせた時、相手のライフ-(\d+)$/,
  );
  if (m) return [{ t: "downReward", tag: m[1], oppLifeMinus: num(m[2]) }];

  // --- 追加ターン ---
  if (/^このターンの後に、もう1回自分のターンを開始する$/.test(text))
    return [{ t: "extraTurn" }];

  // --- 相手のバックホロメンをDebutホロメンに戻す ---
  m = text.match(
    /^相手のバックホロメン(\d+)人をDebutホロメンに戻す(?:（[^）]*）)?$/,
  );
  if (m) return [{ t: "devolve", target: "chooseOppBack", count: num(m[1]) }];

  // --- バトンタッチ・移動・交代の禁止 ---
  if (
    /^次の相手のターンの間、相手のセンターホロメンとコラボホロメンは、バトンタッチ、移動、交代できない$/.test(
      text,
    )
  )
    return [
      { t: "turnNoSwitch", target: "allOppFront", untilNextOppTurn: true },
    ];

  // --- 指定名Debutの公開→ステージに出す ---
  m = text.match(
    /^自分のデッキから、Debutホロメンの\[?((?:〈[^〉]+〉)(?:か〈[^〉]+〉)*)\]?(\d+)枚を公開できる[:：]公開したホロメンをステージに出す$/,
  );
  if (m)
    return [
      {
        // 指定名カードの存在は非公開なので検索前には調べない。
        // デッキ枚数が足りる時だけ公開コストの承諾を確認し、辞退時は
        // 検索も後続のシャッフルも実行しない (10.8.3.2.1)。
        t: "if",
        cond: { c: "not", inner: { c: "deckCountAtMost", n: num(m[2]) - 1 } },
        then: [
          {
            t: "optionalCost",
            cost: [],
            then: [
              {
                t: "searchDeck",
                filter: {
                  kind: "holomen",
                  bloomLevel: "Debut",
                  names: parseNames(m[1]),
                },
                nMax: num(m[2]),
                dest: "stage",
              },
            ],
            label: `デッキから指定のDebutホロメン${m[2]}枚を公開してステージに出しますか？`,
          },
        ],
      },
    ];

  // --- コスト修正 (このターンの間 / このゲームの間) ---
  m = text.match(
    /^この(ターン|ゲーム)の間、(.+?)のアーツに必要な(?:◇|無色)-(\d+)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "turnCostMod",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          artCostless: num(m[3]),
          permanent: m[1] === "ゲーム" || undefined,
        },
      ];
  }
  // 特定色コストの軽減 (「アーツに必要な赤-X」等)
  m = text.match(
    new RegExp(`^このターンの間、(.+?)のアーツに必要な${COLOR_RE}-(\\d+)$`),
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "turnCostMod",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          artColorCostless: { color: m[2] as Color, n: num(m[3]) },
        },
      ];
  }
  m = text.match(
    /^このターンの間、(.+?)のバトンタッチに必要な(?:◇|無色)([+-]\d+)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[1]);
    if (tgt)
      return [
        {
          t: "turnCostMod",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
          batonDelta: num(m[2]),
        },
      ];
  }
  m = text.match(
    /^相手のセンターポジションのホロメン(\d+)人は、次の相手のターンが終了するまでバトンタッチに必要な(?:◇|無色)\+(\d+)$/,
  );
  if (m)
    return [
      {
        t: "turnCostMod",
        target: "oppCenter",
        batonDelta: num(m[2]),
        untilNextOppTurn: true,
      },
    ];

  // --- #tag持ちホロメンのエールを他のホロメンに付け替え ---
  m = text.match(
    /^自分の#([^、を]+?)を持つホロメンのエール(\d+)(?:〜(\d+))?枚を、?(.+?)に付け替え(る|られる)$/,
  );
  if (m) {
    const tgt = parseStackTarget(m[4]) ?? parseCheerTargetLoose(m[4]);
    if (tgt)
      return [
        {
          t: "moveYell",
          min: num(m[2]),
          max: num(m[3] ?? m[2]),
          sourceFilter: { tag: m[1] },
          targetFilter: /^自分の他の/.test(m[4])
            ? {
                ...cheerTargetFilter(tgt),
                excludeSource: undefined,
                excludeYellOrigin: true,
              }
            : cheerTargetFilter(tgt),
          optional: m[5] === "られる",
          sameTarget: tgt.count === 1 && num(m[3] ?? m[2]) > 1,
        },
      ];
  }

  // --- エールの付け替え (自分のステージ内) ---
  m = text.match(
    /^自分のステージのエール(?:(\d+)(?:〜(\d+))?枚を|を(好きな枚数))(?:選び)?、?(.+?)に(?:割り振って)?付け替え(る|られる)$/,
  );
  if (m) {
    const targetText = m[4];
    let filter: TargetFilter | null | undefined;
    let sameTarget = false;
    if (/^(?:自分の)?ホロメン$/.test(targetText)) {
      filter = undefined;
    } else if (/^このホロメン$/.test(targetText)) {
      filter = { sourceOnly: true };
    } else if (/^選んだホロメン$/.test(targetText)) {
      filter = { boundOnly: true };
    } else if (/(?:\d+人|全員)$/.test(targetText)) {
      // 「自分の〈N〉X人」等の名称+人数指定はターゲット解析で抽出
      const tgt = parseStackTarget(targetText);
      filter = tgt ? cheerTargetFilter(tgt) : null;
      sameTarget = tgt?.count === 1;
    } else {
      // 「(このホロメン以外の)自分の(修飾)ホロメン」から修飾を抽出
      const mod = targetText.replace(/自分の/, "").replace(/ホロメン$/, "");
      filter = parseTargetFilterMods(mod);
    }
    const anyCount = m[3] !== undefined; // 「好きな枚数」
    if (filter !== null)
      return [
        {
          t: "moveYell",
          min: anyCount ? 0 : num(m[1]),
          max: anyCount ? 99 : num(m[2] ?? m[1]),
          targetFilter: filter ?? undefined,
          optional: anyCount || m[5] === "られる",
          sameTarget: sameTarget && (anyCount || num(m[2] ?? m[1]) > 1),
        },
      ];
  }

  // --- ステージのマスコットを別のホロメンに付け替える ---
  m = text.match(
    /^自分のステージのマスコット(\d+)枚を、?自分のホロメンに付け替え(る|られる)$/,
  );
  if (m && num(m[1]) === 1)
    return [{ t: "moveMascot", optional: m[2] === "られる" }];

  // --- 相手のステージのエールを相手のホロメンに付け替える ---
  m = text.match(
    /^相手のステージのエール(\d+)(?:〜(\d+))?枚を、?相手の(.+?)に付け替え(る|られる)$/,
  );
  if (m) {
    const targetFilter =
      m[3] === "ホロメン"
        ? undefined
        : parseTargetFilterMods(m[3].replace(/ホロメン$/, ""));
    if (targetFilter !== null)
      return [
        {
          t: "moveYell",
          min: num(m[1]),
          max: num(m[2] ?? m[1]),
          side: "opp",
          targetFilter,
          optional: m[4] === "られる",
        },
      ];
  }

  // --- このターンの間、バックホロメン人数比例アーツ+X ---
  m = text.match(
    /^このターンの間、自分のバックホロメン(\d+)人につき、(.+?)のアーツ\+(\d+)$/,
  );
  if (m && num(m[1]) === 1) {
    const tgt = parseStackTarget(m[2]);
    if (tgt)
      return [
        {
          t: "turnArtPlusPerCount",
          value: num(m[3]),
          per: "ownBack",
          target: tgt.target,
          count: tgt.count,
          filter: tgt.filter,
        },
      ];
  }

  // --- 手札をホロパワーにする ---
  m = text.match(/^自分の手札(\d+)枚をホロパワーにする$/);
  if (m) return [{ t: "handToHoloPower", n: num(m[1]) }];

  // --- 「自分の(F)ホロメンX人につき、(効果)」を人数分繰り返す ---
  m = text.match(/^自分の(.+?)(バック|コラボ)?ホロメン(\d+)人につき、(.+)$/);
  if (m && num(m[3]) === 1) {
    let modText = m[1];
    const pos = m[2] === "バック" ? ("back" as const) : undefined;
    const filter = parseSubjectFilter("自分の" + modText + "ホロメン");
    const inner = parseSentence(m[4]);
    if (filter !== null && inner)
      return [{ t: "repeatPerStage", filter: filter ?? {}, pos, ops: inner }];
  }

  // --- ステージのエールを任意でアーカイブ (後続効果なしの単文) ---
  m = text.match(/^自分のステージのエール(\d+)枚をアーカイブできる$/);
  if (m)
    return [
      {
        t: "optionalCost",
        cost: [{ t: "archiveStageYell", n: num(m[1]) }],
        then: [],
        label: `ステージのエール${m[1]}枚をアーカイブしますか？`,
      },
    ];

  // --- 条件文 ---
  m = text.match(/^(.+?)(?:なら|の?時)、(.+)$/);
  if (m) {
    const cond = parseCond(m[1]);
    const then = parseSentence(m[2].replace(/^さらに、?/, ""));
    if (cond && then) return [{ t: "if", cond, then }];
  }
  // 「〜ければ、(効果)」形式の条件文 (少なければ/多ければ等の形容詞条件)
  m = text.match(/^(.+?ければ)、(.+)$/);
  if (m) {
    const cond = parseCond(m[1]);
    const then = parseSentence(m[2].replace(/^さらに、?/, ""));
    if (cond && then) return [{ t: "if", cond, then }];
  }

  // --- 任意コスト (「〜することで、効果」形式) ---
  m = text.match(/^(.+?)することで、(.+)$/);
  if (m) {
    const cost = parseCostClause(m[1]);
    const then = parseSentence(m[2]);
    if (cost && then)
      return [
        {
          t: "optionalCost",
          cost: cost.ops,
          then,
          label: `${cost.label}して効果を使いますか？`,
        },
      ];
  }

  // --- 任意コスト (「〜できる：効果」/「〜せる：効果」等の可能形コスト) ---
  m = text.match(/^(.+?)(できる|せる|られる|れる)[:：](.+)$/);
  if (m) {
    // 「できる」はコスト動詞に含めず除去、可能形(せる/られる/れる)は動詞の一部なので残す
    const costText = m[2] === "できる" ? m[1] : m[1] + m[2];
    const cost = parseCostClause(costText);
    const then = parseSentence(m[3]);
    if (cost && then)
      return [
        {
          t: "optionalCost",
          cost: cost.ops,
          then,
          label: `${cost.label}して効果を使いますか？`,
        },
      ];
  }

  // --- 必須コスト (「〜する：効果」形式: コストと効果を順に実行) ---
  m = text.match(/^(.+?する)[:：](.+)$/);
  if (m) {
    const cost = parseSentence(m[1]);
    const then = parseSentence(m[2]);
    if (cost && then) return [...cost, ...then];
  }

  // --- 「手札に加えたなら、(効果)」: 直前の選択で実際に手札へ加えた場合だけ後続 ---
  m = text.match(/^手札に加えたなら、(.+)$/);
  if (m) {
    const then = parseSentence(m[1]);
    return then
      ? [{ t: "if", cond: { c: "pickedAtLeast", n: 1 }, then }]
      : null;
  }
  // --- 「X枚以上付けたなら、このターンの間、そのホロメンのアーツ+Y」: 付けた枚数条件+付け先参照 ---
  m = text.match(
    /^(\d+)枚以上付けたなら、このターンの間、その(?:ホロメンの)?アーツ\+(\d+)$/,
  );
  if (m)
    return [
      {
        t: "if",
        cond: { c: "attachedAtLeast", n: num(m[1]) },
        then: [{ t: "turnArtPlusAttachedTo", value: num(m[2]) }],
      },
    ];

  // --- 「付けたなら、(効果)」: 直前の付与効果が実際に成功した場合だけ後続 ---
  m = text.match(/^付けたなら、(.+)$/);
  if (m) {
    const then = parseSentence(m[1]);
    return then
      ? [{ t: "if", cond: { c: "attachedAtLeast", n: 1 }, then }]
      : null;
  }

  // --- その後、〜 / そして〜 の前置きを剥がして再解析 ---
  m = text.match(/^(?:その後、|そして)(.+)$/);
  if (m) return parseSentence(m[1]);

  return null;
}

/** 外側の optionalCost で使用可否を選んだ後は、内側の可能形Opを必須コストとして扱う。 */
function asMandatoryCostOp(op: Op): Op {
  switch (op.t) {
    case "backToDeckBottom":
      return { ...op, cost: true };
    case "draw":
    case "oppDraw":
    case "dice":
    case "cheerFromTop":
    case "cheerFromArchive":
    case "cheerFromArchiveToGroups":
    case "moveArchive":
    case "moveYell":
    case "selfToBack":
    case "selfSwapWithCollab":
    case "repeatArtGrant":
    case "moveMascot":
    case "archiveOppAttached":
    case "effectBloom":
    case "millDeck":
      return { ...op, optional: undefined };
    default:
      return op;
  }
}

/** 任意コスト節の解析 (「〜できる：」の〜部分) */
function parseCostClause(text: string): { ops: Op[]; label: string } | null {
  text = text.trim();
  const limited = text.match(
    /^自分の手札のLIMITEDのサポート(\d+)枚をアーカイブ$/,
  );
  if (limited)
    return {
      ops: [
        {
          t: "archiveHand",
          n: num(limited[1]),
          supportOnly: true,
          limited: true,
        },
      ],
      label: text,
    };
  const top = text.match(
    /^自分の手札の(.+?)(\d+)枚を公開し、デッキの上に戻せる$/,
  );
  if (top) {
    const filter = parseCardFilter(top[1]);
    if (filter)
      return {
        ops: [
          {
            t: "handToDeckBottom",
            n: num(top[2]),
            top: true,
            filter,
            reveal: true,
          },
        ],
        label: text,
      };
  }
  {
    const ma = text.match(/^自分の手札を好きな枚数アーカイブ$/);
    if (ma)
      return {
        ops: [{ t: "archiveHand", n: 1, max: 99 }],
        label: "手札を好きな枚数アーカイブ",
      };
  }
  if (/^このホロメンのエールを好きな枚数アーカイブ$/.test(text))
    return {
      ops: [{ t: "archiveSelfYellAny" }],
      label: "このホロメンのエールを好きな枚数アーカイブ",
    };
  let m = text.match(
    /^自分の手札(のホロメン)?(\d+)(?:〜(\d+))?枚をアーカイブ$/,
  );
  if (m)
    return {
      ops: [
        {
          t: "archiveHand",
          n: num(m[2]),
          max: m[3] ? num(m[3]) : undefined,
          holomenOnly: !!m[1],
        },
      ],
      label: m[3]
        ? `手札${m[2]}〜${m[3]}枚をアーカイブ`
        : `手札${m[2]}枚をアーカイブ`,
    };
  if (/^自分の手札を数えて、自分の手札すべてをアーカイブ$/.test(text))
    return { ops: [{ t: "archiveHandAll" }], label: "手札すべてをアーカイブ" };
  m = text.match(/^自分の手札のサポートカード(\d+)(?:〜(\d+))?枚をアーカイブ$/);
  if (m)
    return {
      ops: [
        {
          t: "archiveHand",
          n: num(m[1]),
          max: m[2] ? num(m[2]) : undefined,
          supportOnly: true,
        },
      ],
      label: m[2]
        ? `手札のサポートカード${m[1]}〜${m[2]}枚をアーカイブ`
        : `手札のサポートカード${m[1]}枚をアーカイブ`,
    };
  m = text.match(
    /^自分の手札の#([^、を]+?)を持つホロメン(\d+)(?:〜(\d+))?枚をアーカイブ$/,
  );
  if (m)
    return {
      ops: [
        {
          t: "archiveHand",
          n: num(m[2]),
          max: m[3] ? num(m[3]) : undefined,
          tag: m[1],
          holomenOnly: true,
        },
      ],
      label: `手札の#${m[1]}持ちホロメン${m[2]}枚をアーカイブ`,
    };
  m = text.match(/^自分の手札の同じタグを持つホロメン(\d+)枚をアーカイブ$/);
  if (m)
    return {
      ops: [
        { t: "archiveHand", n: num(m[1]), holomenOnly: true, sameTag: true },
      ],
      label: `手札の同じタグを持つホロメン${m[1]}枚をアーカイブ`,
    };
  m = text.match(
    /^自分の#([^、を]+?)を持つホロメンのエール(\d+)枚をアーカイブ$/,
  );
  if (m)
    return {
      ops: [
        { t: "archiveStageYell", n: num(m[2]), stackFilter: { tag: m[1] } },
      ],
      label: `#${m[1]}持ちホロメンのエール${m[2]}枚をアーカイブ`,
    };
  m = text.match(
    /^自分のステージの((?:〈[^〉]+〉)+)(\d+)(?:〜(\d+))?枚をアーカイブ$/,
  );
  if (m)
    return {
      ops: [
        {
          t: "archiveStageSupports",
          names: parseNames(m[1]),
          n: num(m[2]),
          max: m[3] ? num(m[3]) : undefined,
        },
      ],
      label: `ステージの${m[1]}${m[2]}${m[3] ? `〜${m[3]}` : ""}枚をアーカイブ`,
    };
  // 「このホロメン」は発生源のみ。「自分の〈名前〉」は同名の別ホロメンも含む。
  m = text.match(
    /^(このホロメン|自分の(?:〈[^〉]+〉)+)に重なっている(Debut|1st|2nd)?ホロメン(\d+)枚をアーカイブ$/,
  );
  if (m)
    return {
      ops: [
        {
          t: "archiveStacked",
          n: num(m[3]),
          level: m[2] as "Debut" | "1st" | "2nd" | undefined,
          ...(m[1].startsWith("自分の")
            ? { holderNames: parseNames(m[1]) }
            : {}),
        },
      ],
      label: `重なっている${m[2] ?? ""}ホロメン${m[3]}枚をアーカイブ`,
    };
  m = text.match(
    /^このホロメンに付いている(ツール|マスコット|ファン)?(\d+)枚をアーカイブ$/,
  );
  if (m)
    return {
      ops: [
        {
          t: "archiveAttached",
          n: num(m[2]),
          kind: m[1] as "ツール" | "マスコット" | "ファン" | undefined,
        },
      ],
      label: `付いている${m[1] ?? "サポート"}${m[2]}枚をアーカイブ`,
    };
  m = text.match(
    /^このホロメンに付いている((?:〈[^〉]+〉)+)(\d+)枚をデッキの上に戻(?:す|せる)$/,
  );
  if (m && num(m[2]) === 1)
    return {
      ops: [{ t: "selfSupportToDeckTop" }],
      label: `付いている${m[1]}をデッキの上に戻`,
    };
  m = text.match(
    new RegExp(
      `^このホロメンの\\[((?:${COLOR_RE}エール)(?:か${COLOR_RE}エール)+)\\](\\d+)枚をアーカイブ$`,
    ),
  );
  if (m) {
    const colors = [...m[1].matchAll(/(白|緑|赤|青|紫|黄)エール/g)].map(
      (mm) => mm[1] as Color,
    );
    return {
      ops: [{ t: "archiveSelfYell", colors, n: num(m[m.length - 1]) }],
      label: `このホロメンの[${colors.join("か")}]エール${m[m.length - 1]}枚をアーカイブ`,
    };
  }
  m = text.match(
    new RegExp(`^このホロメンの${COLOR_RE}以外のエール(\\d+)枚をアーカイブ$`),
  );
  if (m)
    return {
      ops: [
        { t: "archiveSelfYell", excludeColor: m[1] as Color, n: num(m[2]) },
      ],
      label: `このホロメンの${m[1]}以外のエール${m[2]}枚をアーカイブ`,
    };
  m = text.match(/^このホロメンのエール(\d+)〜(\d+)枚をアーカイブ$/);
  if (m)
    return {
      ops: [{ t: "archiveSelfYellAny", min: num(m[1]), max: num(m[2]) }],
      label: `このホロメンのエール${m[1]}〜${m[2]}枚をアーカイブ`,
    };
  m = text.match(
    new RegExp(
      `^このホロメン(?:の|に付いている)${COLOR_RE}?エール(\\d+)枚をアーカイブ$`,
    ),
  );
  if (m)
    return {
      ops: [
        {
          t: "archiveSelfYell",
          color: m[1] as Color | undefined,
          n: num(m[2]),
        },
      ],
      label: `このホロメンの${m[1] ?? ""}エール${m[2]}枚をアーカイブ`,
    };
  m = text.match(/^自分のバックホロメンのエール(\d+)枚をアーカイブ$/);
  if (m)
    return {
      ops: [{ t: "archiveStageYell", n: num(m[1]), pos: "back" }],
      label: `バックホロメンのエール${m[1]}枚をアーカイブ`,
    };
  m = text.match(/^自分のバックホロメン(\d+)人のHP(\d+)回復$/);
  if (m)
    return {
      ops: [
        {
          t: "heal",
          value: num(m[2]),
          target: "chooseOwnBack",
          count: num(m[1]),
        },
      ],
      label: `バックホロメン${m[1]}人のHP${m[2]}回復`,
    };
  m = text.match(/^自分の((?:〈[^〉]+〉)+)のエール(\d+)枚をアーカイブ$/);
  if (m)
    return {
      ops: [
        {
          t: "archiveStageYell",
          n: num(m[2]),
          stackFilter: { names: parseNames(m[1]) },
        },
      ],
      label: `〈${parseNames(m[1]).join("・")}〉のエール${m[2]}枚をアーカイブ`,
    };
  m = text.match(
    /^自分の#([^、を]+?)を持つホロメンのエール(\d+)枚をアーカイブ$/,
  );
  if (m)
    return {
      ops: [
        { t: "archiveStageYell", n: num(m[2]), stackFilter: { tag: m[1] } },
      ],
      label: `#${m[1]}持ちのエール${m[2]}枚をアーカイブ`,
    };
  m = text.match(
    new RegExp(
      `^自分の(?:ステージの)?ホロメンの${COLOR_RE}?エール(\\d+)枚をアーカイブ$`,
    ),
  );
  if (m)
    return {
      ops: [
        {
          t: "archiveStageYell",
          n: num(m[2]),
          yellColor: m[1] as Color | undefined,
        },
      ],
      label: `自分のホロメンの${m[1] ?? ""}エール${m[2]}枚をアーカイブ`,
    };
  m = text.match(/^自分のエールデッキの上から(\d+)(?:〜(\d+))?枚をアーカイブ$/);
  if (m)
    return {
      ops: [
        { t: "millCheer", n: num(m[1]), max: m[2] ? num(m[2]) : undefined },
      ],
      label: m[2]
        ? `エールデッキの上から${m[1]}〜${m[2]}枚をアーカイブ`
        : `エールデッキの上から${m[1]}枚をアーカイブ`,
    };
  m = text.match(/^自分のホロパワーの上から(\d+)枚を公開$/);
  if (m)
    return {
      ops: [{ t: "revealHoloTop", n: num(m[1]) }],
      label: `ホロパワーの上から${m[1]}枚を公開`,
    };
  m = text.match(/^自分のステージのエール(\d+)枚をアーカイブ$/);
  if (m)
    return {
      ops: [{ t: "archiveStageYell", n: num(m[1]) }],
      label: `ステージのエール${m[1]}枚をアーカイブ`,
    };
  m = text.match(/^自分のデッキの上から(\d+)〜(\d+)枚をアーカイブ$/);
  if (m)
    return {
      ops: [{ t: "millDeck", n: num(m[1]), max: num(m[2]) }],
      label: `デッキの上から${m[1]}〜${m[2]}枚をアーカイブ`,
    };
  m = text.match(/^自分のデッキの上から(\d+)枚をアーカイブ$/);
  if (m)
    return {
      ops: [{ t: "millDeck", n: num(m[1]) }],
      label: `デッキの上から${m[1]}枚をアーカイブ`,
    };
  m = text.match(
    /^自分の手札の((?:〈[^〉]+〉)+)(\d+)枚を公開し、デッキの下に戻せる$/,
  );
  if (m)
    return {
      ops: [
        { t: "handToDeckBottomNamed", n: num(m[2]), names: parseNames(m[1]) },
      ],
      label: `手札の${m[1]}${m[2]}枚を公開してデッキの下に戻す`,
    };
  m = text.match(
    /^自分のバックポジションのDebutホロメン(?:の((?:〈[^〉]+〉)+))?(\d+)人をデッキの下に戻せる$/,
  );
  if (m)
    return {
      ops: [
        {
          t: "backToDeckBottom",
          cost: true,
          n: num(m[2]),
          filter: {
            bloomLevel: "Debut",
            ...(m[1] ? { names: parseNames(m[1]) } : {}),
          },
        },
      ],
      label: `バックのDebutホロメン${m[1] ?? ""}${m[2]}人をデッキの下に戻す`,
    };
  m = text.match(/^自分のホロパワー(?:の上から)?(\d+)枚をアーカイブ$/);
  if (m)
    return {
      ops: [{ t: "archiveHoloPower", n: num(m[1]) }],
      label: `ホロパワーの上から${m[1]}枚をアーカイブ`,
    };
  m = text.match(/^自分のデッキの上から(\d+)枚を公開$/);
  if (m)
    return {
      ops: [{ t: "revealTop", n: num(m[1]) }],
      label: `デッキの上から${m[1]}枚を公開`,
    };
  // 汎用フォールバック: コスト文を通常のOp列として解析できればコストとして使う
  // (アーカイブ→デッキ移動等。「〜せる/られる」の任意形は各パーサーが吸収する)
  const generic = parseSentence(text);
  if (generic && generic.length > 0)
    return { ops: generic.map(asMandatoryCostOp), label: text };
  return null;
}

function parseDiceBranches(text: string): DiceBranch[] | null {
  const branches: DiceBranch[] = [];
  const parts = text.split(/。/).filter((p) => p.trim());
  for (const part of parts) {
    const t = part.trim();
    if (IGNORABLE.some((re) => re.test(t))) continue;
    if (NO_LIFE_RIDER.test(t)) {
      // 直前の分岐の special / down に noLife を付与
      for (const br of branches) applyNoLifeRider(br.ops);
      continue;
    }
    // 「出た目の数Xにつき、(効果)」= 出た目に比例して効果を繰り返す
    const pv = t.match(/^出た目の数(\d+)につき、(.+)$/);
    if (pv) {
      const pvOps = parseSentence(pv[2]);
      if (!pvOps) return null;
      branches.push({ cond: { perValue: num(pv[1]) }, ops: pvOps });
      continue;
    }
    // 「出た回数につき」は個別の出目による分岐と区別し、数量をまとめて解決する。
    const oc = t.match(/^(?:(.+?)に、)?奇数が出た回数(\d+)回につき、(.+)$/);
    if (oc && num(oc[2]) === 1) {
      const ocOps = parseSentence((oc[1] ? `${oc[1]}に` : "") + oc[3]);
      if (!ocOps) return null;
      branches.push({ cond: "odd", ops: ocOps, countBased: true });
      continue;
    }
    // 「X以上が出た回数X回につき、(効果)」= X以上の出た回ごとに効果
    const gc = t.match(/^(\d+)以上が出た回数(\d+)回につき、(.+)$/);
    if (gc && num(gc[2]) === 1) {
      const gcOps = parseSentence(gc[3]);
      if (!gcOps) return null;
      branches.push({ cond: { ge: num(gc[1]) }, ops: gcOps, countBased: true });
      continue;
    }
    const m = t.match(/^(?:出た目が)?(.+?)(?:の時|なら)、?(さらに、?)?(.+)$/);
    if (!m) return null;
    const cond = parseDiceCond(m[1]);
    const ops = parseSentence(m[3].trim());
    if (!cond || !ops) return null;
    branches.push({ cond, ops });
  }
  return branches.length > 0 ? branches : null;
}
