import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyResult } from 'aws-lambda';
import { handler } from '../trusted-contacts-handler/index';

const ddbMock = mockClient(DynamoDBDocumentClient);

const mockPlatformContext = {
  requestContext: {
    authorizer: {
      lambda: {
        platformId: 'platform-abc',
      },
    },
    http: { method: 'POST' },
  },
};

function buildEvent(overrides: Record<string, any> = {}) {
  return { ...mockPlatformContext, ...overrides } as any;
}

/** Helper: returns a valid (non-expired) sharing code record */
function validSharingCodeRecord(safeWalkId: string, code: string) {
  const now = new Date();
  return {
    safeWalkId,
    sharingCode: code,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** Helper: returns an expired sharing code record */
function expiredSharingCodeRecord(safeWalkId: string, code: string) {
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
  return {
    safeWalkId,
    sharingCode: code,
    createdAt: new Date(past.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: past.toISOString(),
  };
}

describe('trusted-contacts-handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    ddbMock.reset();
    process.env = {
      ...originalEnv,
      CONTACTS_TABLE_NAME: 'TestContacts',
      USERS_TABLE_NAME: 'TestUsers',
      SHARING_CODES_TABLE_NAME: 'TestSharingCodes',
      PLATFORMS_TABLE_NAME: 'TestPlatforms',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return 401 if authorizer context is missing', async () => {
    const event = buildEvent({
      requestContext: { http: { method: 'POST' } },
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        sharingCode: 'ABC123',
      }),
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(401);
  });

  it('should return 400 when requesterSafeWalkId is missing', async () => {
    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({ sharingCode: 'ABC123' }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Validation Error');
  });

  it('should return 400 when sharingCode is missing', async () => {
    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({ requesterSafeWalkId: 'user-1' }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('either sharingCode or targetSafeWalkId');
  });

  it('should return 404 if reverse-connect target safeWalkId does not exist', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'TestUsers' })
      .resolvesOnce({ Item: { safeWalkId: 'user-1', platformId: 'platform-abc' } })
      .resolvesOnce({ Item: undefined });

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        targetSafeWalkId: 'user-2',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Target safeWalkId');
  });

  it('should return 404 if requester safeWalkId does not exist', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestUsers' }).resolves({ Item: undefined });

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'non-existent',
        sharingCode: 'ABC123',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Requester');
  });

  it('should return 404 if sharing code resolves to no record', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestUsers' }).resolves({
      Item: { safeWalkId: 'user-1', platformId: 'platform-abc' },
    });
    ddbMock.on(QueryCommand, { TableName: 'TestSharingCodes' }).resolves({ Items: [] });

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        sharingCode: 'NOPE00',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('sharing code');
  });

  it('should return 410 if sharing code has expired', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestUsers' }).resolves({
      Item: { safeWalkId: 'user-1', platformId: 'platform-abc' },
    });
    ddbMock.on(QueryCommand, { TableName: 'TestSharingCodes' }).resolves({
      Items: [expiredSharingCodeRecord('user-2', 'EXPIRE')],
    });

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        sharingCode: 'EXPIRE',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(410);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Gone');
    expect(body.message).toContain('expired');
  });

  it('should return 400 when a user tries to add themselves', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestUsers' }).resolves({
      Item: { safeWalkId: 'user-1' },
    });
    ddbMock.on(QueryCommand, { TableName: 'TestSharingCodes' }).resolves({
      Items: [validSharingCodeRecord('user-1', 'SELF00')],
    });

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        sharingCode: 'SELF00',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('themselves');
  });

  it('should return 409 if the trusted contact already exists', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestUsers' }).resolves({
      Item: { safeWalkId: 'user-1' },
    });
    ddbMock.on(QueryCommand, { TableName: 'TestSharingCodes' }).resolves({
      Items: [validSharingCodeRecord('user-2', 'TARGET')],
    });

    ddbMock
      .on(QueryCommand, { TableName: 'TestContacts' })
      .resolves({ Items: [{ contactId: 'existing' }] });

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        sharingCode: 'TARGET',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(409);
  });

  it('should successfully create a trusted contact with denormalised webhookUrl', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestUsers' }).resolves({
      Item: { safeWalkId: 'user-1' },
    });
    ddbMock.on(QueryCommand, { TableName: 'TestSharingCodes' }).resolves({
      Items: [validSharingCodeRecord('user-2', 'TARGET')],
    });
    ddbMock.on(QueryCommand, { TableName: 'TestContacts' }).resolves({ Items: [] });
    ddbMock.on(GetCommand, { TableName: 'TestPlatforms' }).resolves({
      Item: { platformId: 'platform-abc', webhookUrl: 'https://example.com/webhook' },
    });
    ddbMock.on(PutCommand).resolves({});

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        sharingCode: 'TARGET',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(201);

    const body = JSON.parse(result.body as string);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('contactId');
    expect(body.data.requesterSafeWalkId).toBe('user-1');
    expect(body.data.targetSafeWalkId).toBe('user-2');
    expect(body.data.status).toBe('ACTIVE');

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBe(1);
    const item = putCalls[0].args[0].input.Item;
    expect(item).toMatchObject({
      requesterSafeWalkId: 'user-1',
      targetSafeWalkId: 'user-2',
      platformId: 'platform-abc',
      webhookUrl: 'https://example.com/webhook',
      status: 'ACTIVE',
      locationSharing: true,
      sosSharing: true,
    });
    expect(item).toHaveProperty('sharingCodeHash');
    expect(item!.sharingCodeHash).not.toBe('TARGET'); // code is hashed, not stored raw
  });

  it('should successfully create a trusted contact via reverse-connect without sharingCode', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'TestUsers' })
      .resolvesOnce({ Item: { safeWalkId: 'user-1' } })
      .resolvesOnce({ Item: { safeWalkId: 'user-2' } });

    ddbMock.on(QueryCommand, { TableName: 'TestContacts' }).resolves({ Items: [] });
    ddbMock.on(GetCommand, { TableName: 'TestPlatforms' }).resolves({
      Item: { platformId: 'platform-abc', webhookUrl: 'https://example.com/webhook' },
    });
    ddbMock.on(PutCommand).resolves({});

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        targetSafeWalkId: 'user-2',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(201);

    const body = JSON.parse(result.body as string);
    expect(body.success).toBe(true);
    expect(body.data.requesterSafeWalkId).toBe('user-1');
    expect(body.data.targetSafeWalkId).toBe('user-2');

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBe(1);
    const item = putCalls[0].args[0].input.Item;
    expect(item).not.toHaveProperty('sharingCodeHash');
  });

  it('should reactivate a revoked reverse contact and clear stale sharingCodeHash', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'TestUsers' })
      .resolvesOnce({ Item: { safeWalkId: 'user-1' } })
      .resolvesOnce({ Item: { safeWalkId: 'user-2' } });

    ddbMock
      .on(QueryCommand, { TableName: 'TestContacts' })
      .resolvesOnce({ Items: [] })
      .resolvesOnce({
        Items: [
          {
            contactId: 'c-revoked',
            requesterSafeWalkId: 'user-1',
            targetSafeWalkId: 'user-2',
            platformId: 'platform-abc',
            status: 'REVOKED',
            sharingCodeHash: 'oldhash',
            locationSharing: true,
            sosSharing: true,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

    ddbMock.on(UpdateCommand).resolves({});

    const event = buildEvent({
      rawPath: '/contacts',
      body: JSON.stringify({
        requesterSafeWalkId: 'user-1',
        targetSafeWalkId: 'user-2',
      }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'POST' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.success).toBe(true);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);
    const input = updateCalls[0].args[0].input;
    expect(input.UpdateExpression).toContain('REMOVE #ttl, #hash');
    expect(input.UpdateExpression).not.toContain('#hash = :hash');
  });

  it('should list trusted contacts for a user (both directions)', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestUsers' }).resolves({
      Item: { safeWalkId: 'user-1' },
    });

    ddbMock.on(QueryCommand, { IndexName: 'RequesterIndex' }).resolves({
      Items: [
        {
          contactId: 'c-1',
          requesterSafeWalkId: 'user-1',
          targetSafeWalkId: 'user-2',
          platformId: 'platform-abc',
          webhookUrl: 'https://example.com/webhook',
          status: 'ACTIVE',
          sharingCodeHash: 'hash1',
          locationSharing: true,
          sosSharing: false,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    ddbMock.on(QueryCommand, { IndexName: 'TargetIndex' }).resolves({
      Items: [
        {
          contactId: 'c-2',
          requesterSafeWalkId: 'user-3',
          targetSafeWalkId: 'user-1',
          platformId: 'platform-abc',
          webhookUrl: null,
          status: 'ACTIVE',
          sharingCodeHash: 'hash2',
          locationSharing: false,
          sosSharing: true,
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
    });

    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        TestUsers: [
          { safeWalkId: 'user-2', name: 'Alice' },
          { safeWalkId: 'user-3', name: 'Bob' },
        ],
      },
    });

    const event = buildEvent({
      rawPath: '/contacts/user-1',
      pathParameters: { safeWalkId: 'user-1' },
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'GET' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body as string);
    expect(body.success).toBe(true);
    expect(body.data.count).toBe(2);

    const outgoing = body.data.contacts.find((c: any) => c.direction === 'outgoing');
    const incoming = body.data.contacts.find((c: any) => c.direction === 'incoming');
    expect(outgoing.contactId).toBe('c-1');
    expect(incoming.contactId).toBe('c-2');

    // peerName should be resolved from the users table
    expect(outgoing.peerName).toBe('Alice');
    expect(incoming.peerName).toBe('Bob');

    // sharingCodeHash should be stripped from the response
    body.data.contacts.forEach((c: any) => {
      expect(c).not.toHaveProperty('sharingCodeHash');
    });

    // locationSharing and sosSharing should be present
    expect(outgoing.locationSharing).toBe(true);
    expect(outgoing.sosSharing).toBe(false);
    expect(incoming.locationSharing).toBe(false);
    expect(incoming.sosSharing).toBe(true);
  });

  it('should return 404 when listing contacts for an unknown safeWalkId', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestUsers' }).resolves({ Item: undefined });

    const event = buildEvent({
      rawPath: '/contacts/unknown-user',
      pathParameters: { safeWalkId: 'unknown-user' },
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'GET' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(404);

    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Not Found');
    expect(body.message).toContain('safeWalkId');
  });

  it('should return 404 when contact does not exist', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({ Item: undefined });

    const event = buildEvent({
      rawPath: '/contacts/c-999',
      pathParameters: { contactId: 'c-999' },
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'DELETE' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(404);
  });

  it('should return 403 when revoking a contact from another platform', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({
      Item: {
        contactId: 'c-1',
        platformId: 'other-platform',
        status: 'ACTIVE',
      },
    });

    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'DELETE' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(403);
  });

  it('should successfully revoke a trusted contact', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({
      Item: {
        contactId: 'c-1',
        platformId: 'platform-abc',
        status: 'ACTIVE',
      },
    });
    ddbMock.on(UpdateCommand).resolves({});

    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'DELETE' },
      },
    });

    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.data.status).toBe('REVOKED');

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);
  });


  it('PATCH: should return 400 when safeWalkId is missing', async () => {
    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      body: JSON.stringify({ locationSharing: true }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'PATCH' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Validation Error');
    expect(body.message).toContain('safeWalkId');
  });

  it('PATCH: should return 400 when no update fields are provided', async () => {
    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      body: JSON.stringify({ safeWalkId: 'user-1' }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'PATCH' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Validation Error');
    expect(body.message).toContain('locationSharing');
  });

  it('PATCH: should return 404 when contact does not exist', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({ Item: undefined });

    const event = buildEvent({
      rawPath: '/contacts/c-999',
      pathParameters: { contactId: 'c-999' },
      body: JSON.stringify({ safeWalkId: 'user-1', locationSharing: false }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'PATCH' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(404);
  });

  it('PATCH: should return 403 when platformId does not match', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({
      Item: {
        contactId: 'c-1',
        platformId: 'other-platform',
        requesterSafeWalkId: 'user-1',
        targetSafeWalkId: 'user-2',
        status: 'ACTIVE',
        locationSharing: true,
        sosSharing: true,
      },
    });

    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      body: JSON.stringify({ safeWalkId: 'user-1', locationSharing: false }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'PATCH' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(403);
  });

  it('PATCH: should return 403 when safeWalkId is not part of the relationship', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({
      Item: {
        contactId: 'c-1',
        platformId: 'platform-abc',
        requesterSafeWalkId: 'user-1',
        targetSafeWalkId: 'user-2',
        status: 'ACTIVE',
        locationSharing: true,
        sosSharing: true,
      },
    });

    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      body: JSON.stringify({ safeWalkId: 'user-99', locationSharing: false }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'PATCH' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(403);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('not part of this contact relationship');
  });

  it('PATCH: should return 400 when contact is already revoked', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({
      Item: {
        contactId: 'c-1',
        platformId: 'platform-abc',
        requesterSafeWalkId: 'user-1',
        targetSafeWalkId: 'user-2',
        status: 'REVOKED',
        locationSharing: true,
        sosSharing: true,
      },
    });

    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      body: JSON.stringify({ safeWalkId: 'user-1', locationSharing: false }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'PATCH' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('revoked');
  });

  it('PATCH: should successfully update locationSharing and sosSharing', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({
      Item: {
        contactId: 'c-1',
        platformId: 'platform-abc',
        requesterSafeWalkId: 'user-1',
        targetSafeWalkId: 'user-2',
        status: 'ACTIVE',
        locationSharing: true,
        sosSharing: true,
      },
    });
    ddbMock.on(UpdateCommand).resolves({});

    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      body: JSON.stringify({ safeWalkId: 'user-1', locationSharing: false, sosSharing: false }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'PATCH' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.success).toBe(true);
    expect(body.data.contactId).toBe('c-1');
    expect(body.data.locationSharing).toBe(false);
    expect(body.data.sosSharing).toBe(false);
    expect(body.data).toHaveProperty('updatedAt');

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);
    const input = updateCalls[0].args[0].input;
    expect(input.UpdateExpression).toContain('locationSharing');
    expect(input.UpdateExpression).toContain('sosSharing');
  });

  it('PATCH: should allow target user to update the contact', async () => {
    ddbMock.on(GetCommand, { TableName: 'TestContacts' }).resolves({
      Item: {
        contactId: 'c-1',
        platformId: 'platform-abc',
        requesterSafeWalkId: 'user-1',
        targetSafeWalkId: 'user-2',
        status: 'ACTIVE',
        locationSharing: true,
        sosSharing: true,
      },
    });
    ddbMock.on(UpdateCommand).resolves({});

    const event = buildEvent({
      rawPath: '/contacts/c-1',
      pathParameters: { contactId: 'c-1' },
      body: JSON.stringify({ safeWalkId: 'user-2', sosSharing: false }),
      requestContext: {
        ...mockPlatformContext.requestContext,
        http: { method: 'PATCH' },
      },
    });
    const result = (await handler(event)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.data.sosSharing).toBe(false);
    expect(body.data.locationSharing).toBe(true); 
  });
});
