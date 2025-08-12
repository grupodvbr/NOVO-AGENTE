// --- helpers de leitura segura com múltiplas chaves possíveis
const pick = (obj, keys, def = 0) => {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return def;
};
const normStr = (s) => (s || '').toString().trim().toUpperCase();
const isCanceled = (sale) => {
  const s = normStr(pick(sale, ['status', 'situacao', 'saleStatus', 'situacao_venda'], ''));
  return ['CANCELADA','CANCELADO','CANCELED','ESTORNADA','ESTORNADO'].includes(s);
};
const getStoreId = (sale) => pick(sale, ['storeId','lojaId','filialId','empresaId','id_loja'], null);
const getStoreName = (sale) => pick(sale, ['storeName','lojaNome','filialNome','empresaNome','nome_loja'], String(getStoreId(sale) || ''));
const getPayments = (sale) => pick(sale, ['payments','pagamentos','formasPagamento','recebimentos'], []) || [];
const getPaymentMethod = (p) => normStr(pick(p, ['method','forma','tipo','descricao','meioPagamento','descricao_forma'], 'DESCONHECIDO'));
const getPaymentAmount = (p) => Number(pick(p, ['amount','valor','valorRecebido','valor_pago'], 0));
const getItems = (sale) => pick(sale, ['items','itens','produtos'], []) || [];
const getQty = (it) => Number(pick(it, ['quantity','qtd','quantidade'], 0));
const getUnitPrice = (it) => Number(pick(it, ['unitPrice','preco','valorUnit','valor_unitario'], 0));

const getGross = (sale) =>
  Number(pick(sale, ['totalGross','valorBruto','total_bruto'], null) ??
    getItems(sale).reduce((s,it)=> s + getQty(it)*getUnitPrice(it), 0));

const getDiscounts = (sale) => Number(pick(sale, ['totalDiscount','descontoTotal','descontos','valorDesconto','total_desconto'], 0));
const getSurcharges = (sale) => Number(pick(sale, ['totalSurcharge','acrescimos','taxas','valorAcrescimo','total_acrescimo'], 0));
const getTaxes = (sale) => Number(pick(sale, ['totalTax','impostos','valorImposto','total_impostos','taxes'], 0));
const getNet = (sale) => Number(pick(sale, ['totalNet','valorLiquido','total_liquido','total'], null) ??
  Math.max(0, getGross(sale) - getDiscounts(sale) + getSurcharges(sale)));

const getRefund = (sale) => Number(pick(sale, ['refund','estorno','valorEstorno','valor_devolucao'], 0));

async function financialSummary({ startDate, endDate, storeId }) {
  const allSales = await drain(listSales, { startDate, endDate, pageSize: 200 }, 'items', 200);

  // filtro por loja/empresa se informado
  const sales = storeId ? allSales.filter(s => String(getStoreId(s)) === String(storeId)) : allSales;

  // agregadores
  let gross=0, discounts=0, surcharges=0, taxes=0, net=0, canceled=0, refunds=0, itemsSold=0;
  let salesCompleted = 0, salesCanceled = 0;

  const byPay = new Map();   // method -> { amount, count }
  const byStore = new Map(); // storeId -> { name, net, count }

  for (const sale of sales) {
    const canceledFlag = isCanceled(sale);
    const g = getGross(sale);
    const d = getDiscounts(sale);
    const a = getSurcharges(sale);
    const t = getTaxes(sale);
    const n = getNet(sale);
    const r = getRefund(sale);

    gross += g;
    discounts += d;
    surcharges += a;
    taxes += t;
    net += n;
    refunds += r;

    if (canceledFlag) {
      salesCanceled++;
      canceled += n || g; // se líquido vier 0 em canceladas, usa bruto
    } else {
      salesCompleted++;
      // itens vendidos
      itemsSold += getItems(sale).reduce((s,it)=> s + getQty(it), 0);

      // pagamentos
      const pays = getPayments(sale);
      if (pays.length) {
        for (const p of pays) {
          const m = getPaymentMethod(p) || 'DESCONHECIDO';
          const val = getPaymentAmount(p) || 0;
          const agg = byPay.get(m) || { amount: 0, count: 0 };
          agg.amount += val;
          agg.count += 1;
          byPay.set(m, agg);
        }
      } else {
        // se a venda não detalha pagamentos, agrega tudo no método "NÃO INFORMADO"
        const m = 'NÃO INFORMADO';
        const agg = byPay.get(m) || { amount: 0, count: 0 };
        agg.amount += n;
        agg.count += 1;
        byPay.set(m, agg);
      }

      // por loja
      const sid = String(getStoreId(sale) ?? 'desconhecida');
      const sname = getStoreName(sale) || sid;
      const st = byStore.get(sid) || { name: sname, net: 0, count: 0 };
      st.net += n;
      st.count += 1;
      byStore.set(sid, st);
    }
  }

  const byPaymentMethod = [...byPay.entries()]
    .map(([method, v]) => ({ method, amount: Number(v.amount.toFixed(2)), count: v.count }))
    .sort((a,b)=> b.amount - a.amount);

  const byStoreArr = [...byStore.entries()]
    .map(([sid, v]) => ({ storeId: sid, name: v.name, net: Number(v.net.toFixed(2)), count: v.count }))
    .sort((a,b)=> b.net - a.net);

  return {
    period: { startDate, endDate, timezone: 'America/Bahia' },
    filters: { storeId: storeId ?? null },
    counts: { sales: sales.length, salesCompleted, salesCanceled, itemsSold },
    totals: {
      gross: Number(gross.toFixed(2)),
      discounts: Number(discounts.toFixed(2)),
      surcharges: Number(surcharges.toFixed(2)),
      taxes: Number(taxes.toFixed(2)),
      net: Number(net.toFixed(2)),
      canceled: Number(canceled.toFixed(2)),
      refunds: Number(refunds.toFixed(2)),
    },
    avgTicket: { net: Number((salesCompleted ? net / salesCompleted : 0).toFixed(2)) },
    byPaymentMethod,
    byStore: byStoreArr
  };
}
