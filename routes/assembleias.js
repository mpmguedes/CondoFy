const express = require('express');
const multer = require('multer');
const {
  Assembleia,
  AssembleiaParticipante,
  AgendaItem,
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

// Anexos: PDF, JPG, PNG, WebP até 20 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Tipo de ficheiro não permitido (PDF, JPG, PNG, WebP).'), ok);
  },
});

const TIPOS = { ordinaria: 'Ordinária', extraordinaria: 'Extraordinária', urgencia: 'Urgência' };
const ESTADOS_LABEL = {
  rascunho: 'Rascunho',
  agendada: 'Agendada',
  convocada: 'Convocada',
  realizada: 'Realizada',
  cancelada: 'Cancelada',
};

function pontos(ordem) {
  if (!ordem) return [];
  return ordem.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function parseHoraSegundos(hora) {
  // "21:00" → "21:30" (2ª convocatória 30 min depois)
  const m = /^(\d{1,2}):(\d{2})$/.exec((hora || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  let min = parseInt(m[2], 10);
  min += 30;
  if (min >= 60) { min -= 60; h += 1; }
  if (h >= 24) h -= 24;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

async function proximoNumeroAssembleia(ano) {
  const ultima = await Assembleia.findOne({
    where: { numero: { [require('sequelize').Op.like]: `${ano}/%` } },
    order: [['id', 'DESC']],
  });
  if (!ultima) return `${ano}/1`;
  const n = parseInt(ultima.numero.split('/')[1], 10) || 0;
  return `${ano}/${n + 1}`;
}

async function enviarParaDrive(tipo, ano, nome, buffer, mimeType) {
  const pastaId = await drive.pastaParaDocumento(tipo, ano);
  return drive.uploadArquivo({ nome, mimeType, buffer, parentFolderId: pastaId });
}

// ── Lista (dashboard + filtros) ────────────────────────────────────
router.get('/assembleias', async (req, res) => {
  const filtro = req.query.estado || 'todas';
  const where = {};
  if (['rascunho', 'agendada', 'convocada', 'realizada', 'cancelada'].includes(filtro)) {
    where.estado = filtro;
  }
  const assembleias = await Assembleia.findAll({ where, order: [['data', 'DESC'], ['id', 'DESC']] });

  const [nRascunhos, nAgendadas, nRealizadas, nTotal] = await Promise.all([
    Assembleia.count({ where: { estado: 'rascunho' } }),
    Assembleia.count({ where: { estado: { [require('sequelize').Op.in]: ['agendada', 'convocada'] } } }),
    Assembleia.count({ where: { estado: 'realizada' } }),
    Assembleia.count(),
  ]);

  res.render('admin/assembleias/listar', {
    titulo: 'Assembleias',
    assembleias,
    filtro,
    tipos: TIPOS,
    estadosLabel: ESTADOS_LABEL,
    cards: { nRascunhos, nAgendadas, nRealizadas, nTotal },
  });
});

router.get('/assembleias/nova', async (req, res) => {
  const ano = new Date().getFullYear();
  const numero = await proximoNumeroAssembleia(ano);
  res.render('admin/assembleias/form', {
    titulo: 'Nova assembleia',
    assembleia: null,
    tipos: TIPOS,
    numeroSugerido: numero,
  });
});

router.post('/assembleias', async (req, res) => {
  const { numero, tipo, data, hora, local } = req.body;
  const assembleia = await Assembleia.create({
    numero: numero || null,
    tipo: tipo || 'ordinaria',
    data: data || null,
    hora: hora || null,
    local: local || null,
    estado: 'rascunho',
  });
  await audit({ userId: req.user.id, acao: 'criar_assembleia', entidade: 'Assembleia', entidadeId: assembleia.id });
  req.flash('success_msg', 'Assembleia criada (rascunho).');
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

router.get('/assembleias/:id', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id, {
    include: [
      { model: Documento, as: 'convocatoria' },
      { model: Documento, as: 'ata' },
      { model: AgendaItem, as: 'agenda_itens' },
    ],
  });
  if (!assembleia) return res.redirect('/admin/assembleias');

  const [participantes, fracoes, pessoas, anexos] = await Promise.all([
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
    Documento.findAll({
      where: { entidade_tipo: 'Assembleia', entidade_id: assembleia.id },
      order: [['id', 'DESC']],
    }),
  ]);

  res.render('admin/assembleias/detalhe', {
    titulo: assembleia.numero ? `Assembleia ${assembleia.numero}` : 'Assembleia',
    assembleia,
    participantes,
    fracoes,
    pessoas,
    anexos,
    driveLigado: drive.isConfigured(),
    tipos: TIPOS,
    estadosLabel: ESTADOS_LABEL,
  });
});

router.get('/assembleias/:id/editar', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  res.render('admin/assembleias/form', {
    titulo: 'Editar assembleia',
    assembleia,
    tipos: TIPOS,
    numeroSugerido: assembleia.numero,
  });
});

router.post('/assembleias/:id', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  const { numero, tipo, data, hora, local, estado } = req.body;
  await assembleia.update({
    numero: numero || null,
    tipo: tipo || assembleia.tipo,
    data: data || null,
    hora: hora || null,
    local: local || null,
    estado: estado || assembleia.estado,
  });
  await audit({ userId: req.user.id, acao: 'editar_assembleia', entidade: 'Assembleia', entidadeId: assembleia.id });
  req.flash('success_msg', 'Assembleia atualizada.');
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

// ── Ordem de trabalhos (itens) ─────────────────────────────────────
router.post('/assembleias/:id/agenda', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  const descricao = (req.body.descricao || '').trim();
  if (!descricao) {
    req.flash('error_msg', 'Indique a descrição do ponto.');
    return res.redirect(`/admin/assembleias/${assembleia.id}`);
  }
  const ultimo = await AgendaItem.findOne({ where: { assembleia_id: assembleia.id }, order: [['ordem', 'DESC']] });
  await AgendaItem.create({
    assembleia_id: assembleia.id,
    ordem: (ultimo ? ultimo.ordem : 0) + 1,
    descricao,
    sujeito_votacao: req.body.sujeito_votacao === 'on' || req.body.sujeito_votacao === '1' || req.body.sujeito_votacao === true,
  });
  req.flash('success_msg', 'Ponto adicionado.');
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

router.post('/assembleias/:id/agenda/:aid', async (req, res) => {
  const item = await AgendaItem.findByPk(req.params.aid);
  if (!item || item.assembleia_id !== parseInt(req.params.id, 10)) return res.redirect('/admin/assembleias');
  await item.update({
    descricao: (req.body.descricao || item.descricao).trim() || item.descricao,
    sujeito_votacao: req.body.sujeito_votacao === 'on' || req.body.sujeito_votacao === '1' || req.body.sujeito_votacao === true,
  });
  req.flash('success_msg', 'Ponto atualizado.');
  res.redirect(`/admin/assembleias/${req.params.id}`);
});

router.post('/assembleias/:id/agenda/:aid/eliminar', async (req, res) => {
  await AgendaItem.destroy({ where: { id: req.params.aid, assembleia_id: req.params.id } });
  req.flash('success_msg', 'Ponto removido.');
  res.redirect(`/admin/assembleias/${req.params.id}`);
});

router.post('/assembleias/:id/agenda/reordenar', async (req, res) => {
  const ordem = req.body.ordem || [];
  for (let i = 0; i < ordem.length; i++) {
    await AgendaItem.update({ ordem: i + 1 }, { where: { id: parseInt(ordem[i], 10), assembleia_id: req.params.id } });
  }
  res.redirect(`/admin/assembleias/${req.params.id}`);
});

// ── Anexos ─────────────────────────────────────────────────────────
router.post('/assembleias/:id/anexos', upload.single('ficheiro'), async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id);
  if (!assembleia) return res.redirect('/admin/assembleias');
  try {
    if (!req.file) {
      req.flash('error_msg', 'Selecione um ficheiro para anexar.');
      return res.redirect(`/admin/assembleias/${assembleia.id}`);
    }
    if (!drive.isConfigured()) {
      req.flash('error_msg', 'Google Drive não configurado — não é possível guardar anexos.');
      return res.redirect(`/admin/assembleias/${assembleia.id}`);
    }
    const ano = assembleia.data ? new Date(assembleia.data).getFullYear() : new Date().getFullYear();
    const up = await enviarParaDrive('ata', ano, req.file.originalname, req.file.buffer, req.file.mimetype);
    await Documento.create({
      tipo: 'outro',
      numero_documento: null,
      nome: req.file.originalname,
      pasta: 'assembleias',
      drive_file_id: up.driveFileId,
      mime_type: req.file.mimetype,
      tamanho: up.tamanho,
      data: new Date(),
      entidade_tipo: 'Assembleia',
      entidade_id: assembleia.id,
      url: up.url,
      drive_status: 'guardado',
      drive_uploaded_at: new Date(),
      created_by: req.user.id,
    });
    req.flash('success_msg', 'Anexo adicionado.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', `Erro ao anexar: ${err.message}`);
  }
  res.redirect(`/admin/assembleias/${assembleia.id}`);
});

router.post('/assembleias/:id/anexos/:did/eliminar', async (req, res) => {
  const doc = await Documento.findByPk(req.params.did);
  if (doc && doc.entidade_id === parseInt(req.params.id, 10)) {
    await doc.destroy();
    req.flash('success_msg', 'Anexo eliminado.');
  }
  res.redirect(`/admin/assembleias/${req.params.id}`);
});

// ── Participantes ──────────────────────────────────────────────────
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

// ── PDFs ───────────────────────────────────────────────────────────
router.get('/assembleias/:id/convocatoria', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id, {
    include: [{ model: AgendaItem, as: 'agenda_itens' }],
  });
  if (!assembleia) return res.redirect('/admin/assembleias');
  const condominio = await getCondominio();
  const agenda = (assembleia.agenda_itens || [])
    .slice()
    .sort((a, b) => a.ordem - b.ordem)
    .map((i) => i.descricao);
  const buffer = await gerarConvocatoriaPDF(condominio.toJSON(), {
    numero: assembleia.numero,
    tipo: TIPOS[assembleia.tipo] || assembleia.tipo,
    data: assembleia.data,
    hora: assembleia.hora,
    horaSegunda: parseHoraSegundos(assembleia.hora),
    local: assembleia.local,
    ordemTrabalhos: agenda.length ? agenda : pontos(assembleia.ordem_trabalhos),
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="convocatoria_${assembleia.numero || assembleia.id}.pdf"`);
  res.send(buffer);
});

router.get('/assembleias/:id/ata', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id, {
    include: [{ model: AgendaItem, as: 'agenda_itens' }],
  });
  if (!assembleia) return res.redirect('/admin/assembleias');
  const condominio = await getCondominio();
  const participantes = await AssembleiaParticipante.findAll({
    where: { assembleia_id: assembleia.id },
    include: [{ model: Fracao, as: 'fracao' }],
  });
  const presentes = participantes
    .map((p) => (p.fracao ? p.fracao.designacao : '') + (p.permilagem ? ` (${p.permilagem}‰)` : ''))
    .join(', ');
  const agenda = (assembleia.agenda_itens || [])
    .slice()
    .sort((a, b) => a.ordem - b.ordem)
    .map((i) => i.descricao);

  const buffer = await gerarAtaPDF(condominio.toJSON(), {
    data: assembleia.data,
    hora: assembleia.hora,
    local: assembleia.local,
    ordemTrabalhos: agenda.length ? agenda : pontos(assembleia.ordem_trabalhos),
    presentes,
    ataTexto: assembleia.ata_texto,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ata_${assembleia.numero || assembleia.id}.pdf"`);
  res.send(buffer);
});

// Guardar convocatória no Drive
router.post('/assembleias/:id/convocatoria/drive', async (req, res) => {
  const assembleia = await Assembleia.findByPk(req.params.id, {
    include: [{ model: AgendaItem, as: 'agenda_itens' }],
  });
  if (!assembleia) return res.redirect('/admin/assembleias');
  if (!drive.isConfigured()) {
    req.flash('error_msg', 'Google Drive não configurado.');
    return res.redirect(`/admin/assembleias/${assembleia.id}`);
  }
  try {
    const condominio = await getCondominio();
    const agenda = (assembleia.agenda_itens || []).slice().sort((a, b) => a.ordem - b.ordem).map((i) => i.descricao);
    const buffer = await gerarConvocatoriaPDF(condominio.toJSON(), {
      numero: assembleia.numero,
      tipo: TIPOS[assembleia.tipo] || assembleia.tipo,
      data: assembleia.data,
      hora: assembleia.hora,
      horaSegunda: parseHoraSegundos(assembleia.hora),
      local: assembleia.local,
      ordemTrabalhos: agenda.length ? agenda : pontos(assembleia.ordem_trabalhos),
    });
    const ano = assembleia.data ? new Date(assembleia.data).getFullYear() : new Date().getFullYear();
    const up = await enviarParaDrive('convocatoria', ano, `Convocatoria_${assembleia.numero || assembleia.id}.pdf`, buffer, 'application/pdf');
    const doc = await Documento.create({
      tipo: 'convocatoria',
      numero_documento: null,
      nome: `Convocatória ${assembleia.numero || assembleia.id}`,
      pasta: 'assembleias',
      drive_file_id: up.driveFileId,
      mime_type: 'application/pdf',
      tamanho: up.tamanho,
      data: new Date(),
      entidade_tipo: 'Assembleia',
      entidade_id: assembleia.id,
      url: up.url,
      drive_status: 'guardado',
      drive_uploaded_at: new Date(),
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
  const assembleia = await Assembleia.findByPk(req.params.id, {
    include: [{ model: AgendaItem, as: 'agenda_itens' }],
  });
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
    const agenda = (assembleia.agenda_itens || []).slice().sort((a, b) => a.ordem - b.ordem).map((i) => i.descricao);
    const buffer = await gerarAtaPDF(condominio.toJSON(), {
      data: assembleia.data,
      hora: assembleia.hora,
      local: assembleia.local,
      ordemTrabalhos: agenda.length ? agenda : pontos(assembleia.ordem_trabalhos),
      presentes,
      ataTexto: assembleia.ata_texto,
    });
    const ano = assembleia.data ? new Date(assembleia.data).getFullYear() : new Date().getFullYear();
    const up = await enviarParaDrive('ata', ano, `Ata_${assembleia.numero || assembleia.id}.pdf`, buffer, 'application/pdf');
    const doc = await Documento.create({
      tipo: 'ata',
      numero_documento: null,
      nome: `Ata ${assembleia.numero || assembleia.id}`,
      pasta: 'assembleias',
      drive_file_id: up.driveFileId,
      mime_type: 'application/pdf',
      tamanho: up.tamanho,
      data: new Date(),
      entidade_tipo: 'Assembleia',
      entidade_id: assembleia.id,
      url: up.url,
      drive_status: 'guardado',
      drive_uploaded_at: new Date(),
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
