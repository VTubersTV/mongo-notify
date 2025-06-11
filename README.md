# MongoDB Change Notification Service

A real-time notification service that monitors MongoDB changes and broadcasts them to connected clients via WebSocket. The service also provides a diff calculation endpoint for comparing JSON objects.

## Features

- Real-time MongoDB change notifications via WebSocket
- JSON object diff calculation with multiple output formats
- Secure token-based WebSocket authentication with HMAC
- Rate limiting to prevent abuse
- Timestamp validation to prevent replay attacks
- Configurable MongoDB connection

## Prerequisites

- Node.js 18 or higher
- MongoDB instance
- pnpm 10.11.1 or higher

## Installation

1. Clone the repository:
```bash
git clone https://github.com/vtuberstv/mongo-notify.git
cd mongo-notify
```

2. Install dependencies:
```bash
pnpm install
```

3. Create a `.env` file:
```env
MONGODB_URI=mongodb://localhost:27017
TOKEN=your-secure-token-here
PORT=8080
```

## Usage

### Development

Start the development server:
```bash
pnpm dev
```

The server will be available at `http://localhost:8080`.

### Production

Build and start the production server:
```bash
pnpm build
pnpm start
```

## API Endpoints

### Calculate Diff
```http
POST /diff?type=<format>
Content-Type: application/json

Body:
{
  "old": object,
  "new": object
}

Query Parameters:
- type: Output format (json, git, plain, compact, summary)
```

### WebSocket Connection
```http
GET /ws?_internalToken=<token>&time=<timestamp>
```

The WebSocket connection requires:
- A valid HMAC token generated using the server's TOKEN
- A current timestamp (within 5 minutes)
- Rate limit compliance (max 5 connections per IP per minute)

## WebSocket Events

### Server Events
- `db_change`: Broadcasts MongoDB change events to all connected clients

## Security Features

- HMAC-based token validation
- Timestamp validation to prevent replay attacks
- Rate limiting per IP address
- Secure WebSocket upgrade handling
- Proper error handling and logging
- Environment variable configuration

## Directory Structure

```
mongo-notify/
├── src/
│   └── server.ts
├── package.json
└── tsconfig.json
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the AGPL-3.0 License and the VTubers.TV Commercial License (VCL) v1.0. See the [LICENSE](./LICENSE) and [LICENSE-VCL](./LICENSE-VCL.md) files for details.


