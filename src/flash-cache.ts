import { createSingleFlight } from './utils/singleflight';

export interface StoreValue<T> {
    value: T;
    time: number; // когда положили
    staleAt: number; // когда устареет
    expAt: number; // когда истечет
}

export type MayBePromise<T> = T | Promise<T>;
export type CacheableValue<T> = Exclude<T, undefined>;
export type CacheValueSerializer<Value, StoredValue> = (value: Value) => StoredValue;
export type CacheValueDeserializer<StoredValue, Value> = (value: StoredValue) => Value;

export interface Store<T = unknown> {
    get(key: string): StoreValue<T> | undefined;

    set(key: string, value: StoreValue<T>): any;

    delete(key: string): any;
}

export type AsyncStore<T = unknown> = {
    get(key: string): Promise<StoreValue<T> | undefined>;
    set(key: string, value: StoreValue<T>): Promise<any>;
    delete(key: string): Promise<any>;
};

export type MayBeAsyncStore<T = unknown> = {
    get(key: string): MayBePromise<StoreValue<T> | undefined>;
    set(key: string, value: StoreValue<T>): MayBePromise<any>;
    delete(key: string): MayBePromise<any>;
};

export interface MiniCacheOptions {
    ttl: number; // базовый ttl для L2
    staleRatio: number; // коэффициент для определения устаревания (например 0.8 → считается устаревшим за 80% времени жизни)
    namespace?: string | false; // неймспейс для ключей (по умолчанию нет)
}

export interface CacheResult<T> {
    value: T | undefined;
    state: 'fresh' | 'stale' | 'expired' | 'miss';
}

// внутренние коды состояния — быстрее сравнивать числа
const enum S {
    MISS = 0,
    EXPIRED = 1,
    STALE = 2,
    FRESH = 3,
}

const mapStateToStr = ['miss', 'expired', 'stale', 'fresh'] as const;

const now = Date.now;

function toAsyncStore<T>(store: MayBeAsyncStore<T>): AsyncStore<T> {
    return {
        get: (k) => Promise.resolve(store.get(k)),
        set: (k, v) => Promise.resolve(store.set(k, v)),
        delete: (k) => Promise.resolve(store.delete(k)),
    };
}

export class FlashCache<L1Value = unknown, L2Value = L1Value> {
    private readonly readFlight = createSingleFlight();

    // Precomputed functions for performance
    protected readonly makePrefixedKey: (key: string) => string;

    private computeState = <Value>(e: StoreValue<Value>) => {
        if (!e || e.value === undefined) return S.MISS;
        const n = now();
        if (e.expAt <= n) return S.EXPIRED;
        if (e.staleAt <= n) return S.STALE;
        return S.FRESH;
    };

    private readonly primary: Store<L1Value>;
    private readonly secondary: AsyncStore<L2Value>;

    private readonly staleRatio: number;
    private readonly ttl: number;

    constructor(
      primary: Store<L1Value>,
      secondary: MayBeAsyncStore<L2Value>,
      private readonly options: MiniCacheOptions,
    ) {
        if (options.ttl <= 0) {
            throw new Error('ttl must be positive');
        }

        this.primary = primary;
        this.secondary = toAsyncStore(secondary);

        const prefixes = []
        if (options.namespace !== false) {
            prefixes.push('flashCache:v1');
            if (options.namespace) {
                prefixes.push(options.namespace);
            }
        }

        prefixes.push('');

        const prefix = prefixes.join(':');

        // Precompute functions for performance
        this.makePrefixedKey = (key: string) => prefix + key;

        this.staleRatio = options.staleRatio;
        this.ttl = options.ttl;
    }

    get(key: string): MayBePromise<CacheResult<L1Value | L2Value>>;
    get<Value>(
      key: string,
      deserialize: CacheValueDeserializer<L2Value, Value>,
    ): MayBePromise<CacheResult<Value>>;
    get<Value>(
      key: string,
      deserialize?: CacheValueDeserializer<L2Value, Value>,
    ): MayBePromise<CacheResult<L1Value | L2Value | Value>> {
        const prefixedKey = this.makePrefixedKey(key);

        const l1 = this.primary.get(prefixedKey);

        // инлайн fast-path
        if (l1) {
            const n = now();

            if (l1.expAt > n) {
                // не истек
                if (l1.staleAt > n) {
                    // не устарел
                    return {value: l1.value, state: 'fresh'};
                }

                this.refreshFromL2(prefixedKey, deserialize);
                return {value: l1.value, state: 'stale'};
            }
        }

        return this.readFlight(prefixedKey, () => this.getThroughL2(prefixedKey)).then(
          (entry) => {
              if (!entry) {
                  return {value: undefined, state: 'miss'};
              }

              const state = this.computeState(entry);
              const value = deserialize ? deserialize(entry.value) : entry.value;
              if (state === S.FRESH) {
                  this.primary.set(prefixedKey, {...entry, value: value as L1Value});
              }

              return {value, state: mapStateToStr[state]};
          },
        );
    }

    private refreshFromL2<Value>(
      prefixedKey: string,
      deserialize?: CacheValueDeserializer<L2Value, Value>,
    ): void {
        void this.readFlight(prefixedKey, async () => {
            const entry = await this.getThroughL2(prefixedKey);

            if (entry && this.computeState(entry) === S.FRESH) {
                const value = deserialize ? deserialize(entry.value) : entry.value;
                this.primary.set(prefixedKey, {...entry, value: value as L1Value});
            }

            return entry;
        }).catch(() => undefined);
    }

    private async getThroughL2(prefixedKey: string): Promise<StoreValue<L2Value> | undefined> {
        return this.secondary.get(prefixedKey);
    }

    set(
      key: string,
      value: CacheableValue<L1Value & L2Value>,
      customTtl?: number,
    ): Promise<void>;
    set<Value extends L1Value>(
      key: string,
      value: CacheableValue<Value>,
      serialize: CacheValueSerializer<Value, L2Value>,
    ): Promise<void>;
    set<Value extends L1Value>(
      key: string,
      value: CacheableValue<Value>,
      customTtl: number | undefined,
      serialize: CacheValueSerializer<Value, L2Value>,
    ): Promise<void>;
    async set<Value extends L1Value>(
      key: string,
      value: CacheableValue<Value>,
      customTtlOrSerialize?: number | CacheValueSerializer<Value, L2Value>,
      serialize?: CacheValueSerializer<Value, L2Value>,
    ): Promise<void> {
        if (value === undefined) {
            throw new Error('undefined values cannot be cached');
        }

        const prefixedKey = this.makePrefixedKey(key);
        const customTtl = typeof customTtlOrSerialize === 'number' ? customTtlOrSerialize : undefined;
        const serializeValue = typeof customTtlOrSerialize === 'function'
          ? customTtlOrSerialize
          : serialize;
        const ttl = customTtl ?? this.ttl;
        const n = now();
        const entry: StoreValue<Value> = {
            value,
            time: now(),
            staleAt: n + ttl * this.staleRatio,
            expAt: n + ttl,
        };
        this.primary.set(prefixedKey, entry as StoreValue<L1Value>);
        await this.secondary.set(prefixedKey, {
            ...entry,
            value: serializeValue ? serializeValue(value) : value as L2Value,
        });
    }

    async del(key: string): Promise<void> {
        const prefixedKey = this.makePrefixedKey(key);
        this.primary.delete(prefixedKey);
        await this.secondary.delete(prefixedKey);
    }
}
