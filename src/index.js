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
      // Le client peut préciser quel modèle utiliser (texte ou image) ;
      // par défaut, on garde le modèle de conversation habituel.
      const model = body.model || 'gemini-3.5-flash';
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
