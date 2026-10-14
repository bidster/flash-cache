import {afterEach, describe, expect, it, vi} from 'vitest';
import {FlashCache, MapStore, type StoreValue} from './index';

afterEach(() => vi.useRealTimers());

describe('cache lifetime and refresh', () => {
    it.each([0, 0.5, 1])('respects exact stale and expiry boundaries (ratio=%s)', async staleRatio => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const cache = new FlashCache(primary, secondary, {ttl: 1000, staleRatio, namespace: false});
        cache.set('x', 1);
        expect(primary.get('x')).toEqual({value: 1, time: 1000, staleAt: 1000 + 1000 * staleRatio, expAt: 2000});
        let resolve!: (value: number) => void;
        const factory = vi.fn(() => new Promise<number>(done => { resolve = done; }));
        vi.setSystemTime(1000 + 1000 * staleRatio);
        const result = cache.getOrSet('x', factory);
        if (staleRatio === 1) expect(result).toBeInstanceOf(Promise);
        else expect(result).toBe(1);
        expect(factory).toHaveBeenCalledTimes(1);
        vi.setSystemTime(2000);
        expect(cache.get('x')).toBeUndefined();
        const waiting = cache.getOrSet('x', factory);
        resolve(2);
        expect(await waiting).toBe(2);
        expect(await result).toBe(staleRatio === 1 ? 2 : 1);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('applies custom TTL only to new values and preserves L2 timestamps', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const cache = new FlashCache(primary, secondary, {ttl: 1000, staleRatio: 0.5, namespace: false});
        cache.getOrSet('x', () => 1, {customTtl: 200});
        expect(secondary.get('x')).toEqual({value: 1, time: 1000, staleAt: 1100, expAt: 1200});
        primary.clear();
        vi.setSystemTime(1050);
        expect(cache.getOrSet('x', () => 2, {customTtl: NaN})).toBe(1);
        expect(primary.get('x')).toEqual(secondary.get('x'));
        cache.set('y', 3, {customTtl: 400});
        expect(primary.get('y')?.expAt).toBe(1450);
    });

    it('uses the first caller factory and TTL for a shared load', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const cache = new FlashCache(primary, new MapStore<number>(), {ttl: 1000, staleRatio: 0.5, namespace: false});
        let resolve!: (value: number) => void;
        const first = cache.getOrSet('x', () => new Promise<number>(done => { resolve = done; }), {customTtl: 300});
        const otherFactory = vi.fn(() => 2);
        const second = cache.getOrSet('x', otherFactory, {customTtl: 900});
        resolve(1);
        expect(await Promise.all([first, second])).toEqual([1, 1]);
        expect(primary.get('x')?.expAt).toBe(1300);
        expect(otherFactory).not.toHaveBeenCalled();
    });

    it('isolates namespaces and supports disabling the prefix', () => {
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        for (const namespace of [undefined, 'alpha', 'beta', false] as const) {
            const cache = new FlashCache(primary, secondary, {ttl: 1000, staleRatio: 1, namespace});
            cache.set('x', namespace === 'alpha' ? 1 : 2);
        }
        expect([...primary.keys()]).toEqual(['flashCache:v2:x', 'flashCache:v2:alpha:x', 'flashCache:v2:beta:x', 'x']);
        expect(primary.get('flashCache:v2:alpha:x')?.value).toBe(1);
        expect(secondary.size).toBe(4);
    });

    it('retries after failed background refresh without extending the stale entry', async () => {
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const stale = {value: 1, time: 1, staleAt: 2, expAt: Date.now() + 60_000};
        primary.set('x', stale);
        const onError = vi.fn();
        const cache = new FlashCache(primary, secondary, {ttl: 1000, staleRatio: 0.5, namespace: false, onError});
        expect(cache.getOrSet('x', async () => { throw new Error('source'); })).toBe(1);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(primary.get('x')).toBe(stale);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(cache.getOrSet('x', () => 2)).toBe(1);
        expect(cache.get('x')).toBe(2);
    });

    it('does not duplicate a handled L2 error as a refresh error', async () => {
        const primary = new MapStore<number>();
        primary.set('x', {value: 1, time: 1, staleAt: 2, expAt: Date.now() + 60_000});
        const failure = new Error('offline');
        const onError = vi.fn();
        const secondary = {get: async () => { throw failure; }, set: async () => { throw failure; }, delete: async () => {}};
        const cache = new FlashCache(primary, secondary, {ttl: 1000, staleRatio: 0.5, namespace: false, onError});
        expect(cache.getOrSet('x', () => 2)).toBe(1);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(onError.mock.calls.map(call => call[1].operation)).toEqual(['l2.get', 'l2.set']);
        expect(cache.get('x')).toBe(2);
    });

    it('does not restore a deleted entry from a pending direct get', async () => {
        let resolve!: (value: StoreValue<number>) => void;
        const primary = new MapStore<number>();
        const secondary = {get: () => new Promise<StoreValue<number>>(done => { resolve = done; }), set: vi.fn(), delete: vi.fn()};
        const cache = new FlashCache(primary, secondary, {ttl: 1000, staleRatio: 0.5, namespace: false});
        const read = cache.get('x');
        cache.delete('x');
        resolve({value: 1, time: 1, staleAt: Date.now() + 1000, expAt: Date.now() + 2000});
        expect(await read).toBe(1);
        expect(primary.has('x')).toBe(false);
        expect(secondary.set).not.toHaveBeenCalled();
    });
});
