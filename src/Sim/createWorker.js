// Kept as an ES module: webpack needs `new URL(..., import.meta.url)` to emit
// the worker as its own bundle.
export function createWorker() {
    return new Worker(new URL('./sim.worker.js', import.meta.url));
}
