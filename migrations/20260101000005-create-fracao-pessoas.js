'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'fracao_pessoas',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        fracao_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'fracoes', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        pessoa_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'pessoas', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        vinculo: {
          type: Sequelize.ENUM('proprietario', 'arrendatario', 'usufrutuario'),
          allowNull: false,
          defaultValue: 'proprietario',
        },
        data_inicio: { type: Sequelize.DATEONLY, allowNull: true },
        data_fim: { type: Sequelize.DATEONLY, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('fracao_pessoas', ['fracao_id', 'pessoa_id', 'vinculo'], {
      unique: true,
      name: 'fracao_pessoas_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('fracao_pessoas');
  },
};
