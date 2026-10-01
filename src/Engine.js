const WorldEnvironment = require('./Environments/WorldEnvironment');
const ControlPanel = require('./Controllers/ControlPanel');
const OrganismEditor = require('./Environments/OrganismEditor');
const ColorScheme = require('./Rendering/ColorScheme');

// Target fps at or above this value means "as fast as possible". Browsers clamp
// setInterval to >= ~4ms, so a plain one-tick-per-interval loop could never
// exceed ~250 ticks/sec. In max mode each interval runs a time-budgeted batch.
const max_fps = 1000;
// Milliseconds of simulation work per interval in max mode. Leaves the rest of
// each frame for rendering and input so the page stays responsive.
const max_mode_budget = 10;
// How often the "Actual FPS" estimate is recomputed (ms).
const fps_sample_period = 500;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const raf = typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(now()), 1000/60);

class Engine {
    constructor(){
        this.fps = 60;
        this.env = new WorldEnvironment(5);
        this.organism_editor = new OrganismEditor();
        this.controlpanel = new ControlPanel(this);
        this.colorscheme = new ColorScheme(this.env, this.organism_editor);
        this.colorscheme.loadColorScheme();
        this.env.OriginOfLife();

        this.ui_last_update = now();
        this.ticks_since_sample = 0;
        this.last_sample_time = now();

        this.actual_fps = 0;
        this.running = false;
        this.startRenderLoop();
    }

    start(fps=60) {
        if (fps <= 0)
            fps = 1;
        this.fps = fps;
        clearInterval(this.sim_loop);
        if (fps >= max_fps) {
            this.sim_loop = setInterval(() => this.runBudgetedTicks(), 0);
        }
        else {
            this.sim_loop = setInterval(() => this.tick(), 1000/fps);
        }
        this.running = true;
    }

    stop() {
        clearInterval(this.sim_loop);
        this.sim_loop = null;
        this.running = false;
        this.actual_fps = 0;
    }

    restart(fps) {
        this.start(fps);
    }

    tick() {
        this.env.update();
        this.ticks_since_sample++;
    }

    runBudgetedTicks() {
        const deadline = now() + max_mode_budget;
        do {
            this.tick();
        } while (this.running && now() < deadline);
    }

    // Rendering is decoupled from the simulation: draw at most once per display
    // frame no matter how many ticks ran, instead of once per tick.
    startRenderLoop() {
        const frame = () => {
            this.renderFrame();
            raf(frame);
        };
        raf(frame);
    }

    renderFrame() {
        const t = now();
        const ui_delta_time = t - this.ui_last_update;
        this.ui_last_update = t;
        if (t - this.last_sample_time >= fps_sample_period) {
            this.actual_fps = this.running ? this.ticks_since_sample * 1000 / (t - this.last_sample_time) : 0;
            this.ticks_since_sample = 0;
            this.last_sample_time = t;
        }
        this.env.render();
        this.controlpanel.update(ui_delta_time);
        this.organism_editor.update();
    }
}

module.exports = Engine;
