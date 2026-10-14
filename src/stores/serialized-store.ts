import type {MayBeAsyncStore, MayBePromise, StoreValue} from '../types.js';

/** Ошибка преобразования данных, которую нельзя трактовать как недоступность L2. */
export class StoreTransformError extends Error {
    constructor(operation: 'serialize' | 'deserialize', readonly cause: unknown) {
        super(`Store ${operation} failed`);
        this.name = 'StoreTransformError';
    }
}

/** Формат хранения задаётся один раз; метаданные времени передаются без изменений. */
export class SerializedStore<Value, StoredValue> implements MayBeAsyncStore<Value> {
    constructor(
        private readonly store: MayBeAsyncStore<StoredValue>,
        private readonly codec: {
            serialize: (value: Value) => StoredValue;
            deserialize: (value: StoredValue) => Value;
        },
    ) {}

    get(key: string): MayBePromise<StoreValue<Value> | undefined> {
        const read = this.store.get(key);
        const decode = (entry: StoreValue<StoredValue> | undefined): StoreValue<Value> | undefined => {
            if (!entry) return undefined;
            try { return {...entry, value: this.codec.deserialize(entry.value)}; }
            catch (error) { throw new StoreTransformError('deserialize', error); }
        };
        return read instanceof Promise ? read.then(decode) : decode(read);
    }

    set(key: string, entry: StoreValue<Value>): MayBePromise<void> {
        let value: StoredValue;
        try { value = this.codec.serialize(entry.value); }
        catch (error) { throw new StoreTransformError('serialize', error); }
        const written = this.store.set(key, {...entry, value});
        if (written instanceof Promise) return written.then(() => undefined);
    }

    delete(key: string): MayBePromise<void> {
        const removed = this.store.delete(key);
        if (removed instanceof Promise) return removed.then(() => undefined);
    }
}
