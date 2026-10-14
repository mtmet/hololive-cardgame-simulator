// ============================================================
// オンライン対戦の参加画面
// 各プレイヤーが名前とデッキを選び、参加順に P1 → P2 へ割り当てられる。
// ============================================================
import { useEffect, useMemo, useState } from "react";
import { getCard } from "../../data/loader";
import { BackToHome } from "../common/Brand";
import { pickRandomDeck } from "../../game/ai/setup";
import {
  loadSavedDecks,
  SAVED_DECKS_STORAGE_KEY,
} from "../../game/decks/storage";
import { sampleDecks, validateDeck } from "../../game/decks/rules";
import type { MatchSetupState } from "../../game/online/protocol";
import type { DeckList } from "../../game/types";
import {
  PLAYER_NAME_MAX_LENGTH,
  deckNameInputError,
  playerNameInputError,
} from "../common/inputValidation";

const DECK_RANDOM = "random";

export function MatchSetup({
  setup,
  claimError,
  onJoin,
  onSpectate,
}: {
  /** 既存の募集。null なら自分が募集の作成を兼ねる */
  setup: MatchSetupState | null;
  claimError: string | null;
  onJoin: (name: string, deck: DeckList, usesDefaultName: boolean) => void;
  onSpectate: () => void;
}) {
  const samples = useMemo(() => sampleDecks(), []);
  const [savedDecks, setSavedDecks] = useState(() => loadSavedDecks());
  const decks = [...samples, ...savedDecks.map((saved) => saved.deck)];

  const entries = setup?.entries ?? [null, null];
  const expectedPlayer = entries[0] ? 2 : 1;
  const [name, setName] = useState(`プレイヤー${expectedPlayer}`);
  const [nameTouched, setNameTouched] = useState(false);
  const [deckKey, setDeckKey] = useState(DECK_RANDOM);

  // 別タブでのデッキ作成・編集に追従する
  useEffect(() => {
    const syncSavedDecks = (event: StorageEvent) => {
      if (event.key === SAVED_DECKS_STORAGE_KEY)
        setSavedDecks(loadSavedDecks());
    };
    window.addEventListener("storage", syncSavedDecks);
    return () => window.removeEventListener("storage", syncSavedDecks);
  }, []);

  // 同時参加で先にP1が決まった場合、未編集の初期名もP2へ追従する。
  useEffect(() => {
    if (!nameTouched) setName(`プレイヤー${expectedPlayer}`);
  }, [expectedPlayer, nameTouched]);

  const deck = deckKey === DECK_RANDOM ? null : decks[Number(deckKey)];
  const joinableDecks = decks.filter(
    (candidate) =>
      deckNameInputError(candidate.name) === null && validateDeck(candidate).ok,
  );
  const nameError = playerNameInputError(name);
  const selectedDeckNameError = deck ? deckNameInputError(deck.name) : null;
  const deckOk =
    deckKey === DECK_RANDOM
      ? joinableDecks.length > 0
      : !!deck && selectedDeckNameError === null && validateDeck(deck).ok;
  const bothFilled = !!entries[0] && !!entries[1];

  return (
    <main className="lobby-shell">
      <section className="lobby lobby-join">
        <BackToHome />
        <header className="lobby-hero">
          <span className="eyebrow">ONLINE MATCH</span>
          <h1>{setup ? "対戦に参加" : "対戦の募集を作成"}</h1>
          <p className="lobby-note">
            {setup
              ? "名前と使用するデッキを決めて参加してください。席は参加順に自動で割り当てられ、先攻はランダムです。"
              : "名前と使用するデッキを決めて参加すると募集が始まります。作成者は自動的にプレイヤー1になり、先攻はランダムです。"}
          </p>
        </header>

        {claimError && (
          <p className="lobby-storage-error" role="alert">
            {claimError}
          </p>
        )}

        {bothFilled ? (
          <p className="lobby-note">対戦を開始しています…</p>
        ) : (
          <>
            <div className="lobby-setup-grid">
              <label className="control-card">
                <span>プレイヤー名</span>
                <input
                  value={name}
                  maxLength={PLAYER_NAME_MAX_LENGTH}
                  aria-invalid={nameError !== null}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTouched(true);
                  }}
                />
              </label>
              <label className="control-card">
                <span>使用デッキ</span>
                <select
                  value={deckKey}
                  onChange={(e) => setDeckKey(e.target.value)}
                >
                  <option
                    value={DECK_RANDOM}
                    disabled={joinableDecks.length === 0}
                  >
                    ランダム (下の一覧から抽選)
                  </option>
                  {decks.map((d, i) => {
                    const invalid =
                      deckNameInputError(d.name) !== null ||
                      !validateDeck(d).ok;
                    return (
                      <option key={i} value={String(i)} disabled={invalid}>
                        {d.name} (推し：{getCard(d.oshiId).name})
                        {invalid ? " — 参加不可" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            </div>

            {nameError && (
              <p className="lobby-storage-error" role="alert">
                {nameError}
              </p>
            )}
            {selectedDeckNameError && (
              <p className="lobby-storage-error" role="alert">
                {selectedDeckNameError} デッキ編集画面で変更してください。
              </p>
            )}

            <div className="lobby-actions">
              <button
                className="primary"
                disabled={!deckOk || nameError !== null}
                onClick={() => {
                  const selected =
                    deckKey === DECK_RANDOM
                      ? pickRandomDeck(joinableDecks)
                      : deck;
                  if (
                    selected &&
                    playerNameInputError(name) === null &&
                    deckNameInputError(selected.name) === null
                  )
                    onJoin(name.trim(), selected, !nameTouched);
                }}
              >
                この内容で参加する
              </button>
            </div>
          </>
        )}

        <div className="seat-spectate">
          <button onClick={onSpectate}>観戦する</button>
        </div>
      </section>
    </main>
  );
}
