// ─────────────────────────────────────────────────────────────────────
// Convocatórias — Nova Convocatória (interface → pré-visualização → PDF)
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Op } = require('sequelize');
const { Assembleia } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { getCondominio } = require('../helpers/condominio');
const { audit } = require('../helpers/audit');
const {
  construirDocumento,
  normalizarPontos,
  hojeInput,
  parseHora,
} = require('../helpers/convocatoria');
const { gerarConvocatoriaCartaPDF } = require('../helpers/pdf-convocatoria');

const router = express.Router();
router.use(eAdmin);

function strB(v) {
  return v == null ? '' : String(v).trim();
}

function toArrayBruto(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

// "Convocatória Geral" → "convocatoria-geral" (para o nome do ficheiro)
function slug(v) {
  const mapa = {
    á: 'a', à: 'a', ã: 'a', â: 'a', ä: 'a',
    é: 'e', è: 'e', ê: 'e', ë: 'e',
    í: 'i', ì: 'i', î: 'i', ï: 'i',
    ó: 'o', ò: 'o', õ: 'o', ô: 'o', ö: 'o',
    ú: 'u', ù: 'u', û: 'u', ü: 'u',
    ç: 'c', ñ: 'n',
  };
  const s = String(v || '')
    .toLowerCase()
    .replace(/[áàãâäéèêëíìîïóòõôöúùûüçñ]/g, (ch) => mapa[ch] || ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'convocatoria';
}

// Próximo número de reunião sugerido (ex.: "2026/3") — apenas sugestão.
async function proximoNumero() {
  try {
    const ano = new Date().getFullYear();
    const ultima = await Assembleia.findOne({
      where: { numero: { [Op.like]: `${ano}/%` } },
      order: [['id', 'DESC']],
    });
    if (!ultima || !ultima.numero) return `${ano}/1`;
    const n = parseInt(String(ultima.numero).split('/')[1], 10) || 0;
    return `${ano}/${n + 1}`;
  } catch (err) {
    return `${new Date().getFullYear()}/1`;
  }
}

// Valores por omissão do formulário (dados do condomínio + sugestões).
function valoresPorOmissao(c, numeroSugerido) {
  const hoje = hojeInput();
  return {
    edificio_nome: c.designacao || '',
    morada: c.morada || '',
    codigo_postal: c.codigo_postal || '',
    cidade: c.localidade || '',
    administracao_nome: c.administracao_nome || '',
    reuniao_numero: numeroSugerido,
    tipo: 'ordinaria',
    data: hoje,
    hora: '',
    local: '',
    data_emissao: hoje,
    email_autorizado: false,
    pontos: [],
  };
}

// Valores vindos do formulário (post/preview) — nunca perde o que o
// utilizador escreveu.
function valoresDoFormulario(body) {
  return {
    edificio_nome: strB(body.edificio_nome),
    morada: strB(body.morada),
    codigo_postal: strB(body.codigo_postal),
    cidade: strB(body.cidade),
    administracao_nome: strB(body.administracao_nome),
    reuniao_numero: strB(body.reuniao_numero),
    tipo: ['ordinaria', 'extraordinaria', 'urgencia'].includes(body.tipo) ? body.tipo : 'ordinaria',
    data: String(body.data || '').slice(0, 10),
    hora: strB(body.hora),
    local: strB(body.local),
    data_emissao: String(body.data_emissao || hojeInput()).slice(0, 10),
    email_autorizado: body.email_autorizado === 'on' || body.email_autorizado === '1' || body.email_autorizado === true,
    pontos: toArrayBruto(body.pontos),
  };
}

// Validação mínima antes de gerar o PDF.
function validar(v) {
  const problemas = [];
  if (!v.edificio_nome) problemas.push('Indique o nome do edifício.');
  if (!v.cidade) problemas.push('Indique a cidade do condomínio.');
  if (!v.data) problemas.push('Indique a data da reunião.');
  if (!parseHora(v.hora)) problemas.push('Indique a hora da primeira convocatória (formato HH:MM).');
  if (!v.local) problemas.push('Indique o local da reunião.');
  return problemas;
}

// ── Página de criação ───────────────────────────────────────────────
router.get('/convocatorias', (req, res) => res.redirect('/admin/convocatorias/nova'));

router.get('/convocatorias/nova', async (req, res) => {
  const cond = await getCondominio();
  const c = cond ? cond.toJSON() : {};
  const numero = await proximoNumero();
  res.render('admin/convocatorias/nova', {
    titulo: 'Nova Convocatória',
    valores: valoresPorOmissao(c, numero),
    previa: null,
  });
});

// ── Ações do formulário (pré-visualizar / voltar à edição / gerar PDF)
router.post('/convocatorias', async (req, res) => {
  const acao = strB(req.body._acao) || 'preview';
  const valores = valoresDoFormulario(req.body);

  const doc = construirDocumento({
    edificioNome: valores.edificio_nome,
    morada: valores.morada,
    codigoPostal: valores.codigo_postal,
    cidade: valores.cidade,
    administracaoNome: valores.administracao_nome,
    numero: valores.reuniao_numero,
    tipo: valores.tipo,
    data: valores.data,
    hora: valores.hora,
    local: valores.local,
    dataEmissao: valores.data_emissao,
    emailAutorizado: valores.email_autorizado,
    pontos: normalizarPontos(valores.pontos),
  });

  const base = {
    titulo: 'Nova Convocatória',
    valores,
    previa: acao === 'preview' ? doc : null,
  };

  if (acao === 'pdf') {
    const problemas = validar(valores);
    if (problemas.length) {
      problemas.forEach((p) => req.flash('error_msg', p));
      return res.render('admin/convocatorias/nova', base);
    }

    const cond = await getCondominio();
    const buffer = await gerarConvocatoriaCartaPDF(cond ? cond.toJSON() : {}, doc);

    try {
      await audit({
        userId: req.user.id,
        acao: 'gerar_convocatoria',
        entidade: 'Assembleia',
        detalhes: { numero: valores.reuniao_numero, tipo: valores.tipo, data: valores.data },
      });
    } catch (err) {
      // auditoria é auxiliar — nunca impede a geração do documento
    }

    const refSlug = slug(valores.reuniao_numero || valores.data || doc.tipoLabel);
    const nomeFicheiro = ['convocatoria', slug(doc.tipoLabel), refSlug !== 'convocatoria' ? refSlug : '']
      .filter(Boolean)
      .join('-');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeFicheiro}.pdf"`);
    return res.send(buffer);
  }

  // 'editar' → volta ao editor com os dados introduzidos (sem pré-visualização)
  res.render('admin/convocatorias/nova', { ...base, previa: null });
});

module.exports = router;
