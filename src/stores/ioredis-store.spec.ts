import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { IORedisStore, type JsonValue } from './ioredis-store';
import { FlashCache, MapStore } from '../index';

class WrappedIORedisStore extends IORedisStore {
    constructor(
        client: Redis,
        private readonly execute: <T>(command: () => Promise<T>) => Promise<T>,
    ) {
        super(client);
    }

    protected override read(key: string): Promise<string | null> {
        return this.execute(() => super.read(key));
    }

    protected override write(key: string, raw: string, expAt: number): Promise<void> {
        return this.execute(() => super.write(key, raw, expAt));
    }

    protected override remove(key: string): Promise<void> {
        return this.execute(() => super.remove(key));
    }
}

describe('IORedisStore', () => {
    it('stores JSON values without restoring domain-specific types', async () => {
        const values = new Map<string, string>();
        const client = {
            get: vi.fn(async (key: string) => values.get(key) ?? null),
            set: vi.fn(async (key: string, value: string) => {
                values.set(key, value);
                return 'OK';
            }),
            del: vi.fn(async (key: string) => Number(values.delete(key))),
        } as unknown as Redis;
        const store = new IORedisStore(client);

        await store.set('user:42', {
            value: { name: 'Igor' },
            time: 1,
            expAt: 3,
        });

        const entry = await store.get('user:42');

        expect(entry).toEqual({
            value: { name: 'Igor' },
            time: 1,
            expAt: 3,
        });
    });
    it('reports malformed JSON and continues through the factory', async () => {
        const onError = vi.fn();
        const client = {
            get: vi.fn(async () => '{broken'),
            set: vi.fn(async () => 'OK'),
            del: vi.fn(),
        } as unknown as Redis;
        const cache = new FlashCache<JsonValue>(new MapStore(), new IORedisStore(client), {
            ttl: 1000,
            staleAfter: 1000,
            namespace: false,
            onError,
        });
        const factory = vi.fn(() => 42);
        expect(await cache.getOrSet('x', factory)).toBe(42);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(SyntaxError), { key: 'x', operation: 'l2.get' });
    });

    it('retains L1 when JSON serialization fails before the Redis write', async () => {
        const onError = vi.fn();
        const client = { get: vi.fn(async () => null), set: vi.fn(), del: vi.fn() } as unknown as Redis;
        const primary = new MapStore<JsonValue>();
        const cache = new FlashCache<JsonValue>(primary, new IORedisStore(client), {
            ttl: 1000,
            staleAfter: 1000,
            namespace: false,
            onError,
        });
        const value: { [key: string]: JsonValue } = { id: 1 };
        value.self = value;
        expect(await cache.getOrSet('x', () => value)).toBe(value);
        expect(primary.get('x')?.value).toBe(value);
        expect(client.set).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(TypeError), { key: 'x', operation: 'l2.set' });
    });

    it('lets subclasses wrap Redis commands while inheriting JSON conversion and absolute expiry', async () => {
        const entry = { value: { id: 42 }, time: 1, expAt: 3 };
        const client = {
            get: vi.fn().mockResolvedValueOnce(JSON.stringify(entry)).mockResolvedValueOnce(null),
            set: vi.fn().mockResolvedValue('OK'),
            del: vi.fn().mockResolvedValue(1),
        };
        const execute = vi.fn(<T>(command: () => Promise<T>) => command()) as <T>(
            command: () => Promise<T>,
        ) => Promise<T>;
        const store = new WrappedIORedisStore(client as unknown as Redis, execute);

        await expect(store.get('key')).resolves.toEqual(entry);
        await expect(store.get('missing')).resolves.toBeUndefined();
        await expect(store.set('key', entry)).resolves.toBeUndefined();
        await expect(store.delete('key')).resolves.toBeUndefined();

        expect(execute).toHaveBeenCalledTimes(4);
        expect(client.get.mock.calls).toEqual([['key'], ['missing']]);
        expect(client.set).toHaveBeenCalledExactlyOnceWith('key', JSON.stringify(entry), 'PXAT', entry.expAt);
        expect(client.del).toHaveBeenCalledExactlyOnceWith('key');
    });

    it.each(['get', 'set', 'delete'] as const)(
        'lets the wrapper reject %s before accessing Redis',
        async (operation) => {
            const error = new Error('Circuit is open');
            const client = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
            const store = new WrappedIORedisStore(client as unknown as Redis, () => Promise.reject(error));
            const entry = { value: 42, time: 1, expAt: 3 };

            await expect(operation === 'set' ? store.set('key', entry) : store[operation]('key')).rejects.toBe(error);
            expect(client.get).not.toHaveBeenCalled();
            expect(client.set).not.toHaveBeenCalled();
            expect(client.del).not.toHaveBeenCalled();
        },
    );

    it.each(['get', 'set', 'delete'] as const)('passes %s Redis failures through the wrapper', async (operation) => {
        const cause = new Error('Redis unavailable');
        const error = new Error('Wrapped Redis failure', { cause });
        const client = {
            get: vi.fn().mockRejectedValue(cause),
            set: vi.fn().mockRejectedValue(cause),
            del: vi.fn().mockRejectedValue(cause),
        };
        const onFailure = vi.fn();
        const store = new WrappedIORedisStore(client as unknown as Redis, async (command) => {
            try {
                return await command();
            } catch (caught) {
                onFailure(caught);
                throw error;
            }
        });
        const entry = { value: 42, time: 1, expAt: 3 };

        await expect(operation === 'set' ? store.set('key', entry) : store[operation]('key')).rejects.toBe(error);
        expect(onFailure).toHaveBeenCalledExactlyOnceWith(cause);
    });

    it('parses JSON after the wrapped read succeeds', async () => {
        const onSuccess = vi.fn();
        const onFailure = vi.fn();
        const client = { get: vi.fn().mockResolvedValue('{invalid') };
        const store = new WrappedIORedisStore(client as unknown as Redis, async (command) => {
            try {
                const result = await command();
                onSuccess();
                return result;
            } catch (error) {
                onFailure(error);
                throw error;
            }
        });

        await expect(store.get('key')).rejects.toBeInstanceOf(SyntaxError);
        expect(onSuccess).toHaveBeenCalledOnce();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('serializes JSON before entering the wrapped write', async () => {
        const execute = vi.fn(<T>(command: () => Promise<T>) => command()) as <T>(
            command: () => Promise<T>,
        ) => Promise<T>;
        const client = { set: vi.fn() };
        const store = new WrappedIORedisStore(client as unknown as Redis, execute);
        const error = new TypeError('Cannot serialize');
        const entry = {
            value: 42,
            time: 1,
            expAt: 3,
            toJSON() {
                throw error;
            },
        };

        await expect(store.set('key', entry)).rejects.toBe(error);
        expect(execute).not.toHaveBeenCalled();
        expect(client.set).not.toHaveBeenCalled();
    });
});
