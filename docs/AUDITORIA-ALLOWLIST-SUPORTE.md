# Auditoria funcional da allow-list do suporte `diagnostico`

**Commit auditado:** `18dec006c24d3dbb2371153e856c075b411c6709`
**Data:** 2026-09-18
**Âmbito:** auditoria funcional (read-only) — **nenhuma alteração de código foi feita**
**Natureza:** diagnóstico para decisão consciente antes da migration de produção

---

## 0. Como esta auditoria foi feita

Todos os dados abaixo vêm de **leitura do código real** e de **uma sonda de execução
read-only** que montou os routers verdadeiros com duplos sem BD, para medir o que o
contexto de suporte realmente alcança. A sonda foi eliminada no fim
(`scripts/auditoria-allowlist.tmp.js`) — `git status --short` confirma o working tree
sem ficheiros temporários.

Regra de decisão aplicada, do enunciado:

> O suporte diagnóstico pode ver **apenas o mínimo necessário para diagnosticar um
> problema**. Não é administrador do condomínio.

---

## 1. Allow-list atual — o que cada rota permite consultar

Ponto único de admissão: `routes/admin.js:116-132` (`soDiagnostico`), com
`CAMINHOS_SUPORTE_DIAGNOSTICO` em `routes/admin.js:91-97`. Valida **caminho** (lista
fechada) + **nível** (`comSuporte(['diagnostico'])`) + **método**
(`somenteLeitura` = GET/HEAD).

| # | Rota | Handler | O que consulta | O que a view imprime |
|---|---|---|---|---|
| 1 | `/` | `routes/admin.js:178` | Contagens (frações, pessoas, utilizadores), `getCondominio`, `resumoCondominio`, **todas as `Quota` não anuladas**, `BackupLog`, contagens de `EmailFila`, `Documento`, `Fornecedor`, `PagamentoFornecedor`, próximas `Assembleia`, comprovativos pendentes, registos de auditoria | Agregados financeiros (`{{eur resumo.saldoContas}}`, `{{eur emAtraso.total}}`), sinais de atenção, atividade recente |
| 2 | `/fracoes` | `routes/admin.js:385` | `Fracao` + `Pessoa` associadas | Designação, permilagem, **nomes dos proprietários** |
| 3 | `/fracoes/:id` | `routes/admin.js:686` | `Fracao` + `Pessoa`, **todas as `Quota`**, **todos os `Pagamento`** (+ método), **`Documento` da fração**, **`AvisoDestinatario`**, `resumoFracao` | **Nome/e-mail/telefone dos titulares**, permilagem, **valores de quotas e pagamentos**, último pagamento, estado de dívida |
| 4 | `/condominos` | `routes/admin.js:733` | `Pessoa` + `Fracao` associadas | Nome, **e-mail**, **telefone**, **NIF completo** |
| 5 | `/tarefas` | `routes/admin.js:1501` | `background.listarTarefas(100)` (estado em memória) | Nome da tarefa, estado, **texto de erro** (truncado a 260px) |

**Todo o `/condomino` está fechado** — confirmado por sonda: as 10 rotas testadas
(`/condomino`, `/perfil`, `/condominios`, `/documentos`, `/quotas`, `/saida`,
`/assembleias`, `/avisos`, `/orcamento`, `/recibos`) devolvem **302 → `/`** e
**zero eventos de auditoria** são escritos durante o acesso.

### 1.1 Dois achados que a auditoria anterior não tinha reportado

**(a) `/fracoes/:id` é muito mais rico do que «ficha de uma fração» sugere.**
O handler (`routes/admin.js:686-722`) carrega **quotas, pagamentos, documentos e
avisos** dessa fração — não apenas os dados cadastrais. O rótulo do commit anterior
(«ficha de uma fração») subestima a superfície: é, na prática, um dossiê financeiro
completo da fração.

**(b) O fecho do portal é por *prefixo partilhado*, não por guarda em cada módulo.**
Uma sonda isolada provou que `routes/condomino-conta.js` — montado no mesmo prefixo
`/condomino` (`app.js:291`) — **não tem guarda própria contra suporte**: o seu único
guarda é `if (res.locals.isAdmin) redirect('/')` (linhas 41-44), e `isAdmin` é
`false` para o suporte. Montado **isoladamente**, `GET /condomino/perfil` **chega ao
handler** (`res.render` em `condomino-conta.js:76`). Só não é alcançado porque
`routes/condomino.js` está montado **primeiro** (`app.js:286`) e o seu
`router.use(tenant.semSuporte)` (`routes/condomino.js:62`) fecha o prefixo antes.
O mesmo padrão vale para `saida-condominio.js` (protegido por `podeSair` exigir
associação real, não por guarda explícita). **A defesa é real, mas é composta e
frágil por acidente** — quem reordenar as montagens em `app.js` reabre o portal.

---

## 2. Problemas reais que o suporte precisa de diagnosticar

| Problema reportado | Informação necessária para diagnosticar | Disponível hoje em suporte? | Dados sensíveis? |
|---|---|---|---|
| Quota não aparece | Lista de quotas do condomínio/ano, estado, data de emissão | **Parcial** — só via `/fracoes/:id` (uma fração de cada vez); não há listagem global de quotas | Financeiro (valores) |
| Quota com valor incorreto | `valor_base`, `valor_fcr`, `valor_por_1000`, `permilagem_aplicada`, `fcr_percentagem`; grelha do ano | **Não** — esses campos só aparecem em `views/admin/quotas/detalhe.handlebars` | Financeiro |
| Pagamento não aparece | Lista de pagamentos, `numero_documento`, estado, data | **Parcial** — só via `/fracoes/:id` | Financeiro + PII (frações↔pessoas) |
| Recibo não foi gerado | `Recibo` (código, número, estado, `data_emissao`) | **Não** | Financeiro |
| Recibo não está disponível | Estado do ficheiro recibo / `Documento` associado | **Não** | Financeiro |
| Despesa não aparece | `Despesa` (descrição, valor, data, categoria, estado) | **Não** | Financeiro + fornecedor |
| Saldo/extrato parece incorreto | `MovimentoBancario`, conta-corrente por fração, `ContaBancaria` | **Parcial** — só o agregado do dashboard e `resumoFracao`; extrato detalhado não | Financeiro; IBAN na listagem de contas |
| Documento não aparece | `Documento` (nome, pasta, `disponivel_condominos`, `drive_status`) | **Parcial** — só os documentos de uma fração (`/fracoes/:id`); a biblioteca geral não | Nomes de documentos; `drive_file_id` (não impresso) |
| Documento não abre | `drive_status`, `drive_erro`, drive/storage configurado | **Não** — `drive_erro` não está em nenhuma view admitida | Técnico (mas não credenciais) |
| Assembleia/ata não aparece | `Assembleia`, `Convocatoria`, `Ata`, anexos | **Não** | PII (participantes), financeiro (FCR) |
| Votação | Deliberações da agenda, quórum | **Não** | PII |
| Orçamento | `Orcamento` + rubricas, distribuição por permilagem, estado | **Não** | Financeiro |
| Comunicação/aviso | `Aviso`, `AvisoDestinatario`, destinatários | **Parcial** — só os avisos de uma fração (`/fracoes/:id`) | PII (e-mails) |
| Tarefa | Tarefas em segundo plano, erros | **Sim** — `/tarefas` | Baixo |
| Configuração | `Condominio` (designação, NIF, IBAN, e-mail) | **Não** | PII + financeiro |
| Integração de armazenamento | Provedor ligado, `drive_status`, `BackupLog` | **Parcial** — contagem de docs guardados no dashboard; estado da ligação não | Credenciais (não expostas hoje) |
| E-mail | `EmailFila` (estado, erro, destinatário), SMTP configurado | **Parcial** — as contagens no dashboard; a Central de Emails não | PII (e-mails), técnico (erros SMTP) |

**Leitura da tabela:** as 5 rotas atuais cobrem bem o **cadastro** (frações, pessoas)
e a **saúde geral** (dashboard, tarefas). Cobrem mal o **financeiro** e o
**documental** — exatamente as áreas onde o suporte técnico é mais chamado. E o que
cobrem de financeiro está preso a *uma fração de cada vez*, o que não serve para
diagnosticar «as quotas do ano não foram geradas».

---

## 3. Módulos candidatos a read-only — análise por área

| Módulo | Rota de leitura candidata | Informação exposta | Dados pessoais? | Dados financeiros? | Segredos? | GET com efeitos laterais? | Seguro em diagnóstico? |
|---|---|---|---|---|---|---|---|
| **Quotas** | `financeiro.js:707` `/quotas`, `financeiro.js:829` `/quotas/grelha`, `financeiro.js:1242` `/quotas/:id` | Lista por ano/mês, valores, estado, permilagem aplicada | Indiretos (via fração) | **Sim** (valores) | Não | **Não** (leitura pura) | **Sim** — é o essencial do diagnóstico |
| **Pagamentos** | `financeiro.js:1306` `/pagamentos`, `financeiro.js:1596` `/pagamentos/:id` | Documento, valor, data, estado, método | Indiretos | **Sim** | Não | **Não** | **Sim** |
| **Recibos** | `financeiro.js:1893` `/pagamentos/:id/recibo` (PDF em memória), `quotas-modulo.js:509` `/quotas/recibos` | Recibo, estado de emissão | Indiretos | **Sim** | **`codigo_verificacao`** impresso em *title* (`recibos.handlebars:96`) | **Não** (buffer em memória) | **Parcial** — mascarar/omitir o código de verificação |
| **Despesas** | `financeiro.js:492` `/despesas` | Descrição, valor, data, categoria, fornecedor | Fornecedor (PJ) | **Sim** | Não | **Não** | **Sim** |
| **Extrato/movimentos** | `financeiro.js:382` `/movimentos`, `quotas-modulo.js:802` `/quotas/conta-corrente` | Movimentos, saldos, conta | Indiretos | **Sim**; `extrato.js:135` carrega **`iban`** (não impresso na view) | Não | **Não** | **Sim** com IBAN mascarado |
| **Contas bancárias** | `financeiro.js:118` `/contas` | Nome, banco, **`iban`**, saldo inicial | Não | **Sim** | Não | **Não** | **Parcial** — `contas/listar.handlebars:47` imprime IBAN completo |
| **Documentos** | `documentos.js:62` `/documentos` | Nome, pasta, tipo, data, visibilidade | Indiretos | Não | Não | **Não** | **Sim** (a biblioteca); **NÃO** `/documentos/:id/ficheiro` (audit + stream externo) nem `/documentos/drive/pasta` (cria pasta) |
| **Assembleias** | `assembleias.js:115` `/assembleias`, `assembleias.js:167` `/assembleias/:id`, `assembleias.js:524` `/assembleias/:id/ata` | Atas, agenda, participantes, quórum, FCR | **Sim** (participantes) | Sim (FCR) | Não | **`/assembleias/:id/convocatoria` (462) NÃO — faz upload + `Documento.create` + `update`** | **Parcial** — só listagem/detalhe; nunca o gerador de convocatória |
| **Votações/deliberações** | (dentro de `assembleias.js:319`) | Deliberações, resultados | PII | Não | Não | **Só POST** | **Parcial** — sem rota GET dedicada |
| **Orçamento** | `orcamento.js:73` `/orcamento`, `orcamento.js:178` `/orcamento/:id` | Rubricas, valores, distribuição, estado | Não | **Sim** | Não | **Não** | **Sim** |
| **Comunicações/avisos** | `avisos.js:34` `/avisos` | Assunto, corpo, destinatários | **Sim** (e-mails) | Não | Não | **Não** | **Parcial** — listagem sim; detalhe expõe e-mails |
| **Emails (fila)** | `emails.js:54` `/emails` | Fila, estado, erro, destinatário, SMTP (sem password) | **Sim** (e-mails, `corpo_html`) | Não | **`temPassword` é booleano — password nunca renderizada** (`mailer.js:230`) | **Não** | **Parcial** — muito útil para diagnosticar «e-mail não chegou», mas expõe conteúdo de mensagens |
| **Configuração** | `configuracao.js:99` `/config` | Designação, NIF, IBAN, e-mail, telefone, logotipo | **Sim** | Sim (IBAN) | Não | **Não** | **Parcial** — só leitura de identidade; **nunca** `/config/armazenamento*` |
| **Armazenamento** | `configuracao.js:109` `/config/armazenamento` | Provedor ligado, **`conta` autorizada** (e-mail da conta Google/Dropbox) | Sim (e-mail da conta) | Não | Tokens **nunca renderizados** (`storage.js:173`) | **`/config/armazenamento/:provedor/callback` (152) e `/config/drive/callback` (471) NÃO — persistem tokens e auditam** | **Parcial** — só o estado; os *callbacks* nunca |
| **Auditoria** | `configuracao.js:416` `/config/auditoria` | Registos de auditoria do condomínio | **Sim** (nome+e-mail de utilizadores) | Não | Não | **Não** | **Parcial** — poderoso para diagnóstico; expõe identidades |
| **Relatórios** | `relatorios.js:116` `/relatorios/financeiro` | Agregados financeiros, PDF em memória | Não | **Sim** | Não | **Não** | **Sim** |
| **Fornecedores** | `fornecedores.js:84` `/fornecedores` | Nome, NIF, IBAN, contactos | **Sim** (PII de fornecedor) | **Sim** (IBAN) | Não | **Não** | **Parcial** — raramente necessário para diagnóstico |
| **Quotas extra** | `extra-quotas.js:93` `/quotas-extra` | Quotas extraordinárias, parcelas, estado | Indiretos | **Sim** | Não | **Não** | **Sim** |
| **Tarefas** | `admin.js:1501` `/tarefas` | Estado dos jobs, erros | Não | Não | Não | **Não** | **Já incluída** |

---

## 4. Categorias de decisão

### A — Pode ser visto em diagnóstico (read-only, sem mascaramento)

Baseia-se em código real, não em suposição.

- `/` (dashboard), `/fracoes`, `/condominos`, `/tarefas` — **já admitidas**.
  ⚠️ Ver a ressalva de PII em §5.
- **Quotas**: `/admin/quotas`, `/admin/quotas/grelha`, `/admin/quotas/:id`.
- **Pagamentos**: `/admin/pagamentos`, `/admin/pagamentos/:id`.
- **Despesas**: `/admin/despesas`.
- **Orçamento**: `/admin/orcamento`, `/admin/orcamento/:id`.
- **Extra-quotas**: `/admin/quotas-extra`, `/admin/quotas-extra/:id`.
- **Relatórios financeiros**: `/admin/relatorios/financeiro`.
- **Conta-corrente por fração**: `/admin/quotas/conta-corrente`.
- **Documentos (biblioteca)**: `/admin/documentos` — metadados apenas.
- **Assembleias (listagem/detalhe)**: `/admin/assembleias`, `/admin/assembleias/:id`.

**Justificação:** são leituras puras (a auditoria de efeitos laterais não encontrou
qualquer `create`/`update`/`destroy`/`audit`/envio nestes GETs), o âmbito é sempre
`condominio_id = req.condominioId`, e a informação é a que um técnico precisa para
responder a «não aparece» / «está errado».

### B — Pode ser visto apenas parcialmente (exige mascaramento ou recorte)

Não existe **nenhum masker de aplicação** hoje. Confirmado: `helpers/money.js` só
formata EUR; `helpers/handlebars-helpers.js` não tem helper de máscara;
`helpers/cabecalhos-ficheiro.js` só sanitiza nomes de ficheiro. Os únicos maskers do
repo estão em **scripts de diagnóstico** (`scripts/diagnostico-movimentos-condominio.js:32`
`maskIban`, `scripts/diagnostico-documentos.js:68` `mascarar`) e no redator de logs
HTTP (`helpers/armazenamento/http.js:13-14`).

| Item | Rota | O que mascarar/recortar | Onde está exposto |
|---|---|---|---|
| **IBAN** | `/admin/movimentos`, `/admin/quotas/conta-corrente`, `/admin/contas` | Mostrar só últimos 4 dígitos | `contas/listar.handlebars:47` (`{{iban}}`), `situacao-financeira.handlebars:144`, `pdf.js:666` |
| **NIF** | `/admin/condominos`, `/admin/config` | Mostrar parcial (`123***789`) | `condominos/listar.handlebars:30` (`{{nif}}`) — **já admitida hoje, sem máscara** |
| **E-mail/telefone** | `/admin/condominos`, `/admin/fracoes/:id`, `/admin/avisos` | Ocultar ou mostrar domínio | `condominos/listar.handlebars:28-29`, `fracoes/detalhe.handlebars:48-49` — **já admitidas hoje, sem máscara** |
| **`codigo_verificacao` do recibo** | `/admin/quotas/recibos` | Não imprimir o código de autenticidade | `quotas/recibos.handlebars:96` (`title="{{codigo_verificacao}}"`) |
| **Fila de e-mails** | `/admin/emails` | Não expor `corpo`/`corpo_html`; só estado + erro | `emails/index.handlebars:80` (`{{destinatario_email}}`), `:99-100` (`{{erro}}`) |
| **Configuração** | `/admin/config` | NIF/IBAN/contactos mascarados | `configuracao/index.handlebars:31-32,52,56,62-63` |
| **Auditoria** | `/admin/config/auditoria` | Identidades parciais | `configuracao/auditoria.handlebars` |
| **Armazenamento** | `/admin/config/armazenamento` | E-mail da conta autorizada | `armazenamento.handlebars:41-42` (`{{conta}}`) |

### C — Nunca acessível em diagnóstico

Cada ponto foi **verificado contra o código**, não aceite por presunção.

| Categoria | Evidência no código |
|---|---|
| **Passwords / hashes** | `models/User.js` `password_hash`, `two_fa_email_codigo_hash`, `two_fa_recovery_hash` — nunca renderizados; `utilizadores/form.handlebars:44` é input vazio |
| **Tokens OAuth (Drive/Dropbox/OneDrive)** | Armazenados em `configuracoes` cifrados AES-256-GCM (`helpers/armazenamento/cifra.js:39`); `storage.js:173` documenta «Nunca inclui chaves/tokens»; `ligacoes.js:86-89` `ehChaveDeCredenciais()` |
| **SMTP credentials** | Password nunca renderizada (`mailer.js:230` devolve só `temPassword: Boolean`); ⚠️ **não há evidência de cifra em repouso** — a password é um `Configuracao.valor` em claro |
| **`convite_token` / `reset_token` / `two_fa_totp_secret`** | `models/User.js` — **plaintext**, não cifrados; os tokens aparecem no *action* dos formulários (`auth/redefinir.handlebars:25`, `auth/aceitar-convite.handlebars:25`) |
| **Alterações de permissões** | `/admin/utilizadores*` (exige `apenasAdmin`) |
| **Ações financeiras** | `POST` de `/quotas/gerar`, `/quotas/recibos/emitir`, `/pagamentos`, `/despesas`, `/movimentos/:id/anular`, `/contas/transferir-fcr` |
| **Operações destrutivas** | `POST` `/despesas/:id/anular`, `/quotas/:id/anular`, `/orcamento/:id/eliminar`, `/documentos/:id/eliminar` |
| **Envio de e-mails** | `POST` `/emails/*`, `/quotas/recibos/:id/enviar`, `/pagamentos/enviar-recibos`, `/avisos/:id/enviar`, `/documentos/:id/email` |
| **Sincronizações / OAuth** | `GET /config/armazenamento/:provedor/callback` (`configuracao.js:152`) e `GET /config/drive/callback` (`:471`) — **persistem tokens** apesar de serem GET |
| **Configuração de storage** | `POST /config/armazenamento/*`, `/config/drive/*` |
| **Criação de pastas em Drive** | **`GET /documentos/drive/pasta` (`documentos.js:208`)** — cria pasta no provedor e grava `condominios.drive_folder_id` |
| **Gerar convocatória** | **`GET /assembleias/:id/convocatoria` (`assembleias.js:462`)** — upload + `Documento.create` + `assembleia.update` |
| **Ficheiros de documento** | `GET /documentos/:id/ficheiro` (`documentos.js:535`), `/condomino/documentos/:id/ficheiro`, `/documentos/ficheiro/:token` — escrevem `AuditLog` e abrem stream do provedor |
| **Portal `/condomino`** | Inteiro — `router.use(tenant.semSuporte)` (`routes/condomino.js:62`) |
| **Backup** | `POST /sistema/backup` |
| **Nível `operacional`** | Fora de âmbito (recusado no backend) |

---

## 5. Atenção especial: dados financeiros

«Read-only» **não** significa «sem risco». O que um técnico precisa de ver para
diagnosticar é diferente do que a view mostra.

**Para diagnosticar «a quota está errada» o técnico precisa de:**
`valor_base`, `valor_fcr`, `valor_por_1000`, `permilagem_aplicada`, `fcr_percentagem`,
`ano`, `mes`, `periodo`, `data_emissao`, `data_vencimento`, `estado`
(`models/Quota.js`). **Não precisa** do nome/NIF/e-mail do condómino.

**Para diagnosticar «o pagamento não aparece» precisa de:**
`numero_documento`, `valor`, `data_pagamento`, `referencia`, `estado`, `metodo_pagamento`
e a que fração se aplica (`models/Pagamento.js`). **Não precisa** da identidade pessoal
do titular.

**Para diagnosticar «o saldo está errado» precisa de:**
`MovimentoBancario` (data, tipo, valor, descrição, referência, estado) e os saldos
agregados. **Não precisa** do IBAN completo da conta.

**Conclusão financeira:** é possível — e recomendável — dar ao diagnóstico uma
**leitura financeira *despersonalizada***: valores, datas, estados e ids técnicos, com
**identidades pessoais recortadas** e **IBAN mascarado**. Isso responde a praticamente
todos os problemas financeiros sem transformar o suporte em acesso administrativo.

⚠️ **Risco a ter presente:** hoje `/fracoes/:id` já junta **identidade + financeiro
na mesma página** (nome/e-mail/telefone dos titulares ao lado dos valores das quotas).
Se o objetivo é «diagnóstico financeiro sem acesso administrativo», essa combinação é
o ponto mais sensível da allow-list atual.

---

## 6. Atenção especial: documentos

**O técnico precisa de consultar documentos?** Para alguns casos sim:
- «o documento não aparece» → precisa de ver a **lista** (nome, pasta, `disponivel_condominos`);
- «o documento não abre» → precisa de ver **`drive_status`** e **`drive_erro`**;
- «o recibo não está disponível» → precisa do **estado do recibo**, não do PDF.

**O técnico precisa de *descarregar* o ficheiro?** Praticamente nunca. O diagnóstico
resolve-se com **metadados**. Abrir o ficheiro introduz três problemas que os metadados
não têm: exposição do conteúdo, escrita de `AuditLog` num GET, e stream do provedor
externo.

**Forma de expor só o necessário, sem reabrir o portal** (não implementada — apenas
proposta):
1. **Biblioteca em `/admin`**: acrescentar `/admin/documentos` à allow-list — a rota
   `documentos.js:62` é **leitura pura** e já é escopada por `condominio_id`.
2. **Estado técnico, não conteúdo**: expor `drive_status`/`drive_erro` na listagem.
   Hoje `drive_erro` **não aparece em nenhuma view admitida**, o que obriga o técnico a
   adivinhar.
3. **Nunca** admitir `/documentos/:id/ficheiro` (escreve `AuditLog`) nem
   `/documentos/drive/pasta` (cria pasta no provedor) — a menos que se aceite
   explicitamente a escrita de auditoria, como já acontece no portal do condómino.
4. **Não reabrir `/condomino`.** O portal fica fechado; a leitura faz-se por `/admin`.

> Nota: **não implementar nesta fase** — conforme pedido.

---

## 7. Impacto de segurança de cada módulo adicional

| Módulo a adicionar | O que aumenta | Notas |
|---|---|---|
| Quotas / Pagamentos / Despesas | Exposição de **valores financeiros** do condomínio | Sem identidade pessoal se as views forem recortadas |
| Recibos | Valores + **código de verificação** (autenticidade) | Mascarar o código |
| Movimentos / Contas | Valores + **IBAN** | Mascarar IBAN |
| Orçamento / Extra-quotas / Relatórios | Valores agregados | Risco baixo |
| Documentos (biblioteca) | **Nomes de documentos** (podem ser sensíveis: «Processo judicial X») | Metadados apenas |
| Assembleias | **Participantes** (PII) + FCR (financeiro) | Recortar participantes |
| Avisos | **E-mails de destinatários** | Recortar |
| Emails (fila) | **Conteúdo de mensagens** | Só estado/erro |
| Configuração | NIF/IBAN/contactos do condomínio | Mascarar |
| Auditoria | **Identidades + histórico de ações** | Poderoso; expõe quem fez o quê |
| Fornecedores | **PII de fornecedor + IBAN** | Raramente necessário |
| **Qualquer um** se montado em `/condomino` | **Reabre o portal** | Não fazer |

**Risco transversal já presente:** a allow-list atual **não tem camada de
mascaramento**. `/condominos` e `/fracoes/:id` — ambas **já admitidas** — expõem
NIF, e-mail e telefone completos. Antes de alargar, vale a pena decidir se se
introduz máscara (não existe nenhuma hoje).

---

## 8. Recomendação final

### Veredicto: **excessivamente restritiva para o uso real, mas funcionalmente segura**

A allow-list atual é **correta do ponto de vista de segurança** e **insuficiente do
ponto de vista funcional**.

**O que está certo e não deve mudar:**
- Ponto único de admissão, allow-list fechada, nível + método validados.
- `/condomino` fechado; nenhum acesso administrativo; `comPapel('gestor')` **não**
  como solução; `/admin` **não** reaberto.
- Nenhum GET com efeito lateral está admitido (verificado).

**O que falta (por ordem de utilidade para o suporte):**
1. **Quotas e pagamentos** — sem isto o suporte não diagnostica os dois problemas mais
   reportados. É a lacuna mais grave.
2. **Despesas e movimentos** — fecha o diagnóstico do «saldo/extrato errado».
3. **Documentos (metadados)** — resolve «não aparece» / «não abre» sem abrir ficheiros.
4. **Estado da fila de e-mails** — resolve «o e-mail não chegou» (envios são uma
   reclamação frequente e a rota é leitura pura).
5. **Orçamento** — necessário para «a quota está errada» (permilagem/distribuição).

**Recomendação concreta (a decidir, não implementada):** manter o mecanismo
(allow-list explícita + `comSuporte(['diagnostico'])` + `somenteLeitura`) e:

- **Adicionar** um conjunto **mínimo e financeiramente despersonalizado**:
  `/quotas`, `/quotas/:id`, `/quotas/grelha`, `/pagamentos`, `/pagamentos/:id`,
  `/despesas`, `/movimentos`, `/quotas/conta-corrente`, `/orcamento`,
  `/orcamento/:id`, `/relatorios/financeiro`, `/documentos` (biblioteca),
  `/emails` (estado/erro), `/assembleias`, `/assembleias/:id`.
- **Mascarar** IBAN, NIF e contactos pessoais **antes** de expor esses módulos
  (hoje não existe masker).
- **Nunca** admitir: `/documentos/:id/ficheiro`, `/documentos/drive/pasta`,
  `/assembleias/:id/convocatoria`, `/config/armazenamento*`, `/config/drive*`,
  `/config/auditoria`, `/emails/*` (POST), `/utilizadores*`, `/sistema/*`.
- **Rever** se `/fracoes/:id` deve continuar a juntar identidade + financeiro na
  mesma página, ou se o financeiro deve passar para as rotas dedicadas (deixando
  `/fracoes/:id` só com o cadastro).

### Decisão que fica em aberto

A escolha entre **(a)** manter as 5 rotas e resolver os casos financeiros por
intervenção manual, **(b)** alargar já com máscara, ou **(c)** alargar sem máscara
(aceitando PII) é uma decisão de produto — esta auditoria fornece os dados para a
tomar, mas **não a toma**.

---

## 9. Trabalho futuro identificado (não corrigido)

1. **`/condomino` protegido por prefixo partilhado, não por guarda própria** —
   `condomino-conta.js:41-44` recusa só `isAdmin`; `saida-condominio.js` não tem
   guarda de suporte. Reordenar as montagens em `app.js:286-300` reabre o portal.
2. **`helpers/audit.js` engole erros** para `console.error`.
3. **`User.convite_token` / `reset_token` / `two_fa_totp_secret` em claro**;
   tokens em URLs de formulário.
4. **Password SMTP sem evidência de cifra em repouso** (ao contrário dos tokens
   OAuth, que são AES-256-GCM).
5. **Não existe masker de aplicação** para IBAN/NIF/e-mail.
6. **`/fracoes/:id` mistura identidade e financeiro** numa só página.
7. **`drive_erro` não é visível em nenhuma view admitida**, apesar de ser exatamente
   o dado que diagnostica «o documento não abre».
