# Cloudflare deployment

The dashboard runs at https://bantay-barangay.bantay-research.workers.dev in the project's Cloudflare account. The three barangay accounts use the same credentials supplied in the private local account handoff file. Existing station records, incidents, and responses were copied to the standalone D1 database during migration.

The `wrangler.cloudflare.jsonc` file selects the deployed Worker, database, static assets, and Drizzle migration directory. Build output is generated under `dist/`.

To update this deployment, run these commands from this directory.

```text
npm run build
node --import ./scripts/sites-env.mjs node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote --config wrangler.cloudflare.jsonc
node --import ./scripts/sites-env.mjs node_modules/wrangler/bin/wrangler.js deploy --config wrangler.cloudflare.jsonc
```

Sign in with `node node_modules/wrangler/bin/wrangler.js login` if local authorization expires. Keep `SESSION_SECRET`, `DESKTOP_TOKEN`, and `ACCOUNT_CREDENTIALS_JSON` configured as Worker secrets. The ignored `.sites-runtime/demo-secrets.json` contains the current values for this demonstration.

The desktop's **Remote dashboard** connection points to the deployed origin. Browser sessions are scoped to their hostname, so sign in again when moving to this address. The website receives current evidence and prompts while the desktop publishes, and polls while the page is open and visible.
