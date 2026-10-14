/**
 * 複数選択を切り替える。選択済みの値は常に解除できるが、
 * 未選択の値は上限に達している場合は追加しない。
 */
export function toggleBoundedSelection<T>(
  current: ReadonlySet<T>,
  value: T,
  max: number,
): Set<T> {
  const next = new Set(current);
  if (next.delete(value)) return next;
  if (next.size < Math.max(0, max)) next.add(value);
  return next;
}
