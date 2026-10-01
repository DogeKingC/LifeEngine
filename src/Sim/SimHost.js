// Owns the SimWorld and its run loop. Runs inside a Web Worker (sim.worker.js),
// or on the main thread as a fallback when workers are unavailable (e.g. the
// page was opened from file://). All communication is by plain messages.

const SimWorld = require('./SimWorld');
const Hyperparams = require('../Hyperparameters');
const WorldConfig = require('../WorldConfig');
const FossilRecord = require('../Stats/FossilRecord');

const MAX_FPS = 1000; // target fps at or above this means "as fast as possible"

// Yield to the event loop without the 4ms clamp of nested setTimeout(0).
function makeYield() {
    if (typeof MessageChannel !== 'undefined') {
        const channel = new MessageChannel();
        let callback = null;
        channel.port1.onmessage = () => { const cb = callback; callback = null; cb(); };
        return (cb) => { callback = cb; channel.port2.postMessage(0); };
    }
    return (cb) => setTimeout(cb, 0);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function createHost(post, options={}) {
    // ms of simulation per slice before checking messages again
    const budget = options.budget || 12;
    const yieldNow = makeYield();
    let world = null;
    let running = false;
    let fps = 60;
    let loop_id = 0; // invalidates stale loops after start/stop
    let tick_debt = 0;
    let last_time = 0;
    let ticks_in_window = 0;
    let window_start = now();
    let tps = 0;

    function tick() {
        world.update();
        ticks_in_window++;
    }

    function runLoop(id) {
        if (!running || id !== loop_id)
            return;
        const start = now();
        if (fps >= MAX_FPS) {
            const deadline = start + budget;
            do {
                tick();
            } while (running && now() < deadline);
            yieldNow(() => runLoop(id));
        }
        else {
            tick_debt += (start - last_time) * fps / 1000;
            last_time = start;
            // never try to catch up more than ~100ms of backlog
            if (tick_debt > fps / 10 + 1) tick_debt = fps / 10 + 1;
            const deadline = start + budget;
            while (tick_debt >= 1 && running && now() < deadline) {
                tick();
                tick_debt -= 1;
            }
            const wait = Math.max(1, (1 - tick_debt) * 1000 / fps);
            setTimeout(() => runLoop(id), wait);
        }
    }

    function start(new_fps) {
        fps = Math.max(1, new_fps);
        running = true;
        loop_id++;
        tick_debt = 1; // run a tick right away
        last_time = now();
        runLoop(loop_id);
    }

    function stop() {
        running = false;
        loop_id++;
    }

    function measureTps() {
        const t = now();
        if (t - window_start >= 500) {
            tps = running ? ticks_in_window * 1000 / (t - window_start) : 0;
            ticks_in_window = 0;
            window_start = t;
        }
        return tps;
    }

    function record() {
        return {
            tick_record: FossilRecord.tick_record,
            pop_counts: FossilRecord.pop_counts,
            species_counts: FossilRecord.species_counts,
            av_mut_rates: FossilRecord.av_mut_rates,
            av_cells: FossilRecord.av_cells,
            av_cell_counts: FossilRecord.av_cell_counts,
        };
    }

    function sizeInfo() {
        return {cols: world.cols, rows: world.rows, cell_size: world.cell_size};
    }

    const handlers = {
        init(msg) {
            Object.assign(Hyperparams, msg.hyper);
            Object.assign(WorldConfig, msg.config);
            world = new SimWorld(msg.cols, msg.rows, msg.cell_size);
            world.onExtinct = () => {
                stop();
                post({type: 'extinct'});
            };
            world.OriginOfLife();
        },
        hyper(msg) { Object.assign(Hyperparams, msg.values); },
        config(msg) { Object.assign(WorldConfig, msg.values); },
        start(msg) { start(msg.fps); },
        stop() { stop(); },
        frame(msg) {
            const reply = {type: 'frame', grid: null, highlight: null, record: null, ...sizeInfo()};
            const transfer = [];
            if (msg.grid) {
                reply.grid = world.snapshot();
                transfer.push(reply.grid.buffer);
            }
            if (msg.mouse)
                reply.highlight = world.highlightCells(msg.mouse[0], msg.mouse[1]);
            if (msg.record)
                reply.record = record();
            reply.stats = world.stats();
            reply.stats.tps = measureTps();
            post(reply, transfer);
        },
        reset(msg) { world.reset(msg.life); },
        resize(msg) { world.resize(msg.cols, msg.rows, msg.cell_size); },
        brush(msg) { world.dropCellType(msg.c, msg.r, msg.size, msg.state, msg.kill, msg.ignore); },
        kill(msg) { world.killNear(msg.c, msg.r, msg.size); },
        walls(msg) {
            world.clearWalls();
            world.placeWalls(msg.cells);
        },
        clearWalls() { world.clearWalls(); },
        drop(msg) {
            for (const d of msg.orgs)
                world.dropOrganism(d.raw, d.c, d.r);
        },
        rename(msg) {
            const species = FossilRecord.extant_species[msg.old];
            if (species)
                FossilRecord.changeSpeciesName(species, msg.name);
        },
        select(msg) {
            const org = world.findNearOrganism(msg.c, msg.r, msg.size);
            return {org: org ? world.serializeOrg(org) : null};
        },
        save() {
            return {json: JSON.stringify(world.serialize())};
        },
        load(msg) {
            const env = typeof msg.world === 'string' ? JSON.parse(msg.world) : msg.world;
            world.loadRaw(env);
            return sizeInfo();
        },
    };

    return function handle(msg) {
        const handler = handlers[msg.type];
        if (!handler) {
            console.warn('Unknown simulation message', msg.type);
            return;
        }
        let result;
        try {
            result = handler(msg);
        } catch (e) {
            console.error(e);
            if (msg.req !== undefined)
                post({type: 'reply', req: msg.req, error: String(e && e.message || e)});
            return;
        }
        if (msg.req !== undefined)
            post({type: 'reply', req: msg.req, ...(result || {})});
    };
}

module.exports = createHost;
