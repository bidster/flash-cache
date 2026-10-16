import type { CacheableValue, MayBeAsyncStore, MayBePromise, Store, StoreValue } from './types.js';

export interface FlashCacheOptions {
    ttl: number;
    staleRatio: number;
    namespace?: string | false;
    onError?: (error: unknown, context: { key: string; operation: 'l2.get' | 'l2.set' | 'refresh' }) => void;
}

// Исключаем Promise/thenable даже при T = unknown, сохраняя null и примитивы.
type CodecValue<T> = CacheableValue<T> & (string | number | boolean | bigint | symbol | null | { then?: never });

export interface Codec<Value, StoredValue> {
    serialize: (value: CacheableValue<Value>) => CodecValue<StoredValue>;
    deserialize: (value: CacheableValue<StoredValue>) => CodecValue<Value>;
}

interface LifetimeOptions {
    customTtl?: number;
    customStaleRatio?: number;
}

export interface SetOptions<T = unknown, Stored = unknown> extends LifetimeOptions {
    codec?: Codec<T, Stored>;
}

export interface GetOptions<T, Stored = unknown> {
    codec?: Codec<T, Stored>;
    cloneValue?: (value: CacheableValue<T>) => CacheableValue<T>;
}

export interface GetOrSetOptions<T, Stored = unknown> extends GetOptions<T, Stored>, SetOptions<T, Stored> {}

type Publication = { active: boolean };
type Flight<T> = Publication & {
    completed: Promise<CacheableValue<T>>;
    cached: Promise<StoreValue<T> | undefined>;
};

export class FlashCache<T = unknown> {
    private readonly flights = new Map<string, Flight<T>>();
    private readonly publications = new Map<string, Set<Publication>>();
    private readonly prefix: string;
    private readonly ttl: number;
    private readonly staleRatio: number;
    private readonly onError?: FlashCacheOptions['onError'];

    constructor(
        private readonly primary: Store<T>,
        private readonly secondary: MayBeAsyncStore<unknown>,
        options: FlashCacheOptions,
    ) {
        if (!Number.isInteger(options.ttl) || options.ttl <= 0) {
            throw new Error('ttl must be a positive integer in milliseconds');
        }
        if (!Number.isFinite(options.staleRatio) || options.staleRatio < 0 || options.staleRatio > 1) {
            throw new Error('staleRatio must be a finite number between 0 and 1');
        }
        this.ttl = options.ttl;
        this.staleRatio = options.staleRatio;
        this.onError = options.onError;
        const namespace = options.namespace ? `${options.namespace}:` : '';
        this.prefix = options.namespace === false ? '' : `flashCache:v2:${namespace}`;
    }

    getOrSet<Stored = unknown>(
        key: string,
        factory: () => MayBePromise<CacheableValue<T>>,
        options: GetOrSetOptions<T, Stored> = {},
    ): MayBePromise<CacheableValue<T>> {
        const { cloneValue } = options;
        const storedKey = this.prefix + key;
        const local = this.primary.get(storedKey);
        const time = Date.now();
        const hasUsableLocal = local !== undefined && local.value !== undefined && local.expAt > time;

        if (hasUsableLocal && local.staleAt > time) return this.toReader(local.value as CacheableValue<T>, cloneValue);

        const existing = this.flights.get(storedKey);
        if (existing) {
            if (hasUsableLocal) return this.toReader(local.value as CacheableValue<T>, cloneValue);
            return existing.cached
                .then((entry) => {
                    if (entry && entry.expAt > Date.now()) return entry.value as CacheableValue<T>;
                    return existing.completed;
                })
                .then((value) => this.toReader(value, cloneValue));
        }

        let result: MayBePromise<CacheableValue<T>>;
        try {
            result = this.load(key, storedKey, factory, options, hasUsableLocal);
        } catch (error) {
            if (!hasUsableLocal) throw error;
            return this.toReader(local.value as CacheableValue<T>, cloneValue);
        }
        if (hasUsableLocal) {
            if (result instanceof Promise) void result.catch(() => undefined);
            return this.toReader(local.value as CacheableValue<T>, cloneValue);
        }
        return result instanceof Promise
            ? result.then((value) => this.toReader(value, cloneValue))
            : this.toReader(result, cloneValue);
    }

    get<Stored = unknown>(
        key: string,
        options: GetOptions<T, Stored> = {},
    ): MayBePromise<CacheableValue<T> | undefined> {
        const { cloneValue } = options;
        const storedKey = this.prefix + key;
        const local = this.primary.get(storedKey);
        if (local && local.value !== undefined && local.expAt > Date.now()) {
            return this.toReader(local.value as CacheableValue<T>, cloneValue);
        }

        const publication = { active: true };
        this.track(storedKey, publication);
        const accept = (entry: StoreValue<T> | undefined) => {
            const time = Date.now();
            const current = publication.active ? this.primary.get(storedKey) : undefined;
            if (current && current.value !== undefined && current.expAt > time && current.staleAt > time) {
                return this.toReader(current.value as CacheableValue<T>, cloneValue);
            }
            if (!entry || entry.value === undefined || entry.expAt <= time) return undefined;
            if (publication.active) this.primary.set(storedKey, entry);
            return this.toReader(entry.value as CacheableValue<T>, cloneValue);
        };
        let pending = false;
        try {
            const read = this.readSecondary(key, storedKey, options.codec);
            if (read instanceof Promise) {
                pending = true;
                return read.then(accept).finally(() => this.release(storedKey, publication));
            }
            return accept(read);
        } finally {
            if (!pending) this.release(storedKey, publication);
        }
    }

    set<Stored = unknown>(
        key: string,
        value: CacheableValue<T>,
        options: SetOptions<T, Stored> = {},
    ): MayBePromise<void> {
        const storedKey = this.prefix + key;
        this.detach(storedKey);
        const ttl = options.customTtl ?? this.ttl;
        if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('customTtl must be a positive integer in milliseconds');
        const staleRatio = options.customStaleRatio ?? this.staleRatio;
        if (!Number.isFinite(staleRatio) || staleRatio < 0 || staleRatio > 1) {
            throw new Error('customStaleRatio must be a finite number between 0 and 1');
        }
        if (value === undefined) throw new Error('undefined values cannot be cached');
        const publication = { active: true };
        this.track(storedKey, publication);
        try {
            return this.publish(key, storedKey, value, ttl, staleRatio, options.codec, publication);
        } finally {
            // После запуска записи L2 её уже нельзя отменить; защита нужна только до отправки.
            this.release(storedKey, publication);
        }
    }

    delete(key: string): MayBePromise<void> {
        const storedKey = this.prefix + key;
        this.detach(storedKey);
        this.primary.delete(storedKey);
        const removed = this.secondary.delete(storedKey);
        if (removed instanceof Promise) return removed.then(() => undefined);
    }

    /** Ответ из кеша доступен до завершения обновления; singleflight живёт до завершения всего цикла. */
    private load<Stored>(
        key: string,
        storedKey: string,
        factory: () => MayBePromise<CacheableValue<T>>,
        options: SetOptions<T, Stored>,
        background: boolean,
    ): MayBePromise<CacheableValue<T>> {
        // Регистрируем работу до обращения к пользовательскому коду, включая синхронный store.
        let resolveCompleted!: (value: CacheableValue<T>) => void;
        let rejectCompleted!: (error: unknown) => void;
        const completed = new Promise<CacheableValue<T>>((resolve, reject) => {
            resolveCompleted = resolve;
            rejectCompleted = reject;
        });
        let resolveCached!: (entry: StoreValue<T> | undefined) => void;
        let rejectCached!: (error: unknown) => void;
        const cached = new Promise<StoreValue<T> | undefined>((resolve, reject) => {
            resolveCached = resolve;
            rejectCached = reject;
        });
        const flight: Flight<T> = { active: true, completed, cached };
        this.flights.set(storedKey, flight);
        this.track(storedKey, flight);
        void completed.catch(() => undefined);
        void cached.catch(() => undefined);

        // Только завершение цикла очищает регистрацию и уведомляет о фоновой ошибке.
        const finish = (result: { value: CacheableValue<T> } | { error: unknown }) => {
            this.release(storedKey, flight);
            if (this.flights.get(storedKey) === flight) this.flights.delete(storedKey);
            if ('error' in result) {
                rejectCompleted(result.error);
                rejectCached(result.error);
                if (background) this.report(result.error, key, 'refresh');
            } else {
                resolveCompleted(result.value);
            }
        };

        const acceptSecondary = (entry: StoreValue<T> | undefined): MayBePromise<CacheableValue<T>> => {
            // Ответ из кеша не ждёт обновления; промах ждёт completed напрямую.
            let response: StoreValue<T> | undefined;
            let completion: MayBePromise<CacheableValue<T>>;
            try {
                const time = Date.now();
                const current = flight.active ? this.primary.get(storedKey) : undefined;
                if (current && current.value !== undefined && current.expAt > time && current.staleAt > time) {
                    response = current;
                } else if (entry && entry.value !== undefined && entry.expAt > time) {
                    if (flight.active) this.primary.set(storedKey, entry);
                    response = entry;
                }
                resolveCached(response);
                if (response && response.staleAt > time) {
                    completion = response.value as CacheableValue<T>;
                } else {
                    if (response) background = true;
                    completion = this.refresh(key, storedKey, factory, options, flight);
                }
            } catch (error) {
                finish({ error });
                if (response) return response.value as CacheableValue<T>;
                throw error;
            }
            if (completion instanceof Promise) {
                void completion.then(
                    (value) => finish({ value }),
                    (error) => finish({ error }),
                );
                return response ? (response.value as CacheableValue<T>) : completed;
            }
            finish({ value: completion });
            return response ? (response.value as CacheableValue<T>) : completion;
        };

        // Ошибки L2 уже превращены в промах внутри readSecondary.
        const read = this.readSecondary(key, storedKey, options.codec);
        return read instanceof Promise ? read.then(acceptSecondary) : acceptSecondary(read);
    }

    /** Factory и публикация результата; отсоединённая загрузка остаётся доступна своим читателям. */
    private refresh<Stored>(
        key: string,
        storedKey: string,
        factory: () => MayBePromise<CacheableValue<T>>,
        options: SetOptions<T, Stored>,
        publication: Publication,
    ): MayBePromise<CacheableValue<T>> {
        const ttl = options.customTtl ?? this.ttl;
        if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('customTtl must be a positive integer in milliseconds');
        const staleRatio = options.customStaleRatio ?? this.staleRatio;
        if (!Number.isFinite(staleRatio) || staleRatio < 0 || staleRatio > 1) {
            throw new Error('customStaleRatio must be a finite number between 0 and 1');
        }
        const loaded = factory();
        const persist = (value: CacheableValue<T>): MayBePromise<CacheableValue<T>> => {
            if (value === undefined) throw new Error('undefined values cannot be cached');
            if (!publication.active) return value;
            const written = this.publish(key, storedKey, value, ttl, staleRatio, options.codec, publication);
            return written instanceof Promise ? written.then(() => value) : value;
        };
        return loaded instanceof Promise ? loaded.then(persist) : persist(loaded);
    }

    private publish<Stored>(
        key: string,
        storedKey: string,
        value: CacheableValue<T>,
        ttl: number,
        staleRatio: number,
        codec: Codec<T, Stored> | undefined,
        publication?: Publication,
    ): MayBePromise<void> {
        const time = Date.now();
        const entry = { value, time, staleAt: time + ttl * staleRatio, expAt: time + ttl };
        this.primary.set(storedKey, entry);
        if (publication && !publication.active) return;
        try {
            const stored = codec ? { ...entry, value: codec.serialize(value) } : entry;
            if (stored.value === undefined) throw new Error('codec.serialize cannot return undefined');
            // serialize — пользовательский код: он мог вызвать set/delete и отсоединить загрузку.
            if (publication && !publication.active) return;
            const written = this.secondary.set(storedKey, stored);
            if (written instanceof Promise) {
                return written
                    .catch((error) => {
                        this.report(error, key, 'l2.set');
                    })
                    .then(() => undefined);
            }
        } catch (error) {
            this.report(error, key, 'l2.set');
        }
    }

    private readSecondary<Stored>(
        key: string,
        storedKey: string,
        codec: Codec<T, Stored> | undefined,
    ): MayBePromise<StoreValue<T> | undefined> {
        const decode = (entry: StoreValue<unknown> | undefined): StoreValue<T> | undefined => {
            if (!entry || entry.value === undefined || entry.expAt <= Date.now()) return undefined;
            if (!codec) return entry as StoreValue<T>;
            const value = codec.deserialize(entry.value as CacheableValue<Stored>);
            if (value === undefined) throw new Error('codec.deserialize cannot return undefined');
            return { ...entry, value };
        };
        try {
            const read = this.secondary.get(storedKey);
            if (read instanceof Promise) {
                const decoded = codec ? read.then(decode) : (read as Promise<StoreValue<T> | undefined>);
                return decoded.catch((error) => {
                    this.report(error, key, 'l2.get');
                    return undefined;
                });
            }
            return decode(read);
        } catch (error) {
            this.report(error, key, 'l2.get');
            return undefined;
        }
    }

    private toReader(value: CacheableValue<T>, cloneValue: GetOptions<T>['cloneValue']): CacheableValue<T> {
        return cloneValue ? cloneValue(value) : value;
    }

    private report(error: unknown, key: string, operation: 'l2.get' | 'l2.set' | 'refresh'): void {
        try {
            this.onError?.(error, { key, operation });
        } catch {
            /* Диагностика не меняет результат операции. */
        }
    }

    private track(key: string, publication: Publication): void {
        let pending = this.publications.get(key);
        if (!pending) {
            pending = new Set();
            this.publications.set(key, pending);
        }
        pending.add(publication);
    }

    private release(key: string, publication: Publication): void {
        const pending = this.publications.get(key);
        pending?.delete(publication);
        if (pending?.size === 0) this.publications.delete(key);
    }

    private detach(key: string): void {
        this.publications.get(key)?.forEach((publication) => {
            publication.active = false;
        });
        this.publications.delete(key);
        this.flights.delete(key);
    }
}
