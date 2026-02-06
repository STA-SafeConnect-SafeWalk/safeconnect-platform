import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import { PlatformStack } from './platform-stack';

export interface UserStackProps extends cdk.StackProps {
  platformStack: PlatformStack;
}

export class UserStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UserStackProps) {
    super(scope, id, props);

    const platformUsersTable = new dynamodb.Table(this, 'platform-users-table', {
      tableName: 'PlatformUsers',
      partitionKey: {
        name: 'safeWalkId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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

    platformUsersTable.addGlobalSecondaryIndex({
      indexName: 'PlatformUserIndex',
      partitionKey: {
        name: 'platformId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'platformUserId',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const userProfileHandler = new NodejsFunction(this, 'platform-user-handler', {
      functionName: 'platform-user-handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      entry: path.join(__dirname, '../../lambda/platform-user-handler/index.ts'),
      environment: {
        TABLE_NAME: platformUsersTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logRetention: RetentionDays.ONE_WEEK,
    });

    platformUsersTable.grantReadWriteData(userProfileHandler);

    const lambdaIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'platform-user-profile-integration',
      userProfileHandler
    );

    props.platformStack.addProtectedRoute('RegisterUserRoute', {
      path: '/register',
      methods: [apigateway.HttpMethod.POST],
      integration: lambdaIntegration,
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
