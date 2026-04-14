import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
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
    });
    expect(item).toHaveProperty('sharingCodeHash');
    expect(item!.sharingCodeHash).not.toBe('TARGET'); // code is hashed, not stored raw
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
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
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

    // sharingCodeHash should be stripped from the response
    body.data.contacts.forEach((c: any) => {
      expect(c).not.toHaveProperty('sharingCodeHash');
    });
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
});
