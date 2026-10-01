// Headless harness: runs the real simulation code in Node with a stubbed DOM.
// Usage: node bench/headless.js [--ticks N] [--cols C] [--rows R] [--seed S] [--world path.json] [--org path.json]
// Prints timing plus a deterministic state hash (same seed => same hash) so
// optimizations can be checked for behavioral equivalence.

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : def;
};
const TICKS = parseInt(opt('ticks', '3000'));
const COLS = parseInt(opt('cols', '200'));
const ROWS = parseInt(opt('rows', '150'));
const SEED = parseInt(opt('seed', '1'));
const WORLD = opt('world', null);
const ORG = opt('org', null);
const RENDER = args.includes('--render');

// deterministic PRNG (mulberry32) replacing Math.random
let s = SEED >>> 0;
Math.random = function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const stubs = require('./stubs')({ cols: COLS, rows: ROWS });

const WorldEnvironment = require('../src/Environments/WorldEnvironment');
const Organism = require('../src/Organism/Organism');
const FossilRecord = require('../src/Stats/FossilRecord');
const WorldConfig = require('../src/WorldConfig');
const fs = require('fs');

WorldConfig.headless = !RENDER;
const env = new WorldEnvironment(5);
if (WORLD) {
    env.loadRaw(JSON.parse(fs.readFileSync(WORLD, 'utf8')));
} else if (ORG) {
    env.reset(false, false);
    const raw = JSON.parse(fs.readFileSync(ORG, 'utf8'));
    const center = env.grid_map.getCenter();
    const org = new Organism(center[0], center[1], env);
    org.loadRaw(raw);
    org.c = center[0]; org.r = center[1];
    org.living = true; org.lifetime = 0; org.damage = 0; org.food_collected = 0;
    env.addOrganism(org);
    FossilRecord.addSpecies(org, null);
} else {
    env.OriginOfLife();
}

let peak = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < TICKS; i++) {
    env.update();
    env.render();
    if (env.organisms.length > peak) peak = env.organisms.length;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

// FNV-1a hash of grid state + organism positions
let h = 0x811c9dc5;
const mix = (v) => { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
const names = ['empty', 'food', 'wall', 'mouth', 'producer', 'mover', 'killer', 'armor', 'eye'];
for (const col of env.grid_map.grid)
    for (const cell of col) mix(names.indexOf(cell.state.name));
for (const o of env.organisms) { mix(o.c); mix(o.r); mix(o.rotation); mix(o.anatomy.cells.length); }

console.log(JSON.stringify({
    ticks: TICKS, grid: `${env.grid_map.cols}x${env.grid_map.rows}`, seed: SEED,
    ms: Math.round(ms), ticks_per_sec: Math.round(TICKS / ms * 1000),
    organisms: env.organisms.length, peak, resets: env.reset_count,
    fillRects: stubs.counts.fillRects, styleChanges: stubs.counts.styleChanges, hash: h.toString(16),
}));
