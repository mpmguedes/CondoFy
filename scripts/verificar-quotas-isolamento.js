// ═══════════════════════════════════════════════════════════════════
// Verificação pós-deploy do isolamento de quotas por condomínio (E1 + E2).
// SOMENTE LEITURA.
//
// Utilização (no servidor, no diretório da aplicação):
//   node scripts/verificar-quotas-isolamento.js
//   docker compose exec app node scripts/verificar-quotas-isolamento.js
//
// Responde, sem alterar nada:
//   1. os condomínios existentes (id, nome, estado);
//   2. quais chaves de configuração de quotas existem (globais e por condomínio);
//   3. o que a aplicação DEVOLVE para cada condomínio, segundo a precedência;
//   4. se existem chaves específicas `:c<ID>` de condomínios inexistentes (órfãs);
//   5. se o job automático é carregável (sem o executar).
//
// Este script NÃO escreve na base de dados, NÃO gera quotas, NÃO envia emails e
// NÃO reinicia serviços. É seguro correr em produção.
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();

const FCR_MINIMO_LEGAL = 10;
const VALOR_POR_1000_PADRAO = '100.0000';

function linha(titulo) {
  console.log('');
  console.log('── ' + titulo + ' ' + '─'.repeat(Math.max(0, 58 - titulo.length)));
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Verificação de isolamento de quotas por condomínio (só leitura)');
  console.log('══════════════════════════════════════════════════════════════');

  const models = require('../models');
  const { Configuracao, Condominio, Fracao, Quota } = models;
  const { getQuotaConfig, CHAVE_VALOR_1000, CHAVE_FCR_PERCENTAGEM } = require('../helpers/quotas-config');

  // Prefixos cujo âmbito é por condomínio.
  const CHAVES_DE_QUOTA = [CHAVE_VALOR_1000 || 'quota_valor_1000', CHAVE_FCR_PERCENTAGEM || 'quota_fcr_percentagem'];
  const CHAVE_LEGADO = 'quota_valor_permilagem';

  // ── 1. Condomínios ────────────────────────────────────────────────
  linha('1. Condomínios');
  let condominios = [];
  try {
    condominios = await Condominio.findAll({ order: [['id', 'ASC']] });
  } catch (err) {
    console.log('  Não foi possível ler os condomínios: ' + err.message);
    console.log('  (execute este script no ambiente onde a aplicação corre)');
    process.exit(1);
  }
  console.log('  Total: ' + condominios.length);
  if (!condominios.length) console.log('  (não há condomínios registados)');
  for (const c of condominios) {
    const ativo = String(c.estado) === 'ativo';
    console.log(
      '   · id ' + String(c.id).padEnd(6) +
      (ativo ? '[ativo]  ' : '[inativo]') +
      ' ' + (c.nome || c.designacao || '(sem nome)')
    );
  }

  // ── 2. Chaves de configuração de quotas ───────────────────────────
  linha('2. Chaves de configuração de quotas');
  let todas = [];
  try {
    todas = await Configuracao.findAll({ order: [['chave', 'ASC']] });
  } catch (err) {
    console.log('  Não foi possível ler a configuração: ' + err.message);
    process.exit(1);
  }

  const chavesDeQuota = todas.filter((r) => CHAVES_DE_QUOTA.some((c) => r.chave === c || r.chave.startsWith(c + ':')));
  const legado = todas.filter((r) => r.chave === CHAVE_LEGADO);

  console.log('  Globais (herdadas por todos os condomínios):');
  let algumaGlobal = false;
  for (const base of CHAVES_DE_QUOTA) {
    const reg = todas.find((r) => r.chave === base);
    if (reg) { console.log('   · ' + base.padEnd(28) + ' = ' + reg.valor); algumaGlobal = true; }
    else console.log('   · ' + base.padEnd(28) + ' = (AUSENTE)');
  }
  if (legado.length) {
    console.log('  Chave legada (usada só se não existir global nem específica):');
    for (const r of legado) console.log('   · ' + r.chave.padEnd(28) + ' = ' + r.valor);
  }

  const especificas = chavesDeQuota.filter((r) => r.chave.includes(':c'));
  console.log('  Específicas por condomínio: ' + (especificas.length ? especificas.length : 'nenhuma'));
  for (const r of especificas) console.log('   · ' + r.chave.padEnd(28) + ' = ' + r.valor);

  // ── 3. Órfãs: chaves :c<ID> de condomínios inexistentes ───────────
  linha('3. Chaves específicas órfãs');
  const ids = new Set(condominios.map((c) => Number(c.id)));
  const orfas = especificas.filter((r) => {
    const m = r.chave.match(/:c(\d+)$/);
    return m && !ids.has(Number(m[1]));
  });
  if (!orfas.length) {
    console.log('  Nenhuma. Todas as chaves :c<ID> pertencem a condomínios existentes.');
  } else {
    console.log('  ATENÇÃO — ' + orfas.length + ' chave(s) apontam para condomínios que já não existem:');
    for (const r of orfas) console.log('   · ' + r.chave + ' = ' + r.valor);
    console.log('  (não afetam nenhum condomínio atual; podem ser removidas manualmente se quiser)');
  }

  // ── 4. O que a aplicação devolve para cada condomínio ─────────────
  linha('4. Configuração efetiva por condomínio (getQuotaConfig)');
  console.log('  Precedência: específica :c<ID> → global → default do código');
  console.log('');
  for (const c of condominios) {
    const id = Number(c.id);
    let cfg;
    try {
      cfg = await getQuotaConfig(id);
    } catch (err) {
      console.log('   · id ' + id + ': ERRO ao ler — ' + err.message);
      continue;
    }
    const temEsp = especificas.some((r) => r.chave.endsWith(':c' + id));
    const origem = temEsp ? 'específica deste condomínio' : (algumaGlobal ? 'global (herdada)' : 'default do código');
    console.log(
      '   · id ' + String(id).padEnd(6) +
      ' valor/1000‰=' + String(cfg.valorPor1000).padEnd(10) +
      ' FCR=' + String(cfg.fcrPercentagem).padEnd(5) +
      ' ← ' + origem
    );
  }

  // ── 5. Interruptor: só houver globais, o comportamento é o antigo ──
  linha('5. Compatibilidade da instalação');
  if (especificas.length === 0) {
    console.log('  Só existem chaves globais (ou nenhuma).');
    console.log('  Comportamento = exatamente o mesmo de antes desta fase, para TODOS os condomínios.');
    console.log('  As chaves globais nunca são reescritas pela aplicação.');
  } else {
    console.log('  Existem ' + especificas.length + ' chave(s) específica(s).');
    console.log('  Os condomínios com chave própria usam-na; os restantes herdam a global.');
  }
  console.log('  Defaults do código: valor/1000‰=' + VALOR_POR_1000_PADRAO + ' · FCR mínimo legal=' + FCR_MINIMO_LEGAL + '%');

  // ── 6. O job é carregável (sem o executar) ────────────────────────
  linha('6. Job automático — carregamento (NÃO é executado)');
  try {
    const job = require('../jobs/automatizacao');
    const funcoes = ['gerarQuotasAutomaticas', 'enviarLembretesAutomaticos', 'condominiosAtivos'];
    const faltam = funcoes.filter((f) => typeof job[f] !== 'function');
    if (faltam.length) {
      console.log('  PROBLEMA — funções em falta no job: ' + faltam.join(', '));
    } else {
      console.log('  Carregado com sucesso. Funções presentes: ' + funcoes.join(', '));
      const ativos = await job.condominiosAtivos();
      console.log('  Condomínios que o job processaria (só ativos): ' + ativos.map((c) => c.id).join(', ') || '(nenhum)');
      console.log('  Nada foi gerado nem enviado — este script não executa o job.');
    }
  } catch (err) {
    console.log('  ERRO ao carregar o job: ' + err.message);
  }

  // ── 7. Contexto (contagens, só para leitura) ──────────────────────
  linha('7. Contexto (contagens)');
  try {
    const [nFracoes, nQuotas] = await Promise.all([Fracao.count(), Quota.count()]);
    console.log('  Frações registadas: ' + nFracoes);
    console.log('  Quotas registadas:  ' + nQuotas);
    const condInativo = condominios.filter((c) => String(c.estado) !== 'ativo');
    console.log('  Condomínios inativos (excluídos dos jobs): ' + condInativo.length);
  } catch (err) {
    console.log('  Não foi possível contar: ' + err.message);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Fim. Nenhuma escrita foi feita na base de dados.');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');

  await models.sequelize.close().catch(() => {});
}

main().catch((err) => {
  console.error('');
  console.error('✗ Falhou: ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
