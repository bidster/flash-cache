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

/** Проверка завершена: stale означает, что L2 не дал свежих данных, но допустимое значение есть. */
export interface SettledCacheResult<T> {
    value: T | undefined;
    state: 'fresh' | 'stale' | 'expired' | 'miss';
}

/** Допустимое значение L1 и Promise результата выполняющейся проверки L2. */
export type CacheResult<T> = SettledCacheResult<T> | {
    value: T;
    state: 'revalidating';
    revalidation: Promise<SettledCacheResult<T>>;
};

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
        if (!Number.isInteger(options.ttl) || options.ttl <= 0) {
            throw new Error('ttl must be a positive integer in milliseconds');
        }

        if (!Number.isFinite(options.staleRatio) || options.staleRatio < 0 || options.staleRatio > 1) {
            throw new Error('staleRatio must be a finite number between 0 and 1');
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

    /**
     * Возвращает значение по ссылке; допустимую запись L2 переносит в L1 с исходными сроками жизни.
     * Без deserialize чтение разрешено, только если весь тип L2 совместим с типом L1.
     */
    get(key: [L2Value] extends [L1Value] ? string : never): MayBePromise<CacheResult<L1Value | L2Value>>;

    /**
     * deserialize восстанавливает представление для L1 и не вызывается при попадании в L1.
     * Все операции с одним ключом должны использовать согласованные типы и преобразования.
     */
    get<Value extends L1Value>(
      key: string,
      deserialize: CacheValueDeserializer<L2Value, Value>,
    ): MayBePromise<CacheResult<L1Value | Value>>;

    get<Value extends L1Value>(
      key: [L2Value] extends [L1Value] ? string : never,
      deserialize: CacheValueDeserializer<L2Value, Value> | undefined,
    ): MayBePromise<CacheResult<L1Value | L2Value | Value>>;

    get<Value extends L1Value>(
      key: string,
      deserialize?: CacheValueDeserializer<L2Value, Value>,
    ): MayBePromise<CacheResult<L1Value | L2Value | Value>> {
        const prefixedKey = this.makePrefixedKey(key);
        const l1 = this.primary.get(prefixedKey);

        // Допустимое значение L1 можно вернуть синхронно.
        if (l1) {
            const n = now();

            if (l1.expAt > n) {
                // Свежий L1 не требует обращения к L2.
                if (l1.staleAt > n) {
                    return {value: l1.value, state: 'fresh'};
                }

                // Старое значение отдаём сразу, а результат проверки L2 — через Promise.
                const revalidation = this.getThroughL2(prefixedKey, deserialize);

                // Ошибка доступна через Promise, даже если вызывающий код его не ждёт.
                void revalidation.catch(() => undefined);

                return {
                    value: l1.value,
                    state: 'revalidating',
                    revalidation,
                };
            }
        }

        // Допустимого L1 нет: результат чтения требует ожидания L2.
        return this.getThroughL2(prefixedKey, deserialize);
    }

    private getThroughL2<Value extends L1Value>(
      prefixedKey: string,
      deserialize: CacheValueDeserializer<L2Value, Value> | undefined,
    ): Promise<SettledCacheResult<L1Value | L2Value | Value>> {
        // Объединяем чтение L2; десериализация остаётся отдельной для каждого вызова.
        const read = this.readFlight(prefixedKey, async () => this.secondary.get(prefixedKey));

        // Недоступность L2 обрабатываем как промах; ошибки десериализации и L1 остаются видимыми.
        return read.catch(() => undefined).then((entry) => {
            const state = entry ? this.computeState(entry) : S.MISS;

            // Переносим допустимую запись в L1 с исходными сроками жизни.
            if (entry && (state === S.FRESH || state === S.STALE)) {
                const value = deserialize ? deserialize(entry.value) : entry.value;
                this.primary.set(prefixedKey, {...entry, value: value as L1Value});

                return {value, state: mapStateToStr[state]};
            }

            // Промах или истечение L2 не отменяют ещё допустимый L1.
            // За время ожидания L2 локальная запись могла измениться или истечь.
            const local = this.primary.get(prefixedKey);

            if (local && local.expAt > now()) {
                return {
                    value: local.value,
                    state: mapStateToStr[this.computeState(local)],
                };
            }

            // Допустимых данных нет. Истёкшее значение доступно только для диагностики.
            const value = entry ? (deserialize ? deserialize(entry.value) : entry.value) : undefined;

            return {
                value,
                state: state === S.EXPIRED || (local && this.computeState(local) === S.EXPIRED)
                  ? 'expired' : 'miss',
            };
        });
    }

    set(
      key: string,
      value: CacheableValue<L1Value & L2Value>,
    ): Promise<void>;

    set<Value extends L1Value>(
      key: string,
      value: CacheableValue<Value>,
      serialize: CacheValueSerializer<Value, L2Value>,
    ): Promise<void>;

    /** @internal Used by FlashMemo after validating customTtl. */
    set<Value extends L1Value>(
      key: string,
      value: CacheableValue<Value>,
      serialize: CacheValueSerializer<Value, L2Value> | undefined,
      customTtl: number | undefined,
    ): Promise<void>;

    async set<Value extends L1Value>(
      key: string,
      value: CacheableValue<Value>,
      serialize?: CacheValueSerializer<Value, L2Value>,
      customTtl?: number,
    ): Promise<void> {
        if (value === undefined) {
            throw new Error('undefined values cannot be cached');
        }

        const prefixedKey = this.makePrefixedKey(key);
        const ttl = customTtl ?? this.ttl;
        const n = now();

        const entry: StoreValue<Value> = {
            value,
            time: now(),
            staleAt: n + ttl * this.staleRatio,
            expAt: n + ttl,
        };

        // Ошибка сериализации должна произойти до изменения хранилищ.
        const secondaryEntry = {
            ...entry,
            value: serialize ? serialize(value) : value as L2Value,
        };

        // Публикуем L1 сразу. При ошибке записи L2 новое значение в L1 сохраняется.
        this.primary.set(prefixedKey, entry as StoreValue<L1Value>);

        try {
            await this.secondary.set(prefixedKey, secondaryEntry);
        } catch {
            // Ошибка L2 не отменяет опубликованное значение L1.
        }
    }

    async del(key: string): Promise<void> {
        const prefixedKey = this.makePrefixedKey(key);
        this.primary.delete(prefixedKey);

        try {
            await this.secondary.delete(prefixedKey);
        } catch {
            // Ошибка L2 не отменяет удаление из L1.
        }
    }
}
