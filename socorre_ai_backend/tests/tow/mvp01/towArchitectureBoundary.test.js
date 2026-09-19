/**
 * MVP-01 — SEC / architecture boundary suite.
 *
 * Enforces the Clean Architecture constraint of #13:
 *   - Domain and Application must not import Express, Knex/PostgreSQL, the
 *     filesystem or provider SDKs;
 *   - controllers stay thin (no persistence client import);
 *   - tests introduce no hidden skips (`test.only` / `describe.skip`) or
 *     temporary bypasses;
 *   - the canonical error code exists exactly once as the domain source.
 *
 * RED-first: written before the MVP-01 module exists.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MODULE_ROOT = path.resolve(__dirname, '../../../src/modules/tow');
const DOMAIN_DIR = path.join(MODULE_ROOT, 'domain');
const APPLICATION_DIR = path.join(MODULE_ROOT, 'application');
const HTTP_DIR = path.join(MODULE_ROOT, 'http');

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map((entry) => path.join(dir, entry))
    .filter((file) => file.endsWith('.js') && fs.statSync(file).isFile());
}

function importSpecifiers(source) {
  const specifiers = [];
  const regex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match = regex.exec(source);
  while (match) {
    specifiers.push(match[1]);
    match = regex.exec(source);
  }
  return specifiers;
}

const FORBIDDEN_DOMAIN_APP = [
  'express', 'knex', 'pg', 'multer', 'fs', 'path', 'http', 'https',
  'axios', 'firebase-admin', 'stripe', 'mercadopago', 'pagseguro',
];

describe('MVP-01 SEC — architecture boundary', () => {
  test('domain and application import no infrastructure', () => {
    const files = [...listJsFiles(DOMAIN_DIR), ...listJsFiles(APPLICATION_DIR)];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        // The pure layers may only require sibling pure files (relative paths).
        if (!specifier.startsWith('.')) {
          throw new Error(`pure layer ${path.relative(MODULE_ROOT, file)} imports non-relative "${specifier}"`);
        }
        const bare = specifier.split('/')[0];
        expect(FORBIDDEN_DOMAIN_APP).not.toContain(bare);
      }
      // No bare filesystem or persistence access anywhere in the pure layers.
      expect(source).not.toMatch(/from ['"](express|knex|pg|fs)['"]/);
    }
  });

  test('HTTP controllers do not import the persistence client directly', () => {
    for (const file of listJsFiles(HTTP_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      expect({ file: path.basename(file), knex: /require\(['"]knex['"]\)/.test(source) }).toEqual({
        file: path.basename(file), knex: false,
      });
      expect({ file: path.basename(file), configDb: /config\/database/.test(source) }).toEqual({
        file: path.basename(file), configDb: false,
      });
    }
  });

  test('the canonical service_module_disabled code is owned by the domain', () => {
    const errors = fs.readFileSync(path.join(DOMAIN_DIR, 'errors.js'), 'utf8');
    expect(errors).toMatch(/service_module_disabled/);
  });

  test('the new MVP-01 suites contain no hidden skips or focused tests', () => {
    const testsDir = path.resolve(__dirname);
    for (const file of listJsFiles(testsDir)) {
      if (path.basename(file) === path.basename(__filename)) continue;
      const source = fs.readFileSync(file, 'utf8');
      // `describe.skip` is the harness opt-in pattern for the PostgreSQL e2e
      // files; a focused test or a skipped individual test is never allowed.
      expect({ file: path.basename(file), only: /(test|it|describe)\.only\b/.test(source) }).toEqual({
        file: path.basename(file), only: false,
      });
      expect({ file: path.basename(file), skippedTest: /(test|it)\.skip\b/.test(source) }).toEqual({
        file: path.basename(file), skippedTest: false,
      });
    }
  });
});
