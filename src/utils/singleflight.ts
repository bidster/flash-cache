export const singleFlight = (() => {
  const inflight = new Map<string | number, Promise<any>>();

  return function <T>(key: string | number, fn: () => Promise<T>): Promise<T> {
    const ex = inflight.get(key);
    if (ex) return ex as Promise<T>;

    const p = fn();
    inflight.set(key, p);
    return p.finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    }) as Promise<T>;
  };
})();
