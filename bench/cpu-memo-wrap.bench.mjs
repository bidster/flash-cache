import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { FlashCache, FlashMemo, MapStore } from '@bidster/flash-cache';
import { Cacheable } from 'cacheable';
import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';

// Из корня: yarn build; затем cd bench && npm run bench:cpu.
// CPU = process.cpuUsage() (user + system, включая потоки GC), а не wall latency.
// Каждый участник/сценарий/повтор — отдельный процесс; процессы идут последовательно.
// Прогрев, подготовка и проверки вне измерения. GC внутри запроса входит в CPU.
// Основные цифры без профилировщика; отдельный V8 profile только для длинной трассы.
// Профиль использует больше ключей для достаточного количества samples:
// его проценты объясняют hotspots, а не являются основными CPU-результатами.
// Два Map, TTL 1 час, без clones/сериализации/Redis/eviction, async loader без I/O.
// Каждый результат проверяется по ссылке. Синхронный hit не получает лишний await.
// Cacheable.wrap хеширует аргументы даже при createKey; это часть публичного API.
// SWR full-cycle: loader ждёт барьера, затем обе записи обновляются до конца замера.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const TTL = 3_600_000;
const KEYS = 1024;
const libraries = ['flash-memo', 'cacheable', 'cache-manager'];
const scenarios = ['l1', 'l2', 'mixed', 'cold', 'swr'];
const values = Array.from({ length: KEYS }, (_, id) => ({ id, payload: '.'.repeat(256) }));
const updated = values.map((value) => ({ ...value, updated: true }));
const options = { useClones: false };

function makeRequests(scenario, operations) {
  const misses = scenario === 'cold' ? operations : scenario === 'mixed' ? operations / 10 : 0;
  const requests = Array.from({ length: operations }, (_, i) => ({
    key: scenario === 'l2' || scenario === 'swr' ? `hot:${i}`
      : i < misses ? `cold:${i}` : `hot:${(i * 997) % KEYS}`,
    value: values[(i * 997) % KEYS],
    updated: updated[(i * 997) % KEYS],
  }));
  let seed = 42;
  for (let i = requests.length - 1; i > 0; i--) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const j = (seed >>> 0) % (i + 1);
    [requests[i], requests[j]] = [requests[j], requests[i]];
  }
  return { requests, misses };
}

async function worker(library, scenario, kind, profilePath) {
  assert.ok(libraries.includes(library));
  assert.ok(scenarios.includes(scenario));
  assert.ok(kind === 'measure' || kind === 'profile');
  assert.ok(!(library === 'cacheable' && scenario === 'swr'));
  const operations = kind === 'profile' ? (scenario === 'l1' ? 5_000_000 : 200_000)
    : scenario === 'l2' || scenario === 'swr' ? KEYS : 10_000;
  const { requests, misses } = makeRequests(scenario, operations);
  const payloads = new Map(requests.map((request) => [request.key, request]));
  let loads = 0;
  let releaseLoader;
  let loaderBarrier;
  const loader = async (key) => {
    loads++;
    if (scenario === 'swr') await loaderBarrier;
    return scenario === 'swr' ? payloads.get(key).updated : payloads.get(key).value;
  };
  let cache, read, stores;
  if (library === 'flash-memo') {
    stores = [new MapStore(), new MapStore()];
    cache = new FlashCache(stores[0], stores[1], { ttl: TTL, staleRatio: scenario === 'swr' ? 0.5 : 1, namespace: false });
    const memo = new FlashMemo(cache);
    read = (key) => memo.memoize(key, () => loader(key), options);
  } else {
    stores = [0, 1].map(() => new Keyv({
      store: new Map(), serialize: undefined, deserialize: undefined,
      useKeyPrefix: false, throwOnErrors: true,
    }));
    for (const store of stores) {
      assert.equal(store.serialize, undefined);
      assert.equal(store.deserialize, undefined);
      store.on('error', (error) => { throw error; });
    }
    cache = library === 'cacheable'
      ? new Cacheable({ primary: stores[0], secondary: stores[1], ttl: TTL, nonBlocking: false, stats: false })
      : createCache({ stores, ttl: TTL, refreshThreshold: scenario === 'swr' ? TTL / 2 : 0, refreshAllStores: true, nonBlocking: false });
    cache.on('error', (error) => { throw error; });
    cache.on('refresh', (event) => { if (event.error) throw event.error; });
    read = library === 'cacheable' ? cache.wrap(loader, { createKey: (_fn, args) => args[0] })
      : (key) => cache.wrap(key, () => loader(key));
  }

  async function prepare() {
    loads = 0;
    loaderBarrier = new Promise((resolveBarrier) => { releaseLoader = resolveBarrier; });
    for (const store of stores) (library === 'flash-memo' ? store : store.store).clear();
    const preload = scenario === 'cold' ? [] : scenario === 'l2' || scenario === 'swr' ? requests
      : Array.from({ length: KEYS }, (_, i) => ({ key: `hot:${i}`, value: values[i] }));
    const time = Date.now() - (scenario === 'swr' ? TTL * 0.75 : 0);
    for (const request of preload) {
      for (let i = 0; i < stores.length; i++) {
        if (scenario === 'l2' && i === 0) continue;
        if (library === 'flash-memo') {
          stores[i].set(request.key, { value: request.value, time, staleAt: time + TTL * (scenario === 'swr' ? 0.5 : 1), expAt: time + TTL });
        } else {
          stores[i].store.set(request.key, { value: request.value, expires: time + TTL });
        }
      }
    }
  }

  async function runTrace() {
    for (const request of requests) {
      const result = read(request.key);
      const value = result instanceof Promise ? await result : result;
      if (value !== request.value) throw new Error(`${library}/${scenario}: wrong value or cloned object`);
    }
    if (scenario === 'swr') {
      releaseLoader();
      await setImmediate();
    }
  }

  async function verify() {
    assert.equal(loads, scenario === 'swr' ? operations : misses, 'Unexpected loader count');
    const expectedSize = scenario === 'cold' || scenario === 'l2' || scenario === 'swr' ? operations : KEYS + misses;
    for (const store of stores) assert.equal((library === 'flash-memo' ? store : store.store).size, expectedSize);
    for (const request of requests) {
      for (const store of stores) {
        const value = await store.get(request.key);
        assert.equal(library === 'flash-memo' ? value.value : value, scenario === 'swr' ? request.updated : request.value);
      }
    }
  }

  // Прогрев тем же размером трассы, но без V8 profiler и CPU-таймера.
  for (let i = 0; i < (kind === 'profile' ? 2 : 12); i++) {
    await prepare();
    await runTrace();
    await verify();
  }
  global.gc();
  let samples = 0, userUs = 0, systemUs = 0, wallNs = 0;
  let session;
  if (kind === 'profile') {
    session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 1000 });
  }
  do {
    await prepare();
    if (session) await session.post('Profiler.start');
    const beforeCpu = process.cpuUsage();
    const beforeWall = process.hrtime.bigint();
    await runTrace();
    const elapsedWall = Number(process.hrtime.bigint() - beforeWall);
    const cpu = process.cpuUsage(beforeCpu);
    userUs += cpu.user;
    systemUs += cpu.system;
    wallNs += elapsedWall;
    samples++;
    if (session) {
      const { profile } = await session.post('Profiler.stop');
      await writeFile(profilePath, JSON.stringify(profile));
      session.disconnect();
    }
    await verify();
  } while (kind === 'measure' && (userUs + systemUs < 400_000 || samples < 16));
  if (library !== 'flash-memo') await cache.disconnect();
  return {
    library, scenario, kind, operations: operations * samples, operationsPerSample: operations, samples,
    cpuNsPerOp: (userUs + systemUs) * 1000 / (operations * samples),
    userNsPerOp: userUs * 1000 / (operations * samples),
    systemNsPerOp: systemUs * 1000 / (operations * samples),
    wallNsPerOp: wallNs / (operations * samples), cpuUs: userUs + systemUs,
  };
}

function summarizeProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const frame = nodes.get(profile.samples[i]).callFrame;
    const name = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
    self.set(name, (self.get(name) || 0) + profile.timeDeltas[i]);
  }
  const sampledUs = [...self.values()].reduce((sum, value) => sum + value, 0);
  return {
    samples: profile.samples.length, sampledUs,
    topSelf: [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([frame, timeUs]) => ({ frame, selfPercent: timeUs * 100 / sampledUs })),
    gcPercent: [...self].filter(([frame]) => frame.startsWith('(garbage collector)')).reduce((sum, [, timeUs]) => sum + timeUs, 0) * 100 / sampledUs,
  };
}

if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(await worker(...process.argv.slice(3))));
} else {
  const output = resolve(process.env.BENCH_OUTPUT || join(here, 'cpu-memo-wrap.results.json'));
  const profileDirectory = join(root, 'tmp', 'cpu-memo-wrap', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(profileDirectory, { recursive: true });
  const packageVersions = {};
  for (const name of ['cacheable', 'cache-manager', 'keyv', '@cacheable/utils']) {
    packageVersions[name] = JSON.parse(await readFile(join(here, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  const sourceSha256 = {};
  for (const path of ['src/flash-cache.ts', 'src/flash-memo.ts', 'src/utils/singleflight.ts', 'bench/cpu-memo-wrap.bench.mjs']) {
    sourceSha256[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  }
  const metadata = {
    recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    os: release(), cpu: cpus()[0].model, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    packageVersions, sourceSha256, stores: ['Map', 'Map'], useClones: false, valueSerialization: false,
    ttl: TTL, payload: 'object with id and 256-character string', cpuTargetUsPerWorker: 400_000,
    repetitions: 3, samplingIntervalUs: 1000, profileDirectory,
    notes: [
      'CPU metrics exclude setup, warmup and store verification; include user+system CPU across process threads and GC during requests.',
      'Each worker has its own process. Workers run sequentially, library order rotates between repetitions.',
      'Primary CPU comparison is unprofiled. Profiles capture one larger trace after warmup; profile CPU is reported separately.',
      'Keyv + Map has no clone layer; serialize/deserialize are undefined. Returned objects and both stores checked by identity.',
      'L2/SWR use unique keys per trace. Cacheable custom createKey still includes standard argument hashing overhead.',
      'SWR blocks loaders until foreground trace completes, then waits one event-loop turn and verifies both updated stores.',
      'No Redis, I/O, eviction, concurrency or default-cloning scenario. Hot CPU includes common loop and identity checks.',
    ],
  };
  console.log(metadata);
  const runs = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    const order = [...libraries.slice(repetition), ...libraries.slice(0, repetition)];
    for (const scenario of scenarios) {
      for (const library of order) {
        if (scenario === 'swr' && library === 'cacheable') continue;
        const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', library, scenario, 'measure'], { cwd: here, encoding: 'utf8' }));
        runs.push({ repetition: repetition + 1, ...result });
        console.log(`run ${repetition + 1} ${scenario} ${library}: CPU ${result.cpuNsPerOp.toFixed(1)} ns/op`);
      }
    }
  }
  const profiles = [];
  for (const scenario of scenarios) {
    for (const library of libraries) {
      if (scenario === 'swr' && library === 'cacheable') continue;
      const path = join(profileDirectory, `${scenario}-${library}.cpuprofile`);
      const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', library, scenario, 'profile', path], { cwd: here, encoding: 'utf8' }));
      const profile = JSON.parse(await readFile(path, 'utf8'));
      profiles.push({ ...result, path, ...summarizeProfile(profile) });
      console.log(`profile ${scenario} ${library}: ${profile.samples.length} samples`);
    }
  }
  const summary = [];
  for (const scenario of scenarios) {
    const flash = runs.filter((run) => run.scenario === scenario && run.library === 'flash-memo').map((run) => run.cpuNsPerOp).sort((a, b) => a - b)[1];
    for (const library of libraries) {
      const matching = runs.filter((run) => run.scenario === scenario && run.library === library);
      if (!matching.length) continue;
      const sorted = matching.map((run) => run.cpuNsPerOp).sort((a, b) => a - b);
      const cpuNsPerOp = sorted[1];
      summary.push({ scenario, library, cpuNsPerOp, cpuMsPerMillion: cpuNsPerOp, rangeCpuNsPerOp: [sorted[0], sorted[2]], cpuRelativeToFlash: cpuNsPerOp / flash });
    }
  }
  await writeFile(output, `${JSON.stringify({ metadata, summary, runs, profiles }, null, 2)}\n`);
  console.table(summary.map(({ scenario, library, cpuNsPerOp, cpuRelativeToFlash }) => ({ scenario, library, cpuNsPerOp, cpuRelativeToFlash })));
  console.log(`Saved: ${output}`);
}
