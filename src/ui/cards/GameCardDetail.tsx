import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Card } from "../../data/types";
import { CardView } from "./CardView";
import { CloseIcon, MagnifyIcon } from "./CardPreviewButton";

const DetailHeadingTarget = createContext<HTMLDivElement | null>(null);

/** 見出しと操作アイコンを、本文のスクロール領域から分離する。 */
export function GameDetailPanel({
  children,
  className,
  contentClassName,
  label,
}: {
  children: ReactNode;
  className: string;
  contentClassName: string;
  label: string;
}) {
  const [headingTarget, setHeadingTarget] = useState<HTMLDivElement | null>(
    null,
  );
  return (
    <section className={className} aria-label={label}>
      <div className="game-detail-fixed-heading" ref={setHeadingTarget} />
      <div className={contentClassName}>
        <DetailHeadingTarget.Provider value={headingTarget}>
          {children}
        </DetailHeadingTarget.Provider>
      </div>
    </section>
  );
}

/** スマホでも効果本文を常時表示し、カード概要は見出しだけにまとめる。 */
export function GameCardDetail({
  card,
  artworkKey,
  compact,
  onPreview,
  onClose,
  status,
  children,
}: {
  card: Card;
  artworkKey?: string;
  compact: boolean;
  onPreview: () => void;
  onClose?: () => void;
  status?: ReactNode;
  children: ReactNode;
}) {
  const headingTarget = useContext(DetailHeadingTarget);
  if (!compact)
    return (
      <div className="detail-card">
        <CardView cardId={card.id} artworkKey={artworkKey} size="lg" />
        <div>
          {children}
          {status}
        </div>
      </div>
    );
  const subtitle =
    card.cardType === "holomen"
      ? `${card.bloomLevel}${card.buzz ? " Buzz" : ""}${status ? "" : ` / HP${card.hp}`}`
      : card.cardType === "support"
        ? `${card.supportType}${card.limited ? " / LIMITED" : ""}`
        : card.cardType === "oshi"
          ? `推し / ライフ${card.life}`
          : "エール";
  const heading = (
    <div className="compact-card-heading">
      <div>
        <strong>{card.name}</strong>
        <span className="muted">{subtitle}</span>
      </div>
      <div className="compact-card-icons">
        <button
          className="game-icon-button"
          type="button"
          aria-label={`${card.name}を拡大`}
          title="カードを拡大"
          onClick={onPreview}
        >
          <MagnifyIcon />
        </button>
        {onClose && (
          <button
            className="game-icon-button"
            type="button"
            aria-label="カード操作を閉じる"
            title="閉じる"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className="compact-card-detail">
      {headingTarget ? createPortal(heading, headingTarget) : heading}
      {status}
      <div className="compact-card-text">{children}</div>
    </div>
  );
}
