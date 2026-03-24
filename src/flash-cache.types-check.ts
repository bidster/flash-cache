import { FlashCache } from './flash-cache';
import { FlashMemo } from './flash-memo';
import { MapStore } from './stores/map-store';

const stringCache = new FlashCache<string>(
    new MapStore<string>(),
    new MapStore<string>(),
    { ttl: 10_000, staleRatio: 0.4, namespace: 'types' },
);

const stringMemo = new FlashMemo(stringCache);

void stringCache.set('name', 'alice');
void stringMemo.memoize('name', () => 'alice');
void stringMemo.memoize('name', async () => 'alice');

const nullableCache = new FlashCache<string | null>(
    new MapStore<string | null>(),
    new MapStore<string | null>(),
    { ttl: 10_000, staleRatio: 0.4, namespace: 'types' },
);

const nullableMemo = new FlashMemo(nullableCache);

void nullableCache.set('missing-user', null);
void nullableMemo.memoize('missing-user', () => null);

const optionalCache = new FlashCache<string | undefined>(
    new MapStore<string | undefined>(),
    new MapStore<string | undefined>(),
    { ttl: 10_000, staleRatio: 0.4, namespace: 'types' },
);

const optionalMemo = new FlashMemo(optionalCache);

void optionalCache.set('name', 'alice');
void optionalMemo.memoize('name', () => 'alice');

// @ts-expect-error undefined is reserved for cache misses and must not be stored
void optionalCache.set('missing-user', undefined);

// @ts-expect-error undefined is reserved for cache misses and must not be returned by memo loaders
void optionalMemo.memoize('missing-user', () => undefined);
