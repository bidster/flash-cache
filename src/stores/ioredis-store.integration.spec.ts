import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IORedisStore } from './ioredis-store';

describe('IORedisStore integration', () => {
    let container: StartedTestContainer;
    let client: Redis;
    let store: IORedisStore<{ name: string }>;

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

        store = new IORedisStore<{ name: string }>(client);
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
});
