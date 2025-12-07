import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Middleware for session-based authentication (dashboard)
 */
export const requireLogin = (req: Request, res: Response, next: NextFunction) => {
  // @ts-ignore
  if (req.session && req.session.user) {
    next();
  } else {
    if (req.path.startsWith('/api')) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      res.redirect('/login.html');
    }
  }
};

/**
 * Middleware for token-based authentication (API endpoints)
 * Checks for VERIFY_TOKEN token in headers
 */
export const requireApiToken = (req: Request, res: Response, next: NextFunction) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  if (!VERIFY_TOKEN) {
    console.error('CRITICAL: VERIFY_TOKEN not set in environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Check multiple possible header names for flexibility
  const token = 
    req.headers['x-api-token'] || 
    req.headers['x-api-key'] || 
    req.headers['authorization']?.replace('Bearer ', '') ||
    req.query.token; // Also allow token in query string for testing

  if (!token) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'API token required. Provide token in X-API-Token header or Authorization: Bearer <token>' 
    });
  }

  if (token !== VERIFY_TOKEN) {
    return res.status(403).json({ 
      error: 'Forbidden',
      message: 'Invalid API token' 
    });
  }

  // Token is valid, proceed
  next();
};

/**
 * Middleware that allows EITHER session OR token authentication
 * Useful for endpoints that can be accessed from both dashboard and external APIs
 */
export const requireLoginOrToken = (req: Request, res: Response, next: NextFunction) => {
  // @ts-ignore
  const hasSession = req.session && req.session.user;
  
  if (hasSession) {
    logger.info('Request authenticated via session', { 
      path: req.path,
      method: req.method 
    });
    return next();
  }

  // If no session, check for API token
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const token = 
    req.headers['x-api-token'] || 
    req.headers['x-api-key'] || 
    req.headers['authorization']?.replace('Bearer ', '');
  
  logger.debug('Token authentication attempt', { 
    path: req.path,
    method: req.method,
    hasToken: !!token,
    tokenPreview: typeof token === 'string' ? `${token.substring(0, 8)}...` : 'none'
  });

  if (token && token === VERIFY_TOKEN) {
    logger.info('Request authenticated via token', { 
      path: req.path,
      method: req.method 
    });
    return next();
  }

  // Neither session nor valid token
  logger.warn('Unauthorized request', { 
    path: req.path,
    method: req.method,
    ip: req.ip,
    hasSession,
    hasToken: !!token
  });

  if (req.path.startsWith('/api')) {
    res.status(401).json({ error: 'Unauthorized' });
  } else {
    res.redirect('/login.html');
  }
};