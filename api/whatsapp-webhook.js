// api/whatsapp-webhook.js

// Lê o corpo cru de forma segura (funciona em Vercel Functions e Next API)
async function readBodySafe(req) {
  try {
    if (req.body) return req.body; // já parseado
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  } catch {
    return {};
  }
}

async function sendWhatsApp(to, body) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    console.error("Erro enviando p/ WhatsApp:", r.status, j);
  }
}

export default async function handler(req, res) {
  // 1) Verificação (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  // 2) Recebimento (POST)
  if (req.method === "POST") {
    try {
      const body = await readBodySafe(req);
      console.log("Webhook body recebido:", JSON.stringify(body).slice(0, 2000));

      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      const from = msg?.from;
      const text =
        msg?.text?.body ||
        msg?.interactive?.nfm_reply?.response_json ||
        msg?.button?.text;

      if (from && text) {
        // Chama seu agente
        const askUrl = "https://novo-agente.vercel.app/api/agent";
        let reply = "Não consegui processar sua mensagem agora. Tente novamente.";
        try {
          const aiRes = await fetch(askUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: text, from }),
          });
          const raw = await aiRes.text();
          let aiJson = {};
          try { aiJson = JSON.parse(raw); } catch { aiJson = { ok: false, userMessage: raw }; }
          console.log("STATUS /api/agent:", aiRes.status, aiJson);

          if (aiJson?.ok === false) {
            reply = aiJson.userMessage || reply;
          } else {
            reply = aiJson?.text || aiJson?.answer || reply;
          }
        } catch (e) {
          console.error("Erro chamando /api/agent:", e);
        }

        await sendWhatsApp(from, reply);
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
