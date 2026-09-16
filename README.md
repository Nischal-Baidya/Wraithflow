# WraithFlow

WraithFlow is a static, vanilla JavaScript Progressive Web App backed by Supabase.

## Run locally

Serve this folder over `http://localhost:8080` (not `file://`) so authentication redirects and the service worker work. For example, use any static-file server configured to that port. Your Supabase Site URL and redirect URL already permit it.

## Security model

`js/config.js` contains only the public Supabase URL and publishable browser key. It must never contain a service-role key, database password, Google client secret, or other privileged credential. RLS and private Storage policies enforce account isolation.

## Deployment to Vercel

1. Import this folder into a Vercel project as a static site; no framework preset or server is required.
2. Deploy.
3. In Supabase Authentication URL Configuration, replace/add the deployed `https://…vercel.app/**` URL as a Redirect URL and use its origin for Site URL when it becomes the production canonical URL.
4. Keep Google OAuth disabled until its Google Cloud and Supabase provider configuration is complete.

## Offline behavior

After an online first load, the service worker caches the application shell. IndexedDB stores each authenticated user’s local records, queued mutations, local journal-photo blobs, and unresolved conflicts. Supabase remains the cloud source of truth.
