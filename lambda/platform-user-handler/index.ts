import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

interface RegisterUserRequest {
  platformUserId: string;
  email?: string;
  name?: string;
}

interface UserRecord {
  safeWalkId: string;
  platformId: string;
  platformUserId: string;
  sharingCode: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SuccessResponse {
  success: true;
  data: {
    safeWalkId: string;
    sharingCode: string;
  };
}

interface ErrorResponse {
  error: string;
  message: string;
}

/**
 * Generate a unique 6-character alphanumeric sharing code
 */
function generateSharingCode(): string {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // slightly modified to avoid confusing characters
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

async function sharingCodeExists(sharingCode: string): Promise<boolean> {
  try {
    const params = {
      TableName: process.env.TABLE_NAME!,
      IndexName: 'SharingCodeIndex',
      KeyConditionExpression: 'sharingCode = :code',
      ExpressionAttributeValues: {
        ':code': sharingCode,
      },
      Limit: 1,
    };

    const result = await ddbDocClient.send(new QueryCommand(params));
    return !!(result.Items && result.Items.length > 0);
  } catch (error) {
    console.error('Error checking sharing code:', error);
    throw error;
  }
}

async function generateUniqueSharingCode(maxAttempts: number = 10): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateSharingCode();
    const exists = await sharingCodeExists(code);
    if (!exists) {
      return code;
    }
  }
  throw new Error('Unable to generate unique sharing code after maximum attempts');
}

/**
 * Lambda handler for platform user registration
 */
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>> => {

  try {
    const body: RegisterUserRequest = JSON.parse(event.body || '{}');
    const { platformUserId, email, name } = body;

    // Get platformId from authorizer context
    const requestContext = event.requestContext as any;
    const authorizerContext = requestContext.authorizer?.lambda;
    const platformId = authorizerContext?.platformId as string;

    if (!platformId) {
      return {
        statusCode: 401,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Unauthorized',
          message: 'Invalid platform authentication',
        }),
      };
    }

    // Validate required fields
    if (!platformUserId) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Missing required fields',
          message: 'platformUserId is required',
        }),
      };
    }

    const existingUserParams = {
      TableName: process.env.TABLE_NAME!,
      IndexName: 'PlatformUserIndex',
      KeyConditionExpression: 'platformId = :pid AND platformUserId = :puid',
      ExpressionAttributeValues: {
        ':pid': platformId,
        ':puid': platformUserId,
      },
      Limit: 1,
    };
    const existingUserResult = await ddbDocClient.send(new QueryCommand(existingUserParams));
    if (existingUserResult.Items && existingUserResult.Items.length > 0) {
      return {
        statusCode: 409,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Conflict',
          message: 'User with this platformId and platformUserId already exists',
        }),
      };
    }

    const safeWalkId = randomUUID();
    const sharingCode = await generateUniqueSharingCode();
    const timestamp = new Date().toISOString();

    const userRecord: UserRecord = {
      safeWalkId,
      platformId,
      platformUserId,
      sharingCode,
      email: email || null,
      name: name || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const params = {
      TableName: process.env.TABLE_NAME!,
      Item: userRecord,
      ConditionExpression: 'attribute_not_exists(safeWalkId)',
    };

    await ddbDocClient.send(new PutCommand(params));

    return {
      statusCode: 201,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        data: {
          safeWalkId,
          sharingCode,
        },
      }),
    };
  } catch (error: any) {
    console.error('Error:', error);

    if (error.name === 'ConditionalCheckFailedException') {
      return {
        statusCode: 409,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Conflict',
          message: 'User already exists',
        }),
      };
    }

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message || 'An unexpected error occurred',
      }),
    };
  }
};
