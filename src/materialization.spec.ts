import {describe, expect, it, vi} from 'vitest';
import {FlashCache} from './flash-cache';
import {FlashMemo} from './flash-memo';
import {MapStore} from './stores/map-store';

type UserData = {name: string; preferences: {theme: string}};

class User {
    #prefix = 'Hello';

    constructor(readonly data: UserData) {}

    greeting() {
        return `${this.#prefix}, ${this.data.name}`;
    }
}

describe('memo result materialization', () => {
    it.each(['fresh-l1', 'stale-l1', 'fresh-l2', 'stale-l2', 'expired-l1', 'expired-l2', 'miss'])(
        'materializes an isolated copy from %s and keeps data in both stores', async (state) => {
            const l1 = new MapStore<UserData>();
            const l2 = new MapStore<string>();
            const cache = new FlashCache(l1, l2, {ttl: 60_000, staleRatio: 0.5, namespace: false});
            const original: UserData = {name: 'Igor', preferences: {theme: 'light'}};
            if (state !== 'miss') {
                await cache.set('user', original, JSON.stringify);
                for (const store of [l1, l2]) {
                    const entry = store.get('user')!;
                    if (state.startsWith('stale')) entry.staleAt = 0;
                    if (state.startsWith('expired')) entry.expAt = 0;
                }
                if (state.endsWith('l2')) l1.clear();
            }
            const materialize = vi.fn((data: UserData) => {
                data.preferences.theme = 'dark';
                return new User(data);
            });
            const read = new FlashMemo(cache).memoize('user', () => original, {
                serialize: JSON.stringify,
                deserialize: (stored): UserData => JSON.parse(stored),
                materialize,
            });
            expect(read instanceof Promise).toBe(!state.endsWith('l1') || state.startsWith('expired'));
            const user = await read;
            expect(user).toBeInstanceOf(User);
            expect(user.greeting()).toBe('Hello, Igor');
            expect(user.data.preferences.theme).toBe('dark');
            expect(user.data).not.toBe(original);
            expect(user.data.preferences).not.toBe(original.preferences);
            expect(original.preferences.theme).toBe('light');
            expect(l1.get('user')!.value).not.toBeInstanceOf(User);
            expect(l1.get('user')!.value.preferences.theme).toBe('light');
            expect(JSON.parse(l2.get('user')!.value).preferences.theme).toBe('light');
            expect(materialize).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['load', 'l2'])('materializes independently for concurrent callers sharing %s', async (source) => {
        const l1 = new MapStore<UserData>();
        const l2 = new MapStore<string>();
        const cache = new FlashCache(l1, l2, {ttl: 60_000, staleRatio: 1, namespace: false});
        const original: UserData = {name: 'Igor', preferences: {theme: 'light'}};
        if (source === 'l2') {
            await cache.set('user', original, JSON.stringify);
            l1.clear();
        }
        const loader = vi.fn(async () => original);
        const materialize = vi.fn((data: UserData) => new User(data));
        const options = {
            serialize: JSON.stringify,
            deserialize: (stored: string): UserData => JSON.parse(stored),
            materialize,
        };
        const memo = new FlashMemo(cache);
        const [first, second] = await Promise.all([
            memo.memoize('user', loader, options), memo.memoize('user', loader, options),
        ]);
        expect(first).not.toBe(second);
        expect(first.greeting()).toBe(second.greeting());
        first.data.preferences.theme = 'dark';
        expect(second.data.preferences.theme).toBe('light');
        expect(l1.get('user')!.value.preferences.theme).toBe('light');
        expect(materialize).toHaveBeenCalledTimes(2);
        expect(loader).toHaveBeenCalledTimes(source === 'load' ? 1 : 0);
    });

    it('uses each caller\'s materializer after a shared load', async () => {
        const cache = new FlashCache(new MapStore<string>(), new MapStore<string>(), {ttl: 60_000, staleRatio: 1});
        const memo = new FlashMemo(cache);
        const loader = vi.fn(async () => 'Igor');
        const [name, size] = await Promise.all([
            memo.memoize('user', loader, {materialize: (data) => ({name: data})}),
            memo.memoize('user', loader, {materialize: (data) => data.length}),
        ]);
        expect(name).toEqual({name: 'Igor'});
        expect(size).toBe(4);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(cache.get('user')).toEqual({state: 'fresh', value: 'Igor'});
    });

    it('passes shared data to the materializer when cloning is disabled', async () => {
        const original: UserData = {name: 'Igor', preferences: {theme: 'light'}};
        const cache = new FlashCache(new MapStore<UserData>(), new MapStore<UserData>(), {ttl: 60_000, staleRatio: 1});
        await cache.set('user', original);
        const user = new FlashMemo(cache).memoize('user', () => original, {
            useClones: false,
            materialize: (data) => new User(data),
        });
        if (user instanceof Promise) throw new Error('Expected a synchronous L1 hit');
        expect(user.data).toBe(original);
        user.data.preferences.theme = 'dark';
        expect(original.preferences.theme).toBe('dark');
    });

    it('isolates materialization errors between callers sharing a load', async () => {
        const cache = new FlashCache(new MapStore<string>(), new MapStore<string>(), {ttl: 60_000, staleRatio: 1});
        const memo = new FlashMemo(cache);
        const loader = vi.fn(async () => 'Igor');
        const failure = new Error('Materialization failed');
        const [failed, successful] = await Promise.allSettled([
            memo.memoize('user', loader, {materialize: () => { throw failure; }}),
            memo.memoize('user', loader, {materialize: (name) => ({name})}),
        ]);
        expect(failed).toEqual({status: 'rejected', reason: failure});
        expect(successful).toEqual({status: 'fulfilled', value: {name: 'Igor'}});
        expect(loader).toHaveBeenCalledTimes(1);
        expect(cache.get('user')).toEqual({state: 'fresh', value: 'Igor'});
    });

    it.each(['fresh-l1', 'stale-l1', 'fresh-l2', 'miss'])(
        'propagates materializer errors from %s without replacing cached data', async (state) => {
            const l1 = new MapStore<string>();
            const l2 = new MapStore<string>();
            const cache = new FlashCache(l1, l2, {ttl: 60_000, staleRatio: 0.5, namespace: false});
            if (state !== 'miss') {
                await cache.set('user', 'Igor');
                if (state === 'stale-l1') l1.get('user')!.staleAt = 0;
                if (state === 'fresh-l2') l1.clear();
            }
            const failure = new Error('Materialization failed');
            const read = () => new FlashMemo(cache).memoize('user', () => 'Igor', {
                materialize: () => { throw failure; },
            });
            if (state.endsWith('l1')) expect(read).toThrow(failure);
            else await expect(read()).rejects.toBe(failure);
            expect(l1.get('user')!.value).toBe('Igor');
            expect(l2.get('user')!.value).toBe('Igor');
        },
    );

    it('does not materialize data if cloning fails', async () => {
        const original = {fn: () => undefined};
        const cache = new FlashCache(new MapStore<typeof original>(), new MapStore<typeof original>(), {ttl: 60_000, staleRatio: 1});
        await cache.set('user', original);
        const materialize = vi.fn(() => 'result');
        expect(() => new FlashMemo(cache).memoize('user', () => original, {materialize})).toThrow();
        expect(materialize).not.toHaveBeenCalled();
    });
});
