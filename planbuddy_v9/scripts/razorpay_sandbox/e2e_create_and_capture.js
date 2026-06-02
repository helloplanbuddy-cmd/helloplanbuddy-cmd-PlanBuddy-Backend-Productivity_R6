const crypto = require('crypto');
const { URL } = require('url');

async function main() {
  const argv = require('minimist')(process.argv.slice(2));
  const webhookUrl = argv.webhookUrl || process.env.WEBHOOK_URL || 'http://127.0.0.1:3000/api/v1/payment/webhook/razorpay';
  const appUrl = argv.appUrl || process.env.APP_URL || 'http://127.0.0.1:3000';
  const paymentId = argv.paymentId || `pay_test_e2e_${Date.now()}`;
  const bookingId = argv.bookingId || null;
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_TEST_SECRET || 'this_is_a_test_webhook_secret_long_enough_64_chars_1234567890abcdef';

  // Optionally try to create an order (best-effort, may require auth)
  if (bookingId) {
    try {
      console.log('Attempting to create order via', `${appUrl}/api/v1/payment/create-order`);
      const resp = await fetch(`${appUrl}/api/v1/payment/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId }),
      });
      console.log('Create-order status', resp.status);
      const body = await resp.text();
      console.log('Create-order response:', body);
    } catch (err) {
      console.warn('Create-order attempt failed (continuing):', err.message);
    }
  }

  // Build capture webhook payload
  const payload = {
    id: `evt_${Date.now()}`,
    event: 'payment.captured',
    payload: {
      event: { id: `evt_${Date.now()}`, type: 'payment.captured' },
      payment: { entity: { id: paymentId } },
    },
  };

  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  console.log('Sending signed capture webhook to', webhookUrl, 'paymentId=', paymentId);

  try {
    const u = new URL(webhookUrl);
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw).toString(),
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Timestamp': timestamp,
      },
      body: raw,
    });

    const txt = await resp.text();
    console.log('Webhook delivery status', resp.status);
    try { console.log('Response JSON:', JSON.parse(txt)); } catch (e) { console.log('Response body:', txt); }
    process.exit(resp.status === 200 ? 0 : 1);
  } catch (err) {
    console.error('Delivery failed:', err.message);
    process.exit(2);
  }
}

main();
