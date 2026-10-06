import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferPracticeKind } from '../public/practice-kind.js';
const ac = (submitted_at: number) => ({ status: 'AC', submitted_at });
test('earlier AC before the attempt starts identifies a repeat', () => {
  assert.equal(inferPracticeKind([ac(100), ac(300)], 300, 60), 'repeat');
});
test('current AC and multiple submissions during this attempt are not repeats', () => {
  assert.equal(inferPracticeKind([ac(250), ac(280), ac(300)], 300, 60), 'unknown');
  assert.equal(inferPracticeKind([ac(240)], 300, 60), 'unknown');
});
test('future AC does not misclassify a backfilled older attempt', () => {
  assert.equal(inferPracticeKind([ac(500)], 300, 60), 'unknown');
});
test('failures, incomplete history and invalid timing cannot prove first independent', () => {
  assert.equal(inferPracticeKind([{ status: 'WA', submitted_at: 10 }], 300, 60), 'unknown');
  assert.equal(inferPracticeKind([], 300, 60), 'unknown');
  assert.equal(inferPracticeKind([ac(10)], null, 60), 'unknown');
  assert.equal(inferPracticeKind([ac(10)], 300, 0), 'unknown');
  assert.equal(inferPracticeKind([ac(10)], NaN, 60), 'unknown');
});
