import {describe, expect, it, vi} from 'vitest';
import {FlashCache, MapStore} from './index';

describe('reader cloning', () => {
    it.each(['fresh-l1', 'stale-l1', 'fresh-l2', 'stale-l2', 'miss'])('clones once for a reader from %s', async state => {
        const original = {nested: {value: 1}};
        const primary = new MapStore<typeof original>();
        const secondary = new MapStore<typeof original>();
        const cloneValue = vi.fn((value: typeof original) => structuredClone(value));
        const cache = new FlashCache(primary, secondary, {ttl: 60_000, staleRatio: 0.5, namespace: false, cloneValue});
        if (state !== 'miss') {
            const time = Date.now();
            const entry = {value: original, time, staleAt: state.startsWith('stale') ? 0 : time + 30_000, expAt: time + 60_000};
            (state.endsWith('l1') ? primary : secondary).set('x', entry);
        }
        const result = await cache.getOrSet('x', () => original);
        result.nested.value = 2;
        expect(original.nested.value).toBe(1);
        expect(cloneValue).toHaveBeenCalledTimes(1);
        expect(primary.get('x')?.value).toBe(original);
    });

    it('does not clone a miss from get or input values from set', () => {
        const cloneValue = vi.fn((value: {value: number}) => structuredClone(value));
        const primary = new MapStore<{value: number}>();
        const cache = new FlashCache(primary, new MapStore<{value: number}>(), {ttl: 1000, staleRatio: 1, namespace: false, cloneValue});
        expect(cache.get('missing')).toBeUndefined();
        const original = {value: 1};
        cache.set('x', original);
        expect(cloneValue).not.toHaveBeenCalled();
        original.value = 2;
        expect(primary.get('x')?.value.value).toBe(2);
        expect(cache.get('x')).toEqual({value: 2});
        expect(cloneValue).toHaveBeenCalledTimes(1);
    });

    it('keeps class instances and non-cloneable values intact by default', () => {
        class User {
            #name = 'Igor';
            greeting() { return this.#name; }
        }
        const original = new User();
        const cache = new FlashCache(new MapStore<User>(), new MapStore<User>(), {ttl: 1000, staleRatio: 1});
        expect(cache.getOrSet('x', () => original)).toBe(original);
        expect((cache.get('x') as User).greeting()).toBe('Igor');
    });
});
