#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InfraStack } from '../lib/infra-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

const githubOrg = app.node.tryGetContext('githubOrg') || process.env.GITHUB_ORG;
const githubRepo = app.node.tryGetContext('githubRepo') || process.env.GITHUB_REPO;

if (!githubOrg || !githubRepo) {
  console.warn(
    'Warning: githubOrg and githubRepo not provided. The pipeline stack will not be created.\n' +
    'Provide them via context: cdk deploy -c githubOrg=<org> -c githubRepo=<repo>'
  );
}

if (githubOrg && githubRepo) {
  new PipelineStack(app, 'safewalk-pipeline-stack', {
    githubOrg,
    githubRepo,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    description: 'GitHub Actions OIDC authentication and deployment role',
  });
}

// Main Infrastructure Stack
new InfraStack(app, 'safewalk-infra-stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
