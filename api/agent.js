// api/agent.js
import OpenAI from "openai";
// Em Node 18+ o fetch já é global. Se quiser, pode remover a linha abaixo.
// import fetch from "node-fetch";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Prompt base
const systemPrompt =
  "Você é um assistente do Grupo DV. Responda de forma objetiva.";

// ---- helpers de erro ----
function mapOpenAIError(err) {
  const msg = String(err?.message || err || "");
  const dev = `OpenAI error: ${msg}`;

  // Falta de créditos / orçamento / quota
  if (
    /insufficient_quota/i.test(msg) ||
    /exceeded your current quota/i.test(msg) ||
    /billing/i.test(msg)
  ) {
    return {
      userMessage:
        "🤖 Estou temporariamente indisponível por falta de créditos na IA. Já vou voltar assim que o saldo for liberado. Se for urgente, me diga e registro para tratar manualmente.",
      devMessage: dev,
      code: "INSUFFICIENT_QUOTA",
    };
  }

  // Auth inválida
  if (/401/.test(msg) || /invalid api key/i.test(msg) || /unauthorized/i.test(msg)) {
    return {
      userMessage:
        "⚠️ Não consegui acessar o provedor de IA. Verifique a chave de API.",
      devMessage: dev,
      code: "AUTH_ERROR",
    };
  }

  // Demais erros
  return {
    userMessage:
      "⚠️ Tive um problema ao processar agora. Tente novamente em instantes.",
    devMessage: dev,
    code: "GENERIC_ERROR",
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ ok: false, error: "OPENAI_API_KEY não configurada" });
    }

    const { q = "", from } = req.body || {};
    if (!q || typeof q !== "string") {
      return res.status(400).json({ ok: false, error: "Missing 'q' string" });
    }

    // Chamada ao modelo (chat.completions)
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: q },
      ],
      temperature: 0.3,
    });

    const text =
      response?.choices?.[0]?.message?.content ??
      response?.output_text ??
      "";

    return res.status(200).json({
      ok: true,
      text,
      meta: { model: response?.model || "gpt-4o-mini" },
    });
  } catch (err) {
    const mapped = mapOpenAIError(err);
    console.error(mapped.devMessage);
    // 200 para o webhook conseguir ler a mensagem amigável
    return res.status(200).json({
      ok: false,
      userMessage: mapped.userMessage,
      code: mapped.code,
    });
  }
}
