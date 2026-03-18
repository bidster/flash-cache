# @bidster/flash-cache

⚡ Ultra-fast two-level cache with `L1` in-memory reads, `L2` fallback, and strict `ttl` expiry.

## Installation

```bash
npm install @bidster/flash-cache
# or
yarn add @bidster/flash-cache
```
## Usage

```typescript
import { FlashCache, MapStore, IORedisStore } from '@bidster/flash-cache';
import Redis from 'ioredis';

const redis = new Redis();

const cache = new FlashCache(
  new MapStore(),                 // L1
  new IORedisStore(redis),        // L2
  { ttl: 60_000, staleRatio: 0.4 }
);

await cache.set('foo', 'bar');
const result = await cache.get('foo');
console.log(result.value, result.state);
```

`ttl` is a hard expiry for both cache levels. After it expires, the value is invalid everywhere.

`staleRatio` defines the boundary between `L1` and `L2` trust windows relative to `ttl`.
For example, with `ttl = 10_000` and `staleRatio = 0.4`:

- first `4s`: value is `fresh` and served from `L1`
- next `6s`: value is `stale` in `L1`, can still be read from `L2`
- after `10s`: value is `expired`

`get()` returns:

```typescript
type CacheResult<T> = {
  value: T | undefined;
  state: 'fresh' | 'stale' | 'expired' | 'miss';
};
```
