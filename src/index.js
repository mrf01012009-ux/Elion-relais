// ---------------------------------------------------------------
// Relais pour Elion : cache la clé API Gemini côté serveur.
// Le navigateur du visiteur ne voit jamais la clé.
// ---------------------------------------------------------------

export default {
  async fetch(request, env) {
    // Autorise l'appel depuis le navigateur (CORS)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Méthode non autorisée', { status: 405, headers: corsHeaders });
    }

    try {
      const body = await request.json();

      // Recherche web via Tavily (utilisée par le mode "Search" d'Elion)
      if (body.tavily_query) {
        const tavilyRes = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: env.TAVILY_API_KEY, // <- clé Tavily, uniquement sur le serveur
            query: body.tavily_query,
            max_results: 5,
            include_answer: false,
          }),
        });
        const tavilyData = await tavilyRes.text();
        return new Response(tavilyData, {
          status: tavilyRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Recherche de vraies photos via Pexels (galerie d'images "parle-moi de...")
      if (body.pexels_query) {
        const pexelsUrl =
          'https://api.pexels.com/v1/search?query=' +
          encodeURIComponent(body.pexels_query) +
          '&per_page=5&orientation=square';
        const pexelsRes = await fetch(pexelsUrl, {
          headers: { Authorization: env.PEXELS_API_KEY }, // <- clé Pexels, uniquement sur le serveur
        });
        const pexelsData = await pexelsRes.text();
        return new Response(pexelsData, {
          status: pexelsRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Échange du code Google OAuth contre un accès (connexion "Continuer avec Google")
      if (body.google_auth_code) {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: body.google_auth_code,
            client_id: body.client_id || '',
            client_secret: env.GOOGLE_CLIENT_SECRET, // <- Secret Google, uniquement sur le serveur
            redirect_uri: body.redirect_uri || '',
            grant_type: 'authorization_code',
            code_verifier: body.code_verifier || '',
          }),
        });
        const tokenData = await tokenRes.text();
        return new Response(tokenData, {
          status: tokenRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }


      // par défaut, on garde le modèle de conversation habituel.
      const model = body.model || 'gemini-3.5-flash-lite';
      const payload = { ...body };
      delete payload.model; // Google ne connaît pas ce champ, on ne le transmet pas

      const url =
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        model +
        ':generateContent?key=' +
        env.GEMINI_API_KEY; // <- la clé vit ici, uniquement sur le serveur

      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await geminiRes.text();
      return new Response(data, {
        status: geminiRes.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Erreur du relais' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};
