const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PagamentoFornecedor = sequelize.define(
    'PagamentoFornecedor',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      fornecedor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      despesa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      valor: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      data_pagamento: { type: DataTypes.DATEONLY, allowNull: true },
      metodo_pagamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      conta_bancaria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      iban_utilizado: { type: DataTypes.STRING(40), allowNull: true },
      referencia: { type: DataTypes.STRING(120), allowNull: true },
      observacoes: { type: DataTypes.TEXT, allowNull: true },
      estado: {
        type: DataTypes.ENUM('pendente', 'pago', 'cancelado'),
        allowNull: false,
        defaultValue: 'pendente',
      },
      comprovativo_documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'pagamentos_fornecedores', underscored: true }
  );
  return PagamentoFornecedor;
};
