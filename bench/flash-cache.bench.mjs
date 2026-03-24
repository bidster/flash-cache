import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { Bench } from 'tinybench';

import { FlashCache } from '../dist/esm/flash-cache.js';
import { FlashMemo } from '../dist/esm/flash-memo.js';
import { MapStore } from '../dist/esm/stores/map-store.js';

const namespace = 'bench';
const ttl = 10_000;
const staleRatio = 0.4;
const staleEntryOffset = 1;
const freshEntryOffset = 5_000;
const baselinePath = new URL('./flash-cache.baseline.json', import.meta.url);
const defaultThreshold = 0.15;

function createCachePair() {
  const l1 = new MapStore();
  const l2 = new MapStore();
  const cache = new FlashCache(l1, l2, { ttl, staleRatio, namespace });
  const memo = new FlashMemo(cache);

  return { cache, memo, l1, l2 };
}

async function drainMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function toEntry(value, staleAtOffset, expAtOffset = ttl) {
  const now = Date.now();

  return {
    value,
    time: now,
    staleAt: now + staleAtOffset,
    expAt: now + expAtOffset,
  };
}

function toPrefixedKey(key) {
  return `flashCache:v1:${namespace}:${key}`;
}

function primeFresh(cache, key, value) {
  return cache.set(key, value);
}

function primeStale(store, key, staleValue, freshValue) {
  const prefixedKey = toPrefixedKey(key);

  store.l1.set(prefixedKey, toEntry(staleValue, -staleEntryOffset));
  store.l2.set(prefixedKey, toEntry(freshValue, freshEntryOffset));
}

function resetMissKey(store, key) {
  const prefixedKey = toPrefixedKey(key);

  store.l1.delete(prefixedKey);
  store.l2.delete(prefixedKey);
}

function createBench() {
  const freshGet = createCachePair();
  const staleGet = createCachePair();
  const freshMemo = createCachePair();
  const staleMemo = createCachePair();
  const staleMemoLoader = async () => 'fresh-value';
  const missMemo = createCachePair();
  const missMemoLoader = async () => 'loaded-value';

  const bench = new Bench({
    time: 300,
    warmupTime: 100,
  });

  bench
    .add('get() fresh entry', () => {
      freshGet.cache.get('fresh-get');
    }, {
      beforeEach: async () => {
        await primeFresh(freshGet.cache, 'fresh-get', 'value');
      },
    })
    .add('get() stale entry with background refresh', async () => {
      await staleGet.cache.get('stale-get');
    }, {
      beforeEach: () => {
        primeStale(staleGet, 'stale-get', 'stale-value', 'fresh-value');
      },
      afterEach: () => drainMicrotasks(),
    })
    .add('memo() fresh entry', () => {
      freshMemo.memo.memoize('fresh-memo', async () => 'other-value');
    }, {
      beforeEach: async () => {
        await primeFresh(freshMemo.cache, 'fresh-memo', 'value');
      },
    })
    .add('memo() stale entry', () => {
      staleMemo.memo.memoize('stale-memo', staleMemoLoader);
    }, {
      beforeEach: () => {
        primeStale(staleMemo, 'stale-memo', 'stale-value', 'fresh-value');
      },
      afterEach: () => drainMicrotasks(),
    })
    .add('memo() miss entry', async () => {
      await missMemo.memo.memoize('miss-memo', missMemoLoader);
    }, {
      beforeEach: () => {
        resetMissKey(missMemo, 'miss-memo');
      },
    });

  return bench;
}

function summarizeBench(bench) {
  return {
    createdAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    benchmarks: bench.tasks.map((task) => {
      const { result } = task;

      if (!result) {
        throw new Error(`Missing result for benchmark "${task.name}"`);
      }

      return {
        name: task.name,
        hz: result.hz,
        meanLatencyNs: result.latency.mean * 1e6,
        medianLatencyNs: result.latency.p50 * 1e6,
        relativeMarginOfError: result.rme,
        samples: result.samples.length,
      };
    }),
  };
}

async function writeBaseline(summary) {
  await writeFile(baselinePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`Saved benchmark baseline to ${baselinePath.pathname}`);
}

async function readBaseline() {
  const raw = await readFile(baselinePath, 'utf8');

  return JSON.parse(raw);
}

function toBenchmarkMap(summary) {
  return new Map(summary.benchmarks.map((benchmark) => [benchmark.name, benchmark]));
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function compareWithBaseline(currentSummary, baselineSummary, threshold) {
  const baselineBenchmarks = toBenchmarkMap(baselineSummary);
  const regressions = [];
  const comparisons = [];

  for (const currentBenchmark of currentSummary.benchmarks) {
    const baselineBenchmark = baselineBenchmarks.get(currentBenchmark.name);

    if (!baselineBenchmark) {
      regressions.push(`Missing baseline for "${currentBenchmark.name}"`);
      continue;
    }

    const throughputDelta = (baselineBenchmark.hz - currentBenchmark.hz) / baselineBenchmark.hz;
    const latencyDelta =
      (currentBenchmark.meanLatencyNs - baselineBenchmark.meanLatencyNs) /
      baselineBenchmark.meanLatencyNs;

    comparisons.push({
      benchmark: currentBenchmark.name,
      baselineHz: Math.round(baselineBenchmark.hz),
      currentHz: Math.round(currentBenchmark.hz),
      throughputDelta: formatPercent(throughputDelta),
      baselineLatencyNs: Math.round(baselineBenchmark.meanLatencyNs),
      currentLatencyNs: Math.round(currentBenchmark.meanLatencyNs),
      latencyDelta: formatPercent(latencyDelta),
      status: throughputDelta > threshold ? 'FAIL' : 'PASS',
    });

    if (throughputDelta > threshold) {
      regressions.push(
        `"${currentBenchmark.name}" throughput dropped by ${formatPercent(throughputDelta)}`,
      );
    }
  }

  console.table(comparisons);

  if (regressions.length > 0) {
    throw new Error(
      `Benchmark regression check failed (threshold ${formatPercent(threshold)}):\n${regressions.join('\n')}`,
    );
  }

  console.log(`Benchmark regression check passed (threshold ${formatPercent(threshold)})`);
}

function readThreshold() {
  const rawThreshold = process.env.FLASH_CACHE_BENCH_THRESHOLD;

  if (!rawThreshold) {
    return defaultThreshold;
  }

  const threshold = Number(rawThreshold);

  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error('FLASH_CACHE_BENCH_THRESHOLD must be a non-negative number');
  }

  return threshold;
}

const command = process.argv[2] ?? 'run';
const bench = createBench();

await bench.run();

const summary = summarizeBench(bench);

console.table(bench.table());

if (command === 'baseline') {
  await writeBaseline(summary);
} else if (command === 'check') {
  const baseline = await readBaseline();
  compareWithBaseline(summary, baseline, readThreshold());
}
