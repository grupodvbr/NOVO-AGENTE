// api/agent.js
import OpenAI from "openai";
import fetch from "node-fetch"; // se não usar, pode remover

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ajuste seu prompt aqui, se quiser
const systemPrompt = "Você é um assistente do Grupo DV. Responda de forma objetiva.";

function mapOpenAIError(err) {
  const msg = String(err?.message || err || "");
  const dev = `OpenAI error: ${msg}`;

  // Falta de créditos / orçamento / quota
  if (
    msg.includes("insufficient_quota") ||
    msg.includes("exceeded your current quota") ||
    msg.includes("billing") ||
    msg.includes("You exceeded your current quota")
  ) {
    return {
      userMessage:
        "🤖 Estou temporariamente indisponível por falta de créditos na IA. Já vou voltar assim que o saldo for liberado. Se for urgente, me diga e registro para tratar manualmente.",
      devMessage: dev,
      code: "INSUFFICIENT_QUOTA",
    };
  }

  // Auth inválida
  if (msg.includes("401") || msg.toLowerCase().includes("invalid api key")) {
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

    const { q = "", from } = req.body || {};
    if (!q || typeof q !== "string") {
      return res.status(400).json({ ok: false, error: "Missing 'q' string" });
    }

    // Chamada ao modelo
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

    // OK
    return res.status(200).json({
      ok: true,
      text,
      meta: { model: response?.model || "gpt-4o-mini" },
    });
  } catch (err) {
    // Mapeia erro e responde com ok:false
    const mapped = mapOpenAIError(err);
    console.error(mapped.devMessage);
    return res.status(200).json({
      ok: false,
      userMessage: mapped.userMessage,
      code: mapped.code,
    });
  }
}
