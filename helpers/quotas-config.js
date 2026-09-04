const { getConfig, setConfig } = require('./config');

// Configuração global das quotas: valor por permilagem (€ por 1‰) e % do FCR.
async function getQuotaConfig() {
  const [valorPermilagem, fcrPercentagem] = await Promise.all([
    getConfig('quota_valor_permilagem', '0.1000'),
    getConfig('quota_fcr_percentagem', '10'),
  ]);
  return { valorPermilagem, fcrPercentagem };
}

async function setQuotaConfig({ valorPermilagem, fcrPercentagem }) {
  await setConfig('quota_valor_permilagem', String(valorPermilagem));
  await setConfig('quota_fcr_percentagem', String(fcrPercentagem));
}

module.exports = { getQuotaConfig, setQuotaConfig };
