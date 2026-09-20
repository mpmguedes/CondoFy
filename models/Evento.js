const { DataTypes } = require('sequelize');

// Evento ad-hoc do calendário do condomínio.
//
// Um acontecimento datado que pertence a UM condomínio e não tem módulo de
// origem próprio. Distingue-se das outras duas origens do calendário:
//   • Assembleia   — reunião formal, com ordem de trabalhos e ata;
//   • Aviso        — comunicação programada (é informativa, não um
//                    acontecimento do condomínio em si);
//   • Evento       — este: um acontecimento do dia-a-dia (limpeza, obra,
//                    visita técnica, reunião informal…).
//
// Não guarda estado nem tipo: é deliberadamente simples, para não duplicar
// conceitos das assembleias nem criar categorias prematuras. A expansão
// futura (mais campos) faz-se acrescentando colunas, sem tocar no formato
// do evento normalizado devolvido por `helpers/calendario.js`.
const Evento = (sequelize) =>
  sequelize.define(
    'Evento',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      titulo: { type: DataTypes.STRING(255), allowNull: false },
      descricao: { type: DataTypes.TEXT, allowNull: true },
      data: { type: DataTypes.DATEONLY, allowNull: false },
      // 'HH:MM' — opcional (evento de dia inteiro quando ausente). A mesma
      // convenção de `assembleias.hora`: texto, para que o MySQL não devolva
      // um `Date` e mude o dia por causa do fuso horário.
      hora: { type: DataTypes.STRING(10), allowNull: true },
      // 'HH:MM' — opcional; quando presente é sempre posterior a `hora`.
      hora_fim: { type: DataTypes.STRING(10), allowNull: true },
      local: { type: DataTypes.STRING(255), allowNull: true },
      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'eventos', underscored: true }
  );

module.exports = Evento;
