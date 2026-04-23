import { test, expect } from './fixtures';

test.describe('User Journey E2E', () => {
  let apiKey: string;
  let platformId: string;

  test.beforeEach(async ({ api, server }) => {
    // Create a platform to get an API key for authenticated requests
    const res = await api.post('/admin/platforms', {
      data: {
        platformName: 'User Journey Platform',
        redirectUrl: 'https://example.com',
        contactName: 'Test',
        contactEmail: 'test@example.com',
        webhookUrl: 'https://example.com/webhook',
      },
    });
    const body = await res.json();
    apiKey = body.data.apiKey;
    platformId = body.data.platformId;
  });

  function authHeaders() {
    return { 'x-api-key': apiKey };
  }

  test('full user lifecycle: register → sharing code → trusted contact → list → revoke', async ({
    api,
  }) => {
    // 1. Register Alice
    const aliceRes = await api.post('/register', {
      headers: authHeaders(),
      data: { platformUserId: 'alice-001', name: 'Alice', email: 'alice@example.com' },
    });
    expect(aliceRes.status()).toBe(201);
    const aliceId = (await aliceRes.json()).data.safeWalkId;
    expect(aliceId).toBeTruthy();

    // 2. Register Bob
    const bobRes = await api.post('/register', {
      headers: authHeaders(),
      data: { platformUserId: 'bob-002', name: 'Bob', email: 'bob@example.com' },
    });
    expect(bobRes.status()).toBe(201);
    const bobId = (await bobRes.json()).data.safeWalkId;

    // 3. Alice generates sharing code
    const codeRes = await api.post('/sharing-codes', {
      headers: authHeaders(),
      data: { safeWalkId: aliceId },
    });
    expect(codeRes.status()).toBe(201);
    const codeBody = await codeRes.json();
    const sharingCode = codeBody.data.sharingCode;
    expect(sharingCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(codeBody.data.expiresAt).toBeTruthy();

    // 4. Bob uses sharing code to add Alice as trusted contact
    const contactRes = await api.post('/contacts', {
      headers: authHeaders(),
      data: { requesterSafeWalkId: bobId, sharingCode },
    });
    expect(contactRes.status()).toBe(201);
    const contactBody = await contactRes.json();
    expect(contactBody.data.requesterSafeWalkId).toBe(bobId);
    expect(contactBody.data.targetSafeWalkId).toBe(aliceId);
    expect(contactBody.data.locationSharing).toBe(true);
    expect(contactBody.data.sosSharing).toBe(true);
    const contactId = contactBody.data.contactId;

    // 5. Bob lists contacts — sees Alice outgoing
    const bobContactsRes = await api.get(`/contacts/${bobId}`, {
      headers: authHeaders(),
    });
    expect(bobContactsRes.status()).toBe(200);
    const bobContacts = await bobContactsRes.json();
    expect(bobContacts.data.count).toBe(1);
    expect(bobContacts.data.contacts[0].direction).toBe('outgoing');
    expect(bobContacts.data.contacts[0].peerName).toBe('Alice');

    // 6. Alice lists contacts — sees Bob incoming
    const aliceContactsRes = await api.get(`/contacts/${aliceId}`, {
      headers: authHeaders(),
    });
    expect(aliceContactsRes.status()).toBe(200);
    const aliceContacts = await aliceContactsRes.json();
    expect(aliceContacts.data.count).toBe(1);
    expect(aliceContacts.data.contacts[0].direction).toBe('incoming');
    expect(aliceContacts.data.contacts[0].peerName).toBe('Bob');

    // 7. Bob updates sharing preferences
    const updateRes = await api.patch(`/contacts/${contactId}`, {
      headers: authHeaders(),
      data: { safeWalkId: bobId, locationSharing: false },
    });
    expect(updateRes.status()).toBe(200);
    expect((await updateRes.json()).data.locationSharing).toBe(false);

    // 8. Revoke the contact
    const revokeRes = await api.delete(`/contacts/${contactId}`, {
      headers: authHeaders(),
    });
    expect(revokeRes.status()).toBe(200);
    expect((await revokeRes.json()).data.status).toBe('REVOKED');

    // 9. Both users now see zero contacts
    const bobAfter = await api.get(`/contacts/${bobId}`, { headers: authHeaders() });
    expect((await bobAfter.json()).data.count).toBe(0);
  });

  test('unauthenticated request is rejected', async ({ api }) => {
    const res = await api.post('/register', {
      data: { platformUserId: 'unauth-user', name: 'No Auth' },
    });
    expect(res.status()).toBe(401);
  });

  test('invalid API key is rejected', async ({ api }) => {
    const res = await api.post('/register', {
      headers: { 'x-api-key': 'sw_invalidkey' },
      data: { platformUserId: 'bad-key-user', name: 'Bad Key' },
    });
    expect(res.status()).toBe(401);
  });

  test('duplicate registration returns 409', async ({ api }) => {
    await api.post('/register', {
      headers: authHeaders(),
      data: { platformUserId: 'dup-user', name: 'First' },
    });

    const dupRes = await api.post('/register', {
      headers: authHeaders(),
      data: { platformUserId: 'dup-user', name: 'Second' },
    });
    expect(dupRes.status()).toBe(409);
  });

  test('registration with missing platformUserId returns 400', async ({ api }) => {
    const res = await api.post('/register', {
      headers: authHeaders(),
      data: { name: 'No ID' },
    });
    expect(res.status()).toBe(400);
  });

  test('sharing code for non-existent user returns 404', async ({ api }) => {
    const res = await api.post('/sharing-codes', {
      headers: authHeaders(),
      data: { safeWalkId: 'non-existent-id' },
    });
    expect(res.status()).toBe(404);
  });

  test('self-referential contact creation returns 400', async ({ api }) => {
    const userRes = await api.post('/register', {
      headers: authHeaders(),
      data: { platformUserId: 'self-ref', name: 'Narcissus' },
    });
    const userId = (await userRes.json()).data.safeWalkId;

    const codeRes = await api.post('/sharing-codes', {
      headers: authHeaders(),
      data: { safeWalkId: userId },
    });
    const code = (await codeRes.json()).data.sharingCode;

    const contactRes = await api.post('/contacts', {
      headers: authHeaders(),
      data: { requesterSafeWalkId: userId, sharingCode: code },
    });
    expect(contactRes.status()).toBe(400);
  });

  test('bidirectional contact: Alice adds Bob, Bob adds Alice back', async ({ api }) => {
    const aliceRes = await api.post('/register', {
      headers: authHeaders(),
      data: { platformUserId: 'alice-bi', name: 'Alice' },
    });
    const aliceId = (await aliceRes.json()).data.safeWalkId;

    const bobRes = await api.post('/register', {
      headers: authHeaders(),
      data: { platformUserId: 'bob-bi', name: 'Bob' },
    });
    const bobId = (await bobRes.json()).data.safeWalkId;

    // Alice adds Bob
    const c1 = await api.post('/contacts', {
      headers: authHeaders(),
      data: { requesterSafeWalkId: aliceId, targetSafeWalkId: bobId },
    });
    expect(c1.status()).toBe(201);

    // Bob adds Alice back
    const c2 = await api.post('/contacts', {
      headers: authHeaders(),
      data: { requesterSafeWalkId: bobId, targetSafeWalkId: aliceId },
    });
    expect(c2.status()).toBe(201);

    // Alice should see 2 contacts: 1 outgoing + 1 incoming
    const aliceContacts = await api.get(`/contacts/${aliceId}`, { headers: authHeaders() });
    const aliceData = await aliceContacts.json();
    expect(aliceData.data.count).toBe(2);
    const directions = aliceData.data.contacts.map((c: any) => c.direction).sort();
    expect(directions).toEqual(['incoming', 'outgoing']);
  });
});
