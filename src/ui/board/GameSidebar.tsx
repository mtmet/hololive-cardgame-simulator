import {
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const HANDLE_SIZE = 8;

/** 本文だけをスクロールし、境界のドラッグでログの表示領域を調整する。 */
export function GameSidebar({
  detail,
  log,
}: {
  detail: ReactNode;
  log: ReactNode;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const logId = useId();
  const drag = useRef<{
    pointerId: number;
    start: number;
    size: number;
    horizontal: boolean;
  } | null>(null);
  const [layout, setLayout] = useState({
    width: 0,
    height: 0,
    horizontal: false,
  });
  const [preferredSize, setPreferredSize] = useState<{
    width?: number;
    height: number;
  }>({ height: 230 });
  const [resizing, setResizing] = useState(false);
  useLayoutEffect(() => {
    const sidebar = sidebarRef.current!;
    const measure = () =>
      setLayout({
        width: sidebar.clientWidth,
        height: sidebar.clientHeight,
        horizontal: getComputedStyle(sidebar).display === "grid",
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, []);
  const available = Math.max(
    0,
    (layout.horizontal ? layout.width : layout.height) - HANDLE_SIZE,
  );
  const minimum = Math.min(100, available / 3);
  const maximum = Math.max(minimum, available - Math.min(140, available / 3));
  const clamp = (size: number) => Math.min(maximum, Math.max(minimum, size));
  const logSize =
    available > 0
      ? clamp(
          layout.horizontal
            ? (preferredSize.width ?? available / 2)
            : preferredSize.height,
        )
      : 230;
  const resize = (size: number, horizontal = layout.horizontal) =>
    setPreferredSize((previous) => ({
      ...previous,
      [horizontal ? "width" : "height"]: clamp(size),
    }));
  const finish = () => {
    drag.current = null;
    setResizing(false);
  };
  return (
    <aside
      ref={sidebarRef}
      className={`sidebar${resizing ? " sidebar-resizing" : ""}`}
      aria-label="カード情報と対戦ログ"
      style={{ "--log-pane-size": `${logSize}px` } as CSSProperties}
    >
      <section className="detail-panel">
        <h2 className="sidebar-panel-title">カード情報</h2>
        <div className="detail-panel-content">{detail}</div>
      </section>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="対戦ログの表示領域を調整"
        aria-controls={logId}
        aria-orientation={layout.horizontal ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(minimum)}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={Math.round(logSize)}
        tabIndex={0}
        title="ドラッグして対戦ログの領域を調整"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            start: layout.horizontal ? event.clientX : event.clientY,
            size: logSize,
            horizontal: layout.horizontal,
          };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          resize(
            current.size +
              current.start -
              (current.horizontal ? event.clientX : event.clientY),
            current.horizontal,
          );
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={() => setPreferredSize({ height: 230 })}
        onKeyDown={(event) => {
          const grow = layout.horizontal ? "ArrowLeft" : "ArrowUp";
          const shrink = layout.horizontal ? "ArrowRight" : "ArrowDown";
          const size =
            event.key === grow
              ? logSize + 20
              : event.key === shrink
                ? logSize - 20
                : event.key === "Home"
                  ? minimum
                  : event.key === "End"
                    ? maximum
                    : undefined;
          if (size === undefined) return;
          event.preventDefault();
          resize(size);
        }}
      />
      <section className="log-section" id={logId}>
        <h2 className="sidebar-panel-title">対戦ログ</h2>
        {log}
      </section>
    </aside>
  );
}
