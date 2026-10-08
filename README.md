# RestoAdmin Dashboard

A modern, responsive restaurant administration dashboard featuring inventory management, category tracking, and sales analytics.

## Demo Credentials (Local Development)

To access the dashboard locally, use the following credentials on the login page:

- **Username:** `admin`
- **Password:** `123`

## Developer

**Developed by 3Core Leaderstech**

## Getting Started

1. Clone the repository
2. Copy `.env.example` to `.env` and set `DB_PASSWORD` (the database is `sanwol_resto`)
3. Install dependencies:
   - `npm install` (frontend)
   - `cd server && npm install` (Node API)
   - `cd pyserver && python -m venv .venv && .venv\Scripts\python -m pip install -r requirements.txt` (analytics server)
4. Run `npm run dev:all` to start all three services
5. Open `http://localhost:3000` in your browser

## Local host

The project runs on **localhost only** for now:

| Service          | URL                     |
|------------------|-------------------------|
| Frontend (Vite)  | `http://localhost:3000` |
| Node API         | `http://localhost:2000` |
| Python analytics | `http://localhost:2100` |

`server.allowedHosts` in `vite.config.ts` is set to `['localhost']`. When the
project gets a production domain, add it there (e.g. `['localhost', 'example.com']`).
Access by IP address on the local network (e.g. `http://192.168.x.x:3000`) still works.

After changing `vite.config.ts`, restart `npm run dev:all`. Vite does not reload
its own config.

## "All Branches" scope

Branches come from the `branches` table; none are hard-coded. When
**All Branches** is selected, the Dashboard and all Sales Report pages count
every branch except **3Core (IDNo 4)**, the developer/testing branch. 3Core
still shows its own data when selected on its own. A newly created branch is
included automatically.

| IDNo | Code      | Branch           | All Branches? |
|------|-----------|------------------|---------------|
| 4    | Developer | 3Core            | No (testing)  |
| 14   | BR001     | Sanwol BBQ Resto | Yes           |

Per-branch options (business-day cutoff, multi-floor tables, cents display,
dine-in service charge) are off for every branch by default and are switched
on by branch ID.

See `.claude/skills/branch-scope/SKILL.md` for where each setting lives and
the rules for writing branch-aware queries.
