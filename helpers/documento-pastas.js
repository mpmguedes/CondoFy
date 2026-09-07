// ─────────────────────────────────────────────────────────────────────
// Pastas da biblioteca de documentos — base + personalizadas por condomínio.
// A pasta "outros" é obrigatória (parte da base) e nunca pode ser apagada.
// ─────────────────────────────────────────────────────────────────────

// Pastas base (estáticas) — "outros" é obrigatória.
const PASTAS_BASE = {
  atas: 'Atas',
  convocatorias: 'Convocatórias',
  contratos: 'Contratos',
  regulamentos: 'Regulamentos',
  recibos: 'Recibos de Pagamento',
  assembleias: 'Assembleias',
  apolices: 'Seguros — Apólices',
  comprovativos: 'Seguros — Comprovativos',
  faturas: 'Faturas',
  outros: 'Outros',
};

// Lê e valida a lista de pastas personalizadas guardada no condomínio
// (JSON: [{key,nome}]). Nunca devolve inválido; pastas sem key/nome são
// ignoradas.
function pastasPersonalizadas(condominioRow) {
  const bruto = condominioRow && condominioRow.documento_pastas;
  if (!bruto) return [];
  try {
    const arr = JSON.parse(bruto);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && typeof p.key === 'string' && p.key && typeof p.nome === 'string' && p.nome.trim())
      .map((p) => ({ key: p.key, nome: p.nome.trim() }));
  } catch (err) {
    return [];
  }
}

// Mapa completo key → nome (base + personalizadas). "outros" garantida.
function mapaPastas(condominioRow, extra = {}) {
  const mapa = { ...PASTAS_BASE, ...extra };
  for (const p of pastasPersonalizadas(condominioRow)) {
    if (!(p.key in mapa)) mapa[p.key] = p.nome;
  }
  return mapa;
}

function slugificar(nome) {
  const mapa = { á: 'a', à: 'a', ã: 'a', â: 'a', é: 'e', è: 'e', ê: 'e', í: 'i', ó: 'o', ô: 'o', õ: 'o', ú: 'u', ç: 'c' };
  return String(nome)
    .toLowerCase()
    .replace(/[áàãâéèêíóôõúç]/g, (ch) => mapa[ch] || ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pasta';
}

// Gera uma key única para uma nova pasta personalizada.
function novaKey(nome, existentes) {
  const base = slugificar(nome);
  let key = `c-${base}`;
  let i = 2;
  while (existentes.has(key)) {
    key = `c-${base}-${i}`;
    i += 1;
  }
  return key;
}

// ═════════════════════════════════════════════════════════════════════
// Classificação automática (pasta) a partir do TIPO do documento.
// Usada ao criar documentos e no backfill de documentos antigos.
// ═════════════════════════════════════════════════════════════════════

// Pasta por omissão por tipo (regras desta ronda; "outros" nunca é criada de
// raiz para tipos com pasta específica).
const PASTA_POR_TIPO = {
  recibo: 'recibos',
  ata: 'atas',
  convocatoria: 'convocatorias',
  fatura: 'faturas',
  contrato: 'contratos',
  comprovativo: 'comprovativos',
  aviso_quota: 'outros',
  orcamento: 'outros',
  relatorio: 'outros',
};

// Pastas consideradas COMPATÍVEIS com cada tipo (além da de omissão).
// "outros" é sempre compatível (pasta obrigatória/catch-all).
const PASTAS_COMPATIVEIS_POR_TIPO = {
  ata: ['atas', 'assembleias'],
  convocatoria: ['convocatorias', 'assembleias'],
  fatura: ['faturas'],
  contrato: ['contratos'],
  comprovativo: ['comprovativos'],
  recibo: ['recibos'],
  aviso_quota: ['outros'],
  orcamento: ['outros'],
  relatorio: ['outros'],
};

// Resolve a pasta final de um documento.
//  - tipo: tipo do documento (ex.: 'recibo', 'ata', 'outro').
//  - pastaEscolhida: pasta submetida/atual (key válida ou null/vazia).
//  - pastasValidas: conjunto de keys válidas (base + personalizadas do
//    condomínio) para validar escolhas; uma escolha válida e compatível é
//    respeitada (nunca sobrescrevemos uma escolha explícita sem motivo).
// Devolve { pasta, corrigida, motivo? } — corrigida=true quando a pasta foi
// automaticamente alterada para um valor previsível.
function resolverPastaDocumento({ tipo, pastaEscolhida, pastasValidas = [] } = {}) {
  const chaveTipo = String(tipo || 'outro');
  const padrao = PASTA_POR_TIPO[chaveTipo] || 'outros';
  const escolhida = typeof pastaEscolhida === 'string' ? pastaEscolhida.trim() : '';

  if (!escolhida || !pastasValidas.includes(escolhida)) {
    // Sem escolha ou escolha inválida → regra automática pelo tipo.
    return { pasta: padrao, corrigida: Boolean(escolhida), motivo: escolhida ? 'pasta inválida — usada a pasta do tipo' : 'sem pasta — usada a pasta do tipo' };
  }

  // Escolha válida: "outros" aceita tudo; tipos sem mapa aceitam qualquer
  // pasta válida (respeita a escolha explícita do utilizador).
  if (chaveTipo === 'outro' || !PASTA_POR_TIPO[chaveTipo] || escolhida === 'outros' || (PASTAS_COMPATIVEIS_POR_TIPO[chaveTipo] || []).includes(escolhida)) {
    return { pasta: escolhida, corrigida: false };
  }

  // Escolha válida mas incompatível com o tipo → correção automática
  // previsível para a pasta do tipo (documentada no motivo).
  return { pasta: padrao, corrigida: true, motivo: `pasta "${escolhida}" incompatível com o tipo — movido para "${padrao}"` };
}

module.exports = {
  PASTAS_BASE,
  PASTAS_COMPATIVEIS_POR_TIPO,
  PASTA_POR_TIPO,
  pastasPersonalizadas,
  mapaPastas,
  slugificar,
  novaKey,
  resolverPastaDocumento,
};
