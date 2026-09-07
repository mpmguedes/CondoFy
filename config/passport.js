const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { audit } = require('../helpers/audit');

function auditSafe(params) {
  return audit(params).catch(() => {});
}

module.exports = (passport) => {
  passport.use(
    new LocalStrategy(
      { usernameField: 'email', passwordField: 'password' },
      async (email, password, done) => {
        try {
          const user = await User.findOne({ where: { email } });
          if (!user) {
            await auditSafe({ userId: null, acao: 'login_falhou', entidade: 'User', detalhes: { email, motivo: 'conta_inexistente' } });
            return done(null, false, { message: 'Esta conta não existe.' });
          }
          if (!user.ativo) {
            await auditSafe({ userId: user.id, acao: 'login_falhou', entidade: 'User', entidadeId: user.id, detalhes: { email, motivo: 'conta_desativada' } });
            return done(null, false, { message: 'Conta desativada.' });
          }
          const match = await bcrypt.compare(password, user.password_hash);
          if (!match) {
            await auditSafe({ userId: user.id, acao: 'login_falhou', entidade: 'User', entidadeId: user.id, detalhes: { email, motivo: 'password_incorreta' } });
            return done(null, false, { message: 'Palavra-passe incorreta.' });
          }
          await user.update({ last_login_at: new Date() });
          await auditSafe({ userId: user.id, acao: 'inicio_sessao', entidade: 'User', entidadeId: user.id, detalhes: { email } });
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findByPk(id);
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  });
};
