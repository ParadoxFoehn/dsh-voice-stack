window.__ModuleLoader__.load({
  id: '@local/dsh-voice-player',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ------------------------------------------------------------------ voice input
    // Record with the mic, upload the raw audio to the local TTS service, then put a voice
    // marker into the composer. The marker keeps the audio URL (so it can be played back and
    // re-transcribed) and, when the ASR service is up, the transcript as a hint.
    const UPLOAD = 'http://127.0.0.1:18082/upload?ext=webm&transcribe=0';
const HEALTH = 'http://127.0.0.1:18082/health';
const ENSURE = '/voice-player/ensure';
    const PLAY = 'http://127.0.0.1:18082';

    // ---- 可调参数（想改就改这里，改完重启客户端生效）-----------------------------
    // 待发托盘最多攒几条。满了以后新录音会被拒绝并提示，避免一次塞太多条。
    const MAX_DRAFTS = 3;
    // 单条录音的硬上限（秒）。到点自动停止录音。
    // 依据：0.6B 快道实测 22.2 秒可完整正确转写；模型音频位置上限 max_source_positions=1500
    // ≈ 60 秒，是硬边界但长句断句/标点会变差，所以取 30 秒作为安全上限。
    const MAX_SECONDS = 30;
    // 录到多少秒开始提醒"有点长了"（不打断）。
    const WARN_SECONDS = 20;
    // ---------------------------------------------------------------------------

    function insertComposerText(text) {
      const el = document.querySelector('textarea') ||
        document.querySelector('[contenteditable="true"]');
      if (!el) return false;
      try {
        el.focus();
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, (el.value ? el.value + '\n' : '') + text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        document.execCommand('insertText', false, text);
        return true;
      } catch (e) {
        return false;
      }
    }

    // ------------------------------------------------------------------ bubbles v4
    // Narrow rewrite: a text node that is ENTIRELY the marker becomes a bubble, and its host
    // element is replaced only when it holds nothing else (own textContent === marker). A
    // container that also holds the composer or another line can therefore never be touched —
    // this is the fix for the 2026-10-27 incident where a block-level sweep removed the mic.
    const FULL_MARK = /^【语音\s*([\d.]+)s】\s*(https?:\/\/\S+?)(?:转写[：:]([\s\S]*))?$/;
    function waveIcon() {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.6');
      svg.setAttribute('stroke-linecap', 'round');
      for (const d of ['M2 6v4', 'M5 4v8', 'M8 2.5v11', 'M11 4v8', 'M14 6v4']) {
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
      }
      return svg;
    }
    function makeVoiceBubble(secs, url, transcript) {
      const box = document.createElement('div');
      box.setAttribute('data-voice-bubble', '1');
      box.style.cssText = 'display:inline-flex;flex-direction:column;gap:5px;padding:8px 12px;'
        + 'border-radius:14px;border:1px solid rgba(128,128,128,.30);background:rgba(127,179,232,.12);max-width:420px';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;opacity:.72;letter-spacing:.06em';
      head.appendChild(waveIcon());
      const label = document.createElement('span');
      label.textContent = '语音 · ' + secs + ' 秒';
      head.appendChild(label);
      box.appendChild(head);
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = url;
      audio.style.cssText = 'height:32px;width:300px;max-width:100%';
      box.appendChild(audio);
      const tr = (transcript || '').trim();
      if (tr) {
        const line = document.createElement('div');
        line.textContent = tr;
        line.style.cssText = 'font-size:12.5px;line-height:1.6;opacity:.85;white-space:pre-wrap';
        box.appendChild(line);
      }
      return box;
    }
    // One text node may carry SEVERAL markers (two voice messages sent back to back land in
    // the same message). Accept the node only when it is nothing but markers, then draw one
    // bubble per marker — this is the "two recorded, one shown" bug of 2026-10-27.
    function parseMarkers(t) {
      const re = /【语音\s*([\d.]+)s】\s*(https?:\/\/\S+?)(?:转写[：:]([\s\S]*?))?(?=【语音|$)/g;
      const parts = [];
      let joined = '';
      let m;
      while ((m = re.exec(t)) !== null) {
        parts.push({ secs: m[1], url: m[2], transcript: (m[3] || '').trim() });
        joined += m[0];
      }
      return parts.length > 0 && joined === t ? parts : null;
    }
    // Loose match: the message row may carry decoration the marker does not (a timestamp, a
    // copy hint). Accept it when everything OUTSIDE the markers is short and marker-free.
    function matchMarkers(t) {
      const strict = parseMarkers(t);
      if (strict) return { parts: strict, loose: false };
      const re = /【语音\s*([\d.]+)s】\s*(https?:\/\/\S+?)(?=【语音|$|[\s，。])/g;
      const parts = [];
      let m;
      let rest = t;
      while ((m = re.exec(t)) !== null) {
        parts.push({ secs: m[1], url: m[2], transcript: '' });
        rest = rest.replace(m[0], '');
      }
      if (!parts.length) return null;
      const residue = rest.replace(/\s+/g, '');
      if (residue.length > 24 || residue.indexOf('【') >= 0) return null;
      return { parts, loose: true };
    }
    // ------------------------------------------------------------------ transient one-shot player
    // The message list unmounts rows that scroll away, so an iframe inside a message cannot keep
    // playing (it reloads and restarts). Playback therefore lives HERE, in the plugin: poll the
    // host for the current spoken clip, mount ONE detached <audio>, play it once, remove it on
    // `ended`, and REMEMBER that file is done. The decision is "has this clip been played to the
    // end?", not "is it recent" — a clock says nothing about what the user actually heard.
    const VOICE_PLAYED_KEY = 'dsh-voice-played';
    function loadPlayed() {
      try {
        const raw = window.localStorage.getItem(VOICE_PLAYED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr : []);
      } catch (e) { return new Set(); }
    }
    function savePlayed(set) {
      try {
        const arr = Array.from(set).slice(-200);   // bounded: the mark is only for recent clips
        window.localStorage.setItem(VOICE_PLAYED_KEY, JSON.stringify(arr));
      } catch (e) { /* ignore */ }
    }
    function installTransientVoicePlayer() {
      if (typeof document === 'undefined' || window.__voiceTransientOn) return;
      window.__voiceTransientOn = true;
      const played = loadPlayed();
      let el = null;
      const drop = () => {
        try { if (el) { el.pause(); el.remove(); } } catch (e) { /* ignore */ }
        el = null;
      };
      const tick = async () => {
        try {
          const r = await fetch('/voice-player/last-voice', { cache: 'no-store' });
          if (!r.ok) return;
          const d = await r.json();
          if (!d || !d.file) return;
          if (played.has(d.file)) return;                              // already heard to the end
          if (el && el.getAttribute('data-file') === d.file) return;    // already mounted
          drop();
          el = document.createElement('audio');
          el.setAttribute('data-voice-transient', '1');
          el.setAttribute('data-file', d.file);
          el.preload = 'auto';
          el.src = PLAY + '/say-file/' + d.file;
          el.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
          document.body.appendChild(el);
          // `ended` is the only moment we can say it was heard; an error must NOT mark the clip,
          // otherwise one temporary failure would silence it forever.
          el.addEventListener('ended', () => {
            played.add(d.file);
            savePlayed(played);
            drop();
          });
          el.addEventListener('error', drop);
          const p = el.play();
          if (p && p.catch) p.catch(() => { /* policy refused: stay silent, the card still plays */ });
        } catch (e) { /* ignore */ }
      };
      setInterval(tick, 1200);
      tick();
    }
    function installVoiceBubblesV4() {
      if (typeof document === 'undefined' || window.__voiceBubblesOn) return;
      window.__voiceBubblesOn = true;
      // Do NOT rely on one text node: the chat renderer may split the message around the URLs
      // (linkified spans), so with three markers no single node carries the whole text and the
      // v4 text-node scan found nothing (reported 2026-10-27 23:25). Instead find the DEEPEST
      // element whose whole textContent parses as markers — deepest means no child element
      // parses as well, so we never grab a container that also holds other content.
      const roots = () => {
        const out = [document.body];
        try {
          for (const el of document.body.querySelectorAll('*')) {
            if (el.shadowRoot) { out.push(el.shadowRoot); }
          }
        } catch (e) { /* ignore */ }
        return out.filter(Boolean);
      };
      const guardsOk = (el) => {
        if (!el || !el.isConnected) return false;
        if (el.closest('textarea, input, [contenteditable="true"], [data-voice-bubble]')) return false;
        if (el.isContentEditable) return false;
        if (el.querySelector('textarea, input, [contenteditable="true"], button, audio, video, img, svg')) return false;
        return true;
      };
      const rewrite = () => {
        let count = 0;
        const diag = [];
        try {
          for (const root of roots()) {
            const hits = [];
            for (const el of root.querySelectorAll('*')) {
              const t = (el.textContent || '').trim();
              if (t.indexOf('【语音') < 0) continue;
              const m = t.indexOf('【语音') === 0 ? matchMarkers(t) : null;
              if (diag.length < 8) {
                diag.push({
                  tag: el.tagName, cls: String(el.className || '').slice(0, 24),
                  len: t.length, children: el.children.length, at: t.indexOf('【语音'),
                  guard: guardsOk(el), parsed: !!m, loose: !!(m && m.loose),
                  head: t.slice(0, 46),
                });
              }
              if (t.length < 8 || t.length > 900) continue;
              if (t.indexOf('【语音') !== 0) continue;
              if (!guardsOk(el)) continue;
              if (!m) continue;
              hits.push({ el, parts: m.parts });
            }
            for (const h of hits) {
              // Keep only the deepest hit: skip if a descendant is also a hit.
              if (hits.some((o) => o !== h && h.el.contains(o.el))) continue;
              try {
                let out;
                if (h.parts.length === 1) out = makeVoiceBubble(h.parts[0].secs, h.parts[0].url, h.parts[0].transcript);
                else {
                  out = document.createElement('div');
                  out.setAttribute('data-voice-bubble', '1');
                  out.style.cssText = 'display:inline-flex;flex-direction:column;gap:6px';
                  for (const p of h.parts) out.appendChild(makeVoiceBubble(p.secs, p.url, p.transcript));
                }
                h.el.replaceWith(out);
                count += 1;
              } catch (e) {}
            }
          }
        } catch (e) { /* never break the page */ }
        // Report what the scan saw to the host, so it can be read over HTTP instead of devtools.
        try {
          let bodyHits = null;
          if (count === 0) {
            try {
              const inner = document.body.innerText || '';
              bodyHits = (inner.match(/【语音/g) || []).length;
            } catch (e) { bodyHits = -1; }
          }
          const payload = JSON.stringify({ count, diag, bodyHits, at: Date.now() });
          if (payload !== window.__voiceLastDiag) {
            window.__voiceLastDiag = payload;
            if (diag.length || bodyHits) {
              fetch('/voice-player/bubble-report?data=' + encodeURIComponent(payload), { cache: 'no-store' }).catch(() => {});
            }
          }
        } catch (e) { /* ignore */ }
        window.__voiceBubbleCount = count;
        return count;
      };
      rewrite();
      let queued = false;
      const mo = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        setTimeout(() => { queued = false; rewrite(); }, 200);
      });
      try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
      setInterval(rewrite, 4000);   // safety net for re-mounted / virtualised lists
    }

    // Which session this composer belongs to. The slot's props carry `sessionId` (string) — found
    // by dumping the props shape (2026-10-28 00:5x). Without it the host had to guess "newest
    // session", which sent a voice recorded in one conversation into another one.
    let CURRENT_SESSION = '';

    async function postToSession(line) {
      // Official admission, no composer involved: GET with a query keeps us out of body
      // parsing, which is what 500'd on the first attempt (2026-10-27 21:59). sessionId is
      // ALWAYS sent — no id, no direct delivery (the caller then falls back to the composer,
      // which is always bound to the right session).
      if (!CURRENT_SESSION) return false;
      try {
        const q = '/voice-player/probe-send?text=' + encodeURIComponent(line)
          + '&sessionId=' + encodeURIComponent(CURRENT_SESSION);
        const r = await fetch(q, { cache: 'no-store' });
        if (!r.ok) {
          try { const t = await r.text(); console.warn('[voice] probe-send', r.status, t.slice(0, 220)); } catch (e) {}
          return false;
        }
        return true;
      } catch (e) { return false; }
    }

    function sendWithoutFlash(line) {
      // Host route first: it posts the message straight into the session (no composer).
      try {
        postToSession(line).then((ok) => {
          if (!ok) { try { insertComposerText(line); setState('请按回车发送'); } catch (e) {} }
        });
        return true;
      } catch (e) { /* fall through */ }
      try {
        // Second line of defence: put the marker in the composer and let the user press Enter.
        // A synthetic Enter is attempted too, but never a guessed send button — pressing the
        // wrong control is how a message disappears. The composer always belongs to THIS
        // conversation, so this path can never deliver to the wrong session.
        const el = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
        let prev = null;
        if (el) { prev = el.style.opacity; el.style.opacity = '0'; }
        if (!insertComposerText(line)) return false;
        autoSendComposer();                       // synthetic Enter only, never a guessed button
        setTimeout(() => {
          try { if (el && prev !== null) el.style.opacity = prev; } catch (e) { /* ignore */ }
        }, 500);
        return true;
      } catch (e) {
        try { console.warn('[voice] send failed', e); } catch (x) {}
        return false;
      }
    }

    function autoSendComposer() {
      try {
        const el = document.querySelector('textarea') ||
          document.querySelector('[contenteditable="true"]');
        if (!el) return false;
        el.focus();
        const ev = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', ev));
        el.dispatchEvent(new KeyboardEvent('keyup', ev));
        return true;
      } catch (e) { return false; }
    }

    function VoiceInput(props) {
      const [rec, setRec] = React.useState(null);
      const [state, setState] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      // A floating DRAFT TRAY, not a countdown (user's call, 2026-10-27 23:3x). The countdown
      // only existed to keep the marker out of the composer; the host route removed that need,
      // so recordings just collect here: preview each, drop one, then send them together as a
      // single message with one marker per voice (the renderer draws one bubble per marker).
      const [drafts, setDrafts] = React.useState([]);
      const draftsRef = React.useRef([]);
      React.useEffect(() => { draftsRef.current = drafts; }, [drafts]);
      const chunksRef = React.useRef([]);
      const warnRef = React.useRef(null);
      const busyRef = React.useRef(false);
      // The composer slot carries the session id; keep it in module scope so the
      // delivery route can address THIS conversation instead of guessing.
      // SAFE DEGRADATION (for people who just downloaded the plugin): if the harness in front of
      // us does not expose `sessionId` in the slot props, direct delivery is disabled and the
      // marker goes to the composer instead — the user presses Enter IN THEIR OWN conversation,
      // so a wrong session is impossible. Better a clunky path than a silent misdelivery.
      React.useEffect(() => {
        if (props && props.sessionId) { CURRENT_SESSION = String(props.sessionId); return; }
        CURRENT_SESSION = '';
        if (!window.__voiceNoSessionWarned) {
          window.__voiceNoSessionWarned = true;
          setState('此环境未提供会话标识，语音将放进输入框（安全降级）');
          setTimeout(() => setState(''), 6000);
        }
      });
      React.useEffect(() => { installVoiceBubblesV4(); installTransientVoicePlayer(); }, []);
      React.useEffect(() => {
        const onErr = (ev) => {
          try {
            const msg = (ev && (ev.message || (ev.error && ev.error.message))) || 'unknown error';
            // Benign browser noise, not a voice failure: ResizeObserver fires this when a resize
            // triggers another resize inside the same frame; the spec says to ignore it. Showing
            // it as "语音出错" was our bug (reported 2026-10-28 02:5x).
            if (/ResizeObserver loop/i.test(msg)) return;
            if (/Script error\.?$/i.test(msg)) return;
            if (window.__voiceErrShown === msg) return;
            window.__voiceErrShown = msg;
            setState('语音出错：' + String(msg).slice(0, 70));
          } catch (e) { /* ignore */ }
        };
        window.addEventListener('error', onErr);
        window.addEventListener('unhandledrejection', onErr);
        return () => {
          window.removeEventListener('error', onErr);
          window.removeEventListener('unhandledrejection', onErr);
        };
      }, []);
      const dropDraft = (key) => setDrafts((list) => list.filter((d) => d.key !== key));
      const clearDrafts = () => setDrafts([]);
      const sendDrafts = () => {
        const list = draftsRef.current;
        if (!list.length) return;
        // One message, several markers: the renderer turns each marker into its own bubble.
        const text = list.map((d) => d.line).join('');
        setDrafts([]);
        draftsRef.current = [];
        let ok = false;
        try { ok = sendWithoutFlash(text); } catch (e) { ok = false; }
        setState(ok ? '已发送 ' + list.length + ' 条语音' : '已放进输入框，按回车发送');
        setTimeout(() => setState(''), 2500);
      };

      const stop = () => {
        if (warnRef.current) { clearInterval(warnRef.current); warnRef.current = null; }
        if (rec && rec.state === 'recording') rec.stop();
      };

      const start = async () => {
        // One flow at a time: while the service is starting, further clicks are ignored
        // (otherwise a second chain would fight over the microphone).
        if (busyRef.current) return;
        if (rec && rec.state === 'recording') { stop(); return; }
        // Tray cap (MAX_DRAFTS at the top of this file): refuse instead of silently dropping.
        // Keep the notice to ONE short line — a long sentence wraps and the composer row jumps.
        if (draftsRef.current.length >= MAX_DRAFTS) {
          setState('待发已满 ' + MAX_DRAFTS + ' 条');
          setTimeout(() => setState(''), 3000);
          return;
        }
        busyRef.current = true;
        setBusy(true);
        // Before recording: is the voice service up? If not, ask the host half to start it.
        setState('检查语音服务…');
        try {
          let up = false;
          try {
            const r = await fetch(HEALTH, { signal: AbortSignal.timeout(1200) });
            up = r.ok;
          } catch (e) { up = false; }
          if (!up) {
            setState('语音服务未启动，正在自动开启…');
            try { await fetch(ENSURE, { method: 'POST' }); } catch (e) { /* host may be old */ }
            const waitStart = Date.now();
            for (let i = 0; i < 60; i++) {
              await new Promise((r2) => setTimeout(r2, 500));
              const waited = Math.round((Date.now() - waitStart) / 1000);
              setState('正在自动开启语音服务… ' + waited + ' 秒');
              try { if ((await fetch(HEALTH, { signal: AbortSignal.timeout(1200) })).ok) { up = true; break; } } catch (e) { /* keep waiting */ }
            }
          }
          if (!up) { setState('语音服务启动失败，请稍后再试'); setTimeout(() => setState(''), 5000); busyRef.current = false; setBusy(false); return; }
        } catch (e) { /* fall through to recording anyway */ } finally {
          // recording still needs a moment; the flag is released once the recorder exists
        }
        setState('录音中…点一下结束');
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
          chunksRef.current = [];
          // Reminder: long dictation gets harder to use (and the upload grows).
          const startedAt = Date.now();
          if (warnRef.current) clearInterval(warnRef.current);
          warnRef.current = setInterval(() => {
            const secs = Math.round((Date.now() - startedAt) / 1000);
            if (secs >= MAX_SECONDS) {
              // Hard stop at MAX_SECONDS: beyond ~30 s a single clip starts to hurt the small
              // ASR model's punctuation and the reply cost. Finishing here is friendlier than
              // uploading something the ear cannot follow. One short line: the row must not wrap.
              setState('到 ' + MAX_SECONDS + ' 秒，自动结束');
              if (mr.state === 'recording') mr.stop();
            } else if (secs >= WARN_SECONDS) {
              setState('录音中… ' + secs + 's · 偏长了');
            } else {
              setState('录音中… ' + secs + 's');
            }
          }, 1000);
          mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
          mr.onstop = async () => {
            if (warnRef.current) { clearInterval(warnRef.current); warnRef.current = null; }
            stream.getTracks().forEach((t) => t.stop());
            setRec(null);
            const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
            if (blob.size < 1000) { setState('太短了，再说一次'); return; }
            setState('上传中…');
            try {
              const res = await fetch(UPLOAD, { method: 'POST', body: await blob.arrayBuffer(),
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
              const data = await res.json();
              const url = PLAY + (data.url || '');
              const secs = data.seconds ? data.seconds.toFixed(1) : '0.0';
              const line = '【语音 ' + secs + 's】' + url + (data.transcript ? '\n转写：' + data.transcript : '');
              // Into the tray: nothing is sent until the user presses 发送, so recording twice
              // in a row can no longer overwrite the first one.
              const item = { key: String(Date.now()) + Math.random().toString(16).slice(2, 6), secs, url, line };
              setDrafts((list) => list.concat([item]));
              setState('录好了 · 待发 ' + (draftsRef.current.length + 1) + ' 条');
            } catch (e) {
              setState('上传失败：' + (e && e.message ? e.message : 'endpoint down'));
              setTimeout(() => setState(''), 6000);
            }
          };
          mr.start();
          setRec(mr);
          busyRef.current = false;
          setBusy(false);
          setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, 60000);
        } catch (e) {
          busyRef.current = false;
          setBusy(false);
          setState('没有麦克风权限');
        }
      };

      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', fontSize: 11.5,
                 color: 'inherit', opacity: 0.9 },
      },
        h('button', {
          onClick: () => (rec ? stop() : start()),
          disabled: busy && !rec,
          title: (rec ? '结束录音' : '录一段语音发给小肥鱼（发的是语音本身）') + ' · v2 气泡',
          'aria-label': 'voice message',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
                   borderRadius: '50%', cursor: 'pointer', padding: 0,
                   color: 'inherit', background: rec ? 'rgba(192,57,43,.18)' : 'transparent',
                   opacity: busy && !rec ? 0.45 : 1,
                   border: '1px solid rgba(128,128,128,.45)' },
        },
          rec ? h('span', { style: { fontSize: 11, lineHeight: 1 } }, '■') : h('svg', {
            width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
            'stroke-width': 1.6, 'stroke-linecap': 'round',
          },
            h('path', { d: 'M2 6v4' }),
            h('path', { d: 'M5 4v8' }),
            h('path', { d: 'M8 2.5v11' }),
            h('path', { d: 'M11 4v8' }),
            h('path', { d: 'M14 6v4' })
          )),
        state ? h('span', { style: { opacity: 0.65 } }, state) : null,
        drafts.length ? h('div', {
          'data-voice-dock': '1',
          // Theme-neutral: translucent grey + inherited text colour, so it looks native in
          // both the light and the dark client skin instead of imposing a dark panel.
          style: { position: 'fixed', right: 16, bottom: 82, zIndex: 2147482000, display: 'flex',
                   flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 14,
                   minWidth: 268, maxHeight: '46vh', overflowY: 'auto', color: 'inherit',
                   background: 'rgba(127,127,127,.10)', border: '1px solid rgba(128,128,128,.32)',
                   boxShadow: '0 8px 22px rgba(0,0,0,.10)', fontSize: 12 },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              fontSize: 11, opacity: 0.8, letterSpacing: '.06em' } },
            h('span', null, '语音待发 · ' + drafts.length + '/' + MAX_DRAFTS + ' 条'),
            h('button', {
              onClick: clearDrafts,
              style: { background: 'transparent', border: 0, color: 'inherit', opacity: 0.7,
                       cursor: 'pointer', fontSize: 11 },
            }, '清空')
          ),
          drafts.map((d) => h('div', { key: d.key, style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { fontSize: 10.5, opacity: 0.65, whiteSpace: 'nowrap', minWidth: 32 } }, d.secs + 's'),
            h('audio', { controls: true, src: d.url, preload: 'none',
                         style: { height: 28, flex: 1, minWidth: 160 } }),
            h('button', {
              onClick: () => dropDraft(d.key),
              title: '撤回这条',
              style: { background: 'transparent', border: 0, color: 'inherit', opacity: 0.65,
                       cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' },
            }, '×')
          )),
          h('button', {
            onClick: sendDrafts,
            // Same blue as the client's own send button, so the tray reads as part of the app.
            style: { marginTop: 2, padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
                     background: 'rgba(59,130,246,.95)', color: '#fff',
                     border: '1px solid transparent', fontSize: 12 },
          }, '发送 ' + drafts.length + ' 条'),
          h('div', { style: { fontSize: 10, opacity: 0.5, lineHeight: 1.4, letterSpacing: '.02em' } },
            MAX_DRAFTS + ' 条 · ' + MAX_SECONDS + 's · 改法见 client.js')
        ) : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Sits in the composer's LEFT tool cluster, right after the sticker/emoji button
        // (meme-picker is order 5 there) — a plain multi-occupant list slot, so nothing
        // existing is replaced.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'voice-input', order: 6,
          label: () => '语音消息',
        }, VoiceInput));
      },
    };
  },
});
