# Google Drive no CondoFy

Esta página descreve como ativar a integração com o **Google Drive**: criar as
credenciais no Google Cloud Console, configurar o `.env` e ligar a conta Google
na aplicação.

## Como funciona

1. O administrador abre **Configuração → Google Drive** e clica em
   **Ligar Google Drive**.
2. A aplicação envia-o para o Google (OAuth 2.0, *scope* mínimo
   `drive.file` — só ficheiros criados/abertos pela aplicação).
3. Após autorizar, o Google redireciona para `GOOGLE_REDIRECT_URI`.
4. O backend troca o código pelos tokens e **guarda-os na base de dados**
   (tabela `configuracoes`, chave `google_drive_tokens`) — nunca no browser.
5. A partir daí, os documentos gerados (convocatórias, atas, anexos,
   documentos do condomínio e backups) podem ser guardados no Drive.
6. Para desligar: **Configuração → Google Drive → Desligar** (pede
   confirmação; os ficheiros já no Drive **não** são apagados).

### Estrutura de pastas

A aplicação cria (uma única vez, reutilizando se já existirem):

```
CondoFy/
├── <ano>/
│   ├── Assembleias/   (atas, convocatórias, anexos)
│   ├── Quotas/
│   ├── Recibos/
│   ├── Despesas/
│   ├── Contratos/
│   └── Outros/
└── Backups/
```

A pasta raiz pode ser alterada com `GOOGLE_DRIVE_ROOT_FOLDER` no `.env`.
As pastas são encontradas pelo nome — nunca são criadas duplicadas quando se
volta a ligar a conta.

## 1. Configuração no Google Cloud Console

1. Crie um **projeto** em <https://console.cloud.google.com> (ou use um existente).
2. Ative a **Google Drive API**:
   * APIs e Serviços → Biblioteca → procure **Google Drive API** → Ativar.
3. Configure o **ecrã de consentimento OAuth**:
   * APIs e Serviços → Ecrã de consentimento OAuth.
   * Tipo de utilizador: **Externo** (ou Interno, se usar Workspace).
   * Preencha o nome da aplicação e o email de suporte.
   * Em *Âmbitos (scopes)* pode adicionar apenas
     `https://www.googleapis.com/auth/drive.file` (opcional; a aplicação
     pede este scope automaticamente).
   * Em *Utilizadores de teste*, adicione a conta Google que vai ligar
     (necessário enquanto a aplicação estiver em modo de teste).
4. Crie as **credenciais OAuth 2.0**:
   * APIs e Serviços → Credenciais → **Criar credenciais → ID do cliente OAuth**.
   * Tipo de aplicação: **Aplicação Web**.
   * Em **URIs de redirecionamento autorizados** adicione **exatamente** o
     valor de `GOOGLE_REDIRECT_URI` que vai usar, por exemplo:
     * Desenvolvimento: `http://localhost:3000/admin/config/drive/callback`
     * Produção: `https://condofy.exemplo.pt/admin/config/drive/callback`
   * Guarde o **Client ID** e o **Client Secret**.

## 2. Configuração no `.env`

Copie `.env.example` para `.env` e preencha (nunca faça commit destes valores):

```env
GOOGLE_DRIVE_ENABLED=true
GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
GOOGLE_REDIRECT_URI=http://localhost:3000/admin/config/drive/callback
```

> **Desenvolvimento vs. produção:** use valores diferentes de
> `GOOGLE_REDIRECT_URI` em cada ambiente, e registe cada um deles na consola
> Google. As credenciais reais vivem apenas no `.env` (fora do Git).

### Variáveis disponíveis

| Variável | Obrigatória | Descrição |
|---|---|---|
| `GOOGLE_DRIVE_ENABLED` | Sim (`true`) | Liga/desliga a integração |
| `GOOGLE_CLIENT_ID` | Sim | Client ID OAuth (Google Cloud) |
| `GOOGLE_CLIENT_SECRET` | Sim | Client Secret OAuth (Google Cloud) |
| `GOOGLE_REDIRECT_URI` | Sim | Redirect URI registado na consola Google |
| `GOOGLE_REFRESH_TOKEN` | Não (legado) | Permite ligação direta sem fluxo OAuth na aplicação |
| `GOOGLE_DRIVE_ROOT_FOLDER` | Não | Pasta raiz no Drive (padrão: `CondoFy`) |

## 3. Ligar a conta na aplicação

1. Inicie o servidor e entre como administrador.
2. **Configuração → Google Drive**.
3. Clique em **Ligar Google Drive** e autorize a conta na janela do Google.
4. É devolvido à aplicação com o estado **Ligado**.

Quando o *access token* expirar, a aplicação renova-o automaticamente com o
*refresh token*. Se a autorização for revogada (ou o refresh token ficar
inválido), a aplicação remove a ligação e pede que **ligue novamente**.

## 4. Desligar

Em **Configuração → Google Drive → Desligar** (com confirmação):

* a associação à conta Google é removida;
* os tokens guardados são invalidados/apagados da base de dados;
* **não são apagados** os ficheiros que já estão no Google Drive.

Para voltar a ligar mais tarde, basta clicar em **Ligar Google Drive**.

> **Modo legado (`.env`):** se existir `GOOGLE_REFRESH_TOKEN` no `.env`, a
> integração funciona sem conta ligada na aplicação. Para desligar
> completamente nesse modo, remova a variável do `.env` (ou ligue a conta pela
> aplicação, que passa a ter prioridade).

## Segurança

* Client ID/Secret e tokens nunca são colocados no código nem no frontend.
* Os tokens ficam apenas na base de dados do servidor.
* A aplicação pede apenas o scope `drive.file` (menor privilégio) — sem acesso
  a Gmail, contactos, calendário ou à Drive inteira.
* Não são usadas credenciais reais no repositório; o `.env` está no
  `.gitignore`.
