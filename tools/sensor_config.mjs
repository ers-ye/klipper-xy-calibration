// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';

const DEFAULT_SAMPLE_COLUMNS = { time: 0, x: 1, y: 2, z: 3 };

export function resolveHost(argumentHost, environment = process.env) {
  const host = String(argumentHost || environment.B2K_PRINTER_HOST || '').trim();
  if (!host) throw new Error('Set the printer address with --host=<host> or B2K_PRINTER_HOST');
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) throw new Error('Invalid printer host; use a hostname or IP address without a URL scheme');
  return host;
}

export function validateSensorConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Sensor config must be a JSON object');
  const name = String(value.name || '').trim();
  const method = String(value.method || '').trim();
  if (!name) throw new Error('Sensor config name is required');
  if (!/^[A-Za-z0-9_./-]+$/.test(method) || !method.includes('/')) throw new Error('Sensor config method must be a Klipper API method such as lis2dw/dump_lis2dw');
  if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)) throw new Error('Sensor config params must be a JSON object');
  const dataPath = String(value.data_path || 'params.data');
  if (!/^[A-Za-z0-9_.]+$/.test(dataPath)) throw new Error('Sensor config data_path must contain dot-separated object keys');
  const headerPath = String(value.header_path || 'result.header');
  if (!/^[A-Za-z0-9_.]+$/.test(headerPath)) throw new Error('Sensor config header_path must contain dot-separated object keys');
  const inputColumns = value.sample_columns || DEFAULT_SAMPLE_COLUMNS;
  if (!inputColumns || typeof inputColumns !== 'object' || Array.isArray(inputColumns)) throw new Error('sample_columns must map time, x, y, z to array indices');
  const sampleColumns = {};
  for (const key of ['time', 'x', 'y', 'z']) {
    const index = inputColumns[key];
    if (!Number.isInteger(index) || index < 0) throw new Error(`sample_columns.${key} must be a non-negative integer`);
    sampleColumns[key] = index;
  }
  if (new Set(Object.values(sampleColumns)).size !== 4) throw new Error('sample_columns indices must be unique');
  return { name, method, params: value.params, dataPath, headerPath, sampleColumns };
}

export function readSensorConfig(filename) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { throw new Error(`Could not read sensor config ${filename}: ${error.message}`); }
  return validateSensorConfig(raw);
}

export function samplesFromMessage(message, config) {
  let current = message;
  for (const key of config.dataPath.split('.')) current = current?.[key];
  if (!Array.isArray(current)) return [];
  const { time, x, y, z } = config.sampleColumns;
  return current.map((row) => {
    if (!Array.isArray(row)) return null;
    const sample = [row[time], row[x], row[y], row[z]].map(Number);
    return sample.every(Number.isFinite) ? sample : null;
  }).filter(Boolean);
}
