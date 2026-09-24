// ─────────────────────────────────────────────────────────────────────
// Âmbito por condomínio das configurações chave-valor.
//
// A tabela `configuracoes` é chave-valor e NÃO tem (nem passa a ter) uma coluna
// `condominio_id`. Uma configuração que precise de âmbito ganha uma chave
// PRÓPRIA, com a convenção que o armazenamento e as quotas já usam:
//
//   auto_quotas_drive:c12        ← automação «quotas → drive» do condomínio 12
//   notif_recibos_email:c12      ← notificação «recibos → email» do cond. 12
//
// A chave base (`auto_quotas_drive`, `notif_recibos_email`) mantém-se intacta e
// funciona como valor HERDADO (global).
//
// PRECEDÊNCIA da leitura:
//   1. chave específica do condomínio  ─ <chave>:c<ID>
//   2. chave global existente          ─ <chave>
//   3. default do código               ─ decide quem chama
//
// Consequência prática: uma instalação que só tenha as chaves globais continua a
// comportar-se exatamente como antes, sem qualquer escrita na base de dados; e
// uma leitura SEM contexto de condomínio (jobs globais) nunca é afetada pelo que
// um condomínio gravou no seu próprio âmbito.
//
// ⛔ `helpers/quotas-config.js` tem a sua própria cópia desta convenção (escrita
// antes deste módulo existir). Não foi tocado — unificar as duas é uma tarefa
// separada, de risco próprio, fora do âmbito desta frente.
// ─────────────────────────────────────────────────────────────────────
const { getConfig, setConfig } = require('./config');

// Normaliza o id do condomínio. Devolve `null` quando não é um id utilizável —
// nesse caso a leitura cai nas chaves globais e a ESCRITA é recusada (ver
// `gravarNoAmbito`), para nunca gravar uma configuração de âmbito indefinido.
function idCondominio(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Chave de uma configuração no âmbito de um condomínio concreto.
// Devolve `null` se o condomínio não for válido (nunca inventa `:cNaN`).
function chaveDoCondominio(chave, condominioId) {
  const id = idCondominio(condominioId);
  return id ? `${chave}:c${id}` : null;
}

// Lê um valor com a precedência documentada acima.
// Devolve `undefined` quando não existe nem no âmbito do condomínio nem global
// (para o consumidor distinguir «não configurado» de um valor vazio).
async function lerComPrecedencia(chave, condominioId) {
  const doCondominio = chaveDoCondominio(chave, condominioId);
  if (doCondominio) {
    const valor = await getConfig(doCondominio, null);
    if (valor !== null && valor !== '') return valor;
  }
  const global = await getConfig(chave, null);
  return global === null || global === '' ? undefined : global;
}

// Grava uma configuração NO ÂMBITO do condomínio indicado.
// ⛔ `condominioId` é OBRIGATÓRIO: sem âmbito válido a escrita é RECUSADA (nunca
// se grava a chave global, que afetaria todos os condomínios). O âmbito tem de
// vir de quem chama — o condomínio ativo da sessão (já validado pelo tenant) ou
// o condomínio a processar no job. Este módulo nunca lê a sessão nem o pedido.
async function gravarNoAmbito(chave, valor, condominioId, { origem } = {}) {
  const id = idCondominio(condominioId);
  if (!id) {
    throw new Error(
      `${origem || 'gravarNoAmbito'} exige um condominioId válido `
      + '(não é possível gravar configuração sem âmbito).'
    );
  }
  return setConfig(chaveDoCondominio(chave, id), String(valor));
}

module.exports = { idCondominio, chaveDoCondominio, lerComPrecedencia, gravarNoAmbito };
