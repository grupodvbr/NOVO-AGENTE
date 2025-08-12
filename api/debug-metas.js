// api/debug-metas.js
export default async function handler(req, res) {
  try {
    const url = process.env.METAS_URL;
    if (!url) return res.status(500).json({ error: "METAS_URL não configurada" });
    const r = await fetch(url);
    const raw = await r.text();
    let data = null; try { data = JSON.parse(raw); } catch {}
    const sample = Array.isArray(data) ? data.slice(0, 5) : data;
    const schema = Array.isArray(data) && data.length && typeof data[0]==="object" ? Object.keys(data[0]) : null;
    res.status(200).json({ ok:true, type: Array.isArray(data) ? "array" : typeof data, length: Array.isArray(data) ? data.length : undefined, schema, sample });
  } catch (e) {
    res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
