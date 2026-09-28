import type {
    CacheableValue,
    CacheValueDeserializer,
    CacheValueSerializer,
    FlashCache,
    MayBePromise,
} from './flash-cache';
import {createSingleFlight} from './utils/singleflight';

export interface MemoizeOptions {
    customTtl?: number;
}

export interface SerializedMemoizeOptions<Value, StoredValue> extends MemoizeOptions {
    serialize: CacheValueSerializer<Value, StoredValue>;
    deserialize: CacheValueDeserializer<StoredValue, Value>;
}

export class FlashMemo<L1Value = unknown, L2Value = L1Value> {
    private readonly memoFlight = createSingleFlight();

    constructor(private readonly cache: FlashCache<L1Value, L2Value>) {}

    memoize(
        key: string,
        fn: () => MayBePromise<CacheableValue<L1Value & L2Value>>,
        options?: MemoizeOptions,
    ): MayBePromise<CacheableValue<L1Value & L2Value>>;
    memoize<Value extends L1Value>(
        key: string,
        fn: () => MayBePromise<CacheableValue<Value>>,
        options: SerializedMemoizeOptions<Value, L2Value>,
    ): MayBePromise<CacheableValue<Value>>;
    memoize<Value extends L1Value>(
        key: string,
        fn: () => MayBePromise<CacheableValue<Value>>,
        options: MemoizeOptions | SerializedMemoizeOptions<Value, L2Value> = {},
    ): MayBePromise<CacheableValue<Value>> {
        const deserialize = 'deserialize' in options ? options.deserialize : undefined;
        const serialize = 'serialize' in options ? options.serialize : undefined;
        const g = deserialize ? this.cache.get(key, deserialize) : this.cache.get(key);
        if (!(g instanceof Promise)) {
            const r = g;
            if (r.state === 'fresh') {
                return r.value as CacheableValue<Value>;
            }
            if (r.state === 'stale') {
                void this.fillMemoValue(key, fn, options.customTtl, serialize).catch(() => undefined);
                return r.value as CacheableValue<Value>;
            }
        }
        return Promise.resolve(g).then((result) => {
            if (result.state === 'fresh') {
                return result.value as CacheableValue<Value>;
            }
            if (result.state === 'stale') {
                void this.fillMemoValue(key, fn, options.customTtl, serialize).catch(() => undefined);
                return result.value as CacheableValue<Value>;
            }
            return this.fillMemoValue(key, fn, options.customTtl, serialize);
        });
    }

    private fillMemoValue<Value extends L1Value>(
        key: string,
        fn: () => MayBePromise<CacheableValue<Value>>,
        customTtl?: number,
        serialize?: CacheValueSerializer<Value, L2Value>,
    ): Promise<CacheableValue<Value>> {
        return this.memoFlight(key, async () => {
            if (customTtl !== undefined && (!Number.isInteger(customTtl) || customTtl <= 0)) {
                throw new Error('customTtl must be a positive integer in milliseconds');
            }
            const cachedValue = await fn();
            await this.cache.set(key, cachedValue, serialize, customTtl);
            return cachedValue;
        });
    }
}
