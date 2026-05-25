'use strict';
const app = require('./app');
function walk(router, prefix='') {
  if (!router || !router.stack) return;
  router.stack.forEach((layer) => {
    const type = layer.route ? 'route' : layer.name === 'router' ? 'router' : 'middleware';
    const routePath = layer.route ? layer.route.path : undefined;
    const methods = layer.route ? Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).join(',') : '';
    const regex = layer.regexp ? layer.regexp.source : '';
    console.log('PREFIX', prefix, 'TYPE', type, 'NAME', layer.name, 'PATH', routePath || '', 'REGEX', regex, 'METHODS', methods);
    if (layer.handle && layer.handle.stack) {
      walk(layer.handle, prefix + (routePath || ''));
    }
  });
}
walk(app._router, '');
process.exit(0);
