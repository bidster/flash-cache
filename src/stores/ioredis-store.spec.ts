import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { IORedisStore, type JsonValue } from './ioredis-store';
import { FlashCache, MapStore } from '../index';

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
            staleAt: 2,
            expAt: 3,
        });

        const entry = await store.get('user:42');

        expect(entry).toEqual({
            value: { name: 'Igor' },
            time: 1,
            staleAt: 2,
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
            staleRatio: 1,
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
            staleRatio: 1,
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
});
