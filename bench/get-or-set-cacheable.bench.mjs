import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { cpus, release } from 'node:os';
import { FlashCache, MapStore } from '../dist/cjs/index.js';
import { Cacheable } from 'cacheable';
import { Keyv } from 'keyv';
import { Bench } from 'tinybench';

// После yarn build в корне: cd bench && npm run bench:get-or-set-cacheable.
// У обоих два Map-уровня, TTL 1 час, без клонирования и сериализации значений.
// У Keyv + Map нет useClones: serialize/deserialize:undefined сохраняют ссылки.
// Cacheable.wrap получает готовый ключ через createKey. В версии 2.5.0 wrap
// всё равно сначала вычисляет стандартный hash аргументов — его стоимость входит
// в замер. FlashCache принимает готовый ключ непосредственно.
// Только последовательные запросы, async loader без I/O, без SWR и eviction.
// Await только для Promise: синхронный hit FlashCache сохраняет быстрый путь.
// Новый кэш перед каждой трассой; подготовка и проверки stores вне таймера.
// Проверка ссылки каждого результата внутри таймера гарантирует отсутствие clones.
// ns/op — среднее время всей трассы / число запросов; это НЕ request p99.
// BENCH_REVERSE=1 меняет порядок, BENCH_OUTPUT сохраняет JSON одного запуска.

const KEYS = 1024;
const TTL = 3_600_000;
const TIMING = { time: 1000, iterations: 16, warmupTime: 250, warmupIterations: 8 };
const values = Array.from({ length: KEYS }, (_, id) => ({ id, payload: '.'.repeat(256) }));
const results = [];
const metadata = {
    node: process.version,
    platform: process.platform,
    os: release(),
    cpu: cpus()[0].model,
    flashCache: 'current working tree',
    cacheable: '2.5.0',
    keyv: '5.6.0',
    stores: ['Map', 'Map'],
    cloning: false,
    valueSerialization: false,
    ttl: TTL,
    keys: KEYS,
    payload: 'object with id and 256-character string',
    order: process.env.BENCH_REVERSE === '1' ? 'reverse' : 'normal',
    ...TIMING,
};
console.log(metadata);

for (const [scenario, missRatio] of [
    ['L1 hit', 0],
    ['L2 hit', 0],
    ['mixed 10% miss', 0.1],
    ['cold 100% miss', 1],
]) {
    const operations = scenario === 'L2 hit' ? KEYS : 10_000;
    const misses = operations * missRatio;
    const preload = scenario === 'cold 100% miss' ? [] : values.map((value, id) => [`hot:${id}`, value]);
    const requests = Array.from({ length: operations }, (_, i) => ({
        key: i < misses ? `cold:${i}` : `hot:${(i * 997) % KEYS}`,
        value: values[(i * 997) % KEYS],
    }));
    // Фиксированная перестановка одинаковой трассы для обоих участников.
    let seed = 42;
    for (let i = requests.length - 1; i > 0; i--) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const j = (seed >>> 0) % (i + 1);
        [requests[i], requests[j]] = [requests[j], requests[i]];
    }
    const payloads = new Map(requests.map(({ key, value }) => [key, value]));
    const order = ['FlashCache.getOrSet', 'Cacheable.wrap'];
    if (process.env.BENCH_REVERSE === '1') order.reverse();
    const bench = new Bench({ ...TIMING, throws: true });
    for (const name of order) {
        let read, stores, close, loads, started;
        bench.add(
            name,
            async () => {
                for (const request of requests) {
                    const result = read(request.key);
                    const value = result instanceof Promise ? await result : result;
                    if (value !== request.value)
                        throw new Error(`${name}: wrong value or cloned object for ${request.key}`);
                }
            },
            {
                beforeEach: async () => {
                    loads = 0;
                    started = Date.now();
                    const loader = async (key) => {
                        loads++;
                        return payloads.get(key);
                    };
                    if (name === 'FlashCache.getOrSet') {
                        stores = [new MapStore(), new MapStore()];
                        assert.ok(stores.every((store) => store instanceof Map));
                        const cache = new FlashCache(stores[0], stores[1], {
                            ttl: TTL,
                            staleRatio: 1,
                            namespace: false,
                        });
                        for (const [key, value] of preload) await cache.set(key, value);
                        if (scenario === 'L2 hit') stores[0].clear();
                        read = (key) => cache.getOrSet(key, () => loader(key));
                        close = () => {
                            for (const store of stores) store.clear();
                        };
                    } else {
                        stores = [0, 1].map(
                            () =>
                                new Keyv({
                                    store: new Map(),
                                    serialize: undefined,
                                    deserialize: undefined,
                                    useKeyPrefix: false,
                                    throwOnErrors: true,
                                }),
                        );
                        assert.ok(stores.every((store) => store.store instanceof Map));
                        for (const store of stores) {
                            assert.equal(store.serialize, undefined);
                            assert.equal(store.deserialize, undefined);
                            store.on('error', (error) => {
                                throw error;
                            });
                        }
                        const cache = new Cacheable({
                            primary: stores[0],
                            secondary: stores[1],
                            ttl: TTL,
                            nonBlocking: false,
                            stats: false,
                        });
                        cache.on('error', (error) => {
                            throw error;
                        });
                        for (const [key, value] of preload) await cache.set(key, value);
                        if (scenario === 'L2 hit') await stores[0].clear();
                        read = cache.wrap(loader, { createKey: (_fn, args) => args[0] });
                        close = async () => {
                            await cache.clear();
                            await cache.disconnect();
                        };
                    }
                },
                afterEach: async () => {
                    try {
                        assert.equal(loads, misses, `${name}: unexpected loader count`);
                        assert.ok(Date.now() - started < TTL / 2, 'TTL could affect the result');
                        assert.equal(
                            name === 'FlashCache.getOrSet' ? stores[0].size : stores[0].store.size,
                            preload.length + misses,
                        );
                        for (const request of requests) {
                            for (const store of stores) {
                                const stored = await store.get(request.key);
                                assert.equal(name === 'FlashCache.getOrSet' ? stored.value : stored, request.value);
                            }
                        }
                    } finally {
                        await close();
                    }
                },
            },
        );
    }
    await bench.run();
    const rows = bench.tasks.map((task) => ({
        scenario,
        name: task.name,
        operationsPerSample: operations,
        nsPerOp: (task.result.latency.mean * 1e6) / operations,
        opsPerSecond: (operations * 1000) / task.result.latency.mean,
        rmePercent: task.result.latency.rme,
        samples: task.result.latency.samples.length,
    }));
    results.push(...rows);
    console.table(rows);
}
if (process.env.BENCH_OUTPUT) {
    await writeFile(process.env.BENCH_OUTPUT, `${JSON.stringify({ metadata, results }, null, 2)}\n`);
}
