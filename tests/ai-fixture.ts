import { test as base, expect } from './app-fixture';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

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

export const generatedRecipe = {
  id: 'provider-recipe',
  name: 'Tomato soup',
  basePortions: 2,
  ingredients: [{ id: 'tomatoes', name: 'Tomatoes', quantity: 400, unit: 'g' }],
  steps: [
    {
      id: 'simmer',
      instruction: 'Simmer the tomatoes.',
      allocations: [{ ingredientId: 'tomatoes', quantity: 400, unit: 'g' }],
    },
  ],
  difficulty: 'easy',
  activeMinutes: 5,
  totalMinutes: 20,
};

export interface InferenceRequest {
  instructions: string;
  input: { role: string; content: string }[];
}

type InferenceFailure =
  | 'http'
  | 'limited'
  | 'unauthorized'
  | 'failed'
  | 'incomplete'
  | 'interrupted'
  | 'refusal'
  | 'malformed';

export const test = base.extend<{
  provider: {
    issuer: string;
    /** Host identities the provider saw in authorization requests. */
    hosts: string[];
    mode: (value: Mode) => void;
    reply: (value: unknown | ((request: InferenceRequest) => unknown)) => void;
    fail: (value: InferenceFailure | null) => void;
    /** What refreshing a session does: succeed, or end the session. */
    refresh: (value: 'ok' | 'reject') => void;
    /** Makes every issued access token short-lived, so each request renews it. */
    shortSessions: () => void;
    pause: () => void;
    resume: () => void;
    count: (what: 'refresh' | 'inference') => number;
  };
}>({
  // The app talks to a deterministic ChatGPT provider; nothing else is faked.
  app: async ({ launch, provider }, use) => {
    await use(
      await launch({ env: { FORKCAST_AI_TEST_ISSUER: provider.issuer } }),
    );
  },
  provider: async ({}, use) => {
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
    let reply: unknown = generatedRecipe;
    let failure: InferenceFailure | null = null;
    let gate: Promise<void> | undefined;
    let resume = () => {};
    let issuer = '';
    const hosts: string[] = [];
    const accessTokens = new Set<string>();
    const refreshTokens = new Set<string>();
    let refreshMode: 'ok' | 'reject' = 'ok';
    let sessionSeconds = 3600;
    let generation = 0;
    const counts = { refresh: 0, inference: 0 };
    const issue = () => {
      generation += 1;
      const issued = {
        access: `SECRET_ACCESS_TOKEN_${generation}`,
        refresh: `SECRET_REFRESH_TOKEN_${generation}`,
      };
      accessTokens.add(issued.access);
      refreshTokens.add(issued.refresh);
      return issued;
    };
    const provider = createServer(async (request, response) => {
      const url = new URL(request.url!, issuer);
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/.well-known/jwks.json') {
        response.end(JSON.stringify({ keys: [jwk] }));
      } else if (url.pathname === '/api/accounts/authorize') {
        const params = url.searchParams;
        // Forkcast uses the documented UUIDv4 host-ID alternative.
        if (
          !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            params.get('ext_agent_host_id') ?? '',
          )
        ) {
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              error: {
                message: 'Invalid authorize request',
                type: 'invalid_request_error',
                param: 'ext_agent_host_id',
                code: 'invalid_authorize_request',
              },
            }),
          );
          return;
        }
        hosts.push(params.get('ext_agent_host_id')!);
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
          counts.refresh += 1;
          if (
            refreshMode === 'reject' ||
            !refreshTokens.delete(form.get('refresh_token') ?? '')
          ) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          const renewed = issue();
          response.end(
            JSON.stringify({
              access_token: renewed.access,
              refresh_token: renewed.refresh,
              token_type: 'Bearer',
              expires_in: sessionSeconds,
            }),
          );
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
        const granted = issue();
        response.end(
          JSON.stringify({
            access_token: granted.access,
            refresh_token: granted.refresh,
            id_token: `${encoded}.${signature}`,
            token_type: 'Bearer',
            expires_in: mode === 'short_session' ? 1 : sessionSeconds,
            scope:
              mode === 'scope' ? 'openid email profile' : params.get('scope'),
          }),
        );
      } else if (url.pathname === '/v1/models') {
        if (!accessTokens.has(request.headers.authorization?.slice(7) ?? '')) {
          response.statusCode = 401;
          response.end('{}');
          return;
        }
        response.end(
          JSON.stringify({
            models: [
              {
                slug: 'fixture-recipe',
                display_name: 'Fixture recipe model',
                visibility: 'list',
              },
            ],
          }),
        );
      } else if (url.pathname === '/v1/responses') {
        let body = '';
        for await (const part of request) body += part;
        const input = JSON.parse(body);
        counts.inference += 1;
        if (
          !accessTokens.has(request.headers.authorization?.slice(7) ?? '') ||
          input.model !== 'fixture-recipe' ||
          input.store !== false ||
          input.stream !== true ||
          !Array.isArray(input.input)
        ) {
          response.statusCode = 400;
          response.end('{}');
          return;
        }
        if (
          failure === 'http' ||
          failure === 'limited' ||
          failure === 'unauthorized'
        ) {
          response.statusCode =
            failure === 'limited'
              ? 429
              : failure === 'unauthorized'
                ? 401
                : 503;
          response.end(
            JSON.stringify({
              error: {
                message: 'DO_NOT_EXPOSE_PROVIDER_ERRORS SECRET_ACCESS_TOKEN',
              },
            }),
          );
          return;
        }
        response.setHeader('Content-Type', 'text/event-stream');
        const text = JSON.stringify(
          typeof reply === 'function' ? reply(input) : reply,
        );
        const characters = [...text];
        const middle = Math.floor(characters.length / 2);
        const delta = Buffer.from(
          [
            characters.slice(0, middle).join(''),
            characters.slice(middle).join(''),
          ]
            .map(
              (part) =>
                `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: part })}\r\n\r\n`,
            )
            .join(''),
        );
        const split = Math.max(1, delta.indexOf(Buffer.from('🍲')) + 1);
        response.write(delta.subarray(0, split));
        response.write(delta.subarray(split));
        if (gate) await gate;
        if (failure === 'interrupted') {
          response.end();
          return;
        }
        if (failure === 'failed' || failure === 'incomplete') {
          response.end(
            `data: ${JSON.stringify({ type: `response.${failure}`, response: { error: { message: 'DO_NOT_EXPOSE_PROVIDER_ERRORS' } } })}\n\n`,
          );
          return;
        }
        if (failure === 'malformed') {
          response.end('data: invalid-json\n\n');
          return;
        }
        if (failure === 'refusal') {
          response.write(
            `data: ${JSON.stringify({ type: 'response.refusal.delta', delta: 'Cannot help.' })}\n\n`,
          );
        }
        const completed = Buffer.from(
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: failure === 'refusal' ? [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help.' }] }] : [] } })}\n\n`,
        );
        response.end(completed);
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
    try {
      await use({
        issuer,
        hosts,
        mode: (value) => {
          mode = value;
        },
        reply: (value) => {
          reply = value;
        },
        fail: (value) => {
          failure = value;
        },
        refresh: (value) => {
          refreshMode = value;
        },
        shortSessions: () => {
          sessionSeconds = 1;
        },
        pause: () => {
          gate = new Promise<void>((resolve) => {
            resume = resolve;
          });
        },
        resume: () => {
          resume();
          gate = undefined;
        },
        count: (what) => counts[what],
      });
    } finally {
      resume();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  },
});
export { expect };
