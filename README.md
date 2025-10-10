# @bidster/flash-cache

⚡ Ultra-fast two-level cache (L1 in-memory + L2 async) with **stale-while-revalidate** mechanism.

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
  new MapStore(),               // L1
  new RedisStore(redis),        // L2
  { ttl: 60_000, ttlRatio: 0.5 } // 1 min TTL, L1 живет 30 сек
);

await cache.set('foo', 'bar');
const result = await cache.get('foo');
console.log(result.value, result.needRevalidate);
```
That's it! You now have a blazing fast two-level cache with native-like performance.
