const CellStates = require("../Organism/Cell/CellStates");

const ACTIVE = new Uint8Array(CellStates.all.length);
for (const s of CellStates.all)
    ACTIVE[s.id] = s.active ? 1 : 0;

// Rotation of a local (col, row) offset, indexed by direction (up, right, down, left).
const ROT_COL_C = [1, 0, -1, 0];
const ROT_COL_R = [0, -1, 0, 1];
const ROT_ROW_C = [0, 1, 0, -1];
const ROT_ROW_R = [1, 0, -1, 0];

function cellDistance(col, row) {
    return Math.max(Math.abs(row)*2 + 2, Math.abs(col)*2 + 2);
}

// An organism's body plan, stored as parallel typed arrays. Genomes are
// immutable once built, so a parent and every unmutated descendant share one
// genome (and one set of rotated offsets) instead of copying cell objects.
class Genome {
    // cells: array of {type, col, row, dir} in body order
    constructor(cells) {
        const n = cells.length;
        this.n = n;
        this.types = new Uint8Array(n);
        this.cols = new Int16Array(n);
        this.rows = new Int16Array(n);
        this.dirs = new Uint8Array(n); // eye direction relative to the organism
        this.is_producer = false;
        this.is_mover = false;
        this.has_eyes = false;
        this.has_camo = false;
        let base_distance = 4;
        let num_active = 0;
        for (let i = 0; i < n; i++) {
            const cell = cells[i];
            this.types[i] = cell.type;
            this.cols[i] = cell.col;
            this.rows[i] = cell.row;
            this.dirs[i] = cell.dir || 0;
            base_distance = Math.max(base_distance, cellDistance(cell.col, cell.row));
            if (cell.type === CellStates.producer.id) this.is_producer = true;
            else if (cell.type === CellStates.mover.id) this.is_mover = true;
            else if (cell.type === CellStates.eye.id) this.has_eyes = true;
            else if (cell.type === CellStates.camo.id) this.has_camo = true;
            if (ACTIVE[cell.type]) num_active++;
        }
        // birth distance of an organism born with exactly these cells
        this.base_birth_distance = base_distance;
        // indices of cells that do work each tick, in body order
        this.active = new Uint16Array(num_active);
        for (let i = 0, k = 0; i < n; i++)
            if (ACTIVE[this.types[i]]) this.active[k++] = i;
        this.offsets = [null, null, null, null];
    }

    // [col0, row0, col1, row1, ...] offsets from the organism center for a rotation
    getOffsets(rotation) {
        let off = this.offsets[rotation];
        if (off === null) {
            off = new Int16Array(this.n * 2);
            const cc = ROT_COL_C[rotation], cr = ROT_COL_R[rotation];
            const rc = ROT_ROW_C[rotation], rr = ROT_ROW_R[rotation];
            for (let i = 0; i < this.n; i++) {
                off[2*i] = cc * this.cols[i] + cr * this.rows[i];
                off[2*i+1] = rc * this.cols[i] + rr * this.rows[i];
            }
            this.offsets[rotation] = off;
        }
        return off;
    }

    toCellList() {
        const list = new Array(this.n);
        for (let i = 0; i < this.n; i++)
            list[i] = {type: this.types[i], col: this.cols[i], row: this.rows[i], dir: this.dirs[i]};
        return list;
    }

    // Species.calcAnatomyDetails compatibility
    countByName() {
        const counts = {};
        for (const c of CellStates.living)
            counts[c.name] = 0;
        for (let i = 0; i < this.n; i++)
            counts[CellStates.all[this.types[i]].name] += 1;
        return counts;
    }

    static fromRawCells(raw_cells) {
        const cells = [];
        for (const rc of raw_cells) {
            const state = CellStates[rc.state.name];
            if (!state || state.id === undefined) continue; // unknown cell type (e.g. from a mod)
            cells.push({type: state.id, col: rc.loc_col, row: rc.loc_row,
                        dir: state === CellStates.eye ? (rc.direction || 0) : 0});
        }
        return new Genome(cells);
    }

    static cellDistance(col, row) {
        return cellDistance(col, row);
    }
}

module.exports = Genome;
