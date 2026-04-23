import { createInMemoryDDBMock, setupIntegrationEnv } from '../helpers/in-memory-db';
import { buildApiEvent, parseResponse } from '../helpers/event-builder';

const { db, mock: ddbMock } = createInMemoryDDBMock();

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

import { handler as userHandler } from '../../platform-user-handler/index';
import { handler as contactsHandler } from '../../trusted-contacts-handler/index';
import { handler as sosHandler } from '../../sos-handler/index';
import { handler as adminHandler } from '../../platform-admin-handler/index';

const originalEnv = process.env;

beforeEach(() => {
  db.reset();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ status: 200 } as Response);
  process.env = { ...originalEnv };
  setupIntegrationEnv();
});

afterAll(() => {
  ddbMock.restore();
  process.env = originalEnv;
});

describe('Integration: SOS Lifecycle (register → contact → SOS → update → cancel)', () => {
  const PLATFORM_ID = 'platform-main';
  const PLATFORM_NAME = 'SafeWalk Main';
  const WEBHOOK_URL = 'https://app.example.com/webhook';
  const WEBHOOK_SECRET = 'swsec_integrationtest1234567890abcdef';

  async function seedPlatform() {
    db.put('PlatformsTable', {
      platformId: PLATFORM_ID,
      platformName: PLATFORM_NAME,
      apiKey: 'sw_testapikey1234',
      webhookUrl: WEBHOOK_URL,
      webhookSecret: WEBHOOK_SECRET,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async function registerUser(platformUserId: string, name: string) {
    const event = buildApiEvent({
      method: 'POST',
      path: '/register',
      body: { platformUserId, name, email: `${platformUserId}@test.com` },
      platformId: PLATFORM_ID,
    });
    return parseResponse(await userHandler(event));
  }

  async function createContact(requesterSafeWalkId: string, targetSafeWalkId: string) {
    const event = buildApiEvent({
      method: 'POST',
      path: '/contacts',
      body: { requesterSafeWalkId, targetSafeWalkId },
      platformId: PLATFORM_ID,
    });
    return parseResponse(await contactsHandler(event));
  }

  async function triggerSOS(safeWalkId: string, geoLocation?: { lat: number; lng: number }) {
    const event = buildApiEvent({
      method: 'POST',
      path: '/sos',
      body: { safeWalkId, ...(geoLocation ? { geoLocation } : {}) },
      platformId: PLATFORM_ID,
    });
    return parseResponse(await sosHandler(event));
  }

  async function updateSOSLocation(sosId: string, geoLocation: { lat: number; lng: number }) {
    const event = buildApiEvent({
      method: 'PATCH',
      path: `/sos/${sosId}`,
      pathParameters: { sosId },
      body: { geoLocation },
      platformId: PLATFORM_ID,
    });
    return parseResponse(await sosHandler(event));
  }

  async function cancelSOS(sosId: string) {
    const event = buildApiEvent({
      method: 'DELETE',
      path: `/sos/${sosId}`,
      pathParameters: { sosId },
      platformId: PLATFORM_ID,
    });
    return parseResponse(await sosHandler(event));
  }

  it('full SOS lifecycle with webhook delivery', async () => {
    seedPlatform();

    // 1. Register victim and trusted contact
    const victim = await registerUser('victim-001', 'Victim User');
    expect(victim.status).toBe(201);
    const victimId = victim.body.data.safeWalkId;

    const contact = await registerUser('contact-001', 'Trusted Contact');
    expect(contact.status).toBe(201);
    const contactId = contact.body.data.safeWalkId;

    // 2. Victim adds the trusted contact (outgoing relationship)
    const relationship = await createContact(victimId, contactId);
    expect(relationship.status).toBe(201);

    // 3. Trigger SOS with initial location
    const sos = await triggerSOS(victimId, { lat: 52.52, lng: 13.405 });
    expect(sos.status).toBe(201);
    expect(sos.body.data.status).toBe('ACTIVE');
    expect(sos.body.data.contactsNotified).toBe(1);
    const sosId = sos.body.data.sosId;

    // Verify SOS_CREATED webhook was sent
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const createCall = mockFetch.mock.calls[0];
    expect(createCall[0]).toBe(WEBHOOK_URL);
    const createPayload = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(createPayload.type).toBe('SOS_CREATED');
    expect(createPayload.victim.displayName).toBe('Victim User');
    expect(createPayload.geoLocation.lat).toBe(52.52);

    // 4. Update location
    mockFetch.mockClear();
    const update = await updateSOSLocation(sosId, { lat: 52.53, lng: 13.41 });
    expect(update.status).toBe(200);
    expect(update.body.data.latestGeoLocation.lat).toBe(52.53);
    expect(update.body.data.contactsNotified).toBe(1);

    // Verify SOS_LOCATION_UPDATE webhook
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const updatePayload = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(updatePayload.type).toBe('SOS_LOCATION_UPDATE');

    // 5. Cancel SOS
    mockFetch.mockClear();
    const cancel = await cancelSOS(sosId);
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(cancel.body.data.contactsNotified).toBe(1);

    // Verify SOS_CANCELLED webhook
    const cancelPayload = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(cancelPayload.type).toBe('SOS_CANCELLED');

    // 6. Trying to update a cancelled SOS returns 410
    const staleUpdate = await updateSOSLocation(sosId, { lat: 52.54, lng: 13.42 });
    expect(staleUpdate.status).toBe(410);
  });

  it('SOS without trusted contacts notifies zero contacts', async () => {
    seedPlatform();

    const victim = await registerUser('lonely-user', 'Lonely User');
    const victimId = victim.body.data.safeWalkId;

    const sos = await triggerSOS(victimId, { lat: 48.8566, lng: 2.3522 });
    expect(sos.status).toBe(201);
    expect(sos.body.data.contactsNotified).toBe(0);
    expect(sos.body.data.contactsFound).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('new SOS supersedes existing active SOS', async () => {
    seedPlatform();

    const victim = await registerUser('victim-002', 'Victim Two');
    const victimId = victim.body.data.safeWalkId;

    // First SOS
    const sos1 = await triggerSOS(victimId, { lat: 52.52, lng: 13.405 });
    expect(sos1.status).toBe(201);
    const sosId1 = sos1.body.data.sosId;

    // Second SOS supersedes the first
    mockFetch.mockClear();
    const sos2 = await triggerSOS(victimId, { lat: 48.8566, lng: 2.3522 });
    expect(sos2.status).toBe(201);
    const sosId2 = sos2.body.data.sosId;
    expect(sosId2).not.toBe(sosId1);

    // The old SOS should now be SUPERSEDED — can't cancel it
    const cancelOld = await cancelSOS(sosId1);
    expect(cancelOld.status).toBe(410);
  });

  it('cross-platform SOS is forbidden', async () => {
    seedPlatform();

    const victim = await registerUser('victim-003', 'Victim Three');
    const victimId = victim.body.data.safeWalkId;

    // Try to trigger SOS from a different platform
    const event = buildApiEvent({
      method: 'POST',
      path: '/sos',
      body: { safeWalkId: victimId, geoLocation: { lat: 52.52, lng: 13.405 } },
      platformId: 'wrong-platform',
    });
    const result = parseResponse(await sosHandler(event));
    expect(result.status).toBe(403);
  });

  it('SOS without initial geolocation works', async () => {
    seedPlatform();

    const victim = await registerUser('victim-004', 'Victim Four');
    const victimId = victim.body.data.safeWalkId;

    const sos = await triggerSOS(victimId);
    expect(sos.status).toBe(201);
    expect(sos.body.data.status).toBe('ACTIVE');

    // Can still update with location later
    const update = await updateSOSLocation(sos.body.data.sosId, { lat: 52.52, lng: 13.405 });
    expect(update.status).toBe(200);
    expect(update.body.data.latestGeoLocation.lat).toBe(52.52);
  });

  it('SOS notifies contacts only if sosSharing is enabled', async () => {
    seedPlatform();

    const victim = await registerUser('victim-005', 'Victim Five');
    const victimId = victim.body.data.safeWalkId;
    const friend = await registerUser('friend-005', 'Friend Five');
    const friendId = friend.body.data.safeWalkId;

    // Create contact then disable sosSharing
    const rel = await createContact(victimId, friendId);
    const relContactId = rel.body.data.contactId;

    const updateEvent = buildApiEvent({
      method: 'PATCH',
      path: `/contacts/${relContactId}`,
      pathParameters: { contactId: relContactId },
      body: { safeWalkId: victimId, sosSharing: false },
      platformId: PLATFORM_ID,
    });
    await contactsHandler(updateEvent);

    // Trigger SOS — should NOT notify contact since sosSharing=false
    const sos = await triggerSOS(victimId, { lat: 52.52, lng: 13.405 });
    expect(sos.status).toBe(201);
    expect(sos.body.data.contactsFound).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
