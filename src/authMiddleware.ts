import { Request, Response, NextFunction } from 'express';
import * as dotenv from 'dotenv';

dotenv.config();

// Basic Auth Middleware for API routes
export const basicAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Webhook Configuration"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [username, password] = credentials.split(':');

    const validUsername = process.env.ADMIN_USERNAME;
    const validPassword = process.env.ADMIN_PASSWORD;

    if (username === validUsername && password === validPassword) {
      next();
    } else {
      res.setHeader('WWW-Authenticate', 'Basic realm="Webhook Configuration"');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Webhook Configuration"');
    return res.status(401).json({ error: 'Invalid authorization header' });
  }
};

// Webhook Verification Token Middleware
export const webhookVerificationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers['x-webhook-token'] || req.query.token;
  const validToken = process.env.WEBHOOK_CONFIG_TOKEN;

  if (!validToken) {
    // If no token is configured, skip verification (for backward compatibility)
    console.warn('WARNING: WEBHOOK_CONFIG_TOKEN not set. Webhook verification disabled.');
    return next();
  }

  if (token === validToken) {
    next();
  } else {
    return res.status(403).json({ error: 'Invalid webhook verification token' });
  }
};