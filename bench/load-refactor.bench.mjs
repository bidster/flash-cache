import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const baseline = process.argv[2];
assert(baseline, 'Pass the pre-refactor flash-cache.ts snapshot as the first argument');
const sourcePaths = { before: resolve(baseline), after: new URL('../src/flash-cache.ts', import.meta.url) };
const sources = {};
const constructors = {};
const directory = await mkdtemp(join(os.tmpdir(), 'flash-cache-load-bench-'));
try {
    for (const [version, path] of Object.entries(sourcePaths)) {
        const source = await readFile(path, 'utf8');
        sources[version] = { path: String(path), sha256: createHash('sha256').update(source).digest('hex') };
        const compiled = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, strict: true },
        }).outputText;
        const destination = join(directory, `${version}.cjs`);
        await writeFile(destination, compiled);
        constructors[version] = require(destination).FlashCache;
        assert.equal(typeof constructors[version], 'function');
    }
} finally {
    await rm(directory, { recursive: true });
}

const rounds = 21;
const warmup = 8;
const ttl = 3_600_000;
const keys = Array.from({ length: 4096 }, (_, i) => `key:${i}`);
const scenarios = [
    { name: 'fresh-l1-sync', count: 200_000, kind: 'hot' },
    { name: 'fresh-l1-await', count: 100_000, kind: 'hot', awaitHit: true },
    { name: 'fresh-l2-sync-store', count: 4096, kind: 'l2' },
    { name: 'fresh-l2-async-store', count: 4096, kind: 'l2', asyncStore: true },
    { name: 'miss-sync-factory', count: 4096, kind: 'miss' },
    { name: 'miss-async-factory', count: 4096, kind: 'miss', asyncFactory: true },
    { name: 'miss-async-store-and-factory', count: 4096, kind: 'miss', asyncStore: true, asyncFactory: true },
    { name: 'stale-l1-pending-refresh', count: 100_000, kind: 'pending' },
    { name: 'stale-l1-sync-refresh-full-cycle', count: 4096, kind: 'refresh' },
    { name: 'stale-l1-async-refresh-full-cycle', count: 4096, kind: 'refresh', asyncFactory: true },
    {
        name: 'stale-l2-async-refresh-full-cycle',
        count: 4096,
        kind: 'refresh',
        fromL2: true,
        asyncFactory: true,
        asyncStore: true,
    },
    { name: 'singleflight-32-readers', count: 256 * 32, kind: 'flight' },
];

async function measure(version, scenario) {
    const primary = new Map();
    const raw = new Map();
    const secondary = scenario.asyncStore
        ? {
              get: async (key) => raw.get(key),
              set: async (key, value) => {
                  raw.set(key, value);
              },
              delete: async (key) => {
                  raw.delete(key);
              },
          }
        : raw;
    const cache = new constructors[version](primary, secondary, { ttl, staleRatio: 0.8, namespace: false });
    const time = Date.now();
    const fresh = { value: 42, time, staleAt: time + ttl * 0.8, expAt: time + ttl };
    if (scenario.kind === 'hot') for (const key of keys) primary.set(key, fresh);
    if (scenario.kind === 'l2') for (const key of keys) raw.set(key, fresh);
    if (scenario.kind === 'refresh') {
        for (const key of keys) (scenario.fromL2 ? raw : primary).set(key, { ...fresh, staleAt: time - 1 });
    }
    let finish;
    if (scenario.kind === 'pending') {
        primary.set(keys[0], { ...fresh, staleAt: time - 1 });
        const pending = new Promise((resolve) => {
            finish = resolve;
        });
        assert.equal(
            cache.getOrSet(keys[0], () => pending),
            42,
        );
        await nextTurn();
    }
    let calls = 0;
    let sum = 0;
    const value = scenario.kind === 'refresh' ? 43 : 42;
    const load = scenario.asyncFactory
        ? async () => {
              calls++;
              return value;
          }
        : () => {
              calls++;
              return value;
          };
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
            const readers = Array.from({ length: 32 }, () => cache.getOrSet(keys[batch], loader));
            resolve(42);
            for (const value of await Promise.all(readers)) sum += value;
        }
    } else if ((scenario.kind === 'hot' && !scenario.awaitHit) || scenario.kind === 'pending') {
        for (let i = 0; i < scenario.count; i++) {
            sum += cache.getOrSet(keys[scenario.kind === 'pending' ? 0 : i % keys.length], load);
        }
    } else {
        for (let i = 0; i < scenario.count; i++) {
            const response = cache.getOrSet(keys[i % keys.length], load);
            sum += scenario.awaitHit || response instanceof Promise ? await response : response;
        }
        if (scenario.kind === 'refresh') await nextTurn();
    }
    const elapsed = Number(process.hrtime.bigint() - start);
    assert.equal(sum, scenario.count * 42, `${version}: ${scenario.name}: response`);
    const expectedCalls =
        scenario.kind === 'flight'
            ? scenario.count / 32
            : ['miss', 'refresh'].includes(scenario.kind)
              ? scenario.count
              : 0;
    assert.equal(calls, expectedCalls, `${version}: ${scenario.name}: factory count`);
    if (scenario.kind === 'refresh') {
        for (let i = 0; i < scenario.count; i++) {
            assert.equal(primary.get(keys[i]).value, 43);
            assert.equal(raw.get(keys[i]).value, 43);
        }
    }
    finish?.(42);
    await nextTurn();
    return elapsed / scenario.count;
}

const results = [];
for (const scenario of scenarios) {
    const samples = { before: [], after: [] };
    for (let round = -warmup; round < rounds; round++) {
        const order = Math.abs(round) % 2 ? ['after', 'before'] : ['before', 'after'];
        if (process.env.BENCH_REVERSE === '1') order.reverse();
        for (const version of order) {
            if (process.env.BENCH_VERSION && process.env.BENCH_VERSION !== version) continue;
            global.gc?.();
            const ns = await measure(version, scenario);
            if (round >= 0) samples[version].push(ns);
        }
    }
    const summary = Object.fromEntries(
        Object.entries(samples)
            .filter(([, values]) => values.length)
            .map(([version, values]) => {
                const sorted = values.toSorted((a, b) => a - b);
                return [version, { medianNs: sorted[10], p25Ns: sorted[5], p75Ns: sorted[15], samplesNs: values }];
            }),
    );
    const deltaPercent =
        summary.before && summary.after ? (summary.after.medianNs / summary.before.medianNs - 1) * 100 : undefined;
    results.push({ scenario: scenario.name, operationsPerSample: scenario.count, ...summary, deltaPercent });
    console.log(
        `${scenario.name}: ${Object.entries(summary)
            .map(([version, value]) => `${version} ${value.medianNs.toFixed(1)} ns/op`)
            .join(', ')}${deltaPercent === undefined ? '' : ` (${deltaPercent.toFixed(1)}%)`}`,
    );
}
const output = {
    createdAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    sources,
    rounds,
    warmup,
    onlyVersion: process.env.BENCH_VERSION ?? null,
    reversedOrder: process.env.BENCH_REVERSE === '1',
    explicitGc: Boolean(global.gc),
    methodology:
        'Both snapshots transpiled with the same TypeScript/ES2019/CommonJS settings. Identical in-memory stores and payloads; no cloning, network or I/O. Preparation excluded. Versions alternate; explicit GC between samples, GC during timing included. Refresh full-cycle includes the event-loop barrier and both store writes. Singleflight ns/op is per reader.',
    results,
};
if (process.env.BENCH_OUTPUT) await writeFile(process.env.BENCH_OUTPUT, JSON.stringify(output, null, 2) + '\n');
