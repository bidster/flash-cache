import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { IORedisStore } from './ioredis-store';

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
      value: {name: 'Igor'},
      time: 1,
      staleAt: 2,
      expAt: 3,
    });

    const entry = await store.get('user:42');

    expect(entry).toEqual({
      value: {name: 'Igor'},
      time: 1,
      staleAt: 2,
      expAt: 3,
    });
  });
});
