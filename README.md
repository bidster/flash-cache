# @bidster/flash-cache

Two-level cache for Node.js with:

- `L1` in-memory reads
- `L2` async persistence
- strict `ttl` expiry
- stale reads from `L1` with background refresh from `L2`
- request deduplication for concurrent `L2` reads
- memoized cache fill via `FlashMemo`
- optional Redis-backed `L2`

## Installation

```bash
npm install @bidster/flash-cache ioredis
# or
yarn add @bidster/flash-cache ioredis
```

`ioredis` is a peer dependency. You only need it when you use `IORedisStore`.

## Usage

```typescript
import Redis from 'ioredis';
import { FlashCache, FlashMemo, IORedisStore, MapStore } from '@bidster/flash-cache';

const redis = new Redis();

const cache = new FlashCache(
  new MapStore(),          // L1
  new IORedisStore(redis), // L2
  {
    ttl: 60_000,
    staleRatio: 0.4,
    namespace: 'users',
  },
);
const memo = new FlashMemo(cache);

await cache.set('42', { name: 'Igor' });

const result = await cache.get('42');

if (result.state === 'fresh') {
  console.log('served from fresh L1 value');
}

if (result.state === 'stale') {
  console.log('served stale L1 value, L2 refresh is running in background');
}

console.log(result.value);

const user = await memo.memoize(
  '42',
  () => fetchUserFromApi('42'),
);
```

## Semantics

`ttl` is a hard expiry for both cache levels. After `ttl`, the value is invalid everywhere.

`staleRatio` defines when `L1` stops being fresh:

- from `0` to `ttl * staleRatio`: `fresh`
- from `ttl * staleRatio` to `ttl`: `stale`
- after `ttl`: `expired`

Example:

- `ttl = 10_000`
- `staleRatio = 0.4`

Then:

- first `4s`: `get()` returns `{ state: 'fresh' }`
- next `6s`: `get()` returns `{ state: 'stale' }` from `L1` and triggers background refresh from `L2`
- after `10s`: stale value is no longer trusted; the cache reports `expired` or `miss` depending on `L2`

`cache.get()` has two execution modes:

- synchronous return for `L1` hits (`fresh` or `stale`)
- `Promise` return when it has to consult `L2`

### Concurrent operations

Operations on the same key are not serialized. The cache permits temporarily outdated values when reads overlap with `set()` or `del()`:

- A pending `L2` read can populate `L1` after `set()` completes, replacing the newer local value with the older result.
- A pending `L2` read can populate `L1` after `del()` completes, making the deleted value locally available again.
- This applies to both foreground reads and background refreshes. Promotion preserves the entry's original `staleAt` and `expAt`; it does not extend its TTL. Only entries still classified as `fresh` are promoted.
- `set()` and `del()` do not cancel pending reads or remove them from single-flight deduplication. A subsequent read that needs `L2` can join an older request that is still pending.

For example, an `L2` read starts with value `A`, then `await cache.set(key, 'B')` completes. If the earlier read subsequently returns `A` while it is still fresh, `L1` can contain `A` while `L2` contains `B`.

If an application requires strict ordering or immediate invalidation, the caller must coordinate all operations on that key, including pending background refreshes. Awaiting `set()` or `del()` alone does not wait for earlier reads to finish.

Concurrent `L2` reads are deduplicated within each `FlashCache` instance. Different instances remain independent, even when they use the same namespace and the same `L2` store object.

## API

```typescript
type CacheResult<T> = {
  value: T | undefined;
  state: 'fresh' | 'stale' | 'expired' | 'miss';
};
```

### `new FlashCache(primary, secondary, options)`

`primary`:
- synchronous store, usually `MapStore`

`secondary`:
- sync or async store
- usually `IORedisStore` or another custom adapter

`options`:

```typescript
{
  ttl: number;
  staleRatio: number;
  namespace?: string | false;
}
```

### `await cache.set(key, value, customTtl?)`

Stores a value in both `L1` and `L2`.

The value is serialized, if a serializer is provided, and written to `L2` first. `L1` is updated only after the `L2` write succeeds. If serialization or the `L2` write fails, `set()` rejects without updating `L1` through that call. If the subsequent `L1` write fails, `set()` rejects and the successful `L2` write is not rolled back. The operation is not atomic across the two stores.

While the `L2` write is pending, readers may continue to receive the previous value from `L1`. Concurrent operations can still change either store; see [Concurrent operations](#concurrent-operations).

- `customTtl` overrides the default `ttl` for this entry
- `undefined` is not allowed and throws
- `null` is allowed and can be used for negative caching

TypeScript also rejects `undefined` at compile time for `set()`.

### `cache.get(key)`

Returns:

- `fresh` when `L1` entry is still fresh
- `stale` when `L1` entry is stale but still within `ttl`
- `expired` when `L2` still has the entry but it is already past `ttl`
- `miss` when the key is absent

`get()` returns the result directly for `L1` hits and a `Promise` when it needs `L2`.

Concurrent `L2` lookups for the same key within one `FlashCache` instance are deduplicated with single-flight semantics. See [Concurrent operations](#concurrent-operations) for interactions with writes and deletion.

### `new FlashMemo(cache)`

Memoized cache-fill helper on top of `FlashCache`.

### `memo.memoize(key, loader, options?)`

Loads a value on `miss` or `expired`, stores it in the cache, and returns it.

- `fresh` returns the cached value immediately and does not call `loader`
- `stale` returns the stale value immediately and refreshes in background
- `miss` and `expired` call `loader`, store the result, and return it
- concurrent `memoize()` calls for the same key are deduplicated
- `loader` must not return `undefined`

Loader errors are handled identically whether the loader throws synchronously or returns a rejected Promise:

- On `fresh`, the loader is not called.
- On `stale` from either `L1` or `L2`, the stale value is returned and the background loader error is suppressed. The failed loader does not replace the cached value or extend its TTL.
- On `miss` or `expired`, `memoize()` returns a Promise that rejects with the loader's error.
- Loader errors are not cached. A subsequent call can retry loading when the cached value is not fresh; no automatic retry is scheduled.

Background loader errors are not logged by `FlashMemo`. Applications that need logging or metrics should handle that inside the loader and rethrow the error so the load remains a failure.

```typescript
memo.memoize('user:42', () => fetchUser(), {
  customTtl: 30_000,
});
```

Options:

```typescript
{
  customTtl?: number;
}
```

### `await cache.del(key)`

Deletes the key from both `L1` and `L2`.

Pending reads can populate `L1` again after deletion; see [Concurrent operations](#concurrent-operations).

## Built-in stores

The built-in stores are minimal implementations of the storage interfaces. Applications choose and configure memory limits, eviction policies, and physical cleanup of stored entries. `FlashCache` determines freshness and expiry from entry timestamps; it does not impose a storage size limit or run a cleanup scheduler.

### `MapStore`

Simple in-memory store based on `Map`. Useful as `L1`, and also for tests.

It has no size limit, eviction policy, or automatic removal of expired entries. Expiry changes how `FlashCache` treats an entry, but does not remove it from `MapStore`. Applications requiring bounded storage should supply a store with the appropriate policy.

### `IORedisStore`

Redis-backed `L2` store built on top of `ioredis`.

It stores serialized `StoreValue<T>` objects and relies on Redis `PXAT` to expire them at `expAt`.

### Using an LRU store directly

Any synchronous store compatible with `Store<T>` can be used as `L1` without an adapter. For example, `lru-cache` provides compatible `get`, `set`, and `delete` methods. Install it as a direct dependency of the application:

```bash
npm install lru-cache
```

```typescript
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import {
  FlashCache,
  IORedisStore,
  type JsonValue,
  type StoreValue,
} from '@bidster/flash-cache';

const redis = new Redis();
const l1 = new LRUCache<string, StoreValue<JsonValue>>({ max: 10_000 });
const cache = new FlashCache<JsonValue>(
  l1,
  new IORedisStore(redis),
  { ttl: 60_000, staleRatio: 0.4, namespace: 'users' },
);

await cache.set('42', { name: 'Igor' });
```

The LRU stores complete `StoreValue<T>` entries, including their timestamps. Here, `max` limits the number of entries, not their total size in bytes. `FlashCache` handles freshness and expiry, so the LRU does not need its own TTL for this configuration. Expired entries may remain allocated until eviction or explicit deletion; the entry count remains bounded by `max`.

If physical cleanup at expiry is required, the application must configure or adapt its store accordingly. An LRU's own TTL does not automatically use the `expAt` field inside `StoreValue<T>`.

## Utilities

### `jitter(ttl, percent?)`

Returns a randomized TTL shortened by up to `percent` (default `0.1`). Useful when you want to reduce synchronized expiry bursts before calling `set()`.

## Namespacing

By default, keys are prefixed with:

```text
flashCache:v1:<namespace>:<key>
```

Behavior:

- `namespace: 'users'` => `flashCache:v1:users:<key>`
- omitted `namespace` => `flashCache:v1:<key>`
- `namespace: false` => raw key without prefix

Use `namespace: false` only when you explicitly want to control raw keys yourself.

## Testing

```bash
yarn test
yarn test:types
yarn test:integration
yarn bench
yarn bench:baseline
yarn bench:check
```

- `yarn test` runs unit and behavior tests
- `yarn test:types` checks compile-time contracts
- `yarn test:integration` runs Redis integration tests via Testcontainers and Docker
- `yarn bench` runs local `tinybench` scenarios for hot `get()` and `memo()` paths on `MapStore`
- benchmark scenarios currently cover fresh/stale `get()` and fresh/stale/miss `memoize()` flows without Redis
- `yarn bench:baseline` saves the current benchmark summary as the local baseline
- `yarn bench:check` reruns benchmarks and fails if throughput regresses beyond the configured threshold

Benchmark notes:

- benchmark results are intended for local comparison, not as CI pass/fail thresholds
- compare runs on the same machine and Node.js version
- local regression checks compare against `bench/flash-cache.baseline.json`
- local checks gate on throughput, while latency stays in the report for diagnosis
- default regression threshold is `15%`; override it with `FLASH_CACHE_BENCH_THRESHOLD=0.1 yarn bench:check`
