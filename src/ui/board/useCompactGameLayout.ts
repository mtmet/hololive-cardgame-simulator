import { useEffect, useState } from "react";

/** 縦持ちのスマホと、横持ちで高さが限られる画面を同じ操作UIにする。 */
export const COMPACT_GAME_QUERY =
  "(max-width: 760px), (max-width: 1050px) and (max-height: 600px)";

export function useCompactGameLayout() {
  const [compact, setCompact] = useState(
    () => window.matchMedia(COMPACT_GAME_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(COMPACT_GAME_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}
