// api/agent.js
import OpenAI from "openai";
import fetch from "node-fetch"; // Necessário no ambiente server-side

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Lista de origens permitidas
const DEFAULT_ALLOWLIST =
  "https://grupodvbr.github.io,https://novo-agente.vercel.app,http://localhost:8080";
const ALLOWLIST = (process.env.CORS_ALLOWLIST || DEFAULT_ALLOWLIST)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// URL da planilha de METAS
const METAS_URL =
  "https://script.google.com/macros/s/AKfycbzyiL6yNCj_FYWiQ2PS88mthToCvWM1wJ0q7CQy8asyg-59L8YezKzFY6d-lgQU0ni3/exec";

export default async function handler(req, res) {
  // ── CORS ───────────────────────────────────────────────────────────
  const origin = req.headers.origin || "";
  if (ALLOWLIST.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();

  // ── Segurança ──────────────────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "OPENAI_API_KEY não configurada" });
  }

  // ── Entrada ────────────────────────────────────────────────────────
  const q =
    req.method === "GET"
      ? (req.query?.q ?? "").toString()
      : (req.body?.q ?? "").toString();

  if (!q) {
    return res.status(400).json({
      ok: false,
      error:
        "Parametro 'q' é obrigatório (GET ?q=... ou POST { q: ... }).",
    });
  }

  try {
    // 1️⃣ Buscar dados da planilha METAS
    let metasData = [];
    try {
      const metasResp = await fetch(METAS_URL);
      metasData = await metasResp.json();
    } catch (e) {
      console.warn("Falha ao buscar METAS:", e.message);
    }

    // 2️⃣ Criar contexto do sistema
    const systemPrompt = `
Você é o assistente do Leonardo, ferramenta de gestão virtual profissional.
Regras:
- Responda sempre em português do Brasil.
- Seja objetivo, claro e educado.
- Sempre formate listas e dados de forma legível.
- Quando houver datas ou valores, use formato brasileiro (DD/MM/AAAA, R$ 0,00).
- Quando não souber a resposta, informe que não tem certeza.
- Não repita sempre a mesma pergunta, seja descontraído.
- Quando o usuário pedir gráficos, gere HTML + JavaScript usando Chart.js, incluindo <canvas> e <script> prontos para uso.
- O HTML retornado será exibido diretamente no navegador, portanto garanta que seja autossuficiente.
- Use sempre os dados reais da planilha quando possível.

📊 Dados de METAS disponíveis:
${JSON.stringify(metasData)}
    `;

    // 3️⃣ Chamar API OpenAI com os dados no contexto
    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: q },
      ],
      temperature: 0.3,
    });

    // 🔹 IMPORTANTE: Agora a resposta pode conter HTML
    const html = response.output_text ?? "";

    return res
      .status(200)
      .json({ ok: true, html, meta: { model: response.model } });
  } catch (err) {
    console.error("OpenAI error:", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
}
