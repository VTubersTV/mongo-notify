import http, { IncomingMessage, ServerResponse } from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import { MongoClient, ChangeStream } from 'mongodb'
import { parse as parseUrl } from 'url'
import { config } from 'dotenv'
import crypto from 'crypto'
config()

const { MONGODB_URI, TOKEN, PORT = '8080' } = process.env

if (!MONGODB_URI) {
  throw new Error('MONGODB_URI is not set\n\nNeeded for the MongoDB connection')
}
if (!TOKEN) {
  throw new Error('TOKEN is not set\n\nNeeded for the WebSocket server to be secure')
}

const MONGO_URI = MONGODB_URI
const PORT_NUMBER = parseInt(PORT, 10)

const activeSockets = new Set<WebSocket>()

// Rate limiting
const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const MAX_CONNECTIONS_PER_IP = 5
const ipConnections = new Map<string, { count: number; resetTime: number }>()

function validateToken(token: string | null, timestamp: string | null): boolean {
  if (!token || !timestamp || !TOKEN) return false
  
  // Validate timestamp is within 5 minutes
  const timestampNum = parseInt(timestamp, 10)
  if (isNaN(timestampNum)) return false
  
  const now = Date.now()
  if (Math.abs(now - timestampNum) > 5 * 60 * 1000) return false
  
  // Validate token using HMAC
  const expectedToken = crypto
    .createHmac('sha256', TOKEN)
    .update(timestamp)
    .digest('hex')
  
  return crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(expectedToken)
  )
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const connectionInfo = ipConnections.get(ip)
  
  if (!connectionInfo || now > connectionInfo.resetTime) {
    ipConnections.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW })
    return true
  }
  
  if (connectionInfo.count >= MAX_CONNECTIONS_PER_IP) {
    return false
  }
  
  connectionInfo.count++
  return true
}

function broadcast(data: unknown): void {
  const payload = JSON.stringify(data)
  for (const ws of activeSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
    }
  }
}

type DiffEntry =
  | { type: 'added'; path: string; value: unknown }
  | { type: 'removed'; path: string; value: unknown }
  | { type: 'changed'; path: string; from: unknown; to: unknown }

function generateDiff(obj1: any, obj2: any, path = ''): DiffEntry[] {
  const changes: DiffEntry[] = []
  const keys = new Set([...Object.keys(obj1 || {}), ...Object.keys(obj2 || {})])

  for (const key of keys) {
    const fullPath = path ? `${path}.${key}` : key
    const val1 = obj1?.[key]
    const val2 = obj2?.[key]

    if (val1 !== null && typeof val1 === 'object' &&
        val2 !== null && typeof val2 === 'object') {
      changes.push(...generateDiff(val1, val2, fullPath))
    } else if (val1 !== val2) {
      if (val1 === undefined) {
        changes.push({ type: 'added', path: fullPath, value: val2 })
      } else if (val2 === undefined) {
        changes.push({ type: 'removed', path: fullPath, value: val1 })
      } else {
        changes.push({ type: 'changed', path: fullPath, from: val1, to: val2 })
      }
    }
  }

  return changes
}

function formatDiff(diff: DiffEntry[], type: string = 'json'): string {
  switch (type) {
    case 'git':
      return diff.map(change => {
        if (change.type === 'added') return `+ ${change.path}: ${JSON.stringify(change.value)}`
        if (change.type === 'removed') return `- ${change.path}: ${JSON.stringify(change.value)}`
        if (change.type === 'changed') return `~ ${change.path}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`
      }).join('\n')

    case 'plain':
      return diff.map(change => {
        if (change.type === 'added') return `Added ${change.path} = ${change.value}`
        if (change.type === 'removed') return `Removed ${change.path} (was ${change.value})`
        if (change.type === 'changed') return `Changed ${change.path} from ${change.from} to ${change.to}`
      }).join('\n')

    case 'compact':
      return diff.map(change => {
        if (change.type === 'added') return `+${change.path}`
        if (change.type === 'removed') return `-${change.path}`
        if (change.type === 'changed') return `~${change.path}`
      }).join('\n')

    case 'summary':
      const stats = { added: 0, removed: 0, changed: 0 }
      for (const change of diff) {
        stats[change.type] += 1
      }
      return `Added: ${stats.added}, Removed: ${stats.removed}, Changed: ${stats.changed}`

    case 'json':
    default:
      return JSON.stringify({ diff }, null, 2)
  }
}

async function start(): Promise<void> {
  const mongoClient = new MongoClient(MONGO_URI)
  await mongoClient.connect()

  const changeStream: ChangeStream = mongoClient.watch([], { fullDocument: 'updateLookup' })
  changeStream.on('change', change => {
    broadcast({ type: 'db_change', data: change })
  })

  const wss = new WebSocketServer({ noServer: true })
  console.log(`WebSocket server ready on ws://localhost:${PORT_NUMBER}/ws`)

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const parsed = parseUrl(req.url || '', true)

    if (req.method === 'POST' && parsed.pathname === '/diff') {
      let body = ''
      req.on('data', chunk => body += chunk.toString())
      req.on('end', () => {
        try {
          const { old, new: next } = JSON.parse(body)
          const type = parsed.query.type?.toString() || 'json'
          const diff = generateDiff(old, next)
          const output = formatDiff(diff, type)

          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(output)
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid input' }))
        }
      })
      return
    }

    if (parsed.pathname === '/ws') {
      res.writeHead(426, { 'Content-Type': 'text/plain' })
      res.end('Use WebSocket')
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  server.on('upgrade', (req, socket, head) => {
    const parsed = parseUrl(req.url || '', true)
    if (parsed.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const ipHeaders = [
        'x-forwarded-for',
        'x-real-ip',
        'cf-connecting-ip',
        'x-forwarded',
        'true-client-ip',
        'x-client-ip',
        'x-cluster-client-ip',
        'fastly-client-ip',
        'x-appengine-user-ip'
    ]

    const ip = ipHeaders.find(header => req.headers[header]) || req.socket.remoteAddress || 'unknown'
    if (!checkRateLimit(ip)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }

    const token = parsed.query._internalToken?.toString() || null
    const time = parsed.query.time?.toString() || null

    if (!validateToken(token, time)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      activeSockets.add(ws)
      ws.on('close', () => activeSockets.delete(ws))
      ws.on('error', (error) => {
        console.error('WebSocket error:', error)
        ws.close()
      })
    })
  })

  server.listen(PORT_NUMBER, () => {
    console.log(`HTTP + WebSocket server listening on http://localhost:${PORT_NUMBER}`)
    console.log(`Diff endpoint available at http://localhost:${PORT_NUMBER}/diff`)
  })
}

start().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
