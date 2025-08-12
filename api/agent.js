// /api/agent.js (Node.js runtime — não Edge)
// v2.2 — intenções extras, rate limit, projeções e hardening

// ====== deps ======
import OpenAI from "openai";
import Redis from "ioredis";
import crypto from "crypto";

// ====== OpenAI ======
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Redis (memória + cache + rate-limit) ======
const HAS_REDIS = Boolean(process.env.REDIS_URL_NOVO);
const redis = HAS_REDIS
  ? new Redis(process.env.REDIS_URL_NOVO, {
      tls: process.env.REDIS_URL_NOVO?.startsWith("rediss://") ? {} : undefined,
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(500 * times, 3000),
    })
  : null;

const kv = HAS_REDIS
  ? {
      lrange: (k, s, e) => redis.lrange(k, s, e),
      rpush: (k, v) => redis.rpush(k, v),
      expire: (k, secs) => redis.expire(k, secs),
      ltrim: (k, s, e) => redis.ltrim(k, s, e),
      get: async (k) => {
        const v = await redis.get(k);
        try { return JSON.parse(v); } catch { return v; }
      },
      set: (k, val, opts = {}) => {
        const payload = typeof val === "string" ? val : JSON.stringify(val);
        return opts.ex ? redis.set(k, payload, "EX", opts.ex) : redis.set(k, payload);
      },
      del: (k) => redis.del(k),
      incr: (k) => redis.incr(k),
    }
  : null;

// ====== Constantes ======
const TZ = process.env.TZ || "America/Sao_Paulo";
const mesesPT = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const MEM_TTL   = 60 * 60 * 24 * 30; // 30 dias
const MAX_TURNS = 12;                // últimas N trocas
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 40); // req/minuto por usuário

// ====== Utils ======
const strip = (s="") => s.normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().trim();
const parseISO = (s) => { const d = new Date(`${s}T00:00:00-03:00`); return Number.isNaN(d.getTime()) ? null : d; };
const ymd = (d) => d.toISOString().slice(0,10);
const nowBR = () => new Date(new Date().toLocaleString("en-US",{ timeZone: TZ }));
const fmtBR = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fmtPct = (n) => (isFinite(n) ? `${(n).toFixed(1)}%` : "0,0%").replace(".",",");

function daysInMonth(ano, mes){ return new Date(ano, mes, 0).getDate(); }
function guessTodayISO(){ return ymd(nowBR()); }

function signId(obj){
  return crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0,8);
}

// ====== Keys ======
const kTurns = (id) => `mem:turns:${id}`;
const kSum   = (id) => `mem:sum:${id}`;
const kCache = (name) => `cache:${name}`;
const kRate  = (id) => `ratelimit:${id}`;

// ====== Memória ======
async function loadMemory(userId) {
  if (!HAS_REDIS || !userId) return { turns: [], summary: null };
  const [turns, summary] = await Promise.all([
    kv.lrange(kTurns(userId), -MAX_TURNS * 2, -1),
    kv.get(kSum(userId)),
  ]);
  const parsed = (turns || [])
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
  return { turns: parsed, summary: summary || null };
}

async function saveMemory(userId, userText, assistantText) {
  if (!HAS_REDIS || !userId) return;
  const item = JSON.stringify({ u: userText, a: assistantText, t: Date.now() });
  await kv.rpush(kTurns(userId), item);
  await kv.expire(kTurns(userId), MEM_TTL);
  await kv.ltrim(kTurns(userId), -MAX_TURNS * 2, -1);
}

async function clearMemory(userId) {
  if (!HAS_REDIS || !userId) return;
  await Promise.all([kv.del(kTurns(userId)), kv.del(kSum(userId))]);
}

async function summarizeIfLarge(userId) {
  if (!HAS_REDIS || !userId) return;
  const all = await kv.lrange(kTurns(userId), 0, -1);
  if (!all || all.length < MAX_TURNS * 2) return;

  const text = all.map((s) => {
    try { const t = JSON.parse(s); return `U: ${t.u}\nA: ${t.a}`; } catch { return ""; }
  }).join("\n\n");

  const r = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: "Resuma a conversa abaixo em até 6 linhas, guardando fatos persistentes (nome, preferências, empresas, metas, etc.)." },
      { role: "user", content: text }
    ],
    temperature: 0.2,
    metadata: { route: "memory.summarize" }
  });
  const summary = r.output_text?.trim();
  if (summary) await kv.set(kSum(userId), summary, { ex: MEM_TTL });
}

// ====== Rate limit ======
async function rateLimit(from){
  if (!HAS_REDIS || !from) return { ok:true };
  const key = `${kRate(from)}:${Math.floor(Date.now()/1000/RATE_LIMIT_WINDOW_S)}`;
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW_S);
  if (count > RATE_LIMIT_MAX) return { ok:false, retryIn: 1 };
  return { ok:true };
}

// ====== Fetch helpers ======
async function fetchWithTimeout(url, opts = {}){
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), opts.timeout || 8000);
  try{
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ====== Dados (METAS) com cache ======
async function fetchMetas(){
  const url = process.env.METAS_URL;
  if (!url) throw new Error("METAS_URL não configurada");

  const cacheKey = `${kCache("metas")}`;
  if (HAS_REDIS){
    const cached = await kv.get(cacheKey);
    if (Array.isArray(cached)) return cached;
  }

  const r = await fetchWithTimeout(url, { cache:"no-store" });
  const raw = await r.text();
  let data = [];
  try { data = JSON.parse(raw); } catch { throw new Error("METAS_URL não retornou JSON"); }

  const rows = [];
  for (const it of data) {
    const Data = String(it.Data || it.data || "").trim();
    const Empresa = String(it.Empresa || it.empresa || "").trim();
    const Previsto = it.Previsto ?? it.previsto ?? "";
    const Realizado = it.Realizado ?? it.realizado ?? "";

    if (!Data || Data === "1969-12-31") continue;
    if (Previsto === "" || Realizado === "") continue;

    const d = parseISO(Data);
    if (!d) continue;

    const previsto = Number(Previsto);
    const realizado = Number(Realizado);
    if (!Number.isFinite(previsto) || !Number.isFinite(realizado)) continue;

    rows.push({
      dataISO: ymd(d),
      ano: d.getFullYear(),
      mes: d.getMonth()+1,
      dia: d.getDate(),
      empresa: Empresa.trim(),
      empresaKey: strip(Empresa),
      previsto,     // meta mensal (repetida por linha/dia)
      realizado     // realizado do dia
    });
  }

  if (HAS_REDIS) await kv.set(cacheKey, rows, { ex: 60 }); // 60s de cache
  return rows;
}

// ====== Agregações ======
function resumoMes(rows, { mes, ano }) {
  const fil = rows.filter((r) => r.mes === mes && r.ano === ano);
  const map = new Map();

  for (const r of fil) {
    const k = r.empresaKey;
    let agg = map.get(k);
    if (!agg) { agg = { empresa: r.empresa, prevMensal: 0, realSum: 0 }; map.set(k, agg); }
    agg.realSum += r.realizado;
    if (r.previsto > agg.prevMensal) agg.prevMensal = r.previsto; // pega 1 meta mensal
  }

  const empresas = [...map.values()].map((e) => {
    const pct = e.prevMensal > 0 ? (e.realSum / e.prevMensal) * 100 : 0;
    return { empresa: e.empresa, previsto: e.prevMensal, realizado: e.realSum, pct, bateu: e.realSum >= e.prevMensal };
  }).sort((a, b) => b.pct - a.pct);

  const totalPrev = empresas.reduce((s, x) => s + x.previsto, 0);
  const totalReal = empresas.reduce((s, x) => s + x.realizado, 0);
  const totalPct = totalPrev > 0 ? (totalReal / totalPrev) * 100 : 0;

  return { empresas, totalPrev, totalReal, totalPct };
}

function percentualDia(rows, { empresaKey, iso }) {
  const fil = rows.filter((r) => r.empresaKey === empresaKey && r.dataISO === iso);
  if (!fil.length) return null;
  const prev = fil.reduce((s, x) => s + x.previsto, 0); // meta mensal por linha
  const rea  = fil.reduce((s, x) => s + x.realizado, 0);
  return { previsto: prev, realizado: rea, pct: prev > 0 ? (rea / prev) * 100 : 0 };
}

function rankingDia(rows, iso){
  const byEmpresa = new Map();
  for (const r of rows){
    if (r.dataISO !== iso) continue;
    let a = byEmpresa.get(r.empresaKey);
    if (!a) { a = { empresa: r.empresa, mensal: 0, dia: 0 }; byEmpresa.set(r.empresaKey, a); }
    a.mensal += r.previsto;
    a.dia += r.realizado;
  }
  const arr = [...byEmpresa.values()].map(x=>({ ...x, pct: x.mensal>0 ? (x.dia/x.mensal)*100 : 0 }));
  return arr.sort((a,b)=>b.pct - a.pct);
}

function projecaoMes(rows, { mes, ano }){
  const fil = rows.filter(r=>r.mes===mes && r.ano===ano);
  const byEmpresa = new Map();
  for (const r of fil){
    let a = byEmpresa.get(r.empresaKey);
    if (!a) { a = { empresa:r.empresa, prev:0, real:0, dias: new Set(), diaMax: 0 }; byEmpresa.set(r.empresaKey,a); }
    a.prev = Math.max(a.prev, r.previsto);
    a.real += r.realizado;
    a.dias.add(r.dia);
    a.diaMax = Math.max(a.diaMax, r.dia);
  }
  const hoje = nowBR();
  const diasCorridos = Math.max(1, Math.min(new Date(ano, mes-1, hoje.getDate()).getDate(), Math.max(...[...byEmpresa.values()].map(x=>x.diaMax||1))));
  const dim = daysInMonth(ano, mes);
  const out = [...byEmpresa.values()].map(x=>{
    const mediaDia = x.real / diasCorridos;
    const proj = mediaDia * dim;
    const pctProj = x.prev>0 ? (proj / x.prev) * 100 : 0;
    const faltante = Math.max(0, x.prev - x.real);
    return { empresa:x.empresa, previsto:x.prev, realizadoMTD:x.real, diasConsiderados:diasCorridos, projecaoMes: proj, pctProj, faltante };
  }).sort((a,b)=>b.pctProj - a.pctProj);

  const totalPrev = out.reduce((s,x)=>s+x.previsto,0);
  const totalReal = out.reduce((s,x)=>s+x.realizadoMTD,0);
  const mediaDiaTotal = totalReal / (out[0]?.diasConsiderados || 1);
  const projTotal = mediaDiaTotal * dim;
  const totalPctProj = totalPrev>0 ? (projTotal/totalPrev)*100 : 0;
  return { empresas: out, totalPrev, totalReal, projTotal, totalPctProj, dim };
}

// ====== Parsing ======
function getMesRef(txt="") {
  if (/m[eê]s\s+passado/i.test(txt)) {
    const now = nowBR();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    d.setUTCMonth(d.getUTCMonth()-1);
    return { mes: d.getUTCMonth()+1, ano: d.getUTCFullYear(), label:`${mesesPT[d.getUTCMonth()]} de ${d.getUTCFullYear()}` };
  }
  const m = txt.toLowerCase().match(/(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(de|\/|\-| )?\s*(\d{4})?/);
  if (m) {
    const mesIdx = mesesPT.findIndex(x => x.startsWith(m[1].replace("ç","c")));
    const ano = m[3] ? Number(m[3]) : nowBR().getFullYear();
    return { mes: mesIdx+1, ano, label:`${mesesPT[mesIdx]} de ${ano}` };
  }
  const now = nowBR();
  return { mes: now.getMonth()+1, ano: now.getFullYear(), label:`${mesesPT[now.getMonth()]} de ${now.getFullYear()}` };
}

function parseDia(txt="") {
  const ddmmaa = txt.match(/(hoje|ontem)|(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (ddmmaa && ddmmaa[1]){
    const ref = ddmmaa[1].toLowerCase();
    const d = nowBR();
    if (ref === "ontem") d.setDate(d.getDate()-1);
    return { dia: d.getDate(), mes: d.getMonth()+1, ano: d.getFullYear(), iso: ymd(d) };
  }
  if (ddmmaa) {
    const d = Number(ddmmaa[2]), m = Number(ddmmaa[3]);
    const y = ddmmaa[4] ? Number(ddmmaa[4].length===2 ? "20"+ddmmaa[4] : ddmmaa[4]) : nowBR().getFullYear();
    return { dia:d, mes:m, ano:y, iso: `${y.toString().padStart(4,"0")}-${m.toString().padStart(2,"0")}-${d.toString().padStart(2,"0")}` };
  }
  return null;
}

function resolveEmpresaKey(queryEmpresa, rows){
  const q = strip(queryEmpresa||"");
  if (!q) return "";
  const byKey = new Map(rows.map(r=>[r.empresaKey, r.empresa]));
  if (byKey.has(q)) return q;
  // tentativa por prefixo/conteúdo
  for (const [k,name] of byKey){ if (k.includes(q) || strip(name).includes(q)) return k; }
  return q; // retorna tentativa mesmo assim
}

// ====== Intents ======
function detectIntent(qRaw) {
  const q = qRaw.trim();
  const qLow = q.toLowerCase();

  if ((/percentual|%|porcent/.test(qLow)) && (/(dia|hoje|ontem|\d{1,2}[\/\-]\d{1,2})/.test(qLow))) {
    const d = parseDia(qLow);
    const m = q.match(/(?:no|na|do|da)\s+(.+)$/i);
    const empresa = m ? m[1].trim() : "";
    return { kind:"pctDia", args:{ dia:d, empresa } };
  }
  if (/ranking.*dia/i.test(qLow) || /top.*dia/i.test(qLow)){
    const d = parseDia(qLow) || { iso: guessTodayISO() };
    return { kind:"rankingDia", args:{ dia:d } };
  }
  if (/quem.*bateu.*meta/i.test(qLow)) {
    const mesRef = getMesRef(qLow);
    return { kind:"quemBateu", args:{ mesRef } };
  }
  if ((/proje(c|ç)[aã]o|projetado|vai fechar/.test(qLow)) && /m[eê]s/.test(qLow)){
    const mesRef = getMesRef(qLow);
    return { kind:"projecaoMes", args:{ mesRef } };
  }
  if (/quanto.*(falta|resta).*meta/i.test(qLow)){
    const mesRef = getMesRef(qLow);
    const m = q.match(/(?:no|na|do|da)\s+(.+)$/i);
    const empresa = m ? m[1].trim() : "";
    return { kind:"faltante", args:{ mesRef, empresa } };
  }
  if (/metas|resumo/.test(qLow) && /m[eê]s/.test(qLow)) {
    const mesRef = getMesRef(qLow);
    return { kind:"resumoMes", args:{ mesRef } };
  }
  if (/^help$|^ajuda$|como usar/i.test(qLow)){
    return { kind:"help" };
  }
  return { kind:"ai" };
}

// ====== IA helper (NLG) ======
function mapOpenAIError(err) {
  const msg = String(err?.message || err || "");
  if (/insufficient_quota|exceeded your current quota|billing/i.test(msg)) {
    return { ok:false, userMessage:"🤖 Estou temporariamente indisponível por falta de créditos na IA. Tente novamente em breve.", code:"INSUFFICIENT_QUOTA" };
  }
  if (/401|invalid api key|unauthorized/i.test(msg)) {
    return { ok:false, userMessage:"⚠️ Não consegui acessar o provedor de IA. Verifique a chave de API.", code:"AUTH_ERROR" };
  }
  return { ok:false, userMessage:"⚠️ Tive um problema ao processar agora. Tente novamente em instantes.", code:"GENERIC_ERROR" };
}

async function aiNLG({ instruction, context, route, from, memory, temperature=0.2 }) {
  const hoje = nowBR().toLocaleString("pt-BR",{ timeZone: TZ });
  const system = [
    "Você é um analista do Grupo DV. Responda SEMPRE em Português do Brasil.",
    "Seja objetivo e claro. Use bullets quando fizer sentido.",
    "Formate datas em DD/MM/AAAA e valores como R$ 0,00. Percentuais como 0,0%.",
    "Não invente números: use apenas os dados do contexto JSON."
  ].join("\n");

  const history = [];
  if (memory?.summary) history.push({ role:"system", content:`Memória resumida do usuário: ${memory.summary}` });
  for (const t of memory?.turns || []) {
    if (t.u) history.push({ role:"user", content: t.u });
    if (t.a) history.push({ role:"assistant", content: t.a });
  }

  const r = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: system },
      ...history,
      { role: "user", content:
`Hoje é ${hoje}.

INSTRUÇÃO:
${instruction}

CONTEXTO (JSON):
${JSON.stringify(context)}` },
    ],
    temperature,
    metadata: { source: "whatsapp", prompt_id: "pmpt_123456", route: route || "metas.nlg", from: from || "" },
  });

  return r.output_text?.trim() || "";
}

// ====== Handler ======
export default async function handler(req, res) {
  const reqId = signId({ t: Date.now(), n: Math.random() });
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, error:"Method not allowed" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok:false, error:"OPENAI_API_KEY não configurada" });
    }

    // opcional: API key própria do agente
    if (process.env.AGENT_API_KEY) {
      const hdr = req.headers["x-api-key"]; 
      if (hdr !== process.env.AGENT_API_KEY) {
        return res.status(401).json({ ok:false, error:"Unauthorized" });
      }
    }

    const { q = "", from, mode = "plain" } = req.body || {};
    if (!q || typeof q !== "string") {
      return res.status(400).json({ ok:false, error:"Missing 'q' string" });
    }

    // rate-limit simples por usuário
    const rl = await rateLimit(from || req.socket?.remoteAddress || "anon");
    if (!rl.ok) return res.status(429).json({ ok:false, error:"Too Many Requests" });

    // comandos de memória
    if (/^(apagar|limpar|esquecer).*(minha )?mem[oó]ria/i.test(q)) {
      await clearMemory(from);
      return res.status(200).json({ ok:true, text:"✅ Memória apagada." });
    }

    const intent = detectIntent(q);
    const memory = await loadMemory(from);

    // 1) % do dia
    if (intent.kind === "pctDia") {
      const rows = await fetchMetas();
      const { dia, empresa } = intent.args;
      if (!dia?.iso || !empresa) {
        return res.status(200).json({ ok:true, text:"Informe a empresa e a data. Ex.: % do dia 02/08/2025 no Mercatto Delícia." });
      }
      const empresaKey = resolveEmpresaKey(empresa, rows);
      const r = percentualDia(rows, { empresaKey, iso: dia.iso });
      if (!r) return res.status(200).json({ ok:true, text:`Não encontrei registros para ${empresa} em ${dia.iso}.` });

      const text = await aiNLG({
        instruction: `Explique, em poucas linhas, o desempenho do dia para a empresa informada. Mostre Previsto, Realizado e Percentual. Seja direto.`,
        context: { empresa, data: dia.iso, previsto: r.previsto, realizado: r.realizado, pct: r.pct },
        route: "metas.pctDia",
        from,
        memory
      });

      await saveMemory(from, q, text);
      await summarizeIfLarge(from);
      return res.status(200).json({ ok:true, text, data:{ ...r, iso: dia.iso, empresa: empresa } });
    }

    // 1b) Ranking do dia
    if (intent.kind === "rankingDia"){
      const rows = await fetchMetas();
      const { dia } = intent.args;
      const iso = dia?.iso || guessTodayISO();
      const rank = rankingDia(rows, iso);
      if (!rank.length) return res.status(200).json({ ok:true, text:`Sem registros em ${iso}.` });

      const text = await aiNLG({
        instruction: `Monte um ranking do dia ${iso} por % do objetivo diário (realizado do dia / meta mensal). Liste do maior para o menor. Traga top 5 e diga quantas empresas no total.`,
        context: { iso, total: rank.length, top5: rank.slice(0,5) },
        route: "metas.rankingDia",
        from,
        memory
      });

      await saveMemory(from, q, text);
      await summarizeIfLarge(from);
      return res.status(200).json({ ok:true, text, data:{ iso, ranking: rank } });
    }

    // 2) Resumo do mês
    if (intent.kind === "resumoMes") {
      const rows = await fetchMetas();
      const { mesRef } = intent.args;
      const sum = resumoMes(rows, mesRef);

      const text = await aiNLG({
        instruction: `Gere um resumo executivo do mês ${mesRef.label}. Traga primeiro o total (Realizado / Previsto / %) e depois um ranking por empresa com ✓ se bateu e ✗ se não bateu.`,
        context: {
          mes: mesRef.mes, ano: mesRef.ano, label: mesRef.label,
          total: { previsto: sum.totalPrev, realizado: sum.totalReal, pct: sum.totalPct },
          empresas: sum.empresas
        },
        route: "metas.resumoMes",
        from,
        memory
      });

      await saveMemory(from, q, text);
      await summarizeIfLarge(from);
      return res.status(200).json({ ok:true, text, data: sum });
    }

    // 3) Quem bateu
    if (intent.kind === "quemBateu") {
      const rows = await fetchMetas();
      const { mesRef } = intent.args;
      const sum = resumoMes(rows, mesRef);
      const bateu = sum.empresas.filter(e=>e.bateu).map(e=>({ empresa:e.empresa, pct:e.pct }));

      const text = await aiNLG({
        instruction: `Liste as empresas que bateram a meta no mês, com o percentual. Caso nenhuma tenha batido, diga isso claramente.`,
        context: { mes: mesRef.mes, ano: mesRef.ano, label: mesRef.label, bateu },
        route: "metas.quemBateu",
        from,
        memory
      });

      await saveMemory(from, q, text);
      await summarizeIfLarge(from);
      return res.status(200).json({ ok:true, text, data: { label: mesRef.label, bateu } });
    }

    // 4) Projeção do mês
    if (intent.kind === "projecaoMes"){
      const rows = await fetchMetas();
      const { mesRef } = intent.args;
      const proj = projecaoMes(rows, mesRef);

      const text = await aiNLG({
        instruction: `Mostre a projeção de fechamento do mês ${mesRef.label} por empresa e no total: Previsto, Realizado MTD, Projeção para ${proj.dim} dias e % contra a meta. Mencione quem deve bater (≥100%).`,
        context: { label: mesRef.label, dim: proj.dim, total: { previsto: proj.totalPrev, realizado: proj.totalReal, projecao: proj.projTotal, pctProj: proj.totalPctProj }, empresas: proj.empresas },
        route: "metas.projecaoMes",
        from,
        memory
      });

      await saveMemory(from, q, text);
      await summarizeIfLarge(from);
      return res.status(200).json({ ok:true, text, data: proj });
    }

    // 5) Faltante para bater meta (por empresa)
    if (intent.kind === "faltante"){
      const rows = await fetchMetas();
      const { mesRef, empresa } = intent.args;
      if (!empresa) return res.status(200).json({ ok:true, text:"Informe a empresa. Ex.: quanto falta para bater a meta no Mercatto Delícia." });
      const empresaKey = resolveEmpresaKey(empresa, rows);
      const sum = resumoMes(rows, mesRef);
      const e = sum.empresas.find(x=>strip(x.empresa)===empresaKey || strip(x.empresa).includes(empresaKey));
      if (!e) return res.status(200).json({ ok:true, text:`Não encontrei dados de ${empresa} em ${mesRef.label}.` });
      const faltante = Math.max(0, e.previsto - e.realizado);

      const text = await aiNLG({
        instruction: `Responda em 2–3 linhas quanto falta para a empresa bater a meta do mês ${mesRef.label}. Informe Previsto, Realizado e Faltante, com uma orientação sucinta.`,
        context: { label: mesRef.label, empresa: e.empresa, previsto: e.previsto, realizado: e.realizado, faltante, pct: e.pct },
        route: "metas.faltante",
        from,
        memory
      });

      await saveMemory(from, q, text);
      await summarizeIfLarge(from);
      return res.status(200).json({ ok:true, text, data:{ empresa:e.empresa, faltante, previsto:e.previsto, realizado:e.realizado, pct:e.pct } });
    }

    // 6) Ajuda
    if (intent.kind === "help"){
      const help = [
        "Comandos úteis:",
        "• % do dia 02/08/2025 no Mercatto Delícia",
        "• Ranking do dia (hoje/ontem/\nDD/MM)",
        "• Resumo do mês agosto 2025",
        "• Projeção do mês agosto",
        "• Quem bateu a meta no mês passado",
        "• Quanto falta para bater a meta no Villa Gourmet",
        "• apagar/limpar memória"
      ].join("\n");
      return res.status(200).json({ ok:true, text: help });
    }

    // 7) fallback IA (com memória)
    const hoje = nowBR().toLocaleString("pt-BR",{ timeZone: TZ });
    const hist = [];
    if (memory?.summary) hist.push({ role:"system", content:`Memória resumida do usuário: ${memory.summary}` });
    for (const t of memory?.turns || []) {
      if (t.u) hist.push({ role:"user", content: t.u });
      if (t.a) hist.push({ role:"assistant", content: t.a });
    }

    const r = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role:"system", content: "Você é um assistente do Grupo DV. Use a memória abaixo quando for relevante. Responda em PT-BR, objetivo." },
        ...hist,
        { role:"user", content: `${q}\n(Hoje é ${hoje})` }
      ],
      temperature: 0.3,
      metadata: { source:"whatsapp", prompt_id:"pmpt_123456", route:"fallback", from: from || "" }
    });
    const text = r.output_text?.trim() || "";

    await saveMemory(from, q, text);
    await summarizeIfLarge(from);
    return res.status(200).json({ ok:true, text });

  } catch (err) {
    const mapped = mapOpenAIError(err);
    console.error("Agent error:", err?.message || err);
    return res.status(200).json(mapped);
  }
}
