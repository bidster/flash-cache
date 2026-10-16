import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

    it('stores, loads and deletes structured values', async () => {
        const entry = {
            value: { name: 'Igor' },
            time: Date.now(),
            staleAt: Date.now() + 5_000,
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
            staleAt: now + 25,
            expAt: now + 75,
        };

        await store.set('session:1', entry);

        await expect(store.get('session:1')).resolves.toEqual(entry);

        await new Promise((resolve) => setTimeout(resolve, 150));

        await expect(store.get('session:1')).resolves.toBeUndefined();
    });
    it('stores Set values as JSON arrays in Redis and restores them through a call codec', async () => {
        const l1 = new MapStore<Set<string>>();
        const cache = new FlashCache(l1, store, { ttl: 10_000, staleRatio: 0.8, namespace: 'integration' });
        const codec = {
            serialize: (tags: Set<string>) => [...tags],
            deserialize: (tags: string[]) => new Set(tags),
        };
        const tags = new Set(['typescript', 'cache']);
        expect(await cache.getOrSet('tags', () => tags, { codec })).toBe(tags);
        expect(await store.get('flashCache:v2:integration:tags')).toMatchObject({ value: [...tags] });
        const hit = cache.getOrSet('tags', async () => new Set<string>(), { codec });
        expect(hit).toBe(tags);
        l1.clear();
        const restored = await cache.get('tags', { codec });
        expect(restored).toBeInstanceOf(Set);
        expect(restored).toEqual(tags);
        expect(l1.get('flashCache:v2:integration:tags')?.value).toBe(restored);
        await cache.set('tags', new Set(['updated']), { codec });
        l1.clear();
        expect(await cache.getOrSet('tags', () => new Set<string>(), { codec })).toEqual(new Set(['updated']));
        await cache.delete('tags');
        expect(await cache.get('tags', { codec })).toBeUndefined();
    });

    it('does not write a detached factory result into Redis', async () => {
        const cache = new FlashCache<JsonValue>(new MapStore<JsonValue>(), store, {
            ttl: 10_000,
            staleRatio: 0.8,
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
        expect(await store.get('flashCache:v2:integration:detached')).toMatchObject({ value: 'new' });
        await cache.delete('detached');
    });
});
