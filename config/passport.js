const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { User } = require('../models');

module.exports = (passport) => {
  passport.use(
    new LocalStrategy(
      { usernameField: 'email', passwordField: 'password' },
      async (email, password, done) => {
        try {
          const user = await User.findOne({ where: { email } });
          if (!user) {
            return done(null, false, { message: 'Esta conta não existe.' });
          }
          if (!user.ativo) {
            return done(null, false, { message: 'Conta desativada.' });
          }
          const match = await bcrypt.compare(password, user.password_hash);
          if (!match) {
            return done(null, false, { message: 'Palavra-passe incorreta.' });
          }
          await user.update({ last_login_at: new Date() });
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
