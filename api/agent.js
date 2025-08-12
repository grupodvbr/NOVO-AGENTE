// api/agent.js
export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────
  // Troque pelo seu endereço do GitHub Pages:
  const ALLOWED_ORIGIN = 'https://grupodvbr.github.io/IA/'; // <- ajuste aqui!
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Captura de q por GET/POST ────────────────────────────────────────
  const q =
    req.method === 'GET'
      ? (req.query?.q ?? '').toString()
      : (req.body?.q ?? '').toString();

  // Aqui você poderia chamar a OpenAI usando sua OPENAI_API_KEY (na Vercel)
  // Por enquanto só ecoa a pergunta:
  return res.status(200).json({
    sucesso: true,
    mensagem: 'API funcionando!',
    perguntaRecebida: q,
  });
}
