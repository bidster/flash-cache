import { describe, expect, it, vi } from 'vitest';
import { FlashCache, MapStore, SerializedStore } from './index';
import type { MayBeAsyncStore, StoreValue } from './index';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function setup<T>(secondary: MayBeAsyncStore<T> = new MapStore<T>(), extra = {}) {
    const primary = new MapStore<T>();
    const cache = new FlashCache(primary, secondary, { ttl: 60_000, staleRatio: 0.5, namespace: false, ...extra });
    return { cache, primary, secondary };
}

function entry<T>(value: T, state: 'fresh' | 'stale' | 'expired' = 'fresh'): StoreValue<T> {
    const time = Date.now();
    return {
        value,
        time,
        staleAt: state === 'fresh' ? time + 30_000 : time - 1,
        expAt: state === 'expired' ? time - 1 : time + 60_000,
    };
}

describe('FlashCache', () => {
    it('keeps sync misses, hits, get, set and delete synchronous', () => {
        const { cache, secondary } = setup<number>();
        const get = vi.spyOn(secondary, 'get');
        expect(cache.getOrSet('x', () => 1)).toBe(1);
        expect(cache.getOrSet('x', async () => 2)).toBe(1);
        expect(get).toHaveBeenCalledTimes(1);
        expect(cache.get('x')).toBe(1);
        expect(cache.set('x', 3)).toBeUndefined();
        expect(cache.delete('x')).toBeUndefined();
        expect(cache.get('x')).toBeUndefined();
    });

    it('shares L2, factory and pending write, publishing L1 before write completes', async () => {
        const read = deferred<StoreValue<number> | undefined>();
        const load = deferred<number>();
        const write = deferred<void>();
        const secondary = { get: vi.fn(() => read.promise), set: vi.fn(() => write.promise), delete: vi.fn() };
        const { cache } = setup(secondary);
        const started = deferred<void>();
        const factory = vi.fn(() => {
            started.resolve();
            return load.promise;
        });
        const first = cache.getOrSet('x', factory);
        const second = cache.getOrSet('x', factory);
        read.resolve(undefined);
        await started.promise;
        expect(factory).toHaveBeenCalledTimes(1);
        const third = cache.getOrSet('x', factory);
        expect(secondary.get).toHaveBeenCalledTimes(1);
        load.resolve(4);
        await Promise.resolve();
        expect(cache.getOrSet('x', factory)).toBe(4);
        let completed = false;
        void Promise.resolve(first).then(() => {
            completed = true;
        });
        await Promise.resolve();
        expect(completed).toBe(false);
        write.resolve();
        expect(await Promise.all([first, second, third])).toEqual([4, 4, 4]);
    });

    it.each(['l1', 'l2'] as const)('returns stale %s before refresh and does not repeat L2 reads', async (source) => {
        const l2 = new MapStore<number>();
        const { cache, primary } = setup(l2);
        (source === 'l1' ? primary : l2).set('x', entry(1, 'stale'));
        const load = deferred<number>();
        const factory = vi.fn(() => load.promise);
        const read = vi.spyOn(l2, 'get');
        expect(cache.getOrSet('x', factory)).toBe(1);
        expect(cache.getOrSet('x', factory)).toBe(1);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(1);
        load.resolve(2);
        await load.promise;
        expect(cache.get('x')).toBe(2);
    });

    it('returns async stale L2 without waiting for factory and preserves its timestamps', async () => {
        const stale = entry(1, 'stale');
        const load = deferred<number>();
        const secondary = { get: vi.fn(async () => stale), set: vi.fn(), delete: vi.fn() };
        const { cache, primary } = setup(secondary);
        expect(await cache.getOrSet('x', () => load.promise)).toBe(1);
        expect(primary.get('x')).toBe(stale);
        load.resolve(2);
        await load.promise;
        expect(cache.get('x')).toBe(2);
    });

    it('gives concurrent cold readers stale L2 while one factory remains pending', async () => {
        const read = deferred<StoreValue<number> | undefined>();
        const load = deferred<number>();
        const { cache } = setup<number>({ get: () => read.promise, set: vi.fn(), delete: vi.fn() });
        const factory = vi.fn(() => load.promise);
        const first = cache.getOrSet('x', factory);
        const second = cache.getOrSet('x', factory);
        read.resolve(entry(1, 'stale'));
        expect(await first).toBe(1);
        expect(await second).toBe(1);
        expect(factory).toHaveBeenCalledTimes(1);
        load.resolve(2);
        await load.promise;
        expect(cache.get('x')).toBe(2);
    });

    it('waits for the shared refresh when stale expires', async () => {
        const { cache, primary, secondary } = setup<number>();
        const stale = entry(1, 'stale');
        primary.set('x', stale);
        secondary.set('x', stale);
        const load = deferred<number>();
        const factory = vi.fn(() => load.promise);
        expect(cache.getOrSet('x', factory)).toBe(1);
        stale.expAt = 0;
        const waiting = cache.getOrSet('x', factory);
        expect(waiting).toBeInstanceOf(Promise);
        load.resolve(2);
        expect(await waiting).toBe(2);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('uses fresh L2 without factory and never serves expired data', () => {
        const l2 = new MapStore<number>();
        const { cache } = setup(l2);
        l2.set('x', entry(1));
        l2.set('old', entry(2, 'expired'));
        const factory = vi.fn(() => 3);
        expect(cache.getOrSet('x', factory)).toBe(1);
        expect(factory).not.toHaveBeenCalled();
        expect(cache.get('old')).toBeUndefined();
        expect(cache.getOrSet('old', factory)).toBe(3);
    });

    it.each(['read', 'factory'] as const)(
        'delete detaches pending %s, and old cleanup keeps the new flight',
        async (stage) => {
            const oldRead = deferred<StoreValue<number> | undefined>();
            const oldLoad = deferred<number>();
            const newLoad = deferred<number>();
            const secondary = {
                get: vi
                    .fn()
                    .mockImplementationOnce(() => (stage === 'read' ? oldRead.promise : undefined))
                    .mockReturnValue(undefined),
                set: vi.fn(),
                delete: vi.fn(),
            };
            const { cache, primary } = setup<number>(secondary);
            const old = cache.getOrSet('x', () => oldLoad.promise);
            cache.delete('x');
            const factory = vi.fn(() => newLoad.promise);
            const next = cache.getOrSet('x', factory);
            if (stage === 'read') oldRead.resolve(entry(1));
            else oldLoad.resolve(1);
            expect(await old).toBe(1);
            expect(primary.has('x')).toBe(false);
            expect(secondary.set).not.toHaveBeenCalled();
            const joined = cache.getOrSet('x', factory);
            expect(factory).toHaveBeenCalledTimes(1);
            newLoad.resolve(2);
            expect(await next).toBe(2);
            expect(await joined).toBe(2);
            expect(primary.get('x')?.value).toBe(2);
        },
    );

    it.each(['resolve', 'reject'] as const)(
        'keeps the new flight when a detached L2 write ends with %s',
        async (outcome) => {
            const oldWrite = deferred<void>();
            const newLoad = deferred<number>();
            const onError = vi.fn();
            const secondary = {
                get: vi.fn(() => undefined),
                set: vi.fn().mockImplementationOnce(() => oldWrite.promise),
                delete: vi.fn(),
            };
            const { cache, primary } = setup<number>(secondary, { onError });
            const old = cache.getOrSet('x', () => 1);
            expect(primary.get('x')?.value).toBe(1);
            expect(secondary.set).toHaveBeenCalledTimes(1);
            cache.delete('x');
            const factory = vi.fn(() => newLoad.promise);
            const next = cache.getOrSet('x', factory);

            const failure = new Error('old write');
            if (outcome === 'reject') oldWrite.reject(failure);
            else oldWrite.resolve();
            expect(await old).toBe(1);
            expect(primary.has('x')).toBe(false);
            const joined = cache.getOrSet('x', factory);
            expect(factory).toHaveBeenCalledTimes(1);
            expect(secondary.get).toHaveBeenCalledTimes(2);
            expect(secondary.set).toHaveBeenCalledTimes(1);

            newLoad.resolve(2);
            expect(await Promise.all([next, joined])).toEqual([2, 2]);
            expect(primary.get('x')?.value).toBe(2);
            expect(secondary.set).toHaveBeenCalledTimes(2);
            expect(secondary.set).toHaveBeenLastCalledWith('x', expect.objectContaining({ value: 2 }));
            if (outcome === 'reject') {
                expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { key: 'x', operation: 'l2.set' });
            } else expect(onError).not.toHaveBeenCalled();
        },
    );

    it.each(['get', 'getOrSet'] as const)('set prevents publication of a late %s L2 read', async (method) => {
        const read = deferred<StoreValue<number> | undefined>();
        const secondary = { get: () => read.promise, set: vi.fn(), delete: vi.fn() };
        const { cache } = setup(secondary);
        const old = method === 'get' ? cache.get('x') : cache.getOrSet('x', () => 0);
        cache.set('x', 2);
        read.resolve(entry(1));
        expect(await old).toBe(1);
        expect(cache.get('x')).toBe(2);
        expect(secondary.set).toHaveBeenCalledTimes(1);
    });

    it('set prevents publication of a late factory result', async () => {
        const { cache, secondary } = setup<number>();
        const load = deferred<number>();
        const old = cache.getOrSet('x', () => load.promise);
        cache.set('x', 2);
        load.resolve(1);
        expect(await old).toBe(1);
        expect(cache.get('x')).toBe(2);
        expect(secondary.get('x')).toMatchObject({ value: 2 });
    });

    it.each([false, true])('reports L2 failures and returns factory data (async=%s)', async (asyncStore) => {
        const failure = new Error('offline');
        const fail = () => {
            if (asyncStore) return Promise.reject(failure);
            throw failure;
        };
        const onError = vi.fn<(error: unknown, context: unknown) => void>(() => {
            throw new Error('hook');
        });
        const { cache } = setup<number>({ get: fail, set: fail, delete: fail }, { onError });
        expect(await cache.getOrSet('x', () => 1)).toBe(1);
        expect(onError.mock.calls.map((call) => call[1])).toEqual([
            { key: 'x', operation: 'l2.get' },
            { key: 'x', operation: 'l2.set' },
        ]);
        expect(await cache.get('missing')).toBeUndefined();
        if (asyncStore) await expect(cache.delete('x')).rejects.toBe(failure);
        else expect(() => cache.delete('x')).toThrow(failure);
    });

    it.each([
        { mutation: 'set', asyncRead: false },
        { mutation: 'set', asyncRead: true },
        { mutation: 'delete', asyncRead: false },
        { mutation: 'delete', asyncRead: true },
    ] as const)(
        'detaches the load when onError calls $mutation (asyncRead=$asyncRead)',
        async ({ mutation, asyncRead }) => {
            const failure = new Error('read');
            const load = deferred<number>();
            const started = deferred<void>();
            const secondary = {
                get: vi.fn(() => {
                    if (asyncRead) return Promise.reject(failure);
                    throw failure;
                }),
                set: vi.fn(),
                delete: vi.fn(),
            };
            const onError = vi.fn(() => {
                if (mutation === 'set') cache.set('x', 9);
                else cache.delete('x');
            });
            const { cache, primary } = setup<number>(secondary, { onError });
            const factory = vi.fn(() => {
                started.resolve();
                return load.promise;
            });
            const old = cache.getOrSet('x', factory);
            await started.promise;
            expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { key: 'x', operation: 'l2.get' });
            expect(factory).toHaveBeenCalledTimes(1);

            load.resolve(2);
            expect(await old).toBe(2);
            expect(primary.get('x')?.value).toBe(mutation === 'set' ? 9 : undefined);
            expect(secondary.delete).toHaveBeenCalledTimes(mutation === 'delete' ? 1 : 0);
            if (mutation === 'set') {
                expect(secondary.set).toHaveBeenCalledExactlyOnceWith('x', expect.objectContaining({ value: 9 }));
            } else expect(secondary.set).not.toHaveBeenCalled();
        },
    );

    it.each([false, true])(
        'reports background failure once and leaves expiry unchanged (async=%s)',
        async (asyncFactory) => {
            const onError = vi.fn();
            const { cache, primary, secondary } = setup<number>(undefined, { onError });
            const stale = entry(1, 'stale');
            primary.set('x', stale);
            secondary.set('x', stale);
            const failure = new Error('source');
            const factory = () => {
                if (asyncFactory) return Promise.reject(failure);
                throw failure;
            };
            expect(cache.getOrSet('x', factory)).toBe(1);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { key: 'x', operation: 'refresh' });
            expect(primary.get('x')?.expAt).toBe(stale.expAt);
        },
    );

    it('propagates foreground factory errors and permits retry', async () => {
        const onError = vi.fn();
        const { cache } = setup<number>(undefined, { onError });
        await expect(
            cache.getOrSet('x', async () => {
                throw new Error('source');
            }),
        ).rejects.toThrow('source');
        expect(onError).not.toHaveBeenCalled();
        expect(cache.getOrSet('x', () => 2)).toBe(2);
    });

    it('shares references by default and clones only per reader when configured', async () => {
        const original = { nested: { value: 1 } };
        const shared = setup<typeof original>().cache;
        expect(shared.getOrSet('x', () => original)).toBe(original);
        const cloneValue = vi.fn(structuredClone);
        const { cache, primary } = setup<typeof original>(undefined, { cloneValue });
        const load = deferred<typeof original>();
        const first = cache.getOrSet('x', () => load.promise);
        const second = cache.getOrSet('x', () => load.promise);
        load.resolve(original);
        const [a, b] = await Promise.all([first, second]);
        expect(a).not.toBe(b);
        a.nested.value = 9;
        expect(b.nested.value).toBe(1);
        expect(primary.get('x')?.value).toBe(original);
        expect(cloneValue).toHaveBeenCalledTimes(2);
        cache.set('y', original);
        expect(cloneValue).toHaveBeenCalledTimes(2);
        expect(cache.get('y')).not.toBe(original);
    });

    it('keeps clone errors local to readers sharing a load', async () => {
        const cloneValue = vi
            .fn((value: number) => value)
            .mockImplementationOnce(() => {
                throw new Error('clone');
            });
        const { cache } = setup<number>(undefined, { cloneValue });
        const load = deferred<number>();
        const first = cache.getOrSet('x', () => load.promise);
        const second = cache.getOrSet('x', () => load.promise);
        load.resolve(1);
        const results = await Promise.allSettled([first, second]);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: 1 }]);
        expect(cache.get('x')).toBe(1);
    });

    it('stores codec values separately and preserves class methods with a custom clone', () => {
        class User {
            constructor(readonly name: string) {}
            greeting() {
                return `Hello ${this.name}`;
            }
        }
        const raw = new MapStore<string>();
        const secondary = new SerializedStore(raw, {
            serialize: (user: User) => user.name,
            deserialize: (name) => new User(name),
        });
        const { cache, primary } = setup(secondary, { cloneValue: (user: User) => new User(user.name) });
        const original = new User('Igor');
        expect((cache.getOrSet('x', () => original) as User).greeting()).toBe('Hello Igor');
        primary.clear();
        const read = cache.get('x') as User;
        expect(read.greeting()).toBe('Hello Igor');
        expect(read).not.toBe(original);
        expect(raw.get('x')?.value).toBe('Igor');
    });

    it.each([false, true])('handles codec errors as L2 errors (async=%s)', async (asyncStore) => {
        const raw = new MapStore<string>();
        raw.set('x', entry('bad'));
        const underlying = asyncStore
            ? {
                  get: async (key: string) => raw.get(key),
                  set: async (key: string, value: StoreValue<string>) => {
                      raw.set(key, value);
                  },
                  delete: async (key: string) => {
                      raw.delete(key);
                  },
              }
            : raw;
        const decodeError = new Error('decode');
        const encodeError = new Error('encode');
        const secondary = new SerializedStore<number, string>(underlying, {
            serialize: () => {
                throw encodeError;
            },
            deserialize: () => {
                throw decodeError;
            },
        });
        const onError = vi.fn();
        const { cache, primary } = setup(secondary, { onError });
        const factory = vi.fn(() => 2);
        expect(await cache.getOrSet('x', factory)).toBe(2);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(primary.get('x')?.value).toBe(2);
        expect(onError.mock.calls).toEqual([
            [decodeError, { key: 'x', operation: 'l2.get' }],
            [encodeError, { key: 'x', operation: 'l2.set' }],
        ]);
        primary.clear();
        onError.mockClear();
        expect(await cache.get('x')).toBeUndefined();
        expect(onError).toHaveBeenCalledExactlyOnceWith(decodeError, { key: 'x', operation: 'l2.get' });
    });

    it('does not swallow a factory error after an L2 error', async () => {
        const l2Error = new Error('store');
        const factoryError = new Error('factory');
        const onError = vi.fn();
        const { cache } = setup<number>(
            {
                get: async () => {
                    throw l2Error;
                },
                set: vi.fn(),
                delete: vi.fn(),
            },
            { onError },
        );
        await expect(
            cache.getOrSet('x', () => {
                throw factoryError;
            }),
        ).rejects.toBe(factoryError);
        expect(onError).toHaveBeenCalledExactlyOnceWith(l2Error, { key: 'x', operation: 'l2.get' });
    });

    it.each(['get', 'getOrSet'] as const)('rechecks fresh L1 after %s receives L2', async (method) => {
        for (const outcome of ['fresh', 'stale', 'miss', 'error'] as const) {
            const read = deferred<StoreValue<number> | undefined>();
            const onError = vi.fn();
            const secondary = { get: () => read.promise, set: vi.fn(), delete: vi.fn() };
            const { cache, primary } = setup<number>(secondary, { onError });
            const factory = vi.fn(() => 3);
            const first = method === 'get' ? cache.get('x') : cache.getOrSet('x', factory);
            const joined = method === 'getOrSet' ? cache.getOrSet('x', factory) : undefined;
            // Имитируем публикацию другого читателя, которая не вызывает detach.
            const newer = entry(2);
            primary.set('x', newer);
            if (outcome === 'error') read.reject(new Error('L2'));
            else read.resolve(outcome === 'miss' ? undefined : entry(1, outcome));
            expect(await first).toBe(2);
            if (joined !== undefined) expect(await joined).toBe(2);
            expect(primary.get('x')).toBe(newer);
            expect(factory).not.toHaveBeenCalled();
            expect(secondary.set).not.toHaveBeenCalled();
            expect(onError).toHaveBeenCalledTimes(outcome === 'error' ? 1 : 0);
        }
    });

    it('does not let a late direct get overwrite a completed factory result', async () => {
        const oldRead = deferred<StoreValue<number> | undefined>();
        const raw = new MapStore<number>();
        const secondary = {
            get: vi
                .fn()
                .mockImplementationOnce(() => oldRead.promise)
                .mockImplementation((key: string) => raw.get(key)),
            set: (key: string, value: StoreValue<number>) => raw.set(key, value),
            delete: (key: string) => raw.delete(key),
        };
        const { cache, primary } = setup<number>(secondary);
        const pending = cache.get('x');
        expect(cache.getOrSet('x', () => 2)).toBe(2);
        oldRead.resolve(entry(1));
        expect(await pending).toBe(2);
        expect(primary.get('x')?.value).toBe(2);
        expect(raw.get('x')?.value).toBe(2);
    });

    it('does not prefer stale or expired L1 over a fresh L2 response', async () => {
        for (const state of ['stale', 'expired'] as const) {
            const read = deferred<StoreValue<number> | undefined>();
            const { cache, primary } = setup<number>({ get: () => read.promise, set: vi.fn(), delete: vi.fn() });
            const factory = vi.fn(() => 3);
            const pending = cache.getOrSet('x', factory);
            primary.set('x', entry(1, state));
            read.resolve(entry(2));
            expect(await pending).toBe(2);
            expect(primary.get('x')?.value).toBe(2);
            expect(factory).not.toHaveBeenCalled();
        }
    });

    it('finishes a synchronous failed stale refresh before an immediate retry', () => {
        const raw = new MapStore<number>();
        raw.set('x', entry(1, 'stale'));
        const onError = vi.fn();
        const { cache } = setup<number>(raw, { onError });
        const failure = new Error('source');
        expect(
            cache.getOrSet('x', () => {
                throw failure;
            }),
        ).toBe(1);
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { key: 'x', operation: 'refresh' });
        const retry = vi.fn(() => 2);
        expect(cache.getOrSet('x', retry)).toBe(1);
        expect(retry).toHaveBeenCalledTimes(1);
        expect(cache.get('x')).toBe(2);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('serves async stale L2 to joined readers when a synchronous refresh throws, then retries', async () => {
        const stale = entry(1, 'stale');
        const onError = vi.fn();
        const { cache } = setup<number>({ get: async () => stale, set: vi.fn(), delete: vi.fn() }, { onError });
        const failure = new Error('source');
        const factory = vi.fn(() => {
            throw failure;
        });
        const first = cache.getOrSet('x', factory);
        const joined = cache.getOrSet('x', factory);
        expect(await Promise.all([first, joined])).toEqual([1, 1]);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { key: 'x', operation: 'refresh' });

        const retry = vi.fn(() => 2);
        expect(cache.getOrSet('x', retry)).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(retry).toHaveBeenCalledTimes(1);
        expect(cache.get('x')).toBe(2);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('shares refresh failure with expired readers after serving stale L2', async () => {
        const stale = entry(1, 'stale');
        const read = deferred<StoreValue<number> | undefined>();
        const load = deferred<number>();
        const onError = vi.fn();
        const { cache } = setup<number>({ get: () => read.promise, set: vi.fn(), delete: vi.fn() }, { onError });
        const factory = vi.fn(() => load.promise);
        const first = cache.getOrSet('x', factory);
        const second = cache.getOrSet('x', factory);
        read.resolve(stale);
        expect(await Promise.all([first, second])).toEqual([1, 1]);
        stale.expAt = 0;
        const waiting = cache.getOrSet('x', factory);
        const failure = new Error('refresh');
        const rejected = expect(waiting).rejects.toBe(failure);
        load.reject(failure);
        await rejected;
        expect(factory).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { key: 'x', operation: 'refresh' });
    });

    it('keeps the new flight registered when an old detached refresh fails', async () => {
        const oldLoad = deferred<number>();
        const nextLoad = deferred<number>();
        const onError = vi.fn();
        const { cache, primary, secondary } = setup<number>(undefined, { onError });
        primary.set('x', entry(1, 'stale'));
        expect(cache.getOrSet('x', () => oldLoad.promise)).toBe(1);
        cache.delete('x');
        const factory = vi.fn(() => nextLoad.promise);
        const next = cache.getOrSet('x', factory);
        const failure = new Error('old refresh');
        oldLoad.reject(failure);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const joined = cache.getOrSet('x', factory);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(primary.has('x')).toBe(false);
        nextLoad.resolve(2);
        expect(await Promise.all([next, joined])).toEqual([2, 2]);
        expect(secondary.get('x')).toMatchObject({ value: 2 });
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { key: 'x', operation: 'refresh' });
    });

    it('keeps stale refresh in flight until the L2 write completes', async () => {
        const stale = entry(1, 'stale');
        const written = deferred<void>();
        const secondary = { get: vi.fn(() => stale), set: vi.fn(() => written.promise), delete: vi.fn() };
        const { cache, primary } = setup<number>(secondary);
        const factory = vi.fn(() => 2);
        expect(cache.getOrSet('x', factory)).toBe(1);
        expect(cache.get('x')).toBe(2);
        // После истечения обеих доступных записей читатель должен ждать ту же запись L2.
        stale.expAt = 0;
        primary.get('x')!.expAt = 0;
        const waiting = cache.getOrSet('x', factory);
        let completed = false;
        void Promise.resolve(waiting).then(() => {
            completed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(completed).toBe(false);
        expect(secondary.get).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledTimes(1);
        written.resolve();
        expect(await waiting).toBe(2);
    });

    it('validates options, rejects undefined and permits null', () => {
        expect(() => setup(undefined, { ttl: 0 })).toThrow('ttl');
        expect(() => setup(undefined, { staleRatio: 2 })).toThrow('staleRatio');
        const { cache } = setup<number | null>();
        expect(() => cache.getOrSet('x', () => 1, { customTtl: 0 })).toThrow('customTtl');
        expect(() => cache.getOrSet('x', () => undefined as never)).toThrow('undefined');
        expect(cache.getOrSet('x', () => null)).toBeNull();
    });
});
