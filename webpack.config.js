const webpack = require('vortex-api/bin/webpack').default;

const config = webpack('usvfs-deployment', __dirname, 4);
config.externals.usvfs = './usvfs';

module.exports = config;
