'use strict';

// Estados de integração do documento com o Google Drive.
// drive_file_id/url já existem; passam a ser acompanhados por estado,
// mensagem de erro e data de envio para o Drive.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('documentos', 'drive_status', {
      type: Sequelize.ENUM('nao_guardado', 'pendente', 'guardado', 'erro'),
      allowNull: false,
      defaultValue: 'nao_guardado',
    });
    await queryInterface.addColumn('documentos', 'drive_erro', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('documentos', 'drive_uploaded_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('documentos', 'drive_folder_id', {
      type: Sequelize.STRING(191),
      allowNull: true,
    });

    // Retrocesso: documentos que já tinham ficheiro no Drive ficam "guardado".
    await queryInterface.sequelize.query(
      "UPDATE documentos SET drive_status = 'guardado', drive_uploaded_at = COALESCE(updated_at, created_at) " +
        "WHERE drive_file_id IS NOT NULL AND drive_file_id <> ''"
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('documentos', 'drive_folder_id');
    await queryInterface.removeColumn('documentos', 'drive_uploaded_at');
    await queryInterface.removeColumn('documentos', 'drive_erro');
    await queryInterface.removeColumn('documentos', 'drive_status');
  },
};
