// Fails when an installed dependency carries a licence that is not allowed in this repository.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'Unlicense',
  'CC0-1.0',
  'Zlib',
  'BlueOak-1.0.0',
  'Python-2.0',
  'PSF-2.0',
  'MPL-2.0',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
]);

// Checked only after a package fails; each applies to dev-only lock entries.
const EXCEPTIONS = {
  'caniuse-lite':
    'browser support data used only by build tooling (dev dependency)',
};

const stripOuter = (s) => {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')') && !t.slice(1, -1).includes('('))
    t = t.slice(1, -1).trim();
  return t;
};

const idsAllowed = (parts) =>
  parts.every((p) => ALLOWED.has(p.replace(/\s+WITH\s+.*$/i, '').trim()));

function expressionOk(licence) {
  const expr = stripOuter(licence);
  if (expr.includes('(')) {
    return idsAllowed(
      expr.split(/[()]|\s+(?:AND|OR)\s+/).filter((p) => p.trim()),
    );
  }
  return expr
    .split(/\s+OR\s+/)
    .some((alt) => idsAllowed(alt.split(/\s+AND\s+/)));
}

export function verdict(licence, { name, dev } = {}) {
  if (licence && expressionOk(licence)) return { ok: true, reason: 'allowed' };
  if (name && dev === true && EXCEPTIONS[name])
    return { ok: true, reason: EXCEPTIONS[name] };
  return { ok: false, reason: licence || 'no licence declared' };
}

function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses
      .map((l) => (typeof l === 'string' ? l : l?.type))
      .filter(Boolean)
      .join(' OR ');
  }
  return pkg.license?.type ?? '';
}

function main(root) {
  const lock = JSON.parse(
    readFileSync(join(root, 'package-lock.json'), 'utf8'),
  );
  let checked = 0;
  let failing = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '') continue;
    const file = join(root, key, 'package.json');
    if (!existsSync(file)) {
      // Only an optional package (another platform's build) may be absent.
      if (entry.optional) {
        console.log(`SKIP ${key}: optional, not installed`);
      } else {
        failing++;
        console.log(`FAIL ${key}: not installed, run npm ci first`);
      }
      continue;
    }
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    checked++;
    const found = licenceOf(pkg);
    const { ok, reason } = verdict(found, {
      name: pkg.name ?? key.split('node_modules/').pop(),
      dev: entry.dev,
    });
    if (ok && reason !== 'allowed') {
      console.log(`EXCEPTION ${pkg.name ?? key}@${pkg.version}: ${reason}`);
    }
    if (!ok) {
      failing++;
      console.log(
        `FAIL ${pkg.name ?? key}@${pkg.version}: ${found || 'no licence declared'}`,
      );
    }
  }
  console.log(`${checked} packages checked, ${failing} failing`);
  process.exit(failing ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv[2] ?? process.cwd());
