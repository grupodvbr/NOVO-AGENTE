// /api/whatsapp-webhook.js
// Webhook do WhatsApp Cloud API: validação GET + recepção POST + resposta via Graph

import { runAgent } from "./agent.js";

// Lê o corpo cru de forma segura (Node 18 no Vercel já tem fetch/streams)
async function readBodySafe(req) {
  if (req.body) return req.body; // já parseado (Vercel Functions)
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

async function sendWhatsApp(to, body) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token   = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) console.error("Erro ao enviar WhatsApp:", json);
  return json;
}

export default async function handler(req, res) {
  // 1) Verificação do webhook (setup no Meta)
  if (req.method === "GET") {
    const mode  = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const chall = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(chall);
    }
    return res.status(403).send("forbidden");
  }

  // 2) Recepção de mensagens
  if (req.method === "POST") {
    try {
      const body = await readBodySafe(req);
      const entries = body?.entry || [];
      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const value = change?.value || {};
          const messages = value?.messages || [];
          const contacts = value?.contacts || [];
          for (const m of messages) {
            if (m.type !== "text") continue;
            const from = m.from;
            const q = m.text?.body || "";
            if (!from || !q) continue;

            // Variações simples de saúde
            if (/^ping$/i.test(q.trim())) {
              await sendWhatsApp(from, "pong");
              continue;
            }

            // Roda o agente
            const out = await runAgent({ from, q });
            const reply = out?.text || "Sem resposta.";
            await sendWhatsApp(from, reply);
          }
        }
      }
      // Sempre 200 para evitar reenvio
      return res.status(200).end();
    } catch (e) {
      console.error("Erro no webhook:", e);
      // Mesmo com erro, 200 para não repetir
      return res.status(200).end();
    }
  }

  return res.status(405).end();
}
