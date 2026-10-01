// Data-oriented simulation core. Runs in a Web Worker (see SimHost.js) with no
// DOM access. The grid is stored as typed arrays and organisms share immutable
// genomes. The rules, and the order in which Math.random is called, mirror the
// original object-based implementation exactly: for the same random sequence
// both produce identical worlds (checked by `npm test`).

const CellStates = require("../Organism/Cell/CellStates");
const Hyperparams = require("../Hyperparameters");
const Neighbors = require("../Grid/Neighbors");
const Directions = require("../Organism/Directions");
const WorldConfig = require("../WorldConfig");
const FossilRecord = require("../Stats/FossilRecord");
const Species = require("../Stats/Species");
const SerializeHelper = require("../Utils/SerializeHelper");
const Genome = require("./Genome");

const NUM_STATES = CellStates.all.length;
const EMPTY = CellStates.empty.id;
const FOOD = CellStates.food.id;
const WALL = CellStates.wall.id;
const MOUTH = CellStates.mouth.id;
const PRODUCER = CellStates.producer.id;
const KILLER = CellStates.killer.id;
const ARMOR = CellStates.armor.id;
const EYE = CellStates.eye.id;
const HEALER = CellStates.healer.id;

const NEUTRAL = 0, RETREAT = 1, CHASE = 2;
const DEFAULT_BRAIN = new Uint8Array(NUM_STATES);
DEFAULT_BRAIN[FOOD] = CHASE;
DEFAULT_BRAIN[KILLER] = RETREAT;
// decisions re-rolled when an organism first evolves an eye
const RANDOMIZED_DECISIONS = ['mouth', 'producer', 'mover', 'armor', 'eye', 'healer'].map(n => CellStates[n].id);

const randomDirection = () => Math.floor(Math.random() * 4);
const randomDecision = () => Math.floor(Math.random() * 3);
const chance = (prob) => (Math.random() * 100) < prob;

class Org {
    constructor(genome) {
        this.slot = -1; // index into SimWorld.slots while alive in the world
        this.c = 0;
        this.r = 0;
        this.lifetime = 0;
        this.food_collected = 0;
        this.living = true;
        this.direction = Directions.down;
        this.rotation = Directions.up;
        this.can_rotate = Hyperparams.rotationEnabled;
        this.move_count = 0;
        this.move_range = 4;
        this.ignore_brain_for = 0;
        this.mutability = 5;
        this.damage = 0;
        this.genome = genome;
        this.birth_distance = genome.base_birth_distance;
        this.brain = DEFAULT_BRAIN; // shared until written (copy on write)
        this.brain_owned = false;
        this.seen_idx = -1; // grid index of the closest cell seen this tick
        this.seen_distance = Infinity;
        this.seen_direction = 0;
        this.species = null;
    }

    ownBrain() {
        if (!this.brain_owned) {
            this.brain = this.brain.slice();
            this.brain_owned = true;
        }
        return this.brain;
    }

    // FossilRecord/Species expect organism.anatomy
    get anatomy() {
        return this.genome;
    }

    foodNeeded() {
        return this.genome.is_mover ? this.genome.n + Hyperparams.extraMoverFoodCost : this.genome.n;
    }
}

class SimWorld {
    constructor(cols, rows, cell_size=5) {
        this.organisms = [];
        this.slots = [];
        this.free_slots = [];
        this.walls = [];
        this.total_mutability = 0;
        this.largest_cell_count = 0;
        this.reset_count = 0;
        this.total_ticks = 0;
        this.data_update_rate = 100;
        this.onExtinct = null; // called when auto pause should trigger
        this.resize(cols, rows, cell_size);
        FossilRecord.setEnv(this);
    }

    resize(cols, rows, cell_size=this.cell_size) {
        cols = parseInt(cols);
        rows = parseInt(rows);
        this.cols = cols;
        this.rows = rows;
        this.num_cols = cols;
        this.num_rows = rows;
        this.cell_size = cell_size;
        const n = cols * rows;
        this.state = new Uint8Array(n);   // cell state id
        this.owner = new Int32Array(n);   // organism slot + 1, 0 = none
        this.cidx = new Int16Array(n);    // index of the owner's genome cell
        this.walls = [];
    }

    // ---------------- grid helpers ----------------

    indexOf(c, r) {
        if ((c >>> 0) >= this.cols || (r >>> 0) >= this.rows)
            return -1;
        return c * this.rows + r;
    }

    ownerAt(idx) {
        const o = this.owner[idx];
        return o === 0 ? null : this.slots[o - 1];
    }

    changeCell(c, r, state, org=null, cell_index=0) {
        const idx = this.indexOf(c, r);
        if (idx === -1)
            return;
        this.state[idx] = state;
        this.owner[idx] = org === null ? 0 : org.slot + 1;
        this.cidx[idx] = cell_index;
        if (state === WALL)
            this.walls.push(idx);
    }

    getCenter() {
        return [Math.floor(this.cols/2), Math.floor(this.rows/2)];
    }

    // ---------------- organism bookkeeping ----------------

    allocSlot(org) {
        org.slot = this.free_slots.length ? this.free_slots.pop() : this.slots.length;
        this.slots[org.slot] = org;
    }

    freeSlot(org) {
        if (org.slot >= 0 && this.slots[org.slot] === org) {
            this.slots[org.slot] = null;
            this.free_slots.push(org.slot);
        }
        org.slot = -1;
    }

    clearSlots() {
        this.slots = [];
        this.free_slots = [];
    }

    addOrganism(org) {
        if (org.slot < 0)
            this.allocSlot(org);
        this.updateGrid(org);
        this.total_mutability += org.mutability;
        this.organisms.push(org);
        if (org.genome.n > this.largest_cell_count)
            this.largest_cell_count = org.genome.n;
    }

    canAddOrganism() {
        return this.organisms.length < Hyperparams.maxOrganisms || Hyperparams.maxOrganisms < 0;
    }

    averageMutability() {
        if (this.organisms.length < 1)
            return 0;
        if (Hyperparams.useGlobalMutability)
            return Hyperparams.globalMutability;
        return this.total_mutability / this.organisms.length;
    }

    // ---------------- tick ----------------

    update() {
        const orgs = this.organisms;
        const count = orgs.length;
        let write = 0;
        for (let i = 0; i < count; i++) {
            const org = orgs[i];
            if (org.living && this.updateOrg(org)) {
                orgs[write++] = org;
            }
            else {
                this.total_mutability -= org.mutability;
                this.freeSlot(org);
            }
        }
        const removed = count - write;
        if (removed > 0) {
            for (let i = count; i < orgs.length; i++)
                orgs[write++] = orgs[i];
            orgs.length = write;
            if (write === 0)
                this.onPopulationExtinct();
        }
        if (Hyperparams.foodDropProb > 0)
            this.generateFood();
        this.total_ticks++;
        if (this.total_ticks % this.data_update_rate == 0)
            FossilRecord.updateData();
    }

    onPopulationExtinct() {
        if (WorldConfig.auto_pause) {
            if (this.onExtinct) this.onExtinct();
        }
        else if (WorldConfig.auto_reset) {
            this.reset_count++;
            this.reset(true);
        }
    }

    updateOrg(org) {
        const g = org.genome;
        org.lifetime++;
        if (org.lifetime > g.n * Hyperparams.lifespanMultiplier) {
            this.die(org);
            return org.living;
        }
        if (org.food_collected >= org.foodNeeded())
            this.reproduce(org);

        org.seen_idx = -1;
        org.seen_distance = Infinity;
        org.seen_direction = 0;

        const active = g.active;
        if (active.length > 0) {
            const off = g.getOffsets(org.rotation);
            const types = g.types;
            for (let k = 0; k < active.length; k++) {
                const i = active[k];
                const c = org.c + off[2*i], r = org.r + off[2*i+1];
                switch (types[i]) {
                    case MOUTH: this.mouth(org, c, r); break;
                    case PRODUCER: this.producer(org, c, r); break;
                    case KILLER: this.killer(org, c, r); break;
                    case EYE: this.eye(org, c, r, i); break;
                    case HEALER: this.healer(org); break;
                }
                if (!org.living)
                    return false;
            }
        }

        if (g.is_mover) {
            org.move_count++;
            let changed_dir = false;
            if (org.ignore_brain_for == 0)
                changed_dir = this.decide(org);
            else
                org.ignore_brain_for--;
            const moved = this.attemptMove(org);
            if ((org.move_count > org.move_range && !changed_dir) || !moved) {
                const rotated = this.attemptRotate(org);
                if (!rotated) {
                    org.direction = randomDirection();
                    org.move_count = 0;
                    if (changed_dir)
                        org.ignore_brain_for = org.move_range + 1;
                }
            }
        }
        return org.living;
    }

    // ---------------- cell functions ----------------

    mouth(org, c, r) {
        const nb = Hyperparams.edibleNeighbors;
        for (let i = 0; i < nb.length; i++) {
            const idx = this.indexOf(c + nb[i][0], r + nb[i][1]);
            if (idx !== -1 && this.state[idx] === FOOD) {
                this.state[idx] = EMPTY;
                this.owner[idx] = 0;
                org.food_collected++;
            }
        }
    }

    producer(org, c, r) {
        if (org.genome.is_mover && !Hyperparams.moversCanProduce)
            return;
        if (Math.random() * 100 > Hyperparams.foodProdProb)
            return;
        const nb = Hyperparams.growableNeighbors;
        const loc = nb[Math.floor(Math.random() * nb.length)];
        const idx = this.indexOf(c + loc[0], r + loc[1]);
        if (idx !== -1 && this.state[idx] === EMPTY)
            this.state[idx] = FOOD; // owner is already 0 for empty cells
    }

    killer(org, c, r) {
        const nb = Hyperparams.killableNeighbors;
        for (let i = 0; i < nb.length; i++) {
            if (!org.living)
                return;
            const idx = this.indexOf(c + nb[i][0], r + nb[i][1]);
            if (idx === -1)
                continue;
            const target = this.ownerAt(idx);
            if (target === null || target === org || !target.living || this.state[idx] === ARMOR)
                continue;
            const is_hit = this.state[idx] === KILLER;
            this.harm(target);
            if (Hyperparams.instaKill && is_hit)
                this.harm(org);
        }
    }

    eye(org, c, r, i) {
        let direction = org.rotation + org.genome.dirs[i];
        if (direction > 3) direction -= 4;
        const scalar = Directions.scalars[direction];
        const range = Hyperparams.lookRange;
        const see_through_self = Hyperparams.seeThroughSelf;
        for (let d = 1; d <= range; d++) {
            c += scalar[0];
            r += scalar[1];
            const idx = this.indexOf(c, r);
            if (idx === -1)
                return;
            if (this.state[idx] === EMPTY)
                continue;
            const target = this.ownerAt(idx);
            if (target === org && see_through_self)
                continue;
            if (target !== null && target !== org && target.genome.has_camo)
                continue;
            if (target !== org && d < org.seen_distance) {
                org.seen_idx = idx;
                org.seen_distance = d;
                org.seen_direction = direction;
            }
            return;
        }
    }

    healer(org) {
        if (org.damage > 0 && Math.random() * 100 < Hyperparams.healProb)
            org.damage--;
    }

    harm(org) {
        org.damage++;
        if (org.damage >= org.genome.n || Hyperparams.instaKill)
            this.die(org);
    }

    die(org) {
        if (!org.living)
            return;
        this.fillBody(org, FOOD);
        org.species.decreasePop();
        org.living = false;
    }

    // ---------------- movement ----------------

    decide(org) {
        let decision = NEUTRAL;
        if (org.seen_idx !== -1)
            decision = org.brain[this.state[org.seen_idx]];
        const dir = org.seen_direction;
        org.seen_idx = -1;
        org.seen_distance = Infinity;
        org.seen_direction = 0;
        if (decision === CHASE) {
            org.direction = dir;
            org.move_count = 0;
            return true;
        }
        else if (decision === RETREAT) {
            org.direction = Directions.getOppositeDirection(dir);
            org.move_count = 0;
            return true;
        }
        return false;
    }

    isClear(org, col, row, rotation) {
        const off = org.genome.getOffsets(rotation);
        const food_passable = !Hyperparams.foodBlocksReproduction;
        const own = org.slot + 1;
        for (let i = 0; i < off.length; i += 2) {
            const idx = this.indexOf(col + off[i], row + off[i+1]);
            if (idx === -1)
                return false;
            const s = this.state[idx];
            if (s === EMPTY || (food_passable && s === FOOD) || (own !== 0 && this.owner[idx] === own))
                continue;
            return false;
        }
        return true;
    }

    fillBody(org, state) {
        const off = org.genome.getOffsets(org.rotation);
        for (let i = 0; i < off.length; i += 2)
            this.changeCell(org.c + off[i], org.r + off[i+1], state, null);
    }

    updateGrid(org) {
        const g = org.genome;
        const off = g.getOffsets(org.rotation);
        for (let i = 0; i < g.n; i++)
            this.changeCell(org.c + off[2*i], org.r + off[2*i+1], g.types[i], org, i);
    }

    attemptMove(org) {
        const scalar = Directions.scalars[org.direction];
        const new_c = org.c + scalar[0];
        const new_r = org.r + scalar[1];
        if (this.isClear(org, new_c, new_r, org.rotation)) {
            this.fillBody(org, EMPTY);
            org.c = new_c;
            org.r = new_r;
            this.updateGrid(org);
            return true;
        }
        return false;
    }

    attemptRotate(org) {
        if (!org.can_rotate) {
            org.direction = randomDirection();
            org.move_count = 0;
            return true;
        }
        const new_rotation = randomDirection();
        if (this.isClear(org, org.c, org.r, new_rotation)) {
            this.fillBody(org, EMPTY);
            org.rotation = new_rotation;
            org.direction = randomDirection();
            this.updateGrid(org);
            org.move_count = 0;
            return true;
        }
        return false;
    }

    // ---------------- reproduction ----------------

    makeChild(parent) {
        const child = new Org(parent.genome);
        child.move_range = parent.move_range;
        child.mutability = parent.mutability;
        child.species = parent.species;
        if (parent.genome.is_mover && parent.genome.has_eyes) {
            child.brain = parent.brain; // shared until the child writes to it
            child.brain_owned = false;
        }
        return child;
    }

    reproduce(parent) {
        const child = this.makeChild(parent);
        if (Hyperparams.rotationEnabled)
            child.rotation = randomDirection();
        let prob = parent.mutability;
        if (Hyperparams.useGlobalMutability) {
            prob = Hyperparams.globalMutability;
        }
        else {
            if (Math.random() <= 0.5)
                child.mutability++;
            else {
                child.mutability--;
                if (child.mutability < 1)
                    child.mutability = 1;
            }
        }
        let mutated = false;
        if (Math.random() * 100 <= prob) {
            if (child.genome.is_mover && Math.random() * 100 <= 10) {
                if (child.genome.has_eyes) {
                    const brain = child.ownBrain();
                    brain[Math.floor(Math.random() * NUM_STATES)] = randomDecision();
                    brain[EMPTY] = NEUTRAL;
                }
                child.move_range += Math.floor(Math.random() * 4) - 2;
                if (child.move_range <= 0)
                    child.move_range = 1;
            }
            else {
                mutated = this.mutate(child);
            }
        }

        const scalar = Directions.getRandomScalar();
        const offset = Math.floor(Math.random() * 3);
        const base = parent.birth_distance;
        const new_c = parent.c + scalar[0]*base + scalar[0]*offset;
        const new_r = parent.r + scalar[1]*base + scalar[1]*offset;

        if (this.isClear(child, new_c, new_r, child.rotation) &&
            this.isStraightPath(new_c, new_r, parent.c, parent.r, parent) &&
            this.canAddOrganism())
        {
            child.c = new_c;
            child.r = new_r;
            this.addOrganism(child);
            if (mutated)
                FossilRecord.addSpecies(child, parent.species);
            else
                child.species.addPop();
        }
        parent.food_collected -= parent.foodNeeded();
    }

    // Mutates the child's genome. Mirrors Organism.mutate / Anatomy exactly,
    // including RNG order and the order cells end up in.
    mutate(child) {
        let added = false, changed = false, removed = false;
        const cells = child.genome.toCellList();
        let birth_distance = child.birth_distance;
        const hasType = (t) => { for (const c of cells) if (c.type === t) return true; return false; };
        const randomCell = () => cells[Math.floor(Math.random() * cells.length)];
        const addRandomized = (type, col, row) => {
            if (type === EYE && !hasType(EYE)) {
                const brain = child.ownBrain();
                for (const id of RANDOMIZED_DECISIONS)
                    brain[id] = randomDecision();
            }
            birth_distance = Math.max(birth_distance, Genome.cellDistance(col, row));
            const cell = {type, col, row, dir: 0};
            cells.push(cell);
            if (type === EYE)
                cell.dir = randomDirection();
        };
        const removeAt = (col, row, allow_center) => {
            if (col == 0 && row == 0 && !allow_center)
                return false;
            for (let i = 0; i < cells.length; i++) {
                if (cells[i].col == col && cells[i].row == row) {
                    cells.splice(i, 1);
                    break;
                }
            }
            return true;
        };

        if (chance(Hyperparams.addProb)) {
            const branch = randomCell();
            const type = CellStates.getRandomLivingType().id;
            const growth = Neighbors.all[Math.floor(Math.random() * Neighbors.all.length)];
            const c = branch.col + growth[0];
            const r = branch.row + growth[1];
            let free = true;
            for (const cell of cells) if (cell.col == c && cell.row == r) { free = false; break; }
            if (free) {
                added = true;
                addRandomized(type, c, r);
            }
        }
        if (chance(Hyperparams.changeProb)) {
            const cell = randomCell();
            const type = CellStates.getRandomLivingType().id;
            const col = cell.col, row = cell.row;
            removeAt(col, row, true);
            addRandomized(type, col, row);
            changed = true;
        }
        if (chance(Hyperparams.removeProb)) {
            if (cells.length > 1) {
                const cell = randomCell();
                removed = removeAt(cell.col, cell.row, false);
            }
        }
        child.genome = new Genome(cells);
        child.birth_distance = birth_distance;
        return added || changed || removed;
    }

    isStraightPath(c1, r1, c2, r2, parent) {
        const parent_slot = parent.slot + 1;
        if (c1 == c2) {
            if (r1 > r2) { const t = r2; r2 = r1; r1 = t; }
            for (let i = r1; i != r2; i++)
                if (!this.isPassable(this.indexOf(c1, i), parent_slot)) return false;
            return true;
        }
        if (c1 > c2) { const t = c2; c2 = c1; c1 = t; }
        for (let i = c1; i != c2; i++)
            if (!this.isPassable(this.indexOf(i, r1), parent_slot)) return false;
        return true;
    }

    isPassable(idx, parent_slot) {
        if (idx === -1) return false;
        const s = this.state[idx];
        return s === EMPTY || this.owner[idx] === parent_slot || s === FOOD;
    }

    // ---------------- world-level actions ----------------

    generateFood() {
        const num_food = Math.max(Math.floor(this.cols*this.rows*Hyperparams.foodDropProb/50000), 1);
        const prob = Hyperparams.foodDropProb;
        for (let i = 0; i < num_food; i++) {
            if (Math.random() <= prob) {
                const c = Math.floor(Math.random() * this.cols);
                const r = Math.floor(Math.random() * this.rows);
                if (this.state[this.indexOf(c, r)] === EMPTY)
                    this.changeCell(c, r, FOOD, null);
            }
        }
    }

    OriginOfLife() {
        const center = this.getCenter();
        const org = new Org(new Genome([
            {type: MOUTH, col: 0, row: 0},
            {type: PRODUCER, col: 1, row: 1},
            {type: PRODUCER, col: -1, row: -1},
        ]));
        org.c = center[0];
        org.r = center[1];
        this.addOrganism(org);
        FossilRecord.addSpecies(org, null);
    }

    fillGrid(state, ignore_walls=false) {
        for (let i = 0; i < this.state.length; i++) {
            if (ignore_walls && this.state[i] === WALL) continue;
            this.state[i] = state;
            this.owner[i] = 0;
            this.cidx[i] = 0;
        }
    }

    reset(reset_life=true) {
        this.organisms = [];
        this.clearSlots();
        this.fillGrid(EMPTY, !WorldConfig.clear_walls_on_reset);
        this.total_mutability = 0;
        this.total_ticks = 0;
        FossilRecord.clear_record();
        if (reset_life)
            this.OriginOfLife();
    }

    clearWalls() {
        for (const idx of this.walls) {
            if (this.state[idx] === WALL) {
                this.state[idx] = EMPTY;
                this.owner[idx] = 0;
            }
        }
        this.walls = [];
    }

    // place walls at [c0, r0, c1, r1, ...], killing organisms in the way
    placeWalls(cells) {
        for (let i = 0; i < cells.length; i += 2) {
            const idx = this.indexOf(cells[i], cells[i+1]);
            if (idx === -1) continue;
            const org = this.ownerAt(idx);
            if (org !== null) this.die(org);
            this.changeCell(cells[i], cells[i+1], WALL, null);
        }
    }

    // brush painting, mirrors EnvironmentController.dropCellType
    dropCellType(col, row, size, state, kill_blocking=false, ignore_state=-1) {
        for (const loc of Neighbors.inRange(size)) {
            const c = col + loc[0], r = row + loc[1];
            const idx = this.indexOf(c, r);
            if (idx === -1) continue;
            const org = this.ownerAt(idx);
            if (kill_blocking && org !== null)
                this.die(org);
            else if (org !== null)
                continue;
            if (ignore_state !== -1 && this.state[idx] === ignore_state)
                continue;
            this.changeCell(c, r, state, null);
        }
    }

    killNear(col, row, size) {
        for (const loc of Neighbors.inRange(size)) {
            const idx = this.indexOf(col + loc[0], row + loc[1]);
            if (idx === -1) continue;
            const org = this.ownerAt(idx);
            if (org !== null) this.die(org);
        }
    }

    findNearOrganism(col, row, size) {
        let closest = null, closest_dist = 100;
        for (const loc of Neighbors.inRange(size)) {
            const idx = this.indexOf(col + loc[0], row + loc[1]);
            const dist = Math.abs(loc[0]) + Math.abs(loc[1]);
            if (idx === -1) continue;
            const org = this.ownerAt(idx);
            if (org !== null && (closest === null || dist < closest_dist)) {
                closest = org;
                closest_dist = dist;
            }
        }
        return closest;
    }

    // absolute [c0, r0, c1, r1, ...] of the organism at (col,row), or just that cell
    highlightCells(col, row) {
        const idx = this.indexOf(col, row);
        if (idx === -1) return null;
        const org = this.ownerAt(idx);
        if (org === null) return new Int32Array([col, row]);
        const off = org.genome.getOffsets(org.rotation);
        const out = new Int32Array(off.length);
        for (let i = 0; i < off.length; i += 2) {
            out[i] = org.c + off[i];
            out[i+1] = org.r + off[i+1];
        }
        return out;
    }

    // Drop a copy of a serialized organism (editor / clone / random). Mirrors
    // EnvironmentController.dropOrganism: a fresh organism inheriting the body,
    // brain, move range and mutability.
    dropOrganism(raw, col, row) {
        const org = new Org(Genome.fromRawCells(raw.anatomy.cells));
        if (org.genome.n === 0) return false;
        org.move_range = raw.move_range;
        org.mutability = raw.mutability;
        if (org.genome.is_mover && org.genome.has_eyes && raw.brain)
            this.loadBrain(org, raw.brain);
        if (!this.isClear(org, col, row, org.rotation))
            return false;
        const name = raw.species_name;
        let species = name !== undefined ? FossilRecord.extant_species[name] : undefined;
        if (!species) {
            species = new Species(org.genome, null, this.total_ticks);
            if (name !== undefined && name !== null) species.name = name;
            species.population = 0;
            species.cumulative_pop = 0;
            FossilRecord.addSpeciesObj(species);
        }
        org.species = species;
        org.c = col;
        org.r = row;
        this.addOrganism(org);
        species.addPop();
        return true;
    }

    loadBrain(org, raw_brain) {
        const brain = org.ownBrain();
        for (const name in raw_brain.decisions) {
            const state = CellStates[name];
            if (state && state.id !== undefined)
                brain[state.id] = raw_brain.decisions[name];
        }
    }

    // ---------------- serialization (same JSON as the original format) ----------------

    serializeOrg(org) {
        const g = org.genome;
        const cells = [];
        for (let i = 0; i < g.n; i++) {
            const cell = {loc_col: g.cols[i], loc_row: g.rows[i]};
            if (g.types[i] === EYE) cell.direction = g.dirs[i];
            cell.state = {name: CellStates.all[g.types[i]].name};
            cells.push(cell);
        }
        const out = {
            c: org.c, r: org.r, lifetime: org.lifetime, food_collected: org.food_collected,
            living: org.living, direction: org.direction, rotation: org.rotation,
            can_rotate: org.can_rotate, move_count: org.move_count, move_range: org.move_range,
            ignore_brain_for: org.ignore_brain_for, mutability: org.mutability, damage: org.damage,
            anatomy: {
                birth_distance: org.birth_distance, is_producer: g.is_producer, is_mover: g.is_mover,
                has_eyes: g.has_eyes, has_camo: g.has_camo, cells,
            },
        };
        if (g.is_mover && g.has_eyes) {
            const decisions = {};
            for (const s of CellStates.all)
                decisions[s.name] = org.brain[s.id];
            out.brain = {decisions};
        }
        out.species_name = org.species ? org.species.name : undefined;
        return out;
    }

    serialize() {
        // drop organisms that died this tick, like the original clearDeadOrganisms
        const before = this.organisms.length;
        this.organisms = this.organisms.filter(o => {
            if (!o.living) { this.total_mutability -= o.mutability; this.freeSlot(o); }
            return o.living;
        });
        if (this.organisms.length === 0 && before > 0)
            this.onPopulationExtinct();
        const env = {
            num_rows: this.num_rows, num_cols: this.num_cols, total_mutability: this.total_mutability,
            largest_cell_count: this.largest_cell_count, reset_count: this.reset_count,
            total_ticks: this.total_ticks, data_update_rate: this.data_update_rate,
        };
        const grid = {cell_size: this.cell_size, cols: this.cols, rows: this.rows, food: [], walls: []};
        for (let c = 0; c < this.cols; c++) {
            for (let r = 0; r < this.rows; r++) {
                const s = this.state[c*this.rows + r];
                if (s === FOOD) grid.food.push({c, r});
                else if (s === WALL) grid.walls.push({c, r});
            }
        }
        env.grid = grid;
        env.organisms = this.organisms.map(o => this.serializeOrg(o));
        env.fossil_record = FossilRecord.serialize();
        env.controls = Hyperparams;
        return env;
    }

    // Load a world in the original save format. Mirrors WorldEnvironment.loadRaw.
    loadRaw(env) {
        this.organisms = [];
        this.clearSlots();
        FossilRecord.clear_record();
        const cell_size = env.grid.cell_size ? env.grid.cell_size : this.cell_size;
        this.resize(env.grid.cols, env.grid.rows, cell_size);
        for (const f of env.grid.food) {
            const idx = this.indexOf(f.c, f.r);
            if (idx !== -1) this.state[idx] = FOOD;
        }
        for (const w of env.grid.walls) {
            const idx = this.indexOf(w.c, w.r);
            if (idx !== -1) this.state[idx] = WALL;
        }
        for (const w of env.grid.walls) {
            const idx = this.indexOf(w.c, w.r);
            if (idx !== -1) this.walls.push(idx);
        }

        const species = {};
        for (const name in env.fossil_record.species) {
            const s = new Species(null, null, 0);
            SerializeHelper.overwriteNonObjects(env.fossil_record.species[name], s);
            species[name] = s;
        }

        for (const raw of env.organisms) {
            const org = new Org(Genome.fromRawCells(raw.anatomy.cells));
            for (const key of ['c', 'r', 'lifetime', 'food_collected', 'living', 'direction', 'rotation',
                               'can_rotate', 'move_count', 'move_range', 'ignore_brain_for', 'mutability', 'damage']) {
                if (raw[key] !== undefined && typeof raw[key] !== 'object')
                    org[key] = raw[key];
            }
            if (raw.brain)
                this.loadBrain(org, raw.brain);
            this.addOrganism(org);
            let s = species[raw.species_name];
            if (!s) {
                s = new Species(org.genome, null, env.total_ticks);
                species[raw.species_name] = s;
            }
            if (!s.anatomy) {
                s.anatomy = org.genome;
                s.calcAnatomyDetails();
            }
            s.name = raw.species_name;
            org.species = s;
        }
        for (const name in species)
            species[name].population = 0;
        for (const org of this.organisms)
            org.species.population++;
        for (const name in species) {
            if (species[name].population > 0)
                FossilRecord.addSpeciesObj(species[name]);
        }
        FossilRecord.loadRaw(env.fossil_record);
        for (const key of ['total_mutability', 'largest_cell_count', 'reset_count', 'total_ticks', 'data_update_rate']) {
            if (env[key] !== undefined && typeof env[key] !== 'object')
                this[key] = env[key];
        }
    }

    // Render snapshot: one byte per cell, low 4 bits = state id, bits 4-5 = the
    // absolute direction of eye cells (needed to draw the slit).
    snapshot() {
        const out = new Uint8Array(this.state);
        const state = this.state;
        for (let i = 0; i < state.length; i++) {
            if (state[i] === EYE) {
                const org = this.ownerAt(i);
                if (org !== null) {
                    let dir = org.rotation + org.genome.dirs[this.cidx[i]];
                    if (dir > 3) dir -= 4;
                    out[i] = EYE | (dir << 4);
                }
            }
        }
        return out;
    }

    // statistics shown in the UI
    stats() {
        const top = FossilRecord.getMostPopulousSpecies();
        return {
            ticks: this.total_ticks,
            orgs: this.organisms.length,
            species: FossilRecord.numExtantSpecies(),
            top: top ? {name: top.name, population: top.population} : null,
            largest: this.largest_cell_count,
            avg_mut: this.averageMutability(),
            resets: this.reset_count,
        };
    }
}

SimWorld.Org = Org;
module.exports = SimWorld;
