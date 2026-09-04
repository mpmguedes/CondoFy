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
  Pessoa,
  Fracao,
  FracaoPessoa,
  ContaBancaria,
  Categoria,
  MetodoPagamento,
  OrcamentoItem,
  Quota,
  Pagamento,
  PagamentoQuota,
  Despesa,
  Documento,
  Assembleia,
  AssembleiaParticipante,
  Aviso,
  AvisoDestinatario,
  EmailFila,
  AuditLog,
} = db;

// Utilizador ↔ Pessoa (relação explícita, nunca por nome)
User.belongsTo(Pessoa, { foreignKey: 'pessoa_id', as: 'pessoa' });
Pessoa.hasMany(User, { foreignKey: 'pessoa_id', as: 'users' });

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

// Quotas
Quota.belongsTo(Fracao, { foreignKey: 'fracao_id', as: 'fracao' });
Fracao.hasMany(Quota, { foreignKey: 'fracao_id', as: 'quotas' });

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

// Despesas
Despesa.belongsTo(Categoria, { foreignKey: 'categoria_id', as: 'categoria' });
Despesa.belongsTo(ContaBancaria, { foreignKey: 'conta_bancaria_id', as: 'conta_bancaria' });
Despesa.belongsTo(MetodoPagamento, { foreignKey: 'metodo_pagamento_id', as: 'metodo_pagamento' });

// Orçamento
OrcamentoItem.belongsTo(Categoria, { foreignKey: 'categoria_id', as: 'categoria' });

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

// Auditoria
AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

db.sequelize = sequelize;
db.Sequelize = require('sequelize');

module.exports = db;
