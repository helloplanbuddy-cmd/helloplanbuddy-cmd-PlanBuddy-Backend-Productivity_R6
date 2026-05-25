'use strict';
const app = require('./app');
function flattenRouter(router, prefix='') {
  const routes = [];
  router.stack.forEach((layer) => {
    if (layer.route) {
      const path = prefix + layer.route.path;
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      routes.push({ path, methods, names: layer.route.stack.map((l) => l.name) });
      return;
    }
    if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      const regexSource = layer.regexp && layer.regexp.source;
      let layerPath = '';
      if (regexSource) {
        const match = regexSource.match(/^\\/(.*?)(?:\\/\?\(\?=\\\/\|\$\)|\(\?:\^\\\/\$\)|$)/);
        if (match) {
          layerPath = '/' + match[1].replace(/\\\//g, '/');
        }
      }
      routes.push(...flattenRouter(layer.handle, prefix + layerPath));
      return;
    }
  });
  return routes;
}
const routes = flattenRouter(app._router, '');
routes.forEach((route) => console.log(route.methods.join(',').padEnd(7), route.path, JSON.stringify(route.names)));
process.exit(0);
