# Architecture Overview
This document provides a comprehensive understanding of the codebase's architecture, enabling efficient navigation and effective contribution.

## 1. Project Structure

```
agentic-inbox/
├── app/                      # React Router v7 frontend (SSR on the Worker)
│   ├── root.tsx, routes.ts, entry.server.tsx
│   ├── routes/               # home, mailbox, email-list, search-results, settings, not-found
│   ├── components/           # Sidebar, Header, EmailPanel, Compose*, AgentPanel, MCPPanel, ImportMail, RichTextEditor
│   │   └── email-panel/      # Thread/single-message views, toolbar, dialogs
│   ├── queries/              # TanStack Query hooks (emails, folders, mailboxes, search)
│   ├── services/api.ts       # Typed fetch client for /api/v1
│   ├── hooks/                # useUIStore (Zustand), useComposeForm
│   └── lib/, types/
├── workers/                  # Cloudflare Worker backend
│   ├── app.ts                # Entry: Access JWT check, agent routing, API, React Router fallback
│   ├── index.ts              # Hono REST API + inbound email handler (receiveEmail)
│   ├── routes/reply-forward.ts
│   ├── durableObject/        # MailboxDO (per-mailbox SQLite) and migrations
│   ├── db/schema.ts          # Drizzle schema: folders, emails, attachments
│   ├── agent/                # EmailAgent (chat agent, Workers AI)
│   ├── mcp/                  # EmailMCP (MCP server)
│   ├── lib/                  # ai, triage, tools, attachments, email-helpers, mailbox, schemas
│   ├── email-sender.ts, types.ts
├── shared/                   # Code shared by client and worker: dates, folders, triage, mbox
├── tests/                    # node:test unit tests (mbox, triage)
├── .github/workflows/        # checks, pr-checks, deploy
├── wrangler.jsonc            # Worker, bindings, DO migrations
└── vite.config.ts, react-router.config.ts, tsconfig*.json
```

## 2. High-Level System Diagram

```
 Browser (React SPA/SSR)                     Email Routing (inbound)
   │  /api/v1, agent WebSocket, /mcp                 │ email() event
   ▼                                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ Worker (workers/app.ts)                                      │
│  Cloudflare Access JWT ─► Hono API (workers/index.ts)        │
│                        ─► routeAgentRequest (agents)         │
│                        ─► React Router request handler       │
└───────┬───────────────────┬──────────────────┬───────────────┘
        │                   │                  │
        ▼                   ▼                  ▼
  MailboxDO (SQLite)    EmailAgent DO      EmailMCP DO
  one per mailbox       chat + tools       MCP tools for
  folders/emails/       (Workers AI)       external clients
  attachments
        │
        ├──► R2 bucket (attachments, raw blobs)
        ├──► Workers AI (triage, drafts, agent model)
        └──► send_email binding (outbound mail)
```

## 3. Core Components

### 3.1. Frontend

**Description**: Mailbox UI with folder sidebar, split list/reader view, threaded reading, rich-text compose, search, AI agent side panel, MCP panel, and Settings (including mbox import).

**Technologies**: React 19, React Router v7, Tailwind CSS, Zustand, TanStack Query, TipTap, `@cloudflare/kumo`, DOMPurify (sandboxed iframe for message bodies).

**Key Files/Directories**: `app/routes/`, `app/components/`, `app/services/api.ts`, `app/queries/`.

### 3.2. REST API and inbound mail

**Description**: Hono app mounted under `/api/v1`. Mailbox-scoped routes run through `requireMailbox`. Covers mailboxes, emails, drafts, threads, reply/forward, folders, search, attachments, and `POST /mailboxes/:id/import` (raw RFC 822 message, keeps original date, skips triage/auto-draft/forwarding, de-duplicates by Message-ID or content hash). `receiveEmail` parses inbound mail with PostalMime, stores attachments in R2, writes to the mailbox DO, then triages and optionally auto-drafts or forwards.

**Technologies**: Hono, postal-mime, Drizzle, Zod.

**Key Files/Directories**: `workers/index.ts`, `workers/routes/reply-forward.ts`, `workers/lib/`, `workers/email-sender.ts`.

### 3.3. MailboxDO

**Description**: SQLite-backed Durable Object, one per mailbox, owning folders, emails, threads, attachment metadata, search, and import (`isImported`, `hasFolder`, `importEmail`).

**Technologies**: Durable Objects (SQLite), Drizzle.

**Key Files/Directories**: `workers/durableObject/index.ts`, `workers/durableObject/migrations.ts`, `workers/db/schema.ts`.

### 3.4. EmailAgent

**Description**: Chat agent that reads mail and drafts replies using Workers AI tools.

**Technologies**: `agents`, `@cloudflare/ai-chat`, `ai` SDK, `workers-ai-provider` (model `@cf/zai-org/glm-5.3`).

**Key Files/Directories**: `workers/agent/index.ts`, `workers/lib/tools.ts`.

### 3.5. EmailMCP

**Description**: MCP server exposing mailbox tools (list, read, search, draft, send, move, mark read, delete) to external MCP clients.

**Technologies**: `agents/mcp` (`McpAgent`).

**Key Files/Directories**: `workers/mcp/index.ts`, `workers/lib/tools.ts`.

### 3.6. Triage and AI helpers

**Description**: Classifies mail (category, action required, summary), drafts replies, and cleans model output.

**Technologies**: Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`, `@cf/meta/llama-4-scout-17b-16e-instruct`).

**Key Files/Directories**: `workers/lib/ai.ts`, `workers/lib/triage.ts`, `shared/triage.ts`.

### 3.7. Mbox import

**Description**: Browser-side mbox splitter streams a user-selected file into messages and uploads them one at a time (4 in parallel, large messages serially) with retry on 5xx/429. A file is treated as mbox only when its first line is a `From ` separator; otherwise it uploads as a single `.eml`.

**Key Files/Directories**: `shared/mbox.ts`, `app/components/ImportMail.tsx`, `tests/mbox.test.ts`.

## 4. Data Stores

### 4.1. MailboxDO SQLite

**Type**: Durable Object SQLite (one database per mailbox).

**Purpose**: All message metadata and bodies for a mailbox.

**Key Schemas/Models**: `folders`, `emails` (including thread, message-id, raw headers, triage columns), `attachments`, `d1_migrations`.

### 4.2. R2 bucket `agentic-inbox`

**Type**: Object storage (binding `BUCKET`).

**Purpose**: Attachment blobs at `attachments/<emailId>/<attId>/<filename>`; mailbox configuration.

## 5. External Integrations

| Service | Purpose | Integration Method |
|---------|---------|-------------------|
| Cloudflare Email Routing | Inbound mail | Worker `email()` handler |
| Cloudflare `send_email` | Outbound mail | `EMAIL` binding (remote) |
| Workers AI | Triage, drafting, agent | `AI` binding, `workers-ai-provider` |
| Cloudflare Access | Authentication | JWT validation with `jose` |
| R2 | Attachments | `BUCKET` binding |

## 6. Deployment & Infrastructure

**Platform**: Cloudflare Workers with Durable Objects (`MailboxDO`, `EmailAgent`, `EmailMCP`), R2 and Workers AI.

**CI/CD**: GitHub Actions. `pr-checks.yml` runs `checks.yml` (typecheck, `npm test`, build; Node 24) on PRs to `mail.dxnd.ai`. `deploy.yml` runs checks and then deploys on pushes to `mail.dxnd.ai` or manual dispatch, using the `production` environment.

**Key Config Files**: `wrangler.jsonc`, `.github/workflows/*.yml`, `.dev.vars.example`, `vite.config.ts`, `react-router.config.ts`.

## 7. Security Considerations

**Authentication**: Cloudflare Access JWT (`POLICY_AUD`, `TEAM_DOMAIN`) validated in `workers/app.ts`; fails closed outside local development.

**Authorization**: Access is the trust boundary. API routes are mailbox-scoped through `requireMailbox`.

**Key Security Files**: `workers/app.ts`, `workers/lib/mailbox.ts`, `app/components/EmailIframe.tsx` (DOMPurify and sandboxed iframe for HTML mail), `workers/lib/attachments.ts`.

## 8. Development Environment

**Prerequisites**: Node.js 24, a Cloudflare account for deploy.

**Setup**: `npm ci`, copy `.dev.vars.example` to `.dev.vars`, `npm run dev`. See `README.md`.

**Testing**: `npm test` (node:test with `--experimental-strip-types`).

**Code Quality**: `npm run typecheck` (`wrangler types`, `react-router typegen`, `tsc -b`). [No linter or formatter detected - update manually]

## 9. Project Identification

**Project Name**: agentic-inbox

**Repository**: https://github.com/djandrewgibbons/agentic-inbox

**Last Updated**: 2026-11-22
