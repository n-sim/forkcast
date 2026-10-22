import { test as base, expect } from './ai-fixture';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';

// A deterministic Gurkerl: its MCP server over Streamable HTTP and its OAuth
// authorization server (metadata discovery, dynamic registration, PKCE). It
// keeps a cart in memory and never places an order; a checkout call is
// recorded so journeys can prove Forkcast never makes one.

export const catalog = [
  { productId: 'p-pasta', name: 'Barilla Spaghetti 500 g', price: 2.49 },
  { productId: 'p-pasta-cheap', name: 'Clever Spaghetti 500 g', price: 0.99 },
  { productId: 'p-coffee', name: 'Gurkerl Bio Kaffee 250 g', price: 6.99 },
];

const tools = [
  {
    name: 'search_products',
    description: 'Search the Gurkerl catalog.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_to_cart',
    description: 'Add a product to the cart.',
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        quantity: { type: 'integer' },
      },
      required: ['productId', 'quantity'],
    },
  },
  {
    name: 'checkout',
    description: 'Place the order and pay.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function body(request: IncomingMessage) {
  let text = '';
  for await (const part of request) text += part;
  return text;
}

export const test = base.extend<{
  gurkerl: {
    server: string;
    cart: { productId: string; quantity: number }[];
    /** Every tool call Gurkerl received, by tool name. */
    calls: string[];
  };
}>({
  // The app talks to deterministic ChatGPT and Gurkerl fixtures; nothing
  // else is faked.
  app: async ({ launch, provider, gurkerl }, use) => {
    await use(
      await launch({
        env: {
          FORKCAST_AI_TEST_ISSUER: provider.issuer,
          FORKCAST_GURKERL_TEST_SERVER: gurkerl.server,
        },
      }),
    );
  },
  gurkerl: async ({}, use) => {
    let base = '';
    const clients = new Map<string, string>();
    const codes = new Map<string, URLSearchParams>();
    const accessTokens = new Set<string>();
    const cart: { productId: string; quantity: number }[] = [];
    const calls: string[] = [];
    const json = (
      response: import('node:http').ServerResponse,
      status: number,
      value: unknown,
    ) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, base);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        json(response, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ['openid'],
        });
      } else if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(response, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ['S256'],
        });
      } else if (url.pathname === '/register') {
        const registration = JSON.parse(await body(request));
        const client = randomUUID();
        clients.set(client, registration.redirect_uris[0]);
        json(response, 201, { client_id: client });
      } else if (url.pathname === '/authorize') {
        const params = url.searchParams;
        if (
          clients.get(params.get('client_id') ?? '') !==
            params.get('redirect_uri') ||
          params.get('resource') !== `${base}/mcp` ||
          params.get('code_challenge_method') !== 'S256'
        ) {
          json(response, 400, { error: 'invalid_request' });
          return;
        }
        const code = randomUUID();
        codes.set(code, new URLSearchParams(params));
        const callback = new URL(params.get('redirect_uri')!);
        callback.searchParams.set('state', params.get('state')!);
        callback.searchParams.set('code', code);
        response.setHeader('Content-Type', 'text/html');
        response.end(
          `<h1>Gurkerl authorization fixture</h1><a href="${callback.href.replaceAll('&', '&amp;')}">Authorize Forkcast</a>`,
        );
      } else if (url.pathname === '/token') {
        const form = new URLSearchParams(await body(request));
        const params = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (
          !params ||
          form.get('client_id') !== params.get('client_id') ||
          form.get('redirect_uri') !== params.get('redirect_uri') ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== params.get('code_challenge')
        ) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        const access = `GURKERL_SECRET_ACCESS_${randomUUID()}`;
        accessTokens.add(access);
        json(response, 200, {
          access_token: access,
          refresh_token: `GURKERL_SECRET_REFRESH_${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      } else if (url.pathname === '/mcp' && request.method === 'POST') {
        if (!accessTokens.has(request.headers.authorization?.slice(7) ?? '')) {
          json(response, 401, { error: 'invalid_token' });
          return;
        }
        const message = JSON.parse(await body(request));
        if (message.id === undefined) {
          response.statusCode = 202;
          response.end();
          return;
        }
        response.setHeader('Mcp-Session-Id', 'fixture-session');
        let result: unknown;
        if (message.method === 'initialize')
          result = {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'gurkerl-fixture', version: '1' },
          };
        else if (message.method === 'tools/list') result = { tools };
        else if (message.method === 'tools/call') {
          const { name, arguments: args } = message.params;
          calls.push(name);
          const text = (value: unknown) => ({
            content: [{ type: 'text', text: JSON.stringify(value) }],
          });
          if (name === 'search_products')
            result = text(
              catalog.filter((product) =>
                product.name
                  .toLowerCase()
                  .includes(String(args.query).toLowerCase()),
              ),
            );
          else if (
            name === 'add_to_cart' &&
            catalog.some((product) => product.productId === args.productId)
          ) {
            cart.push({ productId: args.productId, quantity: args.quantity });
            result = text({ added: args.productId });
          } else
            result = {
              isError: true,
              content: [{ type: 'text', text: 'Not available.' }],
            };
        } else {
          json(response, 200, {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Unknown method' },
          });
          return;
        }
        json(response, 200, { jsonrpc: '2.0', id: message.id, result });
      } else {
        json(response, 404, {});
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No Gurkerl fixture port');
    base = `http://127.0.0.1:${address.port}`;
    try {
      await use({ server: `${base}/mcp`, cart, calls });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
});
export { expect };
