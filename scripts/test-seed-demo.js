// Testes do seed de demonstração (`scripts/seed-demo.js`) — SEM base de dados.
// Utilização: node scripts/test-seed-demo.js
//
// Não executa o seed: verifica, por análise estática + modelos reais, que o
// script respeita as regras que o tornam seguro e coerente. A verificação
// DINÂMICA (invariantes sobre os dados) corre dentro do próprio seed, no fim de
// `criarDemo()` — este teste garante que essa verificação não foi removida e
// que o script não faz nada fora do âmbito.
//
// Cobre:
//  1. Âmbito: ficheiro independente, fora do `db:seed`/`db:setup`.
//  2. Ambiente: recusa NODE_ENV=production; suporta --dry-run e --reset.
//  3. Escrita: usa os writers existentes; não escreve à mão movimentos com
//     writer; `condominio_id` sempre preenchido.
//  4. Dados fictícios: sem emails/NIF/IBAN reais; nunca envia emails.
//  5. Frações: 6, com permilagens a somar exatamente 1000‰.
//  6. Estados derivados: nunca grava 'paga'/'parcialmente_paga' diretamente.
//  7. Portal: cria FracaoTitularidade (não só FracaoPessoa).
//  8. FCR: usa transferirFcr + transferirFcrAprovado com deliberação aprovada.
//  9. Reset: apaga apenas o condomínio de demonstração.
// 10. Invariantes: o verificador contém todas as verificações exigidas.
// 11. Modelos: os campos/ENUM usados pelo seed existem nos modelos reais.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const models = require('../models');

const SEED = fs.readFileSync(path.join(__dirname, 'seed-demo.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ── 1. Âmbito ────────────────────────────────────────────────────────
function testarAmbito() {
  const scripts = PKG.scripts || {};
  assert.strictEqual(scripts['db:seed'], 'sequelize-cli db:seed:all', 'db:seed intacto');
  assert.strictEqual(scripts['db:setup'], 'sequelize-cli db:migrate && sequelize-cli db:seed:all', 'db:setup intacto');
  // O seed em si não entra em nenhum fluxo automático de BD: só o TESTE (sem
  // BD) pode estar na cadeia de testes.
  for (const [nome, cmd] of Object.entries(scripts)) {
    if (nome.startsWith('test')) continue;
    assert.ok(!cmd.includes('seed-demo'), `${nome} não referencia seed-demo`);
  }
  assert.ok(SEED.includes('require(\'dotenv\').config()'), 'carrega .env');
  assert.ok(SEED.includes("require('../models')"), 'usa os modelos da aplicação');
}

// ── 2. Ambiente e modos ──────────────────────────────────────────────
function testarAmbiente() {
  assert.ok(SEED.includes("=== 'production'"), 'deteta NODE_ENV=production');
  assert.ok(/RECUSADO: NODE_ENV=production/.test(SEED), 'mensagem de recusa clara');
  assert.ok(SEED.includes('process.argv.includes(\'--dry-run\')'), 'suporta --dry-run');
  assert.ok(SEED.includes('process.argv.includes(\'--reset\')'), 'suporta --reset');
  // O --dry-run não pode escrever: o modo é testado antes do criarDemo().
  const posDry = SEED.indexOf('if (OPCOES.dryRun) {');
  const posCriar = SEED.indexOf('await criarDemo()');
  assert.ok(posDry > 0 && posCriar > posDry, '--dry-run é avaliado antes de criar');
}

// ── 3. Escrita via writers ───────────────────────────────────────────
function testarWriters() {
  for (const w of [
    'registarPagamento',
    'registarPagamentoExtraParcela',
    'registarTransferencia',
    'sincronizarMovimentoDespesa',
    'transferirFcr',
    'transferirFcrAprovado',
    'criarMovimento',
  ]) {
    assert.ok(SEED.includes(w), `usa o writer ${w}`);
  }
  // Nunca pode haver bulkInsert de movimentos/pagamentos (têm writer).
  assert.ok(!SEED.includes('bulkInsert'), 'não usa bulkInsert em lado nenhum');
  assert.ok(!SEED.includes('.bulkCreate'), 'não usa bulkCreate em lado nenhum');
  // O movimento de despesa tem de vir SEMPRE do writer, nunca de um create à mão.
  assert.ok(
    !/MovimentoBancario\.create\(\{[\s\S]{0,400}despesa_id:/.test(SEED),
    'não cria movimento de despesa à mão (usa sincronizarMovimentoDespesa)'
  );
  // condominio_id presente nas chamadas aos writers. Cada bloco vai até ao
  // fecho `});` correspondente (não uma janela de N caracteres).
  const blocoDe = (texto, marca) =>
    texto
      .split(marca)
      .slice(1)
      .map((b) => b.slice(0, b.indexOf('});') + 3));
  const blocosPag = blocoDe(SEED, 'await registarPagamento({');
  assert.ok(blocosPag.length >= 2, 'há pagamentos integrais e parciais');
  for (const b of blocosPag) {
    assert.ok(b.includes('condominioId: cid'), 'registarPagamento recebe condominioId');
  }
  // criarMovimento (ajustes manuais) sempre com condominioId.
  const blocosCriar = blocoDe(SEED, 'await criarMovimento({');
  assert.ok(blocosCriar.length > 0, 'há pelo menos um ajuste manual');
  for (const b of blocosCriar) {
    assert.ok(b.includes('condominioId: cid'), 'criarMovimento recebe condominioId');
  }
}

// ── 4. Dados fictícios / sem envio ───────────────────────────────────
function testarFicticio() {
  // Emails só em domínios reservados/inequívocos.
  const emails = SEED.match(/[\w.+-]+@[\w.-]+/g) || [];
  assert.ok(emails.length > 0, 'o seed define emails');
  for (const e of emails) {
    assert.ok(
      e.endsWith('@example.test') || e.endsWith('@example.com') || e.endsWith('@test.invalid'),
      `email fictício (${e})`
    );
  }
  // Nenhuma chamada a transporte de email.
  for (const proibido of ['nodemailer', 'sendMail', 'transporter', 'EmailFila.create', 'enfileirarEmail']) {
    assert.ok(!SEED.includes(proibido), `não usa ${proibido} (não envia emails)`);
  }
  // Documentos nunca 'guardado' (sem Drive/Dropbox).
  assert.ok(SEED.includes("drive_status: 'nao_guardado'"), 'documentos com drive_status nao_guardado');
  assert.ok(!SEED.includes("drive_status: 'guardado'"), 'nunca marca documentos como guardados');
  // NIFs de teste e IBANs fictícios.
  assert.ok(/nif: '99999999/.test(SEED), 'NIFs de teste');
  assert.ok(/PT5000000/.test(SEED), 'IBANs fictícios PT50 + zeros');
}

// ── 5. Frações e permilagens ─────────────────────────────────────────
function testarFracoes() {
  const m = SEED.match(/const FRACOES_DEF = \[([\s\S]*?)\];/);
  assert.ok(m, 'FRACOES_DEF definido');
  const permilagens = [...m[1].matchAll(/permilagem:\s*(\d+)/g)].map((x) => Number(x[1]));
  assert.strictEqual(permilagens.length, 6, '6 frações');
  assert.deepStrictEqual(permilagens, [180, 170, 165, 160, 165, 160], 'permilagens 180/170/165/160/165/160');
  assert.strictEqual(permilagens.reduce((a, b) => a + b, 0), 1000, 'Σ permilagens = 1000‰');
  // E o script aborta se não somar 1000.
  assert.ok(SEED.includes('tem de ser exatamente 1000‰'), 'o seed aborta se Σ ≠ 1000‰');
}

// ── 6. Estados derivados nunca forçados ──────────────────────────────
function testarEstados() {
  // Na criação de Quota o estado tem de ser 'pendente' (o resto vem dos writers).
  const blocoQuota = SEED.match(/Quota\.create\(\{[\s\S]*?\}\)\)/);
  assert.ok(blocoQuota, 'Quota.create presente');
  assert.ok(/estado: 'pendente'/.test(blocoQuota[0]), 'quota nasce pendente');
  assert.ok(
    !/Quota\.update\(/.test(SEED),
    'nunca se faz Quota.update de estado à mão (o writer recalcula)'
  );
  assert.ok(!/estado: 'parcialmente_paga'/.test(SEED), 'nunca grava parcialmente_paga à mão');
  // As despesas pagas vêm do próprio writer de sincronização.
  assert.ok(SEED.includes("estado: d.paga ? 'paga' : 'registada'"), 'despesas com estado pelo cenário');
}

// ── 7. Portal (titularidades) ────────────────────────────────────────
function testarPortal() {
  assert.ok(SEED.includes('FracaoTitularidade.create'), 'cria FracaoTitularidade (portal condómino)');
  assert.ok(SEED.includes("estado: 'ativa'"), 'titularidade ativa');
  assert.ok(SEED.includes('FracaoPessoa.create'), 'mantém FracaoPessoa (fluxo do administrador)');
  assert.ok(SEED.includes('utilizador_id'), 'titularidade liga ao utilizador');
  assert.ok(SEED.includes('created_by: gestor.id'), 'titularidade tem autor');
  // Alguns proprietários sem conta, para o administrador ter o que resolver.
  assert.ok(SEED.includes('conta: false'), 'há frações sem conta de portal');
}

// ── 8. FCR com deliberação ───────────────────────────────────────────
function testarFcr() {
  assert.ok(SEED.includes('transferirFcr({'), 'usa transferirFcr (corrente → fundo)');
  assert.ok(SEED.includes('transferirFcrAprovado({'), 'usa transferirFcrAprovado (fundo → corrente)');
  assert.ok(SEED.includes('deliberacaoId: itemFcr.id'), 'a utilização do FCR aponta à deliberação');
  assert.ok(SEED.includes("deliberacao_estado: 'aprovada'"), 'a deliberação está aprovada');
  assert.ok(SEED.includes("valor_aprovado:"), 'a deliberação tem valor aprovado');
  assert.ok(SEED.includes("estado: 'realizada'"), 'a assembleia está realizada (pode deliberar)');
  assert.ok(SEED.includes("tipo: 'fundo_reserva'"), 'existe conta de fundo de reserva');
}

// ── 9. Reset restrito ────────────────────────────────────────────────
function testarReset() {
  assert.ok(SEED.includes('apagarCondominioDemo'), 'função de reset isolada');
  assert.ok(SEED.includes('async function encontrarCondominioDemo'), 'encontra o condomínio demo');
  assert.ok(SEED.includes('designacao: DESIGNACAO'), 'identifica-o pela designação própria');
  // O reset só pode apagar o condomínio encontrado, nunca "tudo".
  assert.ok(!/\.destroy\(\{\s*truncate/.test(SEED), 'não faz truncate');
  assert.ok(!/DROP TABLE|DROP DATABASE/i.test(SEED), 'não faz DROP');
  assert.ok(SEED.includes('--dry-run: nada foi apagado'), '--reset com --dry-run não apaga');
  // NUNCA pode apagar a tabela de numeração inteira (é global).
  assert.ok(
    !/Numeracao\.destroy\(\{\s*where:\s*\{\s*\}/.test(SEED),
    'não apaga toda a tabela de numeração'
  );
  // Não pode apagar um utilizador que pertença a outro condomínio.
  assert.ok(SEED.includes('usadosNoutro'), 'protege utilizadores de outros condomínios');
  // A limpeza de contacto é por pessoa_id (não por condominio_id, que não tem).
  assert.ok(SEED.includes('ContactoPessoa.destroy'), 'limpa contactos das pessoas demo');
  assert.ok(/ContactoPessoa\.destroy\(\{\s*where:\s*\{\s*pessoa_id/.test(SEED), 'contactos por pessoa_id');
}

// ── 10. Invariantes exigidos ─────────────────────────────────────────
function testarInvariantes() {
  const bloco = SEED.match(/async function verificarInvariantes\(cid\)[\s\S]*?\n\}/);
  assert.ok(bloco, 'existe verificarInvariantes()');
  const t = bloco[0];
  const exigidos = [
    ['Σ permilagens = 1000‰', /Σ permilagens = 1000‰/],
    ['pagamentos aplicados ≤ valor da quota', /Pagamentos aplicados ≤ valor da quota/],
    ['estado das quotas derivado do pago', /Estado das quotas derivado do pago/],
    ['transferências com duas pontas', /Transferências com duas pontas/],
    ['sem movimento sem condominio_id', /Nenhum movimento novo sem condominio_id/],
    ['saldos por conta coerentes', /Saldo da conta .* coerente/],
    ['extrato = somatório das contas', /Saldo agregado do Extrato = somatório das contas/],
    ['isolamento do condomínio demo', /Isolamento do condomínio demo/],
    ['movimentos anteriores ao ano corrente', /movimentos anteriores ao ano corrente/],
    ['movimentos anulados', /Existem movimentos anulados/],
    ['ajustes manuais', /ajustes manuais/],
    ["documentos sem Drive", /drive_status='nao_guardado'/],
    ['nenhum email enviado', /Nenhum email enviado pelo seed/],
  ];
  for (const [nome, re] of exigidos) {
    assert.ok(re.test(t), `invariante presente: ${nome}`);
  }
  // Falhas fazem o processo sair com código 1.
  assert.ok(SEED.includes('process.exit(falhas.length ? 1 : 0)'), 'falhas → exit 1');
}

// ── 11. Campos/ENUM existem nos modelos ──────────────────────────────
function testarModelos() {
  const esperado = {
    Condominio: ['designacao', 'nif', 'estado'],
    Fracao: ['condominio_id', 'permilagem', 'estado'],
    FracaoTitularidade: ['condominio_id', 'fracao_id', 'utilizador_id', 'estado'],
    ContaBancaria: ['condominio_id', 'tipo', 'saldo_inicial', 'ativa'],
    Quota: ['condominio_id', 'valor_base', 'valor_fcr', 'estado'],
    Despesa: ['condominio_id', 'competencia_ano', 'competencia_mes', 'estado'],
    MovimentoBancario: ['condominio_id', 'conta_bancaria_id', 'referencia', 'estado'],
    ExtraQuota: ['condominio_id', 'metodo_divisao', 'numero_parcelas', 'estado'],
    ExtraQuotaParcela: ['extra_quota_id', 'parcela_numero', 'estado'],
    Documento: ['condominio_id', 'drive_status'],
    Assembleia: ['condominio_id', 'numero', 'estado'],
    AgendaItem: ['assembleia_id', 'deliberacao_estado', 'valor_aprovado'],
    Recibo: ['condominio_id', 'codigo', 'numero', 'ano', 'estado'],
    Numeracao: ['tipo_documento', 'ano', 'sequencia'],
  };
  for (const [modelo, campos] of Object.entries(esperado)) {
    const M = models[modelo];
    assert.ok(M, `modelo ${modelo} existe`);
    for (const campo of campos) {
      assert.ok(M.rawAttributes[campo], `${modelo}.${campo} existe`);
    }
  }
  // ENUM crítico do tipo de conta bancária usado pelo FCR.
  assert.ok(models.ContaBancaria.rawAttributes.tipo.values.includes('fundo_reserva'), 'ENUM fundo_reserva');
  // ENUM do estado da quota.
  const estadosQuota = models.Quota.rawAttributes.estado.values;
  for (const e of ['pendente', 'parcialmente_paga', 'paga', 'vencida', 'anulada']) {
    assert.ok(estadosQuota.includes(e), `ENUM quota inclui ${e}`);
  }
  // Documento: o seed só usa 'nao_guardado'.
  assert.ok(models.Documento.rawAttributes.drive_status.values.includes('nao_guardado'), "ENUM drive_status inclui nao_guardado");
}

// ── 12. Comentário de topo documenta as decisões ─────────────────────
function testarDocumentacao() {
  assert.ok(SEED.includes('seed de DEMONSTRAÇÃO'), 'cabeçalho identifica seed de demonstração');
  assert.ok(SEED.includes('nunca em produção') || SEED.includes('nunca usar em produção'), 'avisa sobre produção');
  assert.ok(SEED.includes('IDEMPOTÊNCIA') || SEED.includes('Idempotente'), 'documenta idempotência');
  assert.ok(SEED.includes('USA OS WRITERS EXISTENTES'), 'documenta a regra dos writers');
  assert.ok(SEED.includes('transações aninhadas'), 'explica por que não há transação única');
}

testarAmbito();
testarAmbiente();
testarWriters();
testarFicticio();
testarFracoes();
testarEstados();
testarPortal();
testarFcr();
testarReset();
testarInvariantes();
testarModelos();
testarDocumentacao();
console.log('✓ Testes do seed de demonstração passaram (sem base de dados).');
