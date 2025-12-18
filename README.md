# Telemetry Upload Server

Node.js Express server to handle large telemetry file uploads (up to 500MB).

## Setup

1. **Install dependencies:**
```bash
cd server
npm install
```

2. **Start the server:**
```bash
npm run dev
```

The server will run on `http://localhost:3001`

## Endpoints

### `GET /health`
Health check endpoint
- **Response:** `{ "status": "ok", "message": "Upload server is running" }`

### `POST /api/upload-telemetry`
Upload telemetry file
- **Headers:** 
  - `Authorization: Bearer <your-supabase-token>`
- **Body (FormData):**
  - `file`: The telemetry file
  - `stintId`: UUID of the stint
  - `filePath`: Target path in Supabase Storage

## Configuration

- **Port:** Set via `SERVER_PORT` env variable (default: 3001)
- **Max file size:** 500MB
- **Allowed origins:** localhost:8080, localhost:5173

## How It Works

1. Client uploads file to this server (bypasses browser limits)
2. Server temporarily stores file in `uploads/` directory
3. Server uploads to Supabase Storage with proper authentication
4. Temporary file is deleted
5. Stint status is updated in database
