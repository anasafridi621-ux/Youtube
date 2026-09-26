'use strict';
/**
 * scripts/authorize.js
 * ---------------------------------------------------------------------------
 * One-time Google authorization for the owner account.
 *
 * Starts a loopback server on 127.0.0.1 (random port, 5-minute timeout),
 * prints an authorization URL, captures the redirect, and persists the token
 * bundle server-side to config/tokens.json with 0600 permissions.
 *
 * Works over SSH: open the printed URL on any machine where you are signed in
 * as the owner.
 *
 * Usage:  npm run auth
 */

require('dotenv').config({ quiet: true });

const { config, validate } = require('../config');
const { Logger } = require('../services/logger');
const { GoogleAuthService } = require('../services/google-auth-service');

const log = new Logger('auth', { dir: config.logging.dir });

async function main() {
  const { problems, warnings } = validate(config);
  for (const w of warnings) log.warn(`config: ${w}`);

  if (problems.length) {
    console.error('\nFix these first:');
    for (const p of problems) console.error(`  - ${p}\n`);
    process.exit(1);
  }

  if (!config.youtube.clientId || !config.youtube.clientSecret) {
    console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
    process.exit(1);
  }

  const auth = new GoogleAuthService({ logger: log });

  console.log('\nRequesting these scopes:');
  for (const s of config.google.scopes) console.log(`  - ${s}`);
  console.log(`\nOnly these addresses may sign in: ${config.auth.ownerEmails.join(', ')}\n`);

  const tokens = await auth.authorizeViaLoopback();

  console.log('\nAuthorized. Tokens saved to:');
  console.log(`  ${config.youtube.tokenFile}`);
  console.log('\nScopes granted:');
  console.log(`  ${(tokens.scope || '').split(/\s+/).filter(Boolean).join('\n  ')}`);
  console.log(`\nRefresh token present: ${Boolean(tokens.refresh_token)}`);
  console.log('\nYou can now start the app with:  npm start\n');
}

main().catch((err) => {
  console.error(`\nAuthorization failed: ${err.message}\n`);
  process.exit(1);
});
