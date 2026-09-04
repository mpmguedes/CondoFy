const express = require('express');
const {
  Assembleia,
  AssembleiaParticipante,
  Fracao,
  Pessoa,
  Documento,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { getCondominio } = require('../helpers/condominio');
const drive = require('../helpers/drive');
const { gerarConvocatoriaPDF, gerarAtaPDF } = require('../helpers/pdf');

const router = express.Router();
router.use(eAdmin);

function pontos(ordem) {
  if (!ordem) return [];
  return ordem
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function enviarParaDrive(tipo, ano, nome, buffer, mimeType) {
  const pastaId = await drive.pastaParaDocumento(tipo, ano);
  return drive.uploadArquivo({ nome, mimeType, buffer, parentFolderId: pastaId });
}

router.get('/assembleias', async (req, res) => {
  const assembleias = await Assembleia.findAll({ order: [['data', 'DESC'], ['id', 'DESC']] });
  res.render('admin/assembleias/listar', { titulo: 'Assembleias', assembleias });
});

router.get('/assembleias/nova', (req, res) => {
  res.render('admin/assembleias/form', { titulo: 'Nova assembleia', assembleia: null });
});

router.post('/assembleias', async (req, res) => {
  const { data, hora, local, ordem_trabalhos, estado } = req.body;
  const assembleia = await Assembleia.create({
    data: data || null,
    hora: hora || null,
    local: local || null,
    ordem_trabalhos: ordem_trabalhos || null,
    estado: estado || 'agendada',
  });
  await audit({ userId: req.user.id, acao: 'criar_assembleia', entidade: 'Assembleia', entidadeId: assembleia.id });
  req.flash('success_msg', 'Assembleia criada.');
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

router.get('/assembleias/:id', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id, {
    include: [
      { model: Documento, as: 'convocatoria' },
      { model: Documento, as: 'ata' },
    ],
  });
  if (!assembleia) return res.redirect('/admin/assembleias');

  const [participantes, fracoes, pessoas] = await Promise.all([
    AssembleiaParticipante.findAll({
      where: { assembleia_id: assembleia.id },
      include: [
        { model: Fracao, as: 'fracao' },
        { model: Pessoa, as: 'pessoa' },
      ],
      order: [[{ model: Fracao, as: 'fracao' }, 'designacao', 'ASC']],
    }),
    Fracao.findAll({ order: [['designacao', 'ASC']] }),
    Pessoa.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] }),
  ]);

  res.render('admin/assembleias/detalhe', {
    titulo: 'Assembleia',
    assembleia,
    participantes,
    fracoes,
    pessoas,
    driveLigado: drive.isConfigured(),
  });
});

router.get('/assembleias/:id/editar', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  res.render('admin/assembleias/form', { titulo: 'Editar assembleia', assembleia });
});

router.post('/assembleias/:id', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  const { data, hora, local, ordem_trabalhos, ata_texto, estado } = req.body;
  await assembleia.update({
    data: data || null,
    hora: hora || null,
    local: local || null,
    ordem_trabalhos: ordem_trabalhos || null,
    ata_texto: ata_texto || null,
    estado: estado || 'agendada',
  });
  await audit({ userId: req.user.id, acao: 'editar_assembleia', entidade: 'Assembleia', entidadeId: assembleia.id });
  req.flash('success_msg', 'Assembleia atualizada.');
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

router.post('/assembleias/:id/participantes', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  const { fracao_id, pessoa_id, presente, permilagem } = req.body;
  await AssembleiaParticipante.create({
    assembleia_id: assembleia.id,
    fracao_id: fracao_id || null,
    pessoa_id: pessoa_id || null,
    presente: presente === 'on' || presente === '1' || presente === true,
    permilagem: permilagem ? parseFloat(String(permilagem).replace(',', '.')) : null,
  });
  req.flash('success_msg', 'Participante adicionado.');
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

router.post('/assembleias/:id/participantes/:pid/eliminar', async (req, res) => {
  await AssembleiaParticipante.destroy({ where: { id: req.params.pid, assembleia_id: req.params.id } });
  req.flash('success_msg', 'Participante removido.');
  res.redirect(`/admin/assembleias/${req.params.id}`);
});

router.get('/assembleias/:id/convocatoria', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  const condominio = await getCondominio();
  const buffer = await gerarConvocatoriaPDF(condominio.toJSON(), {
    data: assembleia.data,
    hora: assembleia.hora,
    local: assembleia.local,
    ordemTrabalhos: pontos(assembleia.ordem_trabalhos),
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="convocatoria_${assembleia.id}.pdf"`);
  res.send(buffer);
});

router.get('/assembleias/:id/ata', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  const condominio = await getCondominio();
  const participantes = await AssembleiaParticipante.findAll({
    where: { assembleia_id: assembleia.id },
    include: [{ model: Fracao, as: 'fracao' }],
  });
  const presentes = participantes
    .map((p) => (p.fracao ? p.fracao.designacao : '') + (p.permilagem ? ` (${p.permilagem}‰)` : ''))
    .join(', ');

  const buffer = await gerarAtaPDF(condominio.toJSON(), {
    data: assembleia.data,
    hora: assembleia.hora,
    local: assembleia.local,
    ordemTrabalhos: pontos(assembleia.ordem_trabalhos),
    presentes,
    ataTexto: assembleia.ata_texto,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ata_${assembleia.id}.pdf"`);
  res.send(buffer);
});

// Guardar convocatória no Drive
router.post('/assembleias/:id/convocatoria/drive', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  if (!drive.isConfigured()) {
    req.flash('error_msg', 'Google Drive não configurado.');
    return res.redirect(`/admin/assembleias/${assembleia.id}`);
  }
  try {
    const condominio = await getCondominio();
    const buffer = await gerarConvocatoriaPDF(condominio.toJSON(), {
      data: assembleia.data,
      hora: assembleia.hora,
      local: assembleia.local,
      ordemTrabalhos: pontos(assembleia.ordem_trabalhos),
    });
    const ano = assembleia.data ? new Date(assembleia.data).getFullYear() : new Date().getFullYear();
    const up = await enviarParaDrive('convocatoria', ano, `Convocatoria_${assembleia.id}.pdf`, buffer, 'application/pdf');
    const doc = await Documento.create({
      tipo: 'convocatoria',
      numero_documento: null,
      nome: `Convocatória ${assembleia.id}`,
      drive_file_id: up.driveFileId,
      mime_type: 'application/pdf',
      tamanho: up.tamanho,
      data: new Date(),
      entidade_tipo: 'Assembleia',
      entidade_id: assembleia.id,
      url: up.url,
      created_by: req.user.id,
    });
    await assembleia.update({ convocatoria_documento_id: doc.id });
    req.flash('success_msg', 'Convocatória guardada no Drive.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', `Erro: ${err.message}`);
  }
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

// Guardar ata no Drive
router.post('/assembleias/:id/ata/drive', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  if (!drive.isConfigured()) {
    req.flash('error_msg', 'Google Drive não configurado.');
    return res.redirect(`/admin/assembleias/${assembleia.id}`);
  }
  try {
    const condominio = await getCondominio();
    const participantes = await AssembleiaParticipante.findAll({
      where: { assembleia_id: assembleia.id },
      include: [{ model: Fracao, as: 'fracao' }],
    });
    const presentes = participantes
      .map((p) => (p.fracao ? p.fracao.designacao : '') + (p.permilagem ? ` (${p.permilagem}‰)` : ''))
      .join(', ');
    const buffer = await gerarAtaPDF(condominio.toJSON(), {
      data: assembleia.data,
      hora: assembleia.hora,
      local: assembleia.local,
      ordemTrabalhos: pontos(assembleia.ordem_trabalhos),
      presentes,
      ataTexto: assembleia.ata_texto,
    });
    const ano = assembleia.data ? new Date(assembleia.data).getFullYear() : new Date().getFullYear();
    const up = await enviarParaDrive('ata', ano, `Ata_${assembleia.id}.pdf`, buffer, 'application/pdf');
    const doc = await Documento.create({
      tipo: 'ata',
      numero_documento: null,
      nome: `Ata ${assembleia.id}`,
      drive_file_id: up.driveFileId,
      mime_type: 'application/pdf',
      tamanho: up.tamanho,
      data: new Date(),
      entidade_tipo: 'Assembleia',
      entidade_id: assembleia.id,
      url: up.url,
      created_by: req.user.id,
    });
    await assembleia.update({ ata_documento_id: doc.id });
    req.flash('success_msg', 'Ata guardada no Drive.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', `Erro: ${err.message}`);
  }
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

module.exports = router;
