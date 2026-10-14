const fs = require('node:fs');
const Module = require('node:module');
const { createHook } = require('node:async_hooks');
const { setImmediate: nextTurn } = require('node:timers/promises');
const root = require('node:path').resolve(__dirname, '..');
if (!process.argv[2]) throw new Error('Pass the pre-refactor flash-cache.ts snapshot');
const ts = require(root + '/node_modules/typescript');
const versions = {};
for (const [name, path] of Object.entries({ before: process.argv[2], after: root + '/src/flash-cache.ts' })) {
    const mod = new Module(path);
    mod._compile(
        ts.transpileModule(fs.readFileSync(path, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
        }).outputText,
        path,
    );
    versions[name] = mod.exports.FlashCache;
}
const scenarios = ['fresh', 'sync-miss', 'async-miss', 'async-store-miss', 'stale-async', 'singleflight'];
(async () => {
    const rows = [];
    for (const scenario of scenarios) {
        const row = { scenario };
        for (const [version, Cache] of Object.entries(versions)) {
            const primary = new Map(),
                raw = new Map();
            const secondary =
                scenario === 'async-store-miss'
                    ? {
                          get: async (k) => raw.get(k),
                          set: async (k, v) => {
                              raw.set(k, v);
                          },
                          delete: async (k) => {
                              raw.delete(k);
                          },
                      }
                    : raw;
            const cache = new Cache(primary, secondary, { ttl: 60000, staleRatio: 0.8, namespace: false });
            if (scenario === 'fresh' || scenario === 'stale-async')
                primary.set('x', {
                    value: 42,
                    time: Date.now(),
                    staleAt: scenario === 'fresh' ? Date.now() + 30000 : 0,
                    expAt: Date.now() + 60000,
                });
            let count = 0;
            const hook = createHook({
                init(id, type) {
                    if (type === 'PROMISE') count++;
                },
            });
            hook.enable();
            if (scenario === 'singleflight') {
                const pending = [];
                for (let i = 0; i < 32; i++) pending.push(cache.getOrSet('x', async () => 42));
                await Promise.all(pending);
            } else {
                const value = cache.getOrSet('x', scenario === 'sync-miss' ? () => 42 : async () => 42);
                if (value instanceof Promise) await value;
            }
            await nextTurn();
            hook.disable();
            row[version] = count;
        }
        row.delta = row.after - row.before;
        rows.push(row);
    }
    if (process.env.BENCH_OUTPUT) fs.writeFileSync(process.env.BENCH_OUTPUT, JSON.stringify(rows, null, 2) + '\n');
    console.table(rows);
})();
