// api/agent.js
import OpenAI from "openai";
import fetch from "node-fetch"; // pode remover em Node 18+, mas mantém compatibilidade

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

// --------- Helpers de erro ----------
const isQuotaError = (msg = "") =>
  /insufficient_quota|exceeded your current quota|billing/i.test(msg);

const isAuthError = (msg = "") =>
  /401|invalid api key|unauthorized/i.test(msg);

function mapOpenAIError(err) {
  const msg = String(err?.message || err || "");
  const devMessage = `OpenAI error: ${msg}`;

  if (isQuotaError(msg)) {
    return {
      userMessage:
        "🤖 Estou temporariamente indisponível por falta de créditos na IA. Assim que o saldo for liberado, volto a responder normalmente.",
      code: "INSUFFICIENT_QUOTA",
      devMessage,
    };
  }
  if (isAuthError(msg)) {
    return {
      userMessage:
        "⚠️ Não consegui acessar o provedor de IA. Verifique a chave de API.",
      code: "AUTH_ERROR",
      devMessage,
    };
  }
  return {
    userMessage:
      "⚠️ Tive um problema ao processar agora. Tente novamente em instantes.",
    code: "GENERIC_ERROR",
    devMessage,
  };
}

// --------- Chamada ao modelo (com fallback) ----------
async function callModel({ systemPrompt, q }) {
  // 1ª tentativa: gpt-4o
  try {
    const r = await client.responses.create({
      model: "gpt-4o",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: q },
      ],
      temperature: 0.3,
    });
    const text =
      r?.output_text ??
      r?.choices?.[0]?.message?.content ??
      "";
    return { ok: true, text, model: r?.model || "gpt-4o" };
  } catch (e) {
    const msg = String(e?.message || e || "");
    console.error("Erro no gpt-4o:", msg);

    // Fallback somente se for erro de quota
    if (isQuotaError(msg)) {
      try {
        const r2 = await client.responses.create({
          model: "gpt-4o-mini",
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: q },
          ],
          temperature: 0.3,
        });
        const text2 =
          r2?.output_text ??
          r2?.choices?.[0]?.message?.content ??
          "";
        return { ok: true, text: text2, model: r2?.model || "gpt-4o-mini" };
      } catch (e2) {
        // se o fallback também falhar, propaga
        throw e2;
      }
    }
    // se não for quota, propaga o erro original
    throw e;
  }
}

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
      error: "Parâmetro 'q' é obrigatório (GET ?q=... ou POST { q: ... }).",
    });
  }

  // ── Buscar METAS (sem travar a resposta se falhar) ────────────────
  let metasData = [];
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 8000); // 8s timeout
    const metasResp = await fetch(METAS_URL, { signal: controller.signal });
    clearTimeout(id);
    metasData = await metasResp.json();
  } catch (e) {
    console.warn("Falha ao buscar METAS:", e?.message || e);
  }

  // ── Prompt do sistema ─────────────────────────────────────────────
  const systemPrompt = `
Você é o assistente do Leonardo, ferramenta de gestão virtual profissional.
Regras:
- Responda sempre em português do Brasil.
- Seja objetivo, claro e educado.
- Sempre formate listas e dados de forma legível.
- Quando houver datas ou valores, use formato brasileiro (DD/MM/AAAA, R$ 0,00).
- Quando não souber a resposta, informe que não tem certeza.
- Não repita sempre a mesma pergunta, seja descontraído.

Dados disponíveis para consulta:
- METAS: ${JSON.stringify(metasData)}
  `.trim();

  try {
    const out = await callModel({ systemPrompt, q });
    return res
      .status(200)
      .json({ ok: true, text: out.text, meta: { model: out.model } });
  } catch (err) {
    const mapped = mapOpenAIError(err);
    console.error(mapped.devMessage);
    // status 200 para que o WhatsApp-webhook possa ler a mensagem amigável
    return res
      .status(200)
      .json({ ok: false, userMessage: mapped.userMessage, code: mapped.code });
  }
}
