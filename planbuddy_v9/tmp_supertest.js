'use strict';
const request = require('supertest');
const app = require('./app');
request(app)
  .post('/api/v1/auth/login')
  .send({ email: 'test@example.com', password: 'password123' })
  .then((res) => {
    console.log('status', res.status);
    console.log('body', res.body);
  })
  .catch((err) => {
    console.error('ERR', err);
  });
