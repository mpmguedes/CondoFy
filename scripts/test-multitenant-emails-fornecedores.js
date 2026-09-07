// Testes do isolamento multi-tenant de Emails (EmailFila) e Fornecedores —
// sem base de dados. Verifica os mecanismos PURAMENTE decidíveis offline:
//  1. EmailFila/Fornecedor/PagamentoFornecedor têm condominio_id no modelo;
//  2. o filtro da fila por condomínio (listagem/contagens da Central);
//  3. a relação segura que persiste o condomínio em cada item da fila
//     (documento/aviso/entidade) — o contexto não se perde no processamento;
//  4. os carregadores/escopos das rotas usam o condomínio ativo (invariantes
//     de código) — nunca o primeiro condomínio nem ids do browser isolados.
//
// Utilização: node scripts/test-multitenant-emails-fornecedores.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const models = require('../models');
const {
  contextoDoItem,
  modeloPorEntidade,
  filtroFilaPorCondominio,
} = require('../helpers/email-fila');

const rota = (nome) => fs.readFileSync(path.join(__dirname, '..', 'routes', nome), 'utf8');

// ── 1. Modelos com condominio_id ────────────────────────────────────
function testarModelos() {
  assert.ok(models.EmailFila.rawAttributes.condominio_id, 'EmailFila.condominio_id');
  assert.ok(models.Fornecedor.rawAttributes.condominio_id, 'Fornecedor.condominio_id');
  assert.ok(models.PagamentoFornecedor.rawAttributes.condominio_id, 'PagamentoFornecedor.condominio_id');
  // Entidades usadas para derivar/persistir o condomínio têm condominio_id.
  for (const nome of ['Documento', 'Aviso', 'Quota', 'Pagamento', 'Recibo', 'Despesa', 'ExtraQuota', 'Assembleia']) {
    assert.ok(models[nome].rawAttributes.condominio_id, `${nome}.condominio_id`);
  }
}

// ── 2. Filtro da EmailFila por condomínio ───────────────────────────
function testarFiltroFila() {
  const f = filtroFilaPorCondominio(1, { estado: 'pendente' });
  assert.strictEqual(f.condominio_id, 1, 'filtro inclui condominio_id ativo');
  assert.strictEqual(f.estado, 'pendente', 'filtro funde filtros extra');

  // Registo de outro condomínio (ou NULL) nunca passa no filtro do ativo.
  const regA = { condominio_id: 1, estado: 'pendente' };
  const regB = { condominio_id: 2, estado: 'pendente' };
  const orfao = { condominio_id: null, estado: 'pendente' };
  const passa = (reg) => ['condominio_id', 'estado'].every((k) => f[k] === undefined || String(reg[k]) === String(f[k]));
  assert.ok(passa(regA), 'email de A passa no filtro de A');
  assert.ok(!passa(regB), 'email de B NÃO passa no filtro de A');
  assert.ok(!passa(orfao), 'email órfão (NULL) NÃO passa no filtro de um condomínio');
}

// ── 3. Relação segura do item da fila (contexto persistido) ─────────
function testarContextoDoItem() {
  assert.deepStrictEqual(contextoDoItem({ documento_id: 7 }), { modelo: 'Documento', id: 7 }, 'documento_id');
  assert.deepStrictEqual(contextoDoItem({ aviso_id: 3 }), { modelo: 'Aviso', id: 3 }, 'aviso_id');
  const casos = [
    ['Recibo', 11], ['Quota', 5], ['Pagamento', 9], ['Documento', 12],
    ['Aviso', 4], ['Despesa', 6], ['ExtraQuota', 8], ['Assembleia', 2],
  ];
  for (const [tipo, id] of casos) {
    assert.deepStrictEqual(contextoDoItem({ entidade_tipo: tipo, entidade_id: id }), { modelo: tipo, id }, `entidade ${tipo}`);
  }
  assert.strictEqual(modeloPorEntidade('Quota'), 'Quota', 'Quota reconhecida');
  assert.strictEqual(modeloPorEntidade('PagamentoFornecedor'), null, 'PagamentoFornecedor (global) não mapeia diretamente');
  assert.strictEqual(contextoDoItem({ entidade_tipo: 'PagamentoFornecedor', entidade_id: 2 }), null, 'PagamentoFornecedor sem documento → sem contexto');
  assert.strictEqual(contextoDoItem({}), null, 'sem relação segura → null');
}

// ── 4. Invariantes de código das rotas ──────────────────────────────
function testarRotas() {
  const emails = rota('emails.js');
  const forn = rota('fornecedores.js');
  const financeiro = rota('financeiro.js');

  // Emails: Central + ações (reenviar/cancelar) escopadas pelo condomínio.
  assert.ok(emails.includes('condominio_id: req.condominioId') || emails.includes('filtroFilaPorCondominio'), 'emails: consultas filtram por condominio');
  assert.ok(emails.includes("where: { id: req.params.id, condominio_id: req.condominioId }"), 'emails: ações por id escopadas ao condomínio ativo');
  assert.ok(!emails.includes('EmailFila.findByPk(req.params.id'), 'emails: sem carregar email por id isolado');

  // Fornecedores: cria/consulta sempre com condominio_id do ativo.
  assert.ok(forn.includes('condominio_id: req.condominioId'), 'fornecedores: operações usam o condomínio ativo');
  assert.ok(forn.includes('Fornecedor.create({ ...dados, condominio_id: req.condominioId })'), 'fornecedores: criação persiste condominio_id');
  assert.ok(forn.includes('PagamentoFornecedor.create({') && forn.includes('condominio_id: req.condominioId'), 'fornecedores: pagamento persiste condominio_id');
  assert.ok(!forn.includes('Fornecedor.findByPk(req.params'), 'fornecedores: sem findByPk do id do browser');
  assert.ok(!forn.includes('PagamentoFornecedor.findByPk(req.params'), 'fornecedores: sem findByPk do pid do browser');

  // Financeiro (despesas): os fornecedores propostos pertencem ao condomínio.
  assert.ok(financeiro.includes("condominio_id: req.condominioId, ativo: true }"), 'financeiro: select de fornecedores do condomínio');
  assert.ok(financeiro.includes('Fornecedor.findOne({ where: { id: fornecedor_id, condominio_id: req.condominioId } })'), 'financeiro: valida fornecedor no condomínio');
}

testarModelos();
testarFiltroFila();
testarContextoDoItem();
testarRotas();
console.log('✓ Testes de isolamento de Emails/Fornecedores passaram (sem base de dados).');
