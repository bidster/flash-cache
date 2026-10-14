import { describe, expect, it, vi } from 'vitest';
import { FlashCache, MapStore } from './index';

describe('reader cloning', () => {
    it.each(['fresh-l1', 'stale-l1', 'fresh-l2', 'stale-l2', 'miss'])(
        'clones once for a reader from %s',
        async (state) => {
            const original = { nested: { value: 1 } };
            const primary = new MapStore<typeof original>();
            const secondary = new MapStore<typeof original>();
            const cloneValue = vi.fn((value: typeof original) => structuredClone(value));
            const cache = new FlashCache(primary, secondary, {
                ttl: 60_000,
                staleRatio: 0.5,
                namespace: false,
            });
            if (state !== 'miss') {
                const time = Date.now();
                const entry = {
                    value: original,
                    time,
                    staleAt: state.startsWith('stale') ? 0 : time + 30_000,
                    expAt: time + 60_000,
                };
                (state.endsWith('l1') ? primary : secondary).set('x', entry);
            }
            const response = cache.getOrSet('x', () => original, { cloneValue });
            expect(response).not.toBeInstanceOf(Promise);
            const result = await response;
            result.nested.value = 2;
            expect(original.nested.value).toBe(1);
            expect(cloneValue).toHaveBeenCalledTimes(1);
            expect(primary.get('x')?.value).toBe(original);
        },
    );

    it('does not clone a miss from get or input values from set', () => {
        const cloneValue = vi.fn((value: { value: number }) => structuredClone(value));
        const primary = new MapStore<{ value: number }>();
        const cache = new FlashCache(primary, new MapStore<{ value: number }>(), {
            ttl: 1000,
            staleRatio: 1,
            namespace: false,
        });
        expect(cache.get('missing', { cloneValue })).toBeUndefined();
        const original = { value: 1 };
        cache.set('x', original);
        expect(cloneValue).not.toHaveBeenCalled();
        original.value = 2;
        expect(primary.get('x')?.value.value).toBe(2);
        expect(cache.get('x', { cloneValue })).toEqual({ value: 2 });
        expect(cloneValue).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        'uses each reader clone policy in one singleflight (firstClones=%s)',
        async (firstClones) => {
            const original = { value: 1 };
            const primary = new MapStore<typeof original>();
            const secondary = new MapStore<typeof original>();
            const cache = new FlashCache(primary, secondary, { ttl: 60_000, staleRatio: 0.5 });
            let resolve!: (value: typeof original) => void;
            const pending = new Promise<typeof original>((done) => {
                resolve = done;
            });
            const factory = vi.fn(() => pending);
            const firstClone = vi.fn((value: typeof original) => ({ ...value, value: value.value + 10 }));
            const secondClone = vi.fn((value: typeof original) => ({ ...value, value: value.value + 20 }));
            const first = cache.getOrSet('x', factory, firstClones ? { cloneValue: firstClone } : {});
            const second = cache.getOrSet('x', factory, { cloneValue: secondClone });
            const shared = cache.getOrSet('x', factory);
            resolve(original);
            const [a, b, c] = await Promise.all([first, second, shared]);
            expect(a).toEqual({ value: firstClones ? 11 : 1 });
            if (firstClones) expect(a).not.toBe(original);
            else expect(a).toBe(original);
            expect(b).toEqual({ value: 21 });
            expect(b).not.toBe(original);
            expect(c).toBe(original);
            expect(factory).toHaveBeenCalledTimes(1);
            expect(firstClone).toHaveBeenCalledTimes(firstClones ? 1 : 0);
            expect(secondClone).toHaveBeenCalledExactlyOnceWith(original);
            expect(cache.get('x')).toBe(original);
            expect(cache.getOrSet('x', factory)).toBe(original);
        },
    );

    it('clones stale async L2 separately for joined readers before refresh completes', async () => {
        const original = { value: 1 };
        const time = Date.now();
        const stale = { value: original, time, staleAt: 0, expAt: time + 60_000 };
        let resolve!: (value: typeof original) => void;
        const pending = new Promise<typeof original>((done) => {
            resolve = done;
        });
        const factory = vi.fn(() => pending);
        const cache = new FlashCache(
            new MapStore<typeof original>(),
            {
                get: async () => stale,
                set: vi.fn(),
                delete: vi.fn(),
            },
            { ttl: 60_000, staleRatio: 0.5 },
        );
        const cloneValue = vi.fn((value: typeof original) => ({ ...value }));
        const first = cache.getOrSet('x', factory);
        const joined = cache.getOrSet('x', factory, { cloneValue });
        expect(await first).toBe(original);
        const copy = await joined;
        expect(copy).toEqual(original);
        expect(copy).not.toBe(original);
        expect(cloneValue).toHaveBeenCalledExactlyOnceWith(original);
        expect(factory).toHaveBeenCalledTimes(1);
        const updated = { value: 2 };
        resolve(updated);
        await pending;
        expect(cache.get('x')).toBe(updated);
        expect(cloneValue).toHaveBeenCalledTimes(1);
    });

    it.each(['fresh-l1', 'stale-l1', 'fresh-l2', 'stale-l2', 'async-l2'])(
        'clones a direct get from %s',
        async (state) => {
            const original = { value: 1 };
            const primary = new MapStore<typeof original>();
            const raw = new MapStore<typeof original>();
            const secondary =
                state === 'async-l2'
                    ? {
                          get: async (key: string) => raw.get(key),
                          set: (key: string, value: Parameters<typeof raw.set>[1]) => raw.set(key, value),
                          delete: (key: string) => raw.delete(key),
                      }
                    : raw;
            const cache = new FlashCache(primary, secondary, { ttl: 60_000, staleRatio: 0.5, namespace: false });
            const time = Date.now();
            (state.endsWith('l1') ? primary : raw).set('x', {
                value: original,
                time,
                staleAt: state.startsWith('stale') ? 0 : time + 30_000,
                expAt: time + 60_000,
            });
            const cloneValue = vi.fn((value: typeof original) => ({ ...value }));
            const response = cache.get('x', { cloneValue });
            if (state === 'async-l2') expect(response).toBeInstanceOf(Promise);
            else expect(response).not.toBeInstanceOf(Promise);
            expect(await response).toEqual(original);
            expect(await response).not.toBe(original);
            expect(cloneValue).toHaveBeenCalledExactlyOnceWith(original);
            expect(cache.get('x')).toBe(original);
        },
    );

    it.each([false, true])('keeps direct get clone errors local (asyncRead=%s)', async (asyncRead) => {
        const original = { value: 1 };
        const time = Date.now();
        const stored = { value: original, time, staleAt: time + 30_000, expAt: time + 60_000 };
        const onError = vi.fn();
        const cache = new FlashCache(
            new MapStore<typeof original>(),
            {
                get: () => (asyncRead ? Promise.resolve(stored) : stored),
                set: vi.fn(),
                delete: vi.fn(),
            },
            { ttl: 60_000, staleRatio: 0.5, onError },
        );
        const failure = new Error('clone');
        const read = () =>
            cache.get('x', {
                cloneValue: () => {
                    throw failure;
                },
            });
        if (asyncRead) await expect(read()).rejects.toBe(failure);
        else expect(read).toThrow(failure);
        expect(cache.get('x')).toBe(original);
        expect(onError).not.toHaveBeenCalled();
    });

    it('keeps class instances and non-cloneable values intact by default', () => {
        class User {
            #name = 'Igor';
            greeting() {
                return this.#name;
            }
        }
        const original = new User();
        const cache = new FlashCache(new MapStore<User>(), new MapStore<User>(), { ttl: 1000, staleRatio: 1 });
        expect(cache.getOrSet('x', () => original)).toBe(original);
        expect((cache.get('x') as User).greeting()).toBe('Igor');
    });
});
