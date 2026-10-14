// 対戦の終了・投了・観戦終了メニュー。
import type { GameAction } from "../../game/actions";
import type { GameState } from "../../game/types";
import { CloseIcon } from "../cards/CardPreviewButton";
import { useEffect, useRef } from "react";
import { useModalFocus } from "../common/useModalFocus";
interface GameMenuProps {
  compact: boolean;
  setMenuOpen: (open: boolean) => void;
  spectator: boolean;
  game: GameState;
  dispatch: (action: GameAction) => void;
  onExit: () => void;
  onHome?: () => void;
  exitLabel?: string;
}
export function GameMenu({
  compact,
  setMenuOpen,
  spectator,
  game,
  dispatch,
  onExit,
  onHome,
  exitLabel,
}: GameMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, {
    active: compact,
    onEscape: () => setMenuOpen(false),
  });
  useEffect(() => {
    if (!compact) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !ref.current?.contains(target) &&
        !target.closest('[aria-controls="game-mobile-menu"]')
      )
        setMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [compact, setMenuOpen]);
  return (
    <div
      ref={ref}
      role={compact ? "dialog" : undefined}
      aria-modal={compact ? true : undefined}
      aria-label={compact ? "対戦メニュー" : undefined}
      id={compact ? "game-mobile-menu" : undefined}
      className={compact ? "game-mobile-menu" : "header-actions"}
    >
      {compact && (
        <button
          className="game-icon-button"
          aria-label="メニューを閉じる"
          title="閉じる"
          onClick={() => setMenuOpen(false)}
        >
          <CloseIcon />
        </button>
      )}
      {spectator && <span className="seat-label">観戦中</span>}
      {!spectator && game.phase === "playing" && (
        <button
          onClick={() => {
            if (confirm("投了しますか？")) dispatch({ type: "concede" });
          }}
        >
          投了
        </button>
      )}
      <button onClick={onExit}>
        {spectator ? "観戦を終了" : (exitLabel ?? "対戦終了")}
      </button>
      {compact && onHome && <button onClick={onHome}>ホームへ戻る</button>}
    </div>
  );
}
