// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBeltControlMessage } from '../tools/belt_session.mjs';

test('recognizes separate X and Y start markers and OK finish marker', () => {
  assert.deepEqual(parseBeltControlMessage('B2K_BELT_SESSION_START_X'), { action: 'start', belt: 'X' });
  assert.deepEqual(parseBeltControlMessage('B2K_BELT_SESSION_START_Y'), { action: 'start', belt: 'Y' });
  assert.deepEqual(parseBeltControlMessage('B2K_BELT_SESSION_FINISH'), { action: 'finish' });
});

test('ignores unrelated console output and malformed markers', () => {
  assert.equal(parseBeltControlMessage('B2K_BELT_FREQ_LIVE_X_87.1HZ'), null);
  assert.equal(parseBeltControlMessage('B2K_BELT_SESSION_START_Z'), null);
  assert.equal(parseBeltControlMessage('Klipper state: Ready'), null);
});
