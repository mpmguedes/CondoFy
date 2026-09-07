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

module.exports = { PASTAS_BASE, pastasPersonalizadas, mapaPastas, slugificar, novaKey };
