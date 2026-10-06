import {
    type CacheValueDeserializer,
    type CacheResult,
    type SettledCacheResult,
    type CacheValueSerializer,
    type SerializedMemoizeOptions,
    type JsonValue,
    FlashCache,
    FlashMemo,
    IORedisStore,
    MapStore,
} from '../dist/esm/index';
import type { Redis } from 'ioredis';

declare const redis: Redis;

const stringCache = new FlashCache<string>(
    new MapStore<string>(),
    new MapStore<string>(),
    { ttl: 10_000, staleRatio: 0.4, namespace: 'types' },
);

// @ts-expect-error cloning is configured only on memoize
new FlashCache(new MapStore<string>(), new MapStore<string>(), {ttl: 1_000, staleRatio: 0.5, useClones: true});
// @ts-expect-error FlashCache does not expose a cloning setting
void stringCache.useClones;

const stringMemo = new FlashMemo(stringCache);

void stringCache.get('name');
void stringCache.get('name', undefined);
void stringCache.get('name', (value) => value.toUpperCase());
declare const optionalStringDeserializer: CacheValueDeserializer<string, string> | undefined;
void stringCache.get('name', optionalStringDeserializer);

// @ts-expect-error a deserialized number cannot be promoted into a string L1
void stringCache.get('n', Number);
// @ts-expect-error explicit type arguments cannot bypass the L1 constraint
void stringCache.get<number>('n', Number);
declare const optionalNumberDeserializer: CacheValueDeserializer<string, number> | undefined;
// @ts-expect-error an optional deserializer must also return a value compatible with L1
void stringCache.get('n', optionalNumberDeserializer);

const mixedCache = new FlashCache<string | number, string>(
    new MapStore<string | number>(),
    new MapStore<string>(),
    {ttl: 10_000, staleRatio: 0.4},
);

// A narrower L2 type can populate L1 without conversion.
void mixedCache.get('n');
void mixedCache.get('n', undefined);
void mixedCache.get('n', optionalNumberDeserializer);
void Promise.resolve(mixedCache.get('n', Number)).then((result) => {
    const value: string | number | undefined = result.value;
    // @ts-expect-error an L1 hit can return a string without deserialization
    const numberOnly: number | undefined = result.value;
    if (typeof value === 'number') value.toFixed();
});

const dateCache = new FlashCache<Date, string>(
    new MapStore<Date>(),
    new MapStore<string>(),
    {ttl: 10_000, staleRatio: 0.4},
);
const deserializeDate = (value: string): Date => new Date(value);
declare const optionalDateDeserializer: CacheValueDeserializer<string, Date> | undefined;

// @ts-expect-error raw strings cannot be promoted into a Date L1
void dateCache.get('updatedAt');
// @ts-expect-error explicit undefined cannot bypass the required deserializer
void dateCache.get('updatedAt', undefined);
// @ts-expect-error the deserializer must be present when L2 is incompatible with L1
void dateCache.get('updatedAt', optionalDateDeserializer);
void Promise.resolve(dateCache.get('updatedAt', deserializeDate)).then((result) => {
    const value: Date | undefined = result.value;
    value?.getTime();
});

const unionStoredCache = new FlashCache<number, number | string>(
    new MapStore<number>(),
    new MapStore<number | string>(),
    {ttl: 10_000, staleRatio: 0.4},
);

// @ts-expect-error every L2 union member must be assignable to L1
void unionStoredCache.get('n');
// @ts-expect-error explicit undefined must not distribute the L2 union check
void unionStoredCache.get('n', undefined);
void unionStoredCache.get('n', Number);

const unionStoredMemo = new FlashMemo(unionStoredCache);
// @ts-expect-error memoize must not read an incompatible L2 without deserialization
void unionStoredMemo.memoize('n', () => 42);
// @ts-expect-error ordinary options cannot bypass the required deserializer
void unionStoredMemo.memoize('n', () => 42, {useClones: false});
void unionStoredMemo.memoize('n', () => 42, {serialize: String, deserialize: Number});

void stringCache.set('name', 'alice');
void stringCache.set('name', 'alice', (value) => value.toUpperCase());
void stringMemo.memoize('name', () => 'alice', {customTtl: 1_000});
void stringMemo.memoize('name', () => 'alice', {useClones: true});
// @ts-expect-error cloning must be a boolean
void stringMemo.memoize('name', () => 'alice', {useClones: 'false'});
// @ts-expect-error FlashCache.get has no cloning argument
void stringCache.get('name', undefined, false);

// @ts-expect-error FlashCache.get has no L2 error policy flag
void stringCache.get('name', undefined, true);
// @ts-expect-error FlashCache.set has no L2 error policy flag
void stringCache.set('name', 'alice', undefined, undefined, true);

// @ts-expect-error custom TTL is only exposed through memoize
void stringCache.set('name', 'alice', 1_000);
// @ts-expect-error the internal fourth argument is not part of the public API
void stringCache.set('name', 'alice', undefined, 1_000);
// @ts-expect-error custom TTL must be a number
void stringMemo.memoize('name', () => 'alice', {customTtl: '1000'});
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
void sharedCache.get('user');
void sharedCache.get('user', undefined);
void sharedCache.get('user', deserializeUser);
void sharedCache.get('count', Number);
void sharedCache.get('count', (value) => String(value));
void Promise.resolve(sharedCache.get('user')).then((result) => {
    // @ts-expect-error unconverted shared-cache reads also remain unknown
    const user: User | undefined = result.value;
});

void Promise.resolve(sharedCache.get('user', deserializeUser)).then((result) => {
    // @ts-expect-error the value in a shared L1 remains unknown
    const user: User | undefined = result.value;
});

const userCache = new FlashCache<User, JsonValue>(
    new MapStore<User>(),
    jsonRedisStore,
    {ttl: 10_000, staleRatio: 0.4, namespace: 'types'},
);

// @ts-expect-error raw JSON cannot be promoted into a User L1
void userCache.get('user');
// @ts-expect-error the optional-deserializer overload must not permit raw JSON here
void userCache.get('user', undefined);

void Promise.resolve(userCache.get('user', deserializeUser)).then((result) => {
    const user: User | undefined = result.value;
    user?.greeting();
});

const sharedMemo = new FlashMemo(sharedCache);
const userMemoOptions: SerializedMemoizeOptions<User, JsonValue> = {
    serialize: serializeUser,
    deserialize: deserializeUser,
};

void sharedMemo.memoize('user', () => new User('alice'), userMemoOptions);

void sharedMemo.memoize('user', () => new User('alice'), {...userMemoOptions, customTtl: 1_000});
// @ts-expect-error serialized writes also expose custom TTL only through memoize
void sharedCache.set('user', new User('alice'), serializeUser, 1_000);
// @ts-expect-error the former TTL-plus-serializer overload is no longer public
void sharedCache.set('user', new User('alice'), 1_000, serializeUser);

void Promise.resolve(userCache.get('user', deserializeUser)).then(async (result) => {
    if (result.state === 'revalidating') {
        const pending: Promise<SettledCacheResult<User>> = result.revalidation;
        const user: User = result.value;
        user.greeting();
        const checked = await pending;
        checked.value?.greeting();
        // @ts-expect-error a completed check cannot start another revalidation
        void checked.revalidation;
        // @ts-expect-error revalidating is not a completed state
        const state: 'revalidating' = checked.state;
    } else {
        // @ts-expect-error only revalidating results expose a promise
        void result.revalidation;
    }
});

// @ts-expect-error revalidating requires an awaitable L2 result
const incompleteRevalidation: CacheResult<string> = {value: 'old', state: 'revalidating'};
// @ts-expect-error a fresh result cannot carry a background check
const unexpectedRevalidation: CacheResult<string> = {value: 'fresh', state: 'fresh', revalidation: Promise.resolve({value: 'new', state: 'fresh'})};
