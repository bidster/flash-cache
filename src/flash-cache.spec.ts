import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Тесты для FlashCache без моков: только управление временем.
 * ВАЖНО: включаем fake timers ДО импорта модуля, иначе now = Date.now зафиксируется на реальном времени.
 */

describe('FlashCache (time-driven tests, no mocks)', () => {
    const BASE = new Date('2024-01-01T00:00:00.000Z');
    const advanceTo = (msFromBase: number) =>
      vi.setSystemTime(new Date(BASE.getTime() + msFromBase));

    const createDeferred = <T>() => {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        return { promise, resolve, reject };
    };

    const flushMicrotasks = async (count: number = 3) => {
        for (let i = 0; i < count; i += 1) {
            await Promise.resolve();
        }
    };

    beforeAll(() => {
        vi.useFakeTimers();          // включаем подмену времени
        vi.setSystemTime(BASE);      // фиксируем начальную «эпоху»
    });

    afterAll(() => {
        vi.useRealTimers();
    });

    const invalidTtls = [0, -1, 0.5, 1.5, NaN, Infinity, -Infinity, '1000', null];

    it.each([...invalidTtls, undefined])('rejects invalid default ttl: %s', async (ttl) => {
        const { FlashCache } = await import('./flash-cache');
        const stores = [0, 1].map(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }));
        expect(() => new FlashCache(stores[0], stores[1], {
            ttl: ttl as number, staleRatio: 0.4,
        })).toThrow('ttl must be a positive integer in milliseconds');
        for (const store of stores) {
            for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
        }
    });

    it.each([-0.1, 1.1, NaN, Infinity, -Infinity, '0.5', null, undefined])('rejects invalid staleRatio: %s', async (staleRatio) => {
        const { FlashCache } = await import('./flash-cache');
        const stores = [0, 1].map(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }));
        expect(() => new FlashCache(stores[0], stores[1], {
            ttl: 10_000, staleRatio: staleRatio as number,
        })).toThrow('staleRatio must be a finite number between 0 and 1');
        for (const store of stores) {
            for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
        }
    });

    it.each([0, 1])('supports staleRatio=%s and a one-millisecond ttl', async (staleRatio) => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const cache = new FlashCache(new MapStore<string>(), new MapStore<string>(), {
            ttl: 1, staleRatio,
        });
        await cache.set('k', 'value');
        expect(cache.get('k')).toEqual({ value: 'value', state: staleRatio === 0 ? 'stale' : 'fresh' });
        advanceTo(1);
        expect(await cache.get('k')).toEqual({ value: 'value', state: 'expired' });
    });

    it.each(invalidTtls)('memo rejects invalid custom ttl before loading or writing: %s', async (customTtl) => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4 });
        const memo = new FlashMemo(cache);
        const loader = vi.fn(() => 'value');
        const serialize = vi.fn((value: string) => value);
        const result = memo.memoize('k', loader, {
            customTtl: customTtl as number, serialize, deserialize: (value) => value,
        });
        expect(result).toBeInstanceOf(Promise);
        await expect(result).rejects.toThrow('customTtl must be a positive integer in milliseconds');
        expect(loader).not.toHaveBeenCalled();
        expect(serialize).not.toHaveBeenCalled();
        expect(l1.size).toBe(0);
        expect(l2.size).toBe(0);
        await expect(memo.memoize('k', loader, {customTtl: 1_000})).resolves.toBe('value');
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it.each(['fresh-l1', 'fresh-l2', 'stale-l1', 'stale-l2', 'expired'])(
        'memo validates custom ttl only when filling (state=%s)', async (state) => {
            const { FlashCache } = await import('./flash-cache');
            const { FlashMemo } = await import('./flash-memo');
            const { MapStore } = await import('./stores/map-store');
            advanceTo(0);
            const l1 = new MapStore<string>();
            const l2 = new MapStore<string>();
            const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
            const memo = new FlashMemo(cache);
            await cache.set('k', 'old');
            const oldEntry = l2.get('k');
            if (state.startsWith('stale')) advanceTo(4_001);
            if (state === 'expired') advanceTo(10_001);
            if (state.endsWith('l2')) l1.clear();
            const loader = vi.fn(() => 'new');
            const write = vi.spyOn(cache, 'set');
            const result = memo.memoize('k', loader, {customTtl: NaN});
            if (state === 'expired') {
                await expect(result).rejects.toThrow('customTtl must be a positive integer in milliseconds');
            } else {
                if (state.endsWith('l1')) expect(result).toBe('old');
                expect(await result).toBe('old');
            }
            await flushMicrotasks(10);
            expect(loader).not.toHaveBeenCalled();
            expect(write).not.toHaveBeenCalled();
            expect(l2.get('k')).toBe(oldEntry);
            write.mockRestore();
        },
    );

    it('memo uses default or custom ttl with and without serialization', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache(l1, l2, { ttl: 7, staleRatio: 0.5, namespace: false });
        const memo = new FlashMemo(cache);
        const serialize = (value: string) => value.toUpperCase();
        const deserialize = (value: string) => value.toLowerCase();
        await cache.set('direct', 'value');
        await cache.set('direct-serialized', 'value', serialize);
        await memo.memoize('omitted', () => 'value');
        await memo.memoize('undefined', () => 'value', {customTtl: undefined});
        await memo.memoize('serialized', () => 'value', {serialize, deserialize});
        await memo.memoize('custom', () => 'value', {customTtl: 1});
        await memo.memoize('custom-serialized', () => 'value', {customTtl: 1, serialize, deserialize});
        for (const key of ['direct', 'direct-serialized', 'omitted', 'undefined', 'serialized']) {
            expect(l1.get(key)?.expAt).toBe(BASE.getTime() + 7);
            expect(l1.get(key)?.staleAt).toBe(BASE.getTime() + 3.5);
        }
        for (const key of ['custom', 'custom-serialized']) {
            expect(l1.get(key)?.expAt).toBe(BASE.getTime() + 1);
            expect(l2.get(key)?.expAt).toBe(BASE.getTime() + 1);
        }
        expect(l1.get('custom-serialized')?.value).toBe('value');
        expect(l2.get('custom-serialized')?.value).toBe('VALUE');
    });

    it('basic lifecycle: miss → fresh → stale → expired → miss (after del)', async () => {
        // Импортируем модуль уже после включения fake timers
        const { FlashCache } = await import('./flash-cache'); // путь подправьте под свой файл
        const { MapStore }   = await import('./stores/map-store');

        const l1 = new MapStore<any>();
        const l2 = new MapStore<any>();

        const ttl = 1000;        // 1s
        const staleRatio = 0.8;  // 800ms → stale
        const cache = new FlashCache<any>(l1, l2, {
            ttl,
            staleRatio,
            namespace: 'test',
        });

        // 1) До установки — miss
        let r = await cache.get('k');
        expect(r.state).toBe('miss');
        expect(r.value).toBeUndefined();

        // 2) Сохраняем значение и получаем fresh
        await cache.set('k', 'A');
        r = await cache.get('k');
        expect(r.state).toBe('fresh');
        expect(r.value).toBe('A');

        // 3) Двигаем время за границу staleAt (800мс), но до expAt (1000мс) → stale
        advanceTo(850);
        r = await cache.get('k');
        expect(r.state).toBe('stale');
        expect(r.value).toBe('A'); // значение остаётся тем же

        // 4) После истечения TTL (1000мс+) → expired
        advanceTo(1001);
        r = await cache.get('k');
        expect(r.state).toBe('expired');
        // значение может быть передано из L2 как "истекшее"
        expect(r.value).toBe('A');

        // 5) Явно удаляем — снова miss
        await cache.del('k');
        r = await cache.get('k');
        expect(r.state).toBe('miss');
        expect(r.value).toBeUndefined();
    });

    it('promotes fresh from L2 to L1 when L1 empty', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore }   = await import('./stores/map-store');

        // Общий L2, новый "пустой" L1 — проверим, что get поднимет свежую запись из L2 в L1
        const l2 = new MapStore<any>();
        const ttl = 2000;
        const staleRatio = 0.5;

        // Сначала положим значение через «временный» экземпляр (заполнит и L2)
        {
            const tempL1 = new MapStore<any>();
            const tmp = new FlashCache<any>(tempL1, l2, { ttl, staleRatio, namespace: 'ns' });
            await tmp.set('user:42', { name: 'Igor' });
        }

        // Новый экземпляр с пустым L1
        const l1 = new MapStore<any>();
        const cache = new FlashCache<any>(l1, l2, { ttl, staleRatio, namespace: 'ns' });

        // На базовом времени запись свежая → get должен взять из L2, вернуть fresh и записать в L1
        const res = await cache.get('user:42');
        expect(res.state).toBe('fresh');
        expect(res.value).toEqual({ name: 'Igor' });

        // Проверим, что L1 действительно заполнен (без моков): вычислим ожидаемый ключ с префиксом.
        const prefixedKey = 'flashCache:v1:ns:user:42';
        const l1Entry = l1.get(prefixedKey);
        expect(l1Entry?.value).toEqual({ name: 'Igor' });
    });

    it.each(
        ['serialize', 'l2-throw', 'l2-reject'].flatMap((failureAt) => [
            { failureAt, existing: false },
            { failureAt, existing: true },
        ]),
    )('set preserves L1 on failure (at=$failureAt, existing=$existing)', async ({ failureAt, existing }) => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const l1 = new MapStore<string>();
        const storage = new MapStore<string>();
        const l2 = {
            get: (key: string) => storage.get(key),
            set: vi.fn(async (key: string, entry: import('./flash-cache').StoreValue<string>) => { storage.set(key, entry); }),
            delete: (key: string) => storage.delete(key),
        };
        const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
        if (existing) await cache.set('k', 'old');
        const beforeL1 = l1.get('k');
        const beforeL2 = storage.get('k');
        l2.set.mockClear();
        const failure = new Error('write failed');
        if (failureAt === 'serialize') {
            await expect(cache.set('k', 'new', () => { throw failure; })).rejects.toBe(failure);
            expect(l2.set).not.toHaveBeenCalled();
        } else {
            if (failureAt === 'l2-throw') l2.set.mockImplementationOnce(() => { throw failure; });
            else l2.set.mockRejectedValueOnce(failure);
            await expect(cache.set('k', 'new')).rejects.toBe(failure);
            expect(l2.set).toHaveBeenCalledTimes(1);
        }
        expect(l1.get('k')).toBe(beforeL1);
        expect(storage.get('k')).toBe(beforeL2);
        expect(await cache.get('k')).toEqual(existing
            ? { value: 'old', state: 'fresh' }
            : { value: undefined, state: 'miss' });
    });

    it('set publishes to L1 only after L2 succeeds, preserving original timestamps', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const l1 = new MapStore<string>();
        const storage = new MapStore<string>();
        const pending = createDeferred<void>();
        const l2 = {
            get: (key: string) => storage.get(key),
            set: vi.fn(async (key: string, entry: import('./flash-cache').StoreValue<string>) => { storage.set(key, entry); }),
            delete: (key: string) => storage.delete(key),
        };
        const cache = new FlashCache(l1, l2, { ttl: 5_000, staleRatio: 0.4, namespace: false });
        await cache.set('k', 'old');
        l2.set.mockImplementationOnce(async (key, entry) => {
            await pending.promise;
            storage.set(key, entry);
        });
        const serialize = vi.fn((value: string) => value.toUpperCase());
        const write = cache.set('k', 'new', serialize);
        expect(serialize).toHaveBeenCalledExactlyOnceWith('new');
        expect(cache.get('k')).toEqual({ value: 'old', state: 'fresh' });
        expect(storage.get('k')?.value).toBe('old');
        advanceTo(1_000);
        pending.resolve();
        await write;
        expect(cache.get('k')).toEqual({ value: 'new', state: 'fresh' });
        expect(l1.get('k')).toEqual({
            value: 'new', time: BASE.getTime(),
            staleAt: BASE.getTime() + 2_000, expAt: BASE.getTime() + 5_000,
        });
        expect(storage.get('k')).toEqual({ ...l1.get('k'), value: 'NEW' });
    });

    it('set propagates L1 failure after L2 has already been updated', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
        await cache.set('k', 'old');
        const failure = new Error('L1 write failed');
        const set = vi.spyOn(l1, 'set').mockImplementationOnce(() => { throw failure; });
        await expect(cache.set('k', 'new')).rejects.toBe(failure);
        expect(l2.get('k')?.value).toBe('new');
        expect(l1.get('k')?.value).toBe('old');
        set.mockRestore();
    });

    it('memo custom TTL affects staleAt/expAt correctly', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        advanceTo(0);
        const { MapStore }   = await import('./stores/map-store');

        const l1 = new MapStore<any>();
        const l2 = new MapStore<any>();
        const baseTtl = 5000;      // базовый ttl не используем здесь
        const staleRatio = 0.6;

        const cache = new FlashCache<any>(l1, l2, { ttl: baseTtl, staleRatio, namespace: false });

        // memoize с кастомным TTL
        const customTtl = 3000; // 3s
        await new FlashMemo(cache).memoize('x', () => 'V', {customTtl});

        // Достаём запись напрямую из L1, чтобы проверить метки времени
        const prefixedKey = 'x'; // namespace=false → без префикса
        const e = l1.get(prefixedKey);
        expect(e).toBeTruthy();

        const start = new Date().getTime(); // BASE
        expect(e!.time).toBe(start);                     // положили сейчас
        expect(e!.staleAt).toBe(start + Math.floor(customTtl * staleRatio));
        expect(e!.expAt).toBe(start + customTtl);

        // На границе stale: двигаем точно к staleAt → должно быть stale
        vi.setSystemTime(new Date(e!.staleAt));
        let r = await cache.get('x');
        expect(r.state).toBe('stale');

        // Чуть после expAt → expired
        vi.setSystemTime(new Date(e!.expAt + 1));
        r = await cache.get('x');
        expect(r.state).toBe('expired');
    });

    it('returns stale value from L1 immediately without waiting for L2', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore }   = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<any>();
        const l2Read = createDeferred<any>();
        let l2GetCalls = 0;

        const l2 = {
            get: vi.fn(() => {
                l2GetCalls += 1;
                return l2Read.promise;
            }),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };

        const cache = new FlashCache<any>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });

        await cache.set('k', 'A');

        advanceTo(4_001);

        const result = cache.get('k');

        expect(l2GetCalls).toBe(1);

        l2Read.resolve({
            value: 'B',
            time: BASE.getTime(),
            staleAt: BASE.getTime() + 9_000,
            expAt: BASE.getTime() + 10_000,
        });

        await Promise.resolve();

        expect(result).not.toBeInstanceOf(Promise);
        expect(result).toEqual({ value: 'A', state: 'stale' });
    });

    it('propagates L2 read errors when the response depends on L2', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore }   = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<any>();
        const l2Failure = new Error('redis unavailable');
        const l2 = {
            get: vi.fn(async () => {
                throw l2Failure;
            }),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };

        const cache = new FlashCache<any>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });

        await Promise.resolve(cache.get('k')).then(
            () => {
                throw new Error('expected L2 error to be propagated');
            },
            (error) => {
                expect(error).toBe(l2Failure);
            },
        );
    });

    it('deduplicates concurrent L2 reads for the same key', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<any>();
        const l2Read = createDeferred<any>();
        const l2 = {
            get: vi.fn(() => l2Read.promise),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };

        const cache = new FlashCache<any>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });

        const first = Promise.resolve(cache.get('k'));
        const second = Promise.resolve(cache.get('k'));

        expect(l2.get).toHaveBeenCalledTimes(1);

        l2Read.resolve({
            value: 'A',
            time: BASE.getTime(),
            staleAt: BASE.getTime() + 4_000,
            expAt: BASE.getTime() + 10_000,
        });

        await expect(first).resolves.toEqual({ value: 'A', state: 'fresh' });
        await expect(second).resolves.toEqual({ value: 'A', state: 'fresh' });
        expect(l2.get).toHaveBeenCalledTimes(1);
    });

    it.each([
        { sharedL2: false, stale: false },
        { sharedL2: true, stale: false },
        { sharedL2: false, stale: true },
        { sharedL2: true, stale: true },
    ])('isolates instance reads (sharedL2=$sharedL2, stale=$stale)', async ({ sharedL2, stale }) => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const entryA = {
            value: 'A',
            time: BASE.getTime(),
            staleAt: BASE.getTime() + 9_000,
            expAt: BASE.getTime() + 10_000,
        };
        const entryB = { ...entryA, value: 'B' };
        const l2A = {
            get: vi.fn(async () => entryA),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };
        const l2B = sharedL2 ? l2A : {
            ...l2A,
            get: vi.fn(async () => entryB),
        };
        const options = { ttl: 10_000, staleRatio: 0.4, namespace: 'instance-isolation' };
        const cacheA = new FlashCache(new MapStore<string>(), l2A, options);
        const cacheB = new FlashCache(new MapStore<string>(), l2B, options);

        if (stale) {
            await cacheA.set('k', 'old-A');
            await cacheB.set('k', 'old-B');
            advanceTo(4_001);
        }

        const firstA = cacheA.get('k');
        const secondA = cacheA.get('k');
        const firstB = cacheB.get('k');
        const secondB = cacheB.get('k');

        const results = await Promise.all([firstA, secondA, firstB, secondB]);
        await flushMicrotasks(5);

        expect(l2A.get).toHaveBeenCalledTimes(sharedL2 ? 2 : 1);
        expect(l2B.get).toHaveBeenCalledTimes(sharedL2 ? 2 : 1);
        const expectedA = { value: stale ? 'old-A' : 'A', state: stale ? 'stale' : 'fresh' };
        const expectedB = { value: stale ? 'old-B' : sharedL2 ? 'A' : 'B', state: stale ? 'stale' : 'fresh' };
        expect(results).toEqual([expectedA, expectedA, expectedB, expectedB]);
        if (stale) {
            expect(firstA).not.toBeInstanceOf(Promise);
            expect(firstB).not.toBeInstanceOf(Promise);
        }

        expect(cacheA.get('k')).toEqual({ value: 'A', state: 'fresh' });
        expect(cacheB.get('k')).toEqual({ value: sharedL2 ? 'A' : 'B', state: 'fresh' });
        expect(l2A.get).toHaveBeenCalledTimes(sharedL2 ? 2 : 1);
        expect(l2B.get).toHaveBeenCalledTimes(sharedL2 ? 2 : 1);
    });

    it.each([
        { operation: 'set', stale: false },
        { operation: 'del', stale: false },
        { operation: 'set', stale: true },
        { operation: 'del', stale: true },
    ])('allows an older read to refill L1 after $operation without extending TTL (stale=$stale)', async ({ operation, stale }) => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const oldEntry = { value: 'old', time: BASE.getTime(), staleAt: BASE.getTime() + 9_000, expAt: BASE.getTime() + 10_000 };
        const pending = createDeferred<typeof oldEntry>();
        const l1 = new MapStore<string>();
        const l2 = { get: () => pending.promise, set: async () => undefined, delete: async () => undefined };
        const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
        if (stale) {
            await cache.set('k', 'stale');
            advanceTo(4_001);
        }
        const first = cache.get('k');
        const second = cache.get('k');
        if (operation === 'set') await cache.set('k', 'new');
        else await cache.del('k');
        pending.resolve(oldEntry);
        const expected = { value: stale ? 'stale' : 'old', state: stale ? 'stale' : 'fresh' };
        expect(await first).toEqual(expected);
        expect(await second).toEqual(expected);
        await flushMicrotasks(10);
        expect(l1.get('k')).toEqual(oldEntry);
        expect(cache.get('k')).toEqual({ value: 'old', state: 'fresh' });
        advanceTo(10_001);
        expect(await cache.get('k')).toEqual({ value: 'old', state: 'expired' });
    });

    it.each(['set', 'del'])('keeps the pending L2 read shared across %s', async (operation) => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const oldEntry = { value: 'old', time: BASE.getTime(), staleAt: BASE.getTime() + 9_000, expAt: BASE.getTime() + 10_000 };
        const pending = createDeferred<typeof oldEntry>();
        const l1 = new MapStore<string>();
        const l2 = {
            get: vi.fn(() => pending.promise),
            set: async () => undefined,
            delete: async () => undefined,
        };
        const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
        const first = cache.get('k');
        if (operation === 'set') await cache.set('k', 'new');
        else await cache.del('k');
        l1.clear(); // Force L2 even after a successful set.
        const second = cache.get('k');
        pending.resolve(oldEntry);
        expect(await first).toEqual({ value: 'old', state: 'fresh' });
        expect(await second).toEqual({ value: 'old', state: 'fresh' });
        expect(l2.get).toHaveBeenCalledTimes(1);
        expect(l1.get('k')).toEqual(oldEntry);
    });

    it.each(['get', 'set', 'del'])('allows a fresh L2 read after a failed %s', async (operation) => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const entry = { value: 'fresh', time: BASE.getTime(), staleAt: BASE.getTime() + 9_000, expAt: BASE.getTime() + 10_000 };
        const failure = new Error('store unavailable');
        const l1 = new MapStore<string>();
        const l2 = {
            get: vi.fn(async () => entry),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };
        const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
        if (operation === 'get') {
            l2.get.mockRejectedValueOnce(failure);
            await expect(cache.get('k')).rejects.toBe(failure);
        } else if (operation === 'set') {
            l2.set.mockRejectedValueOnce(failure);
            await expect(cache.set('k', 'new')).rejects.toBe(failure);
        } else {
            l2.delete.mockRejectedValueOnce(failure);
            await expect(cache.del('k')).rejects.toBe(failure);
        }
        l1.clear();
        expect(await cache.get('k')).toEqual({ value: 'fresh', state: 'fresh' });
        expect(l1.get('k')).toEqual(entry);
        expect(cache.get('k')).toEqual({ value: 'fresh', state: 'fresh' });
        expect(l2.get).toHaveBeenCalledTimes(operation === 'get' ? 2 : 1);
    });

    it('promotes refreshed value from L2 into L1 after serving stale', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<any>();
        const l2Read = createDeferred<any>();
        const l2 = {
            get: vi.fn(() => l2Read.promise),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };

        const cache = new FlashCache<any>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });

        await cache.set('k', 'A');
        advanceTo(4_001);

        expect(cache.get('k')).toEqual({ value: 'A', state: 'stale' });

        l2Read.resolve({
            value: 'B',
            time: BASE.getTime(),
            staleAt: BASE.getTime() + 9_000,
            expAt: BASE.getTime() + 10_000,
        });

        const prefixedKey = 'flashCache:v1:test:k';
        await l2Read.promise;
        await flushMicrotasks();

        expect(l1.get(prefixedKey)?.value).toBe('B');
        expect(cache.get('k')).toEqual({ value: 'B', state: 'fresh' });
    });

    it('keeps stale L1 value available when background refresh fails', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<any>();
        const l2 = {
            get: vi.fn(async () => {
                throw new Error('temporary l2 failure');
            }),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };

        const cache = new FlashCache<any>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });

        await cache.set('k', 'A');
        advanceTo(4_001);

        expect(cache.get('k')).toEqual({ value: 'A', state: 'stale' });

        await flushMicrotasks();

        expect(cache.get('k')).toEqual({ value: 'A', state: 'stale' });
        expect(l2.get).toHaveBeenCalledTimes(2);
    });

    it('isolates values by namespace and supports raw keys when namespace is false', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const sharedL1 = new MapStore<any>();
        const sharedL2 = new MapStore<any>();

        const alpha = new FlashCache<any>(sharedL1, sharedL2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'alpha',
        });

        const beta = new FlashCache<any>(sharedL1, sharedL2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'beta',
        });

        const raw = new FlashCache<any>(sharedL1, sharedL2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: false,
        });

        await alpha.set('k', 'A');
        await beta.set('k', 'B');
        await raw.set('k', 'R');

        expect(await alpha.get('k')).toEqual({ value: 'A', state: 'fresh' });
        expect(await beta.get('k')).toEqual({ value: 'B', state: 'fresh' });
        expect(await raw.get('k')).toEqual({ value: 'R', state: 'fresh' });

        expect(sharedL1.has('flashCache:v1:alpha:k')).toBe(true);
        expect(sharedL1.has('flashCache:v1:beta:k')).toBe(true);
        expect(sharedL1.has('k')).toBe(true);
    });

    it('treats null as a valid cached value', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<null>();
        const l2 = new MapStore<null>();
        const cache = new FlashCache<null>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });

        await cache.set('missing-user', null);

        expect(await cache.get('missing-user')).toEqual({ value: null, state: 'fresh' });

        advanceTo(4_001);
        expect(await cache.get('missing-user')).toEqual({ value: null, state: 'stale' });
    });

    it('rejects undefined values instead of storing ambiguous misses', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<any>();
        const l2 = new MapStore<any>();
        const cache = new FlashCache<any>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });

        await expect(cache.set('missing-user', undefined)).rejects.toThrow(
          'undefined values cannot be cached',
        );

        expect(await cache.get('missing-user')).toEqual({ value: undefined, state: 'miss' });
    });

    it('memo fills cache on miss and stores computed value', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache<string>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });
        const memo = new FlashMemo(cache);

        const loader = vi.fn(() => 'A');
        const result = memo.memoize('k', loader);

        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toBe('A');
        expect(loader).toHaveBeenCalledTimes(1);
        expect(await cache.get('k')).toEqual({ value: 'A', state: 'fresh' });
    });

    it('memo returns fresh value without calling loader', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache<string>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });
        const memo = new FlashMemo(cache);

        await cache.set('k', 'A');

        const loader = vi.fn(() => 'B');

        expect(memo.memoize('k', loader)).toBe('A');
        expect(loader).not.toHaveBeenCalled();
    });

    it('memo recomputes expired values instead of returning expired payloads', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache<string>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });
        const memo = new FlashMemo(cache);

        await cache.set('k', 'A');
        advanceTo(10_001);

        const loader = vi.fn(() => 'B');

        await expect(memo.memoize('k', loader)).resolves.toBe('B');
        expect(loader).toHaveBeenCalledTimes(1);
        expect(await cache.get('k')).toEqual({ value: 'B', state: 'fresh' });
    });

    it('memo returns stale immediately by default and refreshes in background', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache<string>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });
        const memo = new FlashMemo(cache);

        await cache.set('k', 'A');
        advanceTo(4_001);

        const loader = vi.fn(async () => 'B');

        expect(memo.memoize('k', loader)).toBe('A');
        expect(loader).toHaveBeenCalledTimes(1);

        await flushMicrotasks();

        expect(await cache.get('k')).toEqual({ value: 'B', state: 'fresh' });
    });

    it.each(
        ['fresh', 'stale-l1', 'stale-l2', 'miss', 'expired'].flatMap((state) => [
            { state, asynchronous: false },
            { state, asynchronous: true },
        ]),
    )('memo handles loader errors consistently (state=$state, async=$asynchronous)', async ({ state, asynchronous }) => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache(l1, l2, { ttl: 10_000, staleRatio: 0.4, namespace: false });
        const memo = new FlashMemo(cache);
        if (state !== 'miss') await cache.set('k', 'old');
        if (state.startsWith('stale')) advanceTo(4_001);
        if (state === 'expired') advanceTo(10_001);
        if (state === 'stale-l2') l1.clear();
        const beforeL1 = l1.get('k');
        const beforeL2 = l2.get('k');
        const failure = new Error('loader failed');
        const loader = vi.fn(() => {
            if (asynchronous) return Promise.reject<string>(failure);
            throw failure;
        });

        const result = memo.memoize('k', loader);
        if (state === 'fresh' || state === 'stale-l1') {
            expect(result).toBe('old');
        } else {
            expect(result).toBeInstanceOf(Promise);
            if (state === 'stale-l2') await expect(result).resolves.toBe('old');
            else await expect(result).rejects.toBe(failure);
        }
        await flushMicrotasks(10);
        expect(loader).toHaveBeenCalledTimes(state === 'fresh' ? 0 : 1);
        expect(l1.get('k')).toBe(beforeL1);
        expect(l2.get('k')).toBe(beforeL2);
        if (state === 'fresh') return;

        const retry = vi.fn(() => 'new');
        expect(await memo.memoize('k', retry)).toBe(state.startsWith('stale') ? 'old' : 'new');
        await flushMicrotasks(10);
        expect(retry).toHaveBeenCalledTimes(1);
        expect(cache.get('k')).toEqual({ value: 'new', state: 'fresh' });
    });

    it.each([false, true])('memo deduplicates failing background loaders (async=%s)', async (asynchronous) => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');
        advanceTo(0);
        const cache = new FlashCache(new MapStore<string>(), new MapStore<string>(), {
            ttl: 10_000, staleRatio: 0.4, namespace: false,
        });
        const memo = new FlashMemo(cache);
        await cache.set('k', 'old');
        advanceTo(4_001);
        const failure = new Error('loader failed');
        const loader = vi.fn(() => {
            if (asynchronous) return Promise.reject<string>(failure);
            throw failure;
        });
        expect(memo.memoize('k', loader)).toBe('old');
        expect(memo.memoize('k', loader)).toBe('old');
        await flushMicrotasks(10);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(memo.memoize('k', () => 'new')).toBe('old');
        await flushMicrotasks(10);
        expect(cache.get('k')).toEqual({ value: 'new', state: 'fresh' });
    });

    it('memo deduplicates concurrent loader calls for the same key', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<string>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache<string>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });
        const memo = new FlashMemo(cache);

        const loaderRead = createDeferred<string>();
        const loader = vi.fn(() => loaderRead.promise);

        const first = Promise.resolve(memo.memoize('k', loader));
        const second = Promise.resolve(memo.memoize('k', loader));

        await flushMicrotasks();
        expect(loader).toHaveBeenCalledTimes(1);

        loaderRead.resolve('A');

        await expect(first).resolves.toBe('A');
        await expect(second).resolves.toBe('A');
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('serializes on set and restores class instances on get for a shared cache', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore } = await import('./stores/map-store');

        class User {
            constructor(readonly name: string) {}

            greeting(): string {
                return `Hello, ${this.name}`;
            }
        }

        advanceTo(0);

        const l1 = new MapStore<unknown>();
        const l2 = new MapStore<{name: string}>();
        const cache = new FlashCache<unknown, {name: string}>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });

        await cache.set('user:42', new User('Igor'), (user) => ({name: user.name}));
        l1.clear();

        const result = await cache.get('user:42', ({name}) => new User(name));

        expect(result.value).toBeInstanceOf(User);
        expect((result.value as User).greeting()).toBe('Hello, Igor');
        expect(l1.get('flashCache:v1:test:user:42')?.value).toBeInstanceOf(User);
    });

    it('memo rejects when loader returns undefined', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { FlashMemo } = await import('./flash-memo');
        const { MapStore } = await import('./stores/map-store');

        advanceTo(0);

        const l1 = new MapStore<any>();
        const l2 = new MapStore<any>();
        const cache = new FlashCache<any>(l1, l2, {
            ttl: 10_000,
            staleRatio: 0.4,
            namespace: 'test',
        });
        const memo = new FlashMemo(cache);

        await expect(memo.memoize('k', () => undefined)).rejects.toThrow(
          'undefined values cannot be cached',
        );
    });
});
