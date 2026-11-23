// Poll until a condition holds instead of sleeping a fixed time (a slow Windows run made fixed sleeps flaky).
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Call `read` until it returns a truthy value and return that value; on timeout throw with the last value read. */
export async function waitFor<T>(
  read: () => T | Promise<T>, description: string, timeoutMs = 15_000, intervalMs = 50,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    last = await read(); // an error thrown by read propagates at once, as before
    if (last) return last as NonNullable<T>;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  let shown: string;
  try {
    shown = typeof last === "string" ? last : JSON.stringify(last) ?? String(last);
  } catch {
    shown = String(last);
  }
  throw new Error(`${description}（等了 ${timeoutMs} ms，最后一次读到：${shown.slice(0, 300)}）`);
}
