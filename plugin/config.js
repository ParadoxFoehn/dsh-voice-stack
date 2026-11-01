/**
 * config.js -- 语音服务的档位配置（持久化到插件目录的 config.json）。
 *
 * 只有这一份真值：宿主端点读写它，client.js 的设置面板通过 HTTP 操作它。
 * 写失败不影响调用（返回内存里的配置），前端最多丢一次设置，不会把语音搞哑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'config.json');

/** 出厂默认：显存优先 —— ASR 走 GPU 空闲卸载，TTS 走 CPU 常驻（CPU 与 GPU 同速）。 */
export const DEFAULTS = {
  asr: { mode: 'idle', idleSec: 120 },                 // mode: 'resident' | 'idle'
  tts: { mode: 'resident', idleSec: 120, device: 'cpu' }, // device: 'gpu' | 'cpu'
};

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** 把任意输入规整成合法配置（坏值一律落到默认，绝不让它抛）。 */
export function normalize(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const asr = (src.asr && typeof src.asr === 'object') ? src.asr : {};
  const tts = (src.tts && typeof src.tts === 'object') ? src.tts : {};
  return {
    asr: {
      mode: asr.mode === 'resident' ? 'resident' : 'idle',
      idleSec: clampInt(asr.idleSec, 30, 3600, DEFAULTS.asr.idleSec),
    },
    tts: {
      mode: tts.mode === 'idle' ? 'idle' : 'resident',
      idleSec: clampInt(tts.idleSec, 30, 3600, DEFAULTS.tts.idleSec),
      device: tts.device === 'gpu' ? 'gpu' : 'cpu',
    },
  };
}

export function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    return normalize(DEFAULTS);
  }
}

export function save(input) {
  const cfg = normalize(input);
  try {
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    /* 写不了就算了：内存里的档位仍然生效，下次启动回落默认 */
  }
  return cfg;
}
