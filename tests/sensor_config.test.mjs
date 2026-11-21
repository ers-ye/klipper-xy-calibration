// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSensorConfig, validateSensorConfig, samplesFromMessage, resolveHost } from '../tools/sensor_config.mjs';

test('accepts editable Klipper dump method, instance, and sample-column mapping', () => {
  const config = validateSensorConfig({
    name: 'Custom accelerometer',
    method: 'custom/dump_accel',
    params: { sensor: 'toolhead_accel', response_template: {} },
    data_path: 'params.samples',
    sample_columns: { time: 2, x: 0, y: 1, z: 3 },
  });
  assert.equal(config.method, 'custom/dump_accel');
  assert.deepEqual(samplesFromMessage({ params: { samples: [[1, 2, 0.5, 3]] } }, config), [[0.5, 1, 2, 3]]);
});

test('rejects malformed stream configuration and missing data paths', () => {
  assert.throws(() => validateSensorConfig({ name: 'Bad example', method: 'not safe', params: {} }), /method/);
  const config = validateSensorConfig({
    name: 'Example', method: 'example/dump', params: {}, data_path: 'params.samples',
    sample_columns: { time: 0, x: 1, y: 2, z: 3 },
  });
  assert.deepEqual(samplesFromMessage({ params: { data: [] } }, config), []);
});

test('requires a host argument or environment variable instead of embedding a printer IP', () => {
  assert.equal(resolveHost('192.0.2.10', {}), '192.0.2.10');
  assert.equal(resolveHost('', { B2K_PRINTER_HOST: 'printer.local' }), 'printer.local');
  assert.throws(() => resolveHost('', {}), /--host/);
});

test('ships Klipper sensor profiles using the shared timestamp and XYZ stream format', () => {
  const expected = {
    lis2dw: ['lis2dw/dump_lis2dw', 'lis2dw'],
    lis3dh: ['lis2dw/dump_lis2dw', 'lis3dh'],
    adxl345: ['adxl345/dump_adxl345', 'adxl345'],
    mpu9250: ['mpu9250/dump_mpu9250', 'mpu9250'],
    icm20948: ['icm20948/dump_icm20948', 'icm20948'],
  };
  for (const [profile, [method, instance]] of Object.entries(expected)) {
    const config = readSensorConfig(`config/accelerometers/${profile}.json`);
    assert.equal(config.method, method);
    assert.equal(config.params.sensor, instance);
    assert.deepEqual(samplesFromMessage({ params: { data: [[1, 2, 3, 4]] } }, config), [[1, 2, 3, 4]]);
  }
});
