import assert from 'node:assert/strict';
import { FlashCache, MapStore } from '@bidster/flash-cache';
import { Cacheable } from 'cacheable';
import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';
import { LRUCache } from 'lru-cache';
import { Bench } from 'tinybench';

// Из корня: yarn install --frozen-lockfile && yarn build
// Затем: cd bench && npm ci && npm run bench (Node 22.22.0, npm 10.9.4).
// Последовательный cache-aside в памяти: get → async loader при miss → set.
// Нет Redis, сериализации, SWR, eviction и конкуренции. lru-cache — один уровень,
// остальные — два. Loader возвращает готовую строку без I/O.
// Await только для Promise: синхронный L1-hit сохраняет быстрый путь.
// Один sample Tinybench — целая трасса; таблица показывает время и throughput ТРАСС,
// а не отдельных запросов. Для ns/op делите latency на OPERATIONS, для ops/s
// умножайте throughput на OPERATIONS. Это не request p99.
// Все участники работают в одном процессе: GC/JIT и порядок могут влиять на цифры.
// Для публикации сохраняйте весь вывод, commit, версии Node/ОС и модель CPU;
// повторяйте полный запуск, не выбирая лучшие результаты отдельных библиотек.

const OPERATIONS = 10_000;
const KEYS = 1024;
const PAYLOAD_BYTES = 256;
const TTL = 3_600_000;
const SEED = 42;
const TIMING = { time: 1000, iterations: 16, warmupTime: 250, warmupIterations: 8 };
const libraries = ['flash-cache', 'cacheable', 'cache-manager'];
assert.equal(OPERATIONS % 10, 0, 'OPERATIONS must be divisible by 10');

let seed = SEED;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
}

function makeCache(name, capacity) {
  if (name === 'flash-cache') {
    const primary = new MapStore();
    const secondary = new MapStore();
    const cache = new FlashCache(primary, secondary, { ttl: TTL, staleRatio: 1, namespace: false });
    return {
      get: (key) => {
        const result = cache.get(key);
        if (result instanceof Promise) return result.then((entry) => entry.state === 'fresh' ? entry.value : undefined);
        return result.state === 'fresh' ? result.value : undefined;
      },
      set: (key, value) => cache.set(key, value),
      close: () => { primary.clear(); secondary.clear(); },
    };
  }
  if (name === 'cacheable' || name === 'cache-manager') {
    const stores = [0, 1].map(() => new Keyv({
      store: new Map(), serialize: undefined, deserialize: undefined,
      useKeyPrefix: false, throwOnErrors: true,
    }));
    for (const store of stores) store.on('error', (error) => { throw error; });
    const cache = name === 'cacheable'
      ? new Cacheable({ primary: stores[0], secondary: stores[1], ttl: TTL, nonBlocking: false, stats: false })
      : createCache({ stores, ttl: TTL, nonBlocking: false });
    cache.on('error', (event) => { throw event.error ?? event; });
    // cache-manager иначе может представить ошибку чтения как обычный miss.
    if (name === 'cache-manager') cache.on('get', (event) => { if (event.error) throw event.error; });
    return {
      get: (key) => cache.get(key),
      set: (key, value) => cache.set(key, value, TTL),
      close: async () => {
        await Promise.all(stores.map((store) => store.clear()));
        await cache.disconnect();
      },
    };
  }
  assert.equal(name, 'lru-cache');
  const cache = new LRUCache({
    max: capacity, ttl: TTL, ttlResolution: 0,
    ttlAutopurge: false, updateAgeOnGet: false, allowStale: false,
  });
  return {
    get: (key) => cache.get(key),
    set: (key, value) => cache.set(key, value),
    close: () => cache.clear(),
  };
}

console.log({ node: process.version, operationsPerSample: OPERATIONS, seed: SEED, ...TIMING });
const values = Array.from({ length: KEYS }, (_, i) => `value:${i}:`.padEnd(PAYLOAD_BYTES, '.'));
const loader = async (value) => value;

for (const [scenario, missRatio] of [['hot', 0], ['mixed', 0.1], ['cold', 1]]) {
  const misses = OPERATIONS * missRatio;
  const preload = scenario === 'cold' ? [] : values.map((value, i) => [`hot:${i}`, value]);
  const requests = Array.from({ length: OPERATIONS }, (_, i) => {
    const id = Math.floor(random() * KEYS);
    return { key: i < misses ? `cold:${i}` : `hot:${id}`, value: values[id] };
  });
  // Фиксированная трасса для всех библиотек; cold-ключи уникальны.
  for (let i = requests.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [requests[i], requests[j]] = [requests[j], requests[i]];
  }
  const order = [...libraries];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const bench = new Bench({ ...TIMING, throws: true });
  if (process.env.BENCH_REVERSE === '1') order.reverse();
  for (const name of order) {
    let cache;
    let loads;
    let setupStarted;
    bench.add(`${name} (${name === 'lru-cache' ? '1 tier' : '2 tiers'})`, async () => {
      for (const request of requests) {
        const result = cache.get(request.key);
        let value = result instanceof Promise ? await result : result;
        if (value === undefined) {
          loads++;
          value = await loader(request.value);
          await cache.set(request.key, value);
        }
        // Одинаковая проверка каждого значения включена в замер.
        if (value !== request.value) throw new Error(`Wrong value for ${request.key}`);
      }
    }, {
      // Hooks работают вне таймера, включая прогрев. Новый кэш сохраняет miss ratio.
      beforeEach: async () => {
        loads = 0;
        setupStarted = Date.now();
        cache = makeCache(name, preload.length + misses + 1);
        for (const [key, value] of preload) await cache.set(key, value);
      },
      afterEach: async () => {
        try {
          assert.equal(loads, misses, `${name}: unexpected miss count`);
          assert.ok(Date.now() - setupStarted < TTL / 2, 'TTL could affect the result');
        } finally {
          await cache?.close();
          cache = undefined;
        }
      },
    });
  }
  await bench.run();
  console.log(`\n${scenario}: ${100 * (1 - missRatio)}% hits, ${OPERATIONS} operations/sample`);
  console.table(bench.table());
}
