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

export interface TrustedContactsStackProps extends cdk.StackProps {
  platformStack: PlatformStack;
  usersTable: dynamodb.ITable;
  sharingCodesTable: dynamodb.ITable;
  platformsTableName: string;
}

export class TrustedContactsStack extends cdk.Stack {
  public readonly trustedContactsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: TrustedContactsStackProps) {
    super(scope, id, props);

    this.trustedContactsTable = new dynamodb.Table(this, 'trusted-contacts-table', {
      tableName: 'SafeWalkTrustedContacts',
      partitionKey: {
        name: 'contactId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
    });

    this.trustedContactsTable.addGlobalSecondaryIndex({
      indexName: 'RequesterIndex',
      partitionKey: {
        name: 'requesterSafeWalkId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.trustedContactsTable.addGlobalSecondaryIndex({
      indexName: 'TargetIndex',
      partitionKey: {
        name: 'targetSafeWalkId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const platformsTableRef = dynamodb.Table.fromTableName(
      this,
      'PlatformsTableRef',
      props.platformsTableName,
    );

    const trustedContactsHandler = new NodejsFunction(this, 'trusted-contacts-handler', {
      functionName: 'safewalk-trusted-contacts-handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      entry: path.join(__dirname, '../../lambda/trusted-contacts-handler/index.ts'),
      environment: {
        CONTACTS_TABLE_NAME: this.trustedContactsTable.tableName,
        USERS_TABLE_NAME: props.usersTable.tableName,
        SHARING_CODES_TABLE_NAME: props.sharingCodesTable.tableName,
        PLATFORMS_TABLE_NAME: props.platformsTableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logRetention: RetentionDays.ONE_WEEK,
    });

    this.trustedContactsTable.grantReadWriteData(trustedContactsHandler);
    props.usersTable.grantReadData(trustedContactsHandler);
    props.sharingCodesTable.grantReadData(trustedContactsHandler);
    platformsTableRef.grantReadData(trustedContactsHandler);


    const trustedContactsIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'trusted-contacts-integration',
      trustedContactsHandler
    );

    props.platformStack.addProtectedRoute('CreateTrustedContactRoute', {
      path: '/contacts',
      methods: [apigateway.HttpMethod.POST],
      integration: trustedContactsIntegration,
    });

    props.platformStack.addProtectedRoute('ListTrustedContactsRoute', {
      path: '/contacts/{safeWalkId}',
      methods: [apigateway.HttpMethod.GET],
      integration: trustedContactsIntegration,
    });

    props.platformStack.addProtectedRoute('RevokeTrustedContactRoute', {
      path: '/contacts/{contactId}',
      methods: [apigateway.HttpMethod.DELETE],
      integration: trustedContactsIntegration,
    });

    props.platformStack.addProtectedRoute('UpdateTrustedContactRoute', {
      path: '/contacts/{contactId}',
      methods: [apigateway.HttpMethod.PATCH],
      integration: trustedContactsIntegration,
    });
  }
}
