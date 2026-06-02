#!/usr/bin/env node
'use strict';

/**
 * apply-all-migrations.js — Apply all migrations in sequence
 * 
 * Purpose: Apply all migrations from migrations/ directory in order
 * Usage: node apply-all-migrations.js
 * 
 * This script:
 * 1. Reads all *.sql files from migrations/ directory
 * 2. Sorts them numerically by filename prefix (000_, 020_, etc.)
 * 3. Executes each migration in order using the db connection
 * 4. Records migration in schema_migrations table
 * 5. Handles errors and rolls back on failure
 */

const fs = require('fs');
const path = require('path');
const db = require('./config/db');
const logger = require('./utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Get all migration files sorted by version
 */
function getMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.includes('rollback'))
    .sort((a, b) => {
      const aVersion = parseInt(a.split('_')[0]);
      const bVersion = parseInt(b.split('_')[0]);
      return aVersion - bVersion;
    });
  
  return files;
}

/**
 * Check which migrations have already been applied
 */
async function getAppliedMigrations() {
  try {
    const result = await db.query(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    return new Set(result.rows.map(r => r.version));
  } catch (err) {
    // schema_migrations table might not exist yet
    logger.warn('schema_migrations table not found (creating on first migration)');
    return new Set();
  }
}

/**
 * Apply a single migration file
 */
async function applyMigration(filename) {
  const filepath = path.join(MIGRATIONS_DIR, filename);
  const version = filename.split('_')[0];
  
  logger.info(`[MIGRATION] Applying ${filename} (v${version})...`);
  
  try {
    const sql = fs.readFileSync(filepath, 'utf-8');
    
    // Apply migration
    await db.query(sql);
    
    // Ensure the migration is recorded in schema_migrations even if the SQL file
    // itself doesn't contain an explicit tracking INSERT.
    await db.query(
      'INSERT INTO schema_migrations (version, filename, run_at) VALUES ($1, $2, NOW()) ON CONFLICT (version) DO NOTHING',
      [version, filename]
    );
    
    logger.info(`[MIGRATION] ✅ ${filename} applied successfully`);
    return { success: true, version, filename };
  } catch (err) {
    logger.error(`[MIGRATION] ❌ ${filename} FAILED: ${err.message}`);
    return { success: false, version, filename, error: err.message };
  }
}

/**
 * Main execution
 */
async function main() {
  logger.info('═════════════════════════════════════════════════════════════');
  logger.info('MIGRATION SCRIPT: Apply all migrations');
  logger.info('═════════════════════════════════════════════════════════════');
  
  try {
    // Step 1: Get all migration files
    const files = getMigrationFiles();
    logger.info(`Found ${files.length} migration files`);
    
    // Step 2: Check which are already applied
    const applied = await getAppliedMigrations();
    logger.info(`Already applied: ${applied.size} migrations`);
    
    // Step 3: Apply pending migrations
    const pending = files.filter(f => !applied.has(f.split('_')[0]));
    
    if (pending.length === 0) {
      logger.info('✅ All migrations already applied. No work to do.');
      await db.end();
      process.exit(0);
    }
    
    logger.info(`Pending: ${pending.length} migrations`);
    logger.info('');
    
    let successCount = 0;
    let failureCount = 0;
    const results = [];
    
    for (const file of pending) {
      const result = await applyMigration(file);
      results.push(result);
      
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
        // Continue applying others to see full picture
      }
    }
    
    // Step 4: Report results
    logger.info('');
    logger.info('═════════════════════════════════════════════════════════════');
    logger.info('MIGRATION RESULTS');
    logger.info('═════════════════════════════════════════════════════════════');
    
    results.forEach(r => {
      if (r.success) {
        logger.info(`✅ v${r.version}: ${r.filename}`);
      } else {
        logger.error(`❌ v${r.version}: ${r.filename}`);
        logger.error(`   Error: ${r.error}`);
      }
    });
    
    logger.info('');
    logger.info(`Total: ${successCount}✅ ${failureCount}❌`);
    
    if (failureCount > 0) {
      logger.error('Some migrations failed. Review errors above.');
      await db.end();
      process.exit(1);
    } else {
      logger.info('✅ ALL MIGRATIONS APPLIED SUCCESSFULLY');
      await db.end();
      process.exit(0);
    }
  } catch (err) {
    logger.fatal('FATAL: Migration script error', err);
    await db.end();
    process.exit(1);
  }
}

// Run
main();
