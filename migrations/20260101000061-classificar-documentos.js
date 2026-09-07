'use strict';

// Backfill idempotente da classificação (pasta) dos documentos existentes.
// Regras iguais às de helpers/documento-pastas.resolverPastaDocumento (cópia
// propositada para a migração não depender de código da aplicação):
//   1. mantém uma pasta já válida (base atual OU pasta personalizada c-*);
//   2. sem pasta / pasta antiga incompatível → pasta por TIPO;
//   3. se nada se aplicar → 'outros' (obrigatória).
// Não apaga nem duplica documentos; não altera ficheiros no Drive.
// A operação é idempotente — pode correr mais do que uma vez sem efeitos.
module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;

    // Pasta por omissão por tipo (mesmas regras do helper da aplicação).
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
    // Pastas compatíveis além da de omissão (mantém também estas como válidas).
    const COMPATIVEIS = {
      ata: ['atas', 'assembleias'],
      convocatoria: ['convocatorias', 'assembleias'],
      comprovativo: ['comprovativos'],
    };
    const PASTAS_BASE_VALIDAS = [
      'atas', 'convocatorias', 'contratos', 'regulamentos', 'recibos',
      'assembleias', 'apolices', 'comprovativos', 'faturas', 'outros',
    ];

    function resolver(tipo, pasta) {
      const chave = String(tipo || 'outro');
      const escolhida = String(pasta || '').trim();
      // Personalizada ou já válida → mantém.
      if (escolhida.startsWith('c-')) return escolhida;
      if (escolhida && PASTAS_BASE_VALIDAS.includes(escolhida)) {
        const padrao = PASTA_POR_TIPO[chave] || 'outros';
        const compativeis = COMPATIVEIS[chave] || [];
        if (chave === 'outro' || escolhida === 'outros' || !padrao || compativeis.includes(escolhida)) return escolhida;
        return padrao; // escolha antiga/incompatível → pasta do tipo
      }
      return PASTA_POR_TIPO[chave] || 'outros';
    }

    const [linhas] = await db.query('SELECT id, pasta, tipo FROM documentos');
    let atualizados = 0;
    for (const linha of linhas) {
      const destino = resolver(linha.tipo, linha.pasta);
      if (destino !== linha.pasta) {
        await db.query('UPDATE documentos SET pasta = ?, updated_at = NOW() WHERE id = ?', {
          replacements: [destino, linha.id],
        });
        atualizados += 1;
      }
    }
    console.log(`[061] Documentos classificados (pasta): ${atualizados} atualizado(s).`);
  },

  // Não é possível reverter uma classificação de forma segura (no-op).
  async down() {
    return Promise.resolve();
  },
};
