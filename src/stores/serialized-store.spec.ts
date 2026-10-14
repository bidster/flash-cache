import { describe, expect, it, vi } from 'vitest';
import { MapStore, SerializedStore } from '../index';

describe('SerializedStore', () => {
    it.each([false, true])('preserves metadata and underlying sync/async behavior (async=%s)', async (asyncStore) => {
        const raw = new MapStore<string>();
        const underlying = asyncStore
            ? {
                  get: async (key: string) => raw.get(key),
                  set: async (key: string, value: Parameters<typeof raw.set>[1]) => {
                      raw.set(key, value);
                  },
                  delete: async (key: string) => {
                      raw.delete(key);
                  },
              }
            : raw;
        const codec = { serialize: vi.fn(String), deserialize: vi.fn(Number) };
        const store = new SerializedStore<number, string>(underlying, codec);
        expect(await store.get('missing')).toBeUndefined();
        expect(codec.deserialize).not.toHaveBeenCalled();
        const value = { value: 42, time: 1, staleAt: 2, expAt: 3 };
        const write = store.set('x', value);
        expect(write instanceof Promise).toBe(asyncStore);
        await write;
        expect(raw.get('x')).toEqual({ ...value, value: '42' });
        const read = store.get('x');
        expect(read instanceof Promise).toBe(asyncStore);
        expect(await read).toEqual(value);
        const removed = store.delete('x');
        expect(removed instanceof Promise).toBe(asyncStore);
        await removed;
        expect(raw.has('x')).toBe(false);
    });

    it.each(['serialize', 'deserialize'] as const)('passes the original %s error through', (operation) => {
        const failure = new Error('bad data');
        const raw = new MapStore<string>();
        raw.set('x', { value: '1', time: 1, staleAt: 2, expAt: 3 });
        const store = new SerializedStore<number, string>(raw, {
            serialize: (value) => {
                if (operation === 'serialize') throw failure;
                return String(value);
            },
            deserialize: (value) => {
                if (operation === 'deserialize') throw failure;
                return Number(value);
            },
        });
        expect(() =>
            operation === 'serialize' ? store.set('x', { value: 1, time: 1, staleAt: 2, expAt: 3 }) : store.get('x'),
        ).toThrow(failure);
    });
});
