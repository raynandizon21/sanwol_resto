# RESTO Python Server (`pyserver`)

Lightweight Python backend for analytics/reporting or heavy data processing
that complements the existing Node.js `server` folder.

## Setup

1. Create and activate a virtualenv (recommended):

```bash
cd pyserver
python -m venv .venv
source .venv/Scripts/activate  # Windows PowerShell: .venv\Scripts\Activate.ps1
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Run the server (default on port 8000):

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

You can check it at:

- `GET http://localhost:8000/health`
- `GET http://localhost:8000/api/analytics/sample`

## Next steps

- Add real analytics/reporting endpoints under `/api/analytics/*`.
- From your React app, call `http://localhost:8000/...` instead of the Node.js
  server for analytics that you want Python to handle.

