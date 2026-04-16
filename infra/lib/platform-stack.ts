import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayAuthorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import * as path from 'path';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export class PlatformStack extends cdk.Stack {
  public readonly httpApi: apigateway.HttpApi;
  public readonly platformAuthorizer: apigateway.IHttpRouteAuthorizer;
  public readonly platformsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.platformsTable = new dynamodb.Table(this, 'platforms-table', {
      tableName: 'SafeWalkPlatforms',
      partitionKey: {
        name: 'platformId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    this.platformsTable.addGlobalSecondaryIndex({
      indexName: 'ApiKeyIndex',
      partitionKey: {
        name: 'apiKey',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.platformsTable.addGlobalSecondaryIndex({
      indexName: 'PlatformNameIndex',
      partitionKey: {
        name: 'platformName',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    const authorizerFunction = new NodejsFunction(this, 'platform-authorizer', {
      functionName: 'safewalk-platform-authorizer',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      entry: path.join(__dirname, '../../lambda/platform-authorizer/index.ts'),
      environment: {
        PLATFORMS_TABLE_NAME: this.platformsTable.tableName,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      logRetention: RetentionDays.ONE_WEEK,
    });

    this.platformsTable.grantReadData(authorizerFunction);

    this.platformAuthorizer = new apigatewayAuthorizers.HttpLambdaAuthorizer(
      'platform-api-authorizer',
      authorizerFunction,
      {
        authorizerName: 'platform-api-key-authorizer',
        responseTypes: [apigatewayAuthorizers.HttpLambdaResponseType.SIMPLE],
        identitySource: ['$request.header.x-api-key'],
        resultsCacheTtl: cdk.Duration.minutes(5), // Cache authorization results for 5 minutes
      }
    );

    // Cognito User Pool for Admins
    const adminUserPool = new cognito.UserPool(this, 'admin-user-pool', {
      userPoolName: 'safewalk-admin-user-pool',
      selfSignUpEnabled: false, // Only admins can create other admins
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });

    const adminUserPoolClient = adminUserPool.addClient('admin-api-client', {
      userPoolClientName: 'safewalk-admin-api-client',
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
    });

    const adminAuthorizer = new apigatewayAuthorizers.HttpUserPoolAuthorizer(
      'admin-authorizer',
      adminUserPool,
      {
        userPoolClients: [adminUserPoolClient],
      }
    );

    this.httpApi = new apigateway.HttpApi(this, 'central-platform-api', {
      apiName: 'safewalk-platform-api',
      description: 'Central SafeWalk Platform API for all platform requests',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigateway.CorsHttpMethod.GET,
          apigateway.CorsHttpMethod.POST,
          apigateway.CorsHttpMethod.PUT,
          apigateway.CorsHttpMethod.PATCH,
          apigateway.CorsHttpMethod.DELETE,
          apigateway.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
        maxAge: cdk.Duration.days(1),
      },
    });

    const adminHandler = new NodejsFunction(this, 'platform-admin-handler', {
      functionName: 'safewalk-platform-admin-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      entry: path.join(__dirname, '../../lambda/platform-admin-handler/index.ts'),
      environment: {
        PLATFORMS_TABLE_NAME: this.platformsTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logRetention: RetentionDays.ONE_WEEK,
    });

    this.platformsTable.grantReadWriteData(adminHandler);

    const adminIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'admin-integration',
      adminHandler
    );

    this.httpApi.addRoutes({
      path: '/admin/platforms',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/platforms/{platformId}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/platforms/{platformId}/regenerate-key',
      methods: [apigateway.HttpMethod.POST],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/platforms/{platformId}/regenerate-webhook-secret',
      methods: [apigateway.HttpMethod.POST],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    new cdk.CfnOutput(this, 'api-endpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'Central Platform API endpoint',
      exportName: 'SafeWalkPlatformApiEndpoint',
    });

    new cdk.CfnOutput(this, 'api-id', {
      value: this.httpApi.apiId,
      description: 'Central Platform API ID',
      exportName: 'SafeWalkPlatformApiId',
    });

    new cdk.CfnOutput(this, 'platforms-table-name', {
      value: this.platformsTable.tableName,
      description: 'Platforms DynamoDB table name',
      exportName: 'SafeWalkPlatformsTableName',
    });

    new cdk.CfnOutput(this, 'platforms-table-arn', {
      value: this.platformsTable.tableArn,
      description: 'Platforms DynamoDB table ARN',
      exportName: 'SafeWalkPlatformsTableArn',
    });

    new cdk.CfnOutput(this, 'admin-user-pool-id', {
      value: adminUserPool.userPoolId,
      description: 'Admin User Pool ID',
      exportName: 'SafeWalkAdminUserPoolId',
    });

    new cdk.CfnOutput(this, 'admin-user-pool-client-id', {
      value: adminUserPoolClient.userPoolClientId,
      description: 'Admin User Pool Client ID',
      exportName: 'SafeWalkAdminUserPoolClientId',
    });
  }

  public addProtectedRoute(
    id: string,
    props: {
      path: string;
      methods: apigateway.HttpMethod[];
      integration: apigatewayIntegrations.HttpLambdaIntegration;
    }
  ): void {
    this.httpApi.addRoutes({
      path: props.path,
      methods: props.methods,
      integration: props.integration,
      authorizer: this.platformAuthorizer,
    });
  }
}
