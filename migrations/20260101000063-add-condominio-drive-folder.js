'use strict';

// Pasta raiz do condomínio no Google Drive (drive_folder_id).
//
// Contexto: a estrutura do Drive passa a ser por condomínio
//   <raiz>/<Condomínio>/<ano>/{Assembleias,Quotas,Recibos,Despesas,Contratos,Outros}
// em vez de <raiz>/<ano>/… (global). O id da pasta do condomínio é guardado
// nesta coluna para resolver inequivocamente a pasta por condominio_id — nunca
// por nomes de ficheiro/pastas. Ficheiros antigos NÃO são movidos: os
// Documentos continuam a apontar para os drive_file_id existentes.
//
// Aditiva: condomínios existentes ficam com drive_folder_id NULL e a pasta é
// criada/registada no primeiro upload (ou no botão "Criar estrutura" da
// Configuração).

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('condominios', 'drive_folder_id', {
      type: Sequelize.STRING(191),
      allowNull: true,
      comment: 'Google Drive: id da pasta raiz do condomínio (<raiz>/<Condomínio>)',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('condominios', 'drive_folder_id');
  },
};
