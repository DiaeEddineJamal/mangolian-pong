# Mangolian Pong

A standalone Next.js Pong game with local multiplayer and private online rooms.
The online mode shares the Lmogolyan Kart Socket.IO server and room-code flow.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3001](http://localhost:3001) with your browser.

Copy `.env.example` to `.env.local` when the arcade or multiplayer server run at
different URLs.

## Environment

- `NEXT_PUBLIC_ARCADE_URL` — portal URL; defaults to `http://localhost:3010`.
- `NEXT_PUBLIC_RACING_SERVER_URL` — shared Socket.IO server; defaults to `http://localhost:3000`.
