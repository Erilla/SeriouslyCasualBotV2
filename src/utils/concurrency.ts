/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * input order in the result.
 *
 * The alt fingerprint sweep is hundreds of Blizzard requests per guild:
 * sequential took ~3 minutes for 313 characters, eight in flight took ~13s.
 *
 * Cooperatively CANCELLED on the first rejection: no worker picks up a new item
 * once any item has thrown. Without that, `Promise.all` hands the caller the
 * error while the remaining workers keep draining the list — and `fn` bodies
 * are not always pure. The alt sweep's callback writes durable resume state
 * (`markScanned`) per member, so siblings racing on after a Blizzard 429 would
 * record hundreds of members as scanned whose comparison results are discarded
 * with the abandoned promise, making them permanently unfingerprintable for
 * that job.
 *
 * Note the residual loss is NOT merely the ≤`limit` items in flight: the
 * rejection discards the whole result array, so every item the callback had
 * already completed in that call is affected too. Cancellation caps the damage
 * at what was already started — it does not undo it. That is why the callback
 * must remain the only place resume state is written, and why it writes only
 * after a determinate outcome.
 *
 * Contract is otherwise unchanged: results are in input order, and the promise
 * rejects with the first error seen.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let aborted = false;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!aborted && next < items.length) {
      const index = next++;
      try {
        out[index] = await fn(items[index], index);
      } catch (error) {
        // Set BEFORE rethrowing so sibling workers observe it on their very
        // next loop check rather than after one more `fn` call.
        aborted = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
