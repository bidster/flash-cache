import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';

// Прямые импорты текущей сборки исключают устаревшую file:-зависимость bench/node_modules.
const require = createRequire(import.meta.url);
const { FlashCache, MapStore } = require('../dist/cjs/index.js');
const rounds = 21;
const warmup = 8;
const ttl = 3_600_000;
const factory = () => 42;
const asyncFactory = async () => 42;
const keys = Array.from({ length: 4096 }, (_, i) => `key:${i}`);
const object = {
    id: 42,
    name: 'Igor',
    preferences: { theme: 'dark', tags: ['a', 'b', 'c'] },
    scores: Array.from({ length: 16 }, (_, i) => i),
};

const scenarios = [
    { name: 'fresh-l1-sync', count: 200_000, kind: 'hot' },
    { name: 'fresh-l1-await', count: 100_000, kind: 'hot', awaitHit: true },
    { name: 'fresh-l1-clone', count: 20_000, kind: 'hot', clone: true },
    { name: 'stale-l1-pending-refresh', count: 100_000, kind: 'stale' },
    { name: 'fresh-l2-sync-store', count: 4096, kind: 'l2' },
    { name: 'fresh-l2-async-store', count: 4096, kind: 'l2', asyncStore: true },
    { name: 'miss-sync-factory', count: 4096, kind: 'miss' },
    { name: 'miss-async-factory', count: 4096, kind: 'miss', asyncFactory: true },
    { name: 'singleflight-32-readers', count: 256 * 32, kind: 'flight' },
];

async function prepare(scenario) {
    const l1 = new MapStore();
    const l2 = new MapStore();
    const secondary = scenario.asyncStore
        ? {
              get: async (key) => l2.get(key),
              set: async (key, entry) => {
                  l2.set(key, entry);
              },
              delete: async (key) => {
                  l2.delete(key);
              },
          }
        : l2;
    const options = { ttl, staleRatio: 0.8, namespace: false };
    const cache = new FlashCache(l1, secondary, {
        ...options,
        ...(scenario.clone ? { cloneValue: structuredClone } : {}),
    });
    const read = (key, load) => cache.getOrSet(key, load);
    const time = Date.now();
    const value = scenario.clone ? object : 42;
    const fresh = { value, time, staleAt: time + ttl * 0.8, expAt: time + ttl };
    if (scenario.kind === 'hot') for (const key of keys) l1.set(key, fresh);
    if (scenario.kind === 'l2') for (const key of keys) l2.set(key, fresh);
    let finish;
    if (scenario.kind === 'stale') {
        l1.set(keys[0], { ...fresh, staleAt: time - 1 });
        const pending = new Promise((resolve) => {
            finish = resolve;
        });
        assert.equal(
            read(keys[0], () => pending),
            42,
        );
        await nextTurn();
    }
    return { read, finish };
}

async function measure(scenario) {
    const { read, finish } = await prepare(scenario);
    let sum = 0;
    let calls = 0;
    const load = scenario.asyncFactory ? asyncFactory : factory;
    const start = process.hrtime.bigint();
    if (scenario.kind === 'flight') {
        for (let batch = 0; batch < scenario.count / 32; batch++) {
            let resolve;
            const pending = new Promise((done) => {
                resolve = done;
            });
            const loader = () => {
                calls++;
                return pending;
            };
            const requests = Array.from({ length: 32 }, () => read(keys[batch], loader));
            resolve(42);
            const values = await Promise.all(requests);
            for (const value of values) sum += value;
        }
    } else if ((scenario.kind === 'hot' && !scenario.awaitHit) || scenario.kind === 'stale') {
        for (let i = 0; i < scenario.count; i++) {
            const value = read(keys[scenario.kind === 'stale' ? 0 : i % keys.length], load);
            sum += scenario.clone ? value.id : value;
        }
    } else {
        for (let i = 0; i < scenario.count; i++) {
            const value = read(keys[i % keys.length], load);
            // На sync miss не добавляем искусственный await; fresh-l1-await измеряется отдельно.
            sum += scenario.awaitHit || value instanceof Promise ? await value : value;
        }
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);
    assert.equal(sum, scenario.count * 42, `${scenario.name}: result mismatch`);
    if (scenario.kind === 'flight') assert.equal(calls, scenario.count / 32, 'one factory per batch');
    finish?.(42);
    await nextTurn(); // Очистка фоновой работы не входит в время выдачи stale.
    return elapsedNs / scenario.count;
}

const results = [];
for (const scenario of scenarios) {
    const samples = [];
    for (let round = -warmup; round < rounds; round++) {
        global.gc?.();
        const ns = await measure(scenario);
        if (round >= 0) samples.push(ns);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    const result = {
        scenario: scenario.name,
        operationsPerSample: scenario.count,
        medianNs: sorted[10],
        p25Ns: sorted[5],
        p75Ns: sorted[15],
        samplesNs: samples,
    };
    results.push(result);
    console.log(`${scenario.name}: ${result.medianNs.toFixed(1)} ns/op`);
}
const output = {
    createdAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    rounds,
    warmup,
    explicitGc: Boolean(global.gc),
    methodology:
        'Median ns/operation; MapStore, namespace:false, 4096 keys; no clones except clone case; prefill excluded; in-process async store without network; singleflight per reader, 32 readers per load; stale measures an existing pending refresh.',
    results,
};
if (process.env.BENCH_OUTPUT) {
    await writeFile(process.env.BENCH_OUTPUT, JSON.stringify(output, null, 2) + '\n');
}
