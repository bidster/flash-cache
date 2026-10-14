export interface StoreValue<T> {
    value: T;
    time: number; // когда положили
    staleAt: number; // когда устареет
    expAt: number; // когда истечет
}

export type MayBePromise<T> = T | Promise<T>;
export type CacheableValue<T> = Exclude<T, undefined>;

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

