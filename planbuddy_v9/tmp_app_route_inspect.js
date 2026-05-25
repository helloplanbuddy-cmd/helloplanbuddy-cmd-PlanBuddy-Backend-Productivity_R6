'use strict';
const app = require('./app');
function dumpLayer(layer, prefix='') {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).join(',');
    console.log('ROUTE', prefix + layer.route.path, methods, layer.route.stack.map((l) => l.name));
  } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
    console.log('LAYER', prefix, layer.name, layer.regexp && layer.regexp.source);
    layer.handle.stack.forEach((inner) => dumpLayer(inner, prefix));
  } else {
    console.log('LAYER', prefix, layer.name, layer.regexp && layer.regexp.source);
  }
}
app._router.stack.forEach((layer) => dumpLayer(layer));
