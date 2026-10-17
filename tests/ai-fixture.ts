import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Mode =
  | 'success'
  | 'denied'
  | 'nonce'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'scope'
  | 'exchange'
  | 'short_session'
  | 'no_email'
  | 'revocation';

export const test = base.extend<{
  companion: {
    url: string;
    directory: string;
    issuer: string;
    mode: (value: Mode) => void;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
  };
}>({
  companion: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'forkcast-ai-'));
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const jwk = {
      ...publicKey.export({ format: 'jwk' }),
      kid: 'fixture',
      alg: 'RS256',
      use: 'sig',
    };
    const attempts = new Map<string, URLSearchParams>();
    let mode: Mode = 'success';
    let issuer = '';
    const provider = createServer(async (request, response) => {
      const url = new URL(request.url!, issuer);
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/.well-known/jwks.json') {
        response.end(JSON.stringify({ keys: [jwk] }));
      } else if (url.pathname === '/api/accounts/authorize') {
        const params = url.searchParams;
        const code = randomUUID();
        attempts.set(code, new URLSearchParams(params));
        const callback = new URL(params.get('redirect_uri')!);
        callback.searchParams.set('state', params.get('state')!);
        if (mode === 'denied')
          callback.searchParams.set('error', 'access_denied');
        else {
          callback.searchParams.set('code', code);
          if (params.get('client_id') === 'dynamic_agent_client')
            callback.searchParams.set('client_id', 'oaiapp_fixture');
        }
        response.setHeader('Content-Type', 'text/html');
        response.end(
          `<h1>ChatGPT authorization fixture</h1><a href="${callback.href.replaceAll('&', '&amp;')}">Authorize Forkcast</a>`,
        );
      } else if (url.pathname === '/api/accounts/oauth/token') {
        let body = '';
        for await (const part of request) body += part;
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'refresh_token') {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const params = attempts.get(form.get('code')!);
        attempts.delete(form.get('code')!);
        if (
          !params ||
          mode === 'exchange' ||
          form.get('client_id') !== 'oaiapp_fixture' ||
          form.get('redirect_uri') !== params.get('redirect_uri') ||
          form.get('resource') !== 'https://api.openai.com/v1' ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== params.get('code_challenge')
        ) {
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'DO_NOT_EXPOSE_PROVIDER_ERRORS',
            }),
          );
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: mode === 'issuer' ? 'https://attacker.invalid' : issuer,
          aud: mode === 'audience' ? 'oaiapp_other' : 'oaiapp_fixture',
          sub: 'fixture-person',
          email: mode === 'no_email' ? undefined : 'cook@example.test',
          iat: now,
          exp: mode === 'expired' ? now - 3600 : now + 3600,
          nonce: mode === 'nonce' ? 'wrong-nonce' : params.get('nonce'),
        };
        const encoded = [
          Buffer.from(
            JSON.stringify({ alg: 'RS256', kid: 'fixture' }),
          ).toString('base64url'),
          Buffer.from(JSON.stringify(claims)).toString('base64url'),
        ].join('.');
        const signature = sign(
          'RSA-SHA256',
          Buffer.from(mode === 'signature' ? 'invalid' : encoded),
          privateKey,
        ).toString('base64url');
        response.end(
          JSON.stringify({
            access_token: 'SECRET_ACCESS_TOKEN',
            refresh_token: 'SECRET_REFRESH_TOKEN',
            id_token: `${encoded}.${signature}`,
            token_type: 'Bearer',
            expires_in: mode === 'short_session' ? 1 : 3600,
            scope:
              mode === 'scope' ? 'openid email profile' : params.get('scope'),
          }),
        );
      } else if (url.pathname === '/api/accounts/oauth/revoke') {
        if (mode === 'revocation') response.statusCode = 503;
        response.end();
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('No provider port');
    issuer = `http://127.0.0.1:${address.port}`;
    let child: ChildProcess | undefined;
    let url = '';
    async function start() {
      child = spawn(
        resolve(
          'target/debug/forkcast-ai-companion' +
            (process.platform === 'win32' ? '.exe' : ''),
        ),
        [],
        {
          env: {
            ...process.env,
            FORKCAST_AI_BIND: url ? new URL(url).host : '127.0.0.1:0',
            FORKCAST_AI_DIRECTORY: directory,
            FORKCAST_AI_ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
            FORKCAST_AI_TEST_ISSUER: issuer,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      const running = child;
      url = await new Promise<string>((resolve, reject) => {
        let output = '';
        let errors = '';
        const timeout = setTimeout(
          () => reject(new Error(`Companion did not start: ${errors}`)),
          15_000,
        );
        running.stdout!.on('data', (data: Buffer) => {
          output += data.toString();
          const match = output.match(/listening on (http:\/\/[^\s]+)/);
          if (match?.[1]) {
            clearTimeout(timeout);
            resolve(match[1]);
          }
        });
        running.stderr!.on('data', (data: Buffer) => {
          errors += data.toString();
        });
        running.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        running.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Companion exited (${code}): ${errors}`));
        });
      });
    }
    async function stop() {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    try {
      await start();
      await use({
        get url() {
          return url;
        },
        directory,
        issuer,
        mode: (value) => {
          mode = value;
        },
        stop,
        restart: async () => {
          await stop();
          await start();
        },
      });
    } finally {
      await stop();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
});
export { expect };
