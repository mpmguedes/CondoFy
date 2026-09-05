// ─────────────────────────────────────────────────────────────────────
// Automações de documentos — comportamento automático por tipo de
// documento quando o GesCondu gera/regista um documento.
//
// Por cada tipo guarda-se na BD (chaves `auto_<tipo>_<canal>`):
//  · drive      → guardar automaticamente no Google Drive (0/1)
//  · email      → disponibilizar para envio por email (0/1, informativo)
//  · automatico → enviar automaticamente por email quando aplicável (0/1)
//
// Regra de segurança: NADA é enviado/guardado automaticamente sem
// configuração explícita ('1'). O padrão é tudo desligado, exceto o que
// já era o comportamento da aplicação (ex.: backups com Drive ligado).
// ─────────────────────────────────────────────────────────────────────
const { getConfig, setConfig } = require('./config');

const CATEGORIAS = {
  assembleias: 'ASSEMBLEIAS',
  financeiro: 'FINANCEIRO',
  comunicacao: 'COMUNICAÇÃO',
  documentos: 'DOCUMENTOS',
  fornecedores: 'FORNECEDORES',
  backups: 'BACKUPS',
};

// Tipo → { categoria, rotulo }
const TIPOS = {
  quotas: { categoria: 'financeiro', rotulo: 'Quotas (avisos de quota)' },
  recibos: { categoria: 'financeiro', rotulo: 'Recibos' },
  avisos_pagamento: { categoria: 'financeiro', rotulo: 'Avisos de pagamento' },
  convocatorias: { categoria: 'assembleias', rotulo: 'Convocatórias de assembleia' },
  atas: { categoria: 'assembleias', rotulo: 'Atas' },
  orcamentos: { categoria: 'financeiro', rotulo: 'Orçamentos' },
  despesas: { categoria: 'financeiro', rotulo: 'Despesas' },
  documentos_gerais: { categoria: 'documentos', rotulo: 'Documentos gerais' },
  documentos_fornecedores: { categoria: 'fornecedores', rotulo: 'Documentos de fornecedores' },
  comprovativos_pagamento: { categoria: 'fornecedores', rotulo: 'Comprovativos de pagamento' },
  backups: { categoria: 'backups', rotulo: 'Backups' },
};

// Padrões (comportamento atual da aplicação):
//  · email='1' para tipos que já são sempre disponibilizados/enváveis;
//  · drive/automatico desligados por omissão (nada automático sem decisão).
const DEFAULT_EMAIL = { quotas: '1', recibos: '1', convocatorias: '1', atas: '1', avisos_pagamento: '1', backups: '1' };
const DEFAULT_DRIVE = { backups: '1' }; // com Drive ligado, backups já vão para o Drive
const DEFAULT_AUTO = {};

function canalPadrao(tipo, canal) {
  if (canal === 'email') return DEFAULT_EMAIL[tipo] === '1';
  if (canal === 'drive') return DEFAULT_DRIVE[tipo] === '1';
  if (canal === 'automatico') return DEFAULT_AUTO[tipo] === '1';
  return false;
}

async function estaAtivo(tipo, canal) {
  if (!TIPOS[tipo] || !['drive', 'email', 'automatico'].includes(canal)) return false;
  const chave = `auto_${tipo}_${canal}`;
  const v = await getConfig(chave, null);
  if (v === null) return canalPadrao(tipo, canal);
  return v === '1';
}

// Lista agrupada por categoria, com os estados atuais — para a interface.
async function listarAutomacoes() {
  const grupos = Object.keys(CATEGORIAS).map((cat) => ({ categoria: cat, rotulo: CATEGORIAS[cat], tipos: [] }));
  const porCat = Object.fromEntries(grupos.map((g) => [g.categoria, g]));
  for (const [tipo, def] of Object.entries(TIPOS)) {
    porCat[def.categoria].tipos.push({
      tipo,
      rotulo: def.rotulo,
      drive: await estaAtivo(tipo, 'drive'),
      email: await estaAtivo(tipo, 'email'),
      automatico: await estaAtivo(tipo, 'automatico'),
    });
  }
  return grupos.filter((g) => g.tipos.length);
}

// Grava as opções do formulário (auto_<tipo>_<canal> = '1'/'0').
async function guardarAutomacoes(body) {
  let alteradas = 0;
  for (const tipo of Object.keys(TIPOS)) {
    for (const canal of ['drive', 'email', 'automatico']) {
      const chave = `auto_${tipo}_${canal}`;
      const valor = body[chave] === 'on' || body[chave] === '1' ? '1' : '0';
      await setConfig(chave, valor);
      alteradas++;
    }
  }
  return { tipos: Object.keys(TIPOS).length, canais: 3, alteradas };
}

// Converte um tipo de documento lógico (Documento.tipo ou slug) na chave
// de automação correspondente (mapeamento usado nos módulos).
function tipoAutomacao(tipoDocumento) {
  const mapa = {
    aviso_quota: 'quotas',
    recibo: 'recibos',
    convocatoria: 'convocatorias',
    ata: 'atas',
    orcamento: 'orcamentos',
    fatura: 'despesas',
    contrato: 'documentos_fornecedores',
    comprovativo: 'comprovativos_pagamento',
    relatorio: 'documentos_gerais',
    outro: 'documentos_gerais',
  };
  return mapa[tipoDocumento] || tipoDocumento || 'documentos_gerais';
}

module.exports = { CATEGORIAS, TIPOS, estaAtivo, listarAutomacoes, guardarAutomacoes, tipoAutomacao };
