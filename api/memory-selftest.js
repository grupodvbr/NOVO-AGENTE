import Redis from "ioredis";

const url = process.env.REDIS_URL_NOVO; // mesmo nome que você criou na Vercel
const redis = url ? new Redis(url) : null;

export default async function handler(req, res) {
  try {
    if (!redis) {
      return res.status(200).json({ ok: false, error: "REDIS_URL_NOVO vazio" });
    }
    await redis.set("kv:ping", JSON.stringify({ ts: Date.now() }), "EX", 60);
    const v = await redis.get("kv:ping");
    return res.status(200).json({ ok: true, value: JSON.parse(v) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
