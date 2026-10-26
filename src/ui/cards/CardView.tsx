import {
  useEffect,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  cardBackUrl,
  cardImageUrl,
  getCard,
  yellColorHex,
} from "../../data/loader";

/** カード1枚の表示。画像が読み込めないエールは色付きチップで表現する */
export function CardView({
  cardId,
  artworkKey,
  faceDown,
  backKind = "holomen",
  size = "md",
  onClick,
  selected,
  resting,
  title,
  className,
  dataHandUid,
  animationUid,
  animationZone,
  lazy,
  onDragPress,
}: {
  cardId?: string;
  /** 同一カードID内の画像キー。省略時は既定画像 */
  artworkKey?: string;
  faceDown?: boolean;
  backKind?: "holomen" | "yell";
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
  selected?: boolean;
  resting?: boolean;
  title?: string;
  className?: string;
  dataHandUid?: string;
  animationUid?: string;
  animationZone?: "hand" | "stage" | "archive" | "resolving";
  /**
   * 一覧のように大量に並べる場合だけ遅延読み込みする。対戦画面は表示直前に
   * 取得が始まると空欄が見えるため、既定では即座に読み込む。
   */
  lazy?: boolean;
  /** ドラッグ開始候補のポインター押下 (Pointer Events実装。useCardDrag.press へ渡す) */
  onDragPress?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const url = !faceDown && cardId ? cardImageUrl(cardId, artworkKey) : null;
  useEffect(() => {
    setImgFailed(false);
    setLoadedUrl(null);
  }, [url]);
  const activeOnClick = faceDown ? undefined : onClick;
  const activePress = faceDown ? undefined : onDragPress;
  const cls =
    `card card-${size}` +
    (selected && !faceDown ? " card-selected" : "") +
    (resting ? " card-resting" : "") +
    (activeOnClick || activePress ? " card-clickable" : "") +
    (className ? ` ${className}` : "");
  const dragProps = activePress ? { onPointerDown: activePress } : {};
  const interactiveProps = activeOnClick
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-pressed": !!selected,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activeOnClick();
          }
        },
      }
    : {};
  if (faceDown || !cardId) {
    return (
      <div
        className={cls}
        data-hand-uid={dataHandUid}
        data-animation-uid={animationUid}
        data-animation-zone={animationZone}
        onClick={activeOnClick}
        title={title}
        {...interactiveProps}
        {...dragProps}
      >
        <img src={cardBackUrl(backKind)} alt="裏面" draggable={false} />
      </div>
    );
  }
  const card = getCard(cardId);
  // エールも通常のカード画像で表示する
  const isYell = card.cardType === "yell";
  // 画像なしエールのフォールバック (読み込み失敗時)
  if (isYell && (imgFailed || !url)) {
    return (
      <div
        className={`${cls} card-yell`}
        data-hand-uid={dataHandUid}
        data-animation-uid={animationUid}
        data-animation-zone={animationZone}
        style={{ background: yellColorHex(card.color) }}
        onClick={activeOnClick}
        title={title ?? card.name}
        {...interactiveProps}
        {...dragProps}
      >
        <span>{card.name.replace("エール", "")}</span>
      </div>
    );
  }
  return (
    // 取得が終わるまではカード枠のプレースホルダを敷き、空欄を見せない。
    // 画像の四隅は透過なので、表示できたら重ねずに外す。
    <div
      className={loadedUrl === url ? cls : `${cls} card-art`}
      data-hand-uid={dataHandUid}
      data-animation-uid={animationUid}
      data-animation-zone={animationZone}
      onClick={activeOnClick}
      title={title ?? card.name}
      {...interactiveProps}
      {...dragProps}
    >
      <img
        // キャッシュ済みでloadが発火しない場合に備えて実体からも判定する。
        ref={(element) => {
          if (
            element?.complete &&
            element.naturalWidth > 0 &&
            loadedUrl !== url
          )
            setLoadedUrl(url);
        }}
        src={url!}
        alt={card.name}
        draggable={false}
        loading={lazy ? "lazy" : undefined}
        decoding="async"
        onLoad={() => setLoadedUrl(url)}
        onError={isYell ? () => setImgFailed(true) : undefined}
      />
    </div>
  );
}

/** エールを小さな色付きドットで表示 */
export function YellDots({ colors }: { colors: string[] }) {
  return (
    <div className="yell-dots">
      {colors.map((c, i) => (
        <span
          key={i}
          className="yell-dot"
          style={{ background: yellColorHex(c as never) }}
        />
      ))}
    </div>
  );
}

/** ステータスバー用: ドラッグ可能なエールカードのミニ表示 */
export function CheerChip({
  cardId,
  artworkKey,
  animationUid,
  onDragPress,
}: {
  cardId: string;
  artworkKey?: string;
  animationUid?: string;
  /** ドラッグ開始候補のポインター押下 (useCardDrag.press へ渡す) */
  onDragPress: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const card = getCard(cardId);
  const url = cardImageUrl(cardId, artworkKey);
  useEffect(() => setImgFailed(false), [url]);
  const color = card.cardType === "yell" ? card.color : "無";
  return (
    <div
      className="cheer-chip card-clickable"
      data-animation-uid={animationUid}
      data-animation-zone="pending-cheer"
      onPointerDown={onDragPress}
      title={card.name}
      style={
        imgFailed || !url ? { background: yellColorHex(color) } : undefined
      }
    >
      {imgFailed || !url ? (
        card.name.replace("エール", "")
      ) : (
        <img
          src={url}
          alt={card.name}
          draggable={false}
          onError={() => setImgFailed(true)}
        />
      )}
    </div>
  );
}
