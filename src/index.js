/**
 * ElionAI Relay — Cloudflare Worker
 * Variables :
 *   INFERENCEPORT_API_KEY  (Fluxion — Vidu Q3)
 *   ACE_MUSIC_API_KEY      (Sonaria — Ace Music)
 *   PIXAZO_API_KEY         (optionnel, fallback)
 *   GROQ_API_KEY
 *   GEMINI_API_KEY
 *   TAVILY_API_KEY, PEXELS_API_KEY (optionnel)
 *   DISCORD_ / GITHUB_ / LINEAR_ / TURNSTILE_ (optionnel)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const IP_BASE = 'https://sharktide-lightning.hf.space';
const FLUXION_TRY = ['vidu-q3', 'vidu-q3-turbo', 'pixverse-v5', 'wan2.7-t2v', 'seedance-2.5-720p'];

const LTX_SUBMIT = [
  'https://gateway.pixazo.ai/ltx-2-5-pro/v1/text-to-video',
  'https://gateway.pixazo.ai/ltx-2-5-lite/v1/text-to-video',
  'https://gateway.pixazo.ai/ltx-video/v1/text-to-video',
  'https://gateway.pixazo.ai/ltx-2-3-text-to-video/v1/ltx-2-3-text-to-video-request',
];
const LTX_STATUS = 'https://gateway.pixazo.ai/v2/requests/status/';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function mapDuration(d) {
  const n = Number(d) || 5;
  if (n < 3) return 3;
  if (n > 8) return 8;
  return Math.round(n);
}

function mapResolution(q) {
  const s = String(q || '720p').toLowerCase();
  if (s.includes('1080') || s === 'hd') return '1080p';
  if (s.includes('1440') || s.includes('2k')) return '1440p';
  if (s.includes('2160') || s.includes('4k')) return '2160p';
  return '720p';
}

function ipHeaders(env) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'ElionAI-Fluxion/1.0',
    Authorization: 'Bearer ' + env.INFERENCEPORT_API_KEY,
  };
}

/* ---------- Fluxion InferencePort (Vidu Q3) ---------- */
async function submitInferencePort(body, env) {
  if (!env.INFERENCEPORT_API_KEY) return null;
  const prompt = String(body.ltx_prompt || body.prompt || '').trim();
  if (!prompt) return null;

  const preferred = String(body.ltx_model || body.model || 'vidu-q3').toLowerCase();
  const models = [preferred, ...FLUXION_TRY.filter((m) => m !== preferred)];
  const duration = mapDuration(body.ltx_duration || body.duration);
  const errors = [];

  for (const model of models) {
    try {
      const res = await fetch(IP_BASE + '/gen/videos', {
        method: 'POST',
        headers: ipHeaders(env),
        body: JSON.stringify({
          model,
          prompt: prompt.slice(0, 800),
          duration,
        }),
      });
      const data = await res.json().catch(() => ({}));
      const id = data.id || data.job_id || data.task_id;
      if ((res.ok || res.status === 202) && id) {
        return json({
          request_id: id,
          status: data.status || 'QUEUED',
          provider: 'inferenceport',
          model,
          polling_url: IP_BASE + '/gen/videos/' + id,
        });
      }
      const msg =
        data.detail ||
        (data.error && data.error.message) ||
        data.error ||
        data.message ||
        ('HTTP ' + res.status);
      errors.push({ model, status: res.status, error: msg });
      const s = String(msg).toLowerCase();
      if (s.includes('not available') || s.includes('unknown model') || res.status === 400) {
        continue;
      }
      return { _fail: true, status: res.status, data, error: msg };
    } catch (e) {
      errors.push({ model, error: String(e.message || e) });
    }
  }
  return {
    _fail: true,
    status: 502,
    error: 'Aucun modèle vidéo accepté',
    data: { details: errors },
  };
}

async function statusInferencePort(id, env) {
  const res = await fetch(IP_BASE + '/gen/videos/' + encodeURIComponent(id), {
    headers: ipHeaders(env),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(
      {
        error: data.detail || data.error || data.message || 'Status InferencePort échoué',
        status: 'ERROR',
        raw: data,
      },
      res.status >= 400 ? res.status : 502
    );
  }

  const st = String(data.status || data.state || '').toLowerCase();
  let videoUrl =
    data.url ||
    data.video_url ||
    data.content_url ||
    (data.output && (data.output.url || data.output.video_url)) ||
    (Array.isArray(data.output && data.output.urls) && data.output.urls[0]) ||
    null;

  if ((st === 'completed' || st === 'succeeded' || st === 'success') && !videoUrl) {
    videoUrl = IP_BASE + '/gen/videos/' + encodeURIComponent(id) + '/content';
  }

  let status = data.status || 'UNKNOWN';
  if (st === 'completed' || st === 'succeeded' || st === 'success') status = 'COMPLETED';
  else if (st === 'failed' || st === 'error') status = 'FAILED';
  else if (st === 'pending' || st === 'queued' || st === 'processing' || st === 'running') {
    status = 'PROCESSING';
  }

  return json({
    request_id: id,
    status,
    video_url: videoUrl,
    url: videoUrl,
    provider: 'inferenceport',
    data,
  });
}

/* ---------- LTX Pixazo (fallback si pas de clé IP) ---------- */
async function submitLtx(body, env) {
  const key = env.PIXAZO_API_KEY;
  if (!key) return json({ error: 'PIXAZO_API_KEY manquante' }, 500);
  const prompt = String(body.ltx_prompt || '').trim();
  if (!prompt) return json({ error: 'ltx_prompt manquant' }, 400);

  const payload = {
    prompt,
    duration: mapDuration(body.ltx_duration),
    resolution: mapResolution(body.ltx_quality),
    aspect_ratio: body.ltx_aspect || '16:9',
    fps: 24,
    generate_audio: body.ltx_sound !== false,
  };

  const endpoints = body.ltx_pro
    ? LTX_SUBMIT
    : [LTX_SUBMIT[1], LTX_SUBMIT[0], LTX_SUBMIT[2], LTX_SUBMIT[3]];

  const errors = [];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': key,
          'Cache-Control': 'no-cache',
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      const requestId =
        data.request_id ||
        data.requestId ||
        data.id ||
        (data.data && (data.data.request_id || data.data.id));
      if ((res.ok || res.status === 202) && requestId) {
        return json({
          request_id: requestId,
          status: data.status || 'QUEUED',
          provider: 'pixazo-ltx',
          polling_url: data.polling_url || LTX_STATUS + requestId,
          endpoint: url,
        });
      }
      errors.push({ url, status: res.status, body: data });
    } catch (e) {
      errors.push({ url, error: String(e.message || e) });
    }
  }
  return json({ error: "Fluxion: aucun endpoint LTX n'a accepté la requête", details: errors }, 502);
}

async function statusLtx(body, env) {
  const key = env.PIXAZO_API_KEY;
  if (!key) return json({ error: 'PIXAZO_API_KEY manquante' }, 500);
  const id = String(body.ltx_status || body.request_id || '').trim();
  if (!id) return json({ error: 'ltx_status manquant' }, 400);

  const res = await fetch(LTX_STATUS + encodeURIComponent(id), {
    headers: { 'Ocp-Apim-Subscription-Key': key },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(
      { error: data.error || data.message || 'Status LTX échoué', status: data.status || 'ERROR', raw: data },
      res.status >= 400 ? res.status : 502
    );
  }

  let videoUrl = null;
  const out = data.output || {};
  if (Array.isArray(out.media_url) && out.media_url[0]) videoUrl = out.media_url[0];
  else if (typeof out.media_url === 'string') videoUrl = out.media_url;
  else if (out.preview_video && out.preview_video.url) videoUrl = out.preview_video.url;
  else if (out.video_url) videoUrl = out.video_url;
  else if (out.url) videoUrl = out.url;
  videoUrl = videoUrl || data.video_url || data.url || (data.result && data.result.video_url) || null;

  return json({
    request_id: id,
    status: data.status || 'UNKNOWN',
    video_url: videoUrl,
    url: videoUrl,
    provider: 'pixazo-ltx',
    data,
  });
}

async function submitFluxion(body, env) {
  if (env.INFERENCEPORT_API_KEY) {
    const ip = await submitInferencePort(body, env);
    if (ip && !ip._fail) return ip;
    const detail = (ip && (ip.data || ip.error)) || 'InferencePort a refusé la requête';
    const st = (ip && ip.status) || 502;
    return json(
      {
        error:
          typeof detail === 'string'
            ? detail
            : detail.detail || detail.error || JSON.stringify(detail).slice(0, 300),
        provider: 'inferenceport',
        status: st,
        details: ip && ip.data && ip.data.details,
        hint: st === 401 ? 'Vérifie INFERENCEPORT_API_KEY' : 'Aucun modèle vidéo disponible pour ce compte',
      },
      st >= 400 ? st : 502
    );
  }
  if (env.PIXAZO_API_KEY) return submitLtx(body, env);
  return json({ error: 'INFERENCEPORT_API_KEY manquante sur le Worker' }, 500);
}

async function statusFluxion(body, env) {
  const id = String(body.ltx_status || body.request_id || '').trim();
  if (!id) return json({ error: 'ltx_status manquant' }, 400);

  if (env.INFERENCEPORT_API_KEY && (body.provider === 'inferenceport' || id.includes('-') || body.force_ip)) {
    try {
      return await statusInferencePort(id, env);
    } catch (_) {}
  }
  if (env.PIXAZO_API_KEY) return statusLtx(body, env);
  if (env.INFERENCEPORT_API_KEY) return statusInferencePort(id, env);
  return json({ error: 'Aucune clé pour poll Fluxion' }, 500);
}

/* ---------- Sonaria (Ace Music) ---------- */
async function submitSonariaAce(body, env) {
  const key = env.ACE_MUSIC_API_KEY;
  if (!key) return json({ error: 'ACE_MUSIC_API_KEY manquante sur le Worker' }, 500);

  const prompt = String(body.ace_prompt || body.pixazo_prompt || body.prompt || '').trim();
  if (!prompt) return json({ error: 'ace_prompt manquant' }, 400);

  const duration = Math.max(10, Math.min(60, Number(body.ace_duration || body.pixazo_duration) || 30));

  const payload = {
    model: 'acemusic/acestep-v15-turbo',
    messages: [{ role: 'user', content: prompt.slice(0, 500) }],
    sample_mode: true,
    task_type: 'text2music',
    audio_config: {
      duration: duration,
      instrumental: true,
      format: 'mp3',
    },
  };

  const res = await fetch('https://api.acemusic.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(
      {
        error:
          data.detail ||
          (data.error && data.error.message) ||
          data.error ||
          data.message ||
          ('HTTP ' + res.status),
        raw: data,
      },
      res.status >= 400 ? res.status : 502
    );
  }

  let audioUrl = null;
  try {
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (msg) {
      // Format officiel Ace : message.audio[0].audio_url.url
      if (Array.isArray(msg.audio) && msg.audio.length) {
        const a0 = msg.audio[0];
        if (a0 && a0.audio_url && a0.audio_url.url) audioUrl = a0.audio_url.url;
        else if (a0 && a0.url) audioUrl = a0.url;
        else if (typeof a0 === 'string') audioUrl = a0;
      } else if (msg.audio && msg.audio.data) {
        audioUrl = 'data:audio/mpeg;base64,' + msg.audio.data;
      } else if (typeof msg.audio === 'string') {
        audioUrl = msg.audio.startsWith('data:') ? msg.audio : 'data:audio/mpeg;base64,' + msg.audio;
      }
    }
    if (!audioUrl && data.audio_url) audioUrl = data.audio_url;
    if (!audioUrl && data.audio_base64) audioUrl = 'data:audio/mpeg;base64,' + data.audio_base64;
  } catch (_) {}

  if (!audioUrl) {
    return json({ error: 'Ace Music a répondu sans audio', raw: data }, 502);
  }

  return json({
    ok: true,
    provider: 'ace-music',
    status: 'COMPLETED',
    audio_url: audioUrl,
    url: audioUrl,
  });
}

/* ---------- Gemini ---------- */
async function relayGemini(body, env) {
  const key = env.GEMINI_API_KEY;
  if (!key) return json({ error: 'GEMINI_API_KEY manquante sur le Worker' }, 500);

  const model = body.gemini_model || body.model || 'gemini-2.5-flash';
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) +
    ':generateContent?key=' +
    encodeURIComponent(key);

  const payload = { contents: body.contents || body.messages || [] };
  if (body.systemInstruction) payload.systemInstruction = body.systemInstruction;
  if (body.system_instruction) payload.systemInstruction = body.system_instruction;
  if (body.generationConfig) payload.generationConfig = body.generationConfig;
  if (body.tools) payload.tools = body.tools;
  if (body.safetySettings) payload.safetySettings = body.safetySettings;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: data.error || data, status: res.status }, res.status);
  return json(data);
}

/* ---------- Groq ---------- */
function geminiContentsToOpenAIMessages(body) {
  const messages = [];
  const sysParts =
    (body.system_instruction && body.system_instruction.parts) ||
    (body.systemInstruction && body.systemInstruction.parts) ||
    [];
  const sys = sysParts.map((p) => p.text || '').filter(Boolean).join('\n') || body.system || '';
  if (sys) messages.push({ role: 'system', content: sys });

  for (const c of body.contents || []) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    let text = '';
    for (const p of c.parts || []) {
      if (typeof p.text === 'string') text += p.text;
    }
    if (text.trim()) messages.push({ role, content: text });
  }

  if (Array.isArray(body.messages) && body.messages.length) {
    if (!messages.length || (messages.length === 1 && messages[0].role === 'system')) {
      return body.messages;
    }
  }
  return messages;
}

async function relayGroq(body, env) {
  const key = env.GROQ_API_KEY;
  if (!key) return json({ error: 'GROQ_API_KEY manquante sur le Worker' }, 500);

  const model = body.groq_model || body.model || 'openai/gpt-oss-120b';
  const messages = geminiContentsToOpenAIMessages(body);
  if (!messages.length) return json({ error: 'Aucun message à envoyer à Groq' }, 400);

  const payload = {
    model,
    messages,
    temperature:
      body.generationConfig && body.generationConfig.temperature != null
        ? body.generationConfig.temperature
        : 0.7,
    max_tokens: (body.generationConfig && body.generationConfig.maxOutputTokens) || 8192,
  };
  if (body.reasoning_format) payload.reasoning_format = body.reasoning_format;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ error: data.error || data, status: res.status }, res.status >= 400 ? res.status : 502);
  }

  const text =
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';

  return json({
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
    groq: data,
  });
}

/* ---------- Pexels / Tavily / TTS / Auth ---------- */
async function pexels(body, env) {
  const key = env.PEXELS_API_KEY;
  if (!key) return json({ photos: [], error: 'PEXELS_API_KEY manquante' }, 200);
  const q = encodeURIComponent(String(body.pexels_query || '').slice(0, 80));
  const res = await fetch('https://api.pexels.com/v1/search?query=' + q + '&per_page=8', {
    headers: { Authorization: key },
  });
  const data = await res.json().catch(() => ({ photos: [] }));
  return json(data, res.ok ? 200 : res.status);
}

async function tavily(body, env) {
  const key = env.TAVILY_API_KEY;
  if (!key) return json({ text: '', results: [], error: 'TAVILY_API_KEY manquante' }, 200);
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query: String(body.tavily_query || '').slice(0, 400),
      max_results: 5,
      include_answer: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return json({ text: data.answer || '', results: data.results || [], ...data }, res.ok ? 200 : res.status);
}

async function handleTts(body) {
  const text = String(body.text || '').slice(0, 180);
  const lang = body.lang || 'fr';
  if (!text) return new Response('Missing text', { status: 400, headers: CORS });
  const ttsUrl =
    'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' +
    encodeURIComponent(lang) +
    '&q=' +
    encodeURIComponent(text);
  const r = await fetch(ttsUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://translate.google.com/',
    },
  });
  if (!r.ok) return new Response('TTS upstream error', { status: 502, headers: CORS });
  const audio = await r.arrayBuffer();
  return new Response(audio, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...CORS },
  });
}

async function authDiscord(body, env) {
  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return json({ error: 'Discord non configuré sur le Worker' }, 500);
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code: body.code || '',
    redirect_uri: body.redirect_uri || '',
  });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  return json(data, res.ok ? 200 : res.status);
}

async function authTurnstile(body, env) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return json({ success: true, skipped: true });
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: body.token || body.response || '' }),
  });
  const data = await res.json().catch(() => ({ success: false }));
  return json(data);
}

async function authGithub(body, env) {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return json({ error: 'GitHub non configuré' }, 500);
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: body.code,
      redirect_uri: body.redirect_uri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return json(data, res.ok ? 200 : res.status);
}

async function authLinear(body, env) {
  const clientId = env.LINEAR_CLIENT_ID || body.client_id;
  const clientSecret = env.LINEAR_CLIENT_SECRET || body.client_secret;
  if (!clientId || !clientSecret) return json({ error: 'Linear non configuré' }, 500);
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: body.code || '',
      redirect_uri: body.redirect_uri || '',
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  return json(data, res.ok ? 200 : res.status);
}

/* ---------- Router ---------- */
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET') {
      return json({
        ok: true,
        service: 'Elion relay',
        fluxion: env.INFERENCEPORT_API_KEY ? 'vidu-q3+fallback' : 'pixazo-ltx',
        sonaria: env.ACE_MUSIC_API_KEY ? 'ace-music' : 'off',
        has_ip_key: !!env.INFERENCEPORT_API_KEY,
        has_ace_key: !!env.ACE_MUSIC_API_KEY,
        key_len: env.INFERENCEPORT_API_KEY ? String(env.INFERENCEPORT_API_KEY).length : 0,
        models: FLUXION_TRY,
        routes: ['ltx_prompt', 'ltx_status', 'ace_prompt', 'pixazo_prompt', 'groq', 'gemini', 'tts', 'auth/*'],
      });
    }

    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    if (path.endsWith('/tts')) {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {}
      return handleTts(body);
    }
    if (path.endsWith('/auth/discord')) {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {}
      return authDiscord(body, env);
    }
    if (path.endsWith('/auth/turnstile')) {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {}
      return authTurnstile(body, env);
    }

    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      return json({ error: 'JSON invalide' }, 400);
    }

    if (body.ltx_prompt != null) return submitFluxion(body, env);
    if (body.ltx_status) return statusFluxion(body, env);
    if (body.ace_prompt != null || body.pixazo_prompt != null) return submitSonariaAce(body, env);
    if (body.pexels_query != null) return pexels(body, env);
    if (body.tavily_query != null) return tavily(body, env);
    if (body.github_oauth) return authGithub(body, env);
    if (body.linear_oauth) return authLinear(body, env);
    if (body.action === 'tts') return handleTts(body);

    const wantGroq =
      body.provider === 'groq' ||
      !!body.groq_model ||
      (typeof body.model === 'string' &&
        (body.model.includes('gpt-oss') ||
          body.model.includes('qwen') ||
          body.model.includes('llama') ||
          body.model.includes('groq')));

    if (wantGroq && !body.force_gemini && !body.force_vision && !body.has_image) {
      return relayGroq(body, env);
    }

    if (body.contents || body.force_gemini || body.force_vision || body.has_image || body.gemini_model) {
      return relayGemini(body, env);
    }

    return json({ error: 'Route inconnue', received_keys: Object.keys(body) }, 400);
  },
};