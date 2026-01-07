# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KhunPai is a LINE chatbot for bill splitting in group chats. Users can create shared bills, select participants, and track payment status via payment slip QR code scanning.

## Tech Stack

- **Runtime**: Node.js with ES modules
- **Framework**: Express.js 5.x
- **Messaging**: LINE Bot SDK (@line/bot-sdk)
- **Database**: PostgreSQL (pg)
- **Image Processing**: canvas + jsQR for QR code detection
- **Frontend**: LIFF (LINE Front-end Framework) for in-app web views

## Commands

```bash
# Start the server
node index.js

# Test database connection
node test-db.js
```

No test suite is configured.

## Architecture

### Entry Point
- `index.js` - Express server with LINE webhook handler and REST API endpoints

### Services (`services/`)
- `billService.js` - Bill creation operations
- `imageService.js` - Image processing and QR code extraction from payment slips

### Database (`db.js`)
- PostgreSQL connection pool using environment variables (PG_USER, PG_HOST, PG_DATABASE, PG_PASSWORD, PG_PORT)

### Frontend (`liff/`)
- `index.html` - LIFF web app for bill creation UI, served at `/liff`

### Database Schema (inferred from queries)
- `group_members` - LINE group member tracking (group_id, user_id, display_name, picture_url, joined_at)
- `bills` - Bill records (group_id, title, pay_type, total, created_at)
- `bill_participants` - Bill participant records (bill_id, member_id, amount_due, paid)

## Key Features

### LINE Bot Commands
- `/create-bill` - Opens LIFF web app to create a new bill
- `/member-list` - Lists registered group members
- `/status` - Shows latest bill status with payment tracking
- `test` - Server health check

### Auto-registration
Members are automatically registered when they send any message in the group (extracts profile from LINE API).

### Payment Verification
Image messages are processed to detect QR codes from payment slips (PromptPay format). The slip processing logic is partially implemented.

## API Endpoints

- `POST /webhook` - LINE webhook handler
- `GET /api/group-members?groupId=` - Get members for a group
- `POST /api/bill` - Create a new bill with participants

## Environment Variables

Required in `.env`:
- `CHANNEL_SECRET` - LINE channel secret
- `CHANNEL_ACCESS_TOKEN` - LINE channel access token
- `LIFF_ID` - LINE LIFF app ID
- `PG_USER`, `PG_HOST`, `PG_DATABASE`, `PG_PASSWORD`, `PG_PORT` - PostgreSQL connection
- `PORT` - Server port (default: 3000)
