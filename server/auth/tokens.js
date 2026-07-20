// Token generation and verification
// accessToken: JWT with sub=jti/type=access/exp claims
// refreshToken: opaque crypto.randomBytes(48) → base64url

import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

export function generateAccessToken(secret, expirySeconds = 900) {
  const payload = {
    sub: 'nexus-user',
    jti: crypto.randomUUID(),
    type: 'access',
  };
  return jwt.sign(payload, secret, { expiresIn: expirySeconds });
}

export function verifyAccessToken(token, secret) {
  const decoded = jwt.verify(token, secret);
  if (decoded.type !== 'access') {
    throw new Error('Token type is not access');
  }
  return decoded;
}

export function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}