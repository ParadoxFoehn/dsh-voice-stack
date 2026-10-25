window.__ModuleLoader__.load({
  id: '@local/dsh-voice-player',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const COSY = 'http://127.0.0.1:18081';   // CosyVoice2 TTS service
    const SAPI = 'http://127.0.0.1:18080';   // fallback TTS

    // Build the audio URL from the tool arguments. CosyVoice2 is preferred; the SAPI endpoint
    // is only used when the first one is unreachable (the browser falls back on error below).
    function sayUrl(text) {
      return COSY + '/say?text=' + encodeURIComponent(String(text || '').slice(0, 800));
    }

    function pickArgs(block) {
      if (!block) return {};
      let a = block.args;
      if (typeof a === 'function') { try { a = a(); } catch (e) { return {}; } }
      if (a && typeof a === 'object' && 'value' in a && a.value && typeof a.value === 'object') a = a.value;
      return (a && typeof a === 'object') ? a : {};
    }

    // A bare player: no card, no border, no background — just the native controls,
    // with enough margin below so the next paragraph does not stick to it.
    function VoiceMessage(props) {
      const args = pickArgs(props.block);
      const text = typeof args.text === 'string' ? args.text : '';
      const [src, setSrc] = React.useState('');
      React.useEffect(() => {
        if (text) setSrc(sayUrl(text));
      }, [text]);
      if (!text) return h('div', { style: { margin: '8px 0' } }, '语音消息…');
      return h('div', { style: { margin: '10px 0 18px' } },
        h('audio', {
          src,
          controls: true,
          preload: 'metadata',
          style: { width: '100%', maxWidth: 460, height: 34, display: 'block' },
          onError: () => setSrc(SAPI + '/tts?text=' + encodeURIComponent(text.slice(0, 800))),
        })
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The dock input bar was removed on user request (2026-10-24): voice is sent by me,
        // not typed by the user, and the bar cluttered the composer.
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview', key: 'voice_say',
        }, VoiceMessage));
      },
    };
  },
});
