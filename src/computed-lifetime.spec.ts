import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlashCache, MapStore } from './index';

afterEach(() => vi.useRealTimers());

describe('computed snapshot lifetime', () => {
    it('samples TTL once when a shared factory publishes, not on construction, hits or pending loads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const ttl = vi.fn().mockReturnValueOnce(4000).mockReturnValueOnce(8000);
        const staleAfter = vi.fn((duration: number) => duration / 2);
        const cache = new FlashCache(primary, secondary, { ttl, staleAfter, namespace: false });
        expect(ttl).not.toHaveBeenCalled();
        let finish!: (value: number) => void;
        const factory = vi.fn(
            () =>
                new Promise<number>((resolve) => {
                    finish = resolve;
                }),
        );
        const first = cache.getOrSet('x', factory);
        const ignoredTtl = vi.fn(() => 9999);
        const second = cache.getOrSet('x', factory, { ttl: ignoredTtl });
        expect(ttl).not.toHaveBeenCalled();
        vi.setSystemTime(5000);
        finish(1);
        expect(await Promise.all([first, second])).toEqual([1, 1]);
        expect(ttl).toHaveBeenCalledTimes(1);
        expect(ignoredTtl).not.toHaveBeenCalled();
        expect(staleAfter).toHaveBeenCalledExactlyOnceWith(4000);
        expect(primary.get('x')).toEqual({ value: 1, time: 5000, staleAt: 7000, expAt: 9000 });
        expect(secondary.get('x')).toEqual({ value: 1, time: 5000, expAt: 9000 });
        expect(cache.get('x')).toBe(1);
        expect(cache.getOrSet('x', () => 2)).toBe(1);
        expect(ttl).toHaveBeenCalledTimes(1);
        cache.set('y', 2);
        expect(ttl).toHaveBeenCalledTimes(2);
        expect(staleAfter).toHaveBeenLastCalledWith(8000);
        expect(secondary.get('y')).toEqual({ value: 2, time: 5000, expAt: 13000 });
    });

    it.each(['get', 'getOrSet'] as const)(
        'uses the original snapshot TTL on L2 %s without evaluating any TTL policy',
        (method) => {
            vi.useFakeTimers();
            vi.setSystemTime(2000);
            const primary = new MapStore<number>();
            const secondary = new MapStore<number>();
            const stored = { value: 1, time: 1000, expAt: 5000 };
            secondary.set('x', stored);
            const ttl = vi.fn(() => {
                throw new Error('must not sample on L2');
            });
            const override = vi.fn(() => {
                throw new Error('must not sample an override on L2');
            });
            const staleAfter = vi.fn((snapshotTtl: number) => snapshotTtl / 2);
            const cache = new FlashCache(primary, secondary, { ttl, staleAfter, namespace: false });
            const factory = vi.fn(() => 2);
            const result = method === 'get' ? cache.get('x') : cache.getOrSet('x', factory, { ttl: override });
            expect(result).toBe(1);
            expect(primary.get('x')).toEqual({ value: 1, time: 1000, expAt: 5000, staleAt: 3000 });
            expect(secondary.get('x')).toBe(stored);
            expect(staleAfter).toHaveBeenCalledExactlyOnceWith(4000);
            expect(ttl).not.toHaveBeenCalled();
            expect(override).not.toHaveBeenCalled();
            expect(factory).not.toHaveBeenCalled();
            cache.getOrSet('x', factory);
            expect(staleAfter).toHaveBeenCalledTimes(1);
        },
    );

    it('gives all pods the same effective TTL and independent local stale intervals', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const secondary = new MapStore<number>();
        const a = new MapStore<number>();
        const b = new MapStore<number>();
        const ttlA = vi.fn(() => 600_000);
        const ttlB = vi.fn(() => 1000);
        const afterA = vi.fn((ttl: number) => ttl / 10);
        const afterB = vi.fn((ttl: number) => ttl / 5);
        const early = new FlashCache(a, secondary, { ttl: ttlA, staleAfter: afterA, namespace: false });
        const later = new FlashCache(b, secondary, { ttl: ttlB, staleAfter: afterB, namespace: false });
        early.set('x', 1);
        later.getOrSet('x', () => 99);
        expect(afterA).toHaveBeenCalledExactlyOnceWith(600_000);
        expect(afterB).toHaveBeenCalledExactlyOnceWith(600_000);
        expect(ttlA).toHaveBeenCalledTimes(1);
        expect(ttlB).not.toHaveBeenCalled();
        expect(a.get('x')).toMatchObject({ staleAt: 61_000, expAt: 601_000 });
        expect(b.get('x')).toMatchObject({ staleAt: 121_000, expAt: 601_000 });
    });

    it('passes an odd TTL unchanged so a proportional policy can round to whole milliseconds', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const staleAfter = vi.fn((ttl: number) => Math.floor(ttl * 0.2));
        const cache = new FlashCache(primary, new MapStore<number>(), { ttl: () => 999, staleAfter, namespace: false });
        cache.set('x', 1);
        expect(staleAfter).toHaveBeenCalledExactlyOnceWith(999);
        expect(primary.get('x')).toEqual({ value: 1, time: 1000, expAt: 1999, staleAt: 1199 });
    });

    it('evaluates a new TTL for each refreshed snapshot and uses the call override', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const ttl = vi.fn(() => 1000);
        const override = vi.fn(() => 4000);
        const after = vi.fn((duration: number) => duration / 2);
        const cache = new FlashCache(primary, secondary, { ttl, staleAfter: after, namespace: false });
        cache.set('x', 1);
        vi.setSystemTime(1500);
        expect(cache.getOrSet('x', () => 2, { ttl: override })).toBe(1);
        expect(override).toHaveBeenCalledTimes(1);
        expect(ttl).toHaveBeenCalledTimes(1);
        expect(after.mock.calls).toEqual([[1000], [4000]]);
        expect(primary.get('x')).toEqual({ value: 2, time: 1500, expAt: 5500, staleAt: 3500 });
    });

    it.each([0, -1, 0.5, NaN, Infinity, -Infinity])(
        'rejects invalid computed TTL before publishing (%s)',
        (duration) => {
            const primary = new MapStore<number>();
            const secondary = new MapStore<number>();
            const ttl = vi.fn(() => duration);
            const staleAfter = vi.fn(() => 500);
            const cache = new FlashCache(primary, secondary, { ttl, staleAfter, namespace: false });
            expect(() => cache.set('x', 1)).toThrow('ttl must be a positive integer');
            const factory = vi.fn(() => 2);
            expect(() => cache.getOrSet('y', factory)).toThrow('ttl must be a positive integer');
            expect(factory).toHaveBeenCalledTimes(1);
            expect(ttl).toHaveBeenCalledTimes(2);
            expect(staleAfter).not.toHaveBeenCalled();
            expect(primary.size).toBe(0);
            expect(secondary.size).toBe(0);
            expect(cache.getOrSet('y', () => 3, { ttl: () => 1000 })).toBe(3);
        },
    );

    it('does not sample TTL for a failed factory or a detached factory result', async () => {
        const ttl = vi.fn(() => 1000);
        const cache = new FlashCache(new MapStore<number>(), new MapStore<number>(), { ttl, staleAfter: 500 });
        await expect(
            cache.getOrSet('x', async () => {
                throw new Error('source');
            }),
        ).rejects.toThrow('source');
        expect(ttl).not.toHaveBeenCalled();
        let finish!: (value: number) => void;
        const pending = cache.getOrSet(
            'x',
            () =>
                new Promise<number>((resolve) => {
                    finish = resolve;
                }),
        );
        cache.delete('x');
        finish(1);
        expect(await pending).toBe(1);
        expect(ttl).not.toHaveBeenCalled();
        expect(cache.get('x')).toBeUndefined();
    });

    it('retains the original snapshot deadlines if a TTL sampler throws during background refresh', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const onError = vi.fn();
        const cache = new FlashCache(primary, secondary, { ttl: 1000, staleAfter: 500, namespace: false, onError });
        cache.set('x', 1);
        const original = primary.get('x');
        vi.setSystemTime(1500);
        const error = new Error('TTL sampler');
        expect(
            cache.getOrSet('x', () => 2, {
                ttl: () => {
                    throw error;
                },
            }),
        ).toBe(1);
        expect(primary.get('x')).toBe(original);
        expect(secondary.get('x')).toEqual({ value: 1, time: 1000, expAt: 2000 });
        expect(onError).toHaveBeenCalledExactlyOnceWith(error, { key: 'x', operation: 'refresh' });
        vi.setSystemTime(2000);
        expect(cache.get('x')).toBeUndefined();
    });

    it('does not overwrite a nested set performed by a TTL callback', () => {
        const primary = new MapStore<number>();
        const secondary = new MapStore<number>();
        const cache = new FlashCache(primary, secondary, { ttl: 1000, staleAfter: 500, namespace: false });
        const staleAfter = vi.fn(() => 500);
        cache.set('x', 1, {
            ttl: () => {
                cache.set('x', 2);
                return 1000;
            },
            staleAfter,
        });
        expect(cache.get('x')).toBe(2);
        expect(secondary.get('x')?.value).toBe(2);
        expect(staleAfter).not.toHaveBeenCalled();
    });

    it('shares a TTL sampling failure with callers waiting for one async load', async () => {
        const error = new Error('TTL sampler');
        const ttl = vi.fn(() => {
            throw error;
        });
        const cache = new FlashCache(new MapStore<number>(), new MapStore<number>(), { ttl, staleAfter: 500 });
        let finish!: (value: number) => void;
        const first = cache.getOrSet(
            'x',
            () =>
                new Promise<number>((resolve) => {
                    finish = resolve;
                }),
        );
        const second = cache.getOrSet('x', () => 2);
        finish(1);
        expect(await Promise.allSettled([first, second])).toEqual([
            { status: 'rejected', reason: error },
            { status: 'rejected', reason: error },
        ]);
        expect(ttl).toHaveBeenCalledTimes(1);
    });
});
