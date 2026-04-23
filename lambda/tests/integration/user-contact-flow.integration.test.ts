import { createInMemoryDDBMock, setupIntegrationEnv } from '../helpers/in-memory-db';
import { buildApiEvent, parseResponse } from '../helpers/event-builder';

const { db, mock: ddbMock } = createInMemoryDDBMock();

import { handler as userHandler } from '../../platform-user-handler/index';
import { handler as contactsHandler } from '../../trusted-contacts-handler/index';

const originalEnv = process.env;

beforeEach(() => {
  db.reset();
  process.env = { ...originalEnv };
  setupIntegrationEnv();
});

afterAll(() => {
  ddbMock.restore();
  process.env = originalEnv;
});

describe('Integration: User Registration → Sharing Code → Trusted Contact', () => {
  const PLATFORM_A = 'platform-alpha';
  const PLATFORM_B = 'platform-beta';

  async function registerUser(platformId: string, platformUserId: string, name: string) {
    const event = buildApiEvent({
      method: 'POST',
      path: '/register',
      body: { platformUserId, name, email: `${platformUserId}@test.com` },
      platformId,
    });
    return parseResponse(await userHandler(event));
  }

  async function generateSharingCode(platformId: string, safeWalkId: string) {
    const event = buildApiEvent({
      method: 'POST',
      path: '/sharing-codes',
      body: { safeWalkId },
      platformId,
    });
    return parseResponse(await userHandler(event));
  }

  async function createContact(
    platformId: string,
    requesterSafeWalkId: string,
    opts: { sharingCode?: string; targetSafeWalkId?: string }
  ) {
    const event = buildApiEvent({
      method: 'POST',
      path: '/contacts',
      body: { requesterSafeWalkId, ...opts },
      platformId,
    });
    return parseResponse(await contactsHandler(event));
  }

  async function listContacts(platformId: string, safeWalkId: string) {
    const event = buildApiEvent({
      method: 'GET',
      path: `/contacts/${safeWalkId}`,
      pathParameters: { safeWalkId },
      platformId,
    });
    return parseResponse(await contactsHandler(event));
  }

  async function revokeContact(platformId: string, contactId: string) {
    const event = buildApiEvent({
      method: 'DELETE',
      path: `/contacts/${contactId}`,
      pathParameters: { contactId },
      platformId,
    });
    return parseResponse(await contactsHandler(event));
  }

  it('full flow: register two users, share code, create contact, list, revoke', async () => {
    // 1. Register User A on Platform Alpha
    const userA = await registerUser(PLATFORM_A, 'alice-123', 'Alice');
    expect(userA.status).toBe(201);
    const aliceSafeWalkId = userA.body.data.safeWalkId;
    expect(aliceSafeWalkId).toBeDefined();

    // 2. Register User B on same platform
    const userB = await registerUser(PLATFORM_A, 'bob-456', 'Bob');
    expect(userB.status).toBe(201);
    const bobSafeWalkId = userB.body.data.safeWalkId;

    // 3. Alice generates a sharing code
    const codeResult = await generateSharingCode(PLATFORM_A, aliceSafeWalkId);
    expect(codeResult.status).toBe(201);
    const sharingCode = codeResult.body.data.sharingCode;
    expect(sharingCode).toMatch(/^[A-Z2-9]{6}$/);

    // 4. Bob uses the sharing code to add Alice as a trusted contact
    const contact = await createContact(PLATFORM_A, bobSafeWalkId, { sharingCode });
    expect(contact.status).toBe(201);
    expect(contact.body.data.requesterSafeWalkId).toBe(bobSafeWalkId);
    expect(contact.body.data.targetSafeWalkId).toBe(aliceSafeWalkId);
    expect(contact.body.data.status).toBe('ACTIVE');
    const contactId = contact.body.data.contactId;

    // 5. Bob can see Alice in his contacts (outgoing)
    const bobContacts = await listContacts(PLATFORM_A, bobSafeWalkId);
    expect(bobContacts.status).toBe(200);
    expect(bobContacts.body.data.count).toBe(1);
    expect(bobContacts.body.data.contacts[0].direction).toBe('outgoing');
    expect(bobContacts.body.data.contacts[0].peerName).toBe('Alice');

    // 6. Alice can see Bob in her contacts (incoming)
    const aliceContacts = await listContacts(PLATFORM_A, aliceSafeWalkId);
    expect(aliceContacts.status).toBe(200);
    expect(aliceContacts.body.data.count).toBe(1);
    expect(aliceContacts.body.data.contacts[0].direction).toBe('incoming');
    expect(aliceContacts.body.data.contacts[0].peerName).toBe('Bob');

    // 7. Revoke the contact
    const revoke = await revokeContact(PLATFORM_A, contactId);
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.status).toBe('REVOKED');

    // 8. Both users now see zero active contacts
    const bobAfter = await listContacts(PLATFORM_A, bobSafeWalkId);
    expect(bobAfter.body.data.count).toBe(0);

    const aliceAfter = await listContacts(PLATFORM_A, aliceSafeWalkId);
    expect(aliceAfter.body.data.count).toBe(0);
  });

  it('duplicate registration returns 409', async () => {
    const first = await registerUser(PLATFORM_A, 'carol-789', 'Carol');
    expect(first.status).toBe(201);

    const duplicate = await registerUser(PLATFORM_A, 'carol-789', 'Carol');
    expect(duplicate.status).toBe(409);
  });

  it('sharing code from different platform is rejected', async () => {
    const userA = await registerUser(PLATFORM_A, 'alice-123', 'Alice');
    const aliceSafeWalkId = userA.body.data.safeWalkId;

    // Try to generate sharing code using Platform B (wrong platform)
    const codeResult = await generateSharingCode(PLATFORM_B, aliceSafeWalkId);
    expect(codeResult.status).toBe(403);
  });

  it('self-referential contact creation is rejected', async () => {
    const userA = await registerUser(PLATFORM_A, 'alice-123', 'Alice');
    const aliceSafeWalkId = userA.body.data.safeWalkId;

    // Alice generates code, then tries to add herself
    const codeResult = await generateSharingCode(PLATFORM_A, aliceSafeWalkId);
    const contact = await createContact(PLATFORM_A, aliceSafeWalkId, {
      sharingCode: codeResult.body.data.sharingCode,
    });
    expect(contact.status).toBe(400);
    expect(contact.body.message).toContain('themselves');
  });

  it('duplicate active contact returns 409', async () => {
    const userA = await registerUser(PLATFORM_A, 'alice-123', 'Alice');
    const userB = await registerUser(PLATFORM_A, 'bob-456', 'Bob');
    const aliceSafeWalkId = userA.body.data.safeWalkId;
    const bobSafeWalkId = userB.body.data.safeWalkId;

    // Bob adds Alice via direct targetSafeWalkId
    const first = await createContact(PLATFORM_A, bobSafeWalkId, {
      targetSafeWalkId: aliceSafeWalkId,
    });
    expect(first.status).toBe(201);

    // Bob tries to add Alice again
    const duplicate = await createContact(PLATFORM_A, bobSafeWalkId, {
      targetSafeWalkId: aliceSafeWalkId,
    });
    expect(duplicate.status).toBe(409);
  });

  it('revoked contact can be re-activated', async () => {
    const userA = await registerUser(PLATFORM_A, 'alice-123', 'Alice');
    const userB = await registerUser(PLATFORM_A, 'bob-456', 'Bob');
    const aliceSafeWalkId = userA.body.data.safeWalkId;
    const bobSafeWalkId = userB.body.data.safeWalkId;

    // Create contact
    const contact = await createContact(PLATFORM_A, bobSafeWalkId, {
      targetSafeWalkId: aliceSafeWalkId,
    });
    const contactId = contact.body.data.contactId;

    // Revoke it
    await revokeContact(PLATFORM_A, contactId);

    // Re-create — should reactivate the revoked record
    const reactivated = await createContact(PLATFORM_A, bobSafeWalkId, {
      targetSafeWalkId: aliceSafeWalkId,
    });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.data.contactId).toBe(contactId);
    expect(reactivated.body.data.status).toBe('ACTIVE');
  });

  it('contact update toggles sharing preferences', async () => {
    const userA = await registerUser(PLATFORM_A, 'alice-123', 'Alice');
    const userB = await registerUser(PLATFORM_A, 'bob-456', 'Bob');
    const aliceSafeWalkId = userA.body.data.safeWalkId;
    const bobSafeWalkId = userB.body.data.safeWalkId;

    const contact = await createContact(PLATFORM_A, bobSafeWalkId, {
      targetSafeWalkId: aliceSafeWalkId,
    });
    const contactId = contact.body.data.contactId;

    // Toggle locationSharing off
    const updateEvent = buildApiEvent({
      method: 'PATCH',
      path: `/contacts/${contactId}`,
      pathParameters: { contactId },
      body: { safeWalkId: bobSafeWalkId, locationSharing: false },
      platformId: PLATFORM_A,
    });
    const updated = parseResponse(await contactsHandler(updateEvent));
    expect(updated.status).toBe(200);
    expect(updated.body.data.locationSharing).toBe(false);
    expect(updated.body.data.sosSharing).toBe(true);
  });
});
