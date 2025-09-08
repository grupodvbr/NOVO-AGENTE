// /api/agent.js
// Runtime: Node.js (não Edge)

// ====== deps ======
import OpenAI from "openai";
import Redis from "ioredis";

// ====== OpenAI ======
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Redis (memória) ======
// Usa REDIS_URL (Upstash ou outro provedor). Aceita formatos rediss://default:senha@host:port
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
const KV_ON = Boolean(redis);

const kv = KV_ON
  ? {
      lpush: (k, v) => redis.lpush(k, v),
      ltrim: (k, start, end) => redis.ltrim(k, start, end),
      lrange: (k, start, end) => redis.lrange(k, start, end),
      setex: (k, ttl, v) => redis.set(k, v, "EX", ttl),
      get: (k) => redis.get(k),
      del: (k) => redis.del(k),
    }
  : null;

// ====== Memória ======
const MEM_TTL   = 60 * 60 * 24 * 30; // 30 dias
const MAX_TURNS = 12;                // últimas N trocas
const kTurns = (id) => `mem:turns:${id}`;
const kSum   = (id) => `mem:sum:${id}`;

async function loadMemory(userId) {
  if (!KV_ON || !userId) return { turns: [], summary: null };
  const [turns, summary] = await Promise.all([
    kv.lrange(kTurns(userId), -MAX_TURNS * 2, -1),
    kv.get(kSum(userId))
  ]);
  const parsed = (turns || []).map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
  return { turns: parsed, summary: summary || null };
}

async function saveMemory(userId, userMsg, assistantMsg) {
  if (!KV_ON || !userId) return;
  const item = JSON.stringify({ t: Date.now(), u: userMsg || "", a: assistantMsg || "" });
  await kv.lpush(kTurns(userId), item);
  await kv.ltrim(kTurns(userId), 0, MAX_TURNS * 2 - 1);
  await kv.setex(kTurns(userId), MEM_TTL, "1"); // só para refresh do TTL via side effect
}

async function clearMemory(userId) {
  if (!KV_ON || !userId) return;
  await Promise.all([kv.del(kTurns(userId)), kv.del(kSum(userId))]);
}

async function summarizeIfLarge(userId) {
  if (!KV_ON || !userId) return;
  const all = await kv.lrange(kTurns(userId), 0, -1);
  if (!all || all.length < MAX_TURNS * 2) return;

  const text = all.map((s) => {
    try { const t = JSON.parse(s); return `U: ${t.u}\nA: ${t.a}`; } catch { return ""; }
  }).join("\\n\\n");

  const r = await client.responses.create({
    model: "gpt-4.1-mini",
    input: `Resuma de forma objetiva o histórico a seguir, destacando empresas citadas, períodos e totais mencionados:\\n\\n${text}`
  });
  const sum = (r.output_text || "").trim();
  await kv.setex(kSum(userId), MEM_TTL, sum);
}

// ====== Utilidades de dados (paineis) ======
function normalizeKey(k) {
  return String(k || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function strDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

async function fetchMetas() {
  const url = process.env.METAS_URL;
  if (!url) return { ok:false, error:"METAS_URL não configurada" };
  const r = await fetch(url);
  const raw = await r.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  return { ok: true, raw, data };
}

function inferFields(row) {
  // tenta descobrir campos comuns sem depender de schema fixo
  const map = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = normalizeKey(k);
    if (/empresa|loja|filial/.test(nk)) map.company = k;
    if (/valor|total|bruto|liquido/.test(nk)) map.amount = k;
    if (/data|emissao|competencia|dia/.test(nk)) map.date = k;
    if (/status/.test(nk)) map.status = k;
    if (/produto|item|descricao/.test(nk)) map.item = k;
  }
  return map;
}

function sumByCompany(data, companyQuery=None, dateFrom=null, dateTo=null) {
  const arr = Array.isArray(data) ? data : [];
  const sums = {};
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const f = inferFields(row);
    const company = String(row[f.company] ?? "DESCONHECIDO");
    const amount = Number(String(row[f.amount] ?? "0").replace(",", ".").replace(/[^\d.-]/g,"")) || 0;
    const dt = toDate(row[f.date]);
    if (dateFrom && dt && dt < dateFrom) continue;
    if (dateTo && dt && dt > dateTo) continue;
    if (companyQuery && !company.toLowerCase().includes(companyQuery.toLowerCase())) continue;
    sums[company] = (sums[company] || 0) + amount;
  }
  return sums;
}

// ====== Ferramentas para tool-calling ======
async function tool_get_metas_summary(args) {
  const { company, period } = args || {};
  const meta = await fetchMetas();
  if (!meta.ok) return { ok:false, error: meta.error };

  let dateFrom = null, dateTo = null;
  if (period && typeof period === "object") {
    if (period.dateFrom) dateFrom = toDate(period.dateFrom);
    if (period.dateTo)   dateTo   = toDate(period.dateTo);
  }

  const sums = sumByCompany(meta.data, company || null, dateFrom, dateTo);

  return {
    ok: true,
    company: company || null,
    period: { dateFrom: dateFrom ? strDate(dateFrom) : null, dateTo: dateTo ? strDate(dateTo) : null },
    totalsByCompany: sums,
    sampleRow: Array.isArray(meta.data) && meta.data.length ? pick(meta.data[0], Object.keys(meta.data[0]).slice(0,8)) : null
  };
}

const toolSchema = [{
  type: "function",
  function: {
    name: "get_metas_summary",
    description: "Obtém totais por empresa a partir do METAS_URL (Google Apps Script) em um período. Útil para perguntas do tipo 'quanto vendi ontem no MERCATTO'.",
    parameters: {
      type: "object",
      properties: {
        company: { type: "string", description: "Nome parcial ou completo da empresa (ex.: 'Mercatto', 'VILLA GOURMET')." },
        period: {
          type: "object",
          properties: {
            dateFrom: { type: "string", description: "YYYY-MM-DD" },
            dateTo: { type: "string", description: "YYYY-MM-DD" }
          }
        }
      }
    }
  }
}];

// ====== Prompt ======
const SYSTEM = `Você é um agente financeiro conectado aos painéis do Grupo DV.
- Responda em PT-BR.
- Quando a pergunta envolver totais de vendas/cancelamentos por empresa e período, chame a ferramenta get_metas_summary.
- Se a ferramenta retornar valores, formate com separador de milhar e prefixo R$.
- Seja direto e mostre também um pequeno resumo por empresa quando fizer sentido.
- Se faltar dado nos painéis, admita claramente e sugira como preencher.`;

// ====== Execução do agente ======
export async function runAgent({ from, q }) {
  q = (q || "").trim();
  if (!q) return { ok:true, text: "Me envie sua pergunta. Ex: 'quanto vendi ontem no Mercatto?'" };

  // Comandos de manutenção
  if (/^\/(clear|limpar)\b/i.test(q)) {
    await clearMemory(from);
    return { ok:true, text: "Memória limpa ✅" };
  }

  const mem = await loadMemory(from);

  // 1) Tenta tool-calling direto
  const r = await client.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: SYSTEM + (mem.summary ? `\\nContexto recente: ${mem.summary}` : "") },
      ...mem.turns.flatMap((t) => [{ role:"user", content: t.u }, { role:"assistant", content: t.a }]),
      { role: "user", content: q }
    ],
    tools: toolSchema,
    tool_choice: "auto",
    temperature: 0.3,
    max_output_tokens: 600,
    metadata: { source:"whatsapp", route:"primary", from: from || "" }
  });

  // 2) Se veio tool call, executa
  let finalText = r.output_text?.trim() || "";
  if (r.tool_calls && r.tool_calls.length) {
    for (const call of r.tool_calls) {
      if (call.function?.name === "get_metas_summary") {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
        const toolRes = await tool_get_metas_summary(args);
        const follow = await client.responses.create({
          model: "gpt-4.1-mini",
          input: [
            { role: "system", content: SYSTEM },
            { role: "user", content: q },
            { role: "tool", content: JSON.stringify(toolRes), tool_call_id: call.id }
          ],
          temperature: 0.2,
          max_output_tokens: 600,
          metadata: { source:"whatsapp", route:"tool-followup", from: from || "" }
        });
        finalText = (follow.output_text || finalText).trim();
      }
    }
  }

  // 3) Fallback simples
  if (!finalText) {
    const fb = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: q }
      ],
      temperature: 0.4,
      max_output_tokens: 600,
      metadata: { source:"whatsapp", route:"fallback", from: from || "" }
    });
    finalText = (fb.output_text || "").trim();
  }

  await saveMemory(from, q, finalText);
  await summarizeIfLarge(from);
  return { ok:true, text: finalText };
}

// ====== Handler HTTP (opcional para debug) ======
function mapOpenAIError(err) {
  const is429 = err?.status === 429 || /rate limit/i.test(String(err?.message||""));
  const is401 = err?.status === 401 || /unauthorized|invalid api key/i.test(String(err?.message||""));
  if (is429) return { ok:false, error:"OpenAI: limite de requisições atingido (429). Tente novamente em instantes." };
  if (is401) return { ok:false, error:"OpenAI: verifique sua OPENAI_API_KEY." };
  return { ok:false, error: String(err?.message || err) };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { from, q } = req.body || {};
    const out = await runAgent({ from, q });
    return res.status(200).json(out);
  } catch (err) {
    const mapped = mapOpenAIError(err);
    console.error("Agent error:", err?.message || err);
    return res.status(200).json(mapped);
  }
}
