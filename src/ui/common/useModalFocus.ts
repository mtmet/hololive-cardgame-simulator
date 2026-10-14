import { useLayoutEffect, useRef, type RefObject } from "react";

const scopes: HTMLElement[] = [];
const focusableSelector =
  'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

function visible(element: HTMLElement) {
  return (
    element.isConnected &&
    !element.closest('[inert], [aria-hidden="true"]') &&
    !element.matches(":disabled") &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

/** 入れ子では最前面だけ操作し、閉じたら開いた位置へ戻る。非表示は効果の辞退にしない。 */
export function useModalFocus<T extends HTMLElement>(
  ref: RefObject<T>,
  {
    active = true,
    onEscape,
    fallbackFocus,
  }: {
    active?: boolean;
    onEscape?: () => void;
    fallbackFocus?: RefObject<HTMLElement>;
  } = {},
) {
  const escapeRef = useRef(onEscape);
  const returnFocusRef = useRef<{ previous: Element | null } | null>(null);
  escapeRef.current = onEscape;
  useLayoutEffect(() => {
    const scope = ref.current;
    if (!active || !scope) return;
    // StrictModeの再設定でも、モーダルを開く前の位置を保持する。
    const activation = (returnFocusRef.current ??= {
      previous: document.activeElement,
    });
    const previousFocus = activation.previous;
    const dialog = scope instanceof HTMLDialogElement ? scope : null;
    const previousTabIndex = scope.getAttribute("tabindex");
    if (previousTabIndex === null) scope.tabIndex = -1;
    scopes.push(scope);
    if (dialog && !dialog.open) dialog.showModal();
    const isTop = () => scopes.at(-1) === scope;
    const controls = () =>
      [...scope.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => visible(element) && element.tabIndex >= 0,
      );
    const focusFirst = () => {
      const preferred = scope.querySelector<HTMLElement>(
        "[data-modal-initial-focus], [autofocus]",
      );
      (preferred && visible(preferred)
        ? preferred
        : (controls()[0] ?? scope)
      ).focus({
        preventScroll: true,
      });
    };
    // 親要素の非表示クラスまで反映してから初期フォーカスを設定する。
    const focusFrame = requestAnimationFrame(() => {
      if (isTop()) focusFirst();
    });
    const focusIn = (event: FocusEvent) => {
      if (isTop() && !scope.contains(event.target as Node)) focusFirst();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) escapeRef.current?.();
      } else if (event.key === "Tab") {
        const items = controls();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (
          items.length === 0 ||
          index === -1 ||
          (event.shiftKey ? index === 0 : index === items.length - 1)
        ) {
          event.preventDefault();
          (event.shiftKey
            ? (items.at(-1) ?? scope)
            : (items[0] ?? scope)
          ).focus({
            preventScroll: true,
          });
        }
      }
    };
    document.addEventListener("focusin", focusIn);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      const wasTop = isTop();
      scopes.splice(scopes.indexOf(scope), 1);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("keydown", keyDown, true);
      if (dialog?.open) dialog.close();
      if (previousTabIndex === null) scope.removeAttribute("tabindex");
      const parent = scopes.at(-1);
      // 非表示のクラスが反映される前に戻すと、隠れる要素へフォーカスが残る。
      // 次のモーダルが開いた場合は、その初期フォーカスを優先する。
      queueMicrotask(() => {
        if (scopes.includes(scope)) return;
        if (returnFocusRef.current === activation)
          returnFocusRef.current = null;
        if (!wasTop || scopes.at(-1) !== parent) return;
        const destination =
          previousFocus instanceof HTMLElement &&
          previousFocus !== document.body &&
          visible(previousFocus)
            ? previousFocus
            : fallbackFocus?.current;
        if (
          destination &&
          visible(destination) &&
          (!parent || parent.contains(destination))
        )
          destination.focus({ preventScroll: true });
        else if (parent)
          (
            [...parent.querySelectorAll<HTMLElement>(focusableSelector)].find(
              (element) => visible(element) && element.tabIndex >= 0,
            ) ?? parent
          ).focus({ preventScroll: true });
      });
    };
  }, [active, ref, fallbackFocus]);
}
