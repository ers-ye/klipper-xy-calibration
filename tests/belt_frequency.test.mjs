// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { dominantFrequency } from '../tools/belt_frequency.mjs';

test('finds the dominant frequency from synthetic three-axis samples', () => {
  const samples = Array.from({ length: 2048 }, (_, i) => {
    const t = i / 1600;
    return [t, 0.1 * Math.sin(2 * Math.PI * 37 * t),
      0.8 * Math.sin(2 * Math.PI * 82 * t), 0.02 * Math.sin(2 * Math.PI * 120 * t)];
  });
  const result = dominantFrequency(samples);
  assert.equal(result.axis, 'Y');
  assert.ok(Math.abs(result.frequencyHz - 82) < 1);
});

test('rejects too few samples and silent data', () => {
  assert.throws(() => dominantFrequency([[0, 0, 0, 0]]), /at least 64/);
  const silent = Array.from({ length: 128 }, (_, i) => [i / 1000, 0, 0, 0]);
  assert.throws(() => dominantFrequency(silent), /no measurable vibration peak/);
});
