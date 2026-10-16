import { test, expect } from './backend-fixture';
import type { APIRequestContext } from '@playwright/test';

async function planningHousehold(
  request: APIRequestContext,
  backendUrl: string,
) {
  const admin = await (
    await request.post(`${backendUrl}/api/setup`, {
      data: {
        householdName: 'Our kitchen',
        username: 'noah',
        password: 'a long local password',
      },
    })
  ).json();
  return {
    url: `${backendUrl}/api/households/${admin.household.id}/planning`,
    headers: { Authorization: `Bearer ${admin.token}` },
  };
}

function groceries() {
  return {
    cookings: {},
    shoppingList: {
      id: 'weekly-list',
      startDate: '2026-10-12',
      endDate: '2026-10-18',
      generatedAt: 1,
      items: [],
      contributions: [],
      manualItems: [
        { id: 'milk', name: 'Milk', quantity: 2, unit: 'l', checked: false },
      ],
    },
  };
}

test('identical concurrent regenerations combine while older generated-item edits still require resolution', async ({
  request,
  backend,
}) => {
  const { url, headers } = await planningHousehold(request, backend.url);
  const original = {
    ...groceries(),
    shoppingList: {
      ...groceries().shoppingList,
      items: [
        {
          id: 'dry-pasta',
          name: 'Pasta',
          quantity: 500,
          unit: 'g',
          needsReview: false,
          sources: [
            { cookingId: 'pasta-cooking', ingredientId: 'pasta-ingredient' },
          ],
        },
      ],
      contributions: [
        {
          cookingId: 'pasta-cooking',
          recipeId: 'pasta',
          recipeName: 'Pasta',
          cookingDate: '2026-10-13',
          portions: 2,
          ingredients: [
            { id: 'pasta-ingredient', name: 'Pasta', quantity: 500, unit: 'g' },
          ],
        },
      ],
    },
  };
  const base = await (
    await request.post(url, {
      headers,
      data: { id: 'original', baseRevision: null, data: original },
    })
  ).json();
  const first = structuredClone(original);
  first.shoppingList.id = 'first-regeneration';
  first.shoppingList.generatedAt = 2;
  first.shoppingList.items[0]!.id = 'first-pasta';
  await request.post(url, {
    headers,
    data: { id: 'first', baseRevision: base.revision, data: first },
  });
  const second = structuredClone(original);
  second.shoppingList.id = 'second-regeneration';
  second.shoppingList.generatedAt = 3;
  second.shoppingList.items[0]!.id = 'second-pasta';
  second.shoppingList.manualItems.push({
    id: 'coffee',
    name: 'Coffee',
    quantity: 1,
    unit: 'piece',
    checked: false,
  });
  const combined = await (
    await request.post(url, {
      headers,
      data: { id: 'second', baseRevision: base.revision, data: second },
    })
  ).json();
  expect(combined.conflicts).toEqual([]);
  expect(combined.data.shoppingList.items).toHaveLength(1);
  expect(combined.data.shoppingList.items[0].quantity).toBe(500);
  expect(
    combined.data.shoppingList.manualItems.map(
      (item: { name: string }) => item.name,
    ),
  ).toEqual(['Coffee', 'Milk']);
  const manualOnly = structuredClone(original);
  manualOnly.shoppingList.manualItems.push({
    id: 'bread',
    name: 'Bread',
    quantity: 1,
    unit: 'piece',
    checked: false,
  });
  expect(
    (
      await request.post(url, {
        headers,
        data: {
          id: 'manual-only-old-generation',
          baseRevision: base.revision,
          data: manualOnly,
        },
      })
    ).status(),
  ).toBe(200);
  await backend.restart();
  const continued = structuredClone(second);
  continued.shoppingList.items[0]!.quantity = 250;
  const continuedResponse = await request.post(url, {
    headers,
    data: {
      id: 'continued',
      baseRevision: null,
      baseMutationId: 'second',
      baseData: second,
      data: continued,
    },
  });
  expect(continuedResponse.status()).toBe(200);
  const continuedSnapshot = await continuedResponse.json();
  expect(continuedSnapshot.conflicts).toEqual([]);
  expect(continuedSnapshot.data.shoppingList.items[0].quantity).toBe(250);
  const olderEdit = structuredClone(original);
  olderEdit.shoppingList.items[0]!.quantity = 300;
  const conflicted = await (
    await request.post(url, {
      headers,
      data: { id: 'older-edit', baseRevision: base.revision, data: olderEdit },
    })
  ).json();
  expect(conflicted.conflicts[0].path).toEqual([
    'shoppingList',
    'requirements',
  ]);
});

test('later edits and removals preserve unresolved alternatives and invalidate an earlier conflict review', async ({
  request,
  backend,
}) => {
  const { url, headers } = await planningHousehold(request, backend.url);
  const original = groceries();
  async function save(
    id: string,
    baseRevision: string | null,
    data: ReturnType<typeof groceries>,
  ) {
    const response = await request.post(url, {
      headers,
      data: { id, baseRevision, data },
    });
    expect(response.status()).toBe(200);
    return response.json();
  }
  const base = await save('original', null, original);
  const first = structuredClone(original);
  first.shoppingList.manualItems[0]!.quantity = 3;
  await save('first', base.revision, first);
  const second = structuredClone(original);
  second.shoppingList.manualItems[0]!.quantity = 4;
  const conflicted = await save('second', base.revision, second);
  const later = structuredClone(conflicted.data);
  later.shoppingList.manualItems[0].quantity = 5;
  const changed = await save('later', conflicted.revision, later);
  expect(changed.conflicts[0].values).toEqual([3, 4, 5]);
  expect(
    (
      await request.post(`${url}/resolve`, {
        headers,
        data: { conflict: conflicted.conflicts[0], value: 4 },
      })
    ).status(),
  ).toBe(409);
  const removal = structuredClone(changed.data);
  removal.shoppingList.manualItems = [];
  const removed = await save('removal', changed.revision, removal);
  expect(removed.conflicts[0].path).toEqual([
    'shoppingList',
    'manualItems',
    'milk',
  ]);
  const retained = removed.conflicts[0].values.find(
    (value: { quantity?: number } | null) => value?.quantity === 4,
  );
  expect(retained).toEqual({
    id: 'milk',
    name: 'Milk',
    quantity: 4,
    unit: 'l',
    checked: false,
  });
  const resolved = await request.post(`${url}/resolve`, {
    headers,
    data: { conflict: removed.conflicts[0], value: retained },
  });
  expect(resolved.status()).toBe(200);
  expect(
    (await resolved.json()).data.shoppingList.manualItems[0].quantity,
  ).toBe(4);
});

test('planning endpoints enforce household authorization, valid quantities, and immutable mutation identities', async ({
  request,
  backend,
}) => {
  const { url, headers } = await planningHousehold(request, backend.url);
  const data = groceries();
  expect((await request.get(url)).status()).toBe(401);
  expect(
    (
      await request.post(url, {
        data: { id: 'unauthenticated', baseRevision: null, data },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.get(`${backend.url}/api/households/other/planning`, {
        headers,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`${backend.url}/api/households/other/planning`, {
        headers,
        data: { id: 'wrong-household', baseRevision: null, data },
      })
    ).status(),
  ).toBe(403);
  const invalid = structuredClone(data);
  invalid.shoppingList.manualItems[0]!.quantity = 0;
  expect(
    (
      await request.post(url, {
        headers,
        data: { id: 'invalid', baseRevision: null, data: invalid },
      })
    ).status(),
  ).toBe(422);
  expect((await request.get(url, { headers })).headers()['cache-control']).toBe(
    'no-store',
  );
  const mutation = { id: 'accepted', baseRevision: null, data };
  const first = await (
    await request.post(url, { headers, data: mutation })
  ).json();
  const retried = await (
    await request.post(url, { headers, data: mutation })
  ).json();
  expect(retried).toEqual(first);
  const changed = structuredClone(mutation);
  changed.data.shoppingList.manualItems[0]!.quantity = 9;
  expect((await request.post(url, { headers, data: changed })).status()).toBe(
    409,
  );
  expect(
    (
      await request.post(url, {
        headers,
        data: { id: 'unknown-base', baseRevision: 'unknown', data },
      })
    ).status(),
  ).toBe(409);
  const malformed = {
    cookings: {
      missing: {
        id: 'missing',
        recipeId: 'missing',
        cookingDate: '2026-10-13',
        portions: 2,
        cookingTime: null,
      },
    },
    shoppingList: null,
  };
  expect(
    (
      await request.post(url, {
        headers,
        data: { id: 'missing-recipe', baseRevision: null, data: malformed },
      })
    ).status(),
  ).toBe(422);
});

test('members share household planning with the administrator and retain it across backend restarts', async ({
  request,
  backend,
}) => {
  const setup = await request.post(`${backend.url}/api/setup`, {
    data: {
      householdName: 'Our kitchen',
      username: 'noah',
      password: 'a long local password',
    },
  });
  const admin = await setup.json();
  const headers = { Authorization: `Bearer ${admin.token}` };
  await request.post(`${backend.url}/api/accounts`, {
    headers,
    data: { username: 'sam', password: 'a long local password' },
  });
  const login = await request.post(`${backend.url}/api/login`, {
    data: { username: 'sam', password: 'a long local password' },
  });
  const member = await login.json();
  const url = `${backend.url}/api/households/${admin.household.id}/planning`;
  const data = {
    cookings: {},
    shoppingList: {
      id: 'weekly-list',
      startDate: '2026-10-12',
      endDate: '2026-10-18',
      generatedAt: 1,
      items: [],
      contributions: [],
      manualItems: [
        { id: 'milk', name: 'Milk', quantity: 2, unit: 'l', checked: false },
      ],
    },
  };
  expect(
    (
      await request.post(url, {
        headers: { Authorization: `Bearer ${member.token}` },
        data: { id: 'member-shopping', baseRevision: null, data },
      })
    ).status(),
  ).toBe(200);
  const saved = await request.get(url, { headers });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).data).toEqual(data);
  await backend.restart();
  expect((await (await request.get(url, { headers })).json()).data).toEqual(
    data,
  );
});

test('deletion versus editing retains both choices and rejects stale conflict resolution', async ({
  request,
  backend,
}) => {
  const { url, headers } = await planningHousehold(request, backend.url);
  const original = groceries();
  const base = await (
    await request.post(url, {
      headers,
      data: { id: 'original', baseRevision: null, data: original },
    })
  ).json();
  const removed = structuredClone(original);
  removed.shoppingList.manualItems = [];
  await request.post(url, {
    headers,
    data: { id: 'remove', baseRevision: base.revision, data: removed },
  });
  const edited = structuredClone(original);
  edited.shoppingList.manualItems[0]!.quantity = 4;
  const conflicted = await (
    await request.post(url, {
      headers,
      data: { id: 'edit', baseRevision: base.revision, data: edited },
    })
  ).json();
  expect(conflicted.conflicts).toEqual([
    {
      path: ['shoppingList', 'manualItems', 'milk'],
      values: [null, edited.shoppingList.manualItems[0]],
    },
  ]);
  const choice = {
    conflict: conflicted.conflicts[0],
    value: edited.shoppingList.manualItems[0],
  };
  const resolved = await request.post(`${url}/resolve`, {
    headers,
    data: choice,
  });
  expect(resolved.status()).toBe(200);
  const saved = await resolved.json();
  expect(saved.conflicts).toEqual([]);
  expect(saved.data.shoppingList.manualItems[0].quantity).toBe(4);
  expect(
    (await request.post(`${url}/resolve`, { headers, data: choice })).status(),
  ).toBe(409);
});

test('synchronization combines independent fields and identical edits but retains incompatible quantities', async ({
  request,
  backend,
}) => {
  const admin = await (
    await request.post(`${backend.url}/api/setup`, {
      data: {
        householdName: 'Our kitchen',
        username: 'noah',
        password: 'a long local password',
      },
    })
  ).json();
  const headers = { Authorization: `Bearer ${admin.token}` };
  const url = `${backend.url}/api/households/${admin.household.id}/planning`;
  const original = {
    cookings: {},
    shoppingList: {
      id: 'weekly-list',
      startDate: '2026-10-12',
      endDate: '2026-10-18',
      generatedAt: 1,
      items: [],
      contributions: [],
      manualItems: [
        { id: 'milk', name: 'Milk', quantity: 2, unit: 'l', checked: false },
      ],
    },
  };
  const base = await (
    await request.post(url, {
      headers,
      data: { id: 'original', baseRevision: null, data: original },
    })
  ).json();
  const quantityEdit = structuredClone(original);
  quantityEdit.shoppingList.manualItems[0]!.quantity = 3;
  await request.post(url, {
    headers,
    data: { id: 'quantity', baseRevision: base.revision, data: quantityEdit },
  });
  const nameEdit = structuredClone(original);
  nameEdit.shoppingList.manualItems[0]!.name = 'Oat milk';
  const combined = await (
    await request.post(url, {
      headers,
      data: { id: 'name', baseRevision: base.revision, data: nameEdit },
    })
  ).json();
  expect(combined.data.shoppingList.manualItems).toEqual([
    { id: 'milk', name: 'Oat milk', quantity: 3, unit: 'l', checked: false },
  ]);
  expect(combined.conflicts).toEqual([]);
  const identical = await (
    await request.post(url, {
      headers,
      data: {
        id: 'same-quantity',
        baseRevision: base.revision,
        data: quantityEdit,
      },
    })
  ).json();
  expect(identical.conflicts).toEqual([]);
  const competing = structuredClone(original);
  competing.shoppingList.manualItems[0]!.quantity = 4;
  const conflicted = await (
    await request.post(url, {
      headers,
      data: { id: 'competing', baseRevision: base.revision, data: competing },
    })
  ).json();
  expect(conflicted.conflicts).toEqual([
    {
      path: ['shoppingList', 'manualItems', 'milk', 'quantity'],
      values: [3, 4],
    },
  ]);
  expect(conflicted.data.shoppingList.manualItems[0].name).toBe('Oat milk');
});
