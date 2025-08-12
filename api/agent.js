// api/agent.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utils ----------
const TZ = "America/Sao_Paulo";
const mesesPT = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

const toBRL = (n) => `R$ ${Number(n||0).toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
const toPct = (n) => `${Number(n||0).toLocaleString("pt-BR",{maximumFractionDigits:1})}%`;

const strip = (s="") => s.normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().trim();

// datas
const parseISO = (s) => {
  const d = new Date(`${s}T00:00:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const ymd = (d) => d.toISOString().slice(0,10);

function getMesRef(txt="") {
  if (/m[eê]s\s+passado/i.test(txt)) {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    d.setUTCMonth(d.getUTCMonth()-1);
    return { mes: d.getUTCMonth()+1, ano: d.getUTCFullYear(), label:`${mesesPT[d.getUTCMonth()]} de ${d.getUTCFullYear()}` };
  }
  const m = txt.toLowerCase().match(/(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(de|\/|\-| )?\s*(\d{4})?/);
  if (m) {
    const mesIdx = mesesPT.findIndex(x => x.startsWith(m[1].replace("ç","c")));
    const ano = m[3] ? Number(m[3]) : new Date().getFullYear();
    return { mes: mesIdx+1, ano, label:`${mesesPT[mesIdx]} de ${ano}` };
  }
  const now = new Date();
  return { mes: now.getMonth()+1, ano: now.getFullYear(), label:`${mesesPT[now.getMonth()]} de ${now.getFullYear()}` };
}

function parseDia(txt="") {
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
      previsto,                 // valor de META mensal (repetido por dia)
      realizado                 // valor realizado do dia
    });
  }
  return rows;
}

// ---- resumo corrigido: Previsto = meta mensal 1x; Realizado = soma do mês
function resumoMes(rows, { mes, ano }) {
  const fil = rows.filter((r) => r.mes === mes && r.ano === ano);
  const map = new Map();

  for (const r of fil) {
    const k = r.empresaKey;
    let agg = map.get(k);
    if (!agg) {
      agg = { empresa: r.empresa, prevMensal: 0, realSum: 0 };
      map.set(k, agg);
    }
    agg.realSum += r.realizado;
    if (r.previsto > agg.prevMensal) agg.prevMensal = r.previsto; // pega 1 meta mensal
  }

  const empresas = [...map.values()].map((e) => {
    const pct = e.prevMensal > 0 ? (e.realSum / e.prevMensal) * 100 : 0;
    return {
      empresa: e.empresa,
      previsto: e.prevMensal,
      realizado: e.realSum,
      pct,
      bateu: e.prevMensal > 0 ? e.realSum >= e.prevMensal : false,
    };
  }).sort((a, b) => b.pct - a.pct);

  const totalPrev = empresas.reduce((s, x) => s + x.previsto, 0);
  const totalReal = empresas.reduce((s, x) => s + x.realizado, 0);
  const totalPct = totalPrev > 0 ? (totalReal / totalPrev) * 100 : 0;

  return { empresas, totalPrev, totalReal, totalPct };
}

function percentualDia(rows, { empresaKey, iso }) {
  const fil = rows.filter((r) => r.empresaKey === empresaKey && r.dataISO === iso);
  if (!fil.length) return null;
  const prev = fil.reduce((s, x) => s + x.previsto, 0);      // cuidado: aqui é meta mensal por linha
  const rea  = fil.reduce((s, x) => s + x.realizado, 0);
  // Como Previsto é mensal, para o dia o percentual fica “realizado vs meta mensal”.
  // Se quiser, podemos dividir meta mensal por número de dias úteis — me avisa.
  return { previsto: prev, realizado: rea, pct: prev > 0 ? (rea / prev) * 100 : 0 };
}

// ---------- Intents ----------
function detectIntent(qRaw) {
  const q = qRaw.trim();
  const qLow = q.toLowerCase();

  if ((/percentual|%|porcent/.test(qLow)) && (/dia|\/|\-/.test(qLow))) {
    const d = parseDia(qLow);
    const m = q.match(/(?:no|na|do|da)\s+(.+)$/i);
    const empresa = m ? m[1].trim() : "";
    return { kind:"pctDia", args:{ dia:d, empresa } };
  }

  if (/quem.*bateu.*meta/i.test(qLow)) {
    const mesRef = getMesRef(qLow);
    return { kind:"quemBateu", args:{ mesRef } };
  }

  if (/metas|resumo/.test(qLow) && /m[eê]s/.test(qLow)) {
    const mesRef = getMesRef(qLow);
    return { kind:"resumoMes", args:{ mesRef } };
  }

  return { kind:"ai" };
}

// ---------- IA (Responses API) ----------
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

async function aiNLG({ instruction, context, route, from }) {
  const hoje = new Date().toLocaleString("pt-BR",{ timeZone: TZ });
  const system = [
    "Você é um analista do Grupo DV. Responda SEMPRE em Português do Brasil.",
    "Seja objetivo e claro. Use bullets quando fizer sentido.",
    "Formate datas em DD/MM/AAAA e valores como R$ 0,00. Percentuais como 0,0%.",
    "Não invente números: use apenas os dados do contexto JSON."
  ].join("\n");

  const r = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content:
`Hoje é ${hoje}.

INSTRUÇÃO:
${instruction}

CONTEXTO (JSON):
${JSON.stringify(context)}` },
    ],
    temperature: 0.2,
    metadata: { source: "whatsapp", prompt_id: "pmpt_123456", route: route || "metas.nlg", from: from || "" },
  });

  return r.output_text?.trim() || "";
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, error:"Method not allowed" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok:false, error:"OPENAI_API_KEY não configurada" });
    }

    const { q = "", from } = req.body || {};
    if (!q || typeof q !== "string") {
      return res.status(400).json({ ok:false, error:"Missing 'q' string" });
    }

    const intent = detectIntent(q);

    // 1) % do dia X para uma empresa — usa IA para “narrar” o resultado
    if (intent.kind === "pctDia") {
      const rows = await fetchMetas();
      const { dia, empresa } = intent.args;
      if (!dia?.iso || !empresa) {
        return res.status(200).json({ ok:true, text:"Informe a empresa e a data. Ex.: % do dia 02/08/2025 no Mercatto Delícia." });
      }
      const empresaKey = strip(empresa);
      const r = percentualDia(rows, { empresaKey, iso: dia.iso });
      if (!r) return res.status(200).json({ ok:true, text:`Não encontrei registros para ${empresa} em ${dia.iso}.` });

      const text = await aiNLG({
        instruction: `Explique, em poucas linhas, o desempenho do dia para a empresa informada. Mostre Previsto, Realizado e Percentual. Seja direto.`,
        context: { empresa, data: dia.iso, previsto: r.previsto, realizado: r.realizado, pct: r.pct },
        route: "metas.pctDia",
        from
      });
      return res.status(200).json({ ok:true, text });
    }

    // 2) Resumo do mês — agrega e passa o JSON para a IA narrar
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
        from
      });
      return res.status(200).json({ ok:true, text });
    }

    // 3) Quem bateu a meta — também “narrado” pela IA
    if (intent.kind === "quemBateu") {
      const rows = await fetchMetas();
      const { mesRef } = intent.args;
      const sum = resumoMes(rows, mesRef);
      const bateu = sum.empresas.filter(e=>e.bateu).map(e=>({ empresa:e.empresa, pct:e.pct }));

      const text = await aiNLG({
        instruction: `Liste as empresas que bateram a meta no mês, com o percentual. Caso nenhuma tenha batido, diga isso claramente.`,
        context: { mes: mesRef.mes, ano: mesRef.ano, label: mesRef.label, bateu },
        route: "metas.quemBateu",
        from
      });
      return res.status(200).json({ ok:true, text });
    }

    // 4) fallback IA genérico
    const hoje = new Date().toLocaleString("pt-BR",{ timeZone: TZ });
    const r = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role:"system", content: "Você é um assistente do Grupo DV. Responda em PT-BR, de forma objetiva." },
        { role:"user", content: `${q}\n(Hoje é ${hoje})` }
      ],
      temperature: 0.3,
      metadata: { source:"whatsapp", prompt_id:"pmpt_123456", route:"fallback", from: from || "" }
    });
    const text = r.output_text || "";
    return res.status(200).json({ ok:true, text });
  } catch (err) {
    const mapped = mapOpenAIError(err);
    console.error("Agent error:", err?.message || err);
    return res.status(200).json(mapped);
  }
}
