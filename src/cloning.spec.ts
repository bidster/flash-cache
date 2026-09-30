import {describe, expect, it, vi} from 'vitest';
import {FlashCache} from './flash-cache';
import {FlashMemo} from './flash-memo';
import {MapStore} from './stores/map-store';

describe('cache references and memo cloning', () => {
    it.each([false, true])('cache returns shared references from L1 and L2 (readL2=%s)', async (readL2) => {
        const value = {count: 1};
        const l1 = new MapStore<typeof value>();
        const cache = new FlashCache(l1, new MapStore<typeof value>(), {ttl: 60_000, staleRatio: 0.5});
        await cache.set('key', value);
        if (readL2) l1.clear();
        const result = await cache.get('key');
        expect(result.value).toBe(value);
        result.value!.count = 2;
        expect((await cache.get('key')).value!.count).toBe(2);
    });

    it.each([false, true])('memo clones stale values during background refresh (readL2=%s)', async (readL2) => {
        const value = {nested: {count: 1}};
        const l1 = new MapStore<typeof value>();
        const l2 = new MapStore<typeof value>();
        const cache = new FlashCache(l1, l2, {ttl: 60_000, staleRatio: 0.5, namespace: false});
        await cache.set('key', value);
        l1.get('key')!.staleAt = 0;
        l2.get('key')!.staleAt = 0;
        if (readL2) l1.clear();
        let resolve!: (nextValue: typeof value) => void;
        const pending = new Promise<typeof value>((done) => { resolve = done; });
        let markStarted!: () => void;
        const started = new Promise<void>((done) => { markStarted = done; });
        const loader = vi.fn(() => { markStarted(); return pending; });
        const memo = new FlashMemo(cache);
        const result = await memo.memoize('key', loader);
        result.nested.count = 99;
        expect(value.nested.count).toBe(1);
        await started;
        expect(loader).toHaveBeenCalledTimes(1);
        resolve({nested: {count: 2}});
        await pending;
    });

    it.each(['fresh-l1', 'stale-l1', 'fresh-l2', 'stale-l2', 'expired-l2'])(
        'cache preserves nested value references returned from %s', async (state) => {
            const l1 = new MapStore<{nested: {count: number}}>();
            const l2 = new MapStore<{nested: {count: number}}>();
            const cache = new FlashCache(l1, l2, {ttl: 60_000, staleRatio: 0.5, namespace: false});
            const original = {nested: {count: 1}};
            await cache.set('key', original);
            for (const store of [l1, l2]) {
                const entry = store.get('key')!;
                if (state.startsWith('stale')) entry.staleAt = 0;
                if (state.startsWith('expired')) entry.expAt = 0;
            }
            if (state.endsWith('l2')) l1.clear();

            const read = cache.get('key');
            expect(read instanceof Promise).toBe(state.endsWith('l2'));
            const result = await read;
            expect(result.state).toBe(state === 'stale-l1' ? 'revalidating' : state.split('-')[0]);
            expect(result.value).toBe(original);
            result.value!.nested.count = 99;
            expect(original.nested.count).toBe(99);
            expect((await cache.get('key')).value).toBe(original);
        },
    );

    it('retains the input reference on writes', async () => {
        const cache = new FlashCache(new MapStore<{count: number}>(), new MapStore<{count: number}>(), {
            ttl: 60_000, staleRatio: 0.5,
        });
        const original = {count: 1};
        await cache.set('key', original);
        original.count = 2;
        expect((await cache.get('key')).value).toEqual({count: 2});
    });

    it('memo clones deserialized values and separates concurrent L2 readers', async () => {
        const value = {nested: {count: 1}};
        const l1 = new MapStore<typeof value>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache(l1, l2, {ttl: 60_000, staleRatio: 0.5});
        await cache.set('key', value, JSON.stringify);
        l1.clear();
        const memo = new FlashMemo(cache);
        const options = {
            serialize: JSON.stringify,
            deserialize: vi.fn((stored: string) => JSON.parse(stored) as typeof value),
        };
        const loader = vi.fn(() => value);
        const [first, second] = await Promise.all([
            memo.memoize('key', loader, options), memo.memoize('key', loader, options),
        ]);
        first.nested.count = 99;
        expect(second.nested.count).toBe(1);
        second.nested.count = 42;
        expect((await cache.get('key', options.deserialize)).value!.nested.count).toBe(1);
        expect(loader).not.toHaveBeenCalled();
    });

    it('memo clones built-in collections, dates and cyclic objects', async () => {
        const value = {map: new Map([['key', {count: 1}]]), set: new Set([1]), date: new Date(0), bytes: new Uint8Array([1]), self: null as unknown};
        value.self = value;
        const cache = new FlashCache(new MapStore<typeof value>(), new MapStore<typeof value>(), {ttl: 60_000, staleRatio: 0.5});
        await cache.set('key', value);
        const memo = new FlashMemo(cache);
        const copy = await memo.memoize('key', () => value);
        expect(copy.self).toBe(copy);
        copy.map.get('key')!.count = 2;
        copy.set.add(2);
        copy.date.setTime(10);
        copy.bytes[0] = 2;
        expect(value.map.get('key')!.count).toBe(1);
        expect(value.set.size).toBe(1);
        expect(value.date.getTime()).toBe(0);
        expect(value.bytes[0]).toBe(1);
    });

    it.each([null, 'text', 42, false, 1n, Symbol('key')])('returns primitive %s unchanged', async (value) => {
        const cache = new FlashCache(new MapStore<typeof value>(), new MapStore<typeof value>(), {ttl: 60_000, staleRatio: 0.5});
        await cache.set('key', value);
        expect((await cache.get('key')).value).toBe(value);
        expect(await new FlashMemo(cache).memoize('key', () => value)).toBe(value);
        expect(await cache.get('missing')).toEqual({value: undefined, state: 'miss'});
    });

    it('cache accepts non-cloneable values while memo propagates clone errors', async () => {
        const l1 = new MapStore<{fn: () => void}>();
        const cache = new FlashCache(l1, new MapStore<{fn: () => void}>(), {ttl: 60_000, staleRatio: 0.5});
        const value = {fn: () => undefined};
        await cache.set('key', value);
        expect((await cache.get('key')).value).toBe(value);
        l1.clear();
        expect((await cache.get('key')).value).toBe(value);

        const memo = new FlashMemo(cache);
        expect(() => memo.memoize('key', () => value)).toThrow();
        l1.clear();
        await expect(memo.memoize('key', () => value)).rejects.toThrow();
        await expect(memo.memoize('missing', () => value)).rejects.toThrow();
        expect(await memo.memoize('key', () => value, {useClones: false})).toBe(value);
    });

    it.each([undefined, true, false])('memo controls cloning per call (useClones=%s)', async (useClones) => {
        const value = {nested: {count: 1}};
        const l1 = new MapStore<typeof value>();
        const cache = new FlashCache(l1, new MapStore<typeof value>(), {ttl: 60_000, staleRatio: 0.5});
        const memo = new FlashMemo(cache);
        const loader = vi.fn(() => value);
        const options = {useClones};
        const expectedCloning = useClones ?? true;
        const first = await memo.memoize('key', loader, options);
        expect(first === value).toBe(!expectedCloning);
        const hit = memo.memoize('key', loader, options);
        expect(hit).not.toBeInstanceOf(Promise);
        expect(hit === value).toBe(!expectedCloning);

        l1.clear();
        const l2Hit = await memo.memoize('key', loader, options);
        expect(l2Hit === value).toBe(!expectedCloning);
        expect(loader).toHaveBeenCalledTimes(1);

        for (const key of ['key', 'another-miss']) {
            const overridden = await memo.memoize(key, loader, {useClones: !expectedCloning});
            expect(overridden === value).toBe(expectedCloning);
        }
        expect((await cache.get('key')).value).toBe(value);
    });

    it('gives concurrent memo callers independent loader results', async () => {
        const value = {nested: {count: 1}};
        const cache = new FlashCache(new MapStore<typeof value>(), new MapStore<typeof value>(), {ttl: 60_000, staleRatio: 0.5});
        const memo = new FlashMemo(cache);
        const loader = vi.fn(async () => value);
        const [first, second, shared] = await Promise.all([
            memo.memoize('key', loader), memo.memoize('key', loader),
            memo.memoize('key', loader, {useClones: false}),
        ]);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(shared).toBe(value);
        first.nested.count = 99;
        expect(second.nested.count).toBe(1);
        expect(value.nested.count).toBe(1);
        second.nested.count = 42;
        expect((await memo.memoize('key', loader)).nested.count).toBe(1);
    });
});
