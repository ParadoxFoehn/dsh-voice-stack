/**
 * services.js -- 语音服务的生命周期（插件的孩子，不是野生的）。
 *
 * 为什么要有这个文件（2026-10-30 定的规矩）：
 *   旧实现用 WMI `Win32_Process.Create` 把 TTS 起在进程树之外，本意是扛住客户端重启，
 *   代价是**插件停用/卸载后服务还在跑、还在占显存**，而用户没有别的办法关掉它。
 *   现在反过来：服务是本插件 spawn 的子进程 ——
 *     1. 插件卸载/停用 → stopAll() 杀掉全部；
 *     2. 插件进程意外消失 → 服务侧 `--parent-pid` 看门狗自杀（防孤儿）；
 *     3. 用户手动关 → 走同一个 stop()。
 *
 * Windows 细节：venv 的 python.exe 是个启动器，真正的解释器是它的子进程，
 * 所以单纯 kill 父 pid 杀不干净 —— 必须 `taskkill /T` 连树一起杀。
 */
import { spawn } from 'node:child_process';

const HEALTH_TIMEOUT = 1200;
const START_TIMEOUT = 40000;   // TTS 在 CPU 上冷加载约 15 s，留足余量

/** 端口与入口都集中在这里，改一处即可。 */
const SPEC = {
  asr: {
    port: 18080,
    cmd: 'D:\\py-asr\\.venv\\Scripts\\python.exe',
    args: ['D:\\py-asr\\asr_server.py', '--port', '18080',
           '--model', 'D:\\py-asr\\models\\Qwen3-ASR-0.6B'],
    cwd: 'D:\\py-asr',
  },
  tts: {
    port: 18082,
    cmd: 'D:\\py-tts\\.venv-qwen\\Scripts\\python.exe',
    args: ['D:\\py-tts\\qwen_tts_server.py', '--port', '18082'],
    cwd: 'D:\\py-tts',
  },
};

/** name -> { proc, pid }，只放我们自己起的进程。 */
const RUNNING = new Map();

const healthUrl = (name) => 'http://127.0.0.1:' + SPEC[name].port + '/health';

export async function alive(name) {
  try {
    const res = await fetch(healthUrl(name), { signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 连子树一起杀。返回 Promise，等 taskkill 退出（或 4 s 超时）后才 resolve。 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      p.on('exit', finish);
      p.on('error', finish);
    } catch {
      finish();
    }
    setTimeout(finish, 4000);
  });
}

/**
 * 起服务并按档位传参。
 * @param {'asr'|'tts'} name
 * @param {{mode?:string, idleSec?:number, device?:string}} tier 该服务的档位
 */
export async function start(name, tier) {
  const spec = SPEC[name];
  if (!spec) throw new Error('unknown service: ' + name);
  if (await alive(name)) return true;               // 已经在跑（可能是上次没来得及关）
  if (RUNNING.has(name)) {                          // 有僵尸：先清
    await stop(name);
  }

  const args = spec.args.slice();
  if (tier && tier.mode === 'idle') {
    args.push('--idle-unload', String(tier.idleSec || 120));
  }
  // 父进程看门狗：本进程一消失，服务自己退出，不留孤儿。
  args.push('--parent-pid', String(process.pid));

  const env = { ...process.env };
  if (name === 'tts' && tier && tier.device === 'cpu') {
    env.CUDA_VISIBLE_DEVICES = '';                  // 让 torch 看不到显卡 → 走 CPU
  }

  try {
    const proc = spawn(spec.cmd, args, {
      cwd: spec.cwd, env, windowsHide: true, stdio: 'ignore', detached: false,
    });
    proc.on('exit', () => RUNNING.delete(name));
    proc.on('error', () => RUNNING.delete(name));
    RUNNING.set(name, { proc, pid: proc.pid });
  } catch {
    return false;
  }

  const deadline = Date.now() + START_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await alive(name)) return true;
    if (!RUNNING.has(name)) return false;           // 进程刚起就退了
  }
  return false;
}

export async function stop(name) {
  const entry = RUNNING.get(name);
  RUNNING.delete(name);
  if (entry) await killTree(entry.pid);
  // 兜底：如果它是在别处起的（例如老的 guard），按端口找到再杀一次。
  if (await alive(name)) {
    const pid = await pidOnPort(SPEC[name].port);
    if (pid) await killTree(pid);
  }
  return !(await alive(name));
}

/** 用 netstat 找监听该端口的 pid（不依赖额外包）。 */
function pidOnPort(port) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true });
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('exit', () => {
        const re = new RegExp('[:.]' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
        const m = out.match(re);
        resolve(m ? Number(m[1]) : 0);
      });
      p.on('error', () => resolve(0));
    } catch {
      resolve(0);
    }
  });
}

/** 插件卸载/停用时调用：把所有自己起的服务连树杀掉。 */
export async function stopAll() {
  const names = Array.from(RUNNING.keys());
  await Promise.all(names.map((n) => stop(n)));
}

export function status() {
  return Promise.all(Object.keys(SPEC).map(async (name) => {
    const base = { name, port: SPEC[name].port };
    try {
      const res = await fetch(healthUrl(name), { signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
      if (!res.ok) return { ...base, up: false, loaded: false };
      const j = await res.json().catch(() => ({}));
      // ASR 的 /health 给 ready，TTS 给 base_ready/design_ready —— 统一成一个 loaded 位。
      return { ...base, up: true, loaded: !!(j.ready || j.base_ready || j.design_ready) };
    } catch {
      return { ...base, up: false, loaded: false };
    }
  }));
}

/** 只卸模型、不杀进程：把显存让给「要干活的模型」，下次用到不必冷启动。 */
export async function unload(name) {
  const spec = SPEC[name];
  if (!spec) throw new Error('unknown service: ' + name);
  try {
    const res = await fetch('http://127.0.0.1:' + spec.port + '/unload', {
      method: 'POST', signal: AbortSignal.timeout(30000),
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  } catch (e) {
    return { status: 0, ok: false, error: String((e && e.message) || e) };
  }
}
