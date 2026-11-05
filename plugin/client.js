window.__ModuleLoader__.load({
  id: '@local/dsh-voice-player',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ------------------------------------------------------------------ voice input
    // Record with the mic, upload the raw audio to the local TTS service, then put a voice
    // marker into the composer. The marker keeps the audio URL (so it can be played back and
    // re-transcribed) and, when the ASR service is up, the transcript as a hint.
    const UPLOAD = '/voice-player/upload';
const HEALTH = 'http://127.0.0.1:18082/health';
const ENSURE = '/voice-player/ensure';
    const PLAY = 'http://127.0.0.1:18082';

// 设置面板的兜底档位：宿主端点还没就绪（例如只热更了客户端半边）时，
// 面板也要能打开并显示合理默认值，而不是点了没反应（2026-10-30 实测踩到）。
const DEFAULT_CFG = {
  asr: { mode: 'idle', idleSec: 120 },
  tts: { mode: 'resident', idleSec: 240, device: 'gpu' },
};

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

    // 与回收站插件（safe-delete-guard）同一套取色逻辑：先读客户端主题令牌，读不到再按
// document.body 的底色判断明暗。区别是**底一律纯色**——白皮肤纯白、黑皮肤纯黑（用户 2026-10-30 定），
// 不再用半透明灰，免得和背景混在一起发脏。
function resolvePalette() {
  let cs = null;
  try { cs = getComputedStyle(document.documentElement); } catch { cs = null; }
  const pick = (name) => {
    try { return ((cs && cs.getPropertyValue(name)) || '').trim(); } catch { return ''; }
  };
  // 只认不透明的颜色：客户端很多容器是 rgba(0,0,0,0)，把 RGB 直接拿来算会把"浅色"误判成"黑色"。
  const parse = (c) => {
    if (!c) return null;
    let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/.exec(c);
    if (m) {
      const a = m[4] === undefined ? 1 : Number(m[4]);
      if (a === 0) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
    if (m) {
      return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    }
    return null;
  };
  const luma = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;

  let dark = null;
  // ① 主题令牌优先：切换皮肤时客户端会改这几个变量，最可靠
  const token = parse(pick('--dsw-alias-bg-layer-1')) || parse(pick('--dsw-alias-bg-layer-2')) ||
                parse(pick('--dsw-alias-bg-base'));
  if (token) dark = luma(token) < 0.5;
  // ② 往上找第一个不透明的实际背景色
  if (dark === null) {
    let el = document.body;
    while (el && dark === null) {
      try {
        const bg = parse(getComputedStyle(el).backgroundColor);
        if (bg) dark = luma(bg) < 0.5;
      } catch { /* ignore */ }
      el = el.parentElement;
    }
  }
  // ③ 系统偏好兜底
  if (dark === null) {
    try { dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch { dark = false; }
  }

  return {
    dark,
    bg: dark ? '#000000' : '#ffffff',
    tint: dark ? 'rgba(255,255,255,.06)' : 'rgba(47,111,237,.06)',
    text: pick('--dsw-alias-label-primary') || (dark ? '#f2f2f2' : '#15181d'),
    sub: pick('--dsw-alias-label-tertiary') || (dark ? 'rgba(242,242,242,.62)' : 'rgba(21,24,29,.55)'),
    line: pick('--dsw-alias-border-l1') || (dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)'),
    brand: pick('--dsw-alias-brand-primary') || (dark ? '#79a2f5' : '#2f6fed'),
  };
}

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
      // 气泡卡跟着客户端明暗走：白皮肤白底黑字、黑皮肤黑底白字（用户 2026-10-30 定）。
      // 原来是半透明蓝 rgba(127,179,232,.12)，在深色皮肤下会发灰、和背景糊在一起。
      const th = resolvePalette();
      const box = document.createElement('div');
      box.setAttribute('data-voice-bubble', '1');
      box.style.cssText = 'display:inline-flex;flex-direction:column;gap:5px;padding:8px 12px;'
        + 'border-radius:14px;border:1px solid ' + th.line + ';background:' + th.bg + ';'
        + 'color:' + th.text + ';max-width:420px';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;opacity:.72;letter-spacing:.06em';
      head.appendChild(waveIcon());
      const label = document.createElement('span');
      label.textContent = '语音 · ' + secs + ' 秒';
      head.appendChild(label);
      box.appendChild(head);
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';   // 预载元数据：否则时长一直显示 0:00/0:00，像坏了
      // 走同源代理：直接指向 18082 会被页面 CSP 拦掉（表现为点了没反应）
      try {
        const fname = String(url || '').split('?')[0].split('/').pop();
        audio.src = fname ? ('/voice-player/audio?file=' + encodeURIComponent(fname)) : url;
      } catch { audio.src = url; }
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
      const re = /【语音\s*([\d.]+)s】\s*(https?:\/\/\S+?)\s*(?:转写[：:]([\s\S]*?))?(?=【语音|$)/g;
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
      const re = /【语音\s*([\d.]+)s】\s*(https?:\/\/\S+?)(?:\s*转写[：:][\s\S]*?)?(?=【语音|$|[\s，。])/g;
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
      const queue = [];          // 排队的语音：{ file, id }，一条没播完，后一条不许盖上来（2026-11-04）
      // 被打断的片段：轮询每 1.2 秒把「最近说过的话」捡回来，如果不记住就又会从头播一遍
      //（用户 2026-11-05 实测：点打断后当组音频重头念了）。记在这里，tick 直接跳过。
      const suppressed = new Set();
      let el = null;
      let busy = false;
      let currentVoiceId = '';   // 正在播的那条语音的 id：取后续分组时带上，防止串到新消息
      const currentFile = () => (el ? el.getAttribute('data-file') : '');
      const drop = () => {
        try { if (el) { el.pause(); el.remove(); } } catch (e) { /* ignore */ }
        el = null;
        busy = false;
      };
      const finish = (file) => {
        if (file) { played.add(file); savePlayed(played); }
        drop();
        setTimeout(pump, 60);
      };
      // 渐进播放：这一组播完去取下一组；后台还在合成会回 pending，等 400ms 再问。
      // 带上 voice id——agent 中途又发一条时，宿主只服务同一条语音的组，老链不会串味。
      const nextGroup = async () => {
        try {
          const q = currentVoiceId ? ('?voice=' + encodeURIComponent(currentVoiceId)) : '';
          const r = await fetch('/voice-player/next-group' + q, { cache: 'no-store' });
          const g = await r.json();
          if (g && g.file) return g.file;
          if (g && g.pending) return '__pending__';
        } catch { /* ignore */ }
        return '';
      };
      const playFile = (file, voiceId) => {
        currentVoiceId = voiceId || '';
        el = document.createElement('audio');
        el.setAttribute('data-voice-transient', '1');
        el.setAttribute('data-file', file);
        el.preload = 'auto';
        el.src = PLAY + '/say-file/' + file;
        el.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
        document.body.appendChild(el);
        // `ended` is the only moment we can say it was heard; an error must NOT mark the clip,
        // otherwise one temporary failure would silence it forever.
        el.addEventListener('ended', async () => {
          for (;;) {
            const g = await nextGroup();
            if (g === '__pending__') { await new Promise((r) => setTimeout(r, 400)); continue; }
            if (g) {
              played.add(file);
              savePlayed(played);
              el.setAttribute('data-file', g);
              el.src = PLAY + '/say-file/' + g;
              const p = el.play();
              if (p && p.catch) p.catch(() => { /* 等用户点 */ });
              return;
            }
            break;
          }
          finish(file);
        });
        el.addEventListener('error', () => finish(file));
        const p = el.play();
        if (p && p.catch) p.catch(() => { /* policy refused: stay silent, the card still plays */ });
      };
      function pump() {
        if (busy) return;
        while (queue.length) {
          const item = queue.shift();
          if (!item || !item.file || played.has(item.file)) continue;
          busy = true;
          playFile(item.file, item.id);
          return;
        }
      }
      // 打断时连队列一起清：用户要它闭嘴，不是排着队继续念。
      // 关键：被打断的片段必须记进 suppressed，否则下一次轮询会当它是「没播过」再放一遍
      //（2026-11-05 实测＝打断后重头播放）。
      window.__voiceTransientClear = () => {
        try {
          const cur = currentFile();
          if (cur) suppressed.add(cur);
          for (const q of queue) { if (q && q.file) suppressed.add(q.file); }
          if (suppressed.size > 60) {
            const keep = Array.from(suppressed).slice(-60);
            suppressed.clear();
            for (const f of keep) suppressed.add(f);
          }
          queue.length = 0;
          drop();
        } catch (e) { /* ignore */ }
      };
      const tick = async () => {
        try {
          const r = await fetch('/voice-player/last-voice', { cache: 'no-store' });
          if (!r.ok) return;
          const d = await r.json();
          if (!d) return;
          // history 里是最近几条（正序）：挨得近的两条也不会漏，全部按顺序入队
          const list = Array.isArray(d.history) && d.history.length
            ? d.history
            : (d.file ? [{ id: d.id || '', file: d.file }] : []);
          let added = false;
          for (const item of list) {
            if (!item || !item.file) continue;
            if (played.has(item.file)) continue;             // 已经听过
            if (suppressed.has(item.file)) continue;         // 被用户打断过：别再自动播
            if (currentFile() === item.file) continue;       // 正在播
            if (queue.some((q) => q.file === item.file)) continue;   // 已排队
            queue.push({ file: item.file, id: item.id || '' });
            added = true;
          }
          if (added) pump();
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
        // 只扫「消息列表容器」：侧栏（会话标题）不在其中，标题里的【语音…】就不会被替换。
        const out = [];
        try {
          for (const sel of ['[class*="scrollBody"]', '[class*="messageList"]', '[class*="messages"]']) {
            document.querySelectorAll(sel).forEach((el) => out.push(el));
          }
        } catch (e) { /* ignore */ }
        if (!out.length) {
          try {
            for (const el of document.body.querySelectorAll('*')) {
              if (el.shadowRoot) out.push(el.shadowRoot);
            }
          } catch (e) { /* ignore */ }
          out.push(document.body);
        }
        return out.filter(Boolean);
      };
      const guardsOk = (el) => {
        if (!el || !el.isConnected) return false;
        // 侧栏/导航区（会话标题等）不属于消息正文：标题里的【语音…】不能变成播放器
        if (el.closest('aside, nav, [role="navigation"], [data-sidebar]')) return false;
        if (el.closest('textarea, input, [contenteditable="true"], [data-voice-bubble]')) return false;
        if (el.isContentEditable) return false;
        // 只排除真正的交互控件；消息行自带的图标（svg/img）不该阻止渲染
        if (el.querySelector('textarea, input, [contenteditable="true"], button, audio, video')) return false;
        return true;
      };
      const innerReport = () => {
        const out = [];
        try {
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = w.nextNode())) {
            const v = n.nodeValue || '';
            if (v.indexOf('【语音') < 0) continue;
            const parent = n.parentElement;
            out.push({
              text: v.slice(0, 60),
              parentTag: parent ? parent.tagName : '',
              parentClass: parent ? String(parent.className || '').slice(0, 30) : '',
              childElements: parent ? parent.children.length : -1,
              inLink: !!(parent && parent.closest('a')),
              len: (parent && parent.textContent ? parent.textContent.trim().length : -1),
              guard: parent ? guardsOk(parent) : false,
              depth: (() => { let d = 0; let el = parent; while (el && d < 12) { d += 1; el = el.parentElement; } return d; })(),
              nearestBtn: (() => { let d = 0; let el = parent; while (el && d < 8) { if (el.querySelector && el.querySelector('button')) return d; d += 1; el = el.parentElement; } return -1; })(),
            });
          }
        } catch { /* ignore */ }
        // 优先短文本（真标记通常在短节点里），长文本（讨论/代码引用）只保留少量
        out.sort((a, b) => a.len - b.len);
        return out.slice(0, 20);
      };

      window.__voiceDebug = () => {
        const out = [];
        try {
          for (const el of document.body.querySelectorAll('*')) {
            const t = (el.textContent || '').trim();
            if (t.indexOf('【语音') !== 0) continue;
            const m = matchMarkers(t);
            out.push({
              tag: el.tagName, cls: String(el.className || '').slice(0, 24),
              len: t.length, kids: el.children.length,
              guard: guardsOk(el), parsed: !!m, loose: !!(m && m.loose),
              sample: t.slice(0, 60),
            });
          }
        } catch (e) { out.push({ error: String(e) }); }
        return out;
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
              if (diag.length < 40) {
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
          const payload = JSON.stringify({ count, diag, bodyHits, inner: innerReport(), at: Date.now() });
          if (payload !== window.__voiceLastDiag) {
            window.__voiceLastDiag = payload;
            if (diag.length || bodyHits) {
              // POST：payload 较大，放 URL 会 431（Request Header Fields Too Large）
              fetch('/voice-player/bubble-report', { method: 'POST', body: payload, cache: 'no-store' }).catch(() => {});
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

    // ---- 语音服务设置面板（必须挂在 shell.overlay）------------------------------
    // 以前这块面板渲染在「输入框左侧」槽位里：那层祖先带 transform，于是 position:fixed
    // 认它当参照系——面板水平还居中、垂直却掉到页面下方并被截断（用户 2026-11-05 报告）。
    // 放到 body 级的 overlay 层后，fixed 才是真正的视口坐标。
    const settingsOpen = (() => {
      let open = false;
      const subs = new Set();
      return {
        get: () => open,
        set(v) {
          const next = !!v;
          if (next === open) return;
          open = next;
          for (const f of Array.from(subs)) { try { f(open); } catch (e) { /* ignore */ } }
        },
        sub(f) { subs.add(f); return () => { subs.delete(f); }; },
      };
    })();

    // 档位分段按钮：面板共用，色调跟客户端明暗走
    const seg = (opts, cur, onPick) => {
      const th = resolvePalette();
      return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, margin: '4px 0 9px' } },
        opts.map(([val, label, dis]) => h('button', {
          key: String(val),
          disabled: !!dis,
          onClick: () => { if (!dis) onPick(val); },
          style: { flex: 1, padding: '5px 0', borderRadius: 8,
                   cursor: dis ? 'not-allowed' : 'pointer', fontSize: 11.5,
                   opacity: dis ? 0.45 : 1,
                   color: cur === val ? '#fff' : th.text,
                   background: cur === val ? th.brand : 'transparent',
                   border: '1px solid ' + (cur === val ? th.brand : th.line) },
        }, label))
      );
    };

    function VoiceSettingsPanel() {
      const [open, setOpen] = React.useState(settingsOpen.get());
      React.useEffect(() => settingsOpen.sub(() => setOpen(settingsOpen.get())), []);
      React.useEffect(() => {
        const on = () => settingsOpen.set(true);
        window.addEventListener('voice-player:open-settings', on);
        return () => window.removeEventListener('voice-player:open-settings', on);
      }, []);
      const [cfg, setCfg] = React.useState(DEFAULT_CFG);
      React.useEffect(() => {
        let live = true;
        const pull = async () => {
          try {
            const r = await fetch('/voice-player/status', { cache: 'no-store' });
            const d = await r.json();
            if (live && d && d.config) setCfg(d.config);
          } catch (e) { /* 端点不在：保留默认值，面板照样打得开 */ }
        };
        pull();
        const t = setInterval(pull, 15000);
        return () => { live = false; clearInterval(t); };
      }, []);
      if (!open || !cfg) return null;
      const th = resolvePalette();
      const saveCfg = async (next) => {
        setCfg(next);
        try {
          await fetch('/voice-player/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          });
        } catch { /* ignore */ }
      };
      const ttsDev = cfg.tts.device;
      const vramEst = 2.3 + (ttsDev === 'cpu' ? 0 : ttsDev === 'gpu2' ? 4.6 : 2.3);
      const ramEst = (ttsDev === 'cpu' ? 2.6 : 0.9) + 0.4;
      return h('div', {
        style: { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
                 zIndex: 2147482003, width: 316,
                 padding: '12px 14px', borderRadius: 14, color: th.text, fontSize: 12,
                 background: th.bg, border: '1px solid ' + th.line,
                 boxShadow: '0 10px 28px rgba(0,0,0,.18)', lineHeight: 1.55 },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('span', { style: { fontWeight: 600, fontSize: 12.5 } }, '语音服务设置'),
          h('button', {
            onClick: () => settingsOpen.set(false),
            style: { background: 'transparent', border: 0, color: 'inherit', opacity: 0.65,
                     cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' },
          }, '×')
        ),

        h('div', { style: { opacity: 0.62, fontSize: 10.5, letterSpacing: '.06em', margin: '8px 0 2px' } },
          'TTS · 说话'),
        h('div', { style: { opacity: 0.8, fontSize: 11 } }, '驻留方式'),
        seg([['resident', '常驻'], ['idle', '空闲卸载']],
          cfg.tts.mode,
          (v) => saveCfg({ ...cfg, tts: { ...cfg.tts, mode: v } })),
        cfg.tts.mode === 'idle' ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, margin: '-4px 0 9px' } },
          h('span', { style: { opacity: 0.7, fontSize: 11 } }, '空闲'),
          h('input', {
            type: 'number', min: 30, max: 3600, value: cfg.tts.idleSec,
            onChange: (e) => saveCfg({ ...cfg, tts: { ...cfg.tts, idleSec: Number(e.target.value) || 120 } }),
            style: { width: 64, padding: '3px 6px', borderRadius: 6, color: 'inherit',
                     background: 'transparent', border: '1px solid rgba(128,128,128,.4)', fontSize: 11.5 },
          }),
          h('span', { style: { opacity: 0.7, fontSize: 11 } }, '秒后卸载')
        ) : null,
        h('div', { style: { opacity: 0.8, fontSize: 11 } }, '运行位置'),
        seg([
          ['gpu', 'GPU · Qwen3-TTS（2.3G 显存）'],
          ['cpu', 'CPU · CosyVoice2（0 显存）'],
          ['gpu2', 'GPU×2 · 双 Qwen3（占用 4.6G）'],
          ['mix', 'CPU+GPU 混合（暂停用）', true],
        ],
          cfg.tts.device,
          (v) => saveCfg({ ...cfg, tts: { ...cfg.tts, device: v } })),
        cfg.tts.device === 'cpu' ? h('div', {
          style: { opacity: 0.75, fontSize: 11, margin: '-2px 0 8px' },
        }, '速度可能较慢：约 5–6 秒/句（首次加载约 20 秒）') : null,
        cfg.tts.device === 'mix' ? h('div', {
          style: { fontWeight: 800, color: '#b45309', fontSize: 11.5, lineHeight: 1.5, margin: '2px 0 8px' },
        }, '注意：混合加速由 GPU（Qwen3）与 CPU（CosyVoice2）两个不同模型合成，同一段话里音色可能不一致。') : null,

        h('div', { style: { opacity: 0.62, fontSize: 10.5, letterSpacing: '.06em', margin: '4px 0 2px' } },
          'ASR · 听话'),
        h('div', { style: { opacity: 0.8, fontSize: 11 } }, '驻留方式'),
        seg([['resident', '常驻'], ['idle', '空闲卸载']],
          cfg.asr.mode,
          (v) => saveCfg({ ...cfg, asr: { ...cfg.asr, mode: v } })),
        cfg.asr.mode === 'idle' ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, margin: '-4px 0 9px' } },
          h('span', { style: { opacity: 0.7, fontSize: 11 } }, '空闲'),
          h('input', {
            type: 'number', min: 30, max: 3600, value: cfg.asr.idleSec,
            onChange: (e) => saveCfg({ ...cfg, asr: { ...cfg.asr, idleSec: Number(e.target.value) || 120 } }),
            style: { width: 64, padding: '3px 6px', borderRadius: 6, color: 'inherit',
                     background: 'transparent', border: '1px solid rgba(128,128,128,.4)', fontSize: 11.5 },
          }),
          h('span', { style: { opacity: 0.7, fontSize: 11 } }, '秒后卸载')
        ) : null,

        h('div', { style: { borderTop: '1px solid rgba(128,128,128,.28)', marginTop: 4, paddingTop: 8,
                            fontSize: 11, opacity: 0.85 } },
          h('div', null, '预计占用　显存 ' + vramEst.toFixed(1) + ' G　内存 ' + ramEst.toFixed(1) + ' G'),
          h('div', { style: { opacity: 0.7, marginTop: 3, fontSize: 10.5 } },
            cfg.tts.device === 'cpu' ? '建议：CPU 与 GPU 同速，显存留给别的东西' : '建议：显存紧张时把 TTS 换到 CPU'),
          h('div', { style: { opacity: 0.7, marginTop: 2, fontSize: 10.5 } }, '改动在重新开启服务后生效')
        )
      );
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

      // ---- 语音服务：开关状态 + 档位（2026-10-30 新增）----------------------
      // svcUp: null=未知 / false=未启动（按钮灰）/ true=已就绪
      // 服务由宿主侧 services.js spawn 并托管，这里只负责"看一眼、点一下"。
      const [svcUp, setSvcUp] = React.useState(null);
      const [menu, setMenu] = React.useState(false);
      // 设置面板已挪到 shell.overlay（见 VoiceSettingsPanel）：这里只留窗口事件，
      // 由那边接管开合状态，避免面板继承输入框那层的 transform 参照系。
      // 菜单挂在按钮上方：位置由按钮的屏幕坐标算出来，不能用 fixed+bottom 蒙（会跑到屏幕右下角去）。
      const [anchor, setAnchor] = React.useState(null);

      const refreshSvc = React.useCallback(async () => {
        try {
          const r = await fetch('/voice-player/status', { cache: 'no-store' });
          const d = await r.json();
          const tts = (d.services || []).find((s) => s.name === 'tts');
          setSvcUp(!!(tts && tts.up));
        } catch {
          setSvcUp(false);
        }
      }, []);
      React.useEffect(() => { refreshSvc(); }, [refreshSvc]);
      React.useEffect(() => {
        const t = setInterval(refreshSvc, 15000);
        return () => clearInterval(t);
      }, [refreshSvc]);

      const svcAction = async (target, action) => {
        setState(action === 'start' ? '正在启动语音服务…' : '正在关闭…');
        try {
          await fetch('/voice-player/service?target=' + target + '&action=' + action, { method: 'POST' });
        } catch { /* 端点不在也继续，下面刷新会给出真实状态 */ }
        await refreshSvc();
        setState('');
        setMenu(false);
      };
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
      const dropDraft = (key) => setDrafts((list) => {
        const next = list.filter((d) => d.key !== key);
        // 状态栏是按条数写死的，删完必须同步，否则会一直挂着「待发 N 条」
        if (!next.length) setState('');
        else setState('录好了 · 待发 ' + next.length + ' 条');
        return next;
      });
      const clearDrafts = () => setDrafts([]);
      const sendDrafts = () => {
        const list = draftsRef.current;
        if (!list.length) return;
        // One message, several markers: the renderer turns each marker into its own bubble.
        const text = list.map((d) => d.line).join('');
        setDrafts([]);
        draftsRef.current = [];
        setState('');
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
            // 不再自动拉起服务：录音严格依赖「服务已启动」，由用户手动决定
            setState('语音服务未启动：先在悬浮条右键状态栏启动服务');
            setTimeout(() => setState(''), 4000);
            busyRef.current = false;
            setBusy(false);
            return;
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
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                signal: AbortSignal.timeout(180000) });
              const data = await res.json();
              const url = PLAY + (data.url || '');
              const secs = data.seconds ? data.seconds.toFixed(1) : '0.0';
              const line = '【语音 ' + secs + 's】' + url + (data.transcript ? '\n转写：' + data.transcript : '');
              // Into the tray: nothing is sent until the user presses 发送, so recording twice
              // in a row can no longer overwrite the first one.
              const item = { key: String(Date.now()) + Math.random().toString(16).slice(2, 6), secs, url, line };
              setDrafts((list) => list.concat([item]));
              setState('');   // 上传成功即清掉「上传中…」，之前删了「待发」提示后这里漏了清空
              // 不再提示「待发 N 条」（用户 2026-11-03：没什么用，还容易状态不同步）
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

      // 菜单项与档位分段按钮的小工具（只在渲染时用，不进状态）
      const th = resolvePalette();
      const mbtn = (label, onClick) => h('button', {
        onClick,
        style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 9px',
                 background: 'transparent', border: 0, borderRadius: 8, color: th.text,
                 cursor: 'pointer', fontSize: 12 },
      }, label);
      // 档位分段按钮 seg 已提到模块级（设置面板共用）

      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', fontSize: 11.5,
                 color: 'inherit', opacity: 0.9 },
      },
        h('button', {
          // 服务没起来时，这一次点击的含义是"启动服务"，不是"录音"（用户 2026-10-30 定）。
          onClick: () => {
            if (rec) return stop();
            if (svcUp === false) {
              setState('语音服务未启动：先在悬浮条右键状态栏启动服务');
              setTimeout(() => setState(''), 4000);
              return;
            }
            return start();
          },
          disabled: busy && !rec,
          title: rec ? '结束录音'
            : svcUp === false ? '语音服务未启动 · 单击启动 · 右键更多'
            : '录一段语音（右键：服务开关 / 设置）',
          'aria-label': 'voice message',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
                   borderRadius: '50%', cursor: 'pointer', padding: 0,
                   color: 'inherit', background: rec ? 'rgba(192,57,43,.18)' : 'transparent',
                   opacity: (busy && !rec) ? 0.45 : (svcUp === false ? 0.55 : 1),
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
          // 与右键面板同一套取色：纯白/纯黑底 + 主题字色（原来是半透明灰，深色皮肤下发灰）。
          style: { position: 'fixed', right: 16, bottom: 82, zIndex: 2147482000, display: 'flex',
                   flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 14,
                   minWidth: 268, maxHeight: '46vh', overflowY: 'auto', color: th.text,
                   background: th.bg, border: '1px solid ' + th.line,
                   boxShadow: '0 10px 28px rgba(0,0,0,.18)', fontSize: 12 },
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


    // ---- 语音通话：独立悬浮条（左：服务状态开关 / 右：电话） ----
    const CALL_RMS = 0.012;
    // 断句：最后一个字之后静音多久算说完。默认 2 秒——用户定调「等我说出最后一个字，
    // 后面 2 秒都没有新字才算说完」（2026-11-04）。可在 config.json 的 call.silenceMs 覆盖。
    let CALL_SILENCE = 2000;
    const CALL_MIN_CHARS = 2;
    let callOn = false;
    let callBusy = false;
    let callHeard = false;
    let callSilent = 0;
    let callPcm = [];
    let callCtx = null;
    let callStream = null;
    let callProc = null;
    let callSpeaking = false;
    let callStartedAt = 0;   // 通话开始时刻：前 1.5 秒显示「准备中」，别一上来就说「聆听」
    let callObserver = null;

    function callBindPlayers() {
      // 轮询所有 audio 的真实播放状态：事件（ended/pause）在气泡重建、流式、
      // 被替换时都不可靠，真实情况以 paused/ended 为准（2026-11-03 实测）。
      if (callObserver !== null) return;
      callObserver = { polling: true };
      setInterval(() => {
        let playing = false;
        try {
          document.querySelectorAll('audio').forEach((el) => {
            if (el.paused || el.ended) return;
            const t = el.currentTime || 0;
            if (t > 0 || el.readyState >= 2) playing = true;
          });
        } catch { /* ignore */ }
        callSpeaking = playing;
      }, 250);
    }

    function callWav(chunks, rate) {
      let total = 0;
      for (const c of chunks) total += c.length;
      const buf = new ArrayBuffer(44 + total * 2);
      const v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, total * 2, true);
      let o = 44;
      for (const c of chunks) {
        for (let i = 0; i < c.length; i += 1) {
          const s = Math.max(-1, Math.min(1, c[i]));
          v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          o += 2;
        }
      }
      return new Blob([buf], { type: 'audio/wav' });
    }

    async function callTranscribe(blob) {
      const form = new FormData();
      form.append('file', blob, 'speech.wav');
      form.append('model', 'qwen3-asr');
      const res = await fetch('http://127.0.0.1:18080/v1/audio/transcriptions', { method: 'POST', body: form });
      if (!res.ok) throw new Error('ASR ' + res.status);
      return ((await res.json()).text || '').trim();
    }

    // 每通电话一个 id：inbox 里的 start / end 都带上它，agent 只认本次通话的 end，
    // 不会被几十分钟前那通电话留下的 end 误导（2026-11-04 实测踩过）。
    let callId = '';
    // 每个会话一套独立文件（calls\<sessionId>\…），互不串味——同一账号开俩会话同时用语音也不会打架。
    let callSession = '';

    async function callPostInbox(type, text, extra) {
      try {
        await fetch('/voice-call/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ type, text: text || '', sessionId: callSession }, extra || {})),
        });
        return true;
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[voice-call] inbox failed', e);
        return false;
      }
    }

    // 通话状态上报：接通 / 挂断各一次，宿主记在内存里供 voice_call_status 读。
    // 光靠 inbox 里最后一条也能推断，但通话被取消、页面刷新时会漏写 end；状态接口是第二份证据。
    async function callPostState(active) {
      try {
        await fetch('/voice-call/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !!active, callId: callId || '', sessionId: callSession || '' }),
        });
        return true;
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[voice-call] state failed', e);
        return false;
      }
    }

    function callIsSpeech(txt) {
      const t = String(txt || '').replace(/[，。！？、；：,.!?;:\s]/g, '');
      if (t.length < 2) return false;
      if (/^(嗯|啊|哦|呃|额|哈|唉|喂|唔|哎)+$/.test(t)) return false;
      if (/^(.)\1+$/.test(t)) return false;
      return true;
    }

    function callSessionId() {
      try {
        const s = window.__voiceCallCtx && window.__voiceCallCtx.get('sessions');
        const table = s && s.manager && s.manager.sessions;
        if (!table) return null;
        if (typeof table.keys === 'function') {
          const first = table.keys().next();
          return first && !first.done ? first.value : null;
        }
        const keys = Object.keys(table);
        return keys.length ? keys[0] : null;
      } catch { return null; }
    }

    function callInject(txt) {
      try {
        const ctx = window.__voiceCallCtx;
        if (!ctx) return false;
        const sessions = ctx.get('sessions');
        if (!sessions || typeof sessions.retain !== 'function') return false;
        const id = callSessionId();
        if (!id) return false;
        const ref = sessions.retain(id, { source: 'voice-call' });
        Promise.resolve(ref.ready).then(async (binding) => {
          try { await binding.session.prompt([{ type: 'text', text: txt }], 'queue'); } catch (e) { if (typeof console !== 'undefined') console.error('[voice-call] prompt failed', e); }
          finally { if (ref && typeof ref.release === 'function') ref.release(); }
        }).catch((e) => { if (typeof console !== 'undefined') console.error('[voice-call] retain failed', e); });
        return true;
      } catch (e) {
        if (typeof console !== 'undefined') console.error('[voice-call] inject failed', e);
        return false;
      }
    }

    async function callEndTurn() {
      if (callBusy || !callHeard) return;
      callBusy = true;
      const chunks = callPcm;
      callPcm = [];
      callHeard = false;
      callSilent = 0;
      try {
        const txt = await callTranscribe(callWav(chunks, 16000));
        // 挂断后到达的转写结果一律丢弃：录制已经停止，不该再往文件里写
        if (!callOn) return;
        if (txt.length >= CALL_MIN_CHARS) {
          if (!callIsSpeech(txt)) {
            if (typeof console !== 'undefined') console.log('[voice-call] noise dropped:', txt);
          } else {
            await callPostInbox('speech', txt);
            if (typeof console !== 'undefined') console.log('[voice-call] inbox:', txt);
          }
        }
      } catch (e) {
        if (typeof console !== 'undefined') console.error('[voice-call] failed', e);
      }
      setTimeout(() => { callBusy = false; }, 300);
    }

    async function callToggle(onChange) {
      if (callOn) {
        callOn = false;
        callPcm = [];
        callHeard = false;
        callSilent = 0;
        callBusy = false;
        try { await callPostInbox('end', '', { callId }); } catch { /* ignore */ }
        void callPostState(false);
        // 强制中止当前回合：尝试几种已知的 session 中止入口，任何一步失败都不影响挂断本身
        try {
          const ctx = window.__voiceCallCtx;
          const sessions = ctx && ctx.get('sessions');
          const table = sessions && sessions.manager && sessions.manager.sessions;
          let id = null;
          if (table) id = typeof table.keys === 'function' ? (table.keys().next() || {}).value : Object.keys(table)[0];
          if (id && typeof sessions.retain === 'function') {
            const ref = sessions.retain(id, { source: 'voice-call-abort' });
            const binding = await Promise.resolve(ref.ready);
            const s = (binding && binding.session) || {};
            // 正解：session-controller 的 cancel() = 「Stop the active turn」
            if (typeof s.cancel === 'function') await s.cancel();
            if (ref && typeof ref.release === 'function') ref.release();
          }
        } catch (e) { if (typeof console !== 'undefined') console.warn('[voice-call] abort failed', e); }
        try { if (callProc) callProc.disconnect(); } catch { /* ignore */ }
        try { if (callCtx) callCtx.close(); } catch { /* ignore */ }
        try { if (callStream) callStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
        callProc = null; callCtx = null; callStream = null;
        if (onChange) onChange(false);
        return;
      }
      try {
        callBindPlayers();
        await fetch('/voice-player/ensure?service=asr', { method: 'POST' });
        await fetch('/voice-player/ensure?service=tts', { method: 'POST' });
        callStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        callCtx = new AudioContext({ sampleRate: 16000 });
        const src = callCtx.createMediaStreamSource(callStream);
        callProc = callCtx.createScriptProcessor(2048, 1, 1);
        callProc.onaudioprocess = (event) => {
          if (!callOn || callBusy || callSpeaking) return;
          const ch = event.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < ch.length; i += 1) sum += ch[i] * ch[i];
          const rms = Math.sqrt(sum / ch.length);
          const now = performance.now();
          if (rms > CALL_RMS) {
            if (!callHeard) { callHeard = true; callPcm = []; }
            callSilent = 0;
            callPcm.push(new Float32Array(ch));
          } else if (callHeard) {
            callPcm.push(new Float32Array(ch));
            if (callSilent === 0) callSilent = now;
            else if (now - callSilent > CALL_SILENCE) void callEndTurn();
          }
        };
        src.connect(callProc);
        callProc.connect(callCtx.destination);
        callOn = true;
        callStartedAt = Date.now();
        callId = 'c' + Date.now().toString(36);
        callSession = String(callSessionId() || '');
        // 断句阈值可被配置覆盖（默认 2 秒）：做成可调，换人用不用改代码
        try {
          const r = await fetch('/voice-player/config', { cache: 'no-store' });
          const d = await r.json();
          const ms = Number(d && d.config && d.config.call && d.config.call.silenceMs);
          if (Number.isFinite(ms) && ms > 0) CALL_SILENCE = Math.min(3500, Math.max(600, ms));
        } catch { /* 用默认 2 秒 */ }
        // 先落一条 start：inbox 里从此能分清「这通电话从哪一行开始」，
        // 历史 end 再也不会被当成这次通话的结束（voice_call_status 用同一份 callId 判定）。
        await callPostInbox('start', '', { callId });
        try {
          // 气泡里只留这一句：操作手册已经写进插件的系统提示段（始终可见），
          // 塞在对话框里既难看又每通电话重复一遍（2026-11-04 用户要求）。
          callInject('（语音通话已开始）');
        } catch { /* ignore */ }
        void callPostState(true);
        // 先让 agent 说完开场白，再真正开麦；这段时间状态显示「准备中」
        await new Promise((r) => setTimeout(r, 3000));
        if (!callOn) {   // 等待期间被挂断
          if (onChange) onChange(false);
          return;
        }
        if (onChange) onChange(true);
      } catch (e) {
        if (typeof console !== 'undefined') console.error('[voice-call] start failed', e);
        if (onChange) onChange(false);
      }
    }

    async function callHeartbeat() {
      try {
        const r = await fetch('/voice-call/heartbeat', { cache: 'no-store' });
        if (!r.ok) return false;
        const d = await r.json();
        return !!(d && d.alive);
      } catch { return false; }
    }

    // 心跳全量：alive = agent 刚碰过文件（在守 inbox），busy = 它正在合成语音。
    // 「聆听」= 麦克风在采集 **且** agent 真的在等你说；只合成不等待的时候该亮「忙线」。
    async function callHeartbeatRaw() {
      try {
        const r = await fetch('/voice-call/heartbeat', { cache: 'no-store' });
        if (!r.ok) return { alive: false, age: -1, busy: false };
        const d = await r.json();
        return { alive: !!(d && d.alive), age: Number((d && d.age) || -1), busy: !!(d && d.busy) };
      } catch { return { alive: false, age: -1, busy: false }; }
    }

    async function callListeningState() {
      try {
        const r = await fetch('/voice-call/heartbeat', { cache: 'no-store' });
        if (!r.ok) return false;
        const d = await r.json();
        return !!(d && d.alive);
      } catch { return false; }
    }

    async function callServiceState() {
      try {
        const r = await fetch('/voice-player/status', { cache: 'no-store' });
        if (!r.ok) return { ok: true, alive: false };
        const d = await r.json();
        const list = Array.isArray(d.services) ? d.services : [];
        const asr = list.find((s) => s && s.name === 'asr');
        const tts = list.find((s) => s && s.name === 'tts');
        const alive = !!(asr && asr.up && tts && tts.up);
        return { ok: true, alive, raw: list };
      } catch (e) { return { ok: false, alive: false, error: e }; }
    }

    function callSilentWav() {
      const rate = 16000;
      const samples = Math.floor(rate * 0.2);
      const buf = new ArrayBuffer(44 + samples * 2);
      const v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, samples * 2, true);
      return new Blob([buf], { type: 'audio/wav' });
    }

    async function callWarm() {
      try {
        const form = new FormData();
        form.append('file', callSilentWav(), 'warm.wav');
        form.append('model', 'qwen3-asr');
        await fetch('http://127.0.0.1:18080/v1/audio/transcriptions', { method: 'POST', body: form });
      } catch (e) { if (typeof console !== 'undefined') console.warn('[voice-call] warm asr failed', e); }
      try { await fetch('http://127.0.0.1:18082/say?text=你好', { cache: 'no-store' }); } catch (e) { if (typeof console !== 'undefined') console.warn('[voice-call] warm tts failed', e); }
    }

    async function callServiceToggle(start) {
      const names = ['asr', 'tts'];
      if (start) {
        for (const n of names) {
          try { await fetch('/voice-player/ensure?service=' + n, { method: 'POST' }); } catch { /* ignore */ }
        }
        await callWarm();
      } else {
        for (const n of names) {
          try { await fetch('/voice-player/service?target=' + n + '&action=stop', { method: 'POST' }); } catch { /* ignore */ }
        }
      }
    }

    function VoiceCallBar(props) {
      const ctx = props.ctx;
      const [on, setOn] = React.useState(!!(typeof window !== 'undefined' && window.__voiceCallOn));
      const syncOn = React.useCallback((v) => {
        if (typeof window !== 'undefined') window.__voiceCallOn = !!v;
        setOn(!!v);
      }, []);
      const [svc, setSvc] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [listen, setListen] = React.useState(false);
      const [svcInfo, setSvcInfo] = React.useState([]);
      const [phase, setPhase] = React.useState('idle');   // idle | connecting | connected
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [menuPos, setMenuPos] = React.useState({ x: 0, y: 0 });
      const [speaking, setSpeaking] = React.useState(false);
      React.useEffect(() => {
        const t = setInterval(() => setSpeaking(!!callSpeaking), 300);
        return () => clearInterval(t);
      }, []);
      const [pos, setPos] = React.useState(null);   // 拖动后的固定位置；null = 默认右下角
      const dragRef = React.useRef(null);
      React.useEffect(() => {
        const onMove = (e) => {
          const d = dragRef.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
          d.moved = true;
          const left = Math.max(0, Math.min(window.innerWidth - d.rect.width, d.rect.left + dx));
          const top = Math.max(0, Math.min(window.innerHeight - d.rect.height, d.rect.top + dy));
          setPos({ left: Math.round(left), top: Math.round(top) });
        };
        const onUp = () => { dragRef.current = null; };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }, []);
      React.useEffect(() => {
        if (ctx) window.__voiceCallCtx = ctx;
        let live = true;
        const tick = async () => {
          if (!live) return;
          const st = await callServiceState();
          const list = Array.isArray(st.raw) ? st.raw : [];
          // 只有「服务在跑 + 模型已加载」才算就绪（否则电话按钮必须灰）
          // 电话可点 = 服务在跑 **且模型已加载**（否则点下去第一句要等十几秒，且容易误判为卡死）
          const ready = list.length > 0 && list.every((s) => s && s.up && s.loaded);
          setSvc(ready);
          setSvcInfo(list);
          setTimeout(tick, 2500);
        };
        tick();
        // 聆听 / 忙线：麦克风是否真在采集 **且** agent 是否真在等你说。
        // - agent 在想事/合成语音时心跳会断（或 busy=true）→ 忙线：这时你说话只会被排队；
        // - agent 正卡在 voice_wait 里等 → 心跳 400ms 刷一次 → 聆听。
        // 只按麦克风算会把「它正忙、你说白说」也亮成聆听，反之只按心跳算会在它干活时反复闪。
        let hbState = { alive: false, busy: false };
        const hbTimer = setInterval(async () => {
          if (!live) return;
          hbState = callOn ? await callHeartbeatRaw() : { alive: false, busy: false };
        }, 800);
        const listenTimer = setInterval(() => {
          if (!live) return;
          const prepared = callStartedAt > 0 && (Date.now() - callStartedAt) > 3000;
          const agentWaiting = !!hbState.alive && !hbState.busy;
          const next = !!callOn && prepared && !callBusy && !callSpeaking && agentWaiting;
          setListen((prev) => (prev === next ? prev : next));
        }, 300);
        return () => { live = false; clearInterval(listenTimer); clearInterval(hbTimer); };
      }, [ctx]);
      const interrupt = () => {
        // 只有我正在播报时才有效；其它时候点了什么都不做
        if (!callSpeaking) return;
        // 打断：立刻停掉所有正在播的音频（连同排队中的后续语音），并把采集状态打回「聆听」
        try {
          window.__voiceTransientClear && window.__voiceTransientClear();
        } catch { /* ignore */ }
        try {
          // 只暂停，不倒带：倒带到 0 等于把「被打断」变成「从头再来一遍」（2026-11-05 实测）
          document.querySelectorAll('audio').forEach((a) => {
            try { a.pause(); } catch { /* ignore */ }
          });
        } catch { /* ignore */ }
        callSpeaking = false;
        setListen(true);
      };
      const toggleSvc = async () => {
        if (busy) return;
        setBusy(true);
        try {
          if (svc) {
            if (on) { await callToggle(syncOn); }
            await callServiceToggle(false);
            setSvc(false);
          } else {
            await callServiceToggle(true);
            setSvc(true);
          }
        } finally { setBusy(false); }
      };
      const toggleCall = async () => {
        if (busy) return;
        if (on) {
          setBusy(true);
          try { await callToggle(syncOn); } finally { setPhase('idle'); setBusy(false); }
          return;
        }
        if (!svc) return;
        setBusy(true);
        setPhase('connecting');
        try {
          await callToggle(syncOn);
          // 缓冲 3 秒再变红（挂断），避免刚接通就误点
          setTimeout(() => setPhase('connected'), 3000);
        } catch { setPhase('idle'); } finally { setBusy(false); }
      };
      return h('div', { className: 'vcall-root', style: pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : undefined },
        on ? h('button', {
          type: 'button', className: 'vcall-interrupt',
          title: callSpeaking ? '打断：停止我的语音，立刻回到聆听' : '我当前没在说话（点了无效）',
          onClick: interrupt,
        }, '打断') : null,
        menuOpen ? h('div', { className: 'vcall-menu', style: { left: menuPos.x, top: menuPos.y },
          onMouseLeave: () => setMenuOpen(false) },
          h('button', { type: 'button', className: 'vcall-menu-item',
            onClick: () => { setMenuOpen(false); void toggleSvc(); } }, svc ? '关闭语音服务' : '启动语音服务'),
        ) : null,
        h('div', { className: 'vcall-bar', style: { cursor: 'grab' },
          onMouseDown: (e) => { dragRef.current = { x: e.clientX, y: e.clientY, rect: e.currentTarget.getBoundingClientRect(), moved: false }; } },
          h('button', {
            type: 'button',
            className: 'vcall-gear',
            title: '语音设置（服务档位 / 驻留 / 运行位置）',
            onClick: () => { try { window.dispatchEvent(new CustomEvent('voice-player:open-settings')); } catch { /* ignore */ } },
          },
            h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true', fill: 'currentColor' },
              h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.25.43.34.61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.18.12.47.03.61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z' }))),
          h('div', { className: 'vcall-seam' }),
          h('button', {
            type: 'button',
            className: 'vcall-cell' + (svc ? ' is-on' : '') + (busy ? ' is-busy' : ''),
            onClick: (e) => { e.preventDefault(); },   // 单击不动作：防止误触启停
            onContextMenu: (e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setMenuPos({ x: Math.round(r.left), y: Math.round(r.bottom + 6) });
              setMenuOpen(true);
            },
            title: (() => {
              if (!svcInfo.length) return svc ? '语音服务运行中（右键关闭）' : '语音服务已停止（右键启动）';
              return svcInfo.map((s) => {
                const name = s.name === 'asr' ? 'ASR' : 'TTS';
                const state = s.up ? (s.loaded ? '已加载' : '进程在·模型未加载') : '未运行';
                const model = s.model ? ' · ' + s.model : '';
                const vram = s.vramGb ? ' · ' + s.vramGb + 'G 显存' : (s.up ? ' · 0 显存' : '');
                const second = s.second ? '（第二实例 :' + s.second + '）' : '';
                return name + '：' + state + model + vram + second;
              }).join('\n') + '\n右键' + (svc ? '关闭' : '启动') + '语音服务';
            })(),
          },
            h('span', { className: 'vcall-dot' + (svc ? ' is-on' : '') }),
            h('span', { className: 'vcall-text' }, svc ? '语音服务' : '启动服务'),
            busy ? h('span', { className: 'vcall-busy' }, '…') : null),
          h('div', { className: 'vcall-seam' }),
          on ? h('span', { className: 'vcall-listen' + (listen ? ' is-on' : ' is-blind'), title: listen ? '我在听' : '现在没在听（忙线）' }, listen ? '聆听' : '忙线') : null,
          h('div', { className: 'vcall-seam' }),
          h('button', {
            type: 'button',
            className: 'vcall-call'
              + (on ? (phase === 'connecting' ? ' is-connecting' : ' is-on') : '')
              + (!on && !svc ? ' is-disabled' : ''),
            disabled: (!on && !svc) || busy,
            onClick: () => { void toggleCall(); },
            title: (!on && !svc) ? '服务或模型未就绪（点左侧状态栏启动）' : (on ? '结束语音通话' : '开始语音通话'),
          },
            h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': 'true' },
              h('path', {
                d: 'M3.2 2.6c.5-.5 1.3-.4 1.7.2l1 1.5c.3.5.2 1.1-.3 1.5l-.6.5c.4 1 .9 1.7 1.7 2.4s1.5 1.2 2.4 1.6l.5-.6c.4-.5 1-.6 1.5-.3l1.5 1c.6.4.7 1.2.2 1.7l-.8.8c-.5.5-1.2.7-1.9.6C7.6 12.7 3.2 8.3 2.5 5.3c-.2-.7 0-1.4.5-1.9l.2-.2Z',
                fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round',
              })))));
    }

    const VCALL_STYLE_ID = 'dsh-voice-call-bar-style';
    if (typeof document !== 'undefined' && !document.getElementById(VCALL_STYLE_ID)) {
      const st = document.createElement('style');
      st.id = VCALL_STYLE_ID;
      st.textContent = [
        // 位置：默认贴右上、落在顶栏下方（用户 2026-11-05：挂右下角太远，来回够不着）。
        // 拖一次就固定在拖到的地方（pos 状态），不会再被这里的默认值盖掉。
        '.vcall-root{position:fixed;right:18px;top:64px;bottom:auto;z-index:2147483001;font-family:inherit;font-size:12px}',
        '.vcall-bar{display:flex;align-items:stretch;height:36px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 6px 18px rgba(0,0,0,.12)}',
        '.vcall-cell{display:flex;align-items:center;gap:6px;padding:0 12px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}',
        '.vcall-cell:hover{background:color-mix(in srgb,var(--dsw-alias-border-l1,#e5e7eb) 30%,transparent)}',
        '.vcall-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af}',
        '.vcall-dot.is-on{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}',
        '.vcall-text{white-space:nowrap}',
        '.vcall-busy{opacity:.6}',
        '.vcall-gear{display:flex;align-items:center;justify-content:center;width:32px;border:0;background:transparent;color:inherit;cursor:pointer}',
        '.vcall-gear:hover{background:color-mix(in srgb,var(--dsw-alias-border-l1,#e5e7eb) 30%,transparent)}',
        '.vcall-listen{display:flex;align-items:center;padding:0 10px;font-size:11.5px;white-space:nowrap}',
        '.vcall-listen.is-on{color:#16a34a}',
        '.vcall-listen.is-blind{color:#d97706}',
        '.vcall-seam{width:1px;background:var(--dsw-alias-border-l1,#e5e7eb)}',
        '.vcall-call{display:flex;align-items:center;justify-content:center;width:40px;border:0;background:transparent;color:inherit;cursor:pointer}',
        '.vcall-call:hover{background:color-mix(in srgb,var(--dsw-alias-border-l1,#e5e7eb) 30%,transparent)}',
        '.vcall-call{color:#16a34a}',
        '.vcall-call:hover{background:rgba(34,197,94,.12)}',
        '.vcall-call.is-connecting{color:#2563eb;background:rgba(37,99,235,.12)}',
        '.vcall-call.is-on{background:rgba(239,68,68,.16);color:#dc2626}',
        '.vcall-call.is-on:hover{background:rgba(239,68,68,.24)}',
        '.vcall-call.is-disabled{opacity:.4;cursor:not-allowed;color:#9ca3af}',
        '.vcall-interrupt{display:block;width:100%;margin-top:6px;padding:7px 0;border:1px solid #d97706;'
          + 'border-radius:999px;background:#f59e0b;color:#3b2205;font:inherit;font-size:12px;'
          + 'font-weight:700;cursor:pointer;white-space:nowrap}',
        '.vcall-interrupt:hover{background:#fbbf24}',
        '.vcall-menu{position:fixed;z-index:2147483001;min-width:150px;padding:4px;border-radius:10px;'
          + 'background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);'
          + 'box-shadow:0 10px 28px rgba(0,0,0,.18);font-size:12px}',
        '.vcall-menu-item{display:block;width:100%;padding:7px 10px;border:0;border-radius:7px;'
          + 'background:transparent;color:inherit;text-align:left;cursor:pointer}',
        '.vcall-menu-item:hover{background:rgba(0,0,0,.06)}',
      ].join('\n');
      document.head.appendChild(st);
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
        // 语音通话：独立悬浮条（左服务状态开关 / 右电话），与模型监控条分开
        if (ctx) window.__voiceCallCtx = ctx;
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'voice-call-bar', order: 12,
        }, (props) => h(VoiceCallBar, Object.assign({}, props, { ctx }))));
        // 设置面板也放 body 级 overlay：挂在输入框槽位里会继承那层的 transform 参照系，
        // position:fixed 就不是视口坐标了（用户 2026-11-05 报告的错位）。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'voice-settings', order: 13,
        }, VoiceSettingsPanel));
      },
    };
  },
});
