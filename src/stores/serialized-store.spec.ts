import {describe, expect, it, vi} from 'vitest';
import {MapStore, SerializedStore, StoreTransformError} from '../index';

describe('SerializedStore', () => {
    it.each([false, true])('preserves metadata and underlying sync/async behavior (async=%s)', async asyncStore => {
        const raw = new MapStore<string>();
        const underlying = asyncStore ? {
            get: async (key: string) => raw.get(key),
            set: async (key: string, value: Parameters<typeof raw.set>[1]) => { raw.set(key, value); },
            delete: async (key: string) => { raw.delete(key); },
        } : raw;
        const codec = {serialize: vi.fn(String), deserialize: vi.fn(Number)};
        const store = new SerializedStore<number, string>(underlying, codec);
        expect(await store.get('missing')).toBeUndefined();
        expect(codec.deserialize).not.toHaveBeenCalled();
        const value = {value: 42, time: 1, staleAt: 2, expAt: 3};
        const write = store.set('x', value);
        expect(write instanceof Promise).toBe(asyncStore);
        await write;
        expect(raw.get('x')).toEqual({...value, value: '42'});
        const read = store.get('x');
        expect(read instanceof Promise).toBe(asyncStore);
        expect(await read).toEqual(value);
        const removed = store.delete('x');
        expect(removed instanceof Promise).toBe(asyncStore);
        await removed;
        expect(raw.has('x')).toBe(false);
    });

    it('preserves the cause of a conversion error', () => {
        const cause = new Error('bad data');
        const store = new SerializedStore<number, string>(new MapStore(), {
            serialize: () => { throw cause; }, deserialize: Number,
        });
        try {
            store.set('x', {value: 1, time: 1, staleAt: 2, expAt: 3});
            throw new Error('Expected conversion failure');
        } catch (error) {
            expect(error).toBeInstanceOf(StoreTransformError);
            expect((error as StoreTransformError).cause).toBe(cause);
        }
    });
});
