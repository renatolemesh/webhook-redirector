import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'path';
import * as dotenv from 'dotenv';
import webhookConfigRouter from './webhookConfigRouter';
import pool, { initDb } from './db';
import { forwardWebhook } from './forwarderService';
import { startWorker } from './jobWorker';

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
    tableName: 'session' // It will create this table automatically
  }),
  secret: process.env.SESSION_SECRET || 'change_this_secret_in_env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// 3. Serve Login Page and Static Assets (CSS/JS) publicly
// We serve 'public' but we will handle '/' manually below
app.use(express.static('public', { index: false }));

// --- AUTHENTICATION MIDDLEWARE ---
const requireLogin = (req: Request, res: Response, next: NextFunction) => {
  // @ts-ignore - express-session adds 'user' to session
  if (req.session && req.session.user) {
    next();
  } else {
    // If it's an API call, return 401
    if (req.path.startsWith('/api')) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      // If it's a browser request, redirect to login
      res.redirect('/login.html');
    }
  }
};

// --- AUTH ROUTES ---
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
// This MUST remain public so Meta can reach it
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
  // Acknowledge immediately
  res.status(200).send('EVENT_RECEIVED');
  try {
    await forwardWebhook(body);
  } catch (error) {
    console.error('Error forwarding:', error);
  }
});

// --- PROTECTED ROUTES ---

// 1. The Dashboard UI
app.get('/', requireLogin, (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// 2. The Configuration API
// Note: Remove basicAuthMiddleware from webhookConfigRouter or index.ts if you used it there
app.use('/api', requireLogin, webhookConfigRouter);


// --- START SERVER ---
const startServer = async () => {
  try {
    await initDb();
    // Create session table if it doesn't exist
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

    startWorker();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();