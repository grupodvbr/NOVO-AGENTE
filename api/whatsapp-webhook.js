// api/whatsapp-webhook.js
const baseUrl =
  process.env.BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

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
    throw new Error(`WhatsApp send failed: ${r.status} ${JSON.stringify(j)}`);
  }
}

export default async function handler(req, res) {
  // Handshake de verificação
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  // Mensagens recebidas
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      const from = msg?.from; // "55DDDNUMERO"
      const text =
        msg?.text?.body ||
        msg?.interactive?.nfm_reply?.response_json ||
        msg?.button?.text;

      if (from && text) {
        // Chama seu agente existente (api/agent.js)
        const askUrl = baseUrl ? `${baseUrl}/api/agent` : "/api/agent";
        let reply = "Não consegui processar sua mensagem agora. Tente novamente.";

        try {
          const aiRes = await fetch(askUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: text, from }),
          });
          const aiJson = await aiRes.json().catch(() => ({}));
          reply = aiJson?.text || aiJson?.answer || reply;
        } catch (e) {
          console.error("Erro chamando /api/agent:", e);
        }

        // Envia a resposta do agente
        await sendWhatsApp(from, reply);
      }

      // Sempre 200 para evitar reenvio automático do Meta
      return res.status(200).end();
    } catch (e) {
      console.error("Erro no webhook:", e);
      return res.status(200).end();
    }
  }

  return res.status(405).end();
}
