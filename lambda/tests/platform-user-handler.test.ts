import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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
    },
  };

  beforeEach(() => {
    ddbMock.reset();
    process.env = { ...originalEnv };
    process.env.TABLE_NAME = 'TestTable';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return 401 if authorizer context is missing', async () => {
    const event = {
      body: JSON.stringify({ platformUserId: 'user-123' }),
      requestContext: {},
    };
    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(401);
  });

  it('should return 400 if body is missing', async () => {
    const event = {
      ...mockContext,
      body: undefined,
    };
    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
  });

  it('should return 400 if platformUserId is missing', async () => {
    const event = {
      ...mockContext,
      body: JSON.stringify({ email: 'test@example.com' }),
    };
    const result = (await handler(event as any)) as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Missing required fields');
  });

  it('should successfully register a new user', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      ...mockContext,
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
    expect(body.data).toHaveProperty('sharingCode');

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
  });

  it('should retry generating sharing code on collision', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ sharingCode: 'COLLISION' }] })
      .resolvesOnce({ Items: [] });
    
    ddbMock.on(PutCommand).resolves({});

    const event = {
      ...mockContext,
      body: JSON.stringify({
        platformUserId: 'user-123',
      }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(201);
    expect(ddbMock.commandCalls(QueryCommand).length).toBe(2);
    expect(ddbMock.commandCalls(PutCommand).length).toBe(1);
  });

  it('should return 500 if unable to generate unique sharing code', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ sharingCode: 'COLLISION' }] });

    const event = {
      ...mockContext,
      body: JSON.stringify({
        platformUserId: 'user-123',
      }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Internal Server Error');
    expect(ddbMock.commandCalls(QueryCommand).length).toBe(10);
  });

  it('should return 500 on DynamoDB error', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB Error'));

    const event = {
      ...mockContext,
      body: JSON.stringify({
        platformUserId: 'user-123',
      }),
    };

    const result = (await handler(event as any)) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Internal Server Error');
  });
});
