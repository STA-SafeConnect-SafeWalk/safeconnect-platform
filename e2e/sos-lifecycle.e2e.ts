import { test, expect } from './fixtures';

test.describe('SOS Lifecycle E2E', () => {
  let apiKey: string;
  let platformId: string;

  test.beforeEach(async ({ api, server }) => {
    const res = await api.post('/admin/platforms', {
      data: {
        platformName: 'SOS E2E Platform',
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

  function h() {
    return { 'x-api-key': apiKey };
  }

  async function registerUser(api: any, platformUserId: string, name: string) {
    const res = await api.post('/register', {
      headers: h(),
      data: { platformUserId, name, email: `${platformUserId}@test.com` },
    });
    return (await res.json()).data.safeWalkId;
  }

  test('complete SOS lifecycle: trigger → update location → cancel', async ({ api, server }) => {
    const victimId = await registerUser(api, 'victim-e2e', 'E2E Victim');
    const contactId = await registerUser(api, 'contact-e2e', 'E2E Contact');

    const contactRes = await api.post('/contacts', {
      headers: h(),
      data: { requesterSafeWalkId: victimId, targetSafeWalkId: contactId },
    });
    expect(contactRes.status()).toBe(201);

    // Trigger SOS
    await server.clearWebhookCalls();
    const sosRes = await api.post('/sos', {
      headers: h(),
      data: { safeWalkId: victimId, geoLocation: { lat: 52.52, lng: 13.405 } },
    });
    expect(sosRes.status()).toBe(201);
    const sosBody = await sosRes.json();
    expect(sosBody.data.status).toBe('ACTIVE');
    expect(sosBody.data.contactsNotified).toBe(1);
    const sosId = sosBody.data.sosId;

    const webhooks = await server.getWebhookCalls();
    expect(webhooks.length).toBe(1);
    expect(webhooks[0].body.type).toBe('SOS_CREATED');
    expect(webhooks[0].body.victim.displayName).toBe('E2E Victim');
    expect(webhooks[0].headers['X-SafeWalk-Event']).toBe('SOS_CREATED');
    expect(webhooks[0].headers['X-SafeWalk-Signature']).toMatch(/^sha256=/);

    // Update location
    await server.clearWebhookCalls();
    const updateRes = await api.patch(`/sos/${sosId}`, {
      headers: h(),
      data: { geoLocation: { lat: 52.53, lng: 13.41 } },
    });
    expect(updateRes.status()).toBe(200);
    const updateBody = await updateRes.json();
    expect(updateBody.data.latestGeoLocation.lat).toBe(52.53);
    expect(updateBody.data.contactsNotified).toBe(1);

    const updateWebhooks = await server.getWebhookCalls();
    expect(updateWebhooks.length).toBe(1);
    expect(updateWebhooks[0].body.type).toBe('SOS_LOCATION_UPDATE');

    // Cancel SOS
    await server.clearWebhookCalls();
    const cancelRes = await api.delete(`/sos/${sosId}`, { headers: h() });
    expect(cancelRes.status()).toBe(200);
    const cancelBody = await cancelRes.json();
    expect(cancelBody.data.status).toBe('CANCELLED');
    expect(cancelBody.data.contactsNotified).toBe(1);

    const cancelWebhooks = await server.getWebhookCalls();
    expect(cancelWebhooks[0].body.type).toBe('SOS_CANCELLED');

    // Trying to update after cancellation returns 410
    const staleRes = await api.patch(`/sos/${sosId}`, {
      headers: h(),
      data: { geoLocation: { lat: 52.54, lng: 13.42 } },
    });
    expect(staleRes.status()).toBe(410);
  });

  test('SOS with no trusted contacts', async ({ api, server }) => {
    const lonelyId = await registerUser(api, 'lonely-e2e', 'Lonely User');

    const sosRes = await api.post('/sos', {
      headers: h(),
      data: { safeWalkId: lonelyId, geoLocation: { lat: 48.8566, lng: 2.3522 } },
    });
    expect(sosRes.status()).toBe(201);
    const sosBody = await sosRes.json();
    expect(sosBody.data.contactsNotified).toBe(0);
    const webhooks = await server.getWebhookCalls();
    expect(webhooks.length).toBe(0);
  });

  test('SOS without geoLocation', async ({ api }) => {
    const userId = await registerUser(api, 'no-geo-e2e', 'No Geo User');

    const sosRes = await api.post('/sos', {
      headers: h(),
      data: { safeWalkId: userId },
    });
    expect(sosRes.status()).toBe(201);

    const sosId = (await sosRes.json()).data.sosId;

    const updateRes = await api.patch(`/sos/${sosId}`, {
      headers: h(),
      data: { geoLocation: { lat: 40.7128, lng: -74.006 } },
    });
    expect(updateRes.status()).toBe(200);
    expect((await updateRes.json()).data.latestGeoLocation.lat).toBe(40.7128);
  });

  test('SOS with invalid coordinates returns 400', async ({ api }) => {
    const userId = await registerUser(api, 'bad-coords-e2e', 'Bad Coords');

    const res = await api.post('/sos', {
      headers: h(),
      data: { safeWalkId: userId, geoLocation: { lat: 999, lng: -74.006 } },
    });
    expect(res.status()).toBe(400);
  });

  test('SOS for non-existent user returns 404', async ({ api }) => {
    const res = await api.post('/sos', {
      headers: h(),
      data: { safeWalkId: 'ghost-user', geoLocation: { lat: 52.52, lng: 13.405 } },
    });
    expect(res.status()).toBe(404);
  });

  test('SOS missing safeWalkId returns 400', async ({ api }) => {
    const res = await api.post('/sos', {
      headers: h(),
      data: { geoLocation: { lat: 52.52, lng: 13.405 } },
    });
    expect(res.status()).toBe(400);
  });

  test('new SOS supersedes existing active SOS', async ({ api }) => {
    const userId = await registerUser(api, 'supersede-e2e', 'Supersede User');

    const sos1 = await api.post('/sos', {
      headers: h(),
      data: { safeWalkId: userId, geoLocation: { lat: 52.52, lng: 13.405 } },
    });
    const sosId1 = (await sos1.json()).data.sosId;

    const sos2 = await api.post('/sos', {
      headers: h(),
      data: { safeWalkId: userId, geoLocation: { lat: 48.8566, lng: 2.3522 } },
    });
    expect(sos2.status()).toBe(201);
    const sosId2 = (await sos2.json()).data.sosId;
    expect(sosId2).not.toBe(sosId1);

    const cancelOld = await api.delete(`/sos/${sosId1}`, { headers: h() });
    expect(cancelOld.status()).toBe(410);
  });

  test('unauthenticated SOS request returns 401', async ({ api }) => {
    const res = await api.post('/sos', {
      data: { safeWalkId: 'test', geoLocation: { lat: 52.52, lng: 13.405 } },
    });
    expect(res.status()).toBe(401);
  });

  test('inactive platform API key is rejected', async ({ api, server }) => {
    await api.patch(`/admin/platforms/${platformId}`, {
      data: { status: 'INACTIVE' },
    });

    const res = await api.post('/register', {
      headers: h(),
      data: { platformUserId: 'inactive-user', name: 'Inactive' },
    });
    expect(res.status()).toBe(401);
  });
});
