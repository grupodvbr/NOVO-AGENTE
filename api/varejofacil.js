export default async function handler(req, res) {
  const { action, ...params } = req.query;

  const BASE_URL = process.env.VF_BASE_URL;
  const API_KEY_HEADER = process.env.VF_API_KEY_HEADER;
  const API_KEY = process.env.VF_API_KEY;

  async function callVarejoFacil(endpoint, query = {}) {
    const url = new URL(`${BASE_URL}${endpoint}`);
    Object.keys(query).forEach(key => {
      if (query[key] !== undefined && query[key] !== null) {
        url.searchParams.append(key, query[key]);
      }
    });

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        [API_KEY_HEADER]: API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Erro na API Varejo Fácil: ${response.status} - ${await response.text()}`);
    }

    return response.json();
  }

  try {
    if (action === 'resumo-financeiro') {
      // Endpoint de resumo financeiro - ajustar se a doc indicar outro caminho
      const data = await callVarejoFacil('/v1/venda/resumo', {
        dataInicial: params.dataInicial,
        dataFinal: params.dataFinal,
        lojaId: params.lojaId
      });
      res.status(200).json(data);

    } else if (action === 'debug-cupons') {
      // Lista de cupons fiscais - útil para teste
      const data = await callVarejoFacil('/v1/venda/cupons-fiscais', {
        dataInicial: params.dataInicial,
        dataFinal: params.dataFinal,
        lojaId: params.lojaId,
        page: params.page || 1,
        pageSize: params.pageSize || 200
      });
      res.status(200).json(data);

    } else {
      res.status(400).json({ error: 'Ação inválida' });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
