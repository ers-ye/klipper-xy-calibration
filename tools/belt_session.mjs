// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dominantFrequency } from './belt_frequency.mjs';
import { readSensorConfig, samplesFromMessage, resolveHost } from './sensor_config.mjs';

export function parseBeltControlMessage(value) {
  const text = String(value ?? '').replace(/^\s*(?:\/\/|echo:)\s*/, '').trim();
  let match = /^B2K_BELT_SESSION_START_([XY])$/.exec(text);
  if (match) return { action: 'start', belt: match[1] };
  if (text === 'B2K_BELT_SESSION_FINISH') return { action: 'finish' };
  return null;
}

function rpc(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
}

function appendOutputDir(filename) {
  return path.resolve(filename || 'outputs');
}

export async function runBeltSessionMonitor({ host, outputDir = 'outputs', sensorConfig = readSensorConfig('config/accelerometers/lis2dw.json'), onMessage = console.log }) {
  host = resolveHost(host);
  const control = new WebSocket(`ws://${host}:7125/websocket`);
  let requestId = 1;
  let sensor = null;
  let current = null;
  let closing = false;
  const outputPath = appendOutputDir(outputDir);

  const sendGcode = (script) => new Promise((resolve, reject) => {
    const id = requestId++;
    const timeout = setTimeout(() => reject(new Error(`Moonraker request timed out: ${script}`)), 10000);
    const handler = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== id) return;
      control.removeEventListener('message', handler);
      clearTimeout(timeout);
      message.error ? reject(new Error(message.error.message)) : resolve();
    };
    control.addEventListener('message', handler);
    rpc(control, id, 'printer.gcode.script', { script });
  });

  const stopSensor = () => {
    if (sensor) { try { sensor.close(); } catch {} sensor = null; }
  };

  const finishCapture = async () => {
    if (!current) { onMessage('B2K: 当前没有活动测量。'); return; }
    const capture = current;
    current = null;
    stopSensor();
    try {
      const result = dominantFrequency(capture.samples);
      fs.mkdirSync(outputPath, { recursive: true });
      const iso = new Date().toISOString();
      const filename = path.join(outputPath, `belt_${capture.belt.toLowerCase()}_${iso.replace(/[:.]/g, '-')}.csv`);
      const csv = ['klipper_time_s,x_acceleration,y_acceleration,z_acceleration',
        ...capture.samples.map((sample) => sample.map((n) => Number(n).toFixed(6)).join(','))].join('\n');
      fs.writeFileSync(filename, `${csv}\n`, 'utf8');
      await sendGcode(`M118 B2K_BELT_FINAL_${capture.belt}_${result.frequencyHz.toFixed(1)}HZ_AXIS_${result.axis}`);
      onMessage(`完成：${capture.belt} 频率 ${result.frequencyHz.toFixed(1)} Hz，${result.axis} 轴，${result.sampleCount} 点；CSV ${filename}`);
    } catch (error) {
      onMessage(`测量结束，但分析/保存失败：${error.message}`);
      try { await sendGcode(`M118 B2K_BELT_ERROR_${capture.belt}_CHECK_LOCAL_COLLECTOR`); } catch {}
    }
  };

  const startCapture = (belt) => {
    if (current) {
      onMessage(`忽略 ${belt} 启动请求：${current.belt} 测量仍在运行，请先输入 OK。`);
      return;
    }
    current = { belt, samples: [], lastReportAt: 0, lastSampleCount: 0 };
    sensor = new WebSocket(`ws://${host}:7125/klippysocket`);
    sensor.addEventListener('open', () => sensor?.send(JSON.stringify({
      id: 1, method: sensorConfig.method, params: sensorConfig.params,
    })));
    const sensorFailure = (detail) => {
      if (!current || current.belt !== belt) return;
      current = null;
      stopSensor();
      const message = `B2K_SENSOR_ERROR_${belt}_${detail}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
      void sendGcode(`M118 ${message}`).catch(() => {});
      onMessage(`加速度计数据流失败：${detail}`);
    };
    sensor.addEventListener('error', () => sensorFailure('WEBSOCKET_CONNECTION_FAILED'));
    sensor.addEventListener('message', (event) => {
      if (!current) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.error) { sensorFailure(message.error.message || 'API_REQUEST_FAILED'); return; }
      const incoming = samplesFromMessage(message, sensorConfig);
      if (incoming.length) {
        current.samples.push(...incoming);
        const now = Date.now();
        if (now - current.lastReportAt >= 1000 && current.samples.length >= 256) {
          current.lastReportAt = now;
          const window = current.samples.slice(-4096);
          try {
            const live = dominantFrequency(window);
            sendGcode(`M118 B2K_BELT_LIVE_${current.belt}_${live.frequencyHz.toFixed(1)}HZ_AXIS_${live.axis}`)
              .catch((error) => onMessage(`控制台频率回显失败：${error.message}`));
          } catch { /* Wait for enough valid samples. */ }
        }
      }
    });
    onMessage(`${belt} 测量已开始；弹一次对应皮带，观察控制台滚动频率，完成后输入 OK。`);
  };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out connecting to Moonraker control WebSocket')), 10000);
    control.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Moonraker control WebSocket connection failed')); }, { once: true });
    control.addEventListener('open', () => rpc(control, requestId++, 'server.connection.identify', {
      client_name: 'B2K live belt frequency monitor', version: '0.1', type: 'agent', url: 'https://local.b2k-xy-calibration',
    }));
    const handler = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id === 1) { clearTimeout(timeout); resolve(); }
      if (message.method === 'notify_gcode_response') {
        const controlMessage = parseBeltControlMessage(message.params?.[0]);
        if (controlMessage?.action === 'start') startCapture(controlMessage.belt);
        if (controlMessage?.action === 'finish') void finishCapture();
      }
    };
    control.addEventListener('message', handler);
  });

  onMessage(`已连接 ${host}，加速度计配置：${sensorConfig.name}（${sensorConfig.method}）。现在在 Mainsail/Fluidd 输入 BELT_X 或 BELT_Y 开始；输入 OK 停止。`);
  return {
    close: () => { closing = true; stopSensor(); control.close(); },
    get activeBelt() { return current?.belt ?? null; },
    get isClosing() { return closing; },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }));
  try {
    const host = resolveHost(args.host);
    const sensorConfig = readSensorConfig(args['sensor-config'] || 'config/accelerometers/lis2dw.json');
    runBeltSessionMonitor({ host, sensorConfig, outputDir: args.output || 'outputs' })
    .then((monitor) => {
      process.on('SIGINT', () => { monitor.close(); process.exit(0); });
    })
    .catch((error) => { console.error(`B2K belt monitor failed: ${error.message}`); process.exitCode = 1; });
  } catch (error) {
    console.error(`B2K belt monitor failed: ${error.message}`);
    process.exitCode = 1;
  }
}
