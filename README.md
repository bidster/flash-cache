# @bidster/flash-cache

[Русская версия](README.ru.md)

Two-level caching for Node.js with synchronous local reads, asynchronous secondary storage, and stale-while-revalidate memoization.

`FlashCache` manages entries in **L1** (a synchronous store) and **L2** (a synchronous or asynchronous store). `FlashMemo` adds source loading, deduplicates concurrent loads, and clones returned values by default. Use `MapStore` for in-memory storage or `IORedisStore` for a shared Redis L2.

## Installation

```bash
npm install @bidster/flash-cache ioredis
# or
yarn add @bidster/flash-cache ioredis
```

The package provides ESM and CommonJS entrypoints and TypeScript declarations. `ioredis` 5 is declared as a peer dependency; `IORedisStore` uses it to access Redis. Default memoization cloning requires the runtime's `structuredClone` API.

## Quick start

```typescript
import {
  FlashCache,
  FlashMemo,
  MapStore,
} from '@bidster/flash-cache';

type User = { id: string; name: string };

const cache = new FlashCache<User>(
  new MapStore<User>(),
  new MapStore<User>(),
  { ttl: 60_000, staleRatio: 0.8, namespace: 'users' },
);
const memo = new FlashMemo(cache);

const user = await memo.memoize('42', async () => {
  const response = await fetch('https://api.example.com/users/42');
  if (!response.ok) throw new Error(`User request failed: ${response.status}`);
  return await response.json() as User;
});

console.log(user.name);
```

The first call loads and caches the user. Fresh calls use L1 without calling the loader. Once L1 becomes stale, a call returns its still-valid value immediately and checks L2 in the background. The loader runs only if that check does not find a fresh value.

For Redis-backed L2, replace the second `MapStore`:

```typescript
import { Redis } from 'ioredis';
import {
  FlashCache,
  FlashMemo,
  IORedisStore,
  MapStore,
  type JsonValue,
} from '@bidster/flash-cache';

const redis = new Redis('redis://localhost:6379');
const cache = new FlashCache<JsonValue>(
  new MapStore<JsonValue>(),
  new IORedisStore(redis),
  { ttl: 60_000, staleRatio: 0.8, namespace: 'users' },
);
const memo = new FlashMemo(cache);

await cache.set('42', { id: '42', name: 'Igor' });
console.log(await memo.memoize('42', () => ({ id: '42', name: 'Igor' })));

// Close the application-owned client during shutdown.
await redis.quit();
```

## TTL and revalidation

All durations are in milliseconds. `ttl` must be a positive integer, and `staleRatio` must be a finite number between `0` and `1`, inclusive. Both options are required.

Each write records `time`, `staleAt`, and `expAt`. For the selected TTL:

```text
staleAt = write start + ttl × staleRatio
expAt   = write start + ttl
```

With `ttl: 10_000` and `staleRatio: 0.4`, an entry is fresh for the first four seconds, stale but usable for the next six seconds, and expired at ten seconds. `staleRatio: 1` keeps entries fresh until expiry; `staleRatio: 0` makes them stale immediately.

Reads and promotion from L2 preserve the original timestamps. Only a new write starts a new lifetime. Expiry is checked when reading; it does not itself remove entries from an in-memory store.

### Reading with `FlashCache`

`cache.get(key, deserialize?)` returns `CacheResult<T>` directly when L1 is usable and a `Promise<CacheResult<T>>` when it must wait for L2.

| State | Meaning |
| --- | --- |
| `fresh` | A fresh value is available; an L1 hit does not read L2. |
| `revalidating` | A stale but unexpired L1 value is returned immediately, with an ongoing L2 check in `revalidation`. |
| `stale` | The L2 check completed without obtaining a fresh value, and a stale but unexpired value is available. |
| `expired` | No usable value is available, and an expired entry was found. Any returned payload is diagnostic only. |
| `miss` | No usable or expired entry was found. |

```typescript
const result = await cache.get('42');

if (result.state === 'revalidating') {
  console.log('Usable local value:', result.value);
  const checked = await result.revalidation;
  console.log('Completed L2 check:', checked.state, checked.value);
} else if (result.state === 'fresh' || result.state === 'stale') {
  console.log('Usable value:', result.value);
}
```

`await cache.get()` does **not** wait for `revalidation`. The original result remains a `revalidating` snapshot after the check finishes. Await its `revalidation` promise to observe the completed result.

A fresh or stale L2 entry is promoted into L1. If L2 is missing, expired, or unavailable, the check rereads L1 and returns its value if it is still unexpired. If L1 expired while waiting, the completed result is `expired` or `miss` instead.

To retain synchronous reads in a hot path, await only actual promises:

```typescript
const pending = cache.get('42');
const result = pending instanceof Promise ? await pending : pending;
```

`FlashCache` only checks L2; it never calls a source loader. Use `FlashMemo` to refresh data from a database, API, or computation.

## Memoization

```typescript
memo.memoize(key, loader, {
  customTtl: 30_000,
  useClones: true,
});
```

The loader can return a value or a promise. `memoize()` likewise returns a value or a promise, depending on the read path.

| Cache result | `FlashMemo` behavior |
| --- | --- |
| Fresh L1 | Returns immediately; skips the loader. |
| Revalidating L1 | Returns the local value immediately; waits for L2 before deciding to run the loader. |
| Fresh L2 | Returns the L2 value; skips the loader. |
| Stale after the L2 check | Returns the stale value and loads a replacement in the background. |
| Miss or expired | Waits for the loader and cache write, then returns the loaded value. |

Concurrent loads for the same key share one refresh within a `FlashMemo` instance. A refresh includes the L2 check, source load when needed, and write. The first participating call supplies the loader, serializers, and custom TTL; use consistent options for each key.

`customTtl` overrides the cache's default TTL for a loader write. It must be a positive integer and is validated only when a source load is needed. It is exposed through `memoize()`, not through the public `cache.set()` API.

`undefined` cannot be cached or returned by a loader; it causes an error and is also excluded by the TypeScript API. `null` is valid and can represent a cached absence.

### Cloning and references

`FlashCache` does not clone values: writes retain the input reference in L1, and reads return stored references. A synchronous Map-backed L2 also retains references unless a serializer creates a separate value.

`FlashMemo` defaults to `useClones: true` per call. It uses `structuredClone` for objects and functions and returns primitives directly. Cloning applies to cache hits, deserialized values, and loader results; concurrent callers receive separate clones.

```typescript
const value = await memo.memoize('42', () => ({ name: 'Igor' }), {
  useClones: false,
});
```

With `useClones: false`, callers receive shared references and must manage mutations themselves. `structuredClone` preserves supported built-in types and cycles, but does not preserve custom class prototypes or methods. Unsupported values, such as functions, cause cloning errors. To return restored class instances with methods, use `useClones: false`.

## Serialization

`FlashCache<L1Value, L2Value>` allows different local and stored value types. Pass a serializer to `set()` and a deserializer to `get()`, or supply both to `memoize()`. These functions are configured per call, not on the constructor.

```typescript
import { Redis } from 'ioredis';
import {
  FlashCache,
  FlashMemo,
  IORedisStore,
  MapStore,
  type JsonValue,
} from '@bidster/flash-cache';

const redis = new Redis();
const cache = new FlashCache<Date, JsonValue>(
  new MapStore<Date>(),
  new IORedisStore(redis),
  { ttl: 60_000, staleRatio: 0.8, namespace: 'dates' },
);
const memo = new FlashMemo(cache);
const serialize = (date: Date): string => date.toISOString();
const deserialize = (value: JsonValue): Date => {
  if (typeof value !== 'string') throw new Error('Expected an ISO date string');
  return new Date(value);
};

await cache.set('updatedAt', new Date(), serialize);
const result = await cache.get('updatedAt', deserialize);
const date = await memo.memoize('createdAt', () => new Date(), {
  serialize,
  deserialize,
  customTtl: 30_000,
});
```

Deserialization runs only for L2 data; an L1 hit already contains the local value. Without a deserializer, L2 values are returned as stored. The read type includes both the L1 type and the deserialized or raw L2 type. Serializers and deserializers must be synchronous. L2 reads are deduplicated, but each caller deserializes and promotes the result separately.

`IORedisStore` JSON-encodes the complete entry. It accepts `JsonValue` and does not restore domain types such as `Date`, `Map`, or class instances automatically. Use explicit conversion when the L1 value is not JSON-compatible.

## Writes, deletion, and errors

- `await cache.set(key, value, serialize?)` serializes first, writes L1 synchronously, then waits for the L2 write. An L2 write error is suppressed; the new L1 value remains available.
- `await cache.del(key)` deletes L1 synchronously, then waits for L2 deletion. An L2 deletion error is suppressed; the remaining L2 entry may populate L1 again on a later read.
- L2 read errors are treated as an absent L2 entry. An unexpired L1 value can still be returned; otherwise the result is `miss` or `expired`.
- L1 errors, serializer errors, and deserializer errors propagate. A serializer failure occurs before either store is changed; an L1 write or deletion failure prevents the corresponding L2 operation.
- Loader errors propagate to callers waiting for a value on a miss or expiry. Background refresh errors are suppressed when a usable cached value has already been returned. Failed loads do not write a replacement or extend the previous TTL; later calls can try again.
- Cloning errors propagate to the caller, including a synchronous throw on a synchronous hit. Cloning a loader result happens after the write, so a clone failure does not roll back the cached value.

Suppressed errors are not logged by the library. Add logging or metrics in a loader or store adapter when needed. There is no automatic retry schedule or configurable L2 error policy.

### Concurrent operations

Writes and deletions are not atomic across stores, and operations on a key are not serialized. An earlier L2 read can finish after `set()` or `del()` and overwrite or repopulate L1 with an older fresh **or stale** entry. Writes and deletions do not cancel pending reads or refreshes; later readers can join the same pending L2 request.

L2 read deduplication is scoped to one `FlashCache` instance; loader deduplication is scoped to one `FlashMemo` instance. Instances and processes do not share a lock, invalidation stream, or refresh coordination. Applications requiring strict ordering must coordinate reads, writes, deletions, and background work themselves.

## Stores and key namespaces

`MapStore<T>` extends `Map<string, StoreValue<T>>`. It has no capacity limit, eviction policy, or automatic cleanup of expired entries. Use it for L1, in-memory L2, or tests.

`IORedisStore` receives an application-owned `ioredis` client. It stores JSON and uses Redis `SET ... PXAT expAt` for physical expiry. Configure the client connection and its retry behavior in the application, and close it during shutdown. Application and Redis clocks must agree for absolute expiry to behave as intended.

A custom L1 implements `Store<T>` with synchronous `get`, `set`, and `delete`. L2 implements `MayBeAsyncStore<T>` with the same methods, returning either direct results or promises. Stores receive complete entries:

```typescript
interface StoreValue<T> {
  value: T;
  time: number;
  staleAt: number;
  expAt: number;
}
```

A compatible synchronous LRU can be used directly as L1. Store `StoreValue<T>` entries, set the desired capacity, and account for its own eviction and TTL behavior. `FlashCache` imposes no storage limit or cleanup scheduler.

The same prefixed key is used for both levels:

| Option | Stored key for `42` |
| --- | --- |
| Namespace omitted | `flashCache:v1:42` |
| `namespace: 'users'` | `flashCache:v1:users:42` |
| `namespace: false` | `42` |

### TTL jitter

`jitter(ttl, percent = 0.1)` shortens a TTL by a random integer less than `ttl × percent`. Apply it when choosing the cache TTL or a memoized loader's `customTtl` to spread expiry times:

```typescript
import { jitter } from '@bidster/flash-cache';

await memo.memoize('42', () => ({ name: 'Igor' }), {
  customTtl: jitter(60_000),
});
```

The utility does not validate its arguments; the resulting TTL must still meet the cache or memoization requirements.

## Development and tests

From the repository root:

```bash
yarn install --frozen-lockfile
yarn build
yarn test
yarn test:types
```

`build` generates ESM and CommonJS output. `test` runs unit and behavior tests, excluding Redis integration tests. `test:types` rebuilds the package and checks its TypeScript contracts.

Redis integration tests use Testcontainers and require Docker:

```bash
yarn test:integration
```

That script sets `DOCKER_HOST` to the Docker Desktop socket at `$HOME/.docker/run/docker.sock`. For a different Docker setup, run Vitest with your environment directly:

```bash
yarn vitest run src/stores/ioredis-store.integration.spec.ts
```

## Benchmarks

Benchmark commands live in the separate [`bench`](bench) package. Its recorded environment uses Node.js 22.22.0 and npm 10.9.4. Build the root package before running a suite:

```bash
yarn build
cd bench
npm ci --ignore-scripts
npm run bench

# Individual suites
npm run bench:cache
npm run bench:memoize
npm run bench:overhead
npm run bench:flash-memo-cacheable
npm run bench:flash-cache

# Reverse participant order in comparison suites
BENCH_REVERSE=1 npm run bench
```

The suites cover cache-aside reads and misses, memoization and SWR, overhead over the same LRU, and `FlashMemo.memoize` versus `Cacheable.wrap`. Sources describe each workload and its validation. [Recorded memoization results](bench/flash-memo-cacheable.results.json) include run metadata and source hashes; they describe the measured checkout, not necessarily the current implementation.

For local regression checks, `bench:baseline` writes `bench/flash-cache.baseline.json`, and `bench:check` compares throughput against it. These commands use the `bench` package:

```bash
npm run bench:baseline
npm run bench:check
FLASH_CACHE_BENCH_THRESHOLD=0.1 npm run bench:check
```

The default allowed throughput drop is 15%. Compare on the same machine and Node version, and regenerate the baseline deliberately when the workload or implementation changes. The saved baseline is ignored by Git.

These in-memory microbenchmarks do not model Redis/network latency, production concurrency, or eviction pressure. Some explicitly disable cloning and serialization. Check those settings before comparing results with the default `FlashMemo` behavior, and measure the workload you intend to deploy.

## License

[MIT](LICENSE).
