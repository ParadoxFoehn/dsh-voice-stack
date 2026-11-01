/** Host half of the voice-player bundle: registers voice_say + owns the two local services. */
import * as services from './services.js';
import * as config from './config.js';

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
      '对话里出现 `【语音 N.Ns】http…` 标记 ＝ 用户刚发来一条语音。此时**必须先用 `voice_say` 回一条语音**（先说要点，20 秒以内），把细节留给紧随其后的文字；不要只回文字。',
      '用户只打字时这条不适用，正常文字回复即可。语音里放不下的内容，用文字补在后面。'
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
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', Buffer.byteLength(body));
      res.end(body);
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

  // The composer mic asks this before recording: "is the voice service up? if not, start it".
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-player/ensure',
    handler: async (req, res) => {
      const ok = await ensure('tts');
      const body = JSON.stringify({ ok, alive: ok });
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
      const cfg = config.save(body);
      // 只存不重启：正在跑的服务按旧档位继续，下次 start 时读新档位。
      return sendJson(res, 200, { ok: true, config: cfg, note: '重新开启服务后生效' });
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
          return sendJson(res, ok ? 200 : 503, { ok });
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

  // Last synthesized clip, kept module-level so output.render() can emit the marker and so the
  // client can poll /voice-player/last-voice for its one-shot playback.
  let lastVoice = { file: '', secs: 0, at: 0 };

  ctx.effect(() => ctx.tools.register({
    name: 'voice_say',
    description:
      'Send a voice message: the given text is spoken by the local offline TTS and appears in the chat as a playable audio message. ' +
      'Use it when the user should HEAR the reply instead of reading it.',
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
        properties: { ok: { type: 'boolean' }, chars: { type: 'number' }, file: { type: 'string' }, secs: { type: 'number' } },
        required: ['ok'],
      },
      // The rendered text IS the marker the client already knows how to draw: the bubble
      // renderer swaps it for a native <audio> in the message list — the same path the user's
      // own voice messages take (and the reason an iframe/HTTP player proved unreliable).
      render: () => [{ type: 'text', text: lastVoice.file
        ? '【语音 ' + lastVoice.secs.toFixed(1) + 's】http://127.0.0.1:18082/say-file/' + lastVoice.file
        : 'voice message failed' }],
    },
    async execute(args) {
      const text = String((args && args.text) || '').slice(0, 800);
      const alive = await ensure('tts');
      if (!alive) return { ok: false, chars: text.length, engine: 'down', file: '', secs: 0 };
      // Synthesize the WHOLE clip here (cached by text digest on the server) instead of deferring
      // to playback: a real mp3 with a known length is the only variant that reliably plays to
      // the end. Cost is paid in this turn, not in the user's ear.
      try {
        const r = await fetch('http://127.0.0.1:18082/say?text=' + encodeURIComponent(text));
        if (!r.ok) throw new Error('say ' + r.status);
        await r.arrayBuffer();
        const last = await (await fetch('http://127.0.0.1:18082/last')).json();
        const file = String((last && last.file) || '').split('/').pop();
        const secs = Number((last && last.sec) || 0);
        lastVoice = { file, secs, at: Date.now() };
        return { ok: !!file, chars: text.length, file, secs, engine: 'qwen3-tts-file' };
      } catch (e) {
        lastVoice = { file: '', secs: 0, at: 0 };
        return { ok: false, chars: text.length, file: '', secs: 0, engine: 'error', error: String((e && e.message) || e) };
      }
    },
  }));
}
