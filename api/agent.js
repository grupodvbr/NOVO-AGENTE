// api/agent.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- helpers de erro ----
function mapOpenAIError(err) {
  const msg = String(err?.message || err || "");
  const dev = `OpenAI error: ${msg}`;
  if (/insufficient_quota|exceeded your current quota|billing/i.test(msg)) {
    return { ok:false, userMessage:"🤖 Estou temporariamente indisponível por falta de créditos na IA. Tente novamente em breve.", code:"INSUFFICIENT_QUOTA", devMessage:dev };
  }
  if (/401|invalid api key|unauthorized/i.test(msg)) {
    return { ok:false, userMessage:"⚠️ Não consegui acessar o provedor de IA. Verifique a chave de API.", code:"AUTH_ERROR", devMessage:dev };
  }
  return { ok:false, userMessage:"⚠️ Tive um problema ao processar agora. Tente novamente em instantes.", code:"GENERIC_ERROR", devMessage:dev };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, error:"Method not allowed" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok:false, error:"OPENAI_API_KEY não configurada" });
    }

    const { q = "", from } = req.body || {};
    if (!q || typeof q !== "string") {
      return res.status(400).json({ ok:false, error:"Missing 'q' string" });
    }

    const hoje = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    const system = [
      "Você é um assistente do Grupo DV. Responda sempre em PT-BR, de forma objetiva.",
      "Formate listas com bullets, datas em DD/MM/AAAA e valores como R$ 0,00.",
      `Hoje é ${hoje}. Se te perguntarem a data, use este valor.`,
    ].join("\n");

    // Responses API (vai aparecer na aba "Responses" dos Logs)
    const r = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: q },
      ],
      temperature: 0.3,
      metadata: { source: "whatsapp", from: from || "", prompt_id: "pmpt_whatsapp_v1" },
    });

    const text =
      r.output_text ||
      r?.content?.[0]?.text?.value ||
      r?.choices?.[0]?.message?.content ||
      "";

    return res.status(200).json({ ok:true, text, meta:{ model: r?.model || "gpt-4o-mini" } });
  } catch (err) {
    const mapped = mapOpenAIError(err);
    console.error(mapped.devMessage);
    // 200 para o webhook usar a userMessage
    return res.status(200).json(mapped);
  }
}
