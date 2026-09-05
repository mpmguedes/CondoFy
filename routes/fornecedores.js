// ─────────────────────────────────────────────────────────────────────
// Fornecedores — CRUD e ficha do fornecedor (despesas, documentos).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const multer = require('multer');
const { Op } = require('sequelize');
const {
  Fornecedor,
  Despesa,
  Categoria,
  Documento,
  PagamentoFornecedor,
  MetodoPagamento,
  ContaBancaria,
  EmailFila,
  User,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const drive = require('../helpers/drive');
const mailer = require('../helpers/mailer');
const { getCondominio } = require('../helpers/condominio');

const router = express.Router();
router.use(eAdmin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Tipo de ficheiro não permitido (PDF, JPG, PNG, WebP).'), ok);
  },
});

function str(v) {
  return v == null ? '' : String(v).trim();
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// IBAN: aceita IBAN portugueses (PT + 23 dígitos) e estrangeiros válidos.
function validarIban(iban) {
  const limpo = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!limpo) return { ok: true };
  if (!/^[A-Z]{2}[0-9A-Z]{11,32}$/.test(limpo)) {
    return { ok: false, mensagem: 'IBAN inválido (deve começar por 2 letras e ter entre 15 e 34 caracteres).' };
  }
  if (limpo.startsWith('PT') && limpo.length !== 25) {
    return { ok: false, mensagem: 'IBAN português deve ter 25 caracteres.' };
  }
  return { ok: true };
}

router.get('/fornecedores', async (req, res) => {
  const filtro = req.query.estado === 'inativos' ? false : req.query.estado === 'todos' ? null : true;
  const where = filtro === null ? {} : { ativo: filtro };
  const fornecedores = await Fornecedor.findAll({ where, order: [['nome', 'ASC']] });
  res.render('admin/fornecedores/listar', {
    titulo: 'Fornecedores',
    fornecedores,
    filtro: req.query.estado || 'ativos',
  });
});

router.get('/fornecedores/novo', (req, res) => {
  res.render('admin/fornecedores/form', { titulo: 'Novo fornecedor', fornecedor: null });
});

function dadosDoFormulario(body) {
  return {
    nome: str(body.nome),
    nif: str(body.nif) || null,
    morada: str(body.morada) || null,
    codigo_postal: str(body.codigo_postal) || null,
    localidade: str(body.localidade) || null,
    email: str(body.email) || null,
    telefone: str(body.telefone) || null,
    telemovel: str(body.telemovel) || null,
    iban: str(body.iban) || null,
    notas: str(body.notas) || null,
    ativo: body.ativo === 'on' || body.ativo === '1' || body.ativo === true,
  };
}

router.post('/fornecedores', async (req, res) => {
  try {
    const dados = dadosDoFormulario(req.body);
    if (!dados.nome) {
      req.flash('error_msg', 'Indique o nome do fornecedor.');
      return res.redirect('/admin/fornecedores/novo');
    }
    if (dados.email && !emailValido(dados.email)) {
      req.flash('error_msg', 'Email do fornecedor inválido.');
      return res.redirect('/admin/fornecedores/novo');
    }
    const iban = validarIban(dados.iban);
    if (!iban.ok) {
      req.flash('error_msg', iban.mensagem);
      return res.redirect('/admin/fornecedores/novo');
    }

    const fornecedor = await Fornecedor.create(dados);
    await audit({ userId: req.user.id, acao: 'criar_fornecedor', entidade: 'Fornecedor', entidadeId: fornecedor.id });
    req.flash('success_msg', 'Fornecedor criado.');
    res.redirect(`/admin/fornecedores/${fornecedor.id}`);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao criar o fornecedor.');
    res.redirect('/admin/fornecedores/novo');
  }
});

router.get('/fornecedores/:id/editar', async (req, res) => {
  const fornecedor = await Fornecedor.findByPk(req.params.id);
  if (!fornecedor) {
    req.flash('error_msg', 'Fornecedor não encontrado.');
    return res.redirect('/admin/fornecedores');
  }
  res.render('admin/fornecedores/form', { titulo: 'Editar fornecedor', fornecedor });
});

router.post('/fornecedores/:id', async (req, res) => {
  const fornecedor = await Fornecedor.findByPk(req.params.id);
  if (!fornecedor) return res.redirect('/admin/fornecedores');
  try {
    const dados = dadosDoFormulario(req.body);
    if (!dados.nome) {
      req.flash('error_msg', 'Indique o nome do fornecedor.');
      return res.redirect(`/admin/fornecedores/${fornecedor.id}/editar`);
    }
    if (dados.email && !emailValido(dados.email)) {
      req.flash('error_msg', 'Email do fornecedor inválido.');
      return res.redirect(`/admin/fornecedores/${fornecedor.id}/editar`);
    }
    const iban = validarIban(dados.iban);
    if (!iban.ok) {
      req.flash('error_msg', iban.mensagem);
      return res.redirect(`/admin/fornecedores/${fornecedor.id}/editar`);
    }
    await fornecedor.update(dados);
    await audit({ userId: req.user.id, acao: 'editar_fornecedor', entidade: 'Fornecedor', entidadeId: fornecedor.id });
    req.flash('success_msg', 'Fornecedor atualizado.');
    res.redirect(`/admin/fornecedores/${fornecedor.id}`);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao atualizar o fornecedor.');
    res.redirect(`/admin/fornecedores/${fornecedor.id}/editar`);
  }
});

router.post('/fornecedores/:id/eliminar', async (req, res) => {
  const fornecedor = await Fornecedor.findByPk(req.params.id);
  if (fornecedor) {
    await fornecedor.destroy();
    await audit({ userId: req.user.id, acao: 'eliminar_fornecedor', entidade: 'Fornecedor', entidadeId: req.params.id });
    req.flash('success_msg', 'Fornecedor eliminado (as despesas associadas ficam sem fornecedor).');
  }
  res.redirect('/admin/fornecedores');
});

router.get('/fornecedores/:id', async (req, res) => {
  const fornecedor = await Fornecedor.findByPk(req.params.id);
  if (!fornecedor) return res.redirect('/admin/fornecedores');

  const [despesas, documentos, pagamentos] = await Promise.all([
    Despesa.findAll({
      where: { fornecedor_id: fornecedor.id },
      include: [{ model: Categoria, as: 'categoria' }],
      order: [['data', 'DESC'], ['id', 'DESC']],
    }),
    Documento.findAll({
      where: { entidade_tipo: 'Fornecedor', entidade_id: fornecedor.id },
      order: [['id', 'DESC']],
    }),
    PagamentoFornecedor.findAll({
      where: { fornecedor_id: fornecedor.id },
      include: [
        { model: MetodoPagamento, as: 'metodo_pagamento' },
        { model: Documento, as: 'comprovativo' },
        { model: Despesa, as: 'despesa' },
      ],
      order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
    }),
  ]);

  // Comunicações: emails associados aos pagamentos deste fornecedor.
  let comunicacoes = [];
  const idsPagamentos = pagamentos.map((p) => p.id);
  if (idsPagamentos.length) {
    comunicacoes = await EmailFila.findAll({
      where: { entidade_tipo: 'PagamentoFornecedor', entidade_id: { [Op.in]: idsPagamentos } },
      include: [{ model: User, as: 'utilizador', attributes: ['id', 'nome'] }],
      order: [['id', 'DESC']],
      limit: 20,
    });
  }

  res.render('admin/fornecedores/detalhe', {
    titulo: fornecedor.nome,
    fornecedor,
    despesas,
    documentos,
    pagamentos,
    comunicacoes,
  });
});

// ═══════════════════════════════════════════════════════════════════
// PAGAMENTOS A FORNECEDORES
// ═══════════════════════════════════════════════════════════════════
router.get('/fornecedores/:id/pagamentos/novo', async (req, res) => {
  const fornecedor = await Fornecedor.findByPk(req.params.id);
  if (!fornecedor) return res.redirect('/admin/fornecedores');
  const [despesas, metodos, contas] = await Promise.all([
    Despesa.findAll({ where: { fornecedor_id: fornecedor.id }, order: [['data', 'DESC']] }),
    MetodoPagamento.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] }),
    ContaBancaria.findAll({ where: { ativa: true }, order: [['nome', 'ASC']] }),
  ]);
  res.render('admin/fornecedores/pagamento-novo', {
    titulo: 'Novo pagamento a fornecedor',
    fornecedor,
    despesas,
    metodos,
    contas,
    today: new Date(),
    driveLigado: drive.isConfigured(),
  });
});

router.post('/fornecedores/:id/pagamentos', async (req, res) => {
  const fornecedor = await Fornecedor.findByPk(req.params.id);
  if (!fornecedor) return res.redirect('/admin/fornecedores');
  try {
    const pagamento = await PagamentoFornecedor.create({
      fornecedor_id: fornecedor.id,
      despesa_id: parseInt(req.body.despesa_id, 10) || null,
      valor: parseFloat(String(req.body.valor).replace(',', '.')) || 0,
      data_pagamento: req.body.data_pagamento || new Date(),
      metodo_pagamento_id: parseInt(req.body.metodo_pagamento_id, 10) || null,
      conta_bancaria_id: parseInt(req.body.conta_bancaria_id, 10) || null,
      iban_utilizado: req.body.iban_utilizado || fornecedor.iban || null,
      referencia: req.body.referencia || null,
      observacoes: req.body.observacoes || null,
      estado: ['pendente', 'pago', 'cancelado'].includes(req.body.estado) ? req.body.estado : 'pendente',
      created_by: req.user.id,
    });
    await audit({ userId: req.user.id, acao: 'criar_pagamento_fornecedor', entidade: 'PagamentoFornecedor', entidadeId: pagamento.id });
    req.flash('success_msg', 'Pagamento registado.');
    res.redirect(`/admin/fornecedores/${fornecedor.id}/pagamentos/${pagamento.id}`);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao registar o pagamento.');
    res.redirect(`/admin/fornecedores/${fornecedor.id}/pagamentos/novo`);
  }
});

router.post('/fornecedores/:id/pagamentos/:pid/estado', async (req, res) => {
  const pagamento = await PagamentoFornecedor.findByPk(req.params.pid);
  if (!pagamento) return res.redirect('/admin/fornecedores');
  if (['pendente', 'pago', 'cancelado'].includes(req.body.estado)) {
    await pagamento.update({ estado: req.body.estado });
    await audit({ userId: req.user.id, acao: 'estado_pagamento_fornecedor', entidade: 'PagamentoFornecedor', entidadeId: pagamento.id, detalhes: { estado: req.body.estado } }).catch(() => {});
  }
  res.redirect(`/admin/fornecedores/${pagamento.fornecedor_id}/pagamentos/${pagamento.id}`);
});

router.get('/fornecedores/:id/pagamentos/:pid', async (req, res) => {
  const pagamento = await PagamentoFornecedor.findByPk(req.params.pid, {
    include: [
      { model: Fornecedor, as: 'fornecedor' },
      { model: Despesa, as: 'despesa' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: ContaBancaria, as: 'conta_bancaria' },
      { model: Documento, as: 'comprovativo' },
      { model: User, as: 'criador', attributes: ['id', 'nome'] },
    ],
  });
  if (!pagamento) return res.redirect('/admin/fornecedores');
  const envios = await EmailFila.findAll({
    where: { entidade_tipo: 'PagamentoFornecedor', entidade_id: pagamento.id },
    include: [{ model: User, as: 'utilizador', attributes: ['id', 'nome'] }],
    order: [['id', 'DESC']],
  });
  res.render('admin/fornecedores/pagamento-detalhe', {
    titulo: `Pagamento a fornecedor — ${pagamento.fornecedor ? pagamento.fornecedor.nome : ''}`,
    fornecedorId: req.params.id,
    pagamento,
    envios,
    driveLigado: drive.isConfigured(),
  });
});

// Comprovativo: upload (guardado no Google Drive e registado como Documento).
router.post('/fornecedores/:id/pagamentos/:pid/comprovativo', upload.single('ficheiro'), async (req, res) => {
  const pagamento = await PagamentoFornecedor.findByPk(req.params.pid, {
    include: [{ model: Fornecedor, as: 'fornecedor' }],
  });
  if (!pagamento) return res.redirect('/admin/fornecedores');
  const fornecedor = pagamento.fornecedor || {};
  try {
    if (!req.file) throw new Error('Selecione o ficheiro do comprovativo.');
    if (!drive.isConfigured()) throw new Error('O Google Drive não está ligado — é necessário para guardar o comprovativo.');
    const ano = pagamento.data_pagamento ? new Date(pagamento.data_pagamento).getFullYear() : new Date().getFullYear();
    const pastas = await drive.pastaParaFornecedor({ nome: fornecedor.nome || 'Fornecedor', ano, subpasta: 'Comprovativos' });
    const up = await drive.uploadArquivo({ nome: req.file.originalname, mimeType: req.file.mimetype, buffer: req.file.buffer, parentFolderId: pastas.subpastaId });

    const documento = await Documento.create({
      tipo: 'comprovativo',
      nome: `Comprovativo ${fornecedor.nome || ''} — ${pagamento.referencia || pagamento.id}`.trim(),
      pasta: 'fornecedores',
      drive_file_id: up.driveFileId,
      drive_folder_id: pastas.subpastaId,
      mime_type: req.file.mimetype,
      tamanho: up.tamanho,
      data: pagamento.data_pagamento || new Date(),
      url: up.url,
      drive_status: 'guardado',
      drive_uploaded_at: new Date(),
      entidade_tipo: 'PagamentoFornecedor',
      entidade_id: pagamento.id,
      created_by: req.user.id,
    });
    await pagamento.update({ comprovativo_documento_id: documento.id });
    await audit({ userId: req.user.id, acao: 'guardar_comprovativo_drive', entidade: 'Documento', entidadeId: documento.id }).catch(() => {});
    req.flash('success_msg', 'Comprovativo guardado no Google Drive.');
  } catch (err) {
    console.error('[comprovativo]', err.message);
    req.flash('error_msg', err.message);
  }
  res.redirect(`/admin/fornecedores/${req.params.id}/pagamentos/${pagamento.id}`);
});

// Enviar comprovativo ao fornecedor (formulário pré-preenchido).
router.get('/fornecedores/:id/pagamentos/:pid/comprovativo/enviar', async (req, res) => {
  const pagamento = await PagamentoFornecedor.findByPk(req.params.pid, {
    include: [
      { model: Fornecedor, as: 'fornecedor' },
      { model: Despesa, as: 'despesa' },
      { model: Documento, as: 'comprovativo' },
    ],
  });
  if (!pagamento) return res.redirect('/admin/fornecedores');
  const fornecedor = pagamento.fornecedor || {};
  const condominio = (await getCondominio()) || {};
  res.render('admin/fornecedores/comprovativo-enviar', {
    titulo: 'Enviar comprovativo ao fornecedor',
    pagamento,
    fornecedorId: req.params.id,
    driveLigado: drive.isConfigured(),
    comprovativo: pagamento.comprovativo || null,
    emailFornecedor: fornecedor.email || '',
    assuntoSugerido: `Comprovativo de pagamento — ${condominio.designacao || 'Condomínio'}${pagamento.referencia ? ` — ${pagamento.referencia}` : ''}`,
    mensagemSugerida:
      'Exmos. Senhores,\n\nEnviamos em anexo o comprovativo da transferência bancária referente ao pagamento da fatura indicada.\n\nCom os melhores cumprimentos,\nAdministração do Condomínio',
  });
});

router.post('/fornecedores/:id/pagamentos/:pid/comprovativo/enviar', async (req, res) => {
  const pagamento = await PagamentoFornecedor.findByPk(req.params.pid, {
    include: [
      { model: Fornecedor, as: 'fornecedor' },
      { model: Documento, as: 'comprovativo' },
    ],
  });
  if (!pagamento) return res.redirect('/admin/fornecedores');
  const fornecedor = pagamento.fornecedor || {};
  try {
    const para = String(req.body.para || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(para)) throw new Error('Email do destinatário inválido.');
    if (!pagamento.comprovativo || !pagamento.comprovativo.drive_file_id) {
      throw new Error('Este pagamento ainda não tem comprovativo guardado.');
    }
    const buffer = await drive.descargarArquivo(pagamento.comprovativo.drive_file_id);
    const nomeAnexo = pagamento.comprovativo.nome || 'comprovativo.pdf';

    const resEmail = await mailer.sendMail({
      to: para,
      subject: req.body.assunto || 'Comprovativo de pagamento',
      text: req.body.mensagem || '',
      attachments: [{ filename: nomeAnexo, content: buffer }],
    });
    await EmailFila.create({
      destinatario_email: para,
      destinatario_nome: fornecedor.nome || null,
      assunto: req.body.assunto || 'Comprovativo de pagamento',
      corpo: req.body.mensagem || null,
      documento_id: pagamento.comprovativo.id,
      entidade_tipo: 'PagamentoFornecedor',
      entidade_id: pagamento.id,
      user_id: req.user.id,
      tipo: 'normal',
      estado: 'enviado',
      data_enviada: new Date(),
      message_id: resEmail.messageId || null,
      tentativas: 1,
    });
    await audit({ userId: req.user.id, acao: 'enviar_comprovativo_fornecedor', entidade: 'PagamentoFornecedor', entidadeId: pagamento.id, detalhes: { para } }).catch(() => {});
    req.flash('success_msg', `Comprovativo enviado para ${para}.`);
  } catch (err) {
    console.error('[comprovativo-envio]', err.message);
    req.flash('error_msg', `Não foi possível enviar: ${err.message}`);
  }
  res.redirect(`/admin/fornecedores/${req.params.id}/pagamentos/${pagamento.id}`);
});

module.exports = router;
