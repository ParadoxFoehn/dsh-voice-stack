/** Host half of the voice-player bundle: registers voice_say + owns the two local services. */
import * as services from './services.js';
import * as config from './config.js';
import { promises as fsp } from 'node:fs';

export const inject = ['tools', 'webServer', 'systemPrompt'];

const TTS_BASE = 'http://127.0.0.1:18082';

/**
 * 确保某个服务在跑；不在就按当前档位把它拉起来。
 *
 * 2026-10-30 改：这里以前用 WMI 把 TTS 起在进程树之外（为了扛客户端重启），
 * 代价是插件卸了服务还在、显存不还。现在一律走 services.js —— 服务是插件的子进程，
 * 插件停用/卸载时连树杀掉，插件崩了服务侧的 --parent-pid 看门狗自杀。
 */
async function ensure(name) {
  if (await services.alive(name)) return true;
  const cfg = config.load();
  return services.start(name, cfg[name]);
}

export function apply(ctx) {
  // The one behavioural rule this plugin owns (2026-10-27, user's call): when the user speaks,
  // the assistant speaks back. Kept to three lines so it costs ~120 tokens per turn, and it says
  // exactly when it does NOT apply, so plain-text chats are unaffected.
  ctx.systemPrompt.section({
    name: 'voice-player',
    order: 60,
    text: [
      '## 语音消息（voice-player）',
      '对话里出现 `【语音 N.Ns】http…` 标记 ＝ 用户刚发来一条语音。此时**必须回一条语音**，固定两步：① `voice_say(text=…)`（合成，并把音频登记为 lastVoice → 自动播放）；② 用返回里的文件名跑 `py.cmd dsh-tools\\voice-mark.py --file <文件名> --secs <时长>`，把输出那一行**单独作为一条消息**发出（前后不加字、不用代码块）——这一步才留下可点的播放卡。只发正文标记、不调 `voice_say` 会变成“有卡无声”。细节写在紧随其后的文字里，别只回文字。',
      '用户只打字时这条不适用，正常文字回复即可。语音里放不下的内容，用文字补在后面。',
      '**要动手的活按通话节奏走**（2026-11-05 用户定）：① 先 `voice_say` 应一句「好，我这就去办」→ ② 干活并自己验收 → ③ 再 `voice_say` 汇报结果 → ④ 用汇报那条的文件名跑 `voice-mark.py`，标记单独成条。两次 `voice_say` 会自动排队连播，中间不要等。',
      '**语音消息是回合制的**：回完这一句就正常结束回合——不要读 `voice-inbox.jsonl`、不要等下一句、不要套用通话规则。',
      '',
      '',
      '',
      '## 语音通话规则（只在对话里出现「（语音通话已开始）」时生效）',
      '**注意区分**：用户发来的 `【语音 N.Ns】` 语音消息**不是**通话，别套用下面几条。',
      '完整操作手册：`dsh-plugins/voice-player/README.md` §0「一次通话怎么跑」。下面是最小必守项：',
      '- **开场白**：接通后 3 秒内先 `voice_say` 说一句「你好，我是小肥鱼，我听着呢」。',
      '- **每轮先查状态**：`voice_call_status`——`inCall=false` 就是已挂断，不发语音、改文字回复并结束回合。',
      '- **等新句用 `voice_wait`**：不要 sleep + 读文件；它返回 `lines` / `ended` / `timedOut`，并自动同步已读行号。',
      '- **每条 ≤120 字（约 30 秒）**：更长就拆 2–3 次 `voice_say`，**连着发完、中间不夹 `voice_wait`**（第一组立刻出声、其余组后台合成、客户端排队连播，夹 `voice_wait` 会把播报切成一段一段），全部发完再 `voice_wait`；播报期间麦克风是关的，用户插话靠悬浮条上的「打断」。',
      '- **只认本通的 end**：历史 `end` 不算数；每通电话有独立 `callId`，文件也按会话隔离在 `…\\输出\\calls\\<sessionId>\\`。',
      '- **先回应，再动手**：用户说完一句，先 `voice_say` 应一句「好的，我这就去」，再去查资料、改文件、派子代理；干完回来报一声，再 `voice_wait`。',
      '- **实时优先**：通话里不做长思考。要查证、写码、翻大文件的，先问一句「要不要开个子代理去办」，派出去之后自己继续陪聊，子代理干完再报一声并验收。',
      '- **挂断才收工**：`inCall=false` 或本通 `end` 才结束回合并正常回复。',
      '',
      '没有「（语音通话已开始）」标记时，一律按普通打字聊天处理：正常思考深度、正常长度，不要模仿通话的简短。'
].join('\n')
  });

  // Render diagnostics: the client's bubble scanner reports what it saw (candidate elements,
  // whether they parsed, whether the guards blocked them) so the operator can read it over
  // HTTP instead of opening devtools — two blind render attempts were enough.
  let bubbleReport = null;
  const recentReports = [];   // ring buffer (last 20): one-shot probes must survive the scanner
  const slotProbes = [];      // payloads that carry `probe: …` (e.g. slot-props dump)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/bubble-report',
    handler: async (req, res) => {
      const send = (code, obj) => {
        const b = JSON.stringify(obj);
        res.statusCode = code;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(b));
        res.end(b);
      };
      try {
        let raw = '';
        try { raw = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('data') || ''; } catch (e) { /* ignore */ }
        if (!raw && req.method === 'POST') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          raw = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8');
        }
        if (raw) {
          let parsed;
          try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw: String(raw).slice(0, 600) }; }
          // Ring buffer: the scanner reports every few seconds, so a one-shot probe (e.g. the
          // slot-props dump) would be overwritten before it could be read. Keep the last 20.
          recentReports.push({ ...((parsed && typeof parsed === 'object') ? parsed : { value: parsed }), receivedAt: Date.now() });
          if (recentReports.length > 20) recentReports.shift();
          if (parsed && parsed.probe) slotProbes.push(parsed);
          if (slotProbes.length > 5) slotProbes.shift();
          bubbleReport = parsed;
          return send(200, { ok: true, stored: true });
        }
        // ?all=1 returns every retained report, newest last (use it for one-shot probes).
        const all = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('all');
        return send(200, { ok: true, report: bubbleReport, slotProbes, recent: all ? recentReports : undefined });
      } catch (e) {
        return send(500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  // 最近几条语音（按时间正序）：客户端按顺序排队播放，一条没播完不会盖下一条。
  const voiceHistory = [];

  // The client polls this to learn "a new spoken clip exists": it then mounts a transient
  // player, plays once, and unmounts on `ended` (user's design, 2026-10-28 00:1x). The card in
  // the message stays as the place to replay from — messages get unmounted by the virtualised
  // list, so playback must not live inside them.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/last-voice',
    handler: async (req, res) => {
      const body = JSON.stringify({
        ok: !!lastVoice.file,
        file: lastVoice.file,
        secs: lastVoice.secs,
        at: lastVoice.at || 0,
        id: lastVoice.id || '',
        // 最近几条语音（按时间正序）：客户端的轮询间隔是 1.2s，两条挨得近时
        // 只看 lastVoice 会漏掉前一条——这里一次给全，客户端自己排队。
        history: voiceHistory.slice(-12),
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', Buffer.byteLength(body));
      res.end(body);
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/next-group',
    handler: async (req, res) => {
      const send = (obj) => {
        const b = JSON.stringify(obj);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(b));
        res.end(b);
      };
      if (!lastVoice.groups || !lastVoice.files) return send({ done: true });
      // 按 id 找**这一条**语音的分组：连发多条时 lastVoice 已经换成下一条了，但那不关这条的事——
      // 每条都要能把自己剩下的组取完（2026-11-05 修：以前在这里直接判 stale，后半句全丢）。
      let want = '';
      try { want = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('voice') || ''; } catch { want = ''; }
      const v = (want && recentVoices.get(want))
        || ((!want || want === (lastVoice.id || '')) ? lastVoice : null);
      if (!v || !v.groups || !v.files) return send({ done: true, stale: true });
      let next = (v.groupIndex || 0) + 1;
      // 还没合成出来的组先「pending」，客户端 400ms 后重试；已经合成完但这段失败就跳过。
      while (next < v.files.length && !v.files[next]) {
        if (!v.done) return send({ pending: true, index: next });
        next += 1;
      }
      if (next >= v.files.length) return send({ done: true });
      v.groupIndex = next;
      return send({ file: v.files[next], at: v.at });
    },
  }));

  // Probe: the official admission a composer prompt takes, called from the host instead of
  // the UI. sessionController.prompt() validates the session, builds a user-role message
  // (createUserMessage + source kind 'user') and hands it to agent.followup() — the same
  // door scheduled reminders walk through, minus the composer and minus synthetic keys.
  // Authored 2026-10-27 late, per the sessionController.prompt / agent.followup signature.
  ctx.inject(['sessionController'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: '/voice-player/probe-send',
      handler: async (req, res) => {
        const reply = (code, obj) => {
          const b = JSON.stringify(obj);
          res.statusCode = code;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('content-length', Buffer.byteLength(b));
          res.end(b);
        };
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const svc = scoped.sessionController;
          const probe = url.searchParams.get('probe') || '';
          const listOf = async () => {
            let list;
            try { list = await svc.list({}); } catch (e) { list = { error: String((e && e.message) || e) }; }
            return list;
          };
          if (probe === 'list') return reply(200, { ok: true, probe: 'list', list: await listOf() });

          let sessionId = url.searchParams.get('sessionId') || '';
          if (!sessionId) {
            // Do NOT guess. The old code picked "most recently updated" and silently delivered a
            // voice recorded in conversation A into conversation B (2026-10-28). Guessing turns a
            // bug into a silent wrong result, so it is only allowed when there is exactly one
            // session and the answer is therefore unambiguous.
            const list = await listOf();
            const arr = Array.isArray(list) ? list : (list && (list.sessions || list.items || list.list)) || [];
            if (arr.length !== 1) {
              return reply(400, {
                error: 'sessionId required',
                reason: 'the client must name its own session; the host refuses to guess',
                sessions: arr.length,
                sample: arr.slice(0, 3).map((s) => (s && (s.sessionId || s.id)) || '?'),
              });
            }
            sessionId = (arr[0] && (arr[0].sessionId || arr[0].id)) || '';
            if (!sessionId) return reply(400, { error: 'no session resolved', listSample: arr.slice(0, 2) });
          }

          const text = (url.searchParams.get('text') || '').trim();
          if (!text) return reply(400, { error: 'text required' });
          const requestId = 'voiceprobe-' + Date.now();
          try {
            const out = await svc.prompt({
              sessionId,
              requestId,
              content: [{ type: 'text', text }],
              mode: 'followup',
              clientTimeZone: 'Asia/Shanghai',
            }, new AbortController().signal);
            return reply(200, { ok: true, via: 'sessionController.prompt', sessionId, requestId, result: out });
          } catch (e) {
            return reply(500, {
              ok: false,
              via: 'sessionController.prompt',
              sessionId,
              error: String((e && e.message) || e),
              code: e && e.code,
              details: e && e.details,
            });
          }
        } catch (e) {
          return reply(500, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
  });

  // 预热：把模型真正加载进显存/内存（用户要求「直接预热，不用省」）。
  // TTS：合成一句短文本；ASR：转写一段 0.2 秒静音。失败只是记日志，不影响 ensure 结果。
  async function warmUp(name) {
    try {
      if (name === 'tts') {
        const cfg = config.load();
        const ports = [18082];
        if (cfg.tts.device === 'gpu2' || cfg.tts.device === 'mix') ports.push(18083);
        await Promise.all(ports.map(async (p) => {
          try { await fetch('http://127.0.0.1:' + p + '/say?text=' + encodeURIComponent('预热' + Date.now()), { cache: 'no-store' }); } catch { /* ignore */ }
        }));
      } else {
        try {
          const frames = Math.floor(16000 * 0.2);
          const header = Buffer.alloc(44);
          header.write('RIFF', 0); header.writeUInt32LE(36 + frames * 2, 4); header.write('WAVE', 8);
          header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
          header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
          header.write('data', 36); header.writeUInt32LE(frames * 2, 40);
          const wav = Buffer.concat([header, Buffer.alloc(frames * 2)]);
          const form = new FormData();
          form.append('file', new Blob([wav], { type: 'audio/wav' }), 'warm.wav');
          form.append('model', 'qwen3-asr');
          await fetch('http://127.0.0.1:18080/v1/audio/transcriptions', { method: 'POST', body: form });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // The composer mic asks this before recording: "is the voice service up? if not, start it".
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/ensure',
    handler: async (req, res) => {
      let name = 'tts';
      try { name = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('service') || 'tts'; } catch (e) { /* ignore */ }
      if (name !== 'asr' && name !== 'tts') name = 'tts';
      const ok = await ensure(name);
      if (ok) await warmUp(name);
      const body = JSON.stringify({ ok, alive: ok, service: name, warmed: ok });
      res.statusCode = ok ? 200 : 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', Buffer.byteLength(body));
      res.end(body);
    },
  }));

  // ---- 服务开关与档位（2026-10-30 新增）---------------------------------
  // 给 client.js 的三个端点：状态 / 开关 / 设置。统一 JSON 形状 { ok, ... }。
  const sendJson = (res, code, obj) => {
    const b = JSON.stringify(obj);
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(b));
    res.end(b);
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8');
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/status',
    handler: async (req, res) => {
      const list = await services.status();
      sendJson(res, 200, { ok: true, services: list, config: config.load() });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/settings',
    handler: async (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: config.load() });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
      const before = config.load();
      const cfg = config.save(body);
      // 运行方式（CPU / GPU / GPU×2）变了 → 必须重启 TTS 才生效；空闲卸载只需把秒数推给在跑的服务。
      if (before.tts.device !== cfg.tts.device) {
        try { await services.stop('tts'); } catch { /* ignore */ }
        const ok = await services.start('tts', cfg.tts);
        return sendJson(res, 200, {
          ok: true, config: cfg, restarted: !!ok,
          note: ok ? '运行方式已切换，服务已自动重启' : '运行方式已切换，但服务启动失败（可手动重试）',
        });
      }
      if (before.tts.mode !== cfg.tts.mode || before.tts.idleSec !== cfg.tts.idleSec) {
        let pushed = false;
        try {
          const secs = cfg.tts.mode === 'idle' ? cfg.tts.idleSec : 0;
          const r = await fetch('http://127.0.0.1:18082/idle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ idle_s: secs }),
          });
          pushed = r.ok;
        } catch { pushed = false; }
        return sendJson(res, 200, {
          ok: true, config: cfg, pushed,
          note: pushed ? '空闲设置已即时生效（无需重启）' : '服务未运行，空闲设置将在下次启动时生效',
        });
      }
      return sendJson(res, 200, { ok: true, config: cfg, note: '已保存' });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/service',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const target = url.searchParams.get('target') || '';
      const action = url.searchParams.get('action') || '';
      if (target !== 'asr' && target !== 'tts') {
        return sendJson(res, 400, { ok: false, error: 'target must be asr|tts' });
      }
      const cfg = config.load();
      try {
        if (action === 'start') {
          const ok = await services.start(target, cfg[target]);
          if (ok) await warmUp(target);   // 启动即预热：模型直接进显存/内存
          return sendJson(res, ok ? 200 : 503, { ok, warmed: ok });
        }
        if (action === 'unload') {
          // 只卸模型、不杀进程：给 local-models-monitor 那类"模型要干活"的调度用。
          // ASR 正在转写时回 409 + busy，调用方应稍后重试，而不是强行杀掉。
          const r = await services.unload(target);
          return sendJson(res, r.status === 409 ? 409 : (r.ok ? 200 : 503), r);
        }
        if (action === 'stop') {
          const ok = await services.stop(target);
          return sendJson(res, ok ? 200 : 500, { ok });
        }
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
      return sendJson(res, 400, { ok: false, error: 'action must be start|stop|unload' });
    },
  }));

  // 插件卸载/停用 → 服务连树杀掉。这是"不留残骸"的唯一保证点。
  ctx.effect(() => () => { services.stopAll(); });

  // 同源音频代理：把 18082 的 /say-file/<name> 转给页面同源地址，绕开跨源播放限制
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/audio',
    handler: async (req, res) => {
      let name = '';
      try { name = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('file') || ''; } catch { name = ''; }
      if (!name || name.indexOf('..') >= 0) { res.statusCode = 400; return res.end(); }
      try {
        const r = await fetch('http://127.0.0.1:18082/say-file/' + encodeURIComponent(name));
        if (!r.ok) { res.statusCode = r.status; return res.end(); }
        const buf = Buffer.from(await r.arrayBuffer());
        res.statusCode = 200;
        res.setHeader('content-type', r.headers.get('content-type') || 'audio/mpeg');
        res.setHeader('content-length', buf.length);
        res.end(buf);
      } catch (e) {
        res.statusCode = 502;
        res.end();
      }
    },
  }));

  // 录音上传：存文件 + 调 ASR 转写。以前是直接 POST 到 TTS 服务的 /upload，
  // 但 CPU 档（CosyVoice2）没有那个端点，录音就录不进去（2026-11-03 实测）。
  const VOICE_UPLOAD_DIR = 'D:\\py-tts\\out';
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/upload',
    handler: async (req, res) => {
      const send = (code, obj) => {
        const b = JSON.stringify(obj);
        res.statusCode = code;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(b));
        res.end(b);
      };
      if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (buf.length < 1000) return send(400, { ok: false, error: 'too short' });
        const crypto = await import('node:crypto');
        const digest = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
        const name = 'in-' + digest + '.webm';
        const { join } = await import('node:path');
        await fsp.mkdir(VOICE_UPLOAD_DIR, { recursive: true });
        await fsp.writeFile(join(VOICE_UPLOAD_DIR, name), buf);
        let transcript = '';
        try {
          const form = new FormData();
          form.append('file', new Blob([buf], { type: 'audio/webm' }), name);
          form.append('model', 'qwen3-asr');
          const r = await fetch('http://127.0.0.1:18080/v1/audio/transcriptions', { method: 'POST', body: form });
          if (r.ok) transcript = ((await r.json()).text || '').trim();
        } catch (e) {
          if (typeof console !== 'undefined') console.error('[voice] asr failed', e);
        }
        return send(200, { ok: true, url: '/say-file/' + name, seconds: 0, transcript });
      } catch (e) {
        return send(500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  ctx.effect(() => () => { services.stopAll(); });

  // 每个会话一套独立的通话文件：calls\<sessionId>\voice-inbox.jsonl | voice-inbox.read | voice-heartbeat.txt
  // 以前所有会话共用一个 inbox，上一通电话留下的 end 会串进下一次通话（2026-11-04 踩过两次）。
  const VOICE_CALLS = 'D:\\Harness工作区\\会话\\流式语音输入可行性\\输出\\calls';
  const safeSid = (sid) => String(sid || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'default';
  const callDir = (sid) => VOICE_CALLS + '\\' + safeSid(sid);
  const inboxPath = (sid) => callDir(sid) + '\\voice-inbox.jsonl';
  const readPath = (sid) => callDir(sid) + '\\voice-inbox.read';
  const heartbeatPath = (sid) => callDir(sid) + '\\voice-heartbeat.txt';
  let callState = { active: false, at: 0, since: 0, callId: '', sessionId: '' };
  // 合成中标记：合成要几秒到几十秒，这期间客户端该亮「忙线」——用户这时说话只会被排队。
  const synthBusy = { count: 0, since: 0 };
  const activeSid = () => String(callState.sessionId || 'default');

  async function ensureCallDir(sid) {
    try { await fsp.mkdir(callDir(sid), { recursive: true }); } catch { /* ignore */ }
  }

  async function touchHeartbeat(sid) {
    try {
      await ensureCallDir(sid);
      await fsp.writeFile(heartbeatPath(sid), String(Date.now()), 'utf8');
    } catch { /* ignore */ }
  }

  // 通话心跳：agent 在通话回合里轮询时刷新这个文件的时间戳；
  // 客户端据此判断「它在听（聆听）」还是「在忙别的（忙线）」。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-call/heartbeat',
    handler: async (req, res) => {
      const send = (obj) => {
        const b = JSON.stringify(obj);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(b));
        res.end(b);
      };
      try {
        const st = await fsp.stat(heartbeatPath(activeSid()));
        const age = Date.now() - st.mtimeMs;
        return send({ ok: true, alive: age < 3000, age: Math.round(age), busy: synthBusy.count > 0, sessionId: activeSid() });
      } catch {
        return send({ ok: true, alive: false, age: -1, busy: synthBusy.count > 0, sessionId: activeSid() });
      }
    },
  }));

  // 通话状态：客户端接通/挂断时各 POST 一次，宿主记住并暴露给 agent。
  // 它和心跳是两个东西——心跳说「agent 还在听」，状态说「这通电话还没挂」。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-call/state',
    handler: async (req, res) => {
      const send = (code, obj) => {
        const b = JSON.stringify(obj);
        res.statusCode = code;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(b));
        res.end(b);
      };
      const heartbeatAge = async () => {
        try {
          const st = await fsp.stat(heartbeatPath(activeSid()));
          return Math.round(Date.now() - st.mtimeMs);
        } catch { return -1; }
      };
      if (req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const active = !!body.active;
          const cid = String(body.callId || '');
          const sid = String(body.sessionId || '');
          if (active) {
            callState = {
              active: true,
              at: Date.now(),
              since: callState.active ? callState.since : Date.now(),
              callId: cid || callState.callId || '',
              sessionId: sid || callState.sessionId || 'default',
            };
            await ensureCallDir(callState.sessionId);
            await touchHeartbeat(callState.sessionId);
          } else {
            callState = {
              active: false,
              at: Date.now(),
              since: 0,
              callId: cid || callState.callId || '',
              sessionId: sid || callState.sessionId || 'default',
            };
          }
          return send(200, { ok: true, state: callState });
        } catch (e) {
          return send(400, { ok: false, error: String((e && e.message) || e) });
        }
      }
      return send(200, {
        ok: true,
        state: callState,
        heartbeatAge: await heartbeatAge(),
        inbox: inboxPath(activeSid()),
      });
    },
  }));

  // 语音通话文件通道：客户端每句转写 POST 到这里，追加进**该会话自己的** JSONL；
  // 云端 agent 在通话回合里读这个文件（不再逐句注入）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-call/inbox',
    handler: async (req, res) => {
      const send = (code, obj) => {
        const b = JSON.stringify(obj);
        res.statusCode = code;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(b));
        res.end(b);
      };
      if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
        const sid = String(body.sessionId || '') || activeSid();
        const line = JSON.stringify(Object.assign({ t: Date.now() }, body)) + '\n';
        await ensureCallDir(sid);
        await fsp.appendFile(inboxPath(sid), line, 'utf8');
        return send(200, { ok: true, sessionId: safeSid(sid), inbox: inboxPath(sid) });
      } catch (e) {
        return send(500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  const FFMPEG_EXE = 'D:\\py-asr\\.venv\\Lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe';
  const TTS_OUT = 'D:\\py-tts\\out';

  function splitBalanced(input) {
    const s = String(input || '');
    if (s.length < 24) return [s];
    const marks = ['。', '！', '？', '；', '，', '、'];
    const mid = Math.floor(s.length / 2);
    let best = -1;
    for (let i = 0; i < s.length; i += 1) {
      if (marks.includes(s[i])) {
        if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
      }
    }
    if (best >= 6 && best <= s.length - 6) return [s.slice(0, best + 1), s.slice(best + 1)];
    return [s.slice(0, mid), s.slice(mid)];
  }

  async function sayBytes(port, segText) {
    const r = await fetch('http://127.0.0.1:' + port + '/say?text=' + encodeURIComponent(segText));
    if (!r.ok) throw new Error('say ' + port + ' -> ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }

  /**
   * 合成策略：由设置里的档位决定「用几个实例、能不能并行」。
   *
   * - gpu  单卡、一份 Qwen3（18082）        → 串行，全部发给 18082
   * - gpu2 双份**同一个** Qwen3（18082+18083）→ 并行，各路一份，音色一致
   * - mix  GPU 的 Qwen3 + CPU 的 CosyVoice2  → 并行，两个不同模型（音色会有差）
   * - cpu  一份 CosyVoice2（18082，CPU）     → 串行
   *
   * 并发的红线：**同一个实例同时接两条合成会触发 CUDA device-side assert**，
   * 一次就把那个进程的 CUDA 上下文废掉。所以并发度必须 ≤ 可用实例数，
   * 单实例时只能串行——这正是之前长文本必 500 的原因。
   */
  function ttsPlan() {
    let dev = 'gpu';
    try { dev = String((config.load().tts || {}).device || 'gpu'); } catch { dev = 'gpu'; }
    if (dev === 'gpu2' || dev === 'mix') {
      return { device: dev, ports: [18082, 18083], concurrency: 2 };
    }
    return { device: dev, ports: [18082], concurrency: 1 };
  }

  async function portAlive(port) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health',
        { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  async function synthesizeMerged(input) {
    const segs = splitBalanced(input);
    const plan = ttsPlan();
    let buffers;
    if (segs.length === 1) {
      buffers = [await sayBytes(plan.ports[0], segs[0])];
    } else {
      // 并行只跨实例：先把这一档里真的活着的实例挑出来，凑不满两路就串行打同一个。
      let ports = [];
      for (const p of plan.ports) {
        if (await portAlive(p)) ports.push(p);
      }
      if (!ports.length) ports = [plan.ports[0]];
      if (ports.length >= 2) {
        buffers = await Promise.all([
          sayBytes(ports[0], segs[0]),
          sayBytes(ports[1], segs[1]),
        ]);
      } else {
        buffers = [await sayBytes(ports[0], segs[0]), await sayBytes(ports[0], segs[1])];
      }
    }
    const fsp = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const id = Date.now().toString(36);
    const parts = [];
    for (let i = 0; i < buffers.length; i += 1) {
      const p = join(TTS_OUT, 'seg-' + id + '-' + i + '.mp3');
      await fsp.writeFile(p, buffers[i]);
      parts.push(p);
    }
    if (parts.length === 1) return { file: parts[0].split(/[\\/]/).pop() };
    const list = join(TTS_OUT, 'seg-' + id + '.txt');
    await fsp.writeFile(list, parts.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n');
    const merged = join(TTS_OUT, 'qwen-merged-' + id + '.mp3');
    await new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_EXE, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', '96k', merged]);
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg ' + code))));
      proc.on('error', reject);
    });
    for (const p of parts) { try { await fsp.unlink(p); } catch { /* ignore */ } }
    try { await fsp.unlink(list); } catch { /* ignore */ }
    return { file: 'qwen-merged-' + id + '.mp3' };
  }

  // 把多段 mp3 拼成一个完整文件（重新编码，避免 -c copy 的噪声问题）
  async function concatClips(files) {
    if (!files || files.length === 0) return '';
    if (files.length === 1) return files[0];
    const fsp = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const id = Date.now().toString(36);
    const list = join(TTS_OUT, 'concat-' + id + '.txt');
    const lines = files.map((f) => "file '" + join(TTS_OUT, f).replace(/\\/g, '/') + "'").join('\n') + '\n';
    await fsp.writeFile(list, lines, 'utf8');
    const out = join(TTS_OUT, 'full-' + id + '.mp3');
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG_EXE, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', '96k', out]);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg ' + code))));
      p.on('error', reject);
    });
    try { await fsp.unlink(list); } catch { /* ignore */ }
    return 'full-' + id + '.mp3';
  }

  // ---- 渐进式分段合成：按句号拆句，每 2 句一组 ----
  function splitGroups(input) {
    const s = String(input || '').trim();
    if (!s) return [];
    const parts = s.match(/[^。！？!?；;\.]+[。！？!?；;\.]*/g) || [s];
    const groups = [];
    let buf = '';
    let count = 0;
    for (const p of parts) {
      buf += p;
      count += 1;
      if (count >= 2) {
        groups.push(buf);
        buf = '';
        count = 0;
      }
    }
    if (buf.trim()) groups.push(buf);
    return groups.length ? groups : [s];
  }

  async function synthGroup(segText, port) {
    const bytes = await sayBytes(port || 18082, segText);
    const fsp = await import('node:fs/promises');
    const { join } = await import('node:path');
    const name = 'seg-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000) + '.mp3';
    await fsp.writeFile(join(TTS_OUT, name), bytes);
    return name;
  }

  // Last synthesized clip, kept module-level so output.render() can emit the marker and so the
  // client can poll /voice-player/last-voice for its one-shot playback.
  let lastVoice = { file: '', streamUrl: '', secs: 0, at: 0 };
  // 每一条语音各自的分组登记表：连发多条时 lastVoice 会被后一条顶掉，
  // 前一条剩下的组就再也取不到了（2026-11-05 用户实测：每段只念前半句）。
  const recentVoices = new Map();   // id -> voice，保留最近 10 条
  function rememberVoice(v) {
    if (!v || !v.id) return;
    recentVoices.set(v.id, v);
    while (recentVoices.size > 10) {
      const oldest = recentVoices.keys().next().value;
      recentVoices.delete(oldest);
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'voice_say',
    description:
      'Send a voice message: the given text is spoken by the local offline TTS and appears in the chat as a playable audio message. ' +
      'Use it when the user should HEAR the reply instead of reading it. ' +
      'Keep it under 120 characters (≈30 s): the mic is closed while it plays, so anything the user ' +
      'says during a long clip is lost. For longer text send 2-3 separate calls and use voice_wait ' +
      'between them to pick up what the user said.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say. Keep it under 600 characters.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, chars: { type: 'number' }, file: { type: 'string' }, secs: { type: 'number' }, groups: { type: 'number' }, warn: { type: 'string' } },
        required: ['ok'],
      },
      // The rendered text IS the marker the client already knows how to draw: the bubble
      // renderer swaps it for a native <audio> in the message list — the same path the user's
      // own voice messages take (and the reason an iframe/HTTP player proved unreliable).
      render: () => [{ type: 'text', text: lastVoice.file
        ? '【语音 ' + lastVoice.secs.toFixed(1) + 's】http://127.0.0.1:18082/say-file/' + lastVoice.file
        : ('voice message failed' + (lastVoice.error ? ': ' + String(lastVoice.error).slice(0, 80) : '')) }],
    },
    async execute(args) {
      const text = String((args && args.text) || '').slice(0, 800);
      const alive = await ensure('tts');
      if (!alive) return { ok: false, chars: text.length, engine: 'down', file: '', secs: 0 };
      // 合成期间标忙：客户端据此把状态灯切成「忙线」（这时用户说话只会被排队）
      synthBusy.count += 1;
      synthBusy.since = Date.now();
      // Synthesize the WHOLE clip here (cached by text digest on the server) instead of deferring
      // to playback: a real mp3 with a known length is the only variant that reliably plays to
      // the end. Cost is paid in this turn, not in the user's ear.
      try {
        const secs = Math.max(1.5, text.length / 4.2);
        const groups = splitGroups(text);
        const plan = ttsPlan();
        // 双实例档位也可能只有一个真活着（第二个没起来 / 崩了）：先探活，凑不满两路就降级串行。
        if (plan.concurrency > 1) {
          const live = [];
          for (const p of plan.ports) {
            if (await portAlive(p)) live.push(p);
          }
          if (live.length < 2) {
            plan.ports = live.length ? live : [plan.ports[0]];
            plan.concurrency = 1;
          }
        }
        const portFor = (i) => plan.ports[i % plan.ports.length];
        // 渐进式：**只等第一组**合成完就返回，播放立刻开始；其余组在播放期间后台合成。
        // 以前是整篇合成完再拼一个文件——长文要干等几十秒才出声；
        // 更早的版本则是「播完第一组才去合成第二组」——两句之间空等。两种都不对（2026-11-04）。
        const voice = {
          id: 'v' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000),
          file: '',
          streamUrl: '',
          secs,
          groups,
          files: new Array(groups.length).fill(''),
          groupIndex: 0,
          at: Date.now(),
          done: false,
        };
        const first = await synthGroup(groups[0], portFor(0));
        voice.files[0] = first;
        voice.file = first;
        lastVoice = voice;
        rememberVoice(voice);
        voiceHistory.push({ id: voice.id, file: first, at: voice.at });
        if (voiceHistory.length > 24) voiceHistory.splice(0, voiceHistory.length - 24);
        if (groups.length > 1) {
          void (async () => {
            const step = plan.concurrency > 1 ? 2 : 1;
            let i = 1;
            while (i < groups.length) {
              const batch = [];
              for (let k = 0; k < step && i + k < groups.length; k += 1) {
                const idx = i + k;
                batch.push(
                  synthGroup(groups[idx], portFor(idx))
                    .then((f) => { voice.files[idx] = f; })
                    .catch(() => { voice.files[idx] = ''; }),
                );
              }
              await Promise.all(batch);
              i += step;
            }
            voice.done = true;
          })();
        } else {
          voice.done = true;
        }
        const file = first;
        const warn = secs > 30
          ? '这段约 ' + Math.round(secs) + ' 秒：播报期间麦克风是关的，用户说的话会丢；下次请拆成 2-3 次，中间用 voice_wait 回读。'
          : '';
        return { ok: true, chars: text.length, file, secs, groups: groups.length, engine: 'qwen3-tts-progressive', warn };
      } catch (e) {
        lastVoice = { file: '', secs: 0, at: 0, error: String((e && e.message) || e) };
        return { ok: false, chars: text.length, file: '', secs: 0, engine: 'error', error: String((e && e.message) || e) };
      } finally {
        synthBusy.count = Math.max(0, synthBusy.count - 1);
      }
    },
  }));

  // ---------------------------------------------------------------- 通话窗口 / 已读标记
  // 每通电话开始时客户端写一条 {"type":"start","callId":…}，挂断写 {"type":"end","callId":…}。
  // agent 只认「最后一条 start 之后」的 end——历史 end 不会再被误判成这通电话结束。
  // 文件按会话隔离（calls\<sessionId>\…），所以这里一律通过 activeSid() 取当前会话的路径。

  async function readInboxLines() {
    try {
      const raw = await fsp.readFile(inboxPath(activeSid()), 'utf8');
      return raw.split(/\r?\n/).filter((l) => l.trim());
    } catch { return []; }
  }

  function parseLine(l) {
    try { return JSON.parse(l); } catch { return null; }
  }

  /** 最后一条 start 的行号（1-based，0 = 没有），以及它之后是否已经有 end。 */
  function callWindow(lines, callId) {
    let startLine = 0;
    let startedId = '';
    for (let i = 0; i < lines.length; i += 1) {
      const o = parseLine(lines[i]);
      if (o && o.type === 'start') { startLine = i + 1; startedId = String(o.callId || ''); }
    }
    let endedAfterStart = false;
    for (let i = startLine; i < lines.length; i += 1) {
      const o = parseLine(lines[i]);
      if (!o || o.type !== 'end') continue;
      const cid = String(o.callId || '');
      if (!cid || !callId || cid === callId || (startedId && cid === startedId)) { endedAfterStart = true; break; }
    }
    return { startLine, startedId, endedAfterStart };
  }

  async function markRead(n) {
    try {
      await ensureCallDir(activeSid());
      await fsp.writeFile(readPath(activeSid()), String(n), 'utf8');
    } catch { /* ignore */ }
  }

  // agent 用的状态查询 + 心跳保活：调一次 = 说一句「我还在听」。
  // 心跳文件（voice-heartbeat.txt）的 mtime 就是凭据，客户端据此把状态灯切回「聆听」。
  let lastStatus = { inCall: false, lastEvent: 'none', hint: '', nextLine: 0 };
  ctx.effect(() => ctx.tools.register({
    name: 'voice_call_status',
    description:
      'Check whether the voice call is still live, and refresh the listening heartbeat. ' +
      'Call it at the start of a call turn and again right before any voice reply. ' +
      'inCall=false means the call is over (historical "end" lines from earlier calls are ignored; ' +
      'only an end after the latest start counts). It also updates voice-inbox.read.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          inCall: { type: 'boolean' },
          callId: { type: 'string' },
          sessionId: { type: 'string' },
          inbox: { type: 'string' },
          lastEvent: { type: 'string' },
          nextLine: { type: 'number' },
          hint: { type: 'string' },
        },
        required: ['inCall'],
      },
      render: () => [{ type: 'text', text: lastStatus.hint || '(voice_call_status)' }],
    },
    async execute() {
      // 先碰心跳：agent 只要还在调这个工具，客户端就认为它「在听」
      await touchHeartbeat(activeSid());
      const lines = await readInboxLines();
      const last = lines.length ? parseLine(lines[lines.length - 1]) : null;
      const lastType = last ? String(last.type || 'none') : 'none';
      const lastAge = last ? Math.round((Date.now() - Number(last.t || 0)) / 1000) : -1;
      const win = callWindow(lines, String(callState.callId || ''));
      // 没有 start 的旧格式（这次升级前写下的 inbox）就只信客户端状态，别拿历史 end 判死。
      const inCall = callState.active === true && !(win.startLine > 0 && win.endedAfterStart);
      await markRead(lines.length);   // 读到哪同步到哪，别再让行号滞后（2026-11-04 踩过）
      let hint;
      if (inCall) {
        hint = '通话中（已接通 ' + Math.round((Date.now() - callState.since) / 1000) + ' 秒，本通起始于第 '
          + win.startLine + ' 行）';
      } else if (callState.active !== true && lastType === 'end' && win.endedAfterStart) {
        hint = '已挂断：本通电话的 end 在 ' + lastAge + ' 秒前，改文字回复并结束回合';
      } else if (lastType === 'end') {
        hint = '未在通话：客户端也没有活跃状态（最后一条 end 属于更早的通话，' + lastAge + ' 秒前）';
      } else {
        hint = '未在通话：没有活跃状态，按已挂断处理';
      }
      lastStatus = {
        inCall,
        callId: String(callState.callId || win.startedId || ''),
        sessionId: activeSid(),
        inbox: inboxPath(activeSid()),
        lastEvent: lastType + (lastAge >= 0 ? '@' + lastAge + 's' : ''),
        nextLine: lines.length,
        hint,
      };
      return lastStatus;
    },
  }));

  // 阻塞等待新句：把「sleep + 读文件」那个手工轮询收进工具里。
  // 等待期间每 400ms 刷一次心跳（状态灯保持「聆听」），有新行/挂断/超时立刻返回，
  // 并把读到的行号写回 voice-inbox.read。
  let lastWait = { text: '' };
  ctx.effect(() => ctx.tools.register({
    name: 'voice_wait',
    description:
      'Block until the user says something new, the call ends, or the timeout expires. ' +
      'Use it instead of sleeping and re-reading voice-inbox.jsonl. Refreshes the listening ' +
      'heartbeat while waiting and updates voice-inbox.read. Returns the new inbox lines.',
    parameters: {
      type: 'object',
      properties: {
        timeoutSec: { type: 'number', description: 'How long to wait, 1-25 seconds (default 20).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                text: { type: 'string' },
                callId: { type: 'string' },
              },
            },
          },
          fromLine: { type: 'number' },
          toLine: { type: 'number' },
          sessionId: { type: 'string' },
          inbox: { type: 'string' },
          ended: { type: 'boolean' },
          timedOut: { type: 'boolean' },
        },
        required: ['ended', 'timedOut'],
      },
      render: () => [{ type: 'text', text: lastWait.text }],
    },
    async execute(args) {
      const timeout = Math.min(25, Math.max(1, Number((args && args.timeoutSec) || 20)));
      const startedAt = Date.now();
      const base = (await readInboxLines()).length;
      let lines = [];
      let timedOut = true;
      while (Date.now() - startedAt < timeout * 1000) {
        await new Promise((r) => setTimeout(r, 400));
        await touchHeartbeat(activeSid());
        lines = await readInboxLines();
        if (lines.length > base) { timedOut = false; break; }
        if (callState.active !== true && Date.now() - startedAt > 4000) { timedOut = false; break; }
      }
      const fresh = lines.slice(base).map(parseLine).filter(Boolean).map((o) => ({
        type: String(o.type || ''), text: String(o.text || ''), callId: String(o.callId || ''),
      }));
      const ended = fresh.some((o) => o.type === 'end');
      await markRead(lines.length);
      lastWait.text = fresh.length
        ? fresh.map((o) => (o.type === 'speech' ? '新句：' + o.text : '[' + o.type + ']')).join(' / ')
        : (timedOut ? '等了 ' + timeout + ' 秒没有新句' : '通话已结束，没有新句');
      return {
        sessionId: activeSid(),
        inbox: inboxPath(activeSid()),
        lines: fresh,
        fromLine: base + 1,
        toLine: lines.length,
        ended,
        timedOut,
      };
    },
  }));
}

