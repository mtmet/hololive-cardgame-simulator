import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getCard } from "../../data/loader";
import { HomeFooter, HomeHeader, HomeHero, Icon } from "../common/Brand";
import { CardView } from "../cards/CardView";
import {
  createSavedDeckId,
  deckExportFileName,
  deckToJson,
  decksToJson,
  loadSavedDecks,
  parseDecksJson,
  SAVED_DECKS_STORAGE_KEY,
  saveSavedDecks,
  type SavedDeck,
} from "../../game/decks/storage";
import {
  ROOM_CODE_MAX_LENGTH,
  deckNameInputError,
  validateRoomCodeInput,
} from "../common/inputValidation";

const DeckBuilder = lazy(() =>
  import("../decks/DeckBuilder").then((module) => ({
    default: module.DeckBuilder,
  })),
);

type DeckBuilderState =
  | { mode: "create" }
  | { mode: "edit"; savedDeckId: string }
  | null;

/** デッキ管理・CPU対戦・オンライン対戦へのホーム画面。 */
export function Lobby() {
  const [savedDecks, setSavedDecks] = useState<SavedDeck[]>(() =>
    loadSavedDecks(),
  );
  const [onlineRoom, setOnlineRoom] = useState("");
  const [onlineRoomTouched, setOnlineRoomTouched] = useState(false);
  const [building, setBuilding] = useState<DeckBuilderState>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const importInputRef = useRef<HTMLInputElement>(null);

  // ロビー⇔デッキ構築は同一ページの表示切り替えのため、モバイル等で
  // windowがスクロールしているとその位置が持ち越される。切り替え時に先頭へ戻す
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [building]);

  useEffect(() => {
    const syncSavedDecks = (event: StorageEvent) => {
      if (event.key === SAVED_DECKS_STORAGE_KEY)
        setSavedDecks(loadSavedDecks());
    };
    window.addEventListener("storage", syncSavedDecks);
    return () => window.removeEventListener("storage", syncSavedDecks);
  }, []);

  const persistSavedDecks = (next: SavedDeck[]): boolean => {
    try {
      saveSavedDecks(next);
      setSavedDecks(next);
      setStorageError(null);
      return true;
    } catch {
      setStorageError(
        "ブラウザの保存領域へ書き込めませんでした。空き容量やプライベートブラウズの設定を確認してください。",
      );
      return false;
    }
  };

  const editingSavedDeck =
    building?.mode === "edit"
      ? savedDecks.find((saved) => saved.id === building.savedDeckId)
      : undefined;

  if (building) {
    return (
      <Suspense
        fallback={
          <main className="app-loading" aria-busy="true" aria-live="polite">
            <div className="app-loading-panel">
              <span className="eyebrow">DECK BUILDER</span>
              <p>デッキ編集画面を読み込んでいます…</p>
            </div>
          </main>
        }
      >
        <DeckBuilder
          key={
            building.mode === "edit" ? building.savedDeckId : "new-saved-deck"
          }
          initialDeck={editingSavedDeck?.deck}
          saveError={storageError}
          onDone={(deck) => {
            if (!deck) {
              setBuilding(null);
              setStorageError(null);
              return;
            }
            const nameError = deckNameInputError(deck.name);
            if (nameError) {
              setStorageError(nameError);
              return;
            }
            const updatedAt = Date.now();
            const next =
              building.mode === "edit" && editingSavedDeck
                ? savedDecks.map((saved) =>
                    saved.id === editingSavedDeck.id
                      ? { ...saved, deck, updatedAt }
                      : saved,
                  )
                : [...savedDecks, { id: createSavedDeckId(), deck, updatedAt }];
            if (persistSavedDecks(next)) setBuilding(null);
          }}
        />
      </Suspense>
    );
  }

  const deleteSavedDeck = (saved: SavedDeck) => {
    if (!window.confirm("「" + saved.deck.name + "」を削除しますか？")) return;
    persistSavedDecks(savedDecks.filter((item) => item.id !== saved.id));
  };

  const deleteAllSavedDecks = () => {
    if (savedDecks.length === 0) return;
    if (
      !window.confirm(
        `保存済みデッキ${savedDecks.length}件をすべて削除しますか？この操作は取り消せません。`,
      )
    )
      return;
    persistSavedDecks([]);
  };

  const downloadJson = (fileName: string, text: string) => {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportAllDecks = () => {
    const date = new Date().toISOString().slice(0, 10);
    downloadJson(
      `hololive-decks-${date}.json`,
      decksToJson(savedDecks.map((saved) => saved.deck)),
    );
  };

  const importDeckFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const imported: SavedDeck["deck"][] = [];
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      let text = "";
      try {
        text = await file.text();
      } catch {
        errors.push(`${file.name}: ファイルを読み込めませんでした`);
        continue;
      }
      const result = parseDecksJson(text);
      for (const deck of result.decks) {
        const nameError = deckNameInputError(deck.name);
        if (nameError) errors.push(`${file.name}: ${nameError}`);
        else imported.push(deck);
      }
      errors.push(...result.errors.map((error) => `${file.name}: ${error}`));
    }
    if (imported.length > 0) {
      const updatedAt = Date.now();
      const next = [
        ...savedDecks,
        ...imported.map((deck) => ({
          id: createSavedDeckId(),
          deck,
          updatedAt,
        })),
      ];
      if (!persistSavedDecks(next)) {
        setImportNotice(null);
        setImportErrors(errors);
        return;
      }
    }
    setImportNotice(
      imported.length > 0
        ? `${imported.length}件のデッキを読み込みました`
        : null,
    );
    setImportErrors(
      imported.length === 0 && errors.length === 0
        ? ["読み込めるデッキがありませんでした"]
        : errors,
    );
  };

  const onlineRoomValidation = validateRoomCodeInput(onlineRoom);
  const onlineRoomError = onlineRoomTouched
    ? onlineRoomValidation.ok
      ? null
      : onlineRoomValidation.error
    : null;

  const createDeck = () => {
    setStorageError(null);
    setBuilding({ mode: "create" });
  };

  return (
    <div className="home-page" id="home">
      <HomeHeader onBuild={createDeck} />
      <main id="main-content" className="home-main" tabIndex={-1}>
        <HomeHero onBuild={createDeck} />
        <div className="home-content">
          <section className="home-play" id="play" aria-labelledby="play-title">
            <div className="play-heading">
              <div>
                <span className="eyebrow">MATCH</span>
                <h2 id="play-title">対戦モード</h2>
              </div>
            </div>
            <div className="play-options">
              <section
                className="play-card play-cpu"
                aria-labelledby="cpu-entry-title"
              >
                <div className="online-entry-inner">
                  <div className="play-card-top">
                    <span className="play-icon">
                      <Icon name="gamepad" />
                    </span>
                    <span className="play-tag">CPU</span>
                  </div>
                  <div className="online-entry-copy">
                    <h2 id="cpu-entry-title">CPU対戦</h2>
                    <p>
                      CPUを相手に一人で対戦します。
                      <br />
                      強さは5段階から選択できます。
                    </p>
                  </div>
                  <div className="online-entry-form online-entry-form--end">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        window.location.href = `${window.location.pathname}?cpu=1`;
                      }}
                    >
                      CPU対戦の設定
                      <Icon name="arrow" />
                    </button>
                  </div>
                </div>
              </section>

              <section
                className="play-card play-online"
                aria-labelledby="online-entry-title"
              >
                <div className="online-entry-inner">
                  <div className="play-card-top">
                    <span className="play-icon">
                      <Icon name="globe" />
                    </span>
                    <span className="play-tag">ONLINE</span>
                  </div>
                  <div className="online-entry-copy">
                    <h2 id="online-entry-title">オンライン対戦</h2>
                    <p>
                      部屋コードを指定してオンラインで対戦します。
                      <br />
                      同じコードまたは招待URLで参加できます。
                    </p>
                  </div>
                  <form
                    className="online-entry-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setOnlineRoomTouched(true);
                      if (!onlineRoomValidation.ok) return;
                      window.location.href = `${window.location.pathname}?room=${encodeURIComponent(onlineRoomValidation.room)}`;
                    }}
                  >
                    <input
                      id="home-room-code"
                      aria-label="部屋コード"
                      placeholder="部屋コードを入力"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      value={onlineRoom}
                      maxLength={ROOM_CODE_MAX_LENGTH}
                      aria-invalid={onlineRoomError !== null}
                      aria-describedby={
                        onlineRoomError ? "online-room-input-error" : undefined
                      }
                      onChange={(e) => {
                        setOnlineRoom(e.target.value);
                        setOnlineRoomTouched(true);
                      }}
                    />
                    <button
                      type="submit"
                      className="primary"
                      disabled={!onlineRoomValidation.ok}
                    >
                      部屋へ移動
                      <Icon name="arrow" />
                    </button>
                    {onlineRoomError && (
                      <p
                        id="online-room-input-error"
                        className="lobby-storage-error"
                        role="alert"
                      >
                        {onlineRoomError}
                      </p>
                    )}
                  </form>
                </div>
              </section>
            </div>
          </section>
          <section className="home-library" id="my-decks">
            <section
              className="lobby-section"
              aria-labelledby="player-settings-title"
            >
              <div className="section-heading">
                <div>
                  <span className="eyebrow">DECK LIBRARY</span>
                  <h2 id="player-settings-title">
                    マイデッキ{" "}
                    <span className="deck-total">{savedDecks.length}</span>
                  </h2>
                  <p>保存済みデッキの作成・編集と入出力を行います。</p>
                </div>
                <button className="primary" onClick={createDeck}>
                  <Icon name="plus" />
                  新しいデッキを作成
                </button>
              </div>

              <div className="saved-deck-library">
                <div className="saved-deck-library-heading">
                  <div>
                    <p>このブラウザに保存したデッキを表示しています。</p>
                  </div>
                  <div className="saved-deck-library-tools">
                    <button
                      type="button"
                      onClick={() => importInputRef.current?.click()}
                    >
                      <Icon name="upload" />
                      JSONを読み込む
                    </button>
                    {savedDecks.length > 0 && (
                      <button type="button" onClick={exportAllDecks}>
                        すべて書き出す
                      </button>
                    )}
                    {savedDecks.length > 0 && (
                      <button
                        type="button"
                        className="danger"
                        onClick={deleteAllSavedDecks}
                      >
                        すべて削除
                      </button>
                    )}
                  </div>
                </div>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".json,application/json"
                  multiple
                  hidden
                  aria-label="デッキJSONファイルを選択"
                  onChange={(event) => {
                    const input = event.currentTarget;
                    void importDeckFiles(input.files).finally(() => {
                      input.value = "";
                    });
                  }}
                />
                {storageError && (
                  <p className="lobby-storage-error" role="alert">
                    {storageError}
                  </p>
                )}
                {importNotice && (
                  <p className="lobby-storage-notice" role="status">
                    {importNotice}
                  </p>
                )}
                {importErrors.length > 0 && (
                  <div className="lobby-storage-error" role="alert">
                    <ul>
                      {importErrors.slice(0, 8).map((error, index) => (
                        <li key={`${index}:${error}`}>{error}</li>
                      ))}
                    </ul>
                    {importErrors.length > 8 && (
                      <p>他{importErrors.length - 8}件のエラーがあります</p>
                    )}
                  </div>
                )}
                {savedDecks.length === 0 ? (
                  <div className="saved-deck-empty">
                    <span className="empty-deck-icon" aria-hidden="true">
                      <Icon name="cards" />
                      <span>
                        <Icon name="plus" />
                      </span>
                    </span>
                    <div>
                      <h3>保存済みデッキはありません</h3>
                      <p>
                        デッキを作成するか、JSONファイルを読み込んで追加してください。
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="saved-deck-list">
                    {savedDecks.map((saved) => (
                      <div key={saved.id} className="saved-deck-row">
                        <div className="saved-deck-art">
                          <CardView
                            cardId={saved.deck.oshiId}
                            artworkKey={saved.deck.artworks?.oshi}
                            size="sm"
                            lazy
                          />
                        </div>
                        <div className="saved-deck-summary">
                          <strong>{saved.deck.name}</strong>
                          <span>推し：{getCard(saved.deck.oshiId).name}</span>
                        </div>
                        <div className="saved-deck-actions">
                          <button
                            type="button"
                            aria-label={saved.deck.name + "を書き出し"}
                            onClick={() =>
                              downloadJson(
                                deckExportFileName(saved.deck),
                                deckToJson(saved.deck),
                              )
                            }
                          >
                            書き出し
                          </button>
                          <button
                            type="button"
                            aria-label={saved.deck.name + "を編集"}
                            onClick={() => {
                              setStorageError(null);
                              setBuilding({
                                mode: "edit",
                                savedDeckId: saved.id,
                              });
                            }}
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            className="danger"
                            aria-label={saved.deck.name + "を削除"}
                            onClick={() => deleteSavedDeck(saved)}
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </section>
        </div>
      </main>
      <HomeFooter />
    </div>
  );
}
