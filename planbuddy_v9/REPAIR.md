# Backend Repair Quick Start

If you're seeing errors when trying to start the backend, use these scripts to fix issues automatically.

## Quick Repair (Recommended - Run This First)

```bash
cd planbuddy_v9
node quick-repair.js
```

This script will:
- ✓ Create missing `services/productionHealth.js` if needed
- ✓ Check all configuration files exist
- ✓ Report if npm dependencies are installed
- ✓ Show next steps

## What If quick-repair.js Isn't Available?

If `quick-repair.js` doesn't exist, use one of these alternatives:

### Option 1: Auto-Repair (Minimal)
```bash
cd planbuddy_v9
node auto-repair.js
```
Creates only the missing `services/productionHealth.js` file.

### Option 2: Setup Script (Full)
```bash
cd <project-root>
node setup.js
```
Handles complete setup including npm install.

### Option 3: Verify Server Status
```bash
cd planbuddy_v9
node verify-server.js
```
Checks everything and reports what's missing.

## After Running Repair Scripts

Once the repair script completes successfully, start the backend:

```bash
cd planbuddy_v9
npm start
```

Expected output in logs:
```
[startup] Database: OK
[startup] Redis: OK  
[startup] HTTP server listening (port: 3000)
```

## Verify Server Is Running

Test the health endpoint:

```bash
curl http://localhost:3000/health/live
```

Expected response:
```
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"ok","timestamp":"..."}
```

## Common Issues

**Issue:** `Cannot find module './services/productionHealth'`
- **Fix:** Run `node quick-repair.js` or `node auto-repair.js`

**Issue:** `Cannot find module 'dotenv'` or other missing modules
- **Fix:** Run `npm install` from planbuddy_v9 directory

**Issue:** `.env file not found`
- **Check:** Verify `.env` file exists in `planbuddy_v9/` directory
- **If missing:** See BACKEND_READY.md for how to create it

**Issue:** `ECONNREFUSED` errors for database/redis
- **Info:** This is normal if PostgreSQL and Redis aren't running
- **Fix:** Start them with: `docker-compose up -d postgres redis`
- **Or:** Update `.env` to point to your database/redis locations

## Files Created by Repair Scripts

```
planbuddy_v9/
├── services/
│   └── productionHealth.js       (created by quick-repair.js)
├── node_modules/                 (created by setup.js)
├── quick-repair.js               (run this first)
├── auto-repair.js                (minimal repair)
└── verify-server.js              (check status)
```

## Need More Help?

See these documentation files:
- `BACKEND_READY.md` - Complete setup and troubleshooting guide
- `QUICK_START.txt` - 4-step quick reference
- `MANUAL_SETUP.md` - Manual step-by-step instructions
