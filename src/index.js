/**
 * ElionAI Relay — Cloudflare Worker (fusionné + Groq)
 * Variables :
 *   PIXAZO_API_KEY
 *   GROQ_API_KEY            (chat normal)  ← OBLIGATOIRE
 *   GEMINI_API_KEY          (vision / Works)
 *   TAVILY_API_KEY, PEXELS_API_KEY (optionnel)
 *   DISCORD_ / GITHUB_ / LINEAR_ / TURNSTILE_ (optionnel)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const LTX_SUBMIT = [
  'https://gateway.pixazo.ai/ltx-2-5-pro/v1/text-to-video',
  'https://gateway.pixazo.ai/ltx-2-5-lite/v1/text-to-video',
  'https://gateway.pixazo.ai/ltx-video/v1/text-to-video',
  'https://gateway.pixazo.ai/ltx-2-3-text-to-video/v1/ltx-2-3-text-to-video-request',
];
const LTX_STATUS = 'https://gateway.pixazo.ai/v2/requests/status/';

const SONARIA_SUBMIT = [
  'https://gateway.pixazo.ai/stable-audio/v1/text-to-audio',
  'https://gateway.pixazo.ai/stable-audio-open/v1/text-to-audio',
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function mapDuration(d) {
  const n = Number(d) || 6;
  if (n <= 6) return 6;
  if (n <= 8) return 8;
  return 10;
}

function mapResolution(q) {
  const s = String(q || '720p').toLowerCase();
  if (s.includes('1080') || s === 'hd') return '1080p';
  if (s.includes('1440') || s.includes('2k')) return '1440p';
  if (s.includes('2160') || s.includes('4k')) return '2160p';
  return '720p';
}

/* ---------- Fluxion LTX ---------- */
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
        data.request_id || data.requestId || data.id ||
        (data.data && (data.data.request_id || data.data.id));
      if ((res.ok || res.status === 202) && requestId) {
        return json({
          request_id: requestId,
          status: data.status || 'QUEUED',
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
    return json({ error: data.error || data.message || 'Status LTX échoué', status: data.status || 'ERROR', raw: data }, res.status >= 400 ? res.status : 502);
  }

  let videoUrl = null;
  const out = data.output || {};
  if (Array.isArray(out.media_url) && out.media_url[0]) videoUrl = out.media_url[0];
  else if (typeof out.media_url === 'string') videoUrl = out.media_url;
  else if (out.preview_video && out.preview_video.url) videoUrl = out.preview_video.url;
  else if (out.video_url) videoUrl = out.video_url;
  else if (out.url) videoUrl = out.url;
  videoUrl = videoUrl || data.video_url || data.url || (data.result && data.result.video_url) || null;

  return json({ request_id: id, status: data.status || 'UNKNOWN', video_url: videoUrl, url: videoUrl, data });
}

/* ---------- Sonaria ---------- */
async function submitSonaria(body, env) {
  const key = env.PIXAZO_API_KEY;
  if (!key) return json({ error: 'PIXAZO_API_KEY manquante' }, 500);
  const prompt = String(body.pixazo_prompt || '').trim();
  if (!prompt) return json({ error: 'pixazo_prompt manquant' }, 400);

  const payload = { prompt, duration: Number(body.pixazo_duration) || 35 };
  const errors = [];
  for (const url of SONARIA_SUBMIT) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      const requestId = data.request_id || data.requestId || data.id;
      if ((res.ok || res.status === 202) && requestId) {
        return json({ request_id: requestId, status: data.status || 'QUEUED', ...data });
      }
      errors.push({ url, status: res.status, body: data });
    } catch (e) {
      errors.push({ url, error: String(e.message || e) });
    }
  }
  return json({ error: 'Sonaria: aucun endpoint audio accepté', details: errors }, 502);
}

async function pollSonaria(body, env) {
  const key = env.PIXAZO_API_KEY;
  if (!key) return json({ error: 'PIXAZO_API_KEY manquante' }, 500);
  const id = String(body.pixazo_poll_id || '').trim();
  if (!id) return json({ error: 'pixazo_poll_id manquant' }, 400);

  const res = await fetch(LTX_STATUS + encodeURIComponent(id), {
    headers: { 'Ocp-Apim-Subscription-Key': key },
  });
  const data = await res.json().catch(() => ({}));
  let audioUrl = null;
  const out = data.output || {};
  if (Array.isArray(out.media_url) && out.media_url[0]) audioUrl = out.media_url[0];
  else if (typeof out.media_url === 'string') audioUrl = out.media_url;
  else if (out.audio_url) audioUrl = out.audio_url;
  audioUrl = audioUrl || data.audio_url || data.url || null;

  return json({
    request_id: id,
    status: data.status || 'UNKNOWN',
    audio_url: audioUrl,
    url: audioUrl,
    output: data.output,
    error: data.error || null,
    ...data,
  });
}

/* ---------- Gemini ---------- */
async function relayGemini(body, env) {
  const key = env.GEMINI_API_KEY;
  if (!key) return json({ error: 'GEMINI_API_KEY manquante sur le Worker' }, 500);

  const model = body.gemini_model || body.model || 'gemini-3.8-flash';
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

/* ---------- Groq (chat) ---------- */
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
        fluxion: 'pixazo-ltx-2.5',
        routes: ['ltx_prompt', 'ltx_status', 'pixazo_prompt', 'pixazo_poll_id', 'groq', 'gemini', 'tts', 'auth/*'],
      });
    }

    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    if (path.endsWith('/tts')) {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      return handleTts(body);
    }
    if (path.endsWith('/auth/discord')) {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      return authDiscord(body, env);
    }
    if (path.endsWith('/auth/turnstile')) {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      return authTurnstile(body, env);
    }

    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      return json({ error: 'JSON invalide' }, 400);
    }

    if (body.ltx_prompt != null) return submitLtx(body, env);
    if (body.ltx_status) return statusLtx(body, env);
    if (body.pixazo_prompt != null) return submitSonaria(body, env);
    if (body.pixazo_poll_id) return pollSonaria(body, env);
    if (body.pexels_query != null) return pexels(body, env);
    if (body.tavily_query != null) return tavily(body, env);
    if (body.github_oauth) return authGithub(body, env);
    if (body.linear_oauth) return authLinear(body, env);
    if (body.action === 'tts') return handleTts(body);

    // ★ Groq AVANT Gemini
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

    if (
      body.contents ||
      body.force_gemini ||
      body.force_vision ||
      body.has_image ||
      body.gemini_model
    ) {
      return relayGemini(body, env);
    }

    return json({ error: 'Route inconnue', received_keys: Object.keys(body) }, 400);
  },
};