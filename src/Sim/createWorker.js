// The worker bundle (built first by webpack.config.js) is embedded as a string
// and started from a Blob URL, so no separate worker file has to be served.
const source = require('../../build/sim.worker.js');

function createWorker() {
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    return new Worker(url);
}

module.exports = { createWorker };
