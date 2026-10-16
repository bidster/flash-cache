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

const count = cache.getOrSet('users', () => 42); // Even the first miss is synchronous with MapStore.
const hit = cache.getOrSet('users', async () => 100); // Returns 42 synchronously.
await cache.set('users', 50, { customTtl: 30_000 });
const stored = await cache.get('users'); // Value or undefined; does not invoke a factory.
await cache.delete('users');
```

## Synchronous results and MayBePromise

`MayBePromise<T>` means `T | Promise<T>`: the method returns **the value itself** when it is available synchronously. `await` is optional. The same call can return a Promise on a miss and a plain value on a subsequent L1 hit, even with an asynchronous factory and Redis as L2.

```ts
const result = cache.getOrSet('users', async () => 42);

if (result instanceof Promise) {
  result.then((count) => console.log(count)).catch(console.error);
} else {
  console.log(result); // Runs immediately, in the current call stack.
}
```

- **Fresh L1:** a synchronous value, without creating a Promise or accessing L2; the factory is not invoked.
- **Usable stale L1:** a synchronous value, even when the refresh continues asynchronously.
- **Miss:** synchronous when the L2 read, factory and L2 write are synchronous. An asynchronous operation required for the response produces a Promise.
- **`get`:** a value or `undefined` synchronously when the read is synchronous; a Promise when reading asynchronous L2. No factory is invoked.

`await cache.getOrSet(...)` works in both cases, but execution after `await` always resumes in a microtask, even when the cache returned a plain value. To preserve synchronous processing, use the branch above and avoid declaring your wrapper `async`: an `async` function always returns a Promise. `cloneValue` is synchronous and does not change this choice.

Synchronous-path errors can be thrown directly by the call; asynchronous-path errors reject the Promise. Use `try/catch` around `await` for unified handling, or `try/catch` around the call plus `.catch()` in the Promise branch to preserve synchronous processing.

## Behavior

- `ttl` is a positive integer in milliseconds. `staleRatio` is between 0 and 1: at `0.8`, entries become eligible for background refresh after 80% of their lifetime. Expired entries are never served. L2 promotion preserves timestamps. After an L2 response, an active operation rechecks L1: a fresh entry takes precedence without another publication or factory call. Stale and expired L1 entries do not take precedence.
- One singleflight per key and cache instance covers L2 lookup, factory execution and writes. The first caller supplies the factory, TTL, stale ratio and codec; each reader chooses its own cloning policy. Callers sharing a key must agree on the data contract.
- `set/delete` detach existing loads. Existing readers still receive their results, but detached work cannot start publishing into either cache level. Already dispatched L2 writes cannot be cancelled. Coordination is local to the instance.
- `get` returns fresh or usable stale data from L1 synchronously, otherwise reads L2. It never starts background refresh. A miss, expired entry or L2 read failure returns `undefined`.
- `null` is a valid cached value; `undefined` is reserved for misses.

## Per-call stale ratio and jitter

Pass `customStaleRatio` between `0` and `1` to `getOrSet` or `set` to override the instance setting independently of `customTtl`. It affects newly published entries, not existing timestamps. The first singleflight caller supplies the factory, TTL, stale ratio and codec. Pass the override again for subsequent refreshes.

```ts
import { jitter } from '@bidster/flash-cache';

const ttlMs = 24 * 60 * 60 * 1000;
const freshForMs = 5 * 60 * 1000;

function getUserCount() {
  return cache.getOrSet('users', () => loadUserCount(), {
    customTtl: ttlMs,
    customStaleRatio: jitter(freshForMs, 0.2) / ttlMs,
  });
}
```

The TTL remains 24 hours while entries become stale roughly 4–5 minutes after publication. Apply jitter to the fresh interval in milliseconds, then divide by TTL. The existing `jitter` helper only reduces the interval; its integer rounding makes it unsuitable for applying directly to a small fractional ratio. Refresh starts on access after `staleAt`, not on a timer.

## Per-call codecs and cloning

`FlashCache<T>` specifies the L1 value type. Pass a `codec` to `getOrSet`, `get` and `set` for values that need a different representation in L2. The intermediate type is inferred from the call's codec; no second instance generic or central registry is required.

```ts
import Redis from 'ioredis';
import { IORedisStore } from '@bidster/flash-cache';

const tagsCache = new FlashCache<Set<string>>(new MapStore<Set<string>>(), new IORedisStore(new Redis()), {
  ttl: 60_000,
  staleRatio: 0.8,
});
const codec = {
  serialize: (value: Set<string>) => [...value],
  deserialize: (value: string[]) => new Set(value),
};
const tags = await tagsCache.getOrSet('tags', () => new Set(['typescript']), { codec });
const copy = await tagsCache.get('tags', { codec, cloneValue: (value) => new Set(value) });
await tagsCache.set('tags', new Set(['updated']), { codec });
```

L1 holds a `Set`; the L2 entry holds an array. `IORedisStore` performs JSON serialization of the entry itself, so codecs do not need `JSON.stringify/parse`. Without conversion, a Set would serialize to `{}`.

Both codec functions are synchronous and must not mutate their input. Fresh L1 never invokes them. The first singleflight caller supplies the codec for both reading and writing; joined readers receive the restored value. All calls sharing a key, including `get/set`, must use compatible codecs. They are not registered or compared by reference.

Without a codec, values pass through unchanged: callers must ensure compatibility with L2. Omitting a codec for an encoded key can appear to work on L1 but return the wrong value type from L2. `SerializedStore` has been removed; connect L2 directly. Conversion errors follow the same policy as L2 access errors.

Values are shared by reference by default. An optional `cloneValue` in the options of `getOrSet` or `get` creates a separate value for that call, including readers sharing a load. Omitting it returns the shared reference, regardless of other readers’ options. Instance-level `cloneValue` is no longer supported. It must synchronously preserve the value's type and behavior. A cloning error affects only that reader. Input values are not cloned. Use `structuredClone` explicitly only for compatible data.

## Wrapping Redis commands

Subclasses can override the protected `read(key)`, `write(key, raw, expAt)` and `remove(key)` methods and wrap calls to `super` with a circuit breaker or another execution policy. Public `get/set/delete` retain JSON conversion and absolute expiry through `PXAT`. Serialization runs before `write`; parsing runs after `read` resolves, keeping JSON errors outside the command wrapper. [Subclass example](docs/flash-cache.md#обёртки-redis-команд).

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
