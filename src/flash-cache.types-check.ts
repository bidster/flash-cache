import {
    type CacheValueDeserializer,
    type CacheValueSerializer,
    FlashCache,
} from './flash-cache';
import { FlashMemo, type SerializedMemoizeOptions } from './flash-memo';
import { IORedisStore, type JsonValue } from './stores/ioredis-store';
import { MapStore } from './stores/map-store';
import type { Redis } from 'ioredis';

declare const redis: Redis;

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

class User {
    constructor(readonly name: string) {}

    greeting(): string {
        return `Hello, ${this.name}`;
    }
}

const serializeUser: CacheValueSerializer<User, JsonValue> = (user) => ({name: user.name});
const deserializeUser: CacheValueDeserializer<JsonValue, User> = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected a user object');
    }

    if (typeof value.name !== 'string') {
        throw new Error('Expected a user name');
    }

    return new User(value.name);
};

const jsonRedisStore = new IORedisStore(redis);
const jsonCache = new FlashCache<JsonValue>(
    new MapStore<JsonValue>(),
    jsonRedisStore,
    {ttl: 10_000, staleRatio: 0.4, namespace: 'types'},
);

void jsonCache.set('user', {name: 'alice'});

const sharedCache = new FlashCache<unknown, JsonValue>(
    new MapStore<unknown>(),
    jsonRedisStore,
    {ttl: 10_000, staleRatio: 0.4, namespace: 'types'},
);

void sharedCache.set('user', new User('alice'), serializeUser);
void sharedCache.get('user', deserializeUser);

const sharedMemo = new FlashMemo(sharedCache);
const userMemoOptions: SerializedMemoizeOptions<User, JsonValue> = {
    serialize: serializeUser,
    deserialize: deserializeUser,
};

void sharedMemo.memoize('user', () => new User('alice'), userMemoOptions);
