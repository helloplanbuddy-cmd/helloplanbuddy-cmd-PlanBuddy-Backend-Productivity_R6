const http = require('http');
const https = require('https');
const crypto = require('crypto');

function usage() {
  console.log('Usage: node send_signed_webhook.js --url <url> --paymentId <pay_xxx> [--event <payment.captured>]');
  process.exit(2);
}

const argv = require('minimist')(process.argv.slice(2));
const url = argv.url || process.env.TARGET_URL || 'http://127.0.0.1:3000/api/v1/payment/webhook/razorpay';
const event = argv.event || 'payment.captured';
const paymentId = argv.paymentId || argv.payment || 'pay_test_123';
const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_TEST_SECRET || 'this_is_a_test_webhook_secret_long_enough_64_chars_1234567890abcdef';

if (!url) usage();

const payload = {
  id: `evt_${Date.now()}`,
  entity: 'event',
  event: event,
  payload: {
    event: {
      id: `evt_${Date.now()}`,
      type: event,
    },
    payment: {
      entity: {
        id: paymentId,
      },
    },
  },
};

const raw = JSON.stringify(payload);
const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
const timestamp = Math.floor(Date.now() / 1000).toString();

const u = new URL(url);
const isHttps = u.protocol === 'https:';
const options = {
  hostname: u.hostname,
  port: u.port || (isHttps ? 443 : 80),
  path: u.pathname + (u.search || ''),
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(raw),
    'X-Razorpay-Signature': signature,
    'X-Razorpay-Timestamp': timestamp,
  },
};

const client = isHttps ? https : http;
const req = client.request(options, (res) => {
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    console.log('Sent to', url);
    console.log('Status', res.statusCode);
    try { console.log('Response', JSON.parse(body)); } catch (e) { console.log('Response', body); }
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});

req.on('error', (err) => {
  console.error('Request error', err.message);
  process.exit(2);
});

req.write(raw);
req.end();
