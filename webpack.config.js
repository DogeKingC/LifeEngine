const path = require('path');
const webpack = require("webpack");

module.exports = {
    entry: './src/index.js',
    output: {
        filename: 'bundle.js',
        // the simulation Web Worker (src/Sim/sim.worker.js) is emitted as its own file
        chunkFilename: '[name].bundle.js',
        path: path.resolve(__dirname, 'dist/js/'),
        publicPath: 'auto',
    },
    plugins: [
        new webpack.ProvidePlugin({
            $: "jquery",
        })
    ]
};
