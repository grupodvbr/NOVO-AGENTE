// api/agent.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utils ----------
const TZ = "America/Sao_Paulo";
const mesesPT = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

const toBRL = (n) => `R$ ${Number(n||0).toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
const toPct = (n) => `${Number(n||0).toLocaleString("pt-BR",{maximumFractionDigits:1})}%`;

const strip = (s="") => s.normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().trim();
const onlyDigits = (s="") => String(s).replace(/\D/g,"");

// data helpers
const parseISO = (s) => {
  // espera "YYYY-MM-DD"
  const d = new Date(`${s}T00:00:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const ymd = (d) => d.toISOString().slice(0,10);

function getMesRef(txt="") {
  // “mês passado”
  if (/m[eê]s\s+passado/i.test(txt)) {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    d.setUTCMonth(d.getUTCMonth()-1);
    return { mes: d.getUTCMonth()+1, ano: d.getUTCFullYear(), label:`${mesesPT[d.getUTCMonth()]} de ${d.getUTCFullYear()}` };
  }
  // “agosto de 2025”, “ago 2025”, “agosto/2025”
  const m = txt.toLowerCase().match(/(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(de|\/|\-| )?\s*(\d{4})?/);
  if (m) {
    const mesIdx = mesesPT.findIndex(x => x.startsWith(m[1].replace("ç","c")));
    const ano = m[3] ? Number(m[3]) : new Date().getFullYear();
    return { mes: mesIdx+1, ano, label:`${mesesPT[mesIdx]} de ${ano}` };
  }
  // default: mês atual
  const now = new Date();
  return { mes: now.getMonth()+1, ano: now.getFullYear(), label:`${mesesPT[now.getMonth()]} de ${now.getFullYear()}` };
}

function parseDia(txt="") {
  // “02/08/2025”, “2/8”, “dia 2 de agosto de 2025”
  const ddmmaa = txt.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (ddmmaa) {
    const d = Number(ddmmaa[1]), m = Number(ddmmaa[2]);
    const y = ddmmaa[3] ? Number(ddmmaa[3].length===2 ? "20"+ddmmaa[3] : ddmmaa[3]) : new Date().getFullYear();
    return { dia:d, mes:m, ano:y, iso: `${y.toString().padStart(4,"0")}-${m.toString().padStart(2,"0")}-${d.toString().padStart(2,"0")}` };
  }
  return null;
}

// ---------- Fetch & normalize ----------
async function fetchMetas() {
  const url = process.env.METAS_URL;
  if (!url) throw new Error("METAS_URL não configurada");
  const r = await fetch(url, { cache:"no-store" });
  const raw = await r.text();
  let data = [];
  try { data = JSON.parse(raw); } catch { throw new Error("METAS_URL não retornou JSON"); }

  // normaliza
  const rows = [];
  for (const it of data) {
    const Data = String(it.Data || it.data || "").trim();
    const Empresa = String(it.Empresa || it.empresa || "").trim();
    const Previsto = it.Previsto ?? it.previsto ?? "";
    const Realizado = it.Realizado ?? it.realizado ?? "";

    // descarta ruins
    if (!Data || Data === "1969-12-31") continue;
    if (Previsto === "" || Realizado === "") continue;
    const d = parseISO(Data);
    if (!d) continue;

    const previsto = Number(Previsto);
    const realizado = Number(Realizado);
    if (!Number.isFinite(previsto) || !Number.isFinite(realizado)) continue;

    const pct = previsto > 0 ? (realizado/previsto)*100 : 0;

    rows.push({
      dataISO: ymd(d),
      ano: d.getFullYear(),
      mes: d.getMonth()+1,
      dia: d.getDate(),
      empresa: Empresa.trim(),
      empresaKey: strip(Empresa),
      previsto, realizado, pct
    });
  }
  return rows;
}

// summaries
function resumoMes(rows, {mes,ano}) {
  const fil = rows.filter(r => r.mes===mes && r.ano===ano);
  const map = new Map();
  for (const r of fil) {
    const k = r.empresaKey;
    const agg = map.get(k) || { empresa:r.empresa, prev:0, real:0 };
    agg.prev += r.previsto;
    agg.real += r.realizado;
    map.set(k, agg);
  }
  const empresas = [...map.values()].map(x => ({
    empresa: x.empresa,
    previsto: x.prev,
    realizado: x.real,
    pct: x.prev>0 ? (x.real/x.prev)*100 : 0,
    bateu: x.prev>0 ? (x.real/x.prev)>=1 : false
  })).sort((a,b)=>b.pct-a.pct);

  const totalPrev = empresas.reduce((s,x)=>s+x.previsto,0);
  const totalReal = empresas.reduce((s,x)=>s+x.realizado,0);
  const totalPct = totalPrev>0 ? (totalReal/totalPrev)*100 : 0;

  return { empresas, totalPrev, totalReal, totalPct };
}

function percentualDia(rows, {empresaKey, iso}) {
  const fil = rows.filter(r => r.empresaKey===empresaKey && r.dataISO===iso);
  if (!fil.length) return null;
  const prev = fil.reduce((s,x)=>s+x.previsto,0);
  const rea = fil.reduce((s,x)=>s+x.realizado,0);
  return { previsto:prev, realizado:rea, pct: prev>0 ? (rea/prev)*100 : 0 };
}

// ---------- Intents ----------
function detectIntent(qRaw) {
  const q = qRaw.trim();
  const qLow = q.toLowerCase();

  // % do dia X para empresa Y
  if ((/percentual|%|porcent/.test(qLow)) && (/dia|\/|\-/.test(qLow))) {
    const d = parseDia(qLow);
    // tenta achar empresa como trecho depois de "no|da|do"
    const m = q.match(/(?:no|na|do|da)\s+(.+)$/i);
    const empresa = m ? m[1].trim() : "";
    return { kind:"pctDia", args:{ dia:d, empresa } };
  }

  // quem bateu a meta (mês passado ou mês X)
  if (/quem.*bateu.*meta/i.test(qLow)) {
    const mesRef = getMesRef(qLow);
    return { kind:"quemBateu", args:{ mesRef } };
  }

  // metas do mês passado / resumo do mês
  if (/metas|resumo/.test(qLow) && /m[eê]s/.test(qLow)) {
    const mesRef = getMesRef(qLow);
    return { kind:"resumoMes", args:{ mesRef } };
  }

  // fallback IA
  return { kind:"ai" };
}

// ---------- IA fallback ----------
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

async function ia(q) {
  const hoje = new Date().toLocaleString("pt-BR",{ timeZone: TZ });
  const sys = [
    "Você é um assistente do Grupo DV. Responda sempre em PT-BR, de forma objetiva.",
    "Formate listas com bullets, datas em DD/MM/AAAA e valores como R$ 0,00.",
    `Hoje é ${hoje}.`
  ].join("\n");
  const r = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role:"system", content: sys },
      { role:"user", content: q }
    ],
    temperature: 0.3,
    metadata: { source:"whatsapp", prompt_id:"pmpt_metas_v1" }
  });
  const text = r.output_text || r?.content?.[0]?.text?.value || "";
  return { ok:true, text };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, error:"Method not allowed" });
    }
    const { q="" } = req.body || {};
    if (!q) return res.status(400).json({ ok:false, error:"Missing 'q' string" });

    const intent = detectIntent(q);
    const rows = (intent.kind !== "ai") ? await fetchMetas() : null;

    // 1) percentual no dia X (empresa)
    if (intent.kind === "pctDia") {
      const { dia, empresa } = intent.args;
      if (!dia?.iso || !empresa) return res.status(200).json({ ok:true, text:"Informe a empresa e a data. Ex.: % do dia 02/08/2025 no Mercatto Delícia." });
      const empresaKey = strip(empresa);
      const r = percentualDia(rows, { empresaKey, iso: dia.iso });
      if (!r) return res.status(200).json({ ok:true, text:`Não encontrei registros para ${empresa} em ${dia.iso}.` });
      const txt = [
        `*${empresa}* — ${dia.iso}`,
        `Previsto: ${toBRL(r.previsto)}`,
        `Realizado: ${toBRL(r.realizado)}`,
        `Percentual: *${toPct(r.pct)}*`
      ].join("\n");
      return res.status(200).json({ ok:true, text: txt });
    }

    // 2) resumo do mês (todas as empresas)
    if (intent.kind === "resumoMes") {
      const { mesRef } = intent.args;
      const sum = resumoMes(rows, mesRef);
      const linhas = sum.empresas.map(e =>
        `• ${e.empresa}: ${toBRL(e.realizado)} / ${toBRL(e.previsto)} (${toPct(e.pct)}) ${e.bateu ? "✅" : "❌"}`
      );
      const quem = sum.empresas.filter(e=>e.bateu).map(e=>e.empresa);
      const txt = [
        `*Resumo de metas — ${mesRef.label}*`,
        `Total: ${toBRL(sum.totalReal)} / ${toBRL(sum.totalPrev)} (${toPct(sum.totalPct)})`,
        "",
        ...linhas,
        "",
        `Bateram a meta: ${quem.length ? quem.join(", ") : "ninguém 😕"}`
      ].join("\n");
      return res.status(200).json({ ok:true, text: txt });
    }

    // 3) quem bateu a meta no mês
    if (intent.kind === "quemBateu") {
      const { mesRef } = intent.args;
      const sum = resumoMes(rows, mesRef);
      const bateu = sum.empresas.filter(e=>e.bateu).sort((a,b)=>b.pct-a.pct);
      const txt = bateu.length
        ? `*Quem bateu a meta — ${mesRef.label}*\n` + bateu.map(e=>`• ${e.empresa} — ${toPct(e.pct)}`).join("\n")
        : `Ninguém bateu a meta em ${mesRef.label}.`;
      return res.status(200).json({ ok:true, text: txt });
    }

    // 4) fallback IA
    const out = await ia(q);
    return res.status(200).json(out);

  } catch (err) {
    const mapped = mapOpenAIError(err);
    console.error("Agent error:", err?.message || err);
    return res.status(200).json(mapped);
  }
}
