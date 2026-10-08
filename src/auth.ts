import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from './http';

export interface BucketConfig { id: string; label: string; binding: string }
export interface Env {
  ASSETS: Fetcher;
  BUCKETS: BucketConfig[];
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  LOCAL_DEV: string;
  [key: string]: unknown;
}

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(request: Request, env: Env): Promise<string> {
  const url = new URL(request.url);
  if (env.LOCAL_DEV === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return '本地开发';
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN ?? '') || !env.ACCESS_AUD) {
    throw new ApiError(503, 'auth_not_configured', 'Access authentication is not configured');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new ApiError(401, 'unauthorized', 'Cloudflare Access JWT is required');
  let keys = keysets.get(env.ACCESS_TEAM_DOMAIN);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    keysets.set(env.ACCESS_TEAM_DOMAIN, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'iss', 'aud'],
    });
    return typeof payload.email === 'string' ? payload.email : 'Access 服务身份';
  } catch {
    throw new ApiError(401, 'unauthorized', 'Invalid or expired Access JWT');
  }
}
