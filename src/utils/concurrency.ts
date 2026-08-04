/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * input order in the result.
 *
 * The alt fingerprint sweep is hundreds of Blizzard requests per guild:
 * sequential took ~3 minutes for 313 characters, eight in flight took ~13s.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}
