// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSensorConfig, samplesFromMessage, resolveHost } from './sensor_config.mjs';

const DEFAULT_MIN_HZ = 10;
const DEFAULT_MAX_HZ = 500;

function fft(real) {
  const n = real.length;
  const data = real.map((value) => [value, 0]);
  let j = 0;
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) [data[i], data[j]] = [data[j], data[i]];
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const wr0 = Math.cos(angle), wi0 = Math.sin(angle), half = length >> 1;
    for (let start = 0; start < n; start += length) {
      let wr = 1, wi = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = data[start + offset];
        const odd = data[start + offset + half];
        const tr = wr * odd[0] - wi * odd[1];
        const ti = wr * odd[1] + wi * odd[0];
        data[start + offset] = [even[0] + tr, even[1] + ti];
        data[start + offset + half] = [even[0] - tr, even[1] - ti];
        [wr, wi] = [wr * wr0 - wi * wi0, wr * wi0 + wi * wr0];
      }
    }
  }
  return data.slice(0, n / 2 + 1).map(([re, im]) => Math.hypot(re, im));
}

export function dominantFrequency(inputSamples, minHz = DEFAULT_MIN_HZ, maxHz = DEFAULT_MAX_HZ) {
  const samples = inputSamples
    .filter((sample) => Array.isArray(sample) && sample.length >= 4)
    .map((sample) => sample.slice(0, 4).map(Number))
    .filter((sample) => sample.every(Number.isFinite))
    .sort((a, b) => a[0] - b[0]);
  if (samples.length < 64) throw new Error('Need at least 64 valid accelerometer samples');
  if (!(minHz > 0 && maxHz > minHz)) throw new Error('Invalid frequency band');
  const start = samples[0][0], end = samples.at(-1)[0], duration = end - start;
  if (!(duration > 0)) throw new Error('Accelerometer timestamps must span a positive duration');
  const n = 2 ** Math.floor(Math.log2(samples.length));
  if (n < 64) throw new Error('Need at least 64 samples for frequency analysis');
  const step = duration / (n - 1), sampleRate = 1 / step;
  if (sampleRate / 2 <= minHz) throw new Error('Sample rate is too low for the requested frequency band');
  const cappedMaxHz = Math.min(maxHz, sampleRate / 2 - sampleRate / n);
  const uniform = [];
  let source = 0;
  for (let i = 0; i < n; i += 1) {
    const t = start + i * step;
    while (source + 1 < samples.length - 1 && samples[source + 1][0] < t) source += 1;
    const left = samples[source], right = samples[Math.min(source + 1, samples.length - 1)];
    const ratio = right[0] === left[0] ? 0 : (t - left[0]) / (right[0] - left[0]);
    uniform.push([1, 2, 3].map((axis) => left[axis] + ratio * (right[axis] - left[axis])));
  }

  let best = null;
  for (let axis = 0; axis < 3; axis += 1) {
    const values = uniform.map((sample) => sample[axis]);
    const mean = values.reduce((sum, value) => sum + value, 0) / n;
    let windowSum = 0;
    const windowed = values.map((value, i) => {
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      windowSum += weight;
      return (value - mean) * weight;
    });
    const magnitudes = fft(windowed);
    const low = Math.max(1, Math.ceil(minHz * n / sampleRate));
    const high = Math.min(n / 2 - 1, Math.floor(cappedMaxHz * n / sampleRate));
    for (let bin = low; bin <= high; bin += 1) {
      if (!best || magnitudes[bin] > best.magnitude) {
        best = { magnitude: magnitudes[bin], magnitudes, axis: ['X', 'Y', 'Z'][axis], bin, windowSum };
      }
    }
  }
  if (!best || best.magnitude < 1e-6) throw new Error('no measurable vibration peak found in the selected frequency band');
  const mag = best.magnitudes;
  const left = Math.log(Math.max(mag[best.bin - 1], 1e-12));
  const center = Math.log(Math.max(mag[best.bin], 1e-12));
  const right = Math.log(Math.max(mag[best.bin + 1], 1e-12));
  const denominator = left - 2 * center + right;
  const offset = denominator === 0 ? 0 : Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator));
  return {
    frequencyHz: (best.bin + offset) * sampleRate / n,
    axis: best.axis,
    peakAmplitudeMmS2: best.magnitude * 2 / best.windowSum,
    sampleCount: samples.length,
    durationSeconds: duration,
    minHz,
    maxHz: cappedMaxHz,
  };
}

function jsonRpc(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
}

export async function captureBeltFrequency({ host, belt, durationSeconds = 5, outputDir, sensorConfig = readSensorConfig('config/accelerometers/lis2dw.json') }) {
  host = resolveHost(host);
  if (!['X', 'Y', 'LEFT', 'RIGHT'].includes(belt)) throw new Error('belt must be X, Y, LEFT, or RIGHT');
  if (!(durationSeconds >= 2 && durationSeconds <= 10)) throw new Error('durationSeconds must be between 2 and 10');
  // Klipper's high-volume sensor stream belongs on Moonraker's bridge socket.
  const endpoint = `ws://${host}:7125/klippysocket`;
  const samples = [];
  let id = 1;
  const ws = new WebSocket(endpoint);
  return await new Promise((resolve, reject) => {
    let captureTimer, connectTimer, closing = false, streamStarted = false;
    const fail = (error) => {
      if (closing) return;
      closing = true;
      clearTimeout(captureTimer);
      clearTimeout(connectTimer);
      try { ws.close(); } catch {}
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finish = async () => {
      if (closing) return;
      closing = true;
      clearTimeout(connectTimer);
      const off = Date.now();
      ws.close();
      try {
        const result = dominantFrequency(samples);
        const iso = new Date().toISOString();
        fs.mkdirSync(outputDir, { recursive: true });
        const filename = path.join(outputDir, `xy_belt_${belt.toLowerCase()}_${iso.replace(/[:.]/g, '-')}.csv`);
        const rows = ['klipper_time_s,x_acceleration,y_acceleration,z_acceleration',
          ...samples.map((row) => row.map((v) => Number(v).toFixed(6)).join(','))];
        fs.writeFileSync(filename, `${rows.join('\n')}\n`, 'utf8');
        resolve({ ...result, belt, startedAt: iso, sampleFile: filename, captureWallMs: off });
      } catch (error) { reject(error); }
    };
    connectTimer = setTimeout(() => fail(new Error('Timed out connecting to Moonraker WebSocket')), 10000);
    ws.addEventListener('error', () => fail(new Error('Moonraker WebSocket connection failed')));
    ws.addEventListener('close', (event) => {
      if (!closing) fail(new Error(`Moonraker WebSocket closed (${event.code})`));
    });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: id++, method: sensorConfig.method, params: sensorConfig.params }));
    });
    ws.addEventListener('message', async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.error) { fail(new Error(message.error.message || JSON.stringify(message.error))); return; }
      let header = message;
      for (const key of sensorConfig.headerPath.split('.')) header = header?.[key];
      if (header && !streamStarted) {
        streamStarted = true;
        clearTimeout(connectTimer);
        try {
          await sendConsoleMessage(host, `B2K_${belt}_BELT_CAPTURE_NOW_PLUCK_ONCE_${durationSeconds}S`);
    console.log(`Pluck the ${belt} belt once now; recording for ${durationSeconds}s…`);
          captureTimer = setTimeout(() => { finish(); }, durationSeconds * 1000);
        } catch (error) {
          fail(error);
        }
        return;
      }
      samples.push(...samplesFromMessage(message, sensorConfig));
    });
  });
}

export async function sendConsoleMessage(host, message) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(message)) throw new Error('Console message contains unsupported characters');
  const ws = new WebSocket(`ws://${host}:7125/websocket`);
  const line = `M118 ${message}`;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out posting result to Fluidd console')), 10000);
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Console WebSocket connection failed')); });
    ws.addEventListener('open', () => jsonRpc(ws, 1, 'server.connection.identify', {
      client_name: 'B2K belt frequency result', version: '0.1', type: 'agent',
      url: 'https://local.b2k-xy-calibration',
    }));
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id === 1) jsonRpc(ws, 2, 'printer.gcode.script', { script: line });
      else if (message.id === 2) {
        clearTimeout(timeout);
        ws.close();
        message.error ? reject(new Error(message.error.message)) : resolve();
      }
    });
  });
  return line;
}

export async function reportToFluidd(host, result) {
  return sendConsoleMessage(host, `B2K_${result.belt}_BELT_FREQ_${result.frequencyHz.toFixed(1)}HZ_AXIS_${result.axis}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }));
  let host;
  const belt = (args.belt || '').toUpperCase();
  const durationSeconds = Number(args.seconds || 5);
  const outputDir = path.resolve(args.output || 'outputs');
  try {
    host = resolveHost(args.host);
    const sensorConfig = readSensorConfig(args['sensor-config'] || 'config/accelerometers/lis2dw.json');
    const result = await captureBeltFrequency({ host, belt, durationSeconds, outputDir, sensorConfig });
    const consoleLine = await reportToFluidd(host, result);
    console.log(JSON.stringify({ ...result, consoleLine }, null, 2));
  } catch (error) {
    console.error(`Belt frequency capture failed: ${error.message}`);
    process.exitCode = 1;
  }
}
