import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  cardImageVariants,
  cardImageUrl,
  getCard,
  holomenCards,
  oshiCards,
  supportCards,
  yellCards,
} from "../../data/loader";
import type { BloomLevel, Card, Color, SupportType } from "../../data/types";
import { validateDeck } from "../../game/decks/rules";
import type { DeckArtworkSelection, DeckList } from "../../game/types";
import { CardDescription } from "../cards/CardDescription";
import { Brand, Icon } from "../common/Brand";
import { CardPreviewButton } from "../cards/CardPreviewButton";
import { CardView } from "../cards/CardView";
import { useModalFocus } from "../common/useModalFocus";
import {
  DECK_NAME_MAX_LENGTH,
  deckNameInputError,
} from "../common/inputValidation";

const COLORS: Color[] = ["白", "緑", "赤", "青", "紫", "黄", "無"];
const BLOOM_LEVELS: BloomLevel[] = ["Debut", "1st", "2nd", "Spot"];
const SUPPORT_TYPES: SupportType[] = [
  "スタッフ",
  "アイテム",
  "イベント",
  "ツール",
  "マスコット",
  "ファン",
];
type ArtworkCounts = Record<string, Record<string, number>>;

export function DeckBuilder({
  initialDeck,
  saveError,
  onDone,
}: {
  initialDeck?: DeckList;
  saveError?: string | null;
  onDone: (deck: DeckList | null) => void;
}) {
  const [name, setName] = useState(initialDeck?.name ?? "カスタムデッキ");
  const [oshiId, setOshiId] = useState<string | null>(
    initialDeck?.oshiId ?? null,
  );
  const [main, setMain] = useState<Record<string, number>>(() => ({
    ...(initialDeck?.main ?? {}),
  }));
  const [cheer, setCheer] = useState<Record<string, number>>(() => ({
    ...(initialDeck?.cheer ?? {}),
  }));
  const [oshiArtwork, setOshiArtwork] = useState<string | null>(
    initialDeck?.artworks?.oshi ?? null,
  );
  const [mainArtworks, setMainArtworks] = useState<ArtworkCounts>(() =>
    cloneArtworkCounts(initialDeck?.artworks?.main),
  );
  const [cheerArtworks, setCheerArtworks] = useState<ArtworkCounts>(() =>
    cloneArtworkCounts(initialDeck?.artworks?.cheer),
  );
  const [artworkPickerId, setArtworkPickerId] = useState<string | null>(null);
  const [tab, setTab] = useState<"oshi" | "holomen" | "support" | "yell">(
    "oshi",
  );
  const [query, setQuery] = useState("");
  const [colorFilter, setColorFilter] = useState<Color | "">("");
  const [bloomFilter, setBloomFilter] = useState<BloomLevel | "">("");
  const [supportTypeFilter, setSupportTypeFilter] = useState<SupportType | "">(
    "",
  );
  const [mobilePane, setMobilePane] = useState<"cards" | "deck">("cards");
  const [previewCardId, setPreviewCardId] = useState<string | null>(null);
  const [previewClosing, setPreviewClosing] = useState(false);

  const mainTotal = Object.values(main).reduce((a, b) => a + b, 0);
  const cheerTotal = Object.values(cheer).reduce((a, b) => a + b, 0);

  const pool: Card[] = useMemo(() => {
    let list: Card[] =
      tab === "oshi"
        ? oshiCards
        : tab === "holomen"
          ? holomenCards
          : tab === "support"
            ? supportCards
            : yellCards;
    if (colorFilter) {
      list = list.filter((c) => {
        if (c.cardType === "holomen") return c.colors.includes(colorFilter);
        if (c.cardType === "oshi" || c.cardType === "yell")
          return c.color === colorFilter;
        return true;
      });
    }
    if (tab === "holomen" && bloomFilter) {
      list = list.filter(
        (c) => c.cardType === "holomen" && c.bloomLevel === bloomFilter,
      );
    }
    if (tab === "support" && supportTypeFilter) {
      list = list.filter(
        (c) => c.cardType === "support" && c.supportType === supportTypeFilter,
      );
    }
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
      );
    }
    return list;
  }, [tab, query, colorFilter, bloomFilter, supportTypeFilter]);
  const cardsRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [grid, setGrid] = useState({
    columns: 1,
    rowHeight: 0,
    gap: 0,
    height: 0,
    paddingTop: 0,
  });

  // CSS の列数・カードの高さを使い、画面幅に応じて全件分の高さを確保する。
  useLayoutEffect(() => {
    const el = cardsRef.current;
    if (!el) return;
    const measure = () => {
      const card = el.querySelector<HTMLElement>(".db-card");
      if (!card || !el.clientWidth) return;
      const style = getComputedStyle(el);
      const next = {
        columns: style.gridTemplateColumns.split(" ").length,
        rowHeight: card.getBoundingClientRect().height,
        gap: parseFloat(style.rowGap) || 0,
        height: el.clientHeight,
        paddingTop: parseFloat(style.paddingTop) || 0,
      };
      setGrid((current) =>
        Object.keys(next).every(
          (key) =>
            current[key as keyof typeof next] ===
            next[key as keyof typeof next],
        )
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const card = el.querySelector(".db-card");
    if (card) observer.observe(card);
    return () => observer.disconnect();
  });

  useLayoutEffect(() => {
    if (cardsRef.current) cardsRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [pool]);

  const rowCount = Math.ceil(pool.length / grid.columns);
  const stride = grid.rowHeight + grid.gap;
  const firstRow = grid.rowHeight
    ? Math.min(
        Math.max(0, rowCount - 1),
        Math.max(0, Math.floor((scrollTop - grid.paddingTop) / stride) - 3),
      )
    : 0;
  const lastRow = grid.rowHeight
    ? Math.min(
        rowCount,
        Math.max(
          firstRow + 1,
          Math.ceil((scrollTop + grid.height - grid.paddingTop) / stride) + 3,
        ),
      )
    : Math.min(rowCount, 60);

  const canAddCard = (id: string) => {
    const c = getCard(id);
    if (c.cardType === "oshi") return true;
    if (c.cardType === "yell") return cheerTotal < 20;
    const cur = main[id] ?? 0;
    const limit = c.cardType === "holomen" && c.unlimitedCopies ? 50 : 4;
    return cur < limit && mainTotal < 50;
  };

  const openArtworkPicker = (id: string) => setArtworkPickerId(id);

  const addCard = (id: string, artworkKey?: string) => {
    if (!canAddCard(id)) return;
    const c = getCard(id);
    const defaultArtwork = c.imageVariants[0];
    const alternateArtwork =
      artworkKey && artworkKey !== defaultArtwork ? artworkKey : undefined;
    if (c.cardType === "oshi") {
      setOshiId(id);
      setOshiArtwork(alternateArtwork ?? null);
    } else if (c.cardType === "yell") {
      setCheer((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
      if (alternateArtwork)
        incrementArtwork(setCheerArtworks, id, alternateArtwork);
    } else {
      setMain((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
      if (alternateArtwork)
        incrementArtwork(setMainArtworks, id, alternateArtwork);
    }
  };

  const removeCard = (
    id: string,
    from: "main" | "cheer",
    artworkKey: string,
  ) => {
    const set = from === "main" ? setMain : setCheer;
    set((m) => {
      const n = { ...m };
      if (n[id] > 1) n[id]--;
      else delete n[id];
      return n;
    });
    if (artworkKey !== getCard(id).imageVariants[0]) {
      const setArtworks = from === "main" ? setMainArtworks : setCheerArtworks;
      decrementArtwork(setArtworks, id, artworkKey);
    }
  };

  const removeArtwork = (id: string, artworkKey: string) => {
    const card = getCard(id);
    if (card.cardType === "oshi") return;
    const selectedCounts = selectedArtworkCounts(
      id,
      oshiId,
      oshiArtwork,
      main,
      mainArtworks,
      cheer,
      cheerArtworks,
    );
    if ((selectedCounts[artworkKey] ?? 0) <= 0) return;
    removeCard(id, card.cardType === "yell" ? "cheer" : "main", artworkKey);
  };

  const openPreview = (id: string) => {
    setPreviewClosing(false);
    setPreviewCardId(id);
  };

  const closePreview = () => {
    if (!previewCardId || previewClosing) return;
    setPreviewClosing(true);
  };

  const previewRef = useRef<HTMLDivElement>(null);
  useModalFocus(previewRef, {
    active: previewCardId !== null,
    onEscape: closePreview,
  });

  const normalizedName = name.trim();
  const nameError = deckNameInputError(name);
  const artworks = compactArtworks(oshiArtwork, mainArtworks, cheerArtworks);
  const deck: DeckList | null =
    oshiId && nameError === null
      ? {
          name: normalizedName,
          oshiId,
          main,
          cheer,
          ...(artworks ? { artworks } : {}),
        }
      : null;
  const validation = deck ? validateDeck(deck) : null;
  const validationMessages = validation
    ? validation.errors
    : [
        ...(nameError ? [nameError] : []),
        ...(!oshiId ? ["推しホロメンカードを1枚選んでください"] : []),
        ...(mainTotal !== 50
          ? [`デッキは50枚ちょうどにしてください (現在${mainTotal}枚)`]
          : []),
        ...(cheerTotal !== 20
          ? [`エールデッキは20枚ちょうどにしてください (現在${cheerTotal}枚)`]
          : []),
      ];
  const validationComplete = validation?.ok === true;
  const validationMessage = validationComplete
    ? "デッキが完成しました"
    : validationMessages.join(" / ");

  return (
    <main className="deck-builder">
      <div className="db-titlebar">
        <Brand />
        <h1>デッキ構築</h1>
        <span>BUILD A DECK</span>
      </div>
      <header className="db-header">
        <label className="db-name-field">
          <span>{initialDeck ? "EDIT DECK" : "DECK NAME"}</span>
          <input
            aria-label="デッキ名"
            value={name}
            maxLength={DECK_NAME_MAX_LENGTH}
            aria-invalid={nameError !== null}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="db-metrics" aria-live="polite">
          <div className={`db-metric${mainTotal === 50 ? " complete" : ""}`}>
            <span>メイン</span>
            <strong>
              {mainTotal}
              <small>/50</small>
            </strong>
          </div>
          <div className={`db-metric${cheerTotal === 20 ? " complete" : ""}`}>
            <span>エール</span>
            <strong>
              {cheerTotal}
              <small>/20</small>
            </strong>
          </div>
          <div
            className={`db-metric db-metric-oshi${oshiId ? " complete" : ""}`}
          >
            <span>推しホロメン</span>
            <strong>{oshiId ? getCard(oshiId).name : "未選択"}</strong>
          </div>
        </div>
        <div className="db-header-actions">
          <button onClick={() => onDone(null)}>
            <Icon name="arrow" className="icon-back" />
            キャンセル
          </button>
          <button
            className="primary"
            disabled={!deck || !validation?.ok}
            onClick={() => deck && onDone(deck)}
          >
            {initialDeck ? "変更を保存" : "デッキを保存"}
          </button>
        </div>
      </header>
      {nameError && (
        <div className="db-errors" role="alert">
          <strong>デッキ名を確認してください</strong>
          <span>{nameError}</span>
        </div>
      )}
      {saveError && (
        <div className="db-errors" role="alert">
          <strong>保存できませんでした</strong>
          <span>{saveError}</span>
        </div>
      )}
      <div
        className={`db-errors db-validation-banner${validationComplete ? " is-valid" : ""}`}
        role="status"
      >
        <span>{validationMessage}</span>
      </div>
      <div
        className="db-mobile-switch"
        role="tablist"
        aria-label="デッキ編集画面"
      >
        <button
          id="db-mobile-cards-tab"
          type="button"
          role="tab"
          aria-controls="db-cards-pane"
          aria-selected={mobilePane === "cards"}
          className={mobilePane === "cards" ? "active" : ""}
          onClick={() => setMobilePane("cards")}
        >
          カード一覧
        </button>
        <button
          id="db-mobile-deck-tab"
          type="button"
          role="tab"
          aria-controls="db-deck-pane"
          aria-selected={mobilePane === "deck"}
          className={mobilePane === "deck" ? "active" : ""}
          onClick={() => setMobilePane("deck")}
        >
          デッキ内容
          <span>{mainTotal + cheerTotal + (oshiId ? 1 : 0)}</span>
        </button>
      </div>
      <div className={`db-body db-mobile-pane-${mobilePane}`}>
        <section
          id="db-cards-pane"
          className="db-pool"
          aria-label="カード一覧"
          aria-labelledby="db-mobile-cards-tab"
        >
          <div className="db-filters">
            <div className="db-tabs" role="tablist" aria-label="カード種別">
              {(["oshi", "holomen", "support", "yell"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t === "oshi"
                    ? "推し"
                    : t === "holomen"
                      ? "ホロメン"
                      : t === "support"
                        ? "サポート"
                        : "エール"}
                </button>
              ))}
            </div>
            <div className="db-filter-controls">
              {tab !== "support" && (
                <label>
                  <span>色</span>
                  <select
                    aria-label="色で絞り込む"
                    value={colorFilter}
                    onChange={(e) =>
                      setColorFilter(e.target.value as Color | "")
                    }
                  >
                    <option value="">全色</option>
                    {COLORS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {tab === "holomen" && (
                <label>
                  <span>Bloomレベル</span>
                  <select
                    aria-label="Bloomレベルで絞り込む"
                    value={bloomFilter}
                    onChange={(e) =>
                      setBloomFilter(e.target.value as BloomLevel | "")
                    }
                  >
                    <option value="">すべて</option>
                    {BLOOM_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level === "1st" ? "1st（Buzz含む）" : level}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {tab === "support" && (
                <label>
                  <span>カード種別</span>
                  <select
                    aria-label="サポートカード種別で絞り込む"
                    value={supportTypeFilter}
                    onChange={(e) =>
                      setSupportTypeFilter(e.target.value as SupportType | "")
                    }
                  >
                    <option value="">すべて</option>
                    {SUPPORT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="db-search-field">
                <span>検索</span>
                <input
                  aria-label="カード名またはIDで検索"
                  placeholder="カード名 / ID"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <span className="db-count">{pool.length}件</span>
            </div>
          </div>
          <div
            ref={cardsRef}
            className="db-cards db-cards-virtual"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {firstRow > 0 && (
              <div
                className="db-card-spacer"
                aria-hidden="true"
                style={{ height: firstRow * stride - grid.gap }}
              />
            )}
            {pool
              .slice(firstRow * grid.columns, lastRow * grid.columns)
              .map((c) => {
                const selectedCount =
                  c.cardType === "oshi"
                    ? oshiId === c.id
                      ? 1
                      : 0
                    : c.cardType === "yell"
                      ? (cheer[c.id] ?? 0)
                      : (main[c.id] ?? 0);
                return (
                  <div
                    key={c.id}
                    className={`db-card${selectedCount ? " selected" : ""}`}
                  >
                    <div className="db-card-visual">
                      <CardView
                        cardId={c.id}
                        size="md"
                        lazy
                        onClick={() => openArtworkPicker(c.id)}
                        title={
                          c.cardType === "oshi"
                            ? `${c.name}を推しホロメンに設定`
                            : `${c.name}の画像と枚数を選択`
                        }
                      />
                      <CardPreviewButton
                        cardName={c.name}
                        onPreview={() => openPreview(c.id)}
                      />
                      {selectedCount > 0 && (
                        <span className="db-card-quantity">
                          {c.cardType === "oshi" ? "推し" : `×${selectedCount}`}
                        </span>
                      )}
                    </div>
                    <span className="db-card-name">{c.name}</span>
                    <span className="db-card-id">{c.id}</span>
                  </div>
                );
              })}
            {pool.length === 0 && (
              <div className="db-empty">条件に一致するカードがありません。</div>
            )}
            {lastRow < rowCount && (
              <div
                className="db-card-spacer"
                aria-hidden="true"
                style={{ height: (rowCount - lastRow) * stride - grid.gap }}
              />
            )}
          </div>
        </section>
        <aside
          id="db-deck-pane"
          className="db-list"
          aria-label="デッキ内容"
          aria-labelledby="db-mobile-deck-tab"
        >
          <div className="db-list-header">
            <div>
              <span className="eyebrow">YOUR DECK</span>
              <h2>デッキ内容</h2>
            </div>
            <span className="db-list-total">
              {mainTotal + cheerTotal + (oshiId ? 1 : 0)}枚
            </span>
          </div>

          <div
            className={`db-mobile-validation${validationComplete ? " is-valid" : ""}`}
            role="status"
          >
            <span>{validationMessage}</span>
          </div>

          <section className="db-list-section">
            <h3>推しホロメン</h3>
            {oshiId ? (
              <button
                type="button"
                className="db-row db-row-oshi"
                style={rowArtStyle(oshiId, oshiArtwork ?? undefined)}
                aria-label={`${getCard(oshiId).name}の推し画像を変更`}
                onClick={() => openArtworkPicker(oshiId)}
              >
                <span className="db-row-count">★</span>
                <span className="db-row-name">{getCard(oshiId).name}</span>
              </button>
            ) : (
              <p className="db-empty-row">カード一覧から1枚選択</p>
            )}
          </section>

          <section className="db-list-section">
            <h3>
              メインデッキ <span>{mainTotal}/50</span>
            </h3>
            {deckArtworkRows(main, mainArtworks).map((row) => (
              <div
                key={`${row.cardId}:${row.artworkKey}`}
                className="db-row db-row-adjustable"
                style={rowArtStyle(row.cardId, row.artworkKey)}
              >
                <span className="db-row-count">{row.count}</span>
                <span className="db-row-name">
                  {getCard(row.cardId).name}
                  <small>
                    {row.cardId}
                    {row.variantIndex > 0
                      ? ` · イラスト${row.variantIndex + 1}`
                      : ""}
                  </small>
                </span>
                <CountAdjustButtons
                  className="db-row-count-controls"
                  decrementLabel={`${getCard(row.cardId).name}を1枚減らす`}
                  incrementLabel={`${getCard(row.cardId).name}を1枚増やす`}
                  onDecrement={() =>
                    removeCard(row.cardId, "main", row.artworkKey)
                  }
                  onIncrement={() => addCard(row.cardId, row.artworkKey)}
                  incrementDisabled={!canAddCard(row.cardId)}
                />
              </div>
            ))}
            {mainTotal === 0 && (
              <p className="db-empty-row">まだカードがありません</p>
            )}
          </section>

          <section className="db-list-section">
            <h3>
              エールデッキ <span>{cheerTotal}/20</span>
            </h3>
            {deckArtworkRows(cheer, cheerArtworks).map((row) => (
              <div
                key={`${row.cardId}:${row.artworkKey}`}
                className="db-row db-row-adjustable"
                style={rowArtStyle(row.cardId, row.artworkKey)}
              >
                <span className="db-row-count">{row.count}</span>
                <span className="db-row-name">
                  {getCard(row.cardId).name}
                  {row.variantIndex > 0 && (
                    <small>イラスト{row.variantIndex + 1}</small>
                  )}
                </span>
                <CountAdjustButtons
                  className="db-row-count-controls"
                  decrementLabel={`${getCard(row.cardId).name}を1枚減らす`}
                  incrementLabel={`${getCard(row.cardId).name}を1枚増やす`}
                  onDecrement={() =>
                    removeCard(row.cardId, "cheer", row.artworkKey)
                  }
                  onIncrement={() => addCard(row.cardId, row.artworkKey)}
                  incrementDisabled={!canAddCard(row.cardId)}
                />
              </div>
            ))}
            {cheerTotal === 0 && (
              <p className="db-empty-row">まだカードがありません</p>
            )}
          </section>

          <p className="db-hint">
            推しホロメンは画像を選ぶと設定されます。他のカードは画像ごとの−/＋で枚数を変更できます。
          </p>
        </aside>
      </div>
      {previewCardId && (
        <div
          className={`db-card-preview${previewClosing ? " is-closing" : ""}`}
          ref={previewRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="db-card-preview-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePreview();
          }}
          onAnimationEnd={(event) => {
            if (!previewClosing || event.target !== event.currentTarget) return;
            setPreviewCardId(null);
            setPreviewClosing(false);
          }}
        >
          <DeckCardPreviewContent
            cardId={previewCardId}
            titleId="db-card-preview-title"
            onClose={closePreview}
          />
        </div>
      )}
      {artworkPickerId && (
        <ArtworkPickerDialog
          cardId={artworkPickerId}
          onIncrement={(artworkKey) => addCard(artworkPickerId, artworkKey)}
          onDecrement={(artworkKey) =>
            removeArtwork(artworkPickerId, artworkKey)
          }
          onClose={() => setArtworkPickerId(null)}
          canSelect={canAddCard(artworkPickerId)}
          selectedCounts={selectedArtworkCounts(
            artworkPickerId,
            oshiId,
            oshiArtwork,
            main,
            mainArtworks,
            cheer,
            cheerArtworks,
          )}
        />
      )}
    </main>
  );
}

/** デッキ内容の行に薄い透過カード画像を敷くための CSS 変数 */
function rowArtStyle(
  cardId: string,
  artworkKey?: string,
): CSSProperties | undefined {
  const url = cardImageUrl(cardId, artworkKey);
  if (!url) return undefined;
  return { "--db-row-art": `url("${url}")` } as CSSProperties;
}

function cloneArtworkCounts(value: ArtworkCounts | undefined): ArtworkCounts {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([cardId, counts]) => [
      cardId,
      { ...counts },
    ]),
  );
}

function incrementArtwork(
  setArtworks: Dispatch<SetStateAction<ArtworkCounts>>,
  cardId: string,
  artworkKey: string,
) {
  setArtworks((current) => ({
    ...current,
    [cardId]: {
      ...(current[cardId] ?? {}),
      [artworkKey]: (current[cardId]?.[artworkKey] ?? 0) + 1,
    },
  }));
}

function decrementArtwork(
  setArtworks: Dispatch<SetStateAction<ArtworkCounts>>,
  cardId: string,
  artworkKey: string,
) {
  setArtworks((current) => {
    const next = cloneArtworkCounts(current);
    const counts = next[cardId];
    if (!counts?.[artworkKey]) return current;
    if (counts[artworkKey] > 1) counts[artworkKey]--;
    else delete counts[artworkKey];
    if (Object.keys(counts).length === 0) delete next[cardId];
    return next;
  });
}

function compactArtworkCounts(value: ArtworkCounts) {
  const entries = Object.entries(value).filter(
    ([, counts]) => Object.keys(counts).length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactArtworks(
  oshi: string | null,
  main: ArtworkCounts,
  cheer: ArtworkCounts,
): DeckArtworkSelection | undefined {
  const compactMain = compactArtworkCounts(main);
  const compactCheer = compactArtworkCounts(cheer);
  if (!oshi && !compactMain && !compactCheer) return undefined;
  return {
    ...(oshi ? { oshi } : {}),
    ...(compactMain ? { main: compactMain } : {}),
    ...(compactCheer ? { cheer: compactCheer } : {}),
  };
}

interface DeckArtworkRow {
  cardId: string;
  artworkKey: string;
  count: number;
  variantIndex: number;
}

function deckArtworkRows(
  cardCounts: Record<string, number>,
  artworks: ArtworkCounts,
): DeckArtworkRow[] {
  return Object.entries(cardCounts).flatMap(([cardId, total]) => {
    const variants = cardImageVariants(cardId);
    const alternateCounts = artworks[cardId] ?? {};
    const alternateTotal = Object.values(alternateCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    return variants.flatMap((variant, variantIndex) => {
      const count =
        variantIndex === 0
          ? Math.max(0, total - alternateTotal)
          : (alternateCounts[variant.key] ?? 0);
      return count > 0
        ? [{ cardId, artworkKey: variant.key, count, variantIndex }]
        : [];
    });
  });
}

function DeckCardPreviewContent({
  cardId,
  artworkKey,
  titleId,
  onClose,
}: {
  cardId: string;
  artworkKey?: string;
  titleId: string;
  onClose: () => void;
}) {
  const card = getCard(cardId);
  return (
    <div className="db-card-preview-dialog card-preview-dialog-with-details">
      <button
        type="button"
        className="db-card-preview-close"
        aria-label="拡大表示を閉じる"
        onClick={onClose}
        data-modal-initial-focus
      >
        <span aria-hidden="true" />
      </button>
      <div className="card-preview-body">
        <CardView
          cardId={cardId}
          artworkKey={artworkKey}
          size="lg"
          className="db-card-preview-card"
        />
        <div className="card-preview-details">
          <CardDescription card={card} artworkKey={artworkKey} showRarity />
        </div>
      </div>
      <div className="db-card-preview-meta">
        <strong id={titleId}>{card.name}</strong>
        <span>{cardId}</span>
      </div>
    </div>
  );
}

function ArtworkPreviewDialog({
  cardId,
  artworkKey,
  onClose,
}: {
  cardId: string;
  artworkKey: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useModalFocus(dialogRef, { onEscape: onClose });
  return (
    <dialog
      ref={dialogRef}
      className="db-card-preview db-artwork-preview"
      aria-labelledby="db-artwork-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <DeckCardPreviewContent
        cardId={cardId}
        artworkKey={artworkKey}
        titleId="db-artwork-preview-title"
        onClose={onClose}
      />
    </dialog>
  );
}

function ArtworkPickerDialog({
  cardId,
  onIncrement,
  onDecrement,
  onClose,
  canSelect,
  selectedCounts,
}: {
  cardId: string;
  onIncrement: (artworkKey: string) => void;
  onDecrement: (artworkKey: string) => void;
  onClose: () => void;
  canSelect: boolean;
  selectedCounts: Record<string, number>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [previewArtwork, setPreviewArtwork] = useState<string | null>(null);
  const card = getCard(cardId);
  const variants = cardImageVariants(cardId);
  const selectedTotal = Object.values(selectedCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const isOshi = card.cardType === "oshi";

  useModalFocus(dialogRef, { onEscape: onClose });

  return (
    <dialog
      ref={dialogRef}
      className="db-artwork-picker"
      aria-labelledby="db-artwork-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="db-artwork-picker-dialog">
        <div className="db-artwork-picker-header">
          <div>
            <span className="eyebrow">SELECT ARTWORK</span>
            <h2 id="db-artwork-picker-title">{card.name}の画像を選択</h2>
            <p>
              {isOshi
                ? "画像を選ぶと、このカードを推しホロメンに設定します。"
                : canSelect
                  ? "各画像の−/＋で枚数を調整できます。完了したら閉じてください。"
                  : "追加できる上限に達しました。−で枚数を減らせます。"}
            </p>
          </div>
          <button
            type="button"
            className="db-card-preview-close"
            aria-label="画像選択を閉じる"
            onClick={onClose}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <div className="db-artwork-options">
          {variants.map((variant, index) => {
            const selectedCount = selectedCounts[variant.key] ?? 0;
            return (
              <div
                className={`db-artwork-option${selectedCount > 0 ? " selected" : ""}`}
                key={variant.key}
              >
                <div className="db-artwork-card-shell">
                  <CardPreviewButton
                    cardName={`${card.name} ${variant.label}`}
                    onPreview={() => setPreviewArtwork(variant.key)}
                  />
                  {isOshi ? (
                    <button
                      type="button"
                      className="db-artwork-select"
                      aria-label={`${card.name} ${variant.label}を推しホロメンに設定`}
                      aria-pressed={selectedCount > 0}
                      autoFocus={
                        selectedCount > 0 ||
                        (index === 0 && selectedTotal === 0)
                      }
                      onClick={() => {
                        onIncrement(variant.key);
                        onClose();
                      }}
                    >
                      <CardView
                        cardId={cardId}
                        artworkKey={variant.key}
                        size="lg"
                        lazy
                      />
                    </button>
                  ) : (
                    <CardView
                      cardId={cardId}
                      artworkKey={variant.key}
                      size="lg"
                      lazy
                    />
                  )}
                </div>
                <span className="db-artwork-option-label">
                  <span>{variant.label}</span>
                  <strong
                    className={selectedCount > 0 ? undefined : "is-empty"}
                    aria-hidden={selectedCount <= 0}
                  >
                    {isOshi ? "設定中" : `${selectedCount}枚`}
                  </strong>
                </span>
                {!isOshi && (
                  <CountAdjustButtons
                    className="db-artwork-count-controls"
                    decrementLabel={`${card.name} ${variant.label}を1枚減らす`}
                    incrementLabel={`${card.name} ${variant.label}を1枚増やす`}
                    onDecrement={() => onDecrement(variant.key)}
                    onIncrement={() => onIncrement(variant.key)}
                    decrementDisabled={selectedCount <= 0}
                    incrementDisabled={!canSelect}
                    autoFocusIncrement={index === 0}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className="db-artwork-picker-footer">
          {isOshi ? (
            <span>設定する画像を選んでください</span>
          ) : (
            <span>
              このカードを
              <strong>{selectedTotal}枚</strong>
              選択中
            </span>
          )}
          <button type="button" onClick={onClose}>
            {isOshi ? "キャンセル" : "選択を完了"}
          </button>
        </div>
        {previewArtwork && (
          <ArtworkPreviewDialog
            cardId={cardId}
            artworkKey={previewArtwork}
            onClose={() => setPreviewArtwork(null)}
          />
        )}
      </div>
    </dialog>
  );
}

function CountAdjustButtons({
  className,
  decrementLabel,
  incrementLabel,
  onDecrement,
  onIncrement,
  decrementDisabled = false,
  incrementDisabled = false,
  autoFocusIncrement = false,
}: {
  className: string;
  decrementLabel: string;
  incrementLabel: string;
  onDecrement: () => void;
  onIncrement: () => void;
  decrementDisabled?: boolean;
  incrementDisabled?: boolean;
  autoFocusIncrement?: boolean;
}) {
  return (
    <div className={className}>
      <button
        type="button"
        className="db-count-step is-minus"
        aria-label={decrementLabel}
        title={decrementLabel}
        onClick={onDecrement}
        disabled={decrementDisabled}
      >
        <span aria-hidden="true">−</span>
      </button>
      <button
        type="button"
        className="db-count-step is-plus"
        aria-label={incrementLabel}
        title={incrementLabel}
        onClick={onIncrement}
        disabled={incrementDisabled}
        autoFocus={autoFocusIncrement}
      >
        <span aria-hidden="true">＋</span>
      </button>
    </div>
  );
}

function selectedArtworkCounts(
  cardId: string,
  oshiId: string | null,
  oshiArtwork: string | null,
  main: Record<string, number>,
  mainArtworks: ArtworkCounts,
  cheer: Record<string, number>,
  cheerArtworks: ArtworkCounts,
): Record<string, number> {
  const card = getCard(cardId);
  const defaultArtwork = card.imageVariants[0];
  if (card.cardType === "oshi") {
    if (oshiId !== cardId) return {};
    return { [oshiArtwork ?? defaultArtwork]: 1 };
  }

  const total =
    card.cardType === "yell" ? (cheer[cardId] ?? 0) : (main[cardId] ?? 0);
  const alternates =
    (card.cardType === "yell" ? cheerArtworks : mainArtworks)[cardId] ?? {};
  const alternateTotal = Object.values(alternates).reduce(
    (sum, count) => sum + count,
    0,
  );
  const defaultCount = Math.max(0, total - alternateTotal);
  return {
    ...(defaultCount > 0 ? { [defaultArtwork]: defaultCount } : {}),
    ...alternates,
  };
}
