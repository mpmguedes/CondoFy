const { getConfig, setConfig } = require('./config');

// Configuração global das quotas: valor por 1000‰ (total do condomínio) e % do FCR.
// O valor por 1000‰ representa o montante para a totalidade da permilagem (1000‰),
// não o valor de cada 1‰. Ex.: 100 € por 1000‰; fração de 500‰ → base 50 €.
async function getQuotaConfig() {
  let [valorPor1000, fcrPercentagem] = await Promise.all([
    getConfig('quota_valor_1000', null),
    getConfig('quota_fcr_percentagem', '10'),
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

module.exports = { getQuotaConfig, setQuotaConfig };
