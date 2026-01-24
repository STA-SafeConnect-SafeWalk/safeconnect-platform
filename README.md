# SafeWalk Platform
This repository contains the SafeWalk platform's business logic and infrastructure. The SafeWalk platform enables 3rd party public safety apps to securely exchange SOS events and therefore eliminate vendor-lockins for users concerned for their everyday safety. 

## Setup
In order to configure the platform for local development, follow the instructions given below.

### Deploy Infrastructure
The infrastructure deployment requires a properly configured AWS account. Make sure the AWS CLI and CDK are authorised correctly using your preferred authentication flow (access keys recommended for local development only). 

#### Node Packages
Install all required Node packages via ```npm ci ``` in the respective folders:

```sh
cd infra && npm ci
cd lambda/platform-admin-handler && npm ci
cd lambda/platform-authorizer && npm ci
cd lambda/platform-user-handler && npm ci
cd lambda && npm ci
npm ci
```

#### GitHub OIDC 
In order to use the contained CI/CD pipeline, make sure to deploy the ```pipeline-stack``` independently using the following command:

```sh
cdk deploy -c githubOrg=YOUR_GITHUB_ORG -c githubRepo=YOUR_GITHUB_REPO
```

In case you deploy for the SafeWalk organisation, use the following: ```githubOrg=SafeWalk-Companion``` and ```githubRepo=safewalk-platform```.

NOTE: This has to be done only ONCE by one team member, not individually.

#### Deploy Remaining Stacks
Once the above steps are completed, you may deploy the stacks to your AWS account using:

```sh
cdk deploy --all
```

## Platform Usage as a SW Admin
The following section describes the SafeWalk Platform management as a designated administrator. 

### Authenticate as a SafeWalk Admin
3rd party platform registrations can only be performed by SafeWalk admins. In order to authenticate as a SafeWalk admin follow these steps.

#### Create your Admin Account
Navigate to the ```safewalk-admin-user-pool``` in AWS Cognito and create a new user for yourself. Make sure to check 'Don't send an invitation' and 'Mark email address as verified'. 

#### Set your new Password
As a new user, you are required to set a new password after registering. The user pool id can be found in AWS Cognito > safewalk-admin-user-pool > Overview.
```sh
aws cognito-idp admin-set-user-password \
  --user-pool-id <SafeWalkUserPoolId> \
  --username admin@example.com \
  --password 'YourSecurePassword123!' \
  --permanent
```

#### Retrieve an Access Token
In order to manually send verified requests (since there currently is not Admin interface), request a JWT Access and Refresh token using the following command. The client id can be found in AWS Cognito > safewalk-admin-user-pool > App clients > safewalk-admin-api-client.

```sh
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id <SafeWalkUserPoolClientId> \
  --auth-parameters "USERNAME=admin@example.com,PASSWORD=YourSecurePassword123!"
```

Make sure to store the access key safely. You may now use it to authenticate your requests by adding the header ```Authorization: Bearer <AccessToken>```.

### Register a new Platform
In order to register a new 3rd party platform for SafeWalk and to obtain an API key for said platform to register users with SafeWalk, send an authenticated ```POST``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms``` with the following body:

```json
{
  "platformName": "Partner Platform Name",
  "redirectUrl": "https://partner.app/callback",
  "contactName": "John Doe",
  "contactEmail": "johndoe@partner.app",
  "webhookUrl": "https://partner.app/webhook", # Webhook for SOS events, can also be added later
  "description": "Partner integration for testing purposes" # Optional
}
```

Positive response after successful validation:
```json
{
  "success": true,
  "data": {
    "platformId": "uuid",
    "platformName": "Partner Platform Name",
    "apiKey": "sw_abc123...",  // Only shown once!
    "apiKeyPrefix": "sw_abc123...",
    "redirectUrl": "https://partner.app/callback",
    "status": "ACTIVE",
    "createdAt": "2026-01-24T..."
  }
}
```

Make sure to securely store the ```apiKey``` and forward it to the responsible contact person if necessary. This is the key used by the 3rd party platform to verify their requests heading to SafeWalk. 

### List all Platforms
You may list all platforms by sending a ```GET``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms```.

### Information about a Platform
You may list all information regarding a certain platform by sending a ```GET``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms/{platformId}```.

### Generate new API Key
In case you or a platform manager have lost their API key, you may generate a new API key by sending a ```POST``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms/{platformId}/regenerate-key```

NOTE: Equally to registering a new platform, the newly generated API key is only shown ONCE!

### Update an existing Platform
Updates to an existing platform's data can be made using a ```PATCH``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms/{platformId}```.

A request body may look like the following, however all fields are optional.

```json
{
  "platformName": "Updated Name",
  "redirectUrl": "https://new.url/callback",
  "contactName": "Jane Doe",
  "contactEmail": "jane@partner.app",
  "webhookUrl": "https://new.url/webhook",
  "description": "Updated description",
  "status": "INACTIVE"
}
```

### Platform Data Model
Note the data model used for 3rd party apps.

| Field | Type | Description |
|-------|------|-------------|
| platformId | String | Unique identifier (UUID) |
| platformName | String | Display name of the platform |
| apiKey | String | Secret API key (format: `sw_<32 hex chars>`) |
| apiKeyPrefix | String | First 11 chars for safe display |
| redirectUrl | String | OAuth callback URL |
| contactName | String | Primary contact name |
| contactEmail | String | Primary contact email |
| webhookUrl | String? | Optional webhook URL for events |
| description | String? | Optional description |
| status | String | ACTIVE or INACTIVE |
| createdAt | String | ISO timestamp |
| updatedAt | String | ISO timestamp |

## Platform Usage as a 3rd Party App
The following section describes the interaction with the platform as a 3rd party platform/application.

### Register a User for the Platform
In order to register one of your platform's users for the vendor-independent SW platform, you may send a ```POST``` request to ```safewalk-platform-stack.apiendpoint```

The request body may look like this:
```json
{
  "platformId": "abcd1234-0000-0000-0000-abcd1234abcd",
  "platformUserId": "123456789",
  "email": "user@example.com", # Optional
  "name": "John User" # Optional
}
```

Expect the following OK-response on successful validation:
```
{
  "success": true,
  "data": {
    "safeWalkId": "12345678-1234-1234-1234-1234abcd1234",
    "sharingCode": "ABCDEF"
  }
}
```

Store these data in order to facilitate cross-platform SOS-events. The sharing code shall be forwarded to the end-user to send to his contacts and therefore facilitate 'trusted contact-requests' via their platform. This sharing code can only be processed by SafeWalk. 