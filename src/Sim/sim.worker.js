// Web Worker entry: the simulation runs here, off the UI thread.
const createHost = require('./SimHost');

const host = createHost((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => host(e.data);
