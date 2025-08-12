// /api/whatsapp-webhook.js
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
    console.error("WA send failed:", r.status, j);
  }
}

export default async function handler(req, res) {
  try {
    // Verificação (GET)
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).end();
    }

    // Mensagem (POST)
    if (req.method === "POST") {
      try {
        const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
        const msg = entry?.messages?.[0];
        const from = msg?.from;
        const text =
          msg?.text?.body ||
          msg?.interactive?.nfm_reply?.response_json ||
          msg?.button?.text;

        if (!from || !text) {
          console.log("Webhook sem from/text:", JSON.stringify(req.body || {}));
          return res.status(200).end();
        }

        const askUrl = baseUrl ? `${baseUrl}/api/agent` : "/api/agent";
        let reply = "Não consegui processar sua mensagem agora. Tente novamente.";

        try {
          const aiRes = await fetch(askUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: text, from }),
          });
          const aiJson = await aiRes.json().catch(() => ({}));
          reply = aiJson?.text || aiJson?.answer || aiJson?.userMessage || reply;
        } catch (e) {
          console.error("Erro chamando /api/agent:", e);
        }

        await sendWhatsApp(from, reply);
        return res.status(200).end();
      } catch (e) {
        console.error("Erro dentro do webhook:", e);
        // Respondemos 200 para o Meta não reenfileirar infinitamente
        return res.status(200).end();
      }
    }

    return res.status(405).end();
  } catch (e) {
    console.error("Webhook top-level error:", e);
    return res.status(200).end(); // não deixar cair
  }
}
