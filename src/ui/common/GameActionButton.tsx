import { useId, type ReactNode } from "react";

/** 理由をボタンの直下に置き、タップやマウスオーバーなしでも読めるようにする。 */
export function GameActionButton({
  children,
  reason,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  reason?: string | null;
  onClick: () => void;
  primary?: boolean;
}) {
  const reasonId = useId();
  return (
    <div className="game-action-option">
      <button
        className={primary ? "primary" : undefined}
        disabled={!!reason}
        aria-describedby={reason ? reasonId : undefined}
        onClick={onClick}
      >
        {children}
      </button>
      {reason && (
        <p className="action-unavailable" id={reasonId}>
          {reason}
        </p>
      )}
    </div>
  );
}
