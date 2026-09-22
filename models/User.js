const { DataTypes } = require('sequelize');
const segredos = require('../helpers/segredos');

module.exports = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      email: { type: DataTypes.STRING(191), allowNull: false, unique: true },
      password_hash: { type: DataTypes.STRING(255), allowNull: true },
      nome: { type: DataTypes.STRING(191), allowNull: false },
      role: {
        type: DataTypes.ENUM('admin', 'condomino'),
        allowNull: false,
        defaultValue: 'condomino',
      },
      // Super Admin GLOBAL (independente dos papéis por condomínio).
      role_global: { type: DataTypes.ENUM('super_admin'), allowNull: true },
      // Confirmação de email (obrigatória antes de acesso normal).
      email_confirmado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      email_confirmado_at: { type: DataTypes.DATE, allowNull: true },
      telefone: { type: DataTypes.STRING(40), allowNull: true },
      // Convite de ativação (token único/expirável + estado).
      convite_token: { type: DataTypes.STRING(255), allowNull: true },
      convite_token_expira: { type: DataTypes.DATE, allowNull: true },
      convite_estado: {
        type: DataTypes.ENUM('pendente', 'enviado', 'aceite', 'expirado', 'revogado'),
        allowNull: true,
      },
      // provider prepara a autenticação para OAuth/Google no futuro,
      // sem reescrever o sistema de utilizadores.
      provider: {
        type: DataTypes.ENUM('local', 'google'),
        allowNull: false,
        defaultValue: 'local',
      },
      google_id: { type: DataTypes.STRING(191), allowNull: true },
      pessoa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      // 2FA por código de email OU aplicação autenticadora (TOTP).
      two_fa_ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      two_fa_metodo: { type: DataTypes.ENUM('email', 'totp'), allowNull: false, defaultValue: 'email' },
      // Segredo TOTP — guardado CIFRADO em repouso (AES-256-GCM; ver
      // helpers/segredos.js). O acesso é transparente: `user.two_fa_totp_secret`
      // devolve sempre o segredo em claro e qualquer escrita cifra, pelo que
      // nenhum ponto do código (ativar, verificar, desativar) precisa de saber
      // disto. A coluna é STRING(255) porque o formato cifrado
      // (`enc:v1:<kid>:<iv>:<tag>:<ct>`) ocupa ~97 caracteres para um segredo
      // Base32 de 32 — não caberia em STRING(64).
      //
      // Sem ENCRYPTION_KEY o valor é guardado em texto simples (comportamento
      // anterior, sem regressão) e é emitido um aviso administrativo; um valor
      // antigo em texto simples continua a ser lido e passa a cifrado na
      // escrita seguinte.
      two_fa_totp_secret: {
        type: DataTypes.STRING(255),
        allowNull: true,
        get() {
          return segredos.lerTotp(this.getDataValue('two_fa_totp_secret')).valor;
        },
        set(valor) {
          this.setDataValue('two_fa_totp_secret', segredos.protegerTotp(valor));
        },
      },
      two_fa_email_codigo_hash: { type: DataTypes.STRING(64), allowNull: true },
      two_fa_email_codigo_expira: { type: DataTypes.DATE, allowNull: true },
      two_fa_email_tentativas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      two_fa_recovery_hash: { type: DataTypes.TEXT, allowNull: true },
      reset_token: { type: DataTypes.STRING(255), allowNull: true },
      reset_token_expires: { type: DataTypes.DATE, allowNull: true },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'users', underscored: true }
  );
  return User;
};
