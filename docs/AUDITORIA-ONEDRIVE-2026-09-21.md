# Auditoria — integração Microsoft OneDrive (read-only)

**Data:** 2026-09-21 · **Âmbito:** auditoria apenas, sem alterações de código, migrations, `.env`, documentos ou backups. Sem commit, sem push.

> ## ⚠️ Estado atual (revisão de 2026-09-22) — auditoria parcialmente SUPERADA
>
> Confirmado **no código** (não por inspeção visual):
>
> | Achado | Estado |
> |---|---|
> | **B1** — `User.Read` não pedido | **Corrigido.** `onedrive.js` tem `SCOPE = 'offline_access Files.ReadWrite User.Read'`; `test-storage-provedores.js` §9 assere o scope na URL de autorização. |
> | **B2** — sem `apagarArquivo` | **Corrigido.** `apagarArquivo` existe no OneDrive (`DELETE /me/drive/items/{id}`, idempotente no 404) e na **Dropbox** (`files/delete_v2`, idempotente em `path_lookup/not_found`). A retenção cloud deixou de ser um no-op. |
> | **B3** — sem UI para a ligação de plataforma | **Tratado** na interface de armazenamento (`?ambito=plataforma`); ver §3.12 do Roadmap. |
> | **B4** — `disponivel` ignorava `featureAtiva()` | **Corrigido.** `helpers/storage.js:servicoDisponivel` exige `featureAtiva()` **e** `temCredenciais()`. |
> | **B7** — `desligar` ignorava `opcoes.plataforma` | **Corrigido.** A assinatura é `desligar(condominioId, opcoes)` e honra o âmbito. |
> | **B8** — documentação de configuração em falta | **Corrigido.** Existe `docs/ONEDRIVE.md`; `.env.example` documenta `ONEDRIVE_ENABLED`. |
> | **B5** — nomes sanitizados só para Windows | **Em aberto** (não corrigido por esta revisão). |
> | **B6** — nenhum teste offline toca na Graph API | **Parcialmente tratado:** existe `scripts/test-onedrive-graph.js` (14 secções) e `test-storage-provedores.js` §8.5 cobre a remoção e a quota com um interceptor do cliente HTTP. |
> | **B9** — «listagem» não existe | **Não é lacuna** (mantém-se): o índice de documentos é a base de dados. |
> | **B10** — eliminar documento não apaga no fornecedor | **Decisão de produto em aberto** — ver **P4**. |
>
> **Falta apenas a Fase 2** (§8): configurar a App Registration Microsoft e correr
> `npm run verificar:provedores -- --provedor onedrive` na máquina com credenciais reais.
> Nada disso exige código novo.
**Pergunta de partida:** o que já está implementado, o que impede a utilização real do OneDrive, e o que é preciso fazer na conta Microsoft **existente** (sem criar conta nova).

---

## 0. Método e evidência

Ficheiros lidos (na íntegra): `helpers/armazenamento/provedores/onedrive.js` (901 linhas), `provedores/index.js`, `contrato.js`, `locator.js`, `estrutura.js`, `http.js`, `cifra.js`, `ligacoes.js`, `helpers/storage.js`, `helpers/documentos-por-servico.js`, `jobs/backup.js` (secção de cloud), `routes/configuracao.js` (secções OAuth), `views/admin/configuracao/armazenamento.handlebars`, `.env.example`, `docker-compose.yml`, `scripts/verificar-provedores-reais.js`, `scripts/test-storage-provedores.js`, `scripts/diagnostico-credenciais.js`.

Testes corridos (read-only, sem alterar nada):

| Comando | Resultado |
|---|---|
| `node scripts/test-storage-provedores.js` | **exit 0** — «Testes da arquitetura de armazenamento (multi-provedor) passaram» |
| `node scripts/test-storage.js` | **exit 0** — «Testes do StorageProvider passaram (sem rede)» |

Pesquisa: `grep -rn "graph.microsoft" scripts/` → **0 resultados**. Nenhum teste offline executa a Graph API.

Requisitos Microsoft confirmados em documentação oficial (ver §6), não assumidos de memória.

---

## 1. O que já funciona

O adaptador OneDrive **não é um esqueleto**: está implementado, registado e conforme ao contrato.

| Área | Estado | Evidência |
|---|---|---|
| Registo e contrato | ✅ completo | `provedores/index.js` regista `onedrive`; `contrato.verificarRegisto()` → `ok:true` (provado pelo teste, exit 0) |
| OAuth (URL de autorização) | ✅ | `urlAutorizacao()`: endpoint v2.0, `response_mode=query`, `prompt=select_account`, scopes com espaço como `%20` |
| OAuth (troca de código) | ✅ | `trocarCodigo()`: `authorization_code`, guarda tokens no âmbito certo |
| Renovação de token | ✅ | `renovarToken()`: `refresh_token`, rotação do refresh, limpa tokens em `invalid_grant`/401 |
| Desligar | ✅ | `desligar()`: remove só os tokens locais; não apaga ficheiros |
| Rotas da aplicação | ✅ | `routes/configuracao.js`: `PROVEDORES_OAUTH = {dropbox, onedrive}` → `/config/armazenamento/:provedor/{ligar,callback,desligar,testar}` |
| Callback OAuth | ✅ | `GET /admin/config/armazenamento/onedrive/callback`; `state` na sessão; **âmbito e condomínio nunca vêm do browser** |
| Cifragem dos tokens | ✅ | `cifra.js` AES-256-GCM, AAD = chave de configuração → um token copiado de um condomínio para outro deixa de decifrar |
| Localizadores `od:` | ✅ | `locator.js`; a fachada monta o prefixo no **ponto único** (`storage.uploadArquivo`) |
| Leitura pelo localizador | ✅ | `storage.abrirFluxo('od:…')` → adaptador OneDrive (provado em `test-storage-provedores.js` §10) |
| Estrutura de pastas | ✅ | `<raiz>/<Condomínio>/<ano>/{Assembleias,Quotas,Recibos,Despesas,Contratos,Outros}` + `<raiz>/Backups`; planeadores em `estrutura.js` |
| Upload | ✅ | simples ≤4 MB (`PUT …/root:/…:/content`) e por sessões de 320 KiB (inclui a fatia final de comprimento zero) |
| Download e streaming | ✅ | `descarregarArquivo` (binário) e `abrirFluxo` (stream, sem reenviar o `Authorization` no salto cross-origin) |
| Pasta de backups | ✅ | `pastaDeBackups()` exportado → `<raiz>/Backups` |
| Sem links públicos | ✅ | `linkPasta()` → `null`; nenhum endpoint `/invite` ou `/createLink`; nenhum método proibido |
| Env no Docker | ✅ | `docker-compose.yml` passa todas as `ONEDRIVE_*` (incl. `ONEDRIVE_ENABLED`, `ONEDRIVE_TENANT`) |
| Verificador real | ✅ existe | `scripts/verificar-provedores-reais.js` — OAuth real em loopback + 25 passos (pastas, upload, download, streaming, renovação, plataforma, isolamento, desligar) |

---

## 2. O que está incompleto

| # | Lacuna | Prova | Impacto |
|---|---|---|---|
| **B1** | **`User.Read` não é pedido** → a identificação da conta falha | `onedrive.js:54` `SCOPE = 'offline_access Files.ReadWrite'`; `onedrive.js:507` chama `GET /me`, que exige a delegada `User.Read`. O erro é engolido (`catch` em `:515`) | `conta` fica `null` → a página mostra «conta autorizada» em vez do email; `testarLigacao()` cai para `dados.id` (`:442`) e mostra o **id do drive** como se fosse a conta |
| **B2** | **Sem `apagarArquivo`** | `grep apagarArquivo provedores/*.js` → só `google-drive.js`. `storage.apagarArquivo` devolve `false` (`storage.js:340`) | A retenção de backups (`jobs/backup.js:71`) é **no-op** quando o destino é OneDrive (e Dropbox). As cópias cloud acumulam-se sem limite |
| **B3** | **Sem UI para criar a ligação de PLATAFORMA** | `grep "ambito=plataforma" views/` → só em `testar`/`desligar`/reconexão de ligação inválida. Não há botão «ligar à plataforma» | Para usar OneDrive nos backups com conta da instalação é preciso escrever o URL à mão. Sem isso, os backups usam a conta de um condomínio (`origem='condominio'`) + aviso. Lacuna **partilhada com a Dropbox** |
| **B4** | **`disponivel` ignora `featureAtiva()`** | `storage.js:144` `disponivel = p.temCredenciais()` (só client id/secret). A vista mostra o botão «Ligar» (`armazenamento.handlebars:92,103`), mas `routes/configuracao.js:147` recusa se `!estado.ativo` | Com credenciais definidas e `ONEDRIVE_ENABLED≠true`, o botão **existe e falha sempre** com «ainda não está disponível nesta instalação» |
| **B5** | **Nomes sanitizados para Windows, não para o OneDrive** | `segmentoSeguro` (`:160`) só remove `\` e `/` | Um condomínio com `: * ? " < > \|` no nome faz `garantirPasta` falhar com `invalidRequest`; também não trata pontos/espaços finais nem nomes reservados (`CON`, `PRN`, …) |
| **B6** | **Nenhum teste offline toca na Graph API** | `grep -rn "graph.microsoft" scripts/` → 0 | As ~700 linhas de pastas/upload/upload-por-sessões/download/streaming/renovação **nunca são executadas** fora da API real. A cobertura offline é contrato + URL + localizadores + planeadores |
| **B7** | **`desligar(condominioId)` ignora `opcoes.plataforma`** | `onedrive.js:534` — a assinatura não lê o 2.º argumento | Funciona **por acaso** (a rota passa `null`). Inconsistente com `storage.desligar({provedor, condominioId, plataforma})` |
| **B8** | **Documentação de configuração em falta** | Existe `docs/GOOGLE_DRIVE.md`; **não** existe `docs/ONEDRIVE.md`. `.env.example:80-91` não diz «`ONEDRIVE_ENABLED=true` liga a integração» (ao contrário do Drive, `:49`) | O passo que ativa a integração é o mais fácil de esquecer |
| **B9** | **`listagem` não existe** | Nem no `contrato.js` nem em nenhum provedor | **Não é lacuna a corrigir:** o índice de documentos é a base de dados (`documentos`), não uma listagem do fornecedor. Registado para clareza |
| **B10** | Eliminar um documento na app não apaga o ficheiro no fornecedor | `routes/documentos.js:470` faz só `documento.destroy()` | Aplica-se a **todos** os provedores. Nota de governação de dados, não bloqueio do OneDrive |

---

## 3. O problema exato na configuração Microsoft/OAuth

Por ordem de probabilidade, do lado da Microsoft **e** do GesCondu:

1. **`ONEDRIVE_ENABLED` não está `true`.** É `false` por omissão em `.env.example:83` **e** em `docker-compose.yml` (`ONEDRIVE_ENABLED: ${ONEDRIVE_ENABLED:-false}`). Com `false`:
   - `featureAtiva()` → `false` → `isConfigured()` → `false`;
   - a rota `GET /config/armazenamento/onedrive/ligar` recusa (`routes/configuracao.js:147`) com **«Microsoft OneDrive ainda não está disponível nesta instalação. Contacte o administrador do GesCondu.»**;
   - e, por **B4**, o botão «Ligar Microsoft OneDrive» continua visível se o `CLIENT_ID`/`SECRET` estiverem preenchidos — ou seja, **o admin vê um botão que nunca funciona**. Este é o sintoma que mais provavelmente fez a tentativa anterior parecer «partida».

2. **`signInAudience` da App Registration.** Se ficou no default **«Accounts in this organizational directory only»** (single-tenant) e `ONEDRIVE_TENANT=common`, o pedido de autorização falha com **`AADSTS50194: Application … is not configured as a multi-tenant application`**. Para OneDrive **pessoal** é obrigatório «Accounts in any organizational directory and personal Microsoft accounts» (`AzureADandPersonalMicrosoftAccount`).

3. **Redirect URI não corresponde exatamente.** Erro **`AADSTS50011`**. O URI é resolvido por `redirectUriDe()` (`routes/configuracao.js:43`): usa `ONEDRIVE_REDIRECT_URI` se definido, senão `${req.protocol}://${req.get('host')}/admin/config/armazenamento/onedrive/callback`. Esquema, host, porta e **caminho** têm de bater certo com o registado; o caminho é *case-sensitive*.

4. **Client secret errado ou expirado.** É preciso usar o **Value** do secret (não o Secret ID) e confirmar que não expirou — os secrets expiram e a app passa a devolver `invalid_client` no `trocarCodigo`.

5. **`ENCRYPTION_KEY` em falta/inválida.** `guardarTokens` → `cifra.cifrar` lança `ErroCifra` (`sem_chave` / `chave_invalida`). Como o `guardarTokens` é chamado **depois** do OAuth ter sucesso, o sintoma é «Não foi possível ligar Microsoft OneDrive: …» no callback, com a autorização já concedida.

6. **Consentimento.** `Files.ReadWrite` e `User.Read` (delegadas) **não** exigem consentimento administrativo. Só se a conta for **escolar/empresarial** e o tenant tiver o consentimento do utilizador desativado é que um administrador tem de aprovar. Numa conta **pessoal** não.

> Nota: **nenhum destes pontos foi confirmado contra a instalação de produção** — não há acesso ao `.env` de `/opt/condofy`. São deduções a partir do código e dos defaults. O passo 1 do plano (§8) confirma-os em minutos.

---

## 4. O que tens de fazer na conta Microsoft / App Registration

Tudo isto é feito **com a conta existente**. Não é preciso criar conta nova.

1. `entra.microsoft.com` → **App registrations** → **New registration**.
2. **Name:** `GesCondu` (livre).
3. **Supported account types:**
   - conta **pessoal** (outlook.com / hotmail / live) → **«Accounts in any organizational directory and personal Microsoft accounts»**;
   - conta **empresarial** → «Accounts in any organizational directory» **ou** single-tenant + `ONEDRIVE_TENANT=<id-do-tenant>`.
4. **Redirect URI** → plataforma **Web** (não «Single-page application»):
   - produção: `https://<o-teu-domínio>/admin/config/armazenamento/onedrive/callback`
   - local: `http://localhost:3000/admin/config/armazenamento/onedrive/callback`
   - ⚠️ O portal **não aceita** um redirect `http` com `127.0.0.1` (só `localhost`); para usar `127.0.0.1` é preciso editar o **manifesto** (`replyUrlsWithType`).
   - ⚠️ Em loopback (`localhost`) a **porta é ignorada** no matching, mas o **caminho não**.
   - ⚠️ Para apps com contas pessoais, **não** são permitidos *query strings* no redirect URI.
5. **Certificates & secrets** → New client secret → copiar o **Value** (só aparece uma vez).
6. **API permissions** → Microsoft Graph → **Delegated**: `Files.ReadWrite`, `offline_access`, `User.Read`.
7. Guardar no `.env` da instalação:
   ```
   ONEDRIVE_ENABLED=true
   ONEDRIVE_CLIENT_ID=<Application (client) ID>
   ONEDRIVE_CLIENT_SECRET=<Value do secret>
   ONEDRIVE_TENANT=common
   ONEDRIVE_REDIRECT_URI=https://<o-teu-domínio>/admin/config/armazenamento/onedrive/callback
   ```
8. Ligar a conta em **Configuração → Armazenamento e Backups → Ligar Microsoft OneDrive**. O fluxo já força `prompt=select_account`, pelo que podes escolher a conta certa mesmo com sessão Microsoft aberta no browser.
9. Para os **backups**: abrir `/admin/config/armazenamento/onedrive/ligar?ambito=plataforma` (não há botão — ver B3), autorizar **a mesma conta**, e escolher OneDrive como destino em «Backups».

---

## 5. O que terá de ser alterado no GesCondu

Por prioridade. **Nada disto está feito** — esta fase é só auditoria.

| # | Alteração | Ficheiro | Corrige |
|---|---|---|---|
| 1 | `SCOPE = 'offline_access Files.ReadWrite User.Read'` — **ou** (alternativa) identificar a conta por `GET /me/drive?$select=id,driveType,owner` em vez de `GET /me`, evitando pedir permissão nova | `helpers/armazenamento/provedores/onedrive.js` | B1 |
| 2 | Implementar `apagarArquivo(fileId, condominioId)` → `DELETE /me/drive/items/{id}` + exportar | `helpers/armazenamento/provedores/onedrive.js` | B2 |
| 3 | `segmentoSeguro`/`nomeSeguro`: remover `: * ? " < > \|` e controlos, aparar pontos/espaços finais, tratar nomes reservados | `helpers/armazenamento/provedores/onedrive.js` | B5 |
| 4 | `disponivel` passa a exigir `featureAtiva()` (ou `estadoLigacao().ativo`) — não mostrar botão inerte | `helpers/storage.js` | B4 |
| 5 | Botão «Ligar conta da plataforma (backups)» para Dropbox/OneDrive (as rotas já suportam `?ambito=plataforma`) | `views/admin/configuracao/armazenamento.handlebars` | B3 |
| 6 | Acrescentar «`ONEDRIVE_ENABLED=true` liga a integração» (paridade com o Google Drive) | `.env.example` | B8 |
| 7 | `desligar(condominioId, opcoes)` honrar `opcoes.plataforma` explicitamente | `helpers/armazenamento/provedores/onedrive.js` | B7 |
| 8 | Usar `http://localhost:<porta>/callback` por omissão (o portal aceita; `127.0.0.1` exige edição do manifesto) | `scripts/verificar-provedores-reais.js` | fricção de registo |
| 9 | Cobertura offline da Graph API com duplo de `http.pedir`: criar pasta (409 idempotente), upload simples, upload por sessões com fatia final zero, download, streaming, 401→limpa tokens, 403 | novo `scripts/test-onedrive-graph.js` | B6 |
| 10 | `docs/ONEDRIVE.md` com os passos de §4 | novo | B8 |

**Não é preciso migration.** O localizador `od:` já está previsto na coluna `documentos.drive_file_id` (STRING(191)) e não há coluna de provedor a acrescentar.

---

## 6. Permissões Microsoft Graph necessárias

| Permissão | Tipo | Para quê | Consentimento administrativo |
|---|---|---|---|
| `Files.ReadWrite` | Delegada | ler/escrever os ficheiros do utilizador (o OneDrive da conta) | **Não** |
| `offline_access` | Delegada | refresh token (renovação automática da ligação) | **Não** |
| `User.Read` | Delegada | identificar a conta (`GET /me`) — **em falta no código (B1)** | **Não** |

**Não usar:**

| Permissão | Porquê não |
|---|---|
| `Files.ReadWrite.All` (delegada) | Exige consentimento administrativo; dá acesso a *todos* os ficheiros a que o utilizador tem acesso (não só o OneDrive dele). Excessiva |
| `Files.ReadWrite` / `Files.ReadWrite.All` (**aplicação**) | Exigem consentimento administrativo; dão acesso a **todos** os drives do tenant. Incompatível com o modelo por conta do GesCondu |
| `User.Read.All`, `Directory.Read.All` | Desnecessárias — só é preciso o perfil do próprio |
| `Sites.*` | SharePoint, fora do âmbito |

**Alternativa mais restrita (decisão de produto, não tomar agora):** `Files.ReadWrite.AppFolder` (delegada) limita o acesso à **pasta especial da aplicação** (`/Apps/<app>`). Seria a permissão mínima, mas obrigaria a mudar a hierarquia de pastas do GesCondu (`<raiz>/<Condomínio>/<ano>/…` deixaria de estar na raiz do drive). Registado para decisão futura.

**Exceção a ter em conta:** numa conta **escolar/empresarial** cujo tenant tenha o consentimento do utilizador desativado, **qualquer** permissão delegada exige aprovação de um administrador do tenant. Numa conta pessoal, o próprio utilizador consente.

---

## 7. É possível concluir tudo com a conta Microsoft existente?

**Sim.** Em detalhe:

- **Documentos:** a ligação é *delegada* — a aplicação age em nome da conta, não é preciso registar conta nova, conta de serviço, nem pagar nada. Basta a conta existente ter OneDrive (as contas pessoais incluem quota gratuita).
- **Backups:** o desenho atual usa uma ligação de **plataforma** (conta da instalação), guardada em `storage:tokens:onedrive:plataforma`. Pode ser **a mesma conta existente** — é uma segunda autorização com a **mesma** App Registration e as **mesmas** credenciais. Não é preciso conta nova.
- **Alternativa aos backups:** deixar o destino usar a conta do condomínio (`origem='condominio'`). Funciona, mas os backups de **todos** os condomínios ficam nessa conta — a interface avisa (`avisoPartilhado`).
- **Atenção à quota:** o dump diário comprimido ocupa espaço; se a conta pessoal tiver pouca quota livre, os backups podem encher o OneDrive. (A retenção cloud não limpa OneDrive enquanto B2 não for corrigido.)

---

## 8. Plano de implementação e testes reais

### Fase 1 — código (sem tocar em Google Drive nem Dropbox)
Implementar os pontos 1–9 da tabela de §5. Regra: nenhuma alteração pode mudar o comportamento do Drive ou da Dropbox. Cada ponto com o seu teste offline que **morde** (mutação).

### Fase 2 — verificação real (na máquina com as credenciais)
1. Confirmar o estado atual: `node scripts/diagnostico-credenciais.js` (mostra `ONEDRIVE_ENABLED` / `CLIENT_ID` / `CLIENT_SECRET` / `REDIRECT_URI` presentes ou não) e o estado da cifra.
2. Registar o redirect no Entra ID (§4, plataforma **Web**).
3. Definir as variáveis (§4, ponto 7) e reiniciar.
4. `npm run verificar:provedores -- --provedor onedrive`
   **Esperado:** ~25 passos ✓ — URL de autorização, código trocado + **conta identificada**, credenciais cifradas em repouso, `estadoLigacao`, `testarLigacao`, `criarEstruturaPastas` (≥6 pastas do ano), `pastaParaDocumento`, `uploadArquivo` + localizador `od:`, `descarregarArquivo`, `abrirFluxo`, renovação automática do token, `pastaParaFornecedor`, **ligação de plataforma** + isolamento (chaves e tokens distintos), `pastaDeBackups`, sem link público, `desligar` (e a plataforma preservada).
   **Atenção:** o script usa `http://127.0.0.1:53682/callback` por omissão — registar no **manifesto** ou usar `--porta` com `localhost` (ponto 8 de §5).
5. Só depois: ligar a conta na página (âmbito condomínio) → enviar um documento real → abrir e descarregar.
6. Opcional: criar a ligação de plataforma → escolher OneDrive como destino de backups → `executarBackup('manual')` → confirmar no painel «Cópias de segurança: ● Microsoft OneDrive» e «Último backup: ● Concluído».

### Critérios de aceitação
- `ONEDRIVE_ENABLED=false` → nenhuma operação usa OneDrive; `isConfigured` → `false`.
- Uma ligação de condomínio **não** herda a conta da plataforma (só o Drive admite esse *fallback*).
- Documento guardado com `od:` abre e descarrega; mudar o principal para Drive **não** o torna ilegível.
- Desligar remove só os tokens; os ficheiros permanecem no fornecedor.
- Falha de upload cloud de backup **preserva** a cópia local.
- Nenhuma mensagem de erro expõe tokens (`http.sanitizar`).
- Nenhum link público é criado.

### Riscos e limitações a declarar
- Pedir `User.Read` acrescenta uma linha ao ecrã de consentimento (mínima).
- Enquanto B2 não for corrigido, a retenção cloud de backups é um no-op no OneDrive.
- `Files.ReadWrite` (delegada) dá acesso a todo o OneDrive da conta, não a uma pasta — é o mínimo que a Graph oferece para escrita fora do AppFolder.
- OneDrive pessoal tem limites de quota.
- A verificação real depende de credenciais e de consentimento; **não pode ser substituída** por testes offline (B6).
