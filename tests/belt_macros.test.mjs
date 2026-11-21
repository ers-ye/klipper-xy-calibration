import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const config = readFileSync(new URL('../config/printer.cfg.belt-frequency-manual-merge.txt', import.meta.url), 'utf8');

test('belt capture macros remind the operator to position XY at 150 without moving', () => {
  const macroBlocks = config.match(/\[gcode_macro BELT_[XY]\][\s\S]*?(?=\[gcode_macro|$)/g) ?? [];
  assert.equal(macroBlocks.length, 2, 'both belt macros must exist');
  for (const block of macroBlocks) {
    assert.match(block, /X\s*=\s*150\s*,?\s*Y\s*=\s*150/i, 'each macro must remind the operator about XY 150,150');
    assert.doesNotMatch(block, /^\s*(?:G0|G1|FORCE_MOVE)\b/im, 'belt macros must not move the printer');
  }
});
