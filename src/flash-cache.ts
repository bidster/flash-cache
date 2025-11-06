import {singleFlight} from './utils/singleflight';
import {MapStore} from "./stores/map-store";

export interface StoreValue<T> {
    value: T;
    time: number; // когда положили
    staleAt: number; // когда устареет
    expAt: number; // когда истечет
}

export type MayBePromise<T> = T | Promise<T>;

export interface Store<T = any> {
    get(key: string): StoreValue<T> | undefined;

    set(key: string, value: StoreValue<T>): any;

    delete(key: string): any;
}

export type AsyncStore<T = any> = {
    get(key: string): Promise<StoreValue<T> | undefined>;
    set(key: string, value: StoreValue<T>): Promise<any>;
    delete(key: string): Promise<any>;
};

export type MayBeAsyncStore<T = any> = {
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

export class FlashCache<T = any> {
    // Precomputed functions for performance
    protected readonly makePrefixedKey: (key: string) => string;

    private computeState = (e: StoreValue<T>) => {
        if (!e || e.value === undefined || e.value === null) return S.MISS;
        const n = now();
        if (e.expAt <= n) return S.EXPIRED;
        if (e.staleAt <= n) return S.STALE;
        return S.FRESH;
    };

    private readonly primary: Store<T>;
    private readonly secondary: AsyncStore<T>;

    private readonly staleRatio: number;
    private readonly ttl: number;

    constructor(
      primary: Store<T>,
      secondary: MayBeAsyncStore<T>,
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

    get(key: string): MayBePromise<CacheResult<T>> {
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
            }
        }

        return singleFlight(prefixedKey, () => this.getThroughL2(prefixedKey)).then(
          (res) => {
              return {value: res.value, state: mapStateToStr[res.state]};
          },
        );
    }

    private async getThroughL2(prefixedKey: string) {
        const l2 = await this.secondary
          .get(prefixedKey)
          .catch<undefined>(() => undefined);

        if (l2) {
            const state = this.computeState(l2);
            if (state === S.FRESH) {
                this.primary.set(prefixedKey, l2);
            }
            return {value: l2.value, state};
        }
        return {value: undefined, state: S.MISS};
    }

    async set(key: string, value: T, customTtl?: number): Promise<void> {
        const prefixedKey = this.makePrefixedKey(key);
        const ttl = customTtl ?? this.ttl;
        const n = now();
        const entry: StoreValue<T> = {
            value,
            time: now(),
            staleAt: n + ttl * this.staleRatio,
            expAt: n + ttl,
        };
        this.primary.set(prefixedKey, entry);
        await this.secondary.set(prefixedKey, entry);
    }

    async del(key: string): Promise<void> {
        const prefixedKey = this.makePrefixedKey(key);
        this.primary.delete(prefixedKey);
        await this.secondary.delete(prefixedKey);
    }
}
