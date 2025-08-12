// api/whatsapp-send.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: "Campos obrigatórios: to, body" });

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
    const json = await r.json();
    return res.status(r.ok ? 200 : 400).json(json);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
