// api/agent.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Você pode configurar CORS via variável CORS_ALLOWLIST na Vercel:
// Ex.: "https://grupodvbr.github.io,https://novo-agente.vercel.app,http://localhost:8080"
const DEFAULT_ALLOWLIST =
  "https://grupodvbr.github.io,https://novo-agente.vercel.app,http://localhost:8080";
const ALLOWLIST = (process.env.CORS_ALLOWLIST || DEFAULT_ALLOWLIST)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export default async function handler(req, res) {
  // ── CORS ───────────────────────────────────────────────────────────
  const origin = req.headers.origin || "";
  if (ALLOWLIST.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // (se quiser liberar tudo durante testes, use: res.setHeader("Access-Control-Allow-Origin", "*"))
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();

  // ── Segurança ──────────────────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: "OPENAI_API_KEY não configurada" });
  }

  // ── Entrada ────────────────────────────────────────────────────────
  const q =
    req.method === "GET"
      ? (req.query?.q ?? "").toString()
      : (req.body?.q ?? "").toString();

  if (!q) {
    return res.status(400).json({
      ok: false,
      error: "Parametro 'q' é obrigatório (GET ?q=... ou POST { q: ... }).",
    });
  }

  try {
    // ── OpenAI Responses API ─────────────────────────────────────────
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "Você é um assistente útil e educado. Responda em pt-BR." },
        { role: "user", content: q },
      ],
      temperature: 0.7,
    });

    const text = response.output_text ?? "";
    return res.status(200).json({ ok: true, text, meta: { model: response.model } });
  } catch (err) {
    console.error("OpenAI error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
