import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlashCache, MapStore, jitter, type StoreValue } from './index';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('local refresh deadlines and shared expiry', () => {
    it.each([0, 500, 1000])('respects refresh and expiry boundaries (staleAfter=%s)', async (staleAfter) => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const cache = new FlashCache(primary, secondary, { ttl: 1000, staleAfter, namespace: false });
        cache.set('x', 1);
        expect(primary.get('x')).toEqual({ value: 1, time: 1000, staleAt: 1000 + staleAfter, expAt: 2000 });
        expect(secondary.get('x')).toEqual({ value: 1, time: 1000, expAt: 2000 });
        let resolve!: (value: number) => void;
        const factory = vi.fn(
            () =>
                new Promise<number>((done) => {
                    resolve = done;
                }),
        );
        vi.setSystemTime(1000 + staleAfter);
        const response = cache.getOrSet('x', factory);
        if (staleAfter === 1000) expect(response).toBeInstanceOf(Promise);
        else expect(response).toBe(1);
        vi.setSystemTime(2000);
        expect(cache.get('x')).toBeUndefined();
        const waiting = cache.getOrSet('x', factory);
        resolve(2);
        expect(await waiting).toBe(2);
        expect(await response).toBe(staleAfter === 1000 ? 2 : 1);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        'lets later pods adopt the early pod refresh instead of running factories (async L2=%s)',
        async (asyncL2) => {
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            const raw = new MapStore<number>();
            const secondary = asyncL2
                ? {
                      get: async (key: string) => raw.get(key),
                      set: async (key: string, value: StoreValue<number>) => {
                          raw.set(key, value);
                      },
                      delete: async (key: string) => {
                          raw.delete(key);
                      },
                  }
                : raw;
            const stores = [new MapStore<number>(), new MapStore<number>(), new MapStore<number>()];
            const policies = [60_000, 90_000, 120_000].map((delay) => vi.fn(() => delay));
            const pods = stores.map(
                (primary, i) =>
                    new FlashCache(primary, secondary, { ttl: 600_000, staleAfter: policies[i], namespace: false }),
            );
            const factory = vi.fn(() => 1);
            for (const pod of pods) expect(await pod.getOrSet('x', factory)).toBe(1);
            expect(factory).toHaveBeenCalledTimes(1);
            expect(stores.map((s) => s.get('x'))).toEqual(
                [60_000, 90_000, 120_000].map((delay) => ({
                    value: 1,
                    time: 1000,
                    expAt: 601_000,
                    staleAt: 1000 + delay,
                })),
            );
            expect(raw.get('x')).toEqual({ value: 1, time: 1000, expAt: 601_000 });
            vi.setSystemTime(61_000);
            const earlyFactory = vi.fn(() => 2);
            expect(await pods[0].getOrSet('x', earlyFactory)).toBe(1);
            await vi.advanceTimersByTimeAsync(0);
            expect(earlyFactory).toHaveBeenCalledTimes(1);
            expect(raw.get('x')).toEqual({ value: 2, time: 61_000, expAt: 661_000 });
            for (const i of [1, 2]) {
                vi.setSystemTime(i === 1 ? 91_000 : 121_000);
                const shouldNotRun = vi.fn(() => 3);
                expect(await pods[i].getOrSet('x', shouldNotRun)).toBe(1);
                await vi.advanceTimersByTimeAsync(0);
                expect(pods[i].get('x')).toBe(2);
                expect(shouldNotRun).not.toHaveBeenCalled();
                expect(stores[i].get('x')).toMatchObject({
                    time: 61_000,
                    staleAt: 61_000 + (i === 1 ? 90_000 : 120_000),
                    expAt: 661_000,
                });
            }
            for (const policy of policies) expect(policy).toHaveBeenCalledTimes(2);
        },
    );

    it('chooses jitter independently once for each pod and each accepted snapshot', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const random = vi
            .spyOn(Math, 'random')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0.5)
            .mockReturnValueOnce(0.99999);
        const raw = new MapStore<number>();
        const stores = [new MapStore<number>(), new MapStore<number>(), new MapStore<number>()];
        const pods = stores.map(
            (primary) =>
                new FlashCache(primary, raw, {
                    ttl: 600_000,
                    staleAfter: () => jitter(120_000, 0.5),
                    namespace: false,
                }),
        );
        const factory = vi.fn(() => 1);
        for (const pod of pods) {
            pod.getOrSet('x', factory);
            pod.getOrSet('x', factory);
        }
        expect(stores.map((s) => s.get('x'))).toEqual(
            [120_000, 90_000, 60_001].map((delay) => ({
                value: 1,
                time: 1000,
                expAt: 601_000,
                staleAt: 1000 + delay,
            })),
        );
        expect(random).toHaveBeenCalledTimes(3);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('anchors L2 adoption to creation time instead of read time and get accepts a local override', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const raw = new MapStore<number>();
        raw.set('x', { value: 1, time: 0, expAt: 600_000 });
        const primary = new MapStore<number>();
        const cache = new FlashCache(primary, raw, { ttl: 600_000, staleAfter: 60_000, namespace: false });
        vi.setSystemTime(110_000);
        expect(cache.get('x', { staleAfter: () => 120_000 })).toBe(1);
        expect(primary.get('x')).toEqual({ value: 1, time: 0, staleAt: 120_000, expAt: 600_000 });
        expect(raw.get('x')).toEqual({ value: 1, time: 0, expAt: 600_000 });
        vi.setSystemTime(120_000);
        const factory = vi.fn(() => 2);
        expect(cache.getOrSet('x', factory)).toBe(1);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('does not resample or extend deadlines after failed refreshes of the same L2 snapshot', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const raw = new MapStore<number>();
        const primary = new MapStore<number>();
        const staleAfter = vi.fn(() => 60_000);
        const onError = vi.fn();
        const cache = new FlashCache(primary, raw, { ttl: 600_000, staleAfter, namespace: false, onError });
        cache.set('x', 1);
        const snapshot = primary.get('x');
        vi.setSystemTime(61_000);
        const fail = vi.fn(() => {
            throw new Error('source');
        });
        for (let i = 0; i < 3; i++) expect(cache.getOrSet('x', fail)).toBe(1);
        expect(primary.get('x')).toBe(snapshot);
        expect(staleAfter).toHaveBeenCalledTimes(1);
        expect(fail).toHaveBeenCalledTimes(3);
        expect(onError).toHaveBeenCalledTimes(3);
        vi.setSystemTime(601_000);
        expect(() => cache.getOrSet('x', fail)).toThrow('source');
    });

    it('caps a local deadline at the original hard expiry', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const raw = new MapStore<number>();
        const primary = new MapStore<number>();
        const cache = new FlashCache(primary, raw, { ttl: 1000, staleAfter: 120_000, namespace: false });
        cache.set('x', 1);
        expect(primary.get('x')).toEqual({ value: 1, time: 1000, expAt: 2000, staleAt: 2000 });
        vi.setSystemTime(2000);
        expect(cache.get('x')).toBeUndefined();
        expect(cache.getOrSet('x', () => 2)).toBe(2);
    });

    it('uses first caller TTL, codec and local policy for a shared load', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const cache = new FlashCache(primary, new MapStore<number>(), {
            ttl: 1000,
            staleAfter: 500,
            namespace: false,
        });
        let resolve!: (value: number) => void;
        const first = cache.getOrSet(
            'x',
            () =>
                new Promise<number>((done) => {
                    resolve = done;
                }),
            { ttl: 300, staleAfter: 60 },
        );
        const otherFactory = vi.fn(() => 2);
        const otherPolicy = vi.fn(() => 900);
        const second = cache.getOrSet('x', otherFactory, { ttl: 900, staleAfter: otherPolicy });
        resolve(1);
        expect(await Promise.all([first, second])).toEqual([1, 1]);
        expect(primary.get('x')).toEqual({ value: 1, time: 1000, expAt: 1300, staleAt: 1060 });
        expect(otherFactory).not.toHaveBeenCalled();
        expect(otherPolicy).not.toHaveBeenCalled();
    });

    it('applies call options to new snapshots without changing existing deadlines or L2 expiry', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const cache = new FlashCache(primary, secondary, { ttl: 1000, staleAfter: 500, namespace: false });
        cache.set('x', 1, { ttl: 200, staleAfter: 150 });
        expect(cache.getOrSet('x', () => 2, { staleAfter: NaN })).toBe(1);
        primary.clear();
        vi.setSystemTime(1050);
        expect(cache.getOrSet('x', () => 2, { ttl: 9999, staleAfter: 100 })).toBe(1);
        expect(primary.get('x')).toEqual({ value: 1, time: 1000, staleAt: 1100, expAt: 1200 });
        expect(secondary.get('x')).toEqual({ value: 1, time: 1000, expAt: 1200 });
        cache.set('y', 3, { ttl: 400, staleAfter: 100 });
        expect(primary.get('y')).toEqual({ value: 3, time: 1050, staleAt: 1150, expAt: 1450 });
    });

    it.each([-1, 0.5, NaN, Infinity, -Infinity])('rejects invalid local delay results (%s)', (delay) => {
        const raw = new MapStore<number>();
        const primary = new MapStore<number>();
        const cache = new FlashCache(primary, raw, { ttl: 1000, staleAfter: 500, namespace: false });
        expect(() => cache.set('x', 1, { staleAfter: () => delay })).toThrow('staleAfter');
        expect(primary.size).toBe(0);
        expect(raw.size).toBe(0);
        expect(cache.getOrSet('x', () => 1)).toBe(1);
    });

    it('does not restore a deleted entry from a pending direct get', async () => {
        let resolve!: (value: StoreValue<number>) => void;
        const primary = new MapStore<number>();
        const secondary = {
            get: () =>
                new Promise<StoreValue<number>>((done) => {
                    resolve = done;
                }),
            set: vi.fn(),
            delete: vi.fn(),
        };
        const cache = new FlashCache(primary, secondary, { ttl: 1000, staleAfter: 500, namespace: false });
        const pending = cache.get('x');
        cache.delete('x');
        resolve({ value: 1, time: Date.now(), expAt: Date.now() + 2000 });
        expect(await pending).toBe(1);
        expect(primary.has('x')).toBe(false);
        expect(secondary.set).not.toHaveBeenCalled();
    });

    it.each(['publish', 'get', 'getOrSet'] as const)(
        'does not republish after a staleAfter callback deletes the key (%s)',
        (stage) => {
            const primary = new MapStore<number>();
            const secondary = new MapStore<number>();
            const cache = new FlashCache(primary, secondary, { ttl: 1000, staleAfter: 500, namespace: false });
            secondary.set('x', { value: 1, time: Date.now(), expAt: Date.now() + 1000 });
            const staleAfter = vi.fn(() => {
                cache.delete('x');
                return 500;
            });
            if (stage === 'publish') cache.set('x', 1, { staleAfter });
            else if (stage === 'get') expect(cache.get('x', { staleAfter })).toBe(1);
            else expect(cache.getOrSet('x', () => 2, { staleAfter })).toBe(1);
            expect(staleAfter).toHaveBeenCalledTimes(1);
            expect(primary.has('x')).toBe(false);
            expect(secondary.has('x')).toBe(false);
        },
    );

    it.each([0, -1, 0.5, NaN, Infinity, -Infinity])(
        'rejects invalid TTL consistently before factory or writes (%s)',
        (ttl) => {
            const primary = new MapStore<number>();
            const secondary = new MapStore<number>();
            const error = 'ttl must be a positive integer in milliseconds';
            expect(() => new FlashCache(primary, secondary, { ttl, staleAfter: 500 })).toThrow(error);
            const cache = new FlashCache(primary, secondary, { ttl: 1000, staleAfter: 500, namespace: false });
            const factory = vi.fn(() => 1);
            expect(() => cache.getOrSet('x', factory, { ttl })).toThrow(error);
            expect(() => cache.set('y', 2, { ttl })).toThrow(error);
            expect(factory).not.toHaveBeenCalled();
            expect(primary.size).toBe(0);
            expect(secondary.size).toBe(0);
            expect(cache.getOrSet('x', factory)).toBe(1);
        },
    );

    it.each([-1, 0.5, NaN, Infinity])('rejects invalid numeric overrides before factory (%s)', (staleAfter) => {
        const cache = new FlashCache(new MapStore<number>(), new MapStore<number>(), {
            ttl: 1000,
            staleAfter: 500,
            namespace: false,
        });
        const factory = vi.fn(() => 1);
        expect(() => cache.getOrSet('x', factory, { staleAfter })).toThrow('staleAfter');
        expect(factory).not.toHaveBeenCalled();
    });

    it('returns stale while two overlapping pods refresh without a distributed lock', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const raw = new MapStore<number>();
        const pods = [60_000, 60_001].map(
            (staleAfter) => new FlashCache(new MapStore<number>(), raw, { ttl: 600_000, staleAfter, namespace: false }),
        );
        for (const pod of pods) pod.getOrSet('x', () => 1);
        vi.setSystemTime(61_001);
        const resolves: ((value: number) => void)[] = [];
        const factory = vi.fn(() => new Promise<number>((resolve) => resolves.push(resolve)));
        for (const pod of pods) expect(pod.getOrSet('x', factory)).toBe(1);
        expect(factory).toHaveBeenCalledTimes(2);
        for (const resolve of resolves) resolve(2);
        await Promise.resolve();
        for (const pod of pods) expect(pod.get('x')).toBe(2);
    });

    it('isolates the new namespace without reading legacy shared-staleAt entries', () => {
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        secondary.set('flashCache:v2:x', { value: 9, time: Date.now(), expAt: Date.now() + 1000 });
        for (const namespace of [undefined, 'alpha', 'beta', false] as const) {
            const cache = new FlashCache(primary, secondary, { ttl: 1000, staleAfter: 500, namespace });
            if (namespace === undefined) expect(cache.get('x')).toBeUndefined();
            cache.set('x', namespace === 'alpha' ? 1 : 2);
        }
        expect([...primary.keys()]).toEqual(['flashCache:v3:x', 'flashCache:v3:alpha:x', 'flashCache:v3:beta:x', 'x']);
        expect(primary.get('flashCache:v3:alpha:x')?.value).toBe(1);
    });
});
