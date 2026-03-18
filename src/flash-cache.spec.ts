import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Тесты для FlashCache без моков: только управление временем.
 * ВАЖНО: включаем fake timers ДО импорта модуля, иначе now = Date.now зафиксируется на реальном времени.
 */

describe('FlashCache (time-driven tests, no mocks)', () => {
    const BASE = new Date('2024-01-01T00:00:00.000Z');
    const advanceTo = (msFromBase: number) =>
      jest.setSystemTime(new Date(BASE.getTime() + msFromBase));

    const createDeferred = <T>() => {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        return { promise, resolve, reject };
    };

    beforeAll(() => {
        jest.useFakeTimers();          // включаем подмену времени
        jest.setSystemTime(BASE);      // фиксируем начальную «эпоху»
    });

    afterAll(() => {
        jest.useRealTimers();
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
        jest.setSystemTime(new Date(e!.staleAt));
        let r = await cache.get('x');
        expect(r.state).toBe('stale');

        // Чуть после expAt → expired
        jest.setSystemTime(new Date(e!.expAt + 1));
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
            get: jest.fn(() => {
                l2GetCalls += 1;
                return l2Read.promise;
            }),
            set: jest.fn(async () => undefined),
            delete: jest.fn(async () => undefined),
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
            get: jest.fn(async () => {
                throw l2Failure;
            }),
            set: jest.fn(async () => undefined),
            delete: jest.fn(async () => undefined),
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

    it('package main entry can be required via the package root', () => {
        const packageJsonPath = path.resolve(__dirname, '../package.json');
        const requireFromPackage = createRequire(packageJsonPath);

        expect(() => {
            requireFromPackage('.');
        }).not.toThrow();
    });
});
