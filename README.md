# @bidster/flash-cache

A two-level Node.js cache with a unified `getOrSet` API, a synchronous fast path, singleflight and stale-while-revalidate.

```sh
npm install @bidster/flash-cache
```

```ts
import { FlashCache, MapStore } from '@bidster/flash-cache';

const cache = new FlashCache<number>(new MapStore<number>(), new MapStore<number>(), {
  ttl: 60_000,
  staleRatio: 0.8,
  namespace: 'counts',
  onError: (error, context) => console.error(context, error),
});

const count = await cache.getOrSet('users', async () => 42);
const hit = cache.getOrSet('users', async () => 100); // Returns 42 synchronously.
await cache.set('users', 50, { customTtl: 30_000 });
const stored = await cache.get('users'); // Value or undefined; does not invoke a factory.
await cache.delete('users');
```

## Behavior

- Operations return `MayBePromise<T>` (`T | Promise<T>`). Fresh L1 hits do not create a Promise or access L2. A miss can also complete synchronously when both stores and the factory are synchronous.
- `ttl` is a positive integer in milliseconds. `staleRatio` is between 0 and 1: at `0.8`, entries become eligible for background refresh after 80% of their lifetime. Expired entries are never served. L2 promotion preserves timestamps. After an L2 response, an active operation rechecks L1: a fresh entry takes precedence without another publication or factory call. Stale and expired L1 entries do not take precedence.
- One singleflight per key and cache instance covers L2 lookup, factory execution and writes. The first caller supplies the factory and refresh options. Callers sharing a key must agree on the data contract.
- `set/delete` detach existing loads. Existing readers still receive their results, but detached work cannot start publishing into either cache level. Already dispatched L2 writes cannot be cancelled. Coordination is local to the instance.
- `get` returns fresh or usable stale data from L1 synchronously, otherwise reads L2. It never starts background refresh. A miss, expired entry or L2 read failure returns `undefined`.
- `null` is a valid cached value; `undefined` is reserved for misses.

## Stores and cloning

Both stores expose the same value type to the cache. Use `MapStore<T>` for memory, `IORedisStore` for JSON-compatible Redis values, and `SerializedStore<Value, StoredValue>` for custom representations:

```ts
import { SerializedStore } from '@bidster/flash-cache';

const secondary = new SerializedStore(new MapStore<string>(), {
  serialize: (date: Date) => date.toISOString(),
  deserialize: (value) => new Date(value),
});
const dates = new FlashCache(new MapStore<Date>(), secondary, {
  ttl: 60_000,
  staleRatio: 0.8,
  cloneValue: (date) => new Date(date.getTime()),
});
```

Serialization belongs to the store, not individual calls. A store only implements `get/set/delete`; no special error types are required. `SerializedStore` is an optional adapter and passes original conversion errors through without wrapping them. FlashCache applies the L2 operation error policy regardless of whether the error came from serialization or storage access.

Values are shared by reference by default. An optional instance-level `cloneValue` creates a separate value for each reader, including readers sharing a load. It must preserve the value's type and behavior. Input values are not cloned. Use `structuredClone` explicitly only for compatible data.

## Errors

L2 read failures are reported through `onError`; after rechecking fresh L1, `getOrSet` continues through the factory if needed and `get` returns `undefined` if no fresh L1 is available; L2 write failures retain the successful result and L1 entry. The optional synchronous `onError(error, {key, operation})` reports these failures as `l2.get` and `l2.set`, and background refresh failures as `refresh`. Exceptions thrown by the hook do not change the cache operation.

Foreground factory, L1 and cloning errors propagate to the caller. `delete` removes L1 first and propagates L2 deletion failures. No retries, timeouts or expired-value fallback are provided.

## API transition

`FlashCache` is the main export. The former `FlashMemo`, `memoize`, `del`, `useClones`, `materialize`, `state/revalidation` result protocol and temporary `/v2` export have been removed without compatibility aliases. The storage prefix remains `flashCache:v2:`; `namespace: false` disables it. Old v1 keys are not read or migrated.

[Русская документация](README.ru.md) · [Detailed contract (Russian)](docs/flash-cache.md) · [Benchmarks](bench/README.md)

```sh
yarn lint
yarn format:check
yarn test
yarn test:types
yarn test:integration
```

`yarn lint:fix` applies ESLint fixes; `yarn format` formats the project with Prettier. Code uses four-space indentation, single quotes, and a 120-character print width. Generated files and benchmark results are excluded from formatting.
