import { Redis } from 'ioredis';
import { MayBeAsyncStore, StoreValue } from '../flash-cache.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class IORedisStore implements MayBeAsyncStore<JsonValue> {
  constructor(private readonly client: Redis) {}

  async get(key: string): Promise<StoreValue<JsonValue> | undefined> {
    const raw = await this.client.get(key);
    if (!raw) return undefined;

    return JSON.parse(raw) as StoreValue<JsonValue>;
  }

  async set(key: string, value: StoreValue<JsonValue>): Promise<void> {
    await this.client.set(
      key,
      JSON.stringify(value),
      'PXAT',
      value.expAt,
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }
}
