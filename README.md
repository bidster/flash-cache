# @bidster/flash-cache

Two-level cache for Node.js with:

- `L1` in-memory reads
- `L2` async persistence
- strict `ttl` expiry
- stale reads from `L1` with background refresh from `L2`
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
import { FlashCache, IORedisStore, MapStore } from '@bidster/flash-cache';

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

await cache.set('42', { name: 'Igor' });

const result = await cache.get('42');

if (result.state === 'fresh') {
  console.log('served from fresh L1 value');
}

if (result.state === 'stale') {
  console.log('served stale L1 value, L2 refresh is running in background');
}

console.log(result.value);
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

- `customTtl` overrides the default `ttl` for this entry
- `undefined` is not allowed and throws
- `null` is allowed and can be used for negative caching

TypeScript also rejects `undefined` at compile time for `set()`.

### `await cache.get(key)`

Returns:

- `fresh` when `L1` entry is still fresh
- `stale` when `L1` entry is stale but still within `ttl`
- `expired` when `L2` still has the entry but it is already past `ttl`
- `miss` when the key is absent

### `await cache.del(key)`

Deletes the key from both `L1` and `L2`.

## Built-in stores

### `MapStore`

Simple in-memory store based on `Map`. Useful as `L1`, and also for tests.

### `IORedisStore`

Redis-backed `L2` store built on top of `ioredis`.

It stores serialized `StoreValue<T>` objects and relies on Redis `PXAT` to expire them at `expAt`.

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
```

- `yarn test` runs unit and behavior tests
- `yarn test:types` checks compile-time contracts
- `yarn test:integration` runs Redis integration tests via Testcontainers and Docker
