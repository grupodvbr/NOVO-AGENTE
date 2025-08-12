// api/agent.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Ajuste isto via variável de ambiente para o domínio do seu GitHub Pages.
// Ex.: FRONTEND_ORIGIN=https://grupodvbr.github.io  (ou  https://grupodvbr.github.io/NOVO-AGENTE)
const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN || "https://grupodvbr.github.io/IA/";

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // ── Segurança básica ─────────────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "OPENAI_API_KEY não configurada na Vercel.",
    });
  }

  // ── Captura a pergunta (q) ───────────────────────────────────────────
  const q =
    req.method === "GET"
      ? (req.query?.q ?? "").toString()
      : (req.body?.q ?? "").toString();

  if (!q) {
    return res.status(400).json({
      ok: false,
      error: "Parametro 'q' é obrigatório (via GET ?q=... ou POST { q: ... }).",
    });
  }

  try {
    // ── Chamada à OpenAI Responses API ────────────────────────────────
    // Doc: https://platform.openai.com/docs/guides/responses
    const response = await client.responses.create({
      model: "gpt-4.1-mini", // você pode trocar por gpt-4o-mini, gpt-4.1, etc.
      // "input" aceita string simples; response.output_text já vem pronto.
      input: [
        {
          role: "system",
          content:
            "Você é um assistente útil, direto e educado. Responda em português do Brasil.",
        },
        { role: "user", content: q },
      ],
      temperature: 0.7,
      // Se quiser respostas mais curtas/longas, ajuste max_output_tokens:
      // max_output_tokens: 500,
    });

    // O SDK v4 expõe o texto final em `output_text`
    const text = response.output_text ?? "";

    return res.status(200).json({
      ok: true,
      text,
      // opcional: devolve partes úteis para depuração
      meta: {
        model: response.model,
        // tokens: response.usage?.output_tokens, // quando disponível
      },
    });
  } catch (err) {
    console.error("OpenAI error:", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
}
