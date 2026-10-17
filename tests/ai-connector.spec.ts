import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from './ai-fixture';
import type { APIRequestContext } from '@playwright/test';

const headers = {
  Origin: 'http://127.0.0.1:4173',
  'X-Forkcast-Companion': '1',
};

async function authorization(request: APIRequestContext, companionUrl: string) {
  const result = await request.post(`${companionUrl}/api/authorization`, {
    headers,
  });
  return new URL(
    ((await result.json()) as { authorizationUrl: string }).authorizationUrl,
  );
}

test('the provider accepts a UUIDv4 host identity that survives companion restarts', async ({
  request,
  companion,
}) => {
  const first = await authorization(request, companion.url);
  const consent = await request.get(first.href);
  expect(consent.status(), await consent.text()).toBe(200);
  expect(first.searchParams.get('ext_agent_host_id')).toMatch(
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await companion.restart();
  const afterRestart = await authorization(request, companion.url);
  expect(afterRestart.searchParams.get('ext_agent_host_id')).toBe(
    first.searchParams.get('ext_agent_host_id'),
  );
});

test.describe('upgrading an initial companion installation', () => {
  test.use({ legacyHost: true });

  test('repair the saved host identity once and preserve the account registration', async ({
    request,
    companion,
  }) => {
    const migrated = await authorization(request, companion.url);
    const consent = await request.get(migrated.href);
    expect(consent.status(), await consent.text()).toBe(200);
    expect(migrated.searchParams.get('client_id')).toBe('oaiapp_fixture');
    const status = await request.get(`${companion.url}/api/status`, {
      headers,
    });
    expect(await status.json()).toMatchObject({ email: 'cook@example.test' });
    await companion.restart();
    const persisted = await authorization(request, companion.url);
    expect(persisted.searchParams.get('ext_agent_host_id')).toBe(
      migrated.searchParams.get('ext_agent_host_id'),
    );
    expect(persisted.searchParams.get('client_id')).toBe('oaiapp_fixture');
  });
});

test('native authorization enforces origin, host, one-time callback state, registration identity, and credential secrecy', async ({
  request,
  companion,
}) => {
  const statusUrl = `${companion.url}/api/status`;
  expect((await request.get(statusUrl)).status()).toBe(403);
  expect(
    (
      await request.get(statusUrl, { headers: { Origin: headers.Origin } })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.get(statusUrl, {
        headers: { ...headers, Origin: 'https://untrusted.example' },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.get(statusUrl, {
        headers: { ...headers, Host: 'untrusted.example' },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`${companion.url}/api/authorization`, {
        headers: { Origin: 'https://untrusted.example' },
      })
    ).status(),
  ).toBe(403);
  const preflight = await request.fetch(statusUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: headers.Origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-forkcast-companion',
    },
  });
  expect(preflight.headers()['access-control-allow-origin']).toBe(
    headers.Origin,
  );

  async function start() {
    const response = await request.post(`${companion.url}/api/authorization`, {
      headers,
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    const body = await response.text();
    expect(body).not.toMatch(
      /SECRET_|id_token|refresh_token|access_token|code_verifier/,
    );
    return new URL(
      (JSON.parse(body) as { authorizationUrl: string }).authorizationUrl,
    );
  }
  const first = await start();
  const second = await start();
  expect(second.searchParams.get('state')).not.toBe(
    first.searchParams.get('state'),
  );
  expect(second.searchParams.get('nonce')).not.toBe(
    first.searchParams.get('nonce'),
  );
  expect(second.searchParams.get('code_challenge')).not.toBe(
    first.searchParams.get('code_challenge'),
  );
  expect(second.searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect(second.searchParams.get('agent_name_hint')).toBe('Forkcast');
  expect(second.searchParams.get('scope')?.split(' ')).toContain(
    'chatgpt.tokens.use.direct',
  );
  expect(second.searchParams.get('resource')).toBe('https://api.openai.com/v1');
  expect(second.searchParams.get('code_challenge_method')).toBe('S256');
  expect(second.searchParams.get('redirect_uri')).toBe(
    `${companion.url}/auth/callback`,
  );
  expect(second.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
  const callback = new URL(second.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', first.searchParams.get('state')!);
  callback.searchParams.set('code', 'untrusted-code');
  callback.searchParams.set('client_id', 'oaiapp_fixture');
  expect((await request.get(callback.href)).status()).toBe(400);
  await expect(
    (await request.get(statusUrl, { headers })).json(),
  ).resolves.toMatchObject({ state: 'authorizing' });
  callback.searchParams.set('state', second.searchParams.get('state')!);
  callback.searchParams.delete('client_id');
  expect((await request.get(callback.href)).status()).toBe(400);
  const authorization = await start();
  const consent = await request.get(authorization.href);
  const link = (await consent.text())
    .match(/href="([^"]+)"/)?.[1]
    ?.replaceAll('&amp;', '&');
  expect(link).toBeTruthy();
  const connected = await request.get(link!);
  expect(connected.status()).toBe(200);
  expect(connected.headers()['referrer-policy']).toBe('no-referrer');
  expect(connected.headers()['content-security-policy']).toContain(
    "default-src 'none'",
  );
  expect(await connected.text()).not.toMatch(
    /SECRET_|id_token|access_token|refresh_token/,
  );
  expect((await request.get(link!)).status()).toBe(400);
  const status = await request.get(statusUrl, { headers });
  expect(await status.json()).toEqual({
    state: 'connected',
    email: 'cook@example.test',
    message: null,
  });
  const credentials = join(companion.directory, 'credentials');
  if (process.platform === 'win32') {
    const encrypted = (await readFile(credentials)).toString();
    expect(encrypted).not.toMatch(
      /SECRET_|cook@example|access_token|refresh_token/,
    );
  } else {
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect((await stat(companion.directory)).mode & 0o777).toBe(0o700);
  }
  await companion.restart();
  const returning = await start();
  expect(returning.searchParams.get('client_id')).toBe('oaiapp_fixture');
  expect(returning.searchParams.get('ext_agent_host_id')).toBe(
    authorization.searchParams.get('ext_agent_host_id'),
  );
  const changedClient = new URL(returning.searchParams.get('redirect_uri')!);
  changedClient.search = new URLSearchParams({
    state: returning.searchParams.get('state')!,
    code: 'unused-code',
    client_id: 'oaiapp_other',
  }).toString();
  expect((await request.get(changedClient.href)).status()).toBe(400);
  const retained = await request.get(statusUrl, { headers });
  expect(await retained.json()).toMatchObject({
    state: 'connected',
    message: 'ChatGPT returned a different registration. Try connecting again.',
  });
});
