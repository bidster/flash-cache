import { FlashCache, MapStore, IORedisStore, type MayBePromise } from '../dist/esm/index';

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
// @ts-expect-error serialize must be part of a codec
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
const tags = new FlashCache<Set<string>>(new MapStore<Set<string>>(), new MapStore<string[]>(), {
    ttl: 1000,
    staleRatio: 0.5,
});
const tagResult: MayBePromise<Set<string>> = tags.getOrSet('tags', () => new Set<string>(), {
    codec: {
        serialize: (value) => Array.from(value),
        deserialize: (value) => {
            const stored: string[] = value;
            return new Set(stored);
        },
    },
});
void tagResult;
const codec = {
    serialize: (value: Set<string>) => Array.from(value),
    deserialize: (value: string[]) => new Set(value),
};
tags.get('tags', { codec });
tags.set('tags', new Set(), { codec });
// @ts-expect-error deserialize must restore the L1 type
tags.get('tags', { codec: { serialize: (value) => Array.from(value), deserialize: () => 1 } });
// @ts-expect-error mismatched encoded types
tags.set('tags', new Set(), { codec: { serialize: () => 1, deserialize: (value: string[]) => new Set(value) } });
tags.get('tags', {
    // @ts-expect-error deserialize must be synchronous
    codec: { serialize: (value) => Array.from(value), deserialize: async (value: string[]) => new Set(value) },
});
tags.getOrSet('tags', () => new Set(), {
    // @ts-expect-error async serialize cannot implement the array representation
    codec: { serialize: async (value) => Array.from(value), deserialize: (value: string[]) => new Set(value) },
});
// @ts-expect-error a codec contains both conversions
tags.get('tags', { codec: { serialize: (value) => Array.from(value) } });
// @ts-expect-error L1 determines the cache value type
new FlashCache<Set<string>>(new MapStore<string>(), new MapStore<string[]>(), { ttl: 1000, staleRatio: 0.5 });
declare const redis: IORedisStore;
const redisTags = new FlashCache<Set<string>>(new MapStore<Set<string>>(), redis, { ttl: 1000, staleRatio: 0.5 });
redisTags.getOrSet('tags', () => new Set(), { codec });
// @ts-expect-error the old store adapter is removed
import { SerializedStore } from '../dist/esm/index';

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

// Protected Redis hooks remain available to subclasses through the published declarations.
class WrappedIORedisStore extends IORedisStore {
    protected override read(key: string): Promise<string | null> {
        return super.read(key);
    }
    protected override write(key: string, raw: string, expAt: number): Promise<void> {
        return super.write(key, raw, expAt);
    }
    protected override remove(key: string): Promise<void> {
        return super.remove(key);
    }
}
declare const wrappedRedisStore: WrappedIORedisStore;
// @ts-expect-error Redis command hooks are protected
wrappedRedisStore.read('key');
// @ts-expect-error Redis command hooks are protected
wrappedRedisStore.write('key', '{}', 1000);
// @ts-expect-error Redis command hooks are protected
wrappedRedisStore.remove('key');

// No annotation of deserialize may let an async serializer infer Promise as Stored.
const asyncCodec = {
    serialize: async (value: Set<string>) => Array.from(value),
    deserialize: () => new Set(['restored']),
};
// @ts-expect-error serialize cannot return Promise, including an inferred representation
tags.set('tags', new Set(), { codec: asyncCodec });
// @ts-expect-error the same restriction applies to get
tags.get('tags', { codec: asyncCodec });
// @ts-expect-error the same restriction applies to getOrSet
tags.getOrSet('tags', () => new Set(), { codec: asyncCodec });
const unknownCache = new FlashCache(new MapStore<unknown>(), new MapStore<unknown>(), { ttl: 1000, staleRatio: 0.5 });
unknownCache.get('x', {
    codec: {
        serialize: () => null,
        // @ts-expect-error unknown L1 must not allow async deserialize
        deserialize: async () => 'value',
    },
});
cache.set('null', null, { codec: { serialize: () => null, deserialize: () => null } });
cache.set('string', 'value', { codec: { serialize: (value) => value, deserialize: (value) => value } });
tags.get('tags', {
    codec: {
        // @ts-expect-error a union with Promise is also asynchronous
        serialize: (value): string[] | Promise<string[]> => (Math.random() ? Array.from(value) : Promise.resolve([])),
        deserialize: () => new Set<string>(),
    },
});

const primitiveCodec: import('../dist/esm/index').Codec<unknown, unknown> = {
    serialize: () => 42,
    deserialize: () => 'value',
};
void primitiveCodec;

declare const thenable: PromiseLike<string[]>;
tags.set('tags', new Set(), {
    codec: {
        // @ts-expect-error PromiseLike is not a synchronous representation
        serialize: () => thenable,
        deserialize: () => new Set<string>(),
    },
});
unknownCache.get('x', {
    codec: {
        // @ts-expect-error undefined is not a codec result even when Stored is unknown
        serialize: () => undefined,
        deserialize: () => null,
    },
});
