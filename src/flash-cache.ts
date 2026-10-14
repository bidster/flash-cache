import type {CacheableValue, MayBeAsyncStore, MayBePromise, Store, StoreValue} from './types.js';
import {StoreTransformError} from './stores/serialized-store.js';

export interface FlashCacheOptions<T> {
    ttl: number;
    staleRatio: number;
    namespace?: string | false;
    cloneValue?: (value: CacheableValue<T>) => CacheableValue<T>;
    onError?: (error: unknown, context: {key: string; operation: 'l2.get' | 'l2.set' | 'refresh'}) => void;
}

export interface GetOrSetOptions {
    customTtl?: number;
}

type Publication = {active: boolean};
type Flight<T> = Publication & {
    promise: Promise<CacheableValue<T>>;
    cached: Promise<StoreValue<T> | undefined>;
};

export class FlashCache<T = unknown> {
    private readonly flights = new Map<string, Flight<T>>();
    private readonly publications = new Map<string, Set<Publication>>();
    private readonly prefix: string;
    private readonly ttl: number;
    private readonly staleRatio: number;
    private readonly cloneValue?: FlashCacheOptions<T>['cloneValue'];
    private readonly onError?: FlashCacheOptions<T>['onError'];

    constructor(
        private readonly primary: Store<T>,
        private readonly secondary: MayBeAsyncStore<T>,
        options: FlashCacheOptions<T>,
    ) {
        if (!Number.isInteger(options.ttl) || options.ttl <= 0) {
            throw new Error('ttl must be a positive integer in milliseconds');
        }
        if (!Number.isFinite(options.staleRatio) || options.staleRatio < 0 || options.staleRatio > 1) {
            throw new Error('staleRatio must be a finite number between 0 and 1');
        }
        this.ttl = options.ttl;
        this.staleRatio = options.staleRatio;
        this.cloneValue = options.cloneValue;
        this.onError = options.onError;
        this.prefix = options.namespace === false ? '' : `flashCache:v2:${options.namespace ? `${options.namespace}:` : ''}`;
    }

    getOrSet(
        key: string,
        factory: () => MayBePromise<CacheableValue<T>>,
        options: GetOrSetOptions = {},
    ): MayBePromise<CacheableValue<T>> {
        const storedKey = this.prefix + key;
        const local = this.primary.get(storedKey);
        const time = Date.now();
        const usable = local !== undefined && local.value !== undefined && local.expAt > time;

        if (usable && local.staleAt > time) return this.toReader(local.value as CacheableValue<T>);

        const existing = this.flights.get(storedKey);
        if (existing) {
            if (usable) return this.toReader(local.value as CacheableValue<T>);
            return existing.cached.then(entry => entry && entry.expAt > Date.now()
                ? entry.value as CacheableValue<T> : existing.promise).then(value => this.toReader(value));
        }

        let result: MayBePromise<CacheableValue<T>>;
        try {
            result = this.load(key, storedKey, factory, options, usable);
        } catch (error) {
            if (!usable) throw error;
            return this.toReader(local.value as CacheableValue<T>);
        }
        if (usable) {
            if (result instanceof Promise) void result.catch(() => undefined);
            return this.toReader(local.value as CacheableValue<T>);
        }
        return result instanceof Promise ? result.then(value => this.toReader(value)) : this.toReader(result);
    }

    get(key: string): MayBePromise<CacheableValue<T> | undefined> {
        const storedKey = this.prefix + key;
        const local = this.primary.get(storedKey);
        if (local && local.value !== undefined && local.expAt > Date.now()) return this.toReader(local.value as CacheableValue<T>);

        const publication = {active: true};
        this.track(storedKey, publication);
        const accept = (entry: StoreValue<T> | undefined) => {
            if (!entry || entry.value === undefined || entry.expAt <= Date.now()) return undefined;
            if (publication.active) this.primary.set(storedKey, entry);
            return this.toReader(entry.value as CacheableValue<T>);
        };
        let pending = false;
        try {
            const read = this.readSecondary(key, storedKey);
            if (read instanceof Promise) {
                pending = true;
                return read.then(accept).finally(() => this.release(storedKey, publication));
            }
            return accept(read);
        } finally {
            if (!pending) this.release(storedKey, publication);
        }
    }

    set(key: string, value: CacheableValue<T>, options: GetOrSetOptions = {}): MayBePromise<void> {
        const storedKey = this.prefix + key;
        this.detach(storedKey);
        const ttl = options.customTtl ?? this.ttl;
        if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('customTtl must be a positive integer in milliseconds');
        if (value === undefined) throw new Error('undefined values cannot be cached');
        return this.publish(key, storedKey, value, ttl);
    }

    delete(key: string): MayBePromise<void> {
        const storedKey = this.prefix + key;
        this.detach(storedKey);
        this.primary.delete(storedKey);
        const removed = this.secondary.delete(storedKey);
        if (removed instanceof Promise) return removed.then(() => undefined);
    }

    /** Один цикл получения данных; ответ stale и завершение обновления могут различаться. */
    private load(
        key: string,
        storedKey: string,
        factory: () => MayBePromise<CacheableValue<T>>,
        options: GetOrSetOptions,
        background: boolean,
    ): MayBePromise<CacheableValue<T>> {
        // Регистрируем работу до обращения к пользовательскому коду, включая синхронный store.
        let resolve!: (value: CacheableValue<T>) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<CacheableValue<T>>((done, fail) => { resolve = done; reject = fail; });
        let resolveCached!: (entry: StoreValue<T> | undefined) => void;
        let rejectCached!: (error: unknown) => void;
        const cached = new Promise<StoreValue<T> | undefined>((done, fail) => { resolveCached = done; rejectCached = fail; });
        const flight: Flight<T> = {active: true, promise, cached};
        this.flights.set(storedKey, flight);
        this.track(storedKey, flight);
        void promise.catch(() => undefined);
        void cached.catch(() => undefined);
        let refreshOwnsCompletion = false;

        const finish = (result: {value: CacheableValue<T>} | {error: unknown}) => {
            this.release(storedKey, flight);
            if (this.flights.get(storedKey) === flight) this.flights.delete(storedKey);
            if ('error' in result) {
                reject(result.error);
                rejectCached(result.error);
                if (background) this.report(result.error, key, 'refresh');
            } else resolve(result.value);
        };
        const refresh = (): MayBePromise<CacheableValue<T>> => {
            const ttl = options.customTtl ?? this.ttl;
            if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('customTtl must be a positive integer in milliseconds');
            const loaded = factory();
            const publish = (value: CacheableValue<T>): MayBePromise<CacheableValue<T>> => {
                if (value === undefined) throw new Error('undefined values cannot be cached');
                if (!flight.active) return value;
                const written = this.publish(key, storedKey, value, ttl, flight);
                return written instanceof Promise ? written.then(() => value) : value;
            };
            return loaded instanceof Promise ? loaded.then(publish) : publish(loaded);
        };
        const checked = (entry: StoreValue<T> | undefined): MayBePromise<CacheableValue<T>> => {
            if (entry && entry.value !== undefined && entry.expAt > Date.now()) {
                if (flight.active) this.primary.set(storedKey, entry);
                resolveCached(entry);
                if (entry.staleAt > Date.now()) return entry.value as CacheableValue<T>;
                // Stale из L2 доступен первому читателю до завершения factory.
                background = true;
                refreshOwnsCompletion = true;
                let updated: MayBePromise<CacheableValue<T>>;
                try { updated = refresh(); } catch (error) {
                    finish({error});
                    return entry.value as CacheableValue<T>;
                }
                if (updated instanceof Promise) updated.then(value => finish({value}), error => finish({error}));
                else finish({value: updated});
                return entry.value as CacheableValue<T>;
            }
            resolveCached(undefined);
            return refresh();
        };

        let result: MayBePromise<CacheableValue<T>>;
        try {
            const read = this.readSecondary(key, storedKey);
            result = read instanceof Promise ? read.then(checked) : checked(read);
        } catch (error) {
            finish({error});
            throw error;
        }

        // Ветка stale L2 завершает flight сама: её ответ и итог обновления различаются.
        const complete = (value: CacheableValue<T>) => {
            if (!refreshOwnsCompletion) finish({value});
            return value;
        };
        if (result instanceof Promise) result = result.then(complete, error => { finish({error}); throw error; });
        else complete(result);

        return result;
    }

    private publish(key: string, storedKey: string, value: CacheableValue<T>, ttl: number, publication?: Publication): MayBePromise<void> {
        const time = Date.now();
        const entry = {value, time, staleAt: time + ttl * this.staleRatio, expAt: time + ttl};
        this.primary.set(storedKey, entry);
        if (publication && !publication.active) return;
        try {
            const written = this.secondary.set(storedKey, entry);
            if (written instanceof Promise) return written.catch(error => {
                if (error instanceof StoreTransformError) throw error;
                this.report(error, key, 'l2.set');
            }).then(() => undefined);
        } catch (error) {
            if (error instanceof StoreTransformError) throw error;
            this.report(error, key, 'l2.set');
        }
    }

    private readSecondary(key: string, storedKey: string): MayBePromise<StoreValue<T> | undefined> {
        try {
            const read = this.secondary.get(storedKey);
            if (read instanceof Promise) return read.catch(error => {
                if (error instanceof StoreTransformError) throw error;
                this.report(error, key, 'l2.get');
                return undefined;
            });
            return read;
        } catch (error) {
            if (error instanceof StoreTransformError) throw error;
            this.report(error, key, 'l2.get');
            return undefined;
        }
    }

    private toReader(value: CacheableValue<T>): CacheableValue<T> {
        return this.cloneValue ? this.cloneValue(value) : value;
    }

    private report(error: unknown, key: string, operation: 'l2.get' | 'l2.set' | 'refresh'): void {
        try { this.onError?.(error, {key, operation}); } catch { /* Диагностика не меняет результат операции. */ }
    }

    private track(key: string, publication: Publication): void {
        let pending = this.publications.get(key);
        if (!pending) this.publications.set(key, pending = new Set());
        pending.add(publication);
    }

    private release(key: string, publication: Publication): void {
        const pending = this.publications.get(key);
        pending?.delete(publication);
        if (pending?.size === 0) this.publications.delete(key);
    }

    private detach(key: string): void {
        this.publications.get(key)?.forEach(publication => { publication.active = false; });
        this.publications.delete(key);
        this.flights.delete(key);
    }
}
