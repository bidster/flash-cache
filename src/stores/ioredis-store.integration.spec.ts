import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IORedisStore, type JsonValue } from './ioredis-store';
import { FlashCache, MapStore } from '../index';

describe('IORedisStore integration', () => {
    let container: StartedTestContainer;
    let client: Redis;
    let store: IORedisStore;

    beforeAll(async () => {
        container = await new GenericContainer('redis:7-alpine')
            .withExposedPorts(6379)
            .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
            .start();

        client = new Redis({
            host: container.getHost(),
            port: container.getMappedPort(6379),
            lazyConnect: false,
            maxRetriesPerRequest: 1,
        });

        store = new IORedisStore(client);
    }, 60_000);

    afterAll(async () => {
        await client?.quit();
        await container?.stop();
    }, 30_000);

    afterEach(() => vi.useRealTimers());

    it('stores, loads and deletes structured values', async () => {
        const entry = {
            value: { name: 'Igor' },
            time: Date.now(),
            expAt: Date.now() + 10_000,
        };

        await store.set('user:42', entry);

        await expect(store.get('user:42')).resolves.toEqual(entry);

        await store.delete('user:42');

        await expect(store.get('user:42')).resolves.toBeUndefined();
    });

    it('lets redis expire entries using PXAT', async () => {
        const now = Date.now();
        const entry = {
            value: { name: 'Flash' },
            time: now,
            expAt: now + 75,
        };

        await store.set('session:1', entry);

        await expect(store.get('session:1')).resolves.toEqual(entry);

        await new Promise((resolve) => setTimeout(resolve, 150));

        await expect(store.get('session:1')).resolves.toBeUndefined();
    });
    it('stores Set values as JSON arrays in Redis and restores them through a call codec', async () => {
        const l1 = new MapStore<Set<string>>();
        const cache = new FlashCache(l1, store, { ttl: 10_000, staleAfter: 8_000, namespace: 'integration' });
        const codec = {
            serialize: (tags: Set<string>) => [...tags],
            deserialize: (tags: string[]) => new Set(tags),
        };
        const tags = new Set(['typescript', 'cache']);
        expect(await cache.getOrSet('tags', () => tags, { codec })).toBe(tags);
        expect(await store.get('flashCache:v3:integration:tags')).toMatchObject({ value: [...tags] });
        const hit = cache.getOrSet('tags', async () => new Set<string>(), { codec });
        expect(hit).toBe(tags);
        l1.clear();
        const restored = await cache.get('tags', { codec });
        expect(restored).toBeInstanceOf(Set);
        expect(restored).toEqual(tags);
        expect(l1.get('flashCache:v3:integration:tags')?.value).toBe(restored);
        await cache.set('tags', new Set(['updated']), { codec });
        l1.clear();
        expect(await cache.getOrSet('tags', () => new Set<string>(), { codec })).toEqual(new Set(['updated']));
        await cache.delete('tags');
        expect(await cache.get('tags', { codec })).toBeUndefined();
    });

    it('shares a fresh Redis snapshot between independent local refresh deadlines', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const time = Date.now();
        vi.setSystemTime(time);
        const firstL1 = new MapStore<number>();
        const secondL1 = new MapStore<number>();
        const earlyTtl = vi.fn(() => 600_000);
        const laterTtl = vi.fn(() => {
            throw new Error('L2 must preserve snapshot TTL');
        });
        const earlyStale = vi.fn((ttl: number) => ttl / 10);
        const laterStale = vi.fn((ttl: number) => ttl / 5);
        const early = new FlashCache(firstL1, store, { ttl: earlyTtl, staleAfter: earlyStale, namespace: 'staggered' });
        const later = new FlashCache(secondL1, store, {
            ttl: laterTtl,
            staleAfter: laterStale,
            namespace: 'staggered',
        });
        await early.set('x', 1);
        expect(await later.getOrSet('x', () => 99)).toBe(1);
        expect(firstL1.get('flashCache:v3:staggered:x')).toMatchObject({ staleAt: time + 60_000 });
        expect(secondL1.get('flashCache:v3:staggered:x')).toMatchObject({ staleAt: time + 120_000 });
        expect(await store.get('flashCache:v3:staggered:x')).toEqual({ value: 1, time, expAt: time + 600_000 });
        vi.setSystemTime(time + 60_000);
        const firstFactory = vi.fn(() => 2);
        expect(await early.getOrSet('x', firstFactory)).toBe(1);
        await vi.waitFor(async () => {
            expect(await store.get('flashCache:v3:staggered:x')).toMatchObject({ value: 2 });
        });
        const freshSnapshot = await store.get('flashCache:v3:staggered:x');
        vi.setSystemTime(time + 120_000);
        const secondFactory = vi.fn(() => 3);
        expect(await later.getOrSet('x', secondFactory)).toBe(1);
        await vi.waitFor(() => {
            expect(later.get('x')).toBe(2);
        });
        expect(secondFactory).not.toHaveBeenCalled();
        expect(firstFactory).toHaveBeenCalledTimes(1);
        expect(earlyTtl).toHaveBeenCalledTimes(2);
        expect(laterTtl).not.toHaveBeenCalled();
        expect(earlyStale.mock.calls).toEqual([[600_000], [600_000]]);
        expect(laterStale.mock.calls).toEqual([[600_000], [600_000]]);
        expect(secondL1.get('flashCache:v3:staggered:x')).toEqual({
            value: 2,
            time: freshSnapshot!.time,
            expAt: freshSnapshot!.expAt,
            staleAt: freshSnapshot!.time + 120_000,
        });
        await early.delete('x');
    });

    it('does not write a detached factory result into Redis', async () => {
        const cache = new FlashCache<JsonValue>(new MapStore<JsonValue>(), store, {
            ttl: 10_000,
            staleAfter: 8_000,
            namespace: 'integration',
        });
        let finish!: (value: JsonValue) => void;
        let started!: () => void;
        const loading = new Promise<void>((resolve) => {
            started = resolve;
        });
        const pending = cache.getOrSet('detached', () => {
            started();
            return new Promise<JsonValue>((resolve) => {
                finish = resolve;
            });
        });
        await loading;
        await cache.set('detached', 'new');
        finish('old');
        expect(await pending).toBe('old');
        expect(await store.get('flashCache:v3:integration:detached')).toMatchObject({ value: 'new' });
        await cache.delete('detached');
    });
});
