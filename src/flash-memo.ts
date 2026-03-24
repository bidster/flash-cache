import type {CacheableValue, FlashCache, MayBePromise} from './flash-cache';
import {createSingleFlight} from './utils/singleflight';

export interface MemoizeOptions {
    customTtl?: number;
}

export class FlashMemo<T = any> {
    private readonly memoFlight = createSingleFlight();

    constructor(private readonly cache: FlashCache<T>) {}

    memoize(
        key: string,
        fn: () => MayBePromise<CacheableValue<T>>,
        options: MemoizeOptions = {},
    ): MayBePromise<CacheableValue<T>> {
        const g = this.cache.get(key);
        if (!(g instanceof Promise)) {
            const r = g;
            if (r.state === 'fresh') {
                return r.value as CacheableValue<T>;
            }
            if (r.state === 'stale') {
                void this.fillMemoValue(key, fn, options.customTtl).catch(() => undefined);
                return r.value as CacheableValue<T>;
            }
        }
        return Promise.resolve(g).then((result) => {
            if (result.state === 'fresh') {
                return result.value as CacheableValue<T>;
            }
            if (result.state === 'stale') {
                void this.fillMemoValue(key, fn, options.customTtl).catch(() => undefined);
                return result.value as CacheableValue<T>;
            }
            return this.fillMemoValue(key, fn, options.customTtl);
        });
    }

    private fillMemoValue(
        key: string,
        fn: () => MayBePromise<CacheableValue<T>>,
        customTtl?: number,
    ): Promise<CacheableValue<T>> {
        return this.memoFlight(key, () =>
            Promise.resolve(fn()).then(async (value) => {
                await this.cache.set(key, value, customTtl);
                return value;
            }),
        );
    }
}
