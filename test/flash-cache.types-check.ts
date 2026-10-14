import { FlashCache, MapStore, SerializedStore, type MayBePromise } from '../dist/esm/index';

const cache = new FlashCache<string | null | undefined>(
    new MapStore<string | null | undefined>(),
    new MapStore<string | null | undefined>(),
    { ttl: 1000, staleRatio: 0.5 },
);
const result: MayBePromise<string | null> = cache.getOrSet('x', () => 'value', { cloneValue: (value) => value });
const read: MayBePromise<string | null | undefined> = cache.get('x', { cloneValue: (value) => value });
void result;
void read;
cache.set('x', null);
// @ts-expect-error undefined is reserved for misses
cache.set('x', undefined);
// @ts-expect-error factory cannot return undefined
cache.getOrSet('x', () => undefined);
// @ts-expect-error factory must return the cache value type
cache.getOrSet('x', () => 1);
// @ts-expect-error materialize is not a cache option
cache.getOrSet('x', () => 'value', { materialize: String });
// @ts-expect-error serialize belongs to the store
cache.getOrSet('x', () => 'value', { serialize: String });
// @ts-expect-error cloneValue cannot return a different value type
cache.getOrSet('x', () => 'value', { cloneValue: () => 1 });
// @ts-expect-error get also requires the original value type
cache.get('x', { cloneValue: () => 1 });
// @ts-expect-error cloneValue must be synchronous
cache.getOrSet('x', () => 'value', { cloneValue: async (value) => value });
// @ts-expect-error get cloneValue must be synchronous
cache.get('x', { cloneValue: async (value) => value });
// @ts-expect-error cloneValue cannot return undefined
cache.get('x', { cloneValue: () => undefined });
// @ts-expect-error set does not clone input values
cache.set('x', 'value', { cloneValue: String });
// @ts-expect-error useClones is removed
new FlashCache(new MapStore<string>(), new MapStore<string>(), { ttl: 1000, staleRatio: 0.5, useClones: true });
new FlashCache<string>(new MapStore<string>(), new MapStore<string>(), {
    ttl: 1000,
    staleRatio: 0.5,
    // @ts-expect-error instance-level cloneValue is removed
    cloneValue: String,
});
const dates = new FlashCache<Date>(
    new MapStore<Date>(),
    new SerializedStore(new MapStore<string>(), {
        serialize: (date: Date) => date.toISOString(),
        deserialize: (value) => new Date(value),
    }),
    { ttl: 1000, staleRatio: 0.5 },
);
const date: MayBePromise<Date> = dates.getOrSet('x', () => new Date(), { cloneValue: (value) => new Date(value) });
void date;
// @ts-expect-error raw strings do not implement a Date store
new FlashCache<Date>(new MapStore<Date>(), new MapStore<string>(), { ttl: 1000, staleRatio: 0.5 });

// @ts-expect-error the legacy class is no longer exported
import { FlashMemo } from '../dist/esm/index';
// @ts-expect-error the old state protocol is no longer exported
import type { CacheResult } from '../dist/esm/index';
// @ts-expect-error only delete is supported
cache.del('x');
// @ts-expect-error getOrSet is the only loading operation
cache.memoize('x', () => 'value');

// @ts-expect-error store errors require no special exported class
import { StoreTransformError } from '../dist/esm/index';

cache.getOrSet('ratio', () => 'value', { customStaleRatio: 0.2 });
cache.set('ratio', 'value', { customStaleRatio: 0.2 });
// @ts-expect-error stale ratio must be a number
cache.getOrSet('ratio', () => 'value', { customStaleRatio: '0.2' });
// @ts-expect-error direct get does not set lifetime options
cache.get('ratio', { customStaleRatio: 0.2 });
