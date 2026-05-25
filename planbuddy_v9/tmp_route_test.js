'use strict';
const app = require('./app');
const req = {
  method: 'POST',
  url: '/api/v1/auth/login',
  path: '/api/v1/auth/login',
  originalUrl: '/api/v1/auth/login',
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
  connection: { remoteAddress: '127.0.0.1' },
};
const res = {
  statusCode: 200,
  headers: {},
  body: '',
  status(code) { this.statusCode = code; return this; },
  setHeader(name, value) { this.headers[name] = value; },
  json(payload) { this.body = JSON.stringify(payload); return this; },
  end(payload) { if (payload) this.body = payload; return this; },
};
let calledNext = false;
app.handle(req, res, (err) => {
  calledNext = true;
  console.log('NEXT', err ? err.message : 'called');
});
setTimeout(() => {
  console.log('RES', res.statusCode, res.body);
  if (!calledNext) console.log('Next not called, router likely handled or still pending');
  process.exit(0);
}, 2000);
