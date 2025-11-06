import { Redis } from 'ioredis';
import { MayBeAsyncStore, StoreValue } from '../flash-cache.js';

export class IORedisStore<T = any> implements MayBeAsyncStore<T> {
  constructor(private client: Redis) {}

  private serialize(value: StoreValue<T>): string {
    return JSON.stringify(value);
  }

  private deserialize(raw: string): StoreValue<T> | undefined {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async get(key: string): Promise<StoreValue<T> | undefined> {
    const raw = await this.client.get(key);
    if (!raw) return undefined;
    return this.deserialize(raw);
  }

  async set(key: string, value: StoreValue<T>): Promise<void> {
    await this.client.set(
      key,
      this.serialize(value),
      'PXAT',
      value.expAt,
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }
}
