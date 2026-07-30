// ---------------------------------------------------------------
// Relais pour Elion : cache les clés API côté serveur
// Gemini + Tavily + Pexels + Google Auth + Notion
// ---------------------------------------------------------------

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const bodyText = request.method === 'POST' ? await request.clone().text() : null;
      let body = {};
      try { body = bodyText ? JSON.parse(bodyText) : {}; } catch(e) {}

      // ---------- 1. Tavily ----------
      if (body.tavily_query) {
        const tavilyRes = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: env.TAVILY_API_KEY,
            query: body.tavily_query,
            max_results: 5,
            include_answer: false,
          }),
        });
        return new Response(await tavilyRes.text(), {
          status: tavilyRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ---------- 2. Pexels ----------
      if (body.pexels_query) {
        const pexelsUrl = 'https://api.pexels.com/v1/search?query=' + encodeURIComponent(body.pexels_query) + '&per_page=5&orientation=square';
        const pexelsRes = await fetch(pexelsUrl, {
          headers: { Authorization: env.PEXELS_API_KEY },
        });
        return new Response(await pexelsRes.text(), {
          status: pexelsRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ---------- 3. Google OAuth ----------
      if (body.google_auth_code) {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: body.google_auth_code,
            client_id: body.client_id || '',
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: body.redirect_uri || '',
            grant_type: 'authorization_code',
            code_verifier: body.code_verifier || '',
          }),
        });
        return new Response(await tokenRes.text(), {
          status: tokenRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ---------- 4. NOTION (nouveau) ----------
      // Le front appelle { notion_path: "/search", notion_body: {...} }
      // ou { notion_path: "/users/me" }
      if (body.notion_path || url.pathname.startsWith('/api/notion')) {
        if (!env.NOTION_TOKEN) {
          return new Response(JSON.stringify({ error: 'NOTION_TOKEN manquant dans env' }), { status: 500, headers: corsHeaders });
        }
        const notionPath = body.notion_path || url.pathname.replace('/api/notion','') || '/search';
        const notionMethod = body.notion_method || (body.notion_body ? 'POST' : 'GET');
        
        const notionRes = await fetch(`https://api.notion.com/v1${notionPath}`, {
          method: notionMethod,
          headers: {
            'Authorization': `Bearer ${env.NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: body.notion_body ? JSON.stringify(body.notion_body) : undefined,
        });
        return new Response(await notionRes.text(), {
          status: notionRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ---------- 5. Gemini (par défaut) ----------
      if (request.method !== 'POST') {
        return new Response('Méthode non autorisée', { status: 405, headers: corsHeaders });
      }

      const model = body.model || 'gemini-2.0-flash';
      const payload = { ...body };
      delete payload.model;
      delete payload.notion_path;
      delete payload.notion_body;
      delete payload.notion_method;

      const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + env.GEMINI_API_KEY;

      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return new Response(await geminiRes.text(), {
        status: geminiRes.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Erreur du relais', details: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};