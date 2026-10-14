import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export function MagnifyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.25" />
      <path d="m15.3 15.3 4.45 4.45" />
      <path d="M10.5 7.5v6M7.5 10.5h6" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

/** カード本体のクリック操作とは独立して拡大表示を開く。 */
export function CardPreviewButton({
  cardName,
  onPreview,
  className,
}: {
  cardName: string;
  onPreview: () => void;
  className?: string;
}) {
  const stopPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const openPreview = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onPreview();
  };

  return (
    <button
      type="button"
      className={`db-card-zoom${className ? ` ${className}` : ""}`}
      aria-label={`${cardName}の詳細を表示`}
      title="カードの詳細を表示"
      onPointerDown={stopPointer}
      onClick={openPreview}
    >
      <MagnifyIcon />
    </button>
  );
}
