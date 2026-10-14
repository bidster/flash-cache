import {FlashCache, MapStore, SerializedStore, type MayBePromise} from '../dist/esm/index';

const cache = new FlashCache<string | null | undefined>(
    new MapStore<string | null | undefined>(), new MapStore<string | null | undefined>(),
    {ttl: 1000, staleRatio: 0.5, cloneValue: value => value},
);
const result: MayBePromise<string | null> = cache.getOrSet('x', () => 'value');
const read: MayBePromise<string | null | undefined> = cache.get('x');
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
cache.getOrSet('x', () => 'value', {materialize: String});
// @ts-expect-error serialize belongs to the store
cache.getOrSet('x', () => 'value', {serialize: String});
// @ts-expect-error cloning is configured on the instance
cache.getOrSet('x', () => 'value', {cloneValue: String});
// @ts-expect-error useClones is removed
new FlashCache(new MapStore<string>(), new MapStore<string>(), {ttl: 1000, staleRatio: 0.5, useClones: true});
// @ts-expect-error cloneValue must preserve the cached type synchronously
new FlashCache<string>(new MapStore<string>(), new MapStore<string>(), {ttl: 1000, staleRatio: 0.5, cloneValue: async value => value});
const dates = new FlashCache<Date>(new MapStore<Date>(), new SerializedStore(new MapStore<string>(), {
    serialize: (date: Date) => date.toISOString(), deserialize: value => new Date(value),
}), {ttl: 1000, staleRatio: 0.5, cloneValue: value => new Date(value)});
const date: MayBePromise<Date> = dates.getOrSet('x', () => new Date());
void date;
// @ts-expect-error raw strings do not implement a Date store
new FlashCache<Date>(new MapStore<Date>(), new MapStore<string>(), {ttl: 1000, staleRatio: 0.5});

// @ts-expect-error the legacy class is no longer exported
import {FlashMemo} from '../dist/esm/index';
// @ts-expect-error the old state protocol is no longer exported
import type {CacheResult} from '../dist/esm/index';
// @ts-expect-error only delete is supported
cache.del('x');
// @ts-expect-error getOrSet is the only loading operation
cache.memoize('x', () => 'value');
