#!/usr/bin/env node
// Validates JSON entries in catalog/profiles/**, catalog/chargers/**, and
// catalog/INDEX.json against a minimal hand-rolled shape check (no ajv
// dependency — single repo, single-file validator, zero install cost in
// CI). A full zod-schema sync from the app side is a follow-up backlog
// item; this stage catches JSON-broken + coarse shape violations, which
// is sufficient for auto-sync PRs that always originate from the
// server-side buildPublishBundle.
//
// Usage: node validate-catalog.mjs <changed-files-list.txt>

import { readFileSync, statSync } from 'node:fs';

const PROFILE_REQUIRED = ['id', 'name', 'totalEnergyWh'];
const CHARGER_REQUIRED = ['id', 'name'];
const INDEX_REQUIRED = ['version', 'generatedAt', 'profiles'];

function fail(file, msg) {
  console.log(`::error file=${file}::${msg}`);
}

function validateProfile(file, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    fail(file, 'profile JSON root must be an object');
    return false;
  }
  let ok = true;
  for (const key of PROFILE_REQUIRED) {
    if (!(key in data)) {
      fail(file, `missing required field: ${key}`);
      ok = false;
    }
  }
  if (typeof data.id !== 'string' || data.id.length < 8) {
    fail(file, 'id must be a string of at least 8 chars');
    ok = false;
  }
  if (typeof data.name !== 'string' || data.name.length === 0) {
    fail(file, 'name must be a non-empty string');
    ok = false;
  }
  if (typeof data.totalEnergyWh !== 'number' || data.totalEnergyWh <= 0) {
    fail(file, 'totalEnergyWh must be a positive number');
    ok = false;
  }
  return ok;
}

function validateCharger(file, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    fail(file, 'charger JSON root must be an object');
    return false;
  }
  let ok = true;
  for (const key of CHARGER_REQUIRED) {
    if (!(key in data)) {
      fail(file, `missing required field: ${key}`);
      ok = false;
    }
  }
  if (typeof data.id !== 'string' || data.id.length < 4) {
    fail(file, 'id must be a string of at least 4 chars');
    ok = false;
  }
  if (typeof data.name !== 'string' || data.name.length === 0) {
    fail(file, 'name must be a non-empty string');
    ok = false;
  }
  return ok;
}

function validateIndex(file, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    fail(file, 'INDEX.json root must be an object');
    return false;
  }
  let ok = true;
  for (const key of INDEX_REQUIRED) {
    if (!(key in data)) {
      fail(file, `missing required field: ${key}`);
      ok = false;
    }
  }
  if (!Array.isArray(data.profiles)) {
    fail(file, 'profiles must be an array');
    ok = false;
  }
  return ok;
}

const changedFile = process.argv[2];
if (!changedFile) {
  console.error('usage: validate-catalog.mjs <changed-files-list.txt>');
  process.exit(2);
}

const list = readFileSync(changedFile, 'utf8').split('\n').filter(Boolean);
let hadError = false;

for (const f of list) {
  if (!f.endsWith('.json')) continue;
  try {
    statSync(f);
  } catch {
    continue; // file deleted in PR
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(f, 'utf8'));
  } catch (err) {
    fail(f, `invalid JSON: ${err.message}`);
    hadError = true;
    continue;
  }

  if (f === 'catalog/INDEX.json') {
    if (!validateIndex(f, parsed)) hadError = true;
  } else if (f.startsWith('catalog/profiles/') && f.endsWith('.json')) {
    if (!validateProfile(f, parsed)) hadError = true;
  } else if (f.startsWith('catalog/chargers/') && f.endsWith('.json')) {
    if (!validateCharger(f, parsed)) hadError = true;
  }
}

if (hadError) {
  console.error('Validation failed.');
  process.exit(1);
}
console.log('All validations passed.');
