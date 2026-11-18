import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verdict } from './check-licenses.mjs';

test('allowed licences pass', () => {
  assert.equal(verdict('MIT').ok, true);
  assert.equal(verdict('(MIT OR CC0-1.0)').ok, true);
  assert.equal(verdict('(MIT AND BSD-3-Clause)').ok, true);
});

test('disallowed licences fail', () => {
  assert.equal(verdict('GPL-2.0-only').ok, false);
  assert.equal(verdict('SSPL-1.0').ok, false);
  assert.equal(verdict('MIT AND GPL-2.0-only').ok, false);
});

test('a missing licence fails', () => {
  assert.equal(verdict('').ok, false);
  assert.equal(verdict(undefined).ok, false);
});

test('the build-data exception needs a dev dependency', () => {
  assert.equal(
    verdict('CC-BY-4.0', { name: 'caniuse-lite', dev: true }).ok,
    true,
  );
  assert.equal(verdict('CC-BY-4.0', { name: 'caniuse-lite' }).ok, false);
});
