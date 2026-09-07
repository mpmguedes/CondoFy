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
npm run db:migrate        # executa 056 → 059
```

Ordem e propósito:

| Migração | Conteúdo |
| --- | --- |
| `…056-multitenant-foundation` | `users.role_global` (super_admin), `email_confirmado(+at)`, `telefone`, convites; `condominios.estado`; tabela `utilizador_condominios` (papel admin/gestor/leitura + estado, índice único utilizador+condomínio); `condominio_id` em **13 tabelas de negócio** com **backfill** para o condomínio existente; utilizadores atuais associados (role `admin` → papel `admin` + `super_admin`; restantes → papel `leitura`). |
| `…057-two-factor-email` | 2FA por email: `two_fa_ativo/metodo/codigo_hash/codigo_expira/tentativas/recovery_hash` em `users`. |
| `…058-documento-pastas-custom` | `condominios.documento_pastas` (JSON das pastas personalizadas da biblioteca). |
| `…059-documento-categorias` | Enum `categorias.tipo` + `documento` e tabela `documento_categorias` (M2M Documento↔Categoria). |

Reverter (só se necessário, sempre com backup):
```bash
npm run db:migrate:undo   # uma migração de cada vez, da 059 para a 056
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
7. **2FA** em "Conta → Segurança": ativar com código recebido por email, ver códigos de
   recuperação uma única vez e fazer logout+login para testar o 2.º fator.
8. **Documentos**: criar pastas personalizadas (a pasta "Outros" é obrigatória) e
   associar categorias tipo "Documento" a um upload.

---

## 5. Notas de decisão (comportamento atual)

- **Dados-mestre partilhados do operador**: categorias, fornecedores, métodos de
  pagamento, configuração SMTP/Drive — sem `condominio_id` (decisão documentada).
- **Eliminação de condomínio** (Super Admin): requer estado `inativo` e confirmação
  `ELIMINAR`; remove as linhas das tabelas de negócio com `condominio_id` (as tabelas
  de junção como `pagamento_quotas`/`recibo_quotas`/`documento_categorias` ficam
  órfãs — simplificação conhecida).
- **Autorização**: os módulos usam o papel **por condomínio ativo** (`comPapel`
  admin/gestor) e o Super Admin em suporte tem papel `admin`.

---

## 6. Validação automática (sem BD)

```bash
node scripts/check-templates.js
node scripts/test-vistas.js
node scripts/test-isolamento.js
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
node scripts/test-storage.js
```

Todas devem terminar com `✓`.
