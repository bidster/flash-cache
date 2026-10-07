import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreValue } from './flash-cache';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};

const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

// Imports must follow useFakeTimers: FlashCache captures Date.now on module load.
const setup = async (local: 'stale' | 'expired' | 'missing' = 'stale') => {
    const { FlashCache } = await import('./flash-cache');
    const { FlashMemo } = await import('./flash-memo');
    const { MapStore } = await import('./stores/map-store');
    const entry = { value: 'old', time: 0, staleAt: 4_000, expAt: 10_000 };
    const l1 = new MapStore<string>();
    if (local !== 'missing') l1.set('k', { ...entry, expAt: local === 'expired' ? 5_000 : 10_000 });
    const read = deferred<StoreValue<string> | undefined>();
    const l2 = {
        get: vi.fn(() => read.promise),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
    };
    const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
    return { entry, l1, l2, read, cache, memo: new FlashMemo(cache) };
};

describe('L2 revalidation contract', () => {
    beforeAll(() => vi.useFakeTimers());
    beforeEach(() => vi.setSystemTime(5_000));
    afterAll(() => vi.useRealTimers());

    it.each(['fresh', 'stale', 'expired', 'miss'] as const)(
        'returns an immutable revalidating snapshot before L2 returns %s', async (state) => {
            const { cache, l1, l2, entry, read } = await setup();
            const result = cache.get('k');
            expect(result).not.toBeInstanceOf(Promise);
            if (result instanceof Promise || result.state !== 'revalidating') throw new Error('Expected revalidating');
            expect(result.value).toBe('old');
            expect(l2.get).toHaveBeenCalledTimes(1);
            const remote = state === 'miss' ? undefined : {
                ...entry, value: 'remote',
                staleAt: state === 'fresh' ? 9_000 : 4_000,
                expAt: state === 'expired' ? 5_000 : 10_000,
            };
            read.resolve(remote);
            const usableRemote = state === 'fresh' || state === 'stale';
            await expect(result.revalidation).resolves.toEqual({
                value: usableRemote ? 'remote' : 'old', state: state === 'fresh' ? 'fresh' : 'stale',
            });
            expect(result.state).toBe('revalidating');
            expect(result.value).toBe('old');
            expect(l1.get('k')).toEqual(usableRemote ? remote : entry);
            expect(l2.set).not.toHaveBeenCalled();
        },
    );

    it.each(['miss', 'expired', 'stale'] as const)(
        'rechecks expiration when L2 returns %s after L1 has expired', async (state) => {
            const { cache, read, entry } = await setup();
            const result = cache.get('k');
            if (result instanceof Promise || result.state !== 'revalidating') throw new Error('Expected revalidating');
            vi.setSystemTime(10_000);
            read.resolve(state === 'miss' ? undefined : {
                ...entry, value: 'remote', expAt: state === 'stale' ? 15_000 : 10_000,
            });
            const checked = await result.revalidation;
            expect(checked.state).toBe(state === 'stale' ? 'stale' : 'expired');
            expect(checked).not.toHaveProperty('revalidation');
            expect(result.value).toBe('old');
        },
    );

    it.each(['missing', 'expired'] as const)(
        'waits for L2 when L1 is %s and promotes stale without extending TTL', async (local) => {
            const { cache, read, l1, entry } = await setup(local);
            const result = cache.get('k');
            expect(result).toBeInstanceOf(Promise);
            read.resolve(entry);
            await expect(result).resolves.toEqual({ value: 'old', state: 'stale' });
            expect(l1.get('k')).toEqual(entry);
        },
    );

    it('returns miss when neither level contains a record', async () => {
        const { cache, read } = await setup('missing');
        const result = cache.get('k');
        read.resolve(undefined);
        await expect(result).resolves.toEqual({ value: undefined, state: 'miss' });
    });

    it('shares the pending L2 read across revalidating and expired callers', async () => {
        const { cache, read, entry, l2 } = await setup();
        const results = Array.from({ length: 100 }, () => cache.get('k'));
        vi.setSystemTime(10_000);
        const waiting = cache.get('k');
        expect(waiting).toBeInstanceOf(Promise);
        expect(l2.get).toHaveBeenCalledTimes(1);
        read.resolve({ ...entry, value: 'new', staleAt: 15_000, expAt: 20_000 });
        for (const result of results) {
            if (result instanceof Promise || result.state !== 'revalidating') throw new Error('Expected revalidating');
            await expect(result.revalidation).resolves.toEqual({ value: 'new', state: 'fresh' });
        }
        await expect(waiting).resolves.toEqual({ value: 'new', state: 'fresh' });
    });

    it.each([false, true])('shares failed L2 reads between cache and memo (memoFirst=%s)', async (memoFirst) => {
        const { cache, memo, read, l2 } = await setup();
        const load = deferred<string>();
        const loader = vi.fn(() => load.promise);
        if (memoFirst) expect(memo.memoize('k', loader)).toBe('old');
        const result = cache.get('k');
        if (result instanceof Promise || result.state !== 'revalidating') throw new Error('Expected revalidating');
        if (!memoFirst) expect(memo.memoize('k', loader)).toBe('old');
        vi.setSystemTime(10_000);
        const waiting = memo.memoize('k', loader);
        const direct = cache.get('k');
        read.reject(new Error('L2 unavailable'));
        await expect(result.revalidation).resolves.toEqual({ value: undefined, state: 'expired' });
        await expect(direct).resolves.toEqual({ value: undefined, state: 'expired' });
        load.resolve('db');
        await expect(waiting).resolves.toBe('db');
        expect(loader).toHaveBeenCalledTimes(1);
        expect(l2.get).toHaveBeenCalledTimes(1);
        expect(cache.get('k')).toEqual({ value: 'db', state: 'fresh' });
    });

    it.each(
        (['stale', 'expired', 'missing'] as const).flatMap((local) =>
            [false, true].map((synchronous) => ({ local, synchronous })),
        ),
    )('cache suppresses L2 read errors (L1=$local, sync=$synchronous)', async ({ local, synchronous }) => {
        const { cache, l2 } = await setup(local);
        const failure = new Error('L2 read failed');
        if (synchronous) l2.get.mockImplementation(() => { throw failure; });
        else l2.get.mockRejectedValue(failure);

        const result = await cache.get('k');
        const checked = result.state === 'revalidating' ? await result.revalidation : result;
        expect(checked).toEqual({
            value: local === 'stale' ? 'old' : undefined,
            state: local === 'missing' ? 'miss' : local,
        });
    });

    it.each([false, true])('del propagates L2 errors after removing L1 (sync=%s)', async (synchronous) => {
        const { cache, l1, l2, read, entry } = await setup();
        const failure = new Error('L2 delete failed');
        if (synchronous) l2.delete.mockImplementation(() => { throw failure; });
        else l2.delete.mockRejectedValue(failure);

        await expect(cache.del('k')).rejects.toBe(failure);
        expect(l1.has('k')).toBe(false);
        expect(l2.delete).toHaveBeenCalledExactlyOnceWith('k');

        // Неудалённая копия L2 может снова заполнить L1.
        read.resolve(entry);
        await expect(cache.get('k')).resolves.toEqual({ value: 'old', state: 'stale' });
        expect(l1.get('k')).toEqual(entry);
    });

    it('del still propagates L1 errors', async () => {
        const { cache, l1, l2 } = await setup();
        const failure = new Error('L1 delete failed');
        vi.spyOn(l1, 'delete').mockImplementationOnce(() => { throw failure; });

        await expect(cache.del('k')).rejects.toBe(failure);
        expect(l2.delete).not.toHaveBeenCalled();
    });

    it('waits for fresh L2 and never calls the source loader', async () => {
        const { memo, read, entry, l2 } = await setup();
        const loader = vi.fn(() => 'db');
        expect(memo.memoize('k', loader)).toBe('old');
        await flush();
        expect(loader).not.toHaveBeenCalled();
        vi.setSystemTime(10_000);
        const waiting = memo.memoize('k', loader);
        read.resolve({ ...entry, value: 'remote', staleAt: 15_000, expAt: 20_000 });
        await expect(waiting).resolves.toBe('remote');
        expect(loader).not.toHaveBeenCalled();
        expect(l2.set).not.toHaveBeenCalled();
    });

    it.each(['stale', 'miss', 'expired'] as const)(
        'starts one source refresh after L2 returns %s, including past expiration', async (state) => {
            const { memo, cache, read, entry, l2 } = await setup();
            const load = deferred<string>();
            const write = deferred<void>();
            l2.set.mockImplementation(() => write.promise);
            const loader = vi.fn(() => load.promise);
            for (let i = 0; i < 100; i++) expect(memo.memoize('k', loader)).toBe('old');
            expect(l2.get).toHaveBeenCalledTimes(1);
            expect(loader).not.toHaveBeenCalled();
            read.resolve(state === 'miss' ? undefined : { ...entry, expAt: state === 'expired' ? 5_000 : 10_000 });
            await flush();
            expect(loader).toHaveBeenCalledTimes(1);
            for (let i = 0; i < 100; i++) expect(memo.memoize('k', loader)).toBe('old');
            await flush();
            vi.setSystemTime(10_000);
            const waiting = Array.from({ length: 100 }, () => memo.memoize('k', loader));
            let settled = false;
            const all = Promise.all(waiting).then((values) => { settled = true; return values; });
            // Эти запросы уже ждут обновления; новые чтения увидят L1 до завершения записи L2.
            await flush();
            load.resolve('new');
            await flush();
            expect(settled).toBe(false);
            expect(loader).toHaveBeenCalledTimes(1);
            expect(l2.set).toHaveBeenCalledTimes(1);
            expect(cache.get('k')).toEqual({ value: 'new', state: 'fresh' });
            expect(memo.memoize('k', loader)).toBe('new');
            write.resolve();
            await expect(all).resolves.toEqual(Array(100).fill('new'));
            expect(memo.memoize('k', loader)).toBe('new');
        },
    );

    it.each(['load', 'write'] as const)('propagates loader errors and tolerates L2 writes (failure=%s)', async (stage) => {
        const { memo, read, entry, l2 } = await setup();
        const load = deferred<string>();
        const write = deferred<void>();
        l2.set.mockImplementation(() => write.promise);
        const loader = vi.fn(() => load.promise);
        expect(memo.memoize('k', loader)).toBe('old');
        read.resolve(entry);
        await flush();
        vi.setSystemTime(10_000);
        const failure = new Error(stage);
        const waiting = memo.memoize('k', loader);
        const outcome = stage === 'load'
            ? expect(waiting).rejects.toBe(failure)
            : expect(waiting).resolves.toBe('new');
        await flush();
        if (stage === 'load') load.reject(failure);
        else { load.resolve('new'); await flush(); write.reject(failure); }
        await outcome;
        expect(loader).toHaveBeenCalledTimes(1);
        if (stage === 'write') {
            expect(memo.memoize('k', loader)).toBe('new');
            vi.setSystemTime(20_000);
        }
        l2.set.mockResolvedValue(undefined);
        loader.mockResolvedValue('retry');
        await expect(memo.memoize('k', loader)).resolves.toBe('retry');
    });

    it.each(
        (['stale', 'expired', 'missing'] as const).flatMap((local) =>
            (['read', 'write', 'both'] as const).flatMap((failureAt) =>
                [false, true].map((synchronous) => ({ local, failureAt, synchronous })),
            ),
        ),
    )('memo tolerates L2 failure (L1=$local, at=$failureAt, sync=$synchronous)', async ({ local, failureAt, synchronous }) => {
        const { cache, memo, l1, l2, read } = await setup(local);
        const failure = new Error('Redis unavailable');
        const load = deferred<string>();
        const loader = vi.fn(() => load.promise);
        if (failureAt !== 'write') {
            if (synchronous) l2.get.mockImplementation(() => { throw failure; });
            else l2.get.mockRejectedValue(failure);
        } else {
            read.resolve(undefined);
        }
        if (failureAt !== 'read') {
            if (synchronous) l2.set.mockImplementation(() => { throw failure; });
            else l2.set.mockRejectedValue(failure);
        }

        const calls = Array.from({ length: 100 }, () => memo.memoize('k', loader));
        if (local === 'stale') expect(calls).toEqual(Array(100).fill('old'));
        else expect(calls.every((result) => result instanceof Promise)).toBe(true);
        await flush();
        expect(loader).toHaveBeenCalledTimes(1);
        expect(l2.get).toHaveBeenCalledTimes(1);

        // После истечения L1 запросы ждут ту же загрузку, даже если Redis всё ещё недоступен.
        vi.setSystemTime(10_000);
        const waiting = Array.from({ length: 100 }, () => memo.memoize('k', loader));
        await flush();
        load.resolve('new');
        await expect(Promise.all(waiting)).resolves.toEqual(Array(100).fill('new'));
        await Promise.all(calls);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(l2.set).toHaveBeenCalledTimes(1);
        expect(l1.get('k')).toEqual({ value: 'new', time: 10_000, staleAt: 14_000, expAt: 20_000 });
        expect(memo.memoize('k', loader)).toBe('new');
        expect(cache.get('k')).toEqual({ value: 'new', state: 'fresh' });

        // При следующем истечении TTL продолжаем работать через источник и обновлять L1.
        vi.setSystemTime(20_000);
        loader.mockResolvedValue('next');
        await expect(memo.memoize('k', loader)).resolves.toBe('next');
        expect(loader).toHaveBeenCalledTimes(2);
        expect(l1.get('k')?.value).toBe('next');
    });

    it.each(['loader', 'serialize', 'l1-write', 'undefined'] as const)(
        'does not swallow %s failures when Redis reads fail', async (stage) => {
            const { memo, l1, l2 } = await setup('missing');
            const failure = new Error(stage);
            l2.get.mockRejectedValue(new Error('Redis unavailable'));
            const loader = vi.fn(() => {
                if (stage === 'loader') throw failure;
                return stage === 'undefined' ? undefined as unknown as string : 'new';
            });
            const serialize = vi.fn((value: string) => {
                if (stage === 'serialize') throw failure;
                return value;
            });
            if (stage === 'l1-write') vi.spyOn(l1, 'set').mockImplementation(() => { throw failure; });

            const result = memo.memoize('k', loader, { serialize, deserialize: (value) => value });
            if (stage === 'undefined') await expect(result).rejects.toThrow('undefined values cannot be cached');
            else await expect(result).rejects.toBe(failure);
            expect(loader).toHaveBeenCalledTimes(1);
            expect(l2.set).not.toHaveBeenCalled();
            expect(l1.has('k')).toBe(false);
        },
    );

    it.each(['deserialize', 'l1-read', 'l1-promote'] as const)(
        'does not turn %s errors into a source load', async (stage) => {
            const { memo, read, entry, l1 } = await setup('missing');
            const failure = new Error(stage);
            read.resolve({ ...entry, staleAt: 9_000 });
            const loader = vi.fn(() => 'db');
            const options = {
                serialize: (value: string) => value,
                deserialize: (value: string) => {
                    if (stage === 'deserialize') throw failure;
                    return value;
                },
            };
            if (stage === 'l1-read') {
                vi.spyOn(l1, 'get').mockImplementationOnce(() => { throw failure; });
                expect(() => memo.memoize('k', loader, options)).toThrow(failure);
            } else {
                if (stage === 'l1-promote') vi.spyOn(l1, 'set').mockImplementationOnce(() => { throw failure; });
                await expect(memo.memoize('k', loader, options)).rejects.toBe(failure);
            }
            expect(loader).not.toHaveBeenCalled();
        },
    );

    it('preserves L1 and deserializer references in revalidation results', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');
        const l1 = new MapStore<{ count: number }>();
        l1.set('k', { value: { count: 0 }, time: 0, staleAt: 4_000, expAt: 10_000 });
        const read = deferred<StoreValue<string>>();
        const l2 = { get: vi.fn(() => read.promise), set: vi.fn(), delete: vi.fn() };
        const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
        const restored = { count: 1 };
        const deserialize = vi.fn(() => restored);
        const first = cache.get('k', deserialize);
        const second = cache.get('k', deserialize);
        if (first instanceof Promise || first.state !== 'revalidating' || second instanceof Promise || second.state !== 'revalidating') {
            throw new Error('Expected revalidating');
        }
        read.resolve({ value: '{"count":1}', time: 0, staleAt: 9_000, expAt: 10_000 });
        const [a, b] = await Promise.all([first.revalidation, second.revalidation]);
        expect(a.value).toBe(restored);
        expect(b.value).toBe(restored);
        expect(l1.get('k')?.value).toBe(restored);
        expect(deserialize).toHaveBeenCalledWith('{"count":1}');
        expect(first.value).toBe(second.value);
        first.value.count = 42;
        expect(second.value.count).toBe(42);
        expect(l2.get).toHaveBeenCalledTimes(1);
    });
});
