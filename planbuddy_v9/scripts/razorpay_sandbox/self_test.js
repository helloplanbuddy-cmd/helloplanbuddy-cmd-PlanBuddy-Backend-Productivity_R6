const http = require('http');
const crypto = require('crypto');

const expectedPath = '/webhook/razorpay';
const secret = process.env.RAZORPAY_TEST_SECRET || 'test_secret';

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === expectedPath) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
      const receivedSig = (req.headers['x-razorpay-signature'] || '').toString();
      const ok = receivedSig === signature;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, receivedSig, expected: signature }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(0, '127.0.0.1', () => {
  const p = server.address().port;
  console.log('Webhook server listening on port', p);

  // Build payload and signature
  const payload = JSON.stringify({ event: 'payment.captured', id: 'evt_test', amount: 1000 });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const options = {
    hostname: '127.0.0.1',
    port: p,
    path: expectedPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Razorpay-Signature': sig,
    },
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      console.log('Received response', res.statusCode, body);
      server.close(() => process.exit(res.statusCode === 200 ? 0 : 1));
    });
  });

  req.on('error', (err) => {
    console.error('Request error', err.message);
    server.close(() => process.exit(2));
  });

  req.write(payload);
  req.end();
});
