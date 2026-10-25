/** Host half of the voice-player bundle: registers the voice_say tool.
 *
 *  Configuration (cordis.patch.yml → config):
 *    stackDir   absolute path of the dsh-voice-stack checkout (e.g. "D:\\dsh-voice-stack").
 *               Only needed to start the TTS service on demand; if it is empty and the service
 *               is not running, voice_say falls back to the SAPI endpoint.
 *    ttsPort    CosyVoice2 service port           (default 18081)
 *    sapiPort   ASR/SAPI endpoint port            (default 18080)
 */
import { execFile } from 'node:child_process';

export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const stackDir = String(config.stackDir || process.env.DSH_VOICE_STACK || '');
  const ttsPort = Number(config.ttsPort) || 18081;
  const sapiPort = Number(config.sapiPort) || 18080;
  const ttsHealth = `http://127.0.0.1:${ttsPort}/health`;
  const ttsCmd = stackDir ? `${stackDir.replace(/[\\/]+$/, '')}\\tts\\tts-server.cmd` : '';

  async function ttsAlive() {
    try {
      const res = await fetch(ttsHealth, { signal: AbortSignal.timeout(1200) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Start the TTS service detached (WMI keeps it out of the client's job object). */
  function startTts() {
    return new Promise((resolve) => {
      if (!ttsCmd) return resolve(false);
      const ps = [
        '$startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()',
        '$startup.ShowWindow = 0',
        '$cmd = [char]34 + $env:VP_CMD + [char]34',
        '$p = ([wmiclass]"Win32_Process").Create($cmd, $env:VP_CWD, $startup)',
        '[Console]::Write($p.ReturnValue)',
      ].join('; ');
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 15000, windowsHide: true, env: { ...process.env, VP_CMD: ttsCmd, VP_CWD: stackDir } },
        (err, stdout) => resolve(!err && String(stdout || '').trim() === '0'));
    });
  }

  async function ensureTts() {
    if (await ttsAlive()) return true;
    if (!ttsCmd) return false;
    await startTts();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (await ttsAlive()) return true;
    }
    return false;
  }

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
        properties: { ok: { type: 'boolean' }, chars: { type: 'number' }, engine: { type: 'string' } },
        required: ['ok'],
      },
      render: (args) => [{ type: 'text', text: 'voice message: ' + String((args && args.text) || '').slice(0, 600) }],
    },
    async execute(args) {
      const text = String((args && args.text) || '').slice(0, 800);
      // Services never start by themselves: the first utterance brings TTS up, then it stays
      // resident until it is closed by hand or evicted for VRAM (the model widget owns that).
      await ensureTts();
      const engines = [
        { name: 'cosyvoice2', url: `http://127.0.0.1:${ttsPort}/say?text=` + encodeURIComponent(text) },
        { name: 'sapi', url: `http://127.0.0.1:${sapiPort}/tts?text=` + encodeURIComponent(text) },
      ];
      let engine = 'none';
      for (const e of engines) {
        try {
          const res = await fetch(e.url, { method: 'GET' });
          if (res && res.ok) { engine = e.name; break; }
        } catch {
          // try the next endpoint
        }
      }
      return { ok: engine !== 'none', chars: text.length, engine };
    },
  }));
}
