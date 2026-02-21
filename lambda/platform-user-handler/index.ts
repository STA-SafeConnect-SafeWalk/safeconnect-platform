import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

const SHARING_CODE_VALIDITY_HOURS = 24;

interface RegisterUserRequest {
  platformUserId: string;
  email?: string;
  name?: string;
}

interface GenerateSharingCodeRequest {
  safeWalkId: string;
}

interface UserRecord {
  safeWalkId: string;
  platformId: string;
  platformUserId: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SharingCodeRecord {
  safeWalkId: string;
  sharingCode: string;
  createdAt: string;
  expiresAt: string;
  ttl: number;
}

interface SuccessResponse {
  success: true;
  data: unknown;
}

interface ErrorResponse {
  error: string;
  message: string;
}

type HandlerResponse = APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>;

function jsonResponse(statusCode: number, body: SuccessResponse | ErrorResponse): HandlerResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Generate a random 6-character alphanumeric sharing code.
 */
function generateRandomCode(): string {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // slightly modified to avoid confusing characters
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

/**
 * Check whether a sharing code already exists in the SharingCodes table.
 */
async function sharingCodeExists(sharingCode: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.SHARING_CODES_TABLE_NAME!,
      IndexName: 'SharingCodeIndex',
      KeyConditionExpression: 'sharingCode = :code',
      ExpressionAttributeValues: { ':code': sharingCode },
      Limit: 1,
    })
  );
  return !!(result.Items && result.Items.length > 0);
}

/**
 * Generate a sharing code that does not collide with any existing code.
 */
async function generateUniqueSharingCode(maxAttempts: number = 10): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateRandomCode();
    const exists = await sharingCodeExists(code);
    if (!exists) return code;
  }
  throw new Error('Unable to generate unique sharing code after maximum attempts');
}

/**
 * POST /register
 *
 * Register a new platform user. Returns the safeWalkId for the user.
 * A sharing code must be requested separately via POST /sharing-codes.
 */
async function registerUser(body: RegisterUserRequest, platformId: string): Promise<HandlerResponse> {
  const { platformUserId, email, name } = body;

  if (!platformUserId) {
    return jsonResponse(400, {
      error: 'Missing required fields',
      message: 'platformUserId is required',
    });
  }

  const existingResult = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.TABLE_NAME!,
      IndexName: 'PlatformUserIndex',
      KeyConditionExpression: 'platformId = :pid AND platformUserId = :puid',
      ExpressionAttributeValues: { ':pid': platformId, ':puid': platformUserId },
      Limit: 1,
    })
  );

  if (existingResult.Items && existingResult.Items.length > 0) {
    return jsonResponse(409, {
      error: 'Conflict',
      message: 'User with this platformId and platformUserId already exists',
    });
  }

  const safeWalkId = randomUUID();
  const timestamp = new Date().toISOString();

  const userRecord: UserRecord = {
    safeWalkId,
    platformId,
    platformUserId,
    email: email || null,
    name: name || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await ddbDocClient.send(
    new PutCommand({
      TableName: process.env.TABLE_NAME!,
      Item: userRecord,
      ConditionExpression: 'attribute_not_exists(safeWalkId)',
    })
  );

  return jsonResponse(201, {
    success: true,
    data: { safeWalkId },
  });
}

/**
 * POST /sharing-codes
 *
 * Generate a new temporary sharing code for the given user.
 * The code is valid for 24 hours and replaces any previously active code.
 */
async function generateSharingCodeForUser(
  body: GenerateSharingCodeRequest,
  platformId: string
): Promise<HandlerResponse> {
  const { safeWalkId } = body;

  if (!safeWalkId) {
    return jsonResponse(400, {
      error: 'Validation Error',
      message: 'safeWalkId is required',
    });
  }

  // Verify the user exists and belongs to the calling platform
  const userResult = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.TABLE_NAME!,
      Key: { safeWalkId },
    })
  );

  if (!userResult.Item) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'User not found',
    });
  }

  if (userResult.Item.platformId !== platformId) {
    return jsonResponse(403, {
      error: 'Forbidden',
      message: 'User does not belong to your platform',
    });
  }

  const sharingCode = await generateUniqueSharingCode();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAtDate = new Date(now.getTime() + SHARING_CODE_VALIDITY_HOURS * 60 * 60 * 1000);
  const expiresAt = expiresAtDate.toISOString();

  const record: SharingCodeRecord = {
    safeWalkId,
    sharingCode,
    createdAt,
    expiresAt,
    ttl: Math.floor(expiresAtDate.getTime() / 1000),
  };

  // PutCommand with safeWalkId as PK overwrites any existing code for this user
  await ddbDocClient.send(
    new PutCommand({
      TableName: process.env.SHARING_CODES_TABLE_NAME!,
      Item: record,
    })
  );

  return jsonResponse(201, {
    success: true,
    data: {
      sharingCode,
      safeWalkId,
      createdAt,
      expiresAt,
    },
  });
}

/**
 * Lambda handler – routes requests to the appropriate function.
 */
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<HandlerResponse> => {
  try {
    const requestContext = event.requestContext as any;
    const authorizerContext = requestContext.authorizer?.lambda;
    const platformId = authorizerContext?.platformId as string;

    if (!platformId) {
      return jsonResponse(401, {
        error: 'Unauthorized',
        message: 'Invalid platform authentication',
      });
    }

    const method = event.requestContext.http.method;
    const rawPath = event.rawPath;

    if (method === 'POST' && rawPath === '/register') {
      const body: RegisterUserRequest = JSON.parse(event.body || '{}');
      return await registerUser(body, platformId);
    }

    if (method === 'POST' && rawPath === '/sharing-codes') {
      const body: GenerateSharingCodeRequest = JSON.parse(event.body || '{}');
      return await generateSharingCodeForUser(body, platformId);
    }

    return jsonResponse(404, {
      error: 'Not Found',
      message: 'Route not found',
    });
  } catch (error: any) {
    console.error('Error:', error);

    if (error.name === 'ConditionalCheckFailedException') {
      return jsonResponse(409, {
        error: 'Conflict',
        message: 'User already exists',
      });
    }

    return jsonResponse(500, {
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred',
    });
  }
};
