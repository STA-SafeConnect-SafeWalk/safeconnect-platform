import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHmac } from 'crypto';
import { handler } from '../sos-handler/index';

const ddbMock = mockClient(DynamoDBDocumentClient);

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

describe('sos-handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    ddbMock.reset();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ status: 200 } as Response);
    process.env = { ...originalEnv };
    process.env.SOS_EVENTS_TABLE_NAME = 'SOSEventsTable';
    process.env.SOS_LOCATION_AUDIT_TABLE_NAME = 'SOSLocationAuditTable';
    process.env.USERS_TABLE_NAME = 'UsersTable';
    process.env.CONTACTS_TABLE_NAME = 'ContactsTable';
    process.env.PLATFORMS_TABLE_NAME = 'PlatformsTable';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const generateEvent = (
    method: string,
    path: string,
    body?: any,
    pathParameters?: any,
    platformId: string = 'platform-1',
  ): APIGatewayProxyEventV2 => {
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: path,
      rawQueryString: '',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      pathParameters,
      requestContext: {
        http: { method, path, protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
        authorizer: {
          lambda: {
            platformId,
            platformName: 'Test Platform',
          },
        },
      } as any,
    } as any;
  };

  const mockVictimUser = {
    safeWalkId: 'victim-sw-id',
    platformId: 'platform-1',
    platformUserId: 'victim-platform-uid',
    name: 'Victim User',
    email: 'victim@test.com',
  };

  const mockTargetUser = {
    safeWalkId: 'target-sw-id',
    platformId: 'platform-2',
    platformUserId: 'target-platform-uid',
    name: 'Target User',
  };

  const mockPlatform2 = {
    platformId: 'platform-2',
    webhookUrl: 'https://platform2.app/webhook',
    webhookSecret: 'swsec_abc123',
  };

  const mockActiveContact = {
    contactId: 'contact-1',
    requesterSafeWalkId: 'victim-sw-id',
    targetSafeWalkId: 'target-sw-id',
    platformId: 'platform-1',
    status: 'ACTIVE',
    sosSharing: true,
    locationSharing: true,
  };

  function setupCreateSOSMocks() {
    // GetCommand: victim user lookup
    ddbMock.on(GetCommand, { TableName: 'UsersTable', Key: { safeWalkId: 'victim-sw-id' } })
      .resolves({ Item: mockVictimUser });

    // QueryCommand: no existing active SOS
    ddbMock.on(QueryCommand, { TableName: 'SOSEventsTable' })
      .resolves({ Items: [] });

    // PutCommand: SOS event + location audit
    ddbMock.on(PutCommand).resolves({});

    // QueryCommand: outgoing trusted contacts only (victim is requester)
    ddbMock.on(QueryCommand, { TableName: 'ContactsTable', IndexName: 'RequesterIndex' })
      .resolves({ Items: [mockActiveContact] });

    // BatchGetCommand: resolve target users
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { UsersTable: [mockTargetUser] },
    });

    // GetCommand: platform webhook info
    ddbMock.on(GetCommand, { TableName: 'PlatformsTable', Key: { platformId: 'platform-2' } })
      .resolves({ Item: mockPlatform2 });
  }

  describe('POST /sos (Create SOS)', () => {
    it('should create an SOS event and notify contacts', async () => {
      setupCreateSOSMocks();

      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });

      const result = (await handler(event)) as any;

      expect(result.statusCode).toBe(201);
      const data = JSON.parse(result.body).data;
      expect(data.sosId).toBeDefined();
      expect(data.status).toBe('ACTIVE');
      expect(data.contactsNotified).toBe(1);
      expect(data.createdAt).toBeDefined();

      // Verify SOS event and location audit were written
      expect(ddbMock.commandCalls(PutCommand).length).toBe(2);

      // Verify webhook was called
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://platform2.app/webhook');
      const fetchOptions = fetchCall[1] as RequestInit;
      expect(fetchOptions.headers).toHaveProperty('X-SafeWalk-Event', 'SOS_CREATED');
      expect(fetchOptions.headers).toHaveProperty('X-SafeWalk-Signature');
      expect(fetchOptions.headers).toHaveProperty('X-SafeWalk-Timestamp');

      // Verify payload contains correct data
      const sentPayload = JSON.parse(fetchOptions.body as string);
      expect(sentPayload.type).toBe('SOS_CREATED');
      expect(sentPayload.victim.safeWalkId).toBe('victim-sw-id');
      expect(sentPayload.victim.platformId).toBe('platform-1');
      expect(sentPayload.victim.displayName).toBe('Victim User');
      expect(sentPayload.targets).toHaveLength(1);
      expect(sentPayload.targets[0].safeWalkId).toBe('target-sw-id');
      expect(sentPayload.targets[0].platformId).toBe('platform-2');
      expect(sentPayload.geoLocation.lat).toBe(48.8566);
      expect(sentPayload.geoLocation.lng).toBe(2.3522);
    });

    it('should return 400 for missing safeWalkId', async () => {
      const event = generateEvent('POST', '/sos', {
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(400);
    });

    it('should return 400 for invalid geo coordinates', async () => {
      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
        geoLocation: { lat: 200, lng: 2.3522 },
      });
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('lat');
    });

    it('should return 400 for missing geoLocation', async () => {
      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
      });
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(400);
    });

    it('should return 404 if user not found', async () => {
      ddbMock.on(GetCommand, { TableName: 'UsersTable' }).resolves({});

      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'nonexistent-id',
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(404);
    });

    it('should return 403 if user does not belong to platform', async () => {
      ddbMock.on(GetCommand, { TableName: 'UsersTable' }).resolves({
        Item: { ...mockVictimUser, platformId: 'other-platform' },
      });

      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(403);
    });

    it('should supersede existing active SOS', async () => {
      const existingSOS = {
        sosId: 'old-sos-id',
        victimSafeWalkId: 'victim-sw-id',
        status: 'ACTIVE',
      };

      ddbMock.on(GetCommand, { TableName: 'UsersTable' }).resolves({ Item: mockVictimUser });
      ddbMock.on(QueryCommand, { TableName: 'SOSEventsTable' }).resolves({ Items: [existingSOS] });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand, { TableName: 'ContactsTable', IndexName: 'RequesterIndex' }).resolves({ Items: [] });

      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(201);

      // Verify old SOS was superseded
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':superseded']).toBe('SUPERSEDED');
    });

    it('should create SOS with 0 contactsNotified when no trusted contacts exist', async () => {
      ddbMock.on(GetCommand, { TableName: 'UsersTable' }).resolves({ Item: mockVictimUser });
      ddbMock.on(QueryCommand, { TableName: 'SOSEventsTable' }).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand, { TableName: 'ContactsTable', IndexName: 'RequesterIndex' }).resolves({ Items: [] });

      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(201);
      const data = JSON.parse(result.body).data;
      expect(data.contactsNotified).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should NOT notify contacts who only added the victim (incoming direction)', async () => {
      // The victim is the *target* in this contact — someone else added the victim.
      // The victim did not choose this person to receive their SOS.
      const incomingOnlyContact = {
        contactId: 'contact-incoming',
        requesterSafeWalkId: 'some-other-user',
        targetSafeWalkId: 'victim-sw-id', // victim is the target
        platformId: 'platform-1',
        status: 'ACTIVE',
        sosSharing: true,
      };

      ddbMock.on(GetCommand, { TableName: 'UsersTable' }).resolves({ Item: mockVictimUser });
      ddbMock.on(QueryCommand, { TableName: 'SOSEventsTable' }).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      // RequesterIndex returns no outgoing contacts for the victim
      ddbMock.on(QueryCommand, { TableName: 'ContactsTable', IndexName: 'RequesterIndex' })
        .resolves({ Items: [] });

      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(201);
      const data = JSON.parse(result.body).data;
      // The incoming-only contact must NOT be notified
      expect(data.contactsNotified).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
      // TargetIndex should never be queried
      expect(ddbMock.commandCalls(QueryCommand, { TableName: 'ContactsTable', IndexName: 'TargetIndex' }).length).toBe(0);
    });

    it('should succeed even if webhook delivery fails', async () => {
      setupCreateSOSMocks();
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(201);
      // Webhook failure should not cause SOS creation to fail
    });

    it('should return 401 if no platform auth context', async () => {
      const event = {
        version: '2.0',
        routeKey: '$default',
        rawPath: '/sos',
        rawQueryString: '',
        headers: {},
        body: JSON.stringify({ safeWalkId: 'test', geoLocation: { lat: 0, lng: 0 } }),
        requestContext: {
          http: { method: 'POST', path: '/sos', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
          authorizer: {},
        },
      } as any;

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(401);
    });

    it('should verify HMAC signature correctness', async () => {
      setupCreateSOSMocks();

      const event = generateEvent('POST', '/sos', {
        safeWalkId: 'victim-sw-id',
        geoLocation: { lat: 48.8566, lng: 2.3522 },
      });

      await handler(event);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchOptions = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = fetchOptions.headers as Record<string, string>;
      const sentBody = fetchOptions.body as string;
      const sentTimestamp = headers['X-SafeWalk-Timestamp'];
      const sentSignature = headers['X-SafeWalk-Signature'];

      // Recompute HMAC
      const expectedHmac = createHmac('sha256', 'swsec_abc123')
        .update(`${sentTimestamp}.${sentBody}`)
        .digest('hex');

      expect(sentSignature).toBe(`sha256=${expectedHmac}`);
    });
  });

  describe('PATCH /sos/{sosId} (Update Location)', () => {
    const mockSOSEvent = {
      sosId: 'sos-123',
      victimSafeWalkId: 'victim-sw-id',
      victimPlatformId: 'platform-1',
      victimPlatformUserId: 'victim-platform-uid',
      victimDisplayName: 'Victim User',
      status: 'ACTIVE',
      latestGeoLocation: { lat: 48.8566, lng: 2.3522 },
      ttl: 9999999999,
    };

    it('should update SOS location and send location update webhook', async () => {
      ddbMock.on(GetCommand, { TableName: 'SOSEventsTable' }).resolves({ Item: mockSOSEvent });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand, { TableName: 'ContactsTable', IndexName: 'RequesterIndex' })
        .resolves({ Items: [mockActiveContact] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { UsersTable: [mockTargetUser] } });
      ddbMock.on(GetCommand, { TableName: 'PlatformsTable' }).resolves({ Item: mockPlatform2 });

      const event = generateEvent('PATCH', '/sos/sos-123', {
        geoLocation: { lat: 48.8584, lng: 2.2945 },
      }, { sosId: 'sos-123' });

      const result = (await handler(event)) as any;

      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body).data;
      expect(data.status).toBe('ACTIVE');
      expect(data.latestGeoLocation.lat).toBe(48.8584);
      expect(data.contactsNotified).toBe(1);

      // Verify webhook is SOS_LOCATION_UPDATE, NOT SOS_CREATED
      const fetchOptions = mockFetch.mock.calls[0][1] as RequestInit;
      const sentPayload = JSON.parse(fetchOptions.body as string);
      expect(sentPayload.type).toBe('SOS_LOCATION_UPDATE');
      expect((fetchOptions.headers as Record<string, string>)['X-SafeWalk-Event']).toBe('SOS_LOCATION_UPDATE');

      // Verify location audit entry was written
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBe(1);
      expect(putCalls[0].args[0].input.TableName).toBe('SOSLocationAuditTable');
    });

    it('should return 404 for non-existent SOS', async () => {
      ddbMock.on(GetCommand, { TableName: 'SOSEventsTable' }).resolves({});

      const event = generateEvent('PATCH', '/sos/nonexistent', {
        geoLocation: { lat: 48.8584, lng: 2.2945 },
      }, { sosId: 'nonexistent' });

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(404);
    });

    it('should return 410 for cancelled SOS', async () => {
      ddbMock.on(GetCommand, { TableName: 'SOSEventsTable' }).resolves({
        Item: { ...mockSOSEvent, status: 'CANCELLED' },
      });

      const event = generateEvent('PATCH', '/sos/sos-123', {
        geoLocation: { lat: 48.8584, lng: 2.2945 },
      }, { sosId: 'sos-123' });

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(410);
    });

    it('should return 403 for wrong platform', async () => {
      ddbMock.on(GetCommand, { TableName: 'SOSEventsTable' }).resolves({ Item: mockSOSEvent });

      const event = generateEvent('PATCH', '/sos/sos-123', {
        geoLocation: { lat: 48.8584, lng: 2.2945 },
      }, { sosId: 'sos-123' }, 'wrong-platform');

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(403);
    });

    it('should return 400 for invalid geoLocation', async () => {
      const event = generateEvent('PATCH', '/sos/sos-123', {
        geoLocation: { lat: 'invalid', lng: 2.2945 },
      }, { sosId: 'sos-123' });

      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(400);
    });
  });

  describe('DELETE /sos/{sosId} (Cancel SOS)', () => {
    const mockSOSEvent = {
      sosId: 'sos-123',
      victimSafeWalkId: 'victim-sw-id',
      victimPlatformId: 'platform-1',
      victimPlatformUserId: 'victim-platform-uid',
      victimDisplayName: 'Victim User',
      status: 'ACTIVE',
    };

    it('should cancel SOS and send cancellation webhook', async () => {
      ddbMock.on(GetCommand, { TableName: 'SOSEventsTable' }).resolves({ Item: mockSOSEvent });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(QueryCommand, { TableName: 'ContactsTable', IndexName: 'RequesterIndex' })
        .resolves({ Items: [mockActiveContact] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { UsersTable: [mockTargetUser] } });
      ddbMock.on(GetCommand, { TableName: 'PlatformsTable' }).resolves({ Item: mockPlatform2 });

      const event = generateEvent('DELETE', '/sos/sos-123', undefined, { sosId: 'sos-123' });
      const result = (await handler(event)) as any;

      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body).data;
      expect(data.status).toBe('CANCELLED');
      expect(data.contactsNotified).toBe(1);

      // Verify status was updated to CANCELLED
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':cancelled']).toBe('CANCELLED');

      // Verify webhook type is SOS_CANCELLED and no geoLocation
      const fetchOptions = mockFetch.mock.calls[0][1] as RequestInit;
      const sentPayload = JSON.parse(fetchOptions.body as string);
      expect(sentPayload.type).toBe('SOS_CANCELLED');
      expect(sentPayload.geoLocation).toBeUndefined();
      expect((fetchOptions.headers as Record<string, string>)['X-SafeWalk-Event']).toBe('SOS_CANCELLED');
    });

    it('should return 404 for non-existent SOS', async () => {
      ddbMock.on(GetCommand, { TableName: 'SOSEventsTable' }).resolves({});

      const event = generateEvent('DELETE', '/sos/nonexistent', undefined, { sosId: 'nonexistent' });
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(404);
    });

    it('should return 410 for already cancelled SOS', async () => {
      ddbMock.on(GetCommand, { TableName: 'SOSEventsTable' }).resolves({
        Item: { ...mockSOSEvent, status: 'CANCELLED' },
      });

      const event = generateEvent('DELETE', '/sos/sos-123', undefined, { sosId: 'sos-123' });
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(410);
    });

    it('should return 403 for wrong platform', async () => {
      ddbMock.on(GetCommand, { TableName: 'SOSEventsTable' }).resolves({ Item: mockSOSEvent });

      const event = generateEvent('DELETE', '/sos/sos-123', undefined, { sosId: 'sos-123' }, 'wrong-platform');
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(403);
    });
  });

  describe('Route handling', () => {
    it('should return 404 for unknown routes', async () => {
      const event = generateEvent('GET', '/sos', undefined, undefined);
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(404);
    });

    it('should return 400 for invalid JSON body on POST', async () => {
      const event = {
        ...generateEvent('POST', '/sos', undefined),
        body: 'not-json{{{',
      };
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('Invalid JSON');
    });
  });
});
