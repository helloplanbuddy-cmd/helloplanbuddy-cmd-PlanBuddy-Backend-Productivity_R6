Razorpay sandbox scripts

Files:
- `send_signed_webhook.js`: send a signed Razorpay-like webhook to a target URL.
- `test_receiver.js`: simple local HTTP server that verifies signature and timestamp headers.

Quick test:

```bash
# start receiver
node scripts/razorpay_sandbox/test_receiver.js

# in another terminal send a signed webhook
node scripts/razorpay_sandbox/send_signed_webhook.js --url http://127.0.0.1:50368/
```

Environment:
- `RAZORPAY_WEBHOOK_SECRET` or `RAZORPAY_TEST_SECRET` to override the default test secret.
Razorpay Sandbox Harness

Files:
- `self_test.js` — lightweight webhook server that verifies HMAC signature handling and responds to a test payload.

Usage:

Run the self-test (no external dependencies required):

```bash
node planbuddy_v9/scripts/razorpay_sandbox/self_test.js
```

Optional: set a custom test secret:

```bash
RAZORPAY_TEST_SECRET=mysecret node planbuddy_v9/scripts/razorpay_sandbox/self_test.js
```

What it does:
- Starts a local HTTP server on an ephemeral port
- Sends a signed POST to `/webhook/razorpay` using a HMAC-SHA256 signature in header `X-Razorpay-Signature`
- Verifies the server returns HTTP 200 for a matching signature

Next steps:
- Integrate this handler into your real webhook processing logic
- Add signature verification to the production webhook endpoint using the same approach
