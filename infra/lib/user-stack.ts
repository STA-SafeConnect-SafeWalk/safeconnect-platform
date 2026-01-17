import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export class UserStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const platformUsersTable = new dynamodb.Table(this, 'platform-users-table', {
      tableName: 'PlatformUsers',
      partitionKey: {
        name: 'safeWalkId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    platformUsersTable.addGlobalSecondaryIndex({
      indexName: 'SharingCodeIndex',
      partitionKey: {
        name: 'sharingCode',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const userProfileHandler = new NodejsFunction(this, 'platform-user-profile-handler', {
      functionName: 'platform-user-profile-handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      entry: path.join(__dirname, '../../lambda/user-profile-handler/index.ts'),
      environment: {
        TABLE_NAME: platformUsersTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
    });

    platformUsersTable.grantReadWriteData(userProfileHandler);

    const httpApi = new apigateway.HttpApi(this, 'platform-user-api', {
      apiName: 'safewalk-platform-user-api',
      description: 'SafeWalk Platform User Registration API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigateway.CorsHttpMethod.POST, apigateway.CorsHttpMethod.GET],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const lambdaIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'platform-user-profile-integration',
      userProfileHandler
    );

    httpApi.addRoutes({
      path: '/register',
      methods: [apigateway.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    new cdk.CfnOutput(this, 'api-url', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API Gateway endpoint URL',
    });

    new cdk.CfnOutput(this, 'table-name', {
      value: platformUsersTable.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'lambda-function-name', {
      value: userProfileHandler.functionName,
      description: 'Platform user profile handler Lambda function name',
    });
  }
}
