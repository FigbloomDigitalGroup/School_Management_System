# Content-Security-Policy (apps/web/vercel.json)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

`apps/web/vercel.json` sends a `Content-Security-Policy` header on every page (`/(.*)`). This is the first CSP the site has
had, and it is enforced. `connect-src` allows `https://sms-api.figbloom.org` alongside Supabase (`https://*.supabase.co`,
`wss://*.supabase.co`), LiveKit (`https://*.livekit.cloud`, `wss://*.livekit.cloud`) and the Google origins, so both the
API build and the Supabase build keep working.

- **Google Maps and Drive** (bus map, home pin picker, Drive attachments): scripts, images and connections are allowed from
  `*.googleapis.com`, `*.gstatic.com` and `*.google.com`, as Google's own CSP guide says. A narrower list breaks the map,
  because the Maps script loads more files from `maps.gstatic.com`.
- **No inline scripts** (`script-src` has no `'unsafe-inline'` and no `'unsafe-eval'`). Inline styles are allowed because the
  UI uses style attributes.
- **Not known from the repo:** the production Supabase address. `https://*.supabase.co` only matches a hosted project. If
  production uses a custom domain, add it to `connect-src`, `img-src`, `media-src` and `frame-src` before merging.
- **Still to add** when presigned storage uploads are wired up: the S3 (or CDN) origin in `connect-src`, `img-src` and
  `media-src`.
- **Checked:** the policy parses and the header tests pass. **Not checked:** a signed-in browser pass with the header on
  (maps, Drive, calls, videos). Open the Vercel preview of the PR and watch the console for "Refused to ..." messages before
  merging.
