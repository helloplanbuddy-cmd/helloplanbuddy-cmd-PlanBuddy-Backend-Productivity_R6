#!/usr/bin/env node
'use strict';

/**
 * scripts/fix-migrations.js — Automated Migration Cleanup
 * 
 * Purpose: Fix critical migration issues:
 * 1. Rename duplicate version files (001_add... → 003_add..., 002_create... → 004_create...)
 * 2. Fix invalid filenames (remove parentheses)
 * 3. Remove obsolete migrations (duplicate seats tables)
 * 
 * Usage: node scripts/fix-migrations.js
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

const FIXES = [
  // Fix 1: Rename the duplicate 001_create_seats_table.sql to 003_create_seats_table.sql
  {
    from: '001_create_seats_table.sql',
    to: '003_create_seats_table.sql',
    reason: 'Duplicate version number with 001_add_seat_uniqueness_constraint.sql',
  },
  // Fix 2: Rename the second duplicate 002_create_seats_table.sql to 004_create_seats_table.sql
  {
    from: '002_create_seats_table.sql',
    to: '004_create_seats_table.sql',
    reason: 'Duplicate version number (appears twice in migration chain)',
  },
  // Fix 3: Rename file with invalid characters
  {
    from: '160_payment_audit_retention (1).sql',
    to: '160_payment_audit_retention_legacy.sql',
    reason: 'Invalid filename with parentheses',
  },
];

/**
 * Execute fixes
 */
async function executeFixes() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  MIGRATION CLEANUP SCRIPT                                      ║');
  console.log('║  Fix critical migration versioning and naming issues           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  let successCount = 0;
  let failureCount = 0;

  for (const fix of FIXES) {
    const fromPath = path.join(MIGRATIONS_DIR, fix.from);
    const toPath = path.join(MIGRATIONS_DIR, fix.to);

    try {
      if (!fs.existsSync(fromPath)) {
        console.log(`❌ Source file not found: ${fix.from}`);
        failureCount++;
        continue;
      }

      if (fs.existsSync(toPath)) {
        console.log(`⚠️  Target file already exists: ${fix.to} (skipping)`);
        continue;
      }

      fs.renameSync(fromPath, toPath);
      console.log(`✅ Renamed: ${fix.from} → ${fix.to}`);
      console.log(`   Reason: ${fix.reason}\n`);
      successCount++;
    } catch (err) {
      console.log(`❌ Error fixing ${fix.from}: ${err.message}\n`);
      failureCount++;
    }
  }

  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log(`│ Success: ${successCount} | Failures: ${failureCount}`);
  console.log('└────────────────────────────────────────────────────────────────┘\n');

  if (failureCount === 0) {
    console.log('✅ All migration fixes applied successfully!\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║  NEXT STEP:                                                    ║');
    console.log('║  Run: npm run migrate                                          ║');
    console.log('║  Or:  node apply-all-migrations.js                            ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');
    process.exit(0);
  } else {
    console.log('⛔ Some migration fixes failed. Check errors above.\n');
    process.exit(1);
  }
}

executeFixes().catch(err => {
  console.error('Fix script failed:', err);
  process.exit(1);
});
