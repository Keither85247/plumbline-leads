# Call Lead Manager

A full-stack app that summarizes sales call transcripts using OpenAI and manages leads through a status pipeline.

## Prerequisites

- Node.js 18+
- An OpenAI API key ([get one here](https://platform.openai.com/api-keys))

## Setup

1. Install all dependencies from the project root:

```bash
npm run install:all
```

2. Add your OpenAI API key to `backend/.env`:

```
OPENAI_API_KEY=sk-proj-your-key-here
```

## Running

```bash
npm run dev
```

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3001

## How It Works

1. Paste a call transcript into the text area on the left
2. Click **Generate Summary & Save Lead**
3. The backend sends the transcript to GPT-4o-mini, which returns:
   - Contact name (extracted from the transcript)
   - A 2-3 sentence summary
   - Up to 3 key action items
4. The lead is saved to a local SQLite database (`backend/leads.db`)
5. The lead appears in the list on the right
6. Use the status dropdown on each lead card to move it through the pipeline:
   `New → Contacted → Qualified → Closed`

## API Reference

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/leads` | `{ transcript }` | Create lead from transcript |
| `GET` | `/api/leads` | — | Get all leads (newest first) |
| `PATCH` | `/api/leads/:id/status` | `{ status }` | Update lead status |

## Project Structure

```
call-lead-manager/
├── backend/
│   ├── .env            ← Add your OPENAI_API_KEY here
│   ├── db.js           ← SQLite setup
│   ├── index.js        ← Express server (port 3001)
│   └── routes/
│       └── leads.js    ← API handlers + OpenAI integration
└── frontend/
    └── src/
        ├── App.jsx
        ├── api.js
        └── components/
            ├── TranscriptForm.jsx
            ├── LeadList.jsx
            └── LeadCard.jsx
```
