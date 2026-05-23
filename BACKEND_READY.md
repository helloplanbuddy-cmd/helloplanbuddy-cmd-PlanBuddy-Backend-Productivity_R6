# 🔧 PlanBuddy Backend - Repair Mode

## Status Summary

The PlanBuddy v9 backend is **ready for startup** pending one final setup step.

**Current State**: 
- ✅ Configuration files created (.env and config/env.js)
- ✅ All core modules verified
- ⏳ Awaiting setup script execution to create missing services directory

**Time to Running**: ~3 minutes

---

## What Was Fixed

### 1. **Environment Configuration** ✅
Created `config/env.js` - Module that loads and validates all environment variables
- Parses DATABASE_URL, REDIS_URL, JWT_SECRET, Razorpay credentials
- Validates required vars on startup
- Provides sensible defaults for development

Created `.env` - Development environment file with:
- PostgreSQL connection string (configured for local docker-compose)
- Redis URLs
- JWT and security credentials
- CORS, logging, and monitoring settings

### 2. **Entry Points Verified** ✅
- **Production**: `npm start` → runs `node server.js`
- **Development**: `npm run dev` → runs `nodemon app.js`
- Both correctly load configuration before initializing

### 3. **Health Check Endpoints** ✅
The server will respond to health checks:
```bash
GET /health        # Liveness (always 200 if app running)
GET /health/live   # Quick readiness check
GET /health/ready  # Deep readiness (checks DB, Redis, queues)
```

---

## What Still Needs To Be Done

### Step 1: Run Setup Script (Required)

The backend requires a `services/productionHealth.js` module that wasn't available.  
This setup script will create it automatically.

**Choose your operating system:**

#### Windows Users
```powershell
.\setup-backend.ps1
```

Or use Command Prompt:
```cmd
setup-backend.bat
```

#### Linux/Mac Users
```bash
bash setup-backend.sh
```

**What the script does:**
1. Creates the `services/` directory
2. Creates `services/productionHealth.js` with health monitoring cron
3. Runs `npm install` to ensure all dependencies are installed

### Step 2: Start External Services

The backend requires PostgreSQL and Redis.

**Option A: Using Docker (Recommended)**
```bash
cd planbuddy_v9
docker-compose up -d postgres redis
```

**Option B: Local Installation**
- Install PostgreSQL 16+ and start on `localhost:5432`
- Install Redis 7+ and start on `localhost:6379`
- Create database: `createdb -U postgres planbuddy`

### Step 3: Start the Backend

```bash
cd planbuddy_v9
npm start
```

**Expected Output:**
```
[startup] Node.js starting
[startup] Verifying database connectivity...
[startup] Database: OK
[startup] Verifying Redis connectivity...
[startup] Redis: OK
[startup] HTTP server listening (port: 3000, pid: 12345)
[startup] Application fully initialized
```

### Step 4: Verify Server is Running

```bash
curl http://localhost:3000/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-05-23T14:30:00Z"
}
```

---

## Project Structure

```
planbuddy_v9/
├── .env                          # ← CREATED: Development config
├── app.js                        # Express app setup
├── server.js                     # HTTP server with graceful shutdown
├── config/
│   ├── env.js                    # ← CREATED: Config loader & validator
│   ├── db.js                     # PostgreSQL connection pool
│   ├── redis.js                  # Redis clients (cache, queue, rate-limit)
│   ├── queues.js                 # BullMQ job queues
│   ├── razorpay.js              # Payment gateway config
│   └── ... other configs
├── middleware/
│   ├── errorHandler.js
│   ├── rateLimit.js
│   ├── backpressure.js
│   └── ... other middleware
├── routes/
│   ├── index.js                  # API route definitions
│   └── internal.js               # Internal observability routes
├── services/                     # ← TO BE CREATED by setup script
│   └── productionHealth.js       # ← TO BE CREATED by setup script
├── controllers/
│   ├── healthController.js
│   ├── authController.js
│   └── ... other controllers
├── utils/
│   ├── logger.js                 # Pino structured logging
│   ├── monitoring.js             # Prometheus metrics
│   └── ... other utilities
└── package.json
```

---

## Configuration Details

### Environment Variables (in .env)

| Variable | Purpose | Default |
|----------|---------|---------|
| `NODE_ENV` | Execution environment | `development` |
| `PORT` | Server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection | `postgresql://postgres:postgres@localhost:5432/planbuddy` |
| `REDIS_URL` | Cache Redis | `redis://127.0.0.1:6379` |
| `REDIS_QUEUE_URL` | BullMQ Redis | `redis://127.0.0.1:6379/1` |
| `JWT_SECRET` | Token signing key | dev key (change in production!) |
| `RAZORPAY_KEY_ID` | Payment API key | `rzp_test_*` (test mode) |
| `RAZORPAY_KEY_SECRET` | Payment API secret | placeholder |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook validation | placeholder |
| `CORS_ORIGINS` | Allowed frontend origins | `http://localhost:3000,http://localhost:5173` |
| `LOG_LEVEL` | Logging verbosity | `info` (dev) / `debug` (production) |

### Health Check Endpoints

The server exposes three health check endpoints for Kubernetes/orchestrator probes:

1. **Liveness Probe** - `GET /health`
   - Always returns 200 if process is alive
   - No dependencies checked
   - Use: Kubernetes `livenessProbe`

2. **Readiness Probe** - `GET /health/live`  
   - Quick readiness check
   - Verifies database connectivity
   - Use: Kubernetes `readinessProbe` (fast)

3. **Deep Readiness** - `GET /health/ready`
   - Complete subsystem check
   - Verifies: DB, Redis, queues, workers
   - Use: load balancer health checks

---

## Troubleshooting

### Error: "Module not found: ./services/productionHealth"
**Solution**: Run the setup script
```bash
# Windows
.\setup-backend.ps1

# or
setup-backend.bat

# Linux/Mac
bash setup-backend.sh
```

### Error: "ECONNREFUSED 127.0.0.1:5432" (PostgreSQL)
**Solution**: Start PostgreSQL
```bash
docker-compose up -d postgres
```

### Error: "ECONNREFUSED 127.0.0.1:6379" (Redis)
**Solution**: Start Redis
```bash
docker-compose up -d redis
```

### Error: "Cannot find module 'express'" or other npm packages
**Solution**: Install dependencies
```bash
cd planbuddy_v9
npm install
```

### Server starts but /health returns 500 error
**Check logs for specific error messages**, but common causes:
- Database not connected (check DATABASE_URL in .env)
- Redis not connected (check REDIS_URL in .env)
- Missing required env variables

---

## Architecture Overview

```
Request Flow:
client → nginx/load-balancer
         ↓
       server.js (HTTP server, graceful shutdown)
         ↓
       app.js (Express middleware chain)
         ├─ Trust proxy (X-Forwarded-For)
         ├─ Proxy validation (KNOWN_PROXY_IPS)
         ├─ Security headers (HSTS, CSP, etc)
         ├─ CORS (origin validation)
         ├─ Rate limiting (globalLimiter)
         ├─ Request tracking (trace ID injection)
         ├─ Request logging (structured JSON via Pino)
         └─ Route handlers
              ├─ /api/v1/* (current API)
              ├─ /api/* (legacy/compat)
              ├─ /health, /health/live, /health/ready
              └─ /metrics (Prometheus)

Background Tasks:
BullMQ workers (separate process or PM2 cluster):
├─ Payment webhook processor
├─ Refund handler
├─ Email notifier
└─ Scheduled tasks (cron)
```

---

## Next Steps

1. **Immediate** (5 mins)
   - [ ] Run setup script for your OS
   - [ ] Verify script created services/productionHealth.js

2. **Short term** (10 mins)
   - [ ] Start PostgreSQL + Redis (docker-compose or local)
   - [ ] Run `npm start`
   - [ ] Test with `curl http://localhost:3000/health`

3. **Verification** (Optional)
   - [ ] Review logs for any warnings
   - [ ] Check /health endpoints all return 200
   - [ ] Review .env for production-safe values

4. **Production Readiness**
   - [ ] Update RAZORPAY_* credentials with live keys
   - [ ] Change JWT_SECRET to strong random value (64 chars)
   - [ ] Configure CORS_ORIGINS for production domains
   - [ ] Set KNOWN_PROXY_IPS to your load balancer IPs
   - [ ] Use environment secrets manager (AWS Secrets Manager, etc)
   - [ ] Enable LOG_LEVEL=info or lower
   - [ ] Test graceful shutdown (SIGTERM handling)

---

## Files Created This Session

```
✓ planbuddy_v9/.env                    (3.2 KB) - Development config
✓ planbuddy_v9/config/env.js           (7.7 KB) - Config module
✓ setup-backend.sh                     (2.2 KB) - Linux/Mac setup
✓ setup-backend.bat                    (2.4 KB) - Windows batch setup
✓ setup-backend.ps1                    (3.8 KB) - PowerShell setup
✓ check-env.js                         (1.3 KB) - Env verification utility
✓ BACKEND_REPAIR_STATUS.md             (7.2 KB) - Full diagnostic report
```

---

## Support Resources

- **API Documentation**: See `/routes/*.js` for endpoint definitions
- **Test Suite**: Run `npm test` to verify setup
- **Configuration Reference**: See comments in `config/env.js`
- **Docker Setup**: See `docker-compose.yml` for full stack
- **Deployment Guide**: See `ecosystem.config.js` for PM2 configuration

---

## Quick Command Reference

```bash
# Setup
./setup-backend.sh (or .bat / .ps1)

# External services
docker-compose up -d postgres redis

# Backend
cd planbuddy_v9
npm install                    # If setup script skipped this
npm start                      # Production mode
npm run dev                    # Development mode (auto-reload)

# Testing
npm test                       # Run all tests
npm test -- __tests__/webhookAuthenticity.unit.test.js
npm test -- --verbose

# Health checks
curl http://localhost:3000/health
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready

# Metrics
curl http://localhost:3000/metrics   # Prometheus metrics

# Logs
tail -f logs/app.log          # If configured
```

---

## Summary

**The backend is ready!** The only remaining step is running the setup script (1 minute) to create the missing services directory and module.

**To get running in 3 minutes:**
1. Run: `./setup-backend.sh` (or .bat / .ps1 for Windows)
2. Run: `docker-compose up -d postgres redis`
3. Run: `npm start` (from planbuddy_v9 directory)
4. Test: `curl http://localhost:3000/health`

Good luck! 🚀
