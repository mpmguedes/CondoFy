// ─────────────────────────────────────────────────────────────────────
// Registo dos provedores de armazenamento do GesCondu.
//
// Acrescentar um serviço novo = criar o respetivo adaptador nesta pasta a
// cumprir helpers/armazenamento/contrato.js e registá-lo aqui. As rotas, as
// vistas e a lógica de documentos não mudam: falam sempre com a fachada
// helpers/storage.
//
// O Google Drive mantém a chave histórica 'google_drive' (compatibilidade
// com a configuração e com a base de dados existentes).
// ─────────────────────────────────────────────────────────────────────
const googleDrive = require('./google-drive');
const dropbox = require('./dropbox');
const onedrive = require('./onedrive');

const REGISTO = {
  google_drive: googleDrive,
  dropbox,
  onedrive,
};

module.exports = REGISTO;
