const { getConfig, setConfig } = require('./config');

// Percentagem mínima do Fundo Comum de Reserva sobre a quota-parte nas restantes
// despesas do condomínio (mínimo legal em Portugal). NÃO é um valor fixo: o
// condomínio pode contribuir acima deste valor; abaixo é que não pode.
const FCR_MINIMO_LEGAL = 10;

// Valor por 1000‰ usado quando não existe qualquer configuração (nem específica
// do condomínio, nem global). É o mesmo default que o seeder inicial grava.
const VALOR_POR_1000_PADRAO = '100.0000';

// ── Âmbito das configurações de quotas ──────────────────────────────
// As quotas e o FCR são decididos por condomínio (por exemplo, a percentagem do
// FCR é aprovada em assembleia de cada condomínio). A tabela `configuracoes` é
// chave-valor e continua a ser usada por configurações legitimamente globais
// (SMTP, ligações de armazenamento, notificações), pelo que NÃO passa a ter uma
// coluna `condominio_id`: as configurações que precisam de âmbito ganham uma
// chave PRÓPRIA, com o mesmo padrão que o armazenamento já usa
// (`storage:*:c<id>`):
//
//   quota_valor_1000:c12          ← valor por 1000‰ do condomínio 12
//   quota_fcr_percentagem:c12     ← percentagem de FCR do condomínio 12
//
// As chaves base (`quota_valor_1000`, `quota_fcr_percentagem`) mantêm-se
// intactas e passam a funcionar como valor herdado.
//
// PRECEDÊNCIA (a mesma para as duas configurações):
//   1. chave específica do condomínio  ─ quota_valor_1000:c<ID>
//   2. chave global existente          ─ quota_valor_1000
//   3. default do código               ─ VALOR_POR_1000_PADRAO / FCR_MINIMO_LEGAL
//
// Consequência prática: uma instalação que só tenha as chaves globais continua a
// comportar-se exatamente como antes, sem qualquer escrita na base de dados.
const CHAVE_VALOR_1000 = 'quota_valor_1000';
const CHAVE_FCR_PERCENTAGEM = 'quota_fcr_percentagem';

// Chave antiga (€ por 1‰), anterior à migração 40 — lida apenas para
// compatibilidade quando não existe nem chave específica nem global.
const CHAVE_VALOR_PERMILAGEM_LEGADO = 'quota_valor_permilagem';

// Lê uma percentagem de FCR dada (formulário/configuração). Aceita decimais
// («12,5») e devolve a decisão de validação — usada pela rota e pelos testes.
// Independente do âmbito: valida o valor, não decide onde o gravar.
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

// Normaliza o id do condomínio. Devolve null quando não é um id utilizável —
// nesse caso a leitura cai nas chaves globais e a escrita é recusada (ver
// `setQuotaConfig`), para nunca gravar uma configuração de âmbito indefinido.
function idCondominio(condominioId) {
  const n = Number(condominioId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Chave de uma configuração no âmbito de um condomínio concreto.
function chaveDoCondominio(chave, condominioId) {
  const id = idCondominio(condominioId);
  return id ? `${chave}:c${id}` : null;
}

// Lê um valor com a precedência documentada acima.
// Devolve `undefined` quando não existe nem no âmbito do condomínio nem global
// (para o consumidor distinguir "não configurado" de um valor vazio).
async function lerComPrecedencia(chave, condominioId) {
  const doCondominio = chaveDoCondominio(chave, condominioId);
  if (doCondominio) {
    const valor = await getConfig(doCondominio, null);
    if (valor !== null && valor !== '') return valor;
  }
  const global = await getConfig(chave, null);
  return global === null || global === '' ? undefined : global;
}

// Configuração das quotas: valor por 1000‰ (total do condomínio) e % do FCR.
// O valor por 1000‰ representa o montante para a totalidade da permilagem (1000‰),
// não o valor de cada 1‰. Ex.: 100 € por 1000‰; fração de 500‰ → base 50 €.
//
// `condominioId` é OBRIGATÓRIO: o âmbito tem de vir de quem chama (o condomínio
// ativo da sessão, já validado pelo tenant, ou o condomínio a processar no job).
// Este módulo nunca lê a sessão nem o pedido HTTP.
async function getQuotaConfig(condominioId) {
  const [valorDoCondominio, fcrDoCondominio] = await Promise.all([
    lerComPrecedencia(CHAVE_VALOR_1000, condominioId),
    lerComPrecedencia(CHAVE_FCR_PERCENTAGEM, condominioId),
  ]);

  let valorPor1000 = valorDoCondominio;
  let fcrPercentagem = fcrDoCondominio;

  // Compatibilidade: se ainda só existir a chave antiga (€ por 1‰), converte.
  if (valorPor1000 === undefined) {
    const antigo = await getConfig(CHAVE_VALOR_PERMILAGEM_LEGADO, null);
    if (antigo !== null && antigo !== '') {
      const v = parseFloat(String(antigo).replace(',', '.'));
      valorPor1000 = Number.isFinite(v) ? String((v * 1000).toFixed(4)) : VALOR_POR_1000_PADRAO;
    } else {
      valorPor1000 = VALOR_POR_1000_PADRAO;
    }
  }

  if (fcrPercentagem === undefined) fcrPercentagem = String(FCR_MINIMO_LEGAL);

  return { valorPor1000, fcrPercentagem };
}

// Grava a configuração NO ÂMBITO do condomínio indicado. As chaves globais
// existentes nunca são reescritas: uma instalação que já tinha valores globais
// mantém-nos como valor herdado pelos condomínios que ainda não tenham os seus.
async function setQuotaConfig(condominioId, { valorPor1000, fcrPercentagem }) {
  const id = idCondominio(condominioId);
  if (!id) {
    throw new Error('setQuotaConfig exige um condominioId válido (não é possível gravar configuração sem âmbito).');
  }
  await setConfig(chaveDoCondominio(CHAVE_VALOR_1000, id), String(valorPor1000));
  await setConfig(chaveDoCondominio(CHAVE_FCR_PERCENTAGEM, id), String(fcrPercentagem));
}

module.exports = {
  getQuotaConfig,
  setQuotaConfig,
  validarFcrPercentagem,
  FCR_MINIMO_LEGAL,
  VALOR_POR_1000_PADRAO,
  CHAVE_VALOR_1000,
  CHAVE_FCR_PERCENTAGEM,
  chaveDoCondominio,
};
