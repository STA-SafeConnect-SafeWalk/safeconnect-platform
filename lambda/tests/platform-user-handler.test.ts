import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyResult } from 'aws-lambda';
import { handler } from '../platform-user-handler/index';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('platform-user-handler', () => {
  const originalEnv = process.env;

  const mockContext = {
    requestContext: {
      authorizer: {
        lambda: {
          platformId: 'platform-abc',
        },
      },
      http: { method: 'POST' },
    },
  };

  beforeEach(() => {
    ddbMock.reset();
    process.env = { ...originalEnv };
    process.env.TABLE_NAME = 'TestTable';
    process.env.SHARING_CODES_TABLE_NAME = 'TestSharingCodes';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // --- Registration tests ---

  it('should return 401 if authorizer context is missing', async () => {
    const event = {
      body: JSON.stringify({ platformUserId: 'user-123' }),
      requestContext: { http: { method: 'POST' } },
      rawPath: '/register',
    };
    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(401);
  });

  it('should return 400 if body is missing', async () => {
    const event = {
      ...mockContext,
      rawPath: '/register',
      body: undefined,
    };
    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
  });

  it('should return 400 if platformUserId is missing', async () => {
    const event = {
      ...mockContext,
      rawPath: '/register',
      body: JSON.stringify({ email: 'test@example.com' }),
    };
    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Missing required fields');
  });

  it('should successfully register a new user without sharing code', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      ...mockContext,
      rawPath: '/register',
      body: JSON.stringify({
        platformUserId: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
      }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body as string);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('safeWalkId');
    expect(body.data).not.toHaveProperty('sharingCode');

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBe(1);
    const putInput = putCalls[0].args[0].input;
    expect(putInput.TableName).toBe('TestTable');
    expect(putInput.Item).toMatchObject({
      platformId: 'platform-abc',
      platformUserId: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
    });
    expect(putInput.Item).not.toHaveProperty('sharingCode');
  });

  it('should return 409 when user already exists', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ safeWalkId: 'existing' }] });

    const event = {
      ...mockContext,
      rawPath: '/register',
      body: JSON.stringify({ platformUserId: 'user-123' }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(409);
  });

  it('should return 500 on DynamoDB error during registration', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB Error'));

    const event = {
      ...mockContext,
      rawPath: '/register',
      body: JSON.stringify({ platformUserId: 'user-123' }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Internal Server Error');
  });

  // --- Sharing code generation tests ---

  it('should return 400 if safeWalkId is missing for sharing code generation', async () => {
    const event = {
      ...mockContext,
      rawPath: '/sharing-codes',
      body: JSON.stringify({}),
    };
    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Validation Error');
  });

  it('should return 404 if user does not exist for sharing code generation', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = {
      ...mockContext,
      rawPath: '/sharing-codes',
      body: JSON.stringify({ safeWalkId: 'non-existent' }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(404);
  });

  it('should return 403 if user belongs to another platform', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { safeWalkId: 'user-1', platformId: 'other-platform' },
    });

    const event = {
      ...mockContext,
      rawPath: '/sharing-codes',
      body: JSON.stringify({ safeWalkId: 'user-1' }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(403);
  });

  it('should successfully generate a sharing code with 24h expiry', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { safeWalkId: 'user-1', platformId: 'platform-abc' },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] }); // no collision
    ddbMock.on(PutCommand).resolves({});

    const event = {
      ...mockContext,
      rawPath: '/sharing-codes',
      body: JSON.stringify({ safeWalkId: 'user-1' }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body as string);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('sharingCode');
    expect(body.data).toHaveProperty('createdAt');
    expect(body.data).toHaveProperty('expiresAt');
    expect(body.data.safeWalkId).toBe('user-1');

    // Verify code is 6 characters
    expect(body.data.sharingCode).toMatch(/^[A-Z2-9]{6}$/);

    // Verify expiry is 24 hours from creation
    const created = new Date(body.data.createdAt);
    const expires = new Date(body.data.expiresAt);
    const diffHours = (expires.getTime() - created.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBe(24);

    // Verify PutCommand was called on sharing codes table
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBe(1);
    expect(putCalls[0].args[0].input.TableName).toBe('TestSharingCodes');
    expect(putCalls[0].args[0].input.Item).toHaveProperty('ttl');
  });

  it('should overwrite previous sharing code for same user', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { safeWalkId: 'user-1', platformId: 'platform-abc' },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      ...mockContext,
      rawPath: '/sharing-codes',
      body: JSON.stringify({ safeWalkId: 'user-1' }),
    };

    // Generate first code
    await handler(event as any);
    // Generate second code (overwrites first since PK is safeWalkId)
    const result = (await handler(event as any)) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(201);
    // Both calls should write to SharingCodes table with same safeWalkId PK
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBe(2);
    expect(putCalls[0].args[0].input.Item!.safeWalkId).toBe('user-1');
    expect(putCalls[1].args[0].input.Item!.safeWalkId).toBe('user-1');
  });

  it('should retry sharing code generation on collision', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { safeWalkId: 'user-1', platformId: 'platform-abc' },
    });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ sharingCode: 'COLLISION' }] })
      .resolvesOnce({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      ...mockContext,
      rawPath: '/sharing-codes',
      body: JSON.stringify({ safeWalkId: 'user-1' }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(201);
    expect(ddbMock.commandCalls(QueryCommand).length).toBe(2);
  });

  it('should return 500 if unable to generate unique sharing code', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { safeWalkId: 'user-1', platformId: 'platform-abc' },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ sharingCode: 'COLLISION' }] });

    const event = {
      ...mockContext,
      rawPath: '/sharing-codes',
      body: JSON.stringify({ safeWalkId: 'user-1' }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(500);
    expect(ddbMock.commandCalls(QueryCommand).length).toBe(10);
  });

  // --- Routing tests ---

  it('should return 404 for unknown routes', async () => {
    const event = {
      ...mockContext,
      rawPath: '/unknown',
      body: JSON.stringify({}),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(404);
  });
});
