# Application Test AI — web frontend

Next.js 15 (App Router, TypeScript) + Tailwind CSS v4, SWR, recharts, lucide-react.
Talks to the QA Analyst backend (`../backend`, port 8200) described in `../docs/architecture/api-contracts.md`.

```bash
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:8200
npm install
npx next dev -p 3002         # http://localhost:3002
npm run build && npm start   # production
npm run lint
```

Layout: `src/lib` (api client, types, auth, formatting), `src/components/ui` (design-system
primitives incl. the single `StatusPill`), `src/components/{domain,project,run,assistant,layout}`,
`src/app/(auth)` public pages and `src/app/(app)` authenticated pages.
