// api/whatsapp-webhook.js
const baseUrl = process.env.BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

export default async function handler(req, res) {
  // Verificação do webhook (handshake)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).end();
  }

  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      const from = msg?.from;
      const text = msg?.text?.body || msg?.interactive?.nfm_reply?.response_json;

      if (from && text) {
        // chama o agente existente
        const askUrl = baseUrl ? `${baseUrl}/api/agent` : "/api/agent";
        let reply = "Ok, recebi sua mensagem.";
        try {
          const aiRes = await fetch(askUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: text, from }),
          });
          const aiJson = await aiRes.json();
          reply = aiJson?.text || aiJson?.answer || reply;
        } catch {}

        // envia de volta no WhatsApp
        await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { body: reply },
          }),
        });
      }

      return res.status(200).end();
    } catch (e) {
      // sempre 200 para evitar reenvio em loop pelo Meta
      return res.status(200).end();
    }
  }

  return res.status(405).end();
}
