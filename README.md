# @bidster/flash-cache

A two-level Node.js cache with a unified `getOrSet` API, a synchronous fast path, singleflight and stale-while-revalidate.

```sh
npm install @bidster/flash-cache
```

```ts
import { FlashCache, MapStore } from '@bidster/flash-cache';

const cache = new FlashCache<number>(new MapStore<number>(), new MapStore<number>(), {
  ttl: 60_000,
  staleAfter: 48_000,
  namespace: 'counts',
  onError: (error, context) => console.error(context, error),
});

const count = cache.getOrSet('users', () => 42); // Even the first miss is synchronous with MapStore.
const hit = cache.getOrSet('users', async () => 100); // Returns 42 synchronously.
await cache.set('users', 50, { ttl: 30_000 });
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

- `ttl` is a positive integer in milliseconds or a synchronous function returning one. Each L1 has its own refresh deadline; L2 retains a shared creation time and hard expiry. Expired entries are never served. After an L2 response, an active operation rechecks fresh L1 before publishing or invoking a factory.
- One singleflight per key and cache instance covers L2 lookup, factory execution and writes. The first caller supplies the factory, TTL, staleAfter and codec; each reader chooses its own cloning policy. Callers sharing a key must agree on the data contract.
- `set/delete` detach existing loads. Existing readers still receive their results, but detached work cannot start publishing into either cache level. Already dispatched L2 writes cannot be cancelled. Coordination is local to the instance.
- `get` returns fresh or usable stale data from L1 synchronously, otherwise reads L2. It never starts background refresh. A miss, expired entry or L2 read failure returns `undefined`.
- `null` is a valid cached value; `undefined` is reserved for misses.

## Local refresh deadlines and shared expiry

L2 stores only `{ value, time, expAt }`. L1 adds a local `staleAt` deadline.
`staleAfter` is a non-negative integer in milliseconds or a synchronous function
`(ttl: number) => number` returning one. Each cache instance samples it once when accepting a new snapshot,
including L2 promotion. A snapshot is identified by its `time/expAt` pair. Re-reading
the same snapshot does not resample; evicting L1 allows a new local deadline.

```ts
import { FlashCache, MapStore, jitter } from '@bidster/flash-cache';

const cache = new FlashCache(l1, l2, {
  ttl: 600_000,
  staleAfter: () => jitter(120_000, 0.5),
});
```

This chooses a local check 60–120 seconds after snapshot creation while preserving
a shared 600-second hard expiry. Deadlines are anchored to the original creation
time, never to the time L2 is read. `staleAt` is capped at `expAt` and is never
persisted in L2.

`ttl` may be a number or a synchronous `() => number`. Its sampler runs once when
publishing a new snapshot, after a successful factory or during explicit `set`.
Construction, cache hits, L2 reads, failed factories and detached factory results do
not evaluate it. The first singleflight caller supplies the TTL sampler.

The argument to `staleAfter(ttl)` is the snapshot's actual `expAt - time`, not its
remaining lifetime or the current instance default. L2 promotion evaluates only the
local stale policy and retains the original creation time and hard expiry.

```ts
const relativeCache = new FlashCache(l1, l2, {
  ttl: () => jitter(600_000),
  staleAfter: (ttl) => jitter(Math.floor(ttl * 0.2), 0.5),
});
```

Both functions are synchronous. TTL results must be positive integers; stale interval
results must be non-negative integers. Sampling or validation errors during publication
do not publish a new snapshot or extend the original deadlines.

After the local deadline, the next request serves usable stale L1 and checks L2
before invoking the factory. A newer snapshot receives a new local deadline;
if locally fresh, it avoids the factory. Re-reading the same stale snapshot cannot
postpone refresh. Only a successful factory or explicit set starts a new hard expiry.

There are no locks, distributed singleflight or background timers. Checks overlapping
an unfinished refresh may still invoke more than one factory. Local singleflight
covers the entire L2 → factory → write cycle.

Override `staleAfter` per call on `getOrSet`, `get` or `set`. `ttl` affects
new publications only. Existing L1 deadlines are unchanged. `get` never invokes a factory.

## Per-call codecs and cloning

`FlashCache<T>` specifies the L1 value type. Pass a `codec` to `getOrSet`, `get` and `set` for values that need a different representation in L2. The intermediate type is inferred from the call's codec; no second instance generic or central registry is required.

```ts
import Redis from 'ioredis';
import { IORedisStore } from '@bidster/flash-cache';

const tagsCache = new FlashCache<Set<string>>(new MapStore<Set<string>>(), new IORedisStore(new Redis()), {
  ttl: 60_000,
  staleAfter: 48_000,
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

`FlashCache` is the main export. The former `FlashMemo`, `memoize`, `del`, `useClones`, `materialize`, `state/revalidation` result protocol and temporary `/v2` export have been removed without compatibility aliases. In rc.11, `staleRatio/customStaleRatio` are replaced by `staleAfter`; `StoreValue` contains shared metadata and `LocalStoreValue` adds the local deadline. The storage prefix is `flashCache:v3:`; `namespace: false` disables it. Old v1/v2 keys are not read or migrated; no compatibility layer is provided.

[Русская документация](README.ru.md) · [Detailed contract (Russian)](docs/flash-cache.md) · [Benchmarks](bench/README.md)

```sh
yarn lint
yarn format:check
yarn test
yarn test:types
yarn test:integration
```

`yarn lint:fix` applies ESLint fixes; `yarn format` formats the project with Prettier. Code uses four-space indentation, single quotes, and a 120-character print width. Generated files and benchmark results are excluded from formatting.
