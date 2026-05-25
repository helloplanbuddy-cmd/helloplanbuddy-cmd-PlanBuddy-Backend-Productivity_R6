'use strict';
const routes = require('./routes');
function dump(layer, prefix = '') {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).filter((method) => layer.route.methods[method]).join(',');
    console.log('ROUTE', prefix + layer.route.path, methods, layer.route.stack.map((l) => l.name));
    return;
  }

  if (layer.name === 'router' && layer.handle && layer.handle.stack) {
    console.log('LAYER', layer.name, layer.regexp && layer.regexp.source);
    layer.handle.stack.forEach((inner) => dump(inner, prefix));
    return;
  }

  console.log('LAYER', layer.name, layer.regexp && layer.regexp.source);
}

console.log('top-level routes stack count', routes.stack.length);
routes.stack.forEach((layer) => dump(layer));
