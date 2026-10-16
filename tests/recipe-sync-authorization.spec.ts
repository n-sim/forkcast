import { test, expect } from './backend-fixture';

test('recipe synchronization enforces household ownership and keeps ratings private even from administrators', async ({
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
  const admin = await setup.json();
  const adminHeaders = { Authorization: `Bearer ${admin.token}` };
  const created = await request.post(`${backend.url}/api/accounts`, {
    headers: adminHeaders,
    data: { username: 'sam', password: 'a long local password' },
  });
  const member = await created.json();
  const login = await request.post(`${backend.url}/api/login`, {
    data: { username: 'sam', password: 'a long local password' },
  });
  const signedIn = await login.json();
  const memberHeaders = { Authorization: `Bearer ${signedIn.token}` };
  const collectionUrl = `${backend.url}/api/households/${admin.household.id}`;
  const ratingsUrl = `${backend.url}/api/accounts/${member.id}/recipe-ratings`;
  const revision = {
    id: 'first-revision',
    parentId: null,
    recipe: {
      id: 'pasta',
      name: 'Pasta',
      basePortions: 4,
      ingredients: [
        { id: 'pasta-ingredient', name: 'Pasta', quantity: 500, unit: 'g' },
      ],
      steps: [{ id: 'boil', instruction: 'Boil.', allocations: [] }],
      difficulty: 'easy',
      activeMinutes: 10,
      totalMinutes: 20,
      nutrition: {
        calories: 2000,
        protein: null,
        fat: null,
        carbohydrates: null,
      },
      nutritionVersionId: 'original-nutrition',
    },
    nutritionVersions: [
      {
        id: 'original-nutrition',
        recipeId: 'pasta',
        perPortion: {
          calories: 500,
          protein: null,
          fat: null,
          carbohydrates: null,
        },
      },
    ],
    coverPhoto: null,
  };
  expect((await request.get(`${collectionUrl}/recipes`)).status()).toBe(401);
  expect(
    (
      await request.post(`${collectionUrl}/recipe-revisions`, {
        data: revision,
      })
    ).status(),
  ).toBe(401);
  expect((await request.get(ratingsUrl)).status()).toBe(401);
  expect(
    (await request.post(ratingsUrl, { data: { changes: [] } })).status(),
  ).toBe(401);
  expect(
    (
      await request.get(
        `${backend.url}/api/households/another-household/recipes`,
        { headers: adminHeaders },
      )
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(
        `${backend.url}/api/households/another-household/recipe-revisions`,
        { headers: memberHeaders, data: revision },
      )
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`${collectionUrl}/recipe-revisions`, {
        headers: memberHeaders,
        data: revision,
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await request.post(`${collectionUrl}/recipe-revisions`, {
        headers: memberHeaders,
        data: revision,
      })
    ).status(),
  ).toBe(204);
  expect(
    (await request.get(ratingsUrl, { headers: adminHeaders })).status(),
  ).toBe(403);
  const rating = { id: 'sam-rating', recipeId: 'pasta', value: 2 };
  expect(
    (
      await request.post(ratingsUrl, {
        headers: adminHeaders,
        data: { changes: [rating] },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(ratingsUrl, {
        headers: memberHeaders,
        data: { changes: [{ ...rating, personId: admin.account.id }] },
      })
    ).status(),
  ).toBe(422);
  expect(
    (
      await request.post(ratingsUrl, {
        headers: memberHeaders,
        data: { changes: [{ ...rating, value: 6 }] },
      })
    ).status(),
  ).toBe(422);
  expect(
    (
      await request.post(ratingsUrl, {
        headers: memberHeaders,
        data: { changes: [rating] },
      })
    ).status(),
  ).toBe(204);
  expect(
    await (await request.get(ratingsUrl, { headers: memberHeaders })).json(),
  ).toEqual([{ recipeId: 'pasta', value: 2 }]);
  const adminRatings = `${backend.url}/api/accounts/${admin.account.id}/recipe-ratings`;
  expect(
    (await request.get(adminRatings, { headers: memberHeaders })).status(),
  ).toBe(403);
  expect(
    (
      await request.post(adminRatings, {
        headers: memberHeaders,
        data: { changes: [rating] },
      })
    ).status(),
  ).toBe(403);
  expect(
    await (await request.get(adminRatings, { headers: adminHeaders })).json(),
  ).toEqual([]);
  expect(
    (
      await request.post(adminRatings, {
        headers: adminHeaders,
        data: { changes: [{ ...rating, id: 'noah-rating', value: 5 }] },
      })
    ).status(),
  ).toBe(204);
  // An acknowledged request may be retried after a lost response; replaying an
  // older personal mutation must not replace a later rating or resurrect it.
  expect(
    (
      await request.post(ratingsUrl, {
        headers: memberHeaders,
        data: {
          changes: [{ ...rating, id: 'remove-sam-rating', value: null }],
        },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await request.post(ratingsUrl, {
        headers: memberHeaders,
        data: { changes: [rating] },
      })
    ).status(),
  ).toBe(204);
  expect(
    await (await request.get(ratingsUrl, { headers: memberHeaders })).json(),
  ).toEqual([{ recipeId: 'pasta', value: null }]);
  const collection = await (
    await request.get(`${collectionUrl}/recipes`, { headers: memberHeaders })
  ).json();
  expect(collection.revisions).toHaveLength(1);
  expect(collection.revisions[0]).toEqual(revision);
  expect(collection.current).toEqual([
    { recipeId: 'pasta', revisionId: 'first-revision', unresolved: 0 },
  ]);
  // Existing nutrition identities are immutable, including when a client tries
  // to make the recipe's current values agree with a rewritten historical value.
  expect(
    (
      await request.post(`${collectionUrl}/recipe-revisions`, {
        headers: adminHeaders,
        data: {
          ...revision,
          id: 'rewrite-nutrition',
          parentId: revision.id,
          recipe: {
            ...revision.recipe,
            nutrition: { ...revision.recipe.nutrition, calories: 2400 },
          },
          nutritionVersions: [
            {
              ...revision.nutritionVersions[0],
              perPortion: {
                ...revision.nutritionVersions[0]!.perPortion,
                calories: 600,
              },
            },
          ],
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.post(`${collectionUrl}/recipe-revisions`, {
        headers: adminHeaders,
        data: {
          ...revision,
          id: 'wrong-reference',
          parentId: revision.id,
          recipe: { ...revision.recipe, nutritionVersionId: 'missing-version' },
        },
      })
    ).status(),
  ).toBe(422);
  expect(
    (
      await request.post(`${collectionUrl}/recipe-revisions`, {
        headers: adminHeaders,
        data: {
          ...revision,
          id: 'wrong-recipe',
          parentId: revision.id,
          nutritionVersions: [
            { ...revision.nutritionVersions[0], recipeId: 'another-recipe' },
          ],
        },
      })
    ).status(),
  ).toBe(422);
  await backend.restart();
  expect(
    await (await request.get(ratingsUrl, { headers: memberHeaders })).json(),
  ).toEqual([{ recipeId: 'pasta', value: null }]);
  expect(
    await (await request.get(adminRatings, { headers: adminHeaders })).json(),
  ).toEqual([{ recipeId: 'pasta', value: 5 }]);
});
