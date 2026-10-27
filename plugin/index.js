/** Host half of the voice-player bundle: registers the voice_say tool. */
import { execFile } from 'node:child_process';

export const inject = ['tools', 'webServer', 'systemPrompt'];

const TTS_HEALTH = 'http://127.0.0.1:18082/health';
// Qwen3-TTS (VoiceDesign) is the primary voice since 2026-10-27; the CosyVoice service
// on 18081 is kept as a fallback in the execute() chain.
const TTS_CMD = 'D:\\py-tts\\qwen-tts-server.cmd';
const TTS_CWD = 'D:\\py-tts';

async function ttsAlive() {
  try {
    const res = await fetch(TTS_HEALTH, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the TTS service detached from this process (WMI keeps it out of our job object). */
function startTts() {
  return new Promise((resolve) => {
    const ps = [
      '$startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()',
      '$startup.ShowWindow = 0',
      '$cmd = [char]34 + $env:VP_CMD + [char]34',
      '$p = ([wmiclass]"Win32_Process").Create($cmd, $env:VP_CWD, $startup)',
      '[Console]::Write($p.ReturnValue)',
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 15000, windowsHide: true, env: { ...process.env, VP_CMD: TTS_CMD, VP_CWD: TTS_CWD } },
      (err, stdout) => resolve(!err && String(stdout || '').trim() === '0'));
  });
}

async function ensureTts() {
  if (await ttsAlive()) return true;
  await startTts();
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ttsAlive()) return true;
  }
  return false;
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
          try { bubbleReport = JSON.parse(raw); } catch (e) { bubbleReport = { raw: String(raw).slice(0, 600) }; }
          return send(200, { ok: true, stored: true });
        }
        return send(200, { ok: true, report: bubbleReport });
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
            const list = await listOf();
            const arr = Array.isArray(list) ? list : (list && (list.sessions || list.items || list.list)) || [];
            const sorted = arr.slice().sort((a, b) => String((b && (b.updatedAt || b.lastActivityAt || b.createdAt)) || '').localeCompare(String((a && (a.updatedAt || a.lastActivityAt || a.createdAt)) || '')));
            const pick = sorted[0];
            sessionId = pick && (pick.id || pick.sessionId);
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
      const ok = await ensureTts();
      const body = JSON.stringify({ ok, alive: ok });
      res.statusCode = ok ? 200 : 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', Buffer.byteLength(body));
      res.end(body);
    },
  }));

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
      const alive = await ensureTts();
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
