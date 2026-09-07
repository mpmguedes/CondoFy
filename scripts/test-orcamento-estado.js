// Testes das regras de estado do Orçamento (rascunho/aprovado/em execução/
// fechado/anulado) — sem base de dados. Verifica os predicados puros usados
// pelas rotas e os invariantes de código/vistas do módulo.
//
// Utilização: node scripts/test-orcamento-estado.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const models = require('../models');
const orcamentoEstado = require('../helpers/orcamento-estado');

const rota = fs.readFileSync(path.join(__dirname, '..', 'routes', 'orcamento.js'), 'utf8');
const detalheView = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'orcamento', 'detalhe.handlebars'), 'utf8');
const listarView = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'orcamento', 'listar.handlebars'), 'utf8');

// ── 1. Modelo: estado é ENUM e inclui 'anulado' ─────────────────────
function testarModelo() {
  const estado = models.Orcamento.rawAttributes.estado;
  assert.ok(estado, 'Orcamento tem coluna estado');
  assert.deepStrictEqual(
    [...estado.values],
    ['rascunho', 'aprovado', 'em_execucao', 'encerrado', 'anulado'],
    'estado inclui rascunho/aprovado/em_execucao/encerrado/anulado'
  );
  assert.strictEqual(estado.defaultValue, 'rascunho', 'default é rascunho');
}

// ── 2. Regras por estado ────────────────────────────────────────────
function testarRegras() {
  // Rascunho: edita, gere rubricas, elimina e aprova.
  assert.strictEqual(orcamentoEstado.podeEditar('rascunho'), true, 'rascunho pode editar');
  assert.strictEqual(orcamentoEstado.podeAprovar('rascunho'), true, 'rascunho pode aprovar');
  assert.strictEqual(orcamentoEstado.podeEliminar('rascunho'), true, 'rascunho pode eliminar');
  assert.strictEqual(orcamentoEstado.podeAnular('rascunho'), false, 'rascunho não se anula (elimina-se)');
  assert.strictEqual(orcamentoEstado.podeFechar('rascunho'), false, 'rascunho não fecha');
  assert.strictEqual(orcamentoEstado.podeAlteracaoExtraordinaria('rascunho'), false, 'rascunho altera por via normal');

  // Aprovado: protegido de edição normal e eliminação; pode anular/fechar.
  assert.strictEqual(orcamentoEstado.podeEditar('aprovado'), false, 'aprovado não edita como rascunho');
  assert.strictEqual(orcamentoEstado.podeEliminar('aprovado'), false, 'aprovado não é eliminado diretamente');
  assert.strictEqual(orcamentoEstado.podeAprovar('aprovado'), false, 'aprovado não aprova de novo');
  assert.strictEqual(orcamentoEstado.podeAnular('aprovado'), true, 'aprovado (sem execução) pode ser anulado');
  assert.strictEqual(orcamentoEstado.podeFechar('aprovado'), true, 'aprovado pode fechar');
  assert.strictEqual(orcamentoEstado.podeAlteracaoExtraordinaria('aprovado'), true, 'aprovado permite alteração extraordinária com justificação');

  // Em execução: sem edição normal; fecha; não anula (já tem execução/quotas).
  assert.strictEqual(orcamentoEstado.podeEditar('em_execucao'), false, 'em execução não edita');
  assert.strictEqual(orcamentoEstado.podeEliminar('em_execucao'), false, 'em execução não elimina');
  assert.strictEqual(orcamentoEstado.podeAnular('em_execucao'), false, 'em execução não anula');
  assert.strictEqual(orcamentoEstado.podeFechar('em_execucao'), true, 'em execução fecha');

  // Fechado: histórico encerrado; mantém alterações extraordinárias (existente).
  assert.strictEqual(orcamentoEstado.podeEditar('encerrado'), false, 'fechado não edita');
  assert.strictEqual(orcamentoEstado.podeAprovar('encerrado'), false, 'fechado não aprova');
  assert.strictEqual(orcamentoEstado.podeFechar('encerrado'), false, 'fechado não fecha de novo');
  assert.strictEqual(orcamentoEstado.podeAlteracaoExtraordinaria('encerrado'), true, 'fechado mantém extraordinária com justificação');

  // Anulado: apenas histórico — nada de editar/aprovar/anular/fechar/eliminar.
  for (const fn of ['podeEditar', 'podeAprovar', 'podeEliminar', 'podeAnular', 'podeFechar', 'podeAlteracaoExtraordinaria']) {
    assert.strictEqual(orcamentoEstado[fn]('anulado'), false, `anulado: ${fn} = false`);
  }
  assert.strictEqual(orcamentoEstado.naoAnulado('anulado'), false, 'anulado bloqueia execução');
  assert.strictEqual(orcamentoEstado.naoAnulado('aprovado'), true, 'aprovado permite execução');
}

// ── 3. Invariantes de código da rota (isolamento + regras) ──────────
function testarRota() {
  assert.ok(rota.includes("condominio_id: req.condominioId"), 'rota continua filtrada pelo condomínio ativo');
  assert.ok(rota.includes('carregarOrcamento(req'), 'tudo carrega pelo carregador escopado');
  assert.ok(rota.includes("require('../helpers/orcamento-estado')"), 'rota usa o helper de estado');
  for (const uso of ['podeEditar', 'podeAprovar', 'podeEliminar', 'podeAnular', 'podeFechar', 'naoAnulado']) {
    assert.ok(rota.includes(`orcamentoEstado.${uso}(`), `rota usa ${uso}`);
  }
  assert.ok(rota.includes("'/orcamento/:id/anular'"), 'rota de anulação existe');
  assert.ok(rota.includes("'/orcamento/:id/eliminar'"), 'rota de eliminação existe');
  assert.ok(rota.includes('Quota.count({ where: { orcamento_id: id } })'), 'eliminação recusa rascunho com quotas associadas');
}

// ── 4. Vistas: anulado identificado e sem ações destrutivas de edição ─
function testarVistas() {
  assert.ok(detalheView.includes("'anulado'") && detalheView.includes('Anulado'), 'detalhe identifica anulado');
  assert.ok(listarView.includes('Anulado'), 'listagem identifica anulado');
  assert.ok(detalheView.includes('Anular orçamento'), 'detalhe expõe ação de anulação (aprovado)');
  assert.ok(detalheView.includes('Eliminar rascunho'), 'detalhe expõe eliminar apenas no rascunho');
  assert.ok(listarView.includes("(eq estado 'rascunho')"), 'listagem limita editar a rascunho');
}

testarModelo();
testarRegras();
testarRota();
testarVistas();
console.log('✓ Testes das regras de estado do Orçamento passaram (sem base de dados).');
