// ─────────────────────────────────────────────────────────────────────
// Quantos documentos de um condomínio estão guardados em cada serviço.
//
// Serve a página Configurações → Armazenamento e Backups para avisar quando há
// documentos guardados num serviço que NÃO está ligado: sem o aviso, o
// administrador só descobre o problema ao tentar abrir um documento (502) e não
// sabe que basta voltar a ligar a conta que os criou.
//
// O serviço é decidido pelo LOCALIZADOR guardado em documentos.drive_file_id
// (helpers/armazenamento/locator.js): `dbx:` Dropbox, `od:` OneDrive e sem
// prefixo (ou `gd:`) Google Drive. Não se lê nenhum ficheiro nem se fala com os
// fornecedores — é só uma contagem.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { Documento } = require('../models');
const locator = require('./armazenamento/locator');

const PREFIXOS = { dropbox: 'dbx:', onedrive: 'od:' };

// Devolve { google_drive: n, dropbox: n, onedrive: n } para o condomínio.
async function contarPorServico(condominioId) {
  const cid = Number(condominioId);
  const vazio = { google_drive: 0, dropbox: 0, onedrive: 0 };
  if (!Number.isFinite(cid) || cid <= 0) return vazio;

  const base = { condominio_id: cid, drive_file_id: { [Op.ne]: null } };
  const comPrefixos = Object.values(PREFIXOS);
  const saida = { ...vazio };
  try {
    const [drive, ...outros] = await Promise.all([
      // Google Drive: sem prefixo conhecido (comportamento histórico) ou `gd:`.
      Documento.count({
        where: {
          ...base,
          [Op.and]: comPrefixos.map((p) => ({ drive_file_id: { [Op.notLike]: `${p}%` } })),
        },
      }),
      ...Object.entries(PREFIXOS).map(([, prefixo]) =>
        Documento.count({ where: { ...base, drive_file_id: { [Op.like]: `${prefixo}%` } } })
      ),
    ]);
    saida.google_drive = drive;
    Object.keys(PREFIXOS).forEach((nome, i) => {
      saida[nome] = outros[i];
    });
  } catch (err) {
    // BD indisponível: a página continua a funcionar sem as contagens.
    return vazio;
  }
  return saida;
}

// Quantos documentos tem um serviço, a partir de um mapa de contagens.
function documentosDoServico(contagens, provedor) {
  const chave = locator.provedorValido(provedor) ? String(provedor).toLowerCase() : null;
  if (!chave || !contagens) return 0;
  return Number(contagens[chave] || 0);
}

module.exports = { contarPorServico, documentosDoServico };
