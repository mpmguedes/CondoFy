// ─────────────────────────────────────────────────────────────────────
// Eventos ad-hoc do calendário do condomínio (criar/editar/eliminar).
//
// Estes são os ÚNICOS acontecimentos do calendário com CRUD próprio: as
// assembleias editam-se em `/admin/assembleias` e as comunicações em
// `/admin/avisos`. Aqui vive só o evento avulso, que não tem módulo de
// origem — ver a nota de âmbito em `helpers/calendario.js`.
//
// Isolamento multi-condomínio: o router usa o condomínio ativo da sessão
// (`tenant.comCondominioAtivo`, que valida a associação real) e TODAS as
// leituras e escritas filtram por `condominio_id`. O `condominio_id` nunca
// é lido do corpo nem da query: vem sempre de `req.condominioId` (sessão).
//
// Acesso: `gestor` (abrange admin e gestor do condomínio), o mesmo das
// áreas operacionais do dia-a-dia. O perfil `leitura` não escreve.
//
// Nota deliberada: este módulo NÃO está na allow-list do suporte
// (`helpers/suporte-allowlist.js`). Não tem vista de diagnóstico minimizada
// e a regra da allow-list é que uma rota nova nasce INACESSÍVEL ao suporte.
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Evento } = require('../models');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { toDateInput } = require('../helpers/dates');

const router = express.Router();

router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('gestor'));

// 'HH:MM' em 24 horas. Aceita também a forma curta ('9:5', '9:05'), que é o
// que sai de um teclado humano e de algumas versões do seletor do browser, e
// normaliza sempre para 'HH:MM' com dois dígitos.
const RE_HORA = /^([01]?\d|2[0-3]):([0-5]?\d)$/;
const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

// Normaliza uma hora para 'HH:MM'. Devolve '' quando ausente ou inválida.
function normalizarHora(valor) {
  const bruto = String(valor == null ? '' : valor).trim();
  if (!bruto) return '';
  const m = RE_HORA.exec(bruto);
  if (!m) return null; // inválida, distingue-se de ausente ('')
  // Ambos os grupos são preenchidos a dois dígitos: '9:5' tem de ficar '09:05'
  // e não '09:5' — caso contrário a comparação de horas por ordem de string
  // (usada na validação da hora de fim) deixaria de ser cronológica.
  return `${String(m[1]).padStart(2, '0')}:${String(m[2]).padStart(2, '0')}`;
}

// Valida a data no formato YYYY-MM-DD. Devolve '' se ausente, null se
// inválida. Verifica também a coerência do calendário (2026-02-30 é
// rejeitado), sem construir um `Date` — em UTC, um `Date` deslocaria o dia.
function normalizarData(valor) {
  const bruto = String(valor == null ? '' : valor).trim();
  if (!bruto) return '';
  const m = RE_DATA.exec(bruto);
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1) return null;
  // Dias de cada mês, com o fevereiro bissexto calculado à mão (regra
  // gregoriana: divisível por 4, excepto os séculos não divisíveis por 400).
  const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
  const diasMes = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (dia > diasMes[mes - 1]) return null;
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Lê e valida o formulário. Devolve `{ valores, erros }`: `valores` é o que
// se guarda (ou o que se volta a mostrar), `erros` são mensagens humanas.
// Validação mínima deliberada (título + data são os campos obrigatórios);
// tudo o resto é opcional, como o modelo.
function lerFormulario(body) {
  const b = body || {};
  const titulo = String(b.titulo == null ? '' : b.titulo).trim();
  const descricao = String(b.descricao == null ? '' : b.descricao).trim();
  const local = String(b.local == null ? '' : b.local).trim();

  const data = normalizarData(b.data);
  const hora = normalizarHora(b.hora);
  const horaFim = normalizarHora(b.hora_fim);

  const erros = [];

  if (!titulo) erros.push('O título é obrigatório.');
  else if (titulo.length > 255) erros.push('O título não pode exceder 255 caracteres.');

  if (data === '') erros.push('A data é obrigatória.');
  else if (data === null) erros.push('A data não é válida.');

  if (hora === null) erros.push('A hora não é válida (use o formato HH:MM).');
  if (horaFim === null) erros.push('A hora de fim não é válida (use o formato HH:MM).');

  // Uma hora de fim sem hora de início não faz sentido; e a hora de fim tem
  // de ser posterior. A comparação é entre strings 'HH:MM' normalizadas, o
  // que é ordem cronológica correta (mesmo comprimento, zeros à esquerda).
  if (horaFim && !hora && !erros.some((e) => e.startsWith('A hora não'))) {
    erros.push('Indique a hora de início antes da hora de fim.');
  }
  if (hora && horaFim && horaFim <= hora) {
    erros.push('A hora de fim tem de ser posterior à hora de início.');
  }

  return {
    valores: {
      titulo,
      descricao: descricao || null,
      data: data || '',
      hora: hora || null,
      hora_fim: horaFim || null,
      local: local || null,
    },
    erros,
  };
}

// Carrega um evento do condomínio ativo. A chave de isolamento faz parte da
// cláusula `where`: um id de outro condomínio simplesmente não é encontrado.
async function carregarEvento(req) {
  return Evento.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
  });
}

// ── Formulário de criação ───────────────────────────────────────────
router.get('/calendario/eventos/nova', (req, res) => {
  return res.render('admin/eventos/form', {
    titulo: 'Novo evento',
    evento: { data: toDateInput(new Date()) },
    erros: [],
    acao: '/admin/calendario/eventos',
  });
});

// ── Criar ───────────────────────────────────────────────────────────
router.post('/calendario/eventos', async (req, res) => {
  const { valores, erros } = lerFormulario(req.body);

  if (erros.length) {
    req.flash('error_msg', erros[0]);
    return res.render('admin/eventos/form', {
      titulo: 'Novo evento',
      evento: valores,
      erros,
      acao: '/admin/calendario/eventos',
    });
  }

  try {
    const criado = await Evento.create({
      ...valores,
      // Isolamento: o condomínio vem SEMPRE da sessão, nunca do formulário.
      condominio_id: req.condominioId,
      created_by: req.user ? req.user.id : null,
    });
    await audit({
      userId: req.user ? req.user.id : null,
      acao: 'criar_evento',
      entidade: 'Evento',
      entidadeId: criado.id,
      detalhes: { condominioId: req.condominioId, data: criado.data },
    });
    req.flash('success_msg', 'Evento criado.');
    return res.redirect('/admin/calendario');
  } catch (err) {
    console.error('[eventos] erro ao criar:', err);
    req.flash('error_msg', 'Não foi possível criar o evento.');
    return res.render('admin/eventos/form', {
      titulo: 'Novo evento',
      evento: valores,
      erros: [],
      acao: '/admin/calendario/eventos',
    });
  }
});

// ── Editar (formulário) ─────────────────────────────────────────────
router.get('/calendario/eventos/:id/editar', async (req, res) => {
  const evento = await carregarEvento(req);
  if (!evento) {
    req.flash('error_msg', 'Evento não encontrado.');
    return res.redirect('/admin/calendario');
  }
  return res.render('admin/eventos/form', {
    titulo: 'Editar evento',
    evento: evento.toJSON(),
    erros: [],
    acao: `/admin/calendario/eventos/${evento.id}`,
  });
});

// ── Atualizar ───────────────────────────────────────────────────────
router.post('/calendario/eventos/:id', async (req, res) => {
  const evento = await carregarEvento(req);
  if (!evento) {
    req.flash('error_msg', 'Evento não encontrado.');
    return res.redirect('/admin/calendario');
  }

  const { valores, erros } = lerFormulario(req.body);

  if (erros.length) {
    req.flash('error_msg', erros[0]);
    return res.render('admin/eventos/form', {
      titulo: 'Editar evento',
      evento: { ...evento.toJSON(), ...valores, id: evento.id },
      erros,
      acao: `/admin/calendario/eventos/${evento.id}`,
    });
  }

  try {
    await evento.update(valores);
    await audit({
      userId: req.user ? req.user.id : null,
      acao: 'editar_evento',
      entidade: 'Evento',
      entidadeId: evento.id,
      detalhes: { condominioId: req.condominioId, data: evento.data },
    });
    req.flash('success_msg', 'Evento atualizado.');
    return res.redirect('/admin/calendario');
  } catch (err) {
    console.error('[eventos] erro ao atualizar:', err);
    req.flash('error_msg', 'Não foi possível guardar as alterações.');
    return res.render('admin/eventos/form', {
      titulo: 'Editar evento',
      evento: { ...evento.toJSON(), ...valores, id: evento.id },
      erros: [],
      acao: `/admin/calendario/eventos/${evento.id}`,
    });
  }
});

// ── Eliminar ────────────────────────────────────────────────────────
// POST (como em documentos e fornecedores): nunca uma rota GET que apaga.
router.post('/calendario/eventos/:id/eliminar', async (req, res) => {
  const evento = await carregarEvento(req);
  if (evento) {
    await evento.destroy();
    await audit({
      userId: req.user ? req.user.id : null,
      acao: 'eliminar_evento',
      entidade: 'Evento',
      entidadeId: evento.id,
      detalhes: { condominioId: req.condominioId, data: evento.data },
    });
    req.flash('success_msg', 'Evento eliminado.');
  } else {
    req.flash('error_msg', 'Evento não encontrado.');
  }
  return res.redirect('/admin/calendario');
});

module.exports = router;
