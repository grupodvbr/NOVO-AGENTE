export default async function handler(req, res) {
  try {
    const { q } = req.method === "POST" ? JSON.parse(req.body) : req.query;

    if (!q) {
      return res.status(400).json({ error: "Pergunta não enviada" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Chave da API não configurada" });
    }

    // Chamada à API da OpenAI
    const resposta = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: q }],
        max_tokens: 200
      })
    });

    const data = await resposta.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    res.status(200).json({
      pergunta: q,
      resposta: data.choices[0].message.content.trim()
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
