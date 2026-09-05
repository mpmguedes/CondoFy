// ─────────────────────────────────────────────────────────────────────
// Fornecedores — CRUD e ficha do fornecedor (despesas, documentos).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Op } = require('sequelize');
const { Fornecedor, Despesa, Categoria, Documento } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');

const router = express.Router();
router.use(eAdmin);

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
  const [despesas, documentos] = await Promise.all([
    Despesa.findAll({
      where: { fornecedor_id: fornecedor.id },
      include: [{ model: Categoria, as: 'categoria' }],
      order: [['data', 'DESC'], ['id', 'DESC']],
    }),
    Documento.findAll({
      where: { entidade_tipo: 'Fornecedor', entidade_id: fornecedor.id },
      order: [['id', 'DESC']],
    }),
  ]);
  res.render('admin/fornecedores/detalhe', {
    titulo: fornecedor.nome,
    fornecedor,
    despesas,
    documentos,
  });
});

module.exports = router;
