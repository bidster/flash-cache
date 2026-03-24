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

    it('custom TTL affects staleAt/expAt correctly', async () => {
        const { FlashCache } = await import('./flash-cache');
        const { MapStore }   = await import('./stores/map-store');

        const l1 = new MapStore<any>();
        const l2 = new MapStore<any>();
        const baseTtl = 5000;      // базовый ttl не используем здесь
        const staleRatio = 0.6;

        const cache = new FlashCache<any>(l1, l2, { ttl: baseTtl, staleRatio, namespace: false });

        // set с кастомным TTL
        const customTtl = 3000; // 3s
        await cache.set('x', 'V', customTtl);

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
