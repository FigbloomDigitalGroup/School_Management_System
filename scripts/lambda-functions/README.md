# Schools' edge functions on AWS Lambda

Builds every function in `supabase/functions` as its own Lambda package, **unchanged**, for figbloom-platform's
`SchoolsFunctions-<env>` stack (moving Schools off Supabase).

```
npm ci --prefix scripts/lambda-functions
npm run build --prefix scripts/lambda-functions     # -> dist/lambda-functions/<name>/index.js + manifest.json
```

- `adapter.ts` does what the edge runtime did:
  - **Settings.** On a cold start it reads the server's keys and the `function-settings` secret from Secrets Manager. These are the same two entries the database server's edge runtime uses today, so no values move. Then it gives the function a `Deno` with `env.get` and `serve`.
  - **Token checks.** It checks the JWT where `config.toml` says `verify_jwt` (true when not listed, as on Supabase).
  - **Request and response.** It turns API Gateway events into `Request`s and the function's `Response` back.
  - **Caller address.** It writes the caller's address from API Gateway into `x-forwarded-for`, so the rate limits can't be fooled.
- `build.mjs` bundles each function with esbuild. `npm:pkg@x.y.z` imports come from this folder's `node_modules`, and the build stops if the installed version differs, so keep `package.json` in step with the functions' imports. The AWS SDK is the Lambda runtime's own.
- The functions still run on the database server's edge runtime too, until the apps and outside callers are switched over.
