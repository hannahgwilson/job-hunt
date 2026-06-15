# Job Hunt — Tracking Hub (web)

A Vite + React SPA that is the read/write surface for the job-hunt pipeline. It
talks to Supabase **directly** via `supabase-js` — no MCP in the data path:

- **Reads** are RLS-scoped selects + two read RPCs (`get_action_queue`,
  `get_funnel_metrics`).
- **Writes** are the transactional RPCs (`intake_role`, `submit_application`,
  `advance_application`) — the same functions the MCP wraps, so the app and the
  agent share one implementation.

The anon (publishable) key is safe in the client: Row Level Security scopes every
query to the signed-in user, and the RPCs default `p_user_id` to `auth.uid()`.

## Pages

| Route | What |
|---|---|
| `/` | Dashboard — counts, status breakdown, next interviews |
| `/pipeline` | Kanban by status (Realtime), posting links, one-click advance, **+ Add a role** |
| `/queue` | Action queue — roles to apply, follow-ups, interviews, networking |
| `/funnel` | Conversion + median time-in-stage from `application_status_history` |
| `/role/:id` | Stage-history timeline + interviews with go/no-go decisions |

## Run

```bash
cp .env.example .env.local   # fill in your project URL + anon key
npm install
npm run dev                  # http://localhost:5173
npm run build                # production build to dist/
```

You must be able to sign in as the Supabase Auth user whose `auth.uid()` matches
the data's `user_id` (the same id the MCP uses as `DEFAULT_USER_ID`). Magic-link
sign-in is wired up on the login screen.

## Adding a role

The **+ Add a role** form calls `intake_role` (find-or-create org + posting in
one transaction), optionally marking it applied. To auto-fill from a job link,
paste the link to Claude and ask it to intake the role — enrichment is the
agent's job; both paths land in the same RPC.
