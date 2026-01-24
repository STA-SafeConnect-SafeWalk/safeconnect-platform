import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

interface PlatformContext {
  platformId: string;
  platformName: string;
}

interface AuthorizerResult extends APIGatewaySimpleAuthorizerWithContextResult<PlatformContext> {}

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2
): Promise<AuthorizerResult> => {
  console.log('Authorizer event:', JSON.stringify(event, null, 2));

  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];

  if (!apiKey) {
    console.log('No API key provided');
    return {
      isAuthorized: false,
      context: {
        platformId: '',
        platformName: '',
      },
    };
  }

  try {
    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: process.env.PLATFORMS_TABLE_NAME!,
        IndexName: 'ApiKeyIndex',
        KeyConditionExpression: 'apiKey = :apiKey',
        ExpressionAttributeValues: {
          ':apiKey': apiKey,
        },
        Limit: 1,
      })
    );

    if (!result.Items || result.Items.length === 0) {
      console.log('API key not found');
      return {
        isAuthorized: false,
        context: {
          platformId: '',
          platformName: '',
        },
      };
    }

    const platform = result.Items[0];

    if (platform.status !== 'ACTIVE') {
      console.log('Platform is not active:', platform.platformId);
      return {
        isAuthorized: false,
        context: {
          platformId: '',
          platformName: '',
        },
      };
    }

    console.log('Authorization successful for platform:', platform.platformId);

    return {
      isAuthorized: true,
      context: {
        platformId: platform.platformId,
        platformName: platform.platformName,
      },
    };
  } catch (error) {
    console.error('Authorization error:', error);
    return {
      isAuthorized: false,
      context: {
        platformId: '',
        platformName: '',
      },
    };
  }
};
