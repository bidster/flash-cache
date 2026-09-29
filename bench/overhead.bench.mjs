import assert from 'node:assert/strict';
import { FlashCache, MapStore } from '@bidster/flash-cache';
import { LRUCache } from 'lru-cache';
import { Bench } from 'tinybench';

// Свежие L1-hit: одинаковый LRU, max и последовательность ключей, без eviction.
// TTL самого LRU выключен у обоих: FlashCache добавляет собственные проверки TTL,
// метаданные записи, namespace:false и объект CacheResult — это часть overhead.
// Третий участник намеренно делает лишний await для оценки стоимости этого вызова.
// Один async-вызов Tinybench обрабатывает всю трассу; sync-пути не await-ятся в цикле.
// Для ns/op делите latency таблицы на OPERATIONS. BENCH_REVERSE=1 меняет порядок.
const OPERATIONS = 10_000;
const KEYS = 1024;
const TTL = 3_600_000;
const requests = Array.from({ length: OPERATIONS }, (_, i) => `key:${(i * 997) % KEYS}`);
const value = 'value:'.padEnd(256, '.');
const bench = new Bench({ time: 1000, iterations: 16, warmupTime: 250, warmupIterations: 8, throws: true });
const order = ['LRU direct', 'FlashCache + LRU', 'FlashCache + LRU + await'];
if (process.env.BENCH_REVERSE === '1') order.reverse();
for (const name of order) {
  let read, primary, secondary, started;
  bench.add(name, async () => {
    for (const key of requests) {
      const result = read(key);
      const actual = name === 'FlashCache + LRU + await' ? await result : result;
      if (actual !== value) throw new Error(`${name}: incorrect or asynchronous result`);
    }
  }, {
    beforeEach: async () => {
      started = Date.now();
      primary = new LRUCache({ max: KEYS, ttl: 0 });
      secondary = new MapStore();
      secondary.get = () => { throw new Error('Fresh L1-hit must not access L2'); };
      if (name === 'LRU direct') {
        for (let i = 0; i < KEYS; i++) primary.set(`key:${i}`, value);
        read = (key) => primary.get(key);
      } else {
        const cache = new FlashCache(primary, secondary, { ttl: TTL, staleRatio: 1, namespace: false });
        for (let i = 0; i < KEYS; i++) await cache.set(`key:${i}`, value);
        assert.ok(!(cache.get('key:0') instanceof Promise));
        read = (key) => cache.get(key).value;
      }
    },
    afterEach: () => {
      assert.ok(Date.now() - started < TTL / 2, 'TTL could affect the result');
      primary.clear();
      secondary.clear();
    },
  });
}
await bench.run();
console.log(`\nLRU overhead, ${OPERATIONS} operations/sample`);
console.table(bench.table());
