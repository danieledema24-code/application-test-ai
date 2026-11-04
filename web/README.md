# Application Test AI — web frontend

Next.js 15 (App Router, TypeScript) + Tailwind CSS v4, SWR, recharts, lucide-react.
Talks to the REST API described in `../docs/API.md`.

```bash
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:4000/api
npm install
npm run dev                  # http://localhost:3000
npm run build && npm start   # production
npm run lint
```

Layout: `src/lib` (api client, types, auth, formatting), `src/components/ui` (design-system
primitives incl. the single `StatusPill`), `src/components/{domain,project,run,assistant,layout}`,
`src/app/(auth)` public pages and `src/app/(app)` authenticated pages.
