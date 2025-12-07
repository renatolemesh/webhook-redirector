import express, { Request, Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'path';
import * as dotenv from 'dotenv';
import webhookConfigRouter from './routes/webhookConfigRouter';
import chatwootMessageRouter from './routes/chatwootMessageRouter';
import pool, { initDb } from './config/database';
import { forwardWebhook } from './services/forwarderService';
import { startWorker } from './services/jobWorker';
import { startChatwootWorker } from './services/chatwootWorker';
import { requireLogin } from './middleware/auth';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3005;
const PgSession = connectPgSimple(session);

// 1. Middleware to parse JSON bodies
app.use(express.json());

// 2. Session Configuration
app.use(session({
  store: new PgSession({
    pool: pool,
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET || 'change_this_secret_in_env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// 3. Serve static assets
app.use(express.static('public', { index: false }));

// --- AUTH ROUTES (Public) ---
app.post('/auth/login', (req: Request, res: Response) => {
  const { username, password } = req.body;
  
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    // @ts-ignore
    req.session.user = username;
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/auth/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.status(200).json({ success: true });
  });
});

// --- PUBLIC ROUTES (Meta Webhook) ---
app.get('/webhook', (req: Request, res: Response) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

app.post('/webhook', async (req: Request, res: Response) => {
  const body = req.body;
  res.status(200).send('EVENT_RECEIVED');
  try {
    await forwardWebhook(body);
  } catch (error) {
    console.error('Error forwarding:', error);
  }
});

// --- PROTECTED ROUTES ---

// Dashboard (requires session login)
app.get('/', requireLogin, (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// Chatwoot message API (token auth is handled inside the router)
app.use('/api/chatwoot', chatwootMessageRouter);

// Webhook configuration API (requires session login - for dashboard)
app.use('/api', requireLogin, webhookConfigRouter);


// --- START SERVER ---
const startServer = async () => {
  try {
    await initDb();
    
    // Validate required environment variables
    if (!process.env.VERIFY_TOKEN) {
      console.warn('⚠️  WARNING: VERIFY_TOKEN not set! API endpoints will not work properly.');
      console.warn('   Add VERIFY_TOKEN=your_secret_token to your .env file');
    }
    
    // Create session table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL
      )
      WITH (OIDS=FALSE);
      
      ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
      
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `).catch(() => console.log('Session table likely exists'));

    // Start both workers
    startWorker();
    startChatwootWorker();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✓ Server is running on port ${PORT}`);
      console.log(`✓ Webhook endpoint: http://localhost:${PORT}/webhook`);
      console.log(`✓ Chatwoot API: http://localhost:${PORT}/api/chatwoot/send`);
      console.log(`✓ Dashboard: http://localhost:${PORT}/`);
      console.log('');
      console.log('API Authentication:');
      console.log('  - Dashboard: Session-based (login required)');
      console.log('  - Chatwoot POST API: Token-based (X-API-Token header with VERIFY_TOKEN)');
      console.log('  - Chatwoot GET API: Session or Token');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();