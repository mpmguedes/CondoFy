# GesCondu — Multi-condomínio/SaaS: guia de migração e validação

Este documento descreve os passos a executar no **servidor** (com MariaDB ligado)
para aplicar a evolução multi-condomínio. Nenhuma migração foi executada em
desenvolvimento (ambiente sem BD) — é obrigatório correr `npm run db:migrate`.

---

## 1. Backup primeiro

```bash
# MariaDB
mysqldump -u <utilizador> -p <base> > condofy_pre_saas_$(date +%Y%m%d_%H%M%S).sql
```

---

## 2. Aplicar as migrações (por ordem)

```bash
cd <caminho_do_projeto>
npm run db:migrate        # executa 056 → 063
```

Ordem e propósito:

| Migração | Conteúdo |
| --- | --- |
| `…056-multitenant-foundation` | `users.role_global` (super_admin), `email_confirmado(+at)`, `telefone`, convites; `condominios.estado`; tabela `utilizador_condominios` (papel admin/gestor/leitura + estado, índice único utilizador+condomínio); `condominio_id` em **13 tabelas de negócio** com **backfill** para o condomínio existente; utilizadores atuais associados (role `admin` → papel `admin` + `super_admin`; restantes → papel `leitura`). |
| `…057-two-factor-email` | 2FA por email: `two_fa_ativo/metodo/codigo_hash/codigo_expira/tentativas/recovery_hash` em `users`. |
| `…058-documento-pastas-custom` | `condominios.documento_pastas` (JSON das pastas personalizadas da biblioteca). |
| `…059-documento-categorias` | Enum `categorias.tipo` + `documento` e tabela `documento_categorias` (M2M Documento↔Categoria). |
| `…060-two-factor-totp` | 2FA — opção Aplicação autenticadora (TOTP RFC 6238): coluna `users.two_fa_totp_secret` (Base32) e enum `two_fa_metodo` com `'totp'`. |
| `…061-classificar-documentos` | Classificação central dos documentos (tipo → pasta lógica via `resolverPastaDocumento`) e reclassificação dos registos existentes; aditiva. |
| `…062-documento-disponivel-condominos` | `documentos.disponivel_condominos` (default `0`): visibilidade na área do Condómino; convocatórias/atas/assembleias ficam disponíveis automaticamente. |
| `…063-add-condominio-drive-folder` | `condominios.drive_folder_id`: pasta raiz do condomínio no Google Drive (árvore `<raiz>/<Condomínio>/<ano>/…`). **Aditiva** — ficheiros antigos não são movidos. |
| `…064-email-fila-condominio` | `email_fila.condominio_id` (persistido na criação) — a Central de Emails/contagens/ações passam a ser por condomínio. Backfill por relações inequívocas (documento/aviso/entidade com `condominio_id`); sem relação ou conflito → `NULL` (órfão, nunca listado nos condomínios). |
| `…065-fornecedor-condominio` | `fornecedores.condominio_id` — cada condomínio tem a sua lista. Backfill só quando TODAS as provas (despesas/documentos/pagamentos) apontam para o mesmo condomínio; ambíguos/globais ficam `NULL` (fora das listas; decisão manual de migração no relatório). |
| `…066-pagamento-fornecedor-condominio` | `pagamentos_fornecedores.condominio_id` (cadeia Fornecedor → Pagamento → Documento coerente). Backfill via fornecedor/comprovativo/despesa; sem relação → `NULL`. |

Reverter (só se necessário, sempre com backup):
```bash
npm run db:migrate:undo   # uma migração de cada vez, da 066 para a 056
```

---

## 3. Variáveis de ambiente relevantes (novas)

| Variável | Efeito |
| --- | --- |
| `CONVITE_VALIDADE_DIAS` | Validade dos convites (default `30`). |
| `STORAGE_PROVIDER` | Provedor de armazenamento (default `google_drive`; a fachada `helpers/storage` usa o Google Drive hoje). |

---

## 4. Pós-migração — checklist de validação

1. **Login dos utilizadores atuais** continua a funcionar (contas com `email_confirmado=1`
   e associação `utilizador_condominios` criada pelo backfill).
2. **Fluxo LOGIN → "Os meus condomínios"** mostra o(s) condomínio(s) e permite entrar;
   o seletor de condomínio aparece na sidebar.
3. **Dados preservados**: quotas, FIFO/pagamentos, comprovativos, recibos/PDFs e Drive
   continuam visíveis no mapa de Quotas, Comprovativos e Recibos.
4. **Super Admin global** (`/admin/global`) — gerir condomínios/associações/auditoria.
5. **Criar um 2.º condomínio (Super Admin)** e confirmar o **isolamento**:
   - criar uma fração/documento/pagamento no novo condomínio;
   - verificar que **não aparece** no primeiro condomínio (e vice-versa).
6. **Convite** ("Novo utilizador" com "Enviar convite por email") → o destinatário abre
   `/aceitar-convite/<token>`, define palavra-passe e entra (confirmação de email).
7. **2FA** em "Conta → Segurança": ativar com código recebido por email **ou** com aplicação
   autenticadora (TOTP, com QR Code), ver códigos de recuperação uma única vez e fazer
   logout+login para testar o 2.º fator.
8. **Documentos**: criar pastas personalizadas (a pasta "Outros" é obrigatória) e
   associar categorias tipo "Documento" a um upload.

---

## 5. Notas de decisão (comportamento atual)

- **Dados-mestre partilhados do operador**: categorias, métodos de pagamento,
  configuração SMTP e infraestrutura Google Drive — sem `condominio_id`
  (decisão documentada). **Fornecedores, pagamentos a fornecedores e a fila de
  emails deixaram de ser partilhados**: passam a ter `condominio_id`
  (migrações 064–066) e vivem dentro do condomínio ativo.
- **Eliminação de condomínio** (Super Admin): requer estado `inativo` e confirmação
  `ELIMINAR`; remove as linhas das tabelas de negócio com `condominio_id` (as tabelas
  de junção como `pagamento_quotas`/`recibo_quotas`/`documento_categorias` ficam
  órfãs — simplificação conhecida).
- **Autorização**: os módulos usam o papel **por condomínio ativo** (`comPapel`
  admin/gestor) e o Super Admin em suporte tem papel `admin`.

---

## 6. Google Drive por condomínio + SMTP contextual (migração 063)

A infraestrutura continua **partilhada** (uma conta Google Drive, um SMTP, uma BD),
mas a árvore física do Drive passa a ser **por condomínio**:

```text
<raiz da empresa>/
├── Backups/                 ← global (infraestrutura)
├── <Condomínio A>/          ← nome amigável (designação), nunca o id
│   └── 2026/{Assembleias,Quotas,Recibos,Despesas,Contratos,Outros,
│            Fornecedores/<nome>/Comprovativos}
└── <Condomínio B>/…
```

Pontos-chave após aplicar a migração e reiniciar (`systemctl restart condofy.service`):

- **Ficheiros antigos NÃO são movidos** (decisão explícita). Os `Documento` continuam a
  apontar para os `drive_file_id` existentes em `<raiz>/<ano>/…`; a reorganização
  histórica é uma tarefa futura separada.
- **Novos ficheiros** (documentos manuais, recibos, avisos/quotas, atas/convocatórias,
  comprovativos de fornecedores) passam a ir para a árvore do condomínio ativo. A pasta
  do condomínio é criada no primeiro upload e o id fica registado em
  `condominios.drive_folder_id` (resolução por `condominio_id`, nunca por nomes).
- **Botão "Abrir pasta no Drive"** (Documentos → biblioteca): resolve a pasta do
  condomínio ativo no servidor e abre-a no Google Drive (o utilizador não precisa de saber
  o `folderId`). O botão "Criar estrutura" da Configuração cria a árvore do condomínio
  ativo (a pasta `Backups` é sempre global).
- **Condomínios inativos**: não criam pastas novas; pastas existentes não são apagadas.
- **Fornecedores**: cada condomínio tem a sua lista (`fornecedores.condominio_id`,
  migração 065) e os comprovativos são documentos do condomínio — o ficheiro físico
  fica na árvore desse condomínio.
- **SMTP / remetente**: configuração SMTP continua global. Prioridade do nome visível do
  remetente: `displayName` explícito → `smtp_from_name` explícito → **contexto do
  condomínio** (quando conhecido: convites, recibos, avisos, documentos, fornecedores) →
  `GesCondu`. Nunca usa "o primeiro condomínio da BD". O contexto é persistido na própria
  fila (`email_fila.condominio_id`, migração 064) — no processamento posterior já não se
  depende de relações indiretas.

---

## 7. Isolamento de Emails e Fornecedores (migrações 064–066)

- **Central de Emails por condomínio**: a listagem, os filtros (estado/origem), as
  contagens e as ações (reenviar/cancelar) filtram `email_fila.condominio_id` = condomínio
  ativo. Registos históricos sem `condominio_id` (órfãos/ambíguos) **não aparecem em
  nenhuma área de condomínio** — não são inventados nem atribuídos ao "primeiro
  condomínio". O scheduler continua global (infraestrutura) e envia os itens pendentes de
  todos os condomínios com o remetente do condomínio persistido.
- **Fornecedores por condomínio**: listar/criar/editar/eliminar/detalhe, despesas,
  pagamentos, comprovativos, emails e os dropdowns de despesas usam
  `fornecedores.condominio_id`/`pagamentos_fornecedores.condominio_id` = ativo. Aceder por
  id a um registo de outro condomínio devolve "não encontrado" (404/redirect).
- **Histórico**: só recebeu `condominio_id` o que era inequívoco (todas as relações com o
  mesmo condomínio). Fornecedores partilhados/ambíguos ficaram `NULL` e **não são
  listados** — exigem decisão manual (estratégia segura no relatório de implementação);
  nada foi movido/eliminado.

---

## 8. Validação automática (sem BD)

```bash
node scripts/check-templates.js
node scripts/test-vistas.js
node scripts/test-isolamento.js
node scripts/test-multitenant-emails-fornecedores.js
node scripts/test-seguranca.js
node scripts/test-convites.js
node scripts/test-2fa.js
node scripts/test-financeiro.js
node scripts/test-quotas-modulo.js
node scripts/test-contactos.js
node scripts/test-comunicacoes.js
node scripts/test-convocatoria.js
node scripts/test-background.js
node scripts/test-documento-pastas.js
node scripts/test-drive-pastas.js
node scripts/test-storage.js
```

Todas devem terminar com `✓`.
