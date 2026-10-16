import { describe, expect, it, vi } from 'vitest';
import { FlashCache, MapStore, type Codec, type StoreValue } from './index';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const setCodec: Codec<Set<string>, string[]> = {
    serialize: (value) => [...value],
    deserialize: (value) => new Set(value),
};

function entry(value: string[], stale = false): StoreValue<string[]> {
    const time = Date.now();
    return { value, time, staleAt: stale ? 0 : time + 30_000, expAt: time + 60_000 };
}

describe('per-call codec', () => {
    it.each([false, true])(
        'converts only at L2, preserves metadata and restores Set (async=%s)',
        async (asyncStore) => {
            const primary = new MapStore<Set<string>>();
            const raw = new MapStore<string[]>();
            const secondary = asyncStore
                ? {
                      get: async (key: string) => raw.get(key),
                      set: async (key: string, value: StoreValue<string[]>) => {
                          raw.set(key, value);
                      },
                      delete: async (key: string) => {
                          raw.delete(key);
                      },
                  }
                : raw;
            const cache = new FlashCache(primary, secondary, { ttl: 60_000, staleRatio: 0.5, namespace: false });
            const codec = { serialize: vi.fn(setCodec.serialize), deserialize: vi.fn(setCodec.deserialize) };
            const original = new Set(['a', 'b']);
            const loaded = cache.getOrSet('x', () => original, { codec });
            expect(loaded instanceof Promise).toBe(asyncStore);
            expect(await loaded).toBe(original);
            const metadata = primary.get('x')!;
            expect(raw.get('x')).toEqual({ ...metadata, value: ['a', 'b'] });
            expect(codec.serialize).toHaveBeenCalledExactlyOnceWith(original);
            expect(codec.deserialize).not.toHaveBeenCalled();
            expect(cache.get('x', { codec })).toBe(original);
            expect(cache.getOrSet('x', async () => new Set<string>(), { codec })).toBe(original);
            expect(codec.serialize).toHaveBeenCalledTimes(1);
            expect(codec.deserialize).not.toHaveBeenCalled();
            primary.clear();
            const read = cache.get('x', { codec });
            expect(read instanceof Promise).toBe(asyncStore);
            const restored = await read;
            expect(restored).toEqual(original);
            expect(restored).not.toBe(original);
            expect(primary.get('x')).toEqual({ ...metadata, value: restored });
            expect(codec.deserialize).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
            const written = cache.set('x', new Set(['c']), { codec });
            expect(written instanceof Promise).toBe(asyncStore);
            await written;
            expect(raw.get('x')?.value).toEqual(['c']);
            await cache.delete('x');
            expect(await cache.get('x', { codec })).toBeUndefined();
            expect(codec.deserialize).toHaveBeenCalledTimes(1);
        },
    );

    it('uses different representations on different keys without registering codecs', () => {
        const raw = new MapStore<unknown>();
        const cache = new FlashCache(new MapStore<Set<string>>(), raw, {
            ttl: 60_000,
            staleRatio: 0.5,
            namespace: false,
        });
        const stringCodec = {
            serialize: (value: Set<string>) => [...value].join(','),
            deserialize: (value: string) => new Set(value.split(',')),
        };
        cache.set('array', new Set(['a', 'b']), { codec: setCodec });
        cache.set('string', new Set(['a', 'b']), { codec: stringCodec });
        expect(raw.get('array')?.value).toEqual(['a', 'b']);
        expect(raw.get('string')?.value).toBe('a,b');
    });

    it.each(['miss', 'stale'] as const)('uses the first codec throughout a shared %s load', async (state) => {
        const read = deferred<StoreValue<string[]> | undefined>();
        const loaded = deferred<Set<string>>();
        const secondary = { get: vi.fn(() => read.promise), set: vi.fn(), delete: vi.fn() };
        const cache = new FlashCache(new MapStore<Set<string>>(), secondary, {
            ttl: 60_000,
            staleRatio: 0.5,
            namespace: false,
        });
        const firstCodec = { serialize: vi.fn(setCodec.serialize), deserialize: vi.fn(setCodec.deserialize) };
        const otherCodec = { serialize: vi.fn(setCodec.serialize), deserialize: vi.fn(setCodec.deserialize) };
        const cloneValue = vi.fn((value: Set<string>) => new Set(value));
        const factory = vi.fn(() => loaded.promise);
        const first = cache.getOrSet('x', factory, { codec: firstCodec });
        const joined = cache.getOrSet('x', factory, { codec: otherCodec, cloneValue });
        read.resolve(state === 'stale' ? entry(['old'], true) : undefined);
        if (state === 'stale') {
            const [a, b] = await Promise.all([first, joined]);
            expect(a).toEqual(new Set(['old']));
            expect(b).toEqual(a);
            expect(b).not.toBe(a);
            expect(firstCodec.serialize).not.toHaveBeenCalled();
        }
        const updated = new Set(['new']);
        loaded.resolve(updated);
        await loaded.promise;
        if (state === 'miss') {
            const [a, b] = await Promise.all([first, joined]);
            expect(a).toBe(updated);
            expect(b).toEqual(updated);
            expect(b).not.toBe(updated);
        }
        expect(factory).toHaveBeenCalledTimes(1);
        expect(secondary.get).toHaveBeenCalledTimes(1);
        expect(firstCodec.deserialize).toHaveBeenCalledTimes(state === 'stale' ? 1 : 0);
        expect(firstCodec.serialize).toHaveBeenCalledExactlyOnceWith(updated);
        expect(otherCodec.serialize).not.toHaveBeenCalled();
        expect(otherCodec.deserialize).not.toHaveBeenCalled();
        expect(cloneValue).toHaveBeenCalledTimes(1);
        expect(secondary.set).toHaveBeenCalledExactlyOnceWith('x', expect.objectContaining({ value: ['new'] }));
    });

    it.each(['read', 'factory'] as const)('does not republish a detached %s result', async (stage) => {
        const read = deferred<StoreValue<string[]> | undefined>();
        const loaded = deferred<Set<string>>();
        const secondary = { get: () => (stage === 'read' ? read.promise : undefined), set: vi.fn(), delete: vi.fn() };
        const cache = new FlashCache(new MapStore<Set<string>>(), secondary, { ttl: 60_000, staleRatio: 0.5 });
        const codec = { serialize: vi.fn(setCodec.serialize), deserialize: vi.fn(setCodec.deserialize) };
        const old = cache.getOrSet('x', () => loaded.promise, { codec });
        const replacement = new Set(['replacement']);
        cache.set('x', replacement, { codec: setCodec });
        if (stage === 'read') read.resolve(entry(['old']));
        else loaded.resolve(new Set(['old']));
        expect(await old).toEqual(new Set(['old']));
        expect(cache.get('x', { codec })).toBe(replacement);
        expect(codec.serialize).not.toHaveBeenCalled();
        expect(secondary.set).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['getOrSet', 'set'],
        ['getOrSet', 'delete'],
        ['set', 'set'],
        ['set', 'delete'],
    ] as const)('prevents an L2 write when %s serialize reenters through %s', (method, mutation) => {
        const primary = new MapStore<Set<string>>();
        const secondary = { get: () => undefined, set: vi.fn(), delete: vi.fn() };
        const cache = new FlashCache(primary, secondary, { ttl: 60_000, staleRatio: 0.5, namespace: false });
        const replacement = new Set(['new']);
        const original = new Set(['old']);
        const options = {
            codec: {
                serialize: (value: Set<string>) => {
                    if (mutation === 'set') cache.set('x', replacement, { codec: setCodec });
                    else cache.delete('x');
                    return [...value];
                },
                deserialize: setCodec.deserialize,
            },
        };
        const result =
            method === 'set' ? cache.set('x', original, options) : cache.getOrSet('x', () => original, options);
        expect(result).toBe(method === 'set' ? undefined : original);
        expect(primary.get('x')?.value).toBe(mutation === 'set' ? replacement : undefined);
        expect(secondary.set).toHaveBeenCalledTimes(mutation === 'set' ? 1 : 0);
        if (mutation === 'set')
            expect(secondary.set).toHaveBeenCalledWith('x', expect.objectContaining({ value: ['new'] }));
    });

    it('does not deserialize expired entries', () => {
        const raw = new MapStore<string[]>();
        raw.set('x', { ...entry(['old']), expAt: 0 });
        const cache = new FlashCache(new MapStore<Set<string>>(), raw, {
            ttl: 60_000,
            staleRatio: 0.5,
            namespace: false,
        });
        const codec = { serialize: vi.fn(setCodec.serialize), deserialize: vi.fn(setCodec.deserialize) };
        expect(cache.get('x', { codec })).toBeUndefined();
        const fresh = new Set(['new']);
        expect(cache.getOrSet('x', () => fresh, { codec })).toBe(fresh);
        expect(codec.deserialize).not.toHaveBeenCalled();
    });
});
