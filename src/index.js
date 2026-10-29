/**
 * ElionAI Relay — Cloudflare Worker
 * Secrets / vars :
 *   AGNES_API_KEY          (Fluxion principal — Agnes Video 2.5 Flash)
 *   PIXAZO_API_KEY         (Sonaria + fallback LTX)
 *   ACE_MUSIC_API_KEY      (Sonaria Ace Music)
 *   GROQ_API_KEY
 *   GEMINI_API_KEY
 *   TAVILY_API_KEY, PEXELS_API_KEY (optionnel)
 * Binding :
 *   AI                     (Workers AI — Illustro Flux family)
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
  'https://gateway.pixazo.ai/ltx-2-3-text-to-video/v1/ltx-2-3-text-to-video-request',
];
const LTX_STATUS = 'https://gateway.pixazo.ai/v2/requests/status/';

const ACE_BASE = 'https://api.ace-music.com'; // ajuste si ton endpoint Ace diffère

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ───────── Fluxion: Agnes 2.5 Flash ───────── */

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
  if (f.includes('9:16') || f.includes('portrait') || f.includes('vertical')) return '9:16';
  if (f.includes('1:1') || f.includes('square')) return '1:1';
  if (f.includes('4:3')) return '4:3';
  return '16:9';
}

async function submitFluxionAgnes(prompt, opts, env) {
  const key = env.AGNES_API_KEY;
  if (!key) return { ok: false, error: 'AGNES_API_KEY manquante' };

  const body = {
    model: AGNES_MODEL,
    prompt: String(prompt || '').slice(0, 2000),
    mode: 'text',
    seconds: mapAgnesSeconds(opts?.duration || opts?.seconds || 5),
    size: '720P',
    aspect_ratio: mapAgnesAspect(opts?.aspect || opts?.format || '16:9'),
  };

  const res = await fetch(`${AGNES_BASE}/v1/videos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data.detail || data.error?.message || data.message || `Agnes HTTP ${res.status}`,
      status: res.status,
      raw: data,
    };
  }

  const videoId = data.video_id || data.id;
  if (!videoId) return { ok: false, error: 'Agnes: pas de video_id', raw: data };

  return {
    ok: true,
    provider: 'agnes-flash',
    video_id: videoId,
    task_id: data.task_id || data.id || videoId,
  };
}

async function pollFluxionAgnes(videoId, env, maxTries = 90) {
  const key = env.AGNES_API_KEY;
  if (!key) return { ok: false, error: 'AGNES_API_KEY manquante' };

  for (let i = 0; i < maxTries; i++) {
    const url =
      `\( {AGNES_BASE}/agnesapi?video_id= \){encodeURIComponent(videoId)}` +
      `&model_name=${encodeURIComponent(AGNES_MODEL)}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await res.json().catch(() => ({}));
    const status = String(data.status || '').toLowerCase();

    if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
      const videoUrl = data.url || data.video_url || data.output?.url;
      if (!videoUrl) return { ok: false, error: 'Agnes completed sans url', raw: data };
      return { ok: true, provider: 'agnes-flash', url: videoUrl, raw: data };
    }
    if (['failed', 'error', 'cancelled'].includes(status)) {
      return {
        ok: false,
        error: data.error?.message || data.error || data.detail || 'Agnes failed',
        raw: data,
      };
    }
    await sleep(1500);
  }
  return { ok: false, error: 'Agnes timeout' };
}

/* ───────── Fluxion: LTX (Pixazo) fallback ───────── */

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
      const requestId =
        data.request_id || data.id || data.job_id || data.data?.request_id;
      if (!requestId) {
        lastErr = 'LTX: pas de request_id';
        continue;
      }
      return pollFluxionLtx(requestId, env);
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { ok: false, error: lastErr };
}

async function pollFluxionLtx(requestId, env, maxTries = 60) {
  const key = env.PIXAZO_API_KEY;
  for (let i = 0; i < maxTries; i++) {
    const res = await fetch(LTX_STATUS + encodeURIComponent(requestId), {
      headers: {
        Authorization: `Bearer ${key}`,
        'x-api-key': key,
      },
    });
    const data = await res.json().catch(() => ({}));
    const status = String(data.status || data.state || '').toLowerCase();
    const url =
      data.video_url ||
      data.url ||
      data.output?.url ||
      data.result?.url ||
      (Array.isArray(data.outputs) && data.outputs[0]?.url);

    if (url && (status.includes('success') || status.includes('complete') || status === 'done')) {
      return { ok: true, provider: 'ltx', url, raw: data };
    }
    if (status.includes('fail') || status.includes('error')) {
      return { ok: false, error: data.message || data.error || 'LTX failed', raw: data };
    }
    await sleep(2000);
  }
  return { ok: false, error: 'LTX timeout' };
}

/** Fluxion: Agnes → LTX */
async function runFluxion(prompt, opts, env) {
  const agnesSubmit = await submitFluxionAgnes(prompt, opts, env);
  if (agnesSubmit.ok) {
    const done = await pollFluxionAgnes(agnesSubmit.video_id, env);
    if (done.ok) return done;
  }

  const ltx = await submitFluxionLtx(prompt, opts, env);
  if (ltx.ok) return ltx;

  return {
    ok: false,
    error: agnesSubmit.error || ltx.error || 'Fluxion indisponible',
  };
}

/* ───────── Sonaria: Ace Music ───────── */

async function runSonaria(prompt, opts, env) {
  const key = env.ACE_MUSIC_API_KEY || env.PIXAZO_API_KEY;
  if (!key) return { ok: false, error: 'ACE_MUSIC_API_KEY manquante' };

  const duration = Math.min(35, Math.max(5, Number(opts?.duration) || 15));

  // Payload type chat/completions audio — adapte si ton Ace endpoint diffère
  const res = await fetch(`${ACE_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'ace-music',
      messages: [{ role: 'user', content: String(prompt || '').slice(0, 1500) }],
      task_type: 'text2music',
      audio_config: {
        duration,
        instrumental: opts?.instrumental !== false,
        format: 'mp3',
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data.error?.message || data.message || `Ace HTTP ${res.status}`,
      raw: data,
    };
  }

  const audioUrl =
    data.choices?.[0]?.message?.audio?.[0]?.audio_url?.url ||
    data.choices?.[0]?.message?.audio_url ||
    data.audio_url ||
    data.url;

  if (!audioUrl) {
    return { ok: false, error: 'Ace Music a répondu sans audio', raw: data };
  }
  return { ok: true, provider: 'ace-music', url: audioUrl, raw: data };
}

/* ───────── Illustro: Workers AI Flux family ───────── */

async function runIllustro(prompt, opts, env) {
  if (!env.AI) return { ok: false, error: 'Workers AI non lié (binding AI)' };

  const p = String(prompt || '').slice(0, 2000);
  const width = Number(opts?.width) || 1024;
  const height = Number(opts?.height) || 1024;
  const useFlux2 = opts?.engine !== 'schnell' && opts?.tier !== 'schnell';

  const flux2Models = [
    '@cf/black-forest-labs/flux-2-klein-4b',
    '@cf/black-forest-labs/flux-2-dev',
  ];
  const schnell = '@cf/black-forest-labs/flux-1-schnell';

  async function tryModel(model, multipart) {
    if (multipart) {
      const form = new FormData();
      form.append('prompt', p);
      form.append('width', String(width));
      form.append('height', String(height));
      const r = await env.AI.run(model, form);
      return r;
    }
    return env.AI.run(model, { prompt: p, width, height });
  }

  let lastErr = 'Illustro failed';
  if (useFlux2) {
    for (const model of flux2Models) {
      try {
        const r = await tryModel(model, true);
        const b64 =
          r?.image ||
          r?.images?.[0] ||
          (typeof r === 'string' ? r : null);
        if (b64) {
          return {
            ok: true,
            provider: 'flux-2',
            model,
            image: typeof b64 === 'string' ? b64 : null,
            raw: r,
          };
        }
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
  }

  try {
    const r = await tryModel(schnell, false);
    const b64 = r?.image || r?.images?.[0] || (typeof r === 'string' ? r : null);
    if (b64) {
      return {
        ok: true,
        provider: 'flux-1-schnell',
        model: schnell,
        image: typeof b64 === 'string' ? b64 : null,
        warning: useFlux2 ? 'fallback_schnell' : undefined,
        raw: r,
      };
    }
  } catch (e) {
    lastErr = e.message || String(e);
  }

  return { ok: false, error: lastErr };
}

/* ───────── Chat: Groq ───────── */

async function runGroq(messages, env) {
  const key = env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'GROQ_API_KEY manquante' };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: messages || [],
      temperature: 0.7,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data.error?.message || `Groq HTTP ${res.status}`, raw: data };
  }
  return {
    ok: true,
    text: data.choices?.[0]?.message?.content || '',
    raw: data,
  };
}

/* ───────── Router ───────── */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // Health
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({
        ok: true,
        service: 'elion-relay',
        fluxion: env.AGNES_API_KEY ? 'agnes-video-2.5-flash' : 'off',
        fluxion_fallback: env.PIXAZO_API_KEY ? 'ltx' : 'off',
        sonaria: env.ACE_MUSIC_API_KEY || env.PIXAZO_API_KEY ? 'ace-music' : 'off',
        illustro: env.AI ? 'flux-2-family' : 'off',
        has_ai_binding: !!env.AI,
        has_agnes: !!env.AGNES_API_KEY,
        has_groq: !!env.GROQ_API_KEY,
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const action = body.action || body.type || url.pathname.replace(/^\//, '');

    try {
      // ── Fluxion (format app Elion : ltx_prompt / ltx_status) ──
      if (body.ltx_prompt || body.fluxion_prompt || body.video_prompt) {
        const prompt = body.ltx_prompt || body.fluxion_prompt || body.video_prompt || body.prompt || '';
        const opts = {
          duration: body.ltx_duration || body.duration || 5,
          aspect: body.ltx_aspect || body.aspect || '16:9',
          quality: body.ltx_quality || body.quality || '720p',
          sound: body.ltx_sound !== false,
        };

        // Agnes submit → renvoie un id pour le poll de l'app
        const agnes = await submitFluxionAgnes(prompt, opts, env);
        if (agnes.ok) {
          return json({
            ok: true,
            request_id: agnes.video_id,
            id: agnes.video_id,
            provider: 'agnes-flash',
            status: 'queued',
          });
        }

        // Fallback LTX immédiat (submit+poll côté worker si pas d'id async simple)
        const ltx = await submitFluxionLtx(prompt, opts, env);
        if (ltx.ok) {
          return json({
            ok: true,
            request_id: 'done-' + Date.now(),
            id: 'done-' + Date.now(),
            provider: 'ltx',
            status: 'COMPLETED',
            video_url: ltx.url,
            url: ltx.url,
          });
        }

        return json({
          ok: false,
          error: agnes.error || ltx.error || 'Fluxion indisponible',
        }, 502);
      }

      // Poll Fluxion (app envoie { ltx_status: id })
      if (body.ltx_status) {
        const id = String(body.ltx_status);
        const provider = body.provider || '';

        // Résultat déjà prêt (fallback LTX synchrone)
        if (id.startsWith('done-')) {
          return json({ ok: false, error: 'Job déjà terminé côté client', status: 'FAILED' }, 400);
        }

        // Poll Agnes
        if (!provider || provider === 'agnes-flash' || id.startsWith('video_') || id.startsWith('task_')) {
          const key = env.AGNES_API_KEY;
          if (!key) return json({ error: 'AGNES_API_KEY manquante', status: 'FAILED' }, 500);

          const pollUrl =
            `\( {AGNES_BASE}/agnesapi?video_id= \){encodeURIComponent(id)}` +
            `&model_name=${encodeURIComponent(AGNES_MODEL)}`;
          const res = await fetch(pollUrl, {
            headers: { Authorization: `Bearer ${key}` },
          });
          const data = await res.json().catch(() => ({}));
          const status = String(data.status || '').toLowerCase();

          if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
            const videoUrl = data.url || data.video_url || data.output?.url;
            return json({
              ok: true,
              status: 'COMPLETED',
              video_url: videoUrl,
              url: videoUrl,
              provider: 'agnes-flash',
              raw: data,
            });
          }
          if (['failed', 'error', 'cancelled'].includes(status)) {
            return json({
              ok: false,
              status: 'FAILED',
              error: data.error?.message || data.error || data.detail || 'Agnes failed',
              raw: data,
            });
          }
          // encore en cours
          return json({
            ok: true,
            status: 'PROCESSING',
            progress: data.progress || 0,
            provider: 'agnes-flash',
          });
        }

        // Poll LTX classique
        const key = env.PIXAZO_API_KEY;
        if (!key) return json({ error: 'PIXAZO_API_KEY manquante', status: 'FAILED' }, 500);
        const res = await fetch(LTX_STATUS + encodeURIComponent(id), {
          headers: { Authorization: `Bearer ${key}`, 'x-api-key': key },
        });
        const data = await res.json().catch(() => ({}));
        const st = String(data.status || data.state || '').toLowerCase();
        const videoUrl =
          data.video_url || data.url || data.output?.url || data.result?.url ||
          (Array.isArray(data.outputs) && data.outputs[0]?.url);

        if (videoUrl && (st.includes('success') || st.includes('complete') || st === 'done')) {
          return json({ ok: true, status: 'COMPLETED', video_url: videoUrl, url: videoUrl, provider: 'ltx' });
        }
        if (st.includes('fail') || st.includes('error')) {
          return json({ ok: false, status: 'FAILED', error: data.message || data.error || 'LTX failed' });
        }
        return json({ ok: true, status: 'PROCESSING', provider: 'ltx' });
      }

      // Sonaria / Illustro / Chat (inchangé)
      if (action === 'sonaria' || action === 'audio' || body.sonaria_prompt || body.audio_prompt) {
        const prompt = body.prompt || body.sonaria_prompt || body.audio_prompt || '';
        const result = await runSonaria(prompt, body, env);
        return json(result, result.ok ? 200 : 502);
      }

      if (action === 'illustro' || action === 'image' || body.illustro_prompt || body.image_prompt) {
        const prompt = body.prompt || body.illustro_prompt || body.image_prompt || '';
        const result = await runIllustro(prompt, body, env);
        return json(result, result.ok ? 200 : 502);
      }

      if (action === 'chat' || action === 'groq' || body.messages) {
        const result = await runGroq(body.messages, env);
        return json(result, result.ok ? 200 : 502);
      }

      return json({ error: 'Unknown action', action, keys: Object.keys(body || {}) }, 400);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 500);
    }