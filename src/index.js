/**
 * ElionAI Relay — Cloudflare Worker
 * Fluxion: Workers AI (Flux 3 Video) → Agnes Flash → LTX
 * Secrets: AGNES_API_KEY, PIXAZO_API_KEY, ACE_MUSIC_API_KEY, GROQ_API_KEY,
 *          GEMINI_API_KEY (ou GEMINI_API_KEY_2)
 * Binding: AI
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const AGNES_BASE = 'https://apihub.agnes-ai.com';
const AGNES_MODEL = 'agnes-video-2.5-flash';
const LTX_SUBMIT = [
  'https://gateway.pixazo.ai/ltx-2-5-pro/v1/text-to-video',
  'https://gateway.pixazo.ai/ltx-2-5-lite/v1/text-to-video',
  'https://gateway.pixazo.ai/ltx-video/v1/text-to-video',
];
const LTX_STATUS = 'https://gateway.pixazo.ai/v2/requests/status/';
const ACE_CHAT_URL = 'https://api.ace-music.com/v1/chat/completions';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function pickGeminiKey(env) {
  return env.GEMINI_API_KEY || env.GEMINI_API_KEY_2 || env.GEMINI_API_KEY_3 || '';
}

/* ─── Chat Gemini ─── */
async function proxyGemini(body, env) {
  const key = pickGeminiKey(env);
  if (!key) return json({ error: { message: 'GEMINI_API_KEY manquante' } }, 500);

  const models = [
    body.model,
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-8b',
  ].filter(Boolean);

  const payload = { contents: body.contents || [] };
  if (body.system_instruction) payload.system_instruction = body.system_instruction;
  if (body.generationConfig) payload.generationConfig = body.generationConfig;
  if (body.tools) payload.tools = body.tools;
  if (body.tool_config) payload.tool_config = body.tool_config;
  if (body.safetySettings) payload.safetySettings = body.safetySettings;

  let lastErr = 'Gemini failed';
  let lastStatus = 502;
  for (const model of models) {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent?key=' +
      encodeURIComponent(key);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return json(data, 200);
      lastStatus = res.status;
      lastErr = data?.error?.message || data?.message || `Gemini HTTP ${res.status}`;
      if (res.status === 429) return json(data, 429);
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return json({ error: { message: lastErr } }, lastStatus || 502);
}

/* ─── Fluxion: Workers AI Flux 3 Video ─── */
async function submitFluxionWorkersAI(prompt, opts, env) {
  if (!env.AI) return { ok: false, error: 'Workers AI non lié' };

  const duration = Math.min(20, Math.max(5, Number(opts?.duration) || 5));
  const resolution = String(opts?.quality || opts?.resolution || 'hd').toLowerCase().includes('1080')
    ? 'fhd'
    : 'hd';

  const models = [
    'black-forest-labs/flux-3-video',
    '@cf/black-forest-labs/flux-3-video',
  ];

  let lastErr = 'Workers AI video failed';
  for (const model of models) {
    try {
      const input = {
        mode: 't2v',
        prompt: String(prompt || '').slice(0, 1500),
        resolution,
        duration,
        generate_audio: opts?.sound !== false,
      };
      if (opts?.image_url || opts?.image) {
        input.mode = 'i2v';
        if (opts.image_url) input.image = opts.image_url;
        else input.image = opts.image;
      }

      const r = await env.AI.run(model, input);
      const videoUrl =
        r?.result?.video ||
        r?.video ||
        r?.url ||
        r?.output?.video ||
        (typeof r === 'string' && r.startsWith('http') ? r : null);

      if (videoUrl) {
        return {
          ok: true,
          provider: 'workers-ai',
          video_url: videoUrl,
          url: videoUrl,
          status: 'COMPLETED',
          request_id: 'cf-done-' + Date.now(),
        };
      }

      if (r?.state && /complet|success|done/i.test(String(r.state))) {
        const u = r?.result?.video || r?.result?.url;
        if (u) {
          return {
            ok: true,
            provider: 'workers-ai',
            video_url: u,
            url: u,
            status: 'COMPLETED',
            request_id: 'cf-done-' + Date.now(),
          };
        }
      }

      lastErr = 'Workers AI: pas d\'URL vidéo — ' + JSON.stringify(r).slice(0, 180);
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { ok: false, error: lastErr };
}

/* ─── Agnes ─── */
function mapAgnesSeconds(d) {
  const n = Number(d) || 5;
  if (n <= 4) return '4';
  if (n <= 5) return '5';
  if (n <= 6) return '6';
  if (n <= 8) return '8';
  if (n <= 10) return '10';
  return '12';
}
function mapAgnesAspect(fmt) {
  const f = String(fmt || '').toLowerCase();
  if (f.includes('9:16') || f.includes('portrait')) return '9:16';
  if (f.includes('1:1')) return '1:1';
  return '16:9';
}

async function submitFluxionAgnes(prompt, opts, env) {
  const key = env.AGNES_API_KEY;
  if (!key) return { ok: false, error: 'AGNES_API_KEY manquante' };
  const res = await fetch(`${AGNES_BASE}/v1/videos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: AGNES_MODEL,
      prompt: String(prompt || '').slice(0, 2000),
      mode: 'text',
      seconds: mapAgnesSeconds(opts?.duration || 5),
      size: '720P',
      aspect_ratio: mapAgnesAspect(opts?.aspect || '16:9'),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data.detail || data.error?.message || data.message || `Agnes HTTP ${res.status}`,
      raw: data,
    };
  }
  const videoId = data.video_id || data.id;
  if (!videoId) return { ok: false, error: 'Agnes: pas de video_id', raw: data };
  return { ok: true, provider: 'agnes-flash', video_id: videoId, request_id: videoId };
}

async function pollAgnesOnce(videoId, env) {
  const key = env.AGNES_API_KEY;
  if (!key) return { ok: false, status: 'FAILED', error: 'AGNES_API_KEY manquante' };
  const url =
    `\( {AGNES_BASE}/agnesapi?video_id= \){encodeURIComponent(videoId)}` +
    `&model_name=${encodeURIComponent(AGNES_MODEL)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  const data = await res.json().catch(() => ({}));
  const status = String(data.status || '').toLowerCase();
  if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
    const videoUrl = data.url || data.video_url;
    if (!videoUrl) return { ok: false, status: 'FAILED', error: 'sans url', raw: data };
    return {
      ok: true,
      status: 'COMPLETED',
      video_url: videoUrl,
      url: videoUrl,
      provider: 'agnes-flash',
    };
  }
  if (['failed', 'error', 'cancelled'].includes(status)) {
    return {
      ok: false,
      status: 'FAILED',
      error: data.error?.message || data.error || data.detail || 'Agnes failed',
      raw: data,
    };
  }
  return { ok: true, status: 'PROCESSING', progress: data.progress || 0, provider: 'agnes-flash' };
}

/* ─── LTX ─── */
async function submitFluxionLtx(prompt, opts, env) {
  const key = env.PIXAZO_API_KEY;
  if (!key) return { ok: false, error: 'PIXAZO_API_KEY manquante' };
  const payload = {
    prompt: String(prompt || '').slice(0, 1500),
    duration: Math.min(8, Math.max(3, Number(opts?.duration) || 5)),
  };
  let lastErr = 'LTX unavailable';
  for (const endpoint of LTX_SUBMIT) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'x-api-key': key,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = data.message || data.error || `LTX HTTP ${res.status}`;
        continue;
      }
      const requestId = data.request_id || data.id || data.job_id || data.data?.request_id;
      if (!requestId) {
        lastErr = 'LTX: pas de request_id';
        continue;
      }
      return { ok: true, provider: 'ltx', request_id: requestId };
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { ok: false, error: lastErr };
}

async function pollLtxOnce(requestId, env) {
  const key = env.PIXAZO_API_KEY;
  if (!key) return { ok: false, status: 'FAILED', error: 'PIXAZO_API_KEY manquante' };
  const res = await fetch(LTX_STATUS + encodeURIComponent(requestId), {
    headers: { Authorization: `Bearer ${key}`, 'x-api-key': key },
  });
  const data = await res.json().catch(() => ({}));
  const st = String(data.status || data.state || '').toLowerCase();
  const videoUrl =
    data.video_url ||
    data.url ||
    data.output?.url ||
    data.result?.url ||
    (Array.isArray(data.outputs) && data.outputs[0]?.url);
  if (videoUrl && (st.includes('success') || st.includes('complete') || st === 'done')) {
    return { ok: true, status: 'COMPLETED', video_url: videoUrl, url: videoUrl, provider: 'ltx' };
  }
  if (st.includes('fail') || st.includes('error')) {
    return { ok: false, status: 'FAILED', error: data.message || data.error || 'LTX failed' };
  }
  return { ok: true, status: 'PROCESSING', provider: 'ltx' };
}

/* ─── Sonaria / Illustro ─── */
async function runSonaria(prompt, opts, env) {
  const key = env.ACE_MUSIC_API_KEY || env.PIXAZO_API_KEY;
  if (!key) return { ok: false, error: 'ACE_MUSIC_API_KEY manquante' };
  const duration = Math.min(35, Math.max(5, Number(opts?.duration || opts?.ace_duration) || 15));
  const res = await fetch(ACE_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'ace-music',
      messages: [{ role: 'user', content: String(prompt || '').slice(0, 1500) }],
      task_type: 'text2music',
      audio_config: { duration, instrumental: true, format: 'mp3' },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data.error?.message || data.message || `Ace HTTP ${res.status}` };
  }
  const audioUrl =
    data.choices?.[0]?.message?.audio?.[0]?.audio_url?.url ||
    data.choices?.[0]?.message?.audio_url ||
    data.audio_url ||
    data.url;
  if (!audioUrl) return { ok: false, error: 'Ace sans audio', raw: data };
  return { ok: true, url: audioUrl, provider: 'ace-music' };
}

async function runIllustro(prompt, opts, env) {
  if (!env.AI) return { ok: false, error: 'Workers AI non lié' };
  const p = String(prompt || '').slice(0, 2000);
  const width = Number(opts?.width) || 1024;
  const height = Number(opts?.height) || 1024;
  const models = [
    '@cf/black-forest-labs/flux-2-klein-4b',
    '@cf/black-forest-labs/flux-2-dev',
  ];
  let lastErr = 'Illustro failed';
  for (let i = 0; i < models.length; i++) {
    try {
      let r;
      if (i === 0) {
        const form = new FormData();
        form.append('prompt', p);
        form.append('width', String(width));
        form.append('height', String(height));
        r = await env.AI.run(models[i], form);
      } else {
        r = await env.AI.run(models[i], { prompt: p, width, height });
      }
      const b64 = r?.image || r?.images?.[0];
      if (b64) return { ok: true, image: b64, provider: models[i] };
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { ok: false, error: lastErr };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);

    if (request.method === 'GET') {
      return json({
        ok: true,
        service: 'elion-relay',
        chat: pickGeminiKey(env) ? 'gemini' : 'off',
        fluxion_primary: env.AI ? 'workers-ai-flux3-video' : 'off',
        fluxion_fallback: env.AGNES_API_KEY ? 'agnes-flash' : 'off',
        fluxion_fallback2: env.PIXAZO_API_KEY ? 'ltx' : 'off',
        sonaria: env.ACE_MUSIC_API_KEY || env.PIXAZO_API_KEY ? 'ace' : 'off',
        illustro: env.AI ? 'flux-2' : 'off',
        has_ai_binding: !!env.AI,
        has_agnes: !!env.AGNES_API_KEY,
        has_gemini: !!pickGeminiKey(env),
      });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    try {
      /* Fluxion SUBMIT */
      if (body.ltx_prompt || body.fluxion_prompt || body.video_prompt) {
        const prompt =
          body.ltx_prompt || body.fluxion_prompt || body.video_prompt || body.prompt || '';
        const opts = {
          duration: body.ltx_duration || body.duration || 5,
          aspect: body.ltx_aspect || body.aspect || '16:9',
          quality: body.ltx_quality || body.quality || '720p',
          sound: body.ltx_sound !== false,
          image: body.image || body.image_url,
          image_url: body.image_url,
        };

        // 1) Workers AI Flux 3 Video
        const cf = await submitFluxionWorkersAI(prompt, opts, env);
        if (cf.ok && cf.video_url) {
          return json({
            ok: true,
            request_id: cf.request_id,
            id: cf.request_id,
            provider: 'workers-ai',
            status: 'COMPLETED',
            video_url: cf.video_url,
            url: cf.video_url,
          });
        }

        // 2) Agnes
        const agnes = await submitFluxionAgnes(prompt, opts, env);
        if (agnes.ok) {
          return json({
            ok: true,
            request_id: agnes.request_id || agnes.video_id,
            id: agnes.video_id,
            provider: 'agnes-flash',
            status: 'queued',
            workers_ai_error: cf.error,
          });
        }

        // 3) LTX
        const ltx = await submitFluxionLtx(prompt, opts, env);
        if (ltx.ok) {
          return json({
            ok: true,
            request_id: ltx.request_id,
            id: ltx.request_id,
            provider: 'ltx',
            status: 'queued',
            workers_ai_error: cf.error,
            agnes_error: agnes.error,
          });
        }

        return json(
          {
            ok: false,
            error: cf.error || agnes.error || ltx.error || 'Fluxion indisponible',
          },
          502
        );
      }

      /* Fluxion POLL */
      if (body.ltx_status) {
        const id = String(body.ltx_status);
        const provider = String(body.provider || '');

        if (id.startsWith('cf-done-')) {
          return json({
            ok: false,
            status: 'FAILED',
            error: 'Job CF déjà terminé côté submit — rafraîchis',
          });
        }

        if (provider === 'ltx') return json(await pollLtxOnce(id, env));

        if (provider === 'agnes-flash' || !provider) {
          if (env.AGNES_API_KEY) {
            const once = await pollAgnesOnce(id, env);
            if (
              once.status === 'FAILED' &&
              !provider &&
              env.PIXAZO_API_KEY &&
              /not found/i.test(String(once.error || ''))
            ) {
              return json(await pollLtxOnce(id, env));
            }
            return json(once);
          }
        }

        if (env.PIXAZO_API_KEY) return json(await pollLtxOnce(id, env));
        return json({ status: 'FAILED', error: 'no poll provider' }, 500);
      }

      /* Sonaria */
      if (body.ace_prompt || body.sonaria_prompt || body.audio_prompt) {
        const prompt =
          body.ace_prompt || body.sonaria_prompt || body.audio_prompt || body.prompt || '';
        const result = await runSonaria(prompt, body, env);
        return json(result, result.ok ? 200 : 502);
      }

      /* Illustro */
      if (body.illustro_prompt || body.image_prompt) {
        const prompt = body.illustro_prompt || body.image_prompt || body.prompt || '';
        const result = await runIllustro(prompt, body, env);
        return json(result, result.ok ? 200 : 502);
      }

      /* Chat Gemini */
      if (
        Array.isArray(body.contents) ||
        body.system_instruction ||
        body.force_gemini ||
        body.force_vision ||
        body.has_image
      ) {
        return proxyGemini(body, env);
      }

      if (Array.isArray(body.messages) && env.GROQ_API_KEY) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: body.messages,
          }),
        });
        const data = await res.json().catch(() => ({}));
        return json(data, res.status);
      }

      return json({ error: 'Unknown action', keys: Object.keys(body || {}) }, 400);
    } catch (e) {
      return json({ error: { message: e.message || String(e) } }, 500);
    }
  },
};