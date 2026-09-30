'use strict';
const path = require('node:path');
const { createAuthServer } = require('./auth.cjs');
const port = Number(process.env.PORT || 4174);
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.DATA_DIR) throw Error('DATA_DIR must point to a persistent disk.');
const server = createAuthServer({
  dbPath: path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'accounts.sqlite'),
  pepper: process.env.AUTH_PEPPER,
  origin: process.env.APP_ORIGIN, production
});
server.listen(port, production ? '0.0.0.0' : '127.0.0.1', () => console.log('APEX account server listening on port ' + port));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
