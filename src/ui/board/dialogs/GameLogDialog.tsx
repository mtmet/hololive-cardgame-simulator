// 対戦画面の表示・操作：gameLogDialog。
import { CloseIcon } from "../../cards/CardPreviewButton";
import { useRef } from "react";
import { useModalFocus } from "../../common/useModalFocus";

export function GameLogDialog({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useModalFocus(dialogRef, { onEscape: onClose });
  return (
    <dialog
      ref={dialogRef}
      className="game-log-dialog"
      aria-labelledby="game-log-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section>
        <div className="game-log-header">
          <h2 id="game-log-title">対戦ログ</h2>
          <button
            className="game-icon-button"
            aria-label="ログを閉じる"
            title="閉じる"
            autoFocus
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </section>
    </dialog>
  );
}
