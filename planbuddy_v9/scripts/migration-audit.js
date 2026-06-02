#!/usr/bin/env node
'use strict';

/**
 * scripts/migration-audit.js — Comprehensive Migration Audit
 * 
 * Purpose: Analyze all migration files, identify duplicates, version conflicts,
 * and SQL issues. Provides a report for manual review and fixes.
 * 
 * Usage: node scripts/migration-audit.js
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

/**
 * Read all migration files
 */
function getMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.includes('rollback'))
    .map(filename => ({
      filename,
      version: extractVersion(filename),
      filepath: path.join(MIGRATIONS_DIR, filename),
    }))
    .sort((a, b) => a.version - b.version);
}

/**
 * Extract numeric version from filename
 */
function extractVersion(filename) {
  const match = filename.match(/^(\d+)_/);
  return match ? parseInt(match[1]) : Infinity;
}

/**
 * Read SQL content of a migration
 */
function readMigrationSQL(filepath) {
  try {
    return fs.readFileSync(filepath, 'utf-8');
  } catch (err) {
    return null;
  }
}

/**
 * Check for duplicate/conflicting versions
 */
function auditVersioning(migrations) {
  const report = {
    issues: [],
    versionMap: {},
  };

  for (const m of migrations) {
    if (!report.versionMap[m.version]) {
      report.versionMap[m.version] = [];
    }
    report.versionMap[m.version].push(m.filename);
  }

  for (const [version, files] of Object.entries(report.versionMap)) {
    if (files.length > 1) {
      report.issues.push({
        type: 'DUPLICATE_VERSION',
        version,
        files,
        severity: 'CRITICAL',
        fix: `Rename one or more files to use unique versions`,
      });
    }
  }

  return report;
}

/**
 * Check for problematic characters in filenames
 */
function auditFilenames(migrations) {
  const report = { issues: [] };

  for (const m of migrations) {
    if (m.filename.includes('(')) {
      report.issues.push({
        type: 'INVALID_FILENAME',
        filename: m.filename,
        severity: 'CRITICAL',
        fix: `Rename to remove special characters`,
      });
    }
  }

  return report;
}

/**
 * Analyze SQL for common errors
 */
function auditSQL(migrations) {
  const report = { issues: [], syntaxProblems: {} };

  for (const m of migrations) {
    const sql = readMigrationSQL(m.filepath);
    if (!sql) {
      report.issues.push({
        type: 'UNREADABLE_FILE',
        filename: m.filename,
        severity: 'CRITICAL',
      });
      continue;
    }

    const problems = [];

    // Check for common SQL issues
    if (sql.includes('WHERE') && sql.includes('SET') && !sql.match(/UPDATE.*SET.*WHERE/i)) {
      problems.push('Potential malformed UPDATE statement');
    }

    if (sql.match(/DROP\s+(TABLE|DATABASE)/i)) {
      problems.push('Contains DROP statement (dangerous in migrations)');
    }

    if (sql.trim().endsWith(';') === false) {
      problems.push('Missing trailing semicolon');
    }

    if (problems.length > 0) {
      report.syntaxProblems[m.filename] = problems;
      report.issues.push({
        type: 'SQL_ISSUE',
        filename: m.filename,
        problems,
        severity: 'WARNING',
      });
    }
  }

  return report;
}

/**
 * Check for dependency issues (e.g., referring to tables that don't exist yet)
 */
function auditDependencies(migrations) {
  const report = {
    issues: [],
    tablesCreated: new Set(),
    tablesReferenced: new Map(),
  };

  for (const m of migrations) {
    const sql = readMigrationSQL(m.filepath);
    if (!sql) continue;

    // Extract CREATE TABLE statements
    const creates = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi) || [];
    creates.forEach(stmt => {
      const match = stmt.match(/(\w+)$/);
      if (match) report.tablesCreated.add(match[1]);
    });

    // Extract table references
    const refs = sql.match(/(?:INSERT|UPDATE|DELETE|FROM|JOIN)\s+(\w+)/gi) || [];
    refs.forEach(stmt => {
      const match = stmt.match(/(\w+)$/);
      if (match) {
        const table = match[1];
        if (!report.tablesReferenced.has(table)) {
          report.tablesReferenced.set(table, []);
        }
        report.tablesReferenced.get(table).push(m.filename);
      }
    });
  }

  // Check for forward references
  for (const [table, files] of report.tablesReferenced) {
    if (!report.tablesCreated.has(table) && table !== 'information_schema' && table !== 'pg_catalog') {
      report.issues.push({
        type: 'FORWARD_REFERENCE',
        table,
        referencedIn: files,
        severity: 'INFO',
      });
    }
  }

  return report;
}

/**
 * Main audit execution
 */
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  MIGRATION AUDIT REPORT                                      ║');
  console.log('║  Generate comprehensive analysis of all migration files      ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const migrations = getMigrationFiles();
  console.log(`✓ Found ${migrations.length} migration files\n`);

  // Run all audits
  const versionAudit = auditVersioning(migrations);
  const filenameAudit = auditFilenames(migrations);
  const sqlAudit = auditSQL(migrations);
  const dependencyAudit = auditDependencies(migrations);

  // Compile all issues
  const allIssues = [
    ...versionAudit.issues,
    ...filenameAudit.issues,
    ...sqlAudit.issues,
    ...dependencyAudit.issues,
  ];

  const critical = allIssues.filter(i => i.severity === 'CRITICAL');
  const warnings = allIssues.filter(i => i.severity === 'WARNING');
  const info = allIssues.filter(i => i.severity === 'INFO');

  // Print report
  console.log('┌─ MIGRATION SUMMARY ────────────────────────────────────────────┐');
  console.log(`│ Total migrations: ${migrations.length}`);
  console.log(`│ Critical issues: ${critical.length}`);
  console.log(`│ Warnings: ${warnings.length}`);
  console.log(`│ Info: ${info.length}`);
  console.log('└────────────────────────────────────────────────────────────────┘\n');

  if (critical.length > 0) {
    console.log('🔴 CRITICAL ISSUES (Blocking):\n');
    critical.forEach((issue, i) => {
      console.log(`  ${i + 1}. ${issue.type}`);
      if (issue.version) console.log(`     Version: ${issue.version}`);
      if (issue.files) console.log(`     Files: ${issue.files.join(', ')}`);
      if (issue.filename) console.log(`     File: ${issue.filename}`);
      if (issue.fix) console.log(`     Fix: ${issue.fix}`);
      console.log();
    });
  }

  if (warnings.length > 0) {
    console.log('⚠️  WARNINGS:\n');
    warnings.forEach((issue, i) => {
      console.log(`  ${i + 1}. ${issue.type}: ${issue.filename}`);
      if (issue.problems) {
        issue.problems.forEach(p => console.log(`     - ${p}`));
      }
      console.log();
    });
  }

  if (info.length > 0) {
    console.log('ℹ️  INFO:\n');
    info.forEach((issue, i) => {
      console.log(`  ${i + 1}. ${issue.type}`);
      if (issue.table) console.log(`     Table: ${issue.table}`);
      if (issue.referencedIn) console.log(`     Referenced in: ${issue.referencedIn.join(', ')}`);
      console.log();
    });
  }

  // Print migration list
  console.log('┌─ MIGRATION EXECUTION ORDER ────────────────────────────────────┐');
  migrations.forEach((m, i) => {
    const status = m.version === Infinity ? '❌' : '✓';
    console.log(`│ ${status} ${String(i).padStart(2, '0')} │ v${String(m.version).padStart(3, '0')} │ ${m.filename.padEnd(40, ' ')} │`);
  });
  console.log('└────────────────────────────────────────────────────────────────┘\n');

  // Recommendations
  if (critical.length > 0) {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║  ⛔ DEPLOYMENT BLOCKED                                         ║');
    console.log('║                                                                ║');
    console.log('║  Cannot proceed with migrations until critical issues fixed.  ║');
    console.log('║                                                                ║');
    console.log('║  Recommended actions:                                         ║');
    console.log('║  1. Fix duplicate version numbers                            ║');
    console.log('║  2. Rename files with invalid characters                     ║');
    console.log('║  3. Re-run audit to verify                                   ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');
    process.exit(1);
  }

  console.log('✅ Migration audit complete. System ready for application.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
