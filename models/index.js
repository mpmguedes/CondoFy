const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');

const db = {};

// Carrega todos os modelos da pasta (exceto o próprio index.js)
fs.readdirSync(__dirname)
  .filter(
    (file) =>
      file.indexOf('.') !== 0 && file !== 'index.js' && file.slice(-3) === '.js'
  )
  .forEach((file) => {
    const model = require(path.join(__dirname, file))(sequelize);
    db[model.name] = model;
  });

// ── Associações (todas por ID / foreign key) ───────────────────────
const {
  User,
  UserCondominio,
  Condominio,
  Pessoa,
  ContactoPessoa,
  Fracao,
  FracaoPessoa,
  ContaBancaria,
  Categoria,
  MetodoPagamento,
  Orcamento,
  OrcamentoRubrica,
  OrcamentoAlteracao,
  OrcamentoDistribuicao,
  PlanoQuota,
  MovimentoBancario,
  OrcamentoItem,
  Quota,
  Pagamento,
  PagamentoQuota,
  PagamentoExtraParcela,
  Recibo,
  ReciboQuota,
  ReciboExtraParcela,
  Despesa,
  Fornecedor,
  PagamentoFornecedor,
  Documento,
  DocumentoCategoria,
  Assembleia,
  AssembleiaParticipante,
  Aviso,
  AvisoDestinatario,
  EmailFila,
  AuditLog,
  ExtraQuota,
  ExtraQuotaParcela,
  AgendaItem,
} = db;

// Utilizador ↔ Pessoa (relação explícita, nunca por nome)
User.belongsTo(Pessoa, { foreignKey: 'pessoa_id', as: 'pessoa' });
Pessoa.hasMany(User, { foreignKey: 'pessoa_id', as: 'users' });

// ── Multi-condomínio: utilizador ↔ condomínio (papel por condomínio) ──
User.belongsToMany(Condominio, {
  through: UserCondominio,
  foreignKey: 'utilizador_id',
  otherKey: 'condominio_id',
  as: 'condominios',
});
Condominio.belongsToMany(User, {
  through: UserCondominio,
  foreignKey: 'condominio_id',
  otherKey: 'utilizador_id',
  as: 'utilizadores',
});
UserCondominio.belongsTo(User, { foreignKey: 'utilizador_id', as: 'utilizador' });
UserCondominio.belongsTo(Condominio, { foreignKey: 'condominio_id', as: 'condominio' });

// Entidades de negócio → condomínio (isolamento por condominio_id)
const MODELOS_COM_CONDOMINIO = [
  Fracao,
  Pessoa,
  ContactoPessoa,
  Quota,
  Pagamento,
  Recibo,
  Documento,
  Assembleia,
  Despesa,
  ContaBancaria,
  Orcamento,
  ExtraQuota,
  Aviso,
];
for (const M of MODELOS_COM_CONDOMINIO) {
  M.belongsTo(Condominio, { foreignKey: 'condominio_id', as: 'condominio' });
}
Condominio.hasMany(Fracao, { foreignKey: 'condominio_id', as: 'fracoes' });
Condominio.hasMany(Pessoa, { foreignKey: 'condominio_id', as: 'pessoas' });

// Fração ↔ Pessoa (muitos-para-muitos, com papel/vínculo)
Fracao.belongsToMany(Pessoa, {
  through: FracaoPessoa,
  foreignKey: 'fracao_id',
  otherKey: 'pessoa_id',
  as: 'pessoas',
});
Pessoa.belongsToMany(Fracao, {
  through: FracaoPessoa,
  foreignKey: 'pessoa_id',
  otherKey: 'fracao_id',
  as: 'fracoes',
});
FracaoPessoa.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
FracaoPessoa.belongsTo(Pessoa, { foreignKey: 'pessoa_id', as: 'pessoa' });

// Contactos flexíveis por pessoa (vários emails/telefones)
Pessoa.hasMany(ContactoPessoa, { foreignKey: 'pessoa_id', as: 'contactos' });
ContactoPessoa.belongsTo(Pessoa, { foreignKey: 'pessoa_id', as: 'pessoa' });

// Recibos formais (RCP) por fração, com meses/quotas cobertos.
Fracao.hasMany(Recibo, { foreignKey: 'fracao_id', as: 'recibos' });
Recibo.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
Recibo.hasMany(ReciboQuota, { foreignKey: 'recibo_id', as: 'meses' });
ReciboQuota.belongsTo(Recibo, { foreignKey: 'recibo_id', as: 'recibo' });
Quota.hasMany(ReciboQuota, { foreignKey: 'quota_id', as: 'coberturas_recibo' });
ReciboQuota.belongsTo(Quota, { foreignKey: 'quota_id', as: 'quota' });
Recibo.belongsToMany(Quota, {
  through: ReciboQuota,
  foreignKey: 'recibo_id',
  otherKey: 'quota_id',
  as: 'quotas',
});
Quota.belongsToMany(Recibo, {
  through: ReciboQuota,
  foreignKey: 'quota_id',
  otherKey: 'recibo_id',
  as: 'recibos',
});
Recibo.belongsTo(User, { foreignKey: 'created_by', as: 'criador' });

// Quotas
Quota.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
Fracao.hasMany(Quota, { foreignKey: 'fracao_id', as: 'quotas' });
Quota.belongsTo(Orcamento, { foreignKey: 'orcamento_id', as: 'orcamento' });
Orcamento.hasMany(Quota, { foreignKey: 'orcamento_id', as: 'quotas' });

// Pagamentos ↔ Quotas (distribuição de pagamentos parciais)
Pagamento.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
Pagamento.belongsTo(ContaBancaria, { foreignKey: 'conta_bancaria_id', as: 'conta_bancaria' });
Pagamento.belongsTo(MetodoPagamento, { foreignKey: 'metodo_pagamento_id', as: 'metodo_pagamento' });
Pagamento.belongsToMany(Quota, {
  through: PagamentoQuota,
  foreignKey: 'pagamento_id',
  otherKey: 'quota_id',
  as: 'quotas',
});
Quota.belongsToMany(Pagamento, {
  through: PagamentoQuota,
  foreignKey: 'quota_id',
  otherKey: 'pagamento_id',
  as: 'pagamentos',
});
PagamentoQuota.belongsTo(Pagamento, { foreignKey: 'pagamento_id', as: 'pagamento' });
PagamentoQuota.belongsTo(Quota, { foreignKey: 'quota_id', as: 'quota' });

// Pagamentos ↔ Parcelas de Quota Extra (pagamentos reais de Quotas Extra)
Pagamento.belongsToMany(ExtraQuotaParcela, {
  through: PagamentoExtraParcela,
  foreignKey: 'pagamento_id',
  otherKey: 'extra_quota_parcela_id',
  as: 'parcelasExtra',
});
ExtraQuotaParcela.belongsToMany(Pagamento, {
  through: PagamentoExtraParcela,
  foreignKey: 'extra_quota_parcela_id',
  otherKey: 'pagamento_id',
  as: 'pagamentosExtra',
});
PagamentoExtraParcela.belongsTo(Pagamento, { foreignKey: 'pagamento_id', as: 'pagamento' });
PagamentoExtraParcela.belongsTo(ExtraQuotaParcela, { foreignKey: 'extra_quota_parcela_id', as: 'parcela' });

// Recibos ↔ Parcelas de Quota Extra (discriminação de Quotas Extra no recibo)
Recibo.belongsToMany(ExtraQuotaParcela, {
  through: ReciboExtraParcela,
  foreignKey: 'recibo_id',
  otherKey: 'extra_quota_parcela_id',
  as: 'parcelasExtra',
});
ExtraQuotaParcela.belongsToMany(Recibo, {
  through: ReciboExtraParcela,
  foreignKey: 'extra_quota_parcela_id',
  otherKey: 'recibo_id',
  as: 'recibosExtra',
});
ReciboExtraParcela.belongsTo(Recibo, { foreignKey: 'recibo_id', as: 'recibo' });
ReciboExtraParcela.belongsTo(ExtraQuotaParcela, { foreignKey: 'extra_quota_parcela_id', as: 'parcela' });

// Despesas
Despesa.belongsTo(Categoria, { foreignKey: 'categoria_id', as: 'categoria' });
Despesa.belongsTo(ContaBancaria, { foreignKey: 'conta_bancaria_id', as: 'conta_bancaria' });
Despesa.belongsTo(MetodoPagamento, { foreignKey: 'metodo_pagamento_id', as: 'metodo_pagamento' });
Despesa.belongsTo(Fornecedor, { foreignKey: 'fornecedor_id', as: 'fornecedorReg' });
Fornecedor.hasMany(Despesa, { foreignKey: 'fornecedor_id', as: 'despesas' });

// Pagamentos a fornecedores
PagamentoFornecedor.belongsTo(Fornecedor, { foreignKey: 'fornecedor_id', as: 'fornecedor' });
Fornecedor.hasMany(PagamentoFornecedor, { foreignKey: 'fornecedor_id', as: 'pagamentos' });
PagamentoFornecedor.belongsTo(Despesa, { foreignKey: 'despesa_id', as: 'despesa' });
PagamentoFornecedor.belongsTo(MetodoPagamento, { foreignKey: 'metodo_pagamento_id', as: 'metodo_pagamento' });
PagamentoFornecedor.belongsTo(ContaBancaria, { foreignKey: 'conta_bancaria_id', as: 'conta_bancaria' });
PagamentoFornecedor.belongsTo(Documento, { foreignKey: 'comprovativo_documento_id', as: 'comprovativo' });
PagamentoFornecedor.belongsTo(User, { foreignKey: 'created_by', as: 'criador' });

// Movimentos bancários
MovimentoBancario.belongsTo(ContaBancaria, { foreignKey: 'conta_bancaria_id', as: 'conta_bancaria' });
ContaBancaria.hasMany(MovimentoBancario, { foreignKey: 'conta_bancaria_id', as: 'movimentos' });
MovimentoBancario.belongsTo(Categoria, { foreignKey: 'categoria_id', as: 'categoria' });
MovimentoBancario.belongsTo(Quota, { foreignKey: 'quota_id', as: 'quota' });
MovimentoBancario.belongsTo(Pagamento, { foreignKey: 'pagamento_id', as: 'pagamento' });
MovimentoBancario.belongsTo(Despesa, { foreignKey: 'despesa_id', as: 'despesa' });
MovimentoBancario.belongsTo(ExtraQuotaParcela, { foreignKey: 'extra_quota_parcela_id', as: 'extra_quota_parcela' });
ExtraQuotaParcela.hasMany(MovimentoBancario, { foreignKey: 'extra_quota_parcela_id', as: 'movimentos' });
MovimentoBancario.belongsTo(Documento, { foreignKey: 'documento_id', as: 'documento' });
MovimentoBancario.belongsTo(User, { foreignKey: 'created_by', as: 'criador' });

// Orçamento (modelo antigo, mantido por compatibilidade)
OrcamentoItem.belongsTo(Categoria, { foreignKey: 'categoria_id', as: 'categoria' });

// Orçamento (novo modelo: entidade + rubricas + histórico de alterações)
Orcamento.belongsTo(User, { foreignKey: 'aprovado_por', as: 'aprovador' });
Orcamento.belongsTo(Assembleia, { foreignKey: 'assembleia_id', as: 'assembleia' });
Orcamento.belongsTo(Documento, { foreignKey: 'documento_id', as: 'documento' });
Orcamento.hasMany(OrcamentoRubrica, { foreignKey: 'orcamento_id', as: 'rubricas' });
OrcamentoRubrica.belongsTo(Orcamento, { foreignKey: 'orcamento_id', as: 'orcamento' });
OrcamentoRubrica.belongsTo(Categoria, { foreignKey: 'categoria_id', as: 'categoria' });
Orcamento.hasMany(OrcamentoDistribuicao, { foreignKey: 'orcamento_id', as: 'distribuicoes' });
OrcamentoDistribuicao.belongsTo(Orcamento, { foreignKey: 'orcamento_id', as: 'orcamento' });
OrcamentoDistribuicao.belongsTo(OrcamentoRubrica, { foreignKey: 'rubrica_id', as: 'rubrica' });
OrcamentoDistribuicao.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
Orcamento.hasMany(PlanoQuota, { foreignKey: 'orcamento_id', as: 'plano' });
PlanoQuota.belongsTo(Orcamento, { foreignKey: 'orcamento_id', as: 'orcamento' });
PlanoQuota.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
Orcamento.hasMany(OrcamentoAlteracao, { foreignKey: 'orcamento_id', as: 'alteracoes' });
OrcamentoAlteracao.belongsTo(Orcamento, { foreignKey: 'orcamento_id', as: 'orcamento' });
OrcamentoAlteracao.belongsTo(User, { foreignKey: 'utilizador_id', as: 'utilizador' });
OrcamentoAlteracao.belongsTo(Assembleia, { foreignKey: 'assembleia_id', as: 'assembleia' });
OrcamentoAlteracao.belongsTo(Documento, { foreignKey: 'documento_id', as: 'documento' });

// Documentos
Documento.belongsTo(User, { foreignKey: 'created_by', as: 'criador' });

// Assembleias
Assembleia.belongsTo(Documento, { foreignKey: 'convocatoria_documento_id', as: 'convocatoria' });
Assembleia.belongsTo(Documento, { foreignKey: 'ata_documento_id', as: 'ata' });
AssembleiaParticipante.belongsTo(Assembleia, { foreignKey: 'assembleia_id', as: 'assembleia' });
AssembleiaParticipante.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
AssembleiaParticipante.belongsTo(Pessoa, { foreignKey: 'pessoa_id', as: 'pessoa' });

// Avisos e destinatários
Aviso.belongsTo(Documento, { foreignKey: 'documento_id', as: 'documento' });
Aviso.belongsTo(User, { foreignKey: 'created_by', as: 'criador' });
AvisoDestinatario.belongsTo(Aviso, { foreignKey: 'aviso_id', as: 'aviso' });
AvisoDestinatario.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
AvisoDestinatario.belongsTo(Pessoa, { foreignKey: 'pessoa_id', as: 'pessoa' });
AvisoDestinatario.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Fila de email
EmailFila.belongsTo(Documento, { foreignKey: 'documento_id', as: 'documento' });
EmailFila.belongsTo(Aviso, { foreignKey: 'aviso_id', as: 'aviso' });
EmailFila.belongsTo(User, { foreignKey: 'user_id', as: 'utilizador' });

// Documento ↔ Categoria (many-to-many; categorias tipo 'documento')
Documento.belongsToMany(Categoria, {
  through: DocumentoCategoria,
  foreignKey: 'documento_id',
  otherKey: 'categoria_id',
  as: 'categorias',
});
Categoria.belongsToMany(Documento, {
  through: DocumentoCategoria,
  foreignKey: 'categoria_id',
  otherKey: 'documento_id',
  as: 'documentos',
});

// Auditoria
AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Quotas Extraordinárias
ExtraQuota.hasMany(ExtraQuotaParcela, { foreignKey: 'extra_quota_id', as: 'parcelas' });
ExtraQuotaParcela.belongsTo(ExtraQuota, { foreignKey: 'extra_quota_id', as: 'extra_quota' });
ExtraQuotaParcela.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
Fracao.hasMany(ExtraQuotaParcela, { foreignKey: 'fracao_id', as: 'parcelas_extra' });

// Itens da ordem de trabalhos
Assembleia.hasMany(AgendaItem, { foreignKey: 'assembleia_id', as: 'agenda_itens' });
AgendaItem.belongsTo(Assembleia, { foreignKey: 'assembleia_id', as: 'assembleia' });

db.sequelize = sequelize;
db.Sequelize = require('sequelize');

module.exports = db;
