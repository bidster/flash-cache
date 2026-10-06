import type {
    CacheableValue,
    CacheValueDeserializer,
    CacheValueSerializer,
    FlashCache,
    MayBePromise,
} from './flash-cache';
import {createSingleFlight} from './utils/singleflight';
import {cloneValue} from './utils/clone-value';

export interface MemoizeOptions {
    customTtl?: number;
    /** Клонировать возвращаемые значения, включая результаты loader. По умолчанию true. */
    useClones?: boolean;
}

export interface SerializedMemoizeOptions<Value, StoredValue> extends MemoizeOptions {
    serialize: CacheValueSerializer<Value, StoredValue>;
    deserialize: CacheValueDeserializer<StoredValue, Value>;
}

/** Синхронное преобразование локальных данных в результат для читателя. */
export type MemoizeMaterializer<Value, Result> = (value: CacheableValue<Value>) =>
    Result & (Extract<Result, PromiseLike<unknown>> extends never ? unknown : never);

export interface MaterializedMemoizeOptions<Value, Result> extends MemoizeOptions {
    /** Создать результат после клонирования данных L1; результат не записывается в кеш. */
    materialize: MemoizeMaterializer<Value, Result>;
}

export class FlashMemo<L1Value = unknown, L2Value = L1Value> {
    private readonly memoFlight = createSingleFlight();

    constructor(private readonly cache: FlashCache<L1Value, L2Value>) {}

    memoize<Result>(
        key: [L2Value] extends [L1Value] ? string : never,
        fn: () => MayBePromise<CacheableValue<L1Value & L2Value>>,
        options: MaterializedMemoizeOptions<L1Value, Result>,
    ): MayBePromise<Result>;

    memoize<Value extends L1Value, Result>(
        key: string,
        fn: () => MayBePromise<CacheableValue<Value>>,
        options: SerializedMemoizeOptions<Value, L2Value> & MaterializedMemoizeOptions<L1Value, Result>,
    ): MayBePromise<Result>;

    memoize(
        key: [L2Value] extends [L1Value] ? string : never,
        fn: () => MayBePromise<CacheableValue<L1Value & L2Value>>,
        options?: MemoizeOptions & {materialize?: never},
    ): MayBePromise<CacheableValue<L1Value & L2Value>>;

    memoize<Value extends L1Value>(
        key: string,
        fn: () => MayBePromise<CacheableValue<Value>>,
        options: SerializedMemoizeOptions<Value, L2Value> & {materialize?: never},
    ): MayBePromise<CacheableValue<Value>>;

    memoize<Value extends L1Value, Result>(
        key: string,
        fn: () => MayBePromise<CacheableValue<Value>>,
        options: (MemoizeOptions | SerializedMemoizeOptions<Value, L2Value>)
            & {materialize?: MemoizeMaterializer<L1Value, Result>} = {},
    ): MayBePromise<CacheableValue<Value> | Result> {
        const deserialize = 'deserialize' in options ? options.deserialize : undefined;
        const serialize = 'serialize' in options ? options.serialize : undefined;
        const useClones = options.useClones ?? true;
        const materialize = options.materialize;
        const toResult = (value: L1Value | L2Value | undefined): CacheableValue<Value> | Result => {
            const data = (useClones ? cloneValue(value) : value) as CacheableValue<L1Value>;
            return materialize ? materialize(data) : data as CacheableValue<Value>;
        };

        // Перегрузки разрешают отсутствие deserialize только при совместимых типах L2 и L1.
        const cached = this.cache.get(key, deserialize!);

        if (!(cached instanceof Promise) && cached.state === 'fresh') {
            return toResult(cached.value);
        }

        const refresh = this.memoFlight(key, async () => {
            // Готовый результат не требует await; у revalidating ждём только проверку L2.
            const result = cached instanceof Promise ? await cached : cached;
            const checked = result.state === 'revalidating' ? await result.revalidation : result;

            if (checked.state === 'fresh') return checked.value as CacheableValue<Value>;

            const customTtl = options.customTtl;

            if (customTtl !== undefined && (!Number.isInteger(customTtl) || customTtl <= 0)) {
                throw new Error('customTtl must be a positive integer in milliseconds');
            }

            const value = await fn();
            await this.cache.set(key, value, serialize, customTtl);

            return value;
        });

        void refresh.catch(() => undefined);

        if (!(cached instanceof Promise)) {
            return toResult(cached.value);
        }

        return cached.then((result) => {
            if (result.state === 'fresh' || result.state === 'stale') {
                return toResult(result.value);
            }

            return refresh.then(toResult);
        });
    }
}
