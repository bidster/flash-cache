import { Redis } from 'ioredis';
import type { MayBeAsyncStore, StoreValue } from '../types.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class IORedisStore implements MayBeAsyncStore<JsonValue> {
    constructor(private readonly client: Redis) {}

    async get(key: string): Promise<StoreValue<JsonValue> | undefined> {
        const raw = await this.read(key);
        if (!raw) return undefined;

        return JSON.parse(raw) as StoreValue<JsonValue>;
    }

    async set(key: string, value: StoreValue<JsonValue>): Promise<void> {
        const raw = JSON.stringify(value);
        await this.write(key, raw, value.expAt);
    }

    async delete(key: string): Promise<void> {
        await this.remove(key);
    }

    /** Override to wrap Redis reads without including JSON parsing. */
    protected read(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    /** Receives serialized JSON and the absolute expiry time in milliseconds. */
    protected async write(key: string, raw: string, expAt: number): Promise<void> {
        await this.client.set(key, raw, 'PXAT', expAt);
    }

    /** Override to wrap Redis deletions. */
    protected async remove(key: string): Promise<void> {
        await this.client.del(key);
    }
}
