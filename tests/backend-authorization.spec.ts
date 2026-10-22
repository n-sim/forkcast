import { test, expect } from './backend-fixture';

test('authentication enforces household scope and personal scope independently of administrator privileges', async ({
  backend,
  request,
}) => {
  const setup = await request.post(`${backend.url}/api/setup`, {
    data: {
      householdName: 'Our kitchen',
      username: 'noah',
      password: 'a long local password',
    },
  });
  expect(setup.status()).toBe(201);
  const admin = await setup.json();
  const adminHeaders = { Authorization: `Bearer ${admin.token}` };
  const created = await request.post(`${backend.url}/api/accounts`, {
    headers: adminHeaders,
    data: { username: 'sam', password: 'another local password' },
  });
  expect(created.status()).toBe(201);
  const member = await created.json();
  const login = await request.post(`${backend.url}/api/login`, {
    data: { username: 'sam', password: 'another local password' },
  });
  const signedIn = await login.json();
  const memberHeaders = { Authorization: `Bearer ${signedIn.token}` };

  expect((await request.get(`${backend.url}/api/accounts`)).status()).toBe(401);
  expect(
    (await request.get(`${backend.url}/api/accounts/${member.id}`)).status(),
  ).toBe(401);
  expect(
    (
      await request.get(`${backend.url}/api/households/${admin.household.id}`)
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.get(`${backend.url}/api/accounts`, {
        headers: memberHeaders,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`${backend.url}/api/accounts`, {
        headers: memberHeaders,
        data: { username: 'intruder', password: 'unauthorized password' },
      })
    ).status(),
  ).toBe(403);

  const personal = await request.get(
    `${backend.url}/api/accounts/${member.id}`,
    { headers: memberHeaders },
  );
  expect(personal.status()).toBe(200);
  expect(await personal.json()).toEqual({
    id: member.id,
    householdId: admin.household.id,
    username: 'sam',
    role: 'member',
    active: true,
  });
  expect(
    (
      await request.get(`${backend.url}/api/accounts/${admin.account.id}`, {
        headers: memberHeaders,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.get(`${backend.url}/api/accounts/${member.id}`, {
        headers: adminHeaders,
      })
    ).status(),
  ).toBe(403);
  const household = await request.get(
    `${backend.url}/api/households/${admin.household.id}`,
    { headers: memberHeaders },
  );
  expect(household.status()).toBe(200);
  expect(await household.json()).toEqual({
    id: admin.household.id,
    name: 'Our kitchen',
  });
  expect(
    (
      await request.get(`${backend.url}/api/households/another-household`, {
        headers: memberHeaders,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`${backend.url}/api/accounts`, {
        headers: adminHeaders,
        data: {
          username: 'extra',
          password: 'a long password',
          role: 'administrator',
          householdId: 'forged',
        },
      })
    ).status(),
  ).toBe(422);

  expect(
    (
      await request.delete(`${backend.url}/api/session`, {
        headers: memberHeaders,
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await request.get(`${backend.url}/api/accounts/${member.id}`, {
        headers: memberHeaders,
      })
    ).status(),
  ).toBe(401);
});

test('concurrent first-account requests create exactly one administrator and one household', async ({
  backend,
  request,
}) => {
  const results = await Promise.all(
    ['noah', 'sam'].map((username) =>
      request.post(`${backend.url}/api/setup`, {
        data: {
          householdName: `${username}'s kitchen`,
          username,
          password: 'a long local password',
        },
      }),
    ),
  );
  expect(results.map((response) => response.status()).sort()).toEqual([
    201, 409,
  ]);
  const winner = await results
    .find((response) => response.status() === 201)!
    .json();
  const list = await request.get(`${backend.url}/api/accounts`, {
    headers: { Authorization: `Bearer ${winner.token}` },
  });
  expect(await list.json()).toEqual([winner.account]);
  expect(
    (
      await request.patch(`${backend.url}/api/accounts/${winner.account.id}`, {
        headers: { Authorization: `Bearer ${winner.token}` },
        data: { active: false },
      })
    ).status(),
  ).toBe(403);
  await backend.restart();
  const status = await request.get(`${backend.url}/api/status`);
  expect(await status.json()).toEqual({ setupRequired: false, protocol: 3 });
  expect(
    (
      await request.get(`${backend.url}/api/session`, {
        headers: { Authorization: `Bearer ${winner.token}` },
      })
    ).status(),
  ).toBe(200);
});

test('repeated failed sign-ins are throttled across backend restarts', async ({
  backend,
  request,
}) => {
  await request.post(`${backend.url}/api/setup`, {
    data: {
      householdName: 'Our kitchen',
      username: 'noah',
      password: 'a long local password',
    },
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const failed = await request.post(`${backend.url}/api/login`, {
      data: { username: 'NOAH', password: 'wrong password' },
    });
    expect(failed.status()).toBe(401);
  }
  const throttled = await request.post(`${backend.url}/api/login`, {
    data: { username: 'noah', password: 'a long local password' },
  });
  expect(throttled.status()).toBe(429);
  await backend.restart();
  expect(
    (
      await request.post(`${backend.url}/api/login`, {
        data: { username: 'noah', password: 'a long local password' },
      })
    ).status(),
  ).toBe(429);
});
