/**
 * One read in flight per key, and at most one queued behind it.
 *
 * For a read whose answer depends on state that keeps changing, such as a
 * file's blame or its change bars. A caller that arrives while a read for the
 * same key is running cannot simply share it: it may be asking because the
 * state changed after that read started. So it waits for one fresh read, and
 * every caller that arrives while the first read runs shares that second one.
 * A burst of N calls for one key costs at most two runs, never N concurrent
 * processes.
 *
 * Each key's arguments must determine the read (`keyOf` folds in every
 * argument that changes the answer): the queued read runs with the arguments
 * of the first caller that queued it.
 */
export function coalesceByKey<A extends unknown[], R>(
  keyOf: (...args: A) => string,
  run: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const running = new Map<string, Promise<R>>();
  const queued = new Map<string, Promise<R>>();

  const start = (key: string, args: A): Promise<R> => {
    const read = run(...args);
    running.set(key, read);
    const clear = () => {
      if (running.get(key) === read) running.delete(key);
    };
    read.then(clear, clear);
    return read;
  };

  return (...args: A): Promise<R> => {
    const key = keyOf(...args);
    const current = running.get(key);
    if (!current) return start(key, args);
    const waiting = queued.get(key);
    if (waiting) return waiting;
    // After the running read settles, either way: its outcome says nothing
    // about the state this caller is asking after.
    const next = () => {
      queued.delete(key);
      return start(key, args);
    };
    const fresh = current.then(next, next);
    queued.set(key, fresh);
    return fresh;
  };
}
