import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { FlashCache, FlashMemo, MapStore } from '@bidster/flash-cache';
import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';
import { Bench } from 'tinybench';

// npm run bench:memoize после yarn build в корне. Два Map-уровня, без сериализации.
// Сравниваем fresh memo-hit и выдачу stale с запуском обновления (SWR).
// Каждая трасса обращается к 1024 разным ключам один раз. В SWR оба участника
// возвращают старую строку и запускают ровно один loader на ключ.
// Loader ждёт общего барьера до конца замера: данные не успевают стать fresh
// посреди трассы. Это измерение выдачи stale и планирования обновлений, НЕ полного
// времени обновления и НЕ имитация задержки БД. Запущенные microtasks входят в замер.
// В afterEach барьер открывается, обновления завершаются и проверяются оба уровня.
// В SWR full-cycle барьер и ожидание следующей фазы event loop входят в таймер:
// учитываются выдача stale, все обновления in-memory stores и microtasks.
// Для подготовки возраста используем внутренний формат записей закреплённых версий:
// FlashCache {value,time,staleAt,expAt}, Keyv без сериализации {value,expires}.
// Исходный возраст: 0 для fresh, 75% TTL для stale; порог обновления: 50% TTL.
// Таймеры и Date.now не подменяются. Refresh продлевает TTL и обновляет ОБА уровня.
// Таблица Tinybench измеряет целую трассу, для ns/op делите latency на KEYS.
// Всё в одном процессе; повторяйте весь запуск при публикации результатов.

const KEYS = 1024;
const TTL = 3_600_000;
const TIMING = { time: 1000, iterations: 16, warmupTime: 250, warmupIterations: 8 };
const oldValue = 'old:'.padEnd(256, '.');
const newValue = 'new:'.padEnd(256, '.');
const keys = Array.from({ length: KEYS }, (_, i) => `key:${i}`);
console.log({ node: process.version, operationsPerSample: KEYS, ...TIMING });

for (const mode of ['fresh', 'SWR foreground', 'SWR full-cycle']) {
  const stale = mode !== 'fresh';
  const bench = new Bench({ ...TIMING, throws: true });
  const order = ['FlashMemo.memoize', 'cache-manager.wrap'];
  if (process.env.BENCH_REVERSE === '1') order.reverse();
  for (const name of order) {
    let read, stores, close, release, watchdog, started;
    let loads, timedOut;
    const loadedKeys = new Set();
    bench.add(name, async () => {
      for (const key of keys) {
        const result = read(key);
        const value = result instanceof Promise ? await result : result;
        if (value !== oldValue) throw new Error(`${name}: expected the original cached value`);
      }
      if (mode === 'SWR full-cycle') {
        release();
        await setImmediate();
      }
    }, {
      beforeEach: () => {
        loads = 0;
        timedOut = false;
        loadedKeys.clear();
        started = Date.now();
        const pending = new Promise((resolve) => { release = resolve; });
        // Не даём ошибочной реализации, ожидающей loader, навсегда повесить тест.
        watchdog = setTimeout(() => { timedOut = true; release(); }, 5000);
        const loader = async (key) => { loads++; loadedKeys.add(key); await pending; return newValue; };
        const time = started - (stale ? TTL * 0.75 : 0);
        if (name === 'FlashMemo.memoize') {
          stores = [new MapStore(), new MapStore()];
          const memo = new FlashMemo(new FlashCache(stores[0], stores[1], {
            ttl: TTL, staleRatio: 0.5, namespace: false,
          }));
          for (const key of keys) {
            for (const store of stores) store.set(key, { value: oldValue, time, staleAt: time + TTL / 2, expAt: time + TTL });
          }
          read = (key) => memo.memoize(key, () => loader(key));
          close = () => { for (const store of stores) store.clear(); };
        } else {
          stores = [0, 1].map(() => new Keyv({
            store: new Map(), serialize: undefined, deserialize: undefined,
            useKeyPrefix: false, throwOnErrors: true,
          }));
          for (const store of stores) {
            store.on('error', (error) => { throw error; });
            for (const key of keys) store.store.set(key, { value: oldValue, expires: time + TTL });
          }
          const cache = createCache({ stores, ttl: TTL, refreshThreshold: TTL / 2, refreshAllStores: true, nonBlocking: false });
          cache.on('refresh', (event) => { if (event.error) throw event.error; });
          read = (key) => cache.wrap(key, () => loader(key));
          close = async () => {
            await Promise.all(stores.map((store) => store.clear()));
            await cache.disconnect();
          };
        }
      },
      afterEach: async () => {
        clearTimeout(watchdog);
        release();
        try {
          // Для этих in-memory stores все Promise-цепочки завершаются до следующей фазы event loop.
          await setImmediate();
          assert.equal(timedOut, false, 'The foreground request waited for the blocked loader');
          assert.ok(Date.now() - started < TTL / 4, 'Entry age crossed a state boundary');
          assert.equal(loads, stale ? KEYS : 0);
          assert.equal(loadedKeys.size, stale ? KEYS : 0);
          for (const key of keys) {
            for (const store of stores) {
              const value = await store.get(key);
              assert.equal(name === 'FlashMemo.memoize' ? value.value : value, stale ? newValue : oldValue);
            }
            const result = read(key);
            assert.equal(result instanceof Promise ? await result : result, stale ? newValue : oldValue);
          }
          await setImmediate();
          assert.equal(loads, stale ? KEYS : 0, 'Updated entries must be fresh, without another refresh');
        } finally {
          await close();
        }
      },
    });
  }
  await bench.run();
  console.log(`\nmemoize ${mode}, ${KEYS} operations/sample`);
  console.table(bench.table());
}
