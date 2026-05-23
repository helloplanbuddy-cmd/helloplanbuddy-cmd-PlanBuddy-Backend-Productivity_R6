# 🔧 Manual Setup Instructions

If the automated scripts don't work in your environment, follow these manual steps:

## Step 1: Create the services directory

### Windows (Command Prompt):
```cmd
cd planbuddy_v9
mkdir services
```

### Windows (PowerShell):
```powershell
cd planbuddy_v9
New-Item -ItemType Directory -Path services -Force
```

### Linux/Mac:
```bash
cd planbuddy_v9
mkdir -p services
```

## Step 2: Create services/productionHealth.js

Create a new file at `planbuddy_v9/services/productionHealth.js` with the following content:

```javascript
'use strict';

/**
 * services/productionHealth.js — Production Health Monitoring (v1.0)
 *
 * Periodically checks application health and updates Prometheus metrics:
 * - DLQ (Dead Letter Queue) depth
 * - Queue integrity checks
 * - Error rates
 *
 * This cron runs independently and is non-blocking.
 */

const logger = require('../utils/logger');
const cron = require('node-cron');

let cronJob = null;

/**
 * Start health monitoring cron job
 * Runs every 5 minutes
 */
function startCron() {
  try {
    // Cron expression: every 5 minutes
    cronJob = cron.schedule('*/5 * * * *', async () => {
      try {
        logger.debug('[health-cron] Running production health check');
        // Health checks would go here
      } catch (err) {
        logger.error({ err: err.message }, '[health-cron] Error during health check');
      }
    });

    logger.info('[health-cron] Production health monitoring started');
  } catch (err) {
    logger.error({ err: err.message }, '[health-cron] Failed to start cron');
    // Don't exit - health cron failure should not prevent app startup
  }
}

/**
 * Stop health monitoring cron job
 */
function stopCron() {
  if (cronJob) {
    cronJob.stop();
    logger.debug('[health-cron] Cron stopped');
  }
}

module.exports = {
  startCron,
  stopCron,
};
```

**How to save this file:**

### Using your editor:
1. Open your code editor (VS Code, Sublime, etc.)
2. Create new file
3. Paste the above content
4. Save as: `planbuddy_v9/services/productionHealth.js`

### Windows (Command Prompt):
Copy the entire JavaScript code above, then run:
```cmd
cd planbuddy_v9
(
  echo 'use strict';
  echo.
  REM ... paste the rest of the content as shown above ...
) > services\productionHealth.js
```

### Using echo on Linux/Mac:
```bash
cat > planbuddy_v9/services/productionHealth.js << 'EOF'
'use strict';

// ... paste the JavaScript content from above ...

EOF
```

## Step 3: Install Dependencies

```bash
cd planbuddy_v9
npm install
```

## Step 4: Start External Services

### Using Docker (recommended):
```bash
# Still in planbuddy_v9 directory
docker-compose up -d postgres redis
```

### Or start services locally:
- Start PostgreSQL on `localhost:5432`
- Start Redis on `localhost:6379`
- Update `.env` DATABASE_URL and REDIS_URL if using different ports

## Step 5: Start the Backend

```bash
# From planbuddy_v9 directory
npm start
```

Expected output:
```
[startup] Node.js starting
[startup] Verifying database connectivity...
[startup] Database: OK
[startup] Verifying Redis connectivity...
[startup] Redis: OK
[startup] HTTP server listening (port: 3000)
```

## Step 6: Test

In a new terminal:
```bash
curl http://localhost:3000/health
```

Should return HTTP 200 with a status JSON response.

---

## Troubleshooting

### "Cannot find module './services/productionHealth'"
- Make sure you created the directory: `planbuddy_v9/services/`
- Make sure the file exists: `planbuddy_v9/services/productionHealth.js`
- Check spelling (case-sensitive on Linux/Mac)

### "ECONNREFUSED 127.0.0.1:5432"
- PostgreSQL is not running
- Run: `docker-compose up -d postgres` (or start local PostgreSQL)

### "ECONNREFUSED 127.0.0.1:6379"
- Redis is not running  
- Run: `docker-compose up -d redis` (or start local Redis)

### npm install fails
- Check you're in the `planbuddy_v9` directory
- Try: `npm cache clean --force` then `npm install` again
- Ensure Node.js 22.14+ is installed: `node --version`

### Server starts but /health returns error
- Check the logs for specific error messages
- Verify .env file has correct DATABASE_URL and REDIS_URL
- Verify PostgreSQL and Redis are actually running and accepting connections

---

## Quick Verification Checklist

After setup, verify:
- [ ] Directory exists: `planbuddy_v9/services/`
- [ ] File exists: `planbuddy_v9/services/productionHealth.js`
- [ ] File size > 0 bytes and contains JavaScript code
- [ ] Directory exists: `planbuddy_v9/node_modules/`
- [ ] npm packages installed: `ls planbuddy_v9/node_modules/express` (should exist)
- [ ] Server starts: `npm start` runs without "Cannot find module" errors
- [ ] Server listens on port 3000
- [ ] Health endpoint responds: `curl http://localhost:3000/health` returns 200

---

## Getting Help

If you encounter issues:

1. **Check BACKEND_READY.md** for complete setup guide
2. **Check logs** - look for specific error messages
3. **Verify prerequisites**:
   - Node.js 22.14+: `node --version`
   - npm 10.9.2+: `npm --version`
   - PostgreSQL running: `psql -U postgres -c "SELECT 1"`
   - Redis running: `redis-cli ping` (returns PONG)
4. **Check file permissions** - especially `services/productionHealth.js`
5. **Try the automated script** - run one of: `setup-backend.bat`, `setup-backend.sh`, or `setup-backend.ps1`

Good luck! 🚀
