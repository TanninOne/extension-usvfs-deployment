const webpack = require('vortex-api/bin/webpack').default;

const config = webpack('usvfs-deployment', __dirname, 4);
config.externals['node-usvfs'] = './usvfs';
config.externals.turbowalk = 'turbowalk';

module.exports = config;
