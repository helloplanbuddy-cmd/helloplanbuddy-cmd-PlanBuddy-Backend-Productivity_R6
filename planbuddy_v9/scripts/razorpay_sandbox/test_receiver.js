const http = require('http');
const crypto = require('crypto');

const port = process.env.PORT || 50368;
const secret = process.env.RAZORPAY_TEST_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET || 'this_is_a_test_webhook_secret_long_enough_64_chars_1234567890abcdef';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const sig = (req.headers['x-razorpay-signature'] || '').toString();
    const ts = req.headers['x-razorpay-timestamp'] || '';
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const ok = sig === expected;
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, receivedSig: sig, expected: expected, timestamp: ts }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('Test receiver listening on port', port);
});
