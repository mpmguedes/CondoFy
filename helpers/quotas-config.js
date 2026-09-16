const { getConfig, setConfig } = require('./config');

// Percentagem mínima do Fundo Comum de Reserva sobre a quota-parte nas restantes
// despesas do condomínio (mínimo legal em Portugal). NÃO é um valor fixo: o
// condomínio pode contribuir acima deste valor; abaixo é que não pode.
const FCR_MINIMO_LEGAL = 10;

// Lê uma percentagem de FCR dada (formulário/configuração). Aceita decimais
// («12,5») e devolve a decisão de validação — usada pela rota e pelos testes.
function validarFcrPercentagem(valor) {
  const texto = String(valor === null || valor === undefined ? '' : valor).trim().replace(',', '.');
  if (texto === '') {
    return { ok: false, motivo: 'vazio', mensagem: 'Indique a percentagem do Fundo de Reserva (mínimo 10%).' };
  }
  const numero = Number(texto);
  if (!Number.isFinite(numero)) {
    return { ok: false, motivo: 'nao_numerico', mensagem: 'A percentagem do FCR tem de ser um número (ex.: 10).' };
  }
  if (numero < FCR_MINIMO_LEGAL) {
    return {
      ok: false,
      motivo: 'abaixo_do_minimo',
      valor: numero,
      mensagem: `A percentagem do FCR não pode ser inferior a ${FCR_MINIMO_LEGAL}% (mínimo legal sobre a quota-parte nas restantes despesas do condomínio). Indique ${FCR_MINIMO_LEGAL}% ou mais.`,
    };
  }
  if (numero > 100) {
    return { ok: false, motivo: 'acima_do_maximo', valor: numero, mensagem: 'A percentagem do FCR não pode ser superior a 100%.' };
  }
  return { ok: true, valor: numero };
}

// Configuração global das quotas: valor por 1000‰ (total do condomínio) e % do FCR.
// O valor por 1000‰ representa o montante para a totalidade da permilagem (1000‰),
// não o valor de cada 1‰. Ex.: 100 € por 1000‰; fração de 500‰ → base 50 €.
async function getQuotaConfig() {
  let [valorPor1000, fcrPercentagem] = await Promise.all([
    getConfig('quota_valor_1000', null),
    getConfig('quota_fcr_percentagem', String(FCR_MINIMO_LEGAL)),
  ]);

  // Compatibilidade: se ainda só existir a chave antiga (€ por 1‰), converte.
  if (valorPor1000 === null || valorPor1000 === '') {
    const antigo = await getConfig('quota_valor_permilagem', null);
    if (antigo !== null && antigo !== '') {
      const v = parseFloat(String(antigo).replace(',', '.'));
      valorPor1000 = Number.isFinite(v) ? String((v * 1000).toFixed(4)) : '100.0000';
    } else {
      valorPor1000 = '100.0000';
    }
  }

  return { valorPor1000, fcrPercentagem };
}

async function setQuotaConfig({ valorPor1000, fcrPercentagem }) {
  await setConfig('quota_valor_1000', String(valorPor1000));
  await setConfig('quota_fcr_percentagem', String(fcrPercentagem));
}

module.exports = { getQuotaConfig, setQuotaConfig, validarFcrPercentagem, FCR_MINIMO_LEGAL };
