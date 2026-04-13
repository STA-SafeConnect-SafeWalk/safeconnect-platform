# SafeConnect Platform
This repository contains the SafeConnect platform's business logic and infrastructure. The SafeConnect platform enables 3rd party public safety apps to securely exchange SOS events and therefore eliminate vendor-lockins for users concerned for their everyday safety. 

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
cdk deploy safewalk-pipeline-stack -c githubOrg=YOUR_GITHUB_ORG -c githubRepo=YOUR_GITHUB_REPO -c githubAppRepo=YOUR_GITHUB_APP_REPO
```

In case you deploy for the SafeWalk organisation, use the following: ```githubOrg=STA-SafeConnect-SafeWalk```, ```githubAppRepo=safewalk-app``` and ```githubRepo=safeconnect-platform```.

NOTE: This has to be done only ONCE by one team member, not individually.

#### Deploy Remaining Stacks
Once the above steps are completed, you may deploy the stacks to your AWS account using:

```sh
cdk deploy --all
```

## Platform Usage as a SC Admin
The following section describes the SafeConnect Platform management as a designated administrator. 

### Authenticate as a SafeConnect Admin
3rd party platform registrations can only be performed by SafeConnect admins. In order to authenticate as a SafeConnect admin follow these steps.

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
    "apiKey": "sw_abc123...", # Only shown once!
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

### Authorization
To authorize all of the requests described in this section, the API Key for the platform needs to be used by setting the header ```x-api-key: <API_Key>```

### Register a User for the Platform
In order to register one of your platform's users for the vendor-independent SW platform, you may send a ```POST``` request to ```safewalk-platform-stack.apiendpoint/register```

The request body may look like this:
```json
{
  "platformUserId": "123456789",
  "email": "user@example.com",
  "name": "John User"
}
```

Note: ```email``` and ```name``` are optional fields.

Expect the following OK-response on successful validation:
```json
{
  "success": true,
  "data": {
    "safeWalkId": "12345678-1234-1234-1234-1234abcd1234"
  }
}
```

Store the ```safeWalkId``` securely. It is required for all subsequent operations concerning this user (e.g. generating sharing codes and creating trusted contacts).

### Generate a Sharing Code
Sharing codes are temporary 6-character codes that allow other users to add your user as a trusted contact. Each code is valid for **24 hours**. Generating a new code automatically invalidates any previously active code for the same user.

To generate a sharing code, send a ```POST``` request to ```safewalk-platform-stack.apiendpoint/sharing-codes```

The request body:
```json
{
  "safeWalkId": "12345678-1234-1234-1234-1234abcd1234"
}
```

Expect the following response:
```json
{
  "success": true,
  "data": {
    "sharingCode": "ABCDEF",
    "safeWalkId": "12345678-1234-1234-1234-1234abcd1234",
    "createdAt": "2026-02-21T12:00:00.000Z",
    "expiresAt": "2026-02-22T12:00:00.000Z"
  }
}
```

The sharing code shall be forwarded to the end-user so they can share it with their contacts to facilitate trusted contact requests via their respective platforms. This sharing code can only be processed by SafeWalk.

NOTE: Each new code generation replaces the previous one. Only the most recent code is valid.

### Create a Trusted Contact
To add a trusted contact relationship for one of your users, send a ```POST``` request to ```safewalk-platform-stack.apiendpoint/contacts```

The request body should contain:
```json
{
  "requesterSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
  "sharingCode": "ABCDEF"
}
```

Expect the following response on successful creation:
```json
{
  "success": true,
  "data": {
    "contactId": "87654321-4321-4321-4321-4321dcba4321",
    "requesterSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
    "targetSafeWalkId": "98765432-9876-9876-9876-9876fedc9876",
    "status": "ACTIVE",
    "createdAt": "2026-02-21T..."
  }
}
```

The `requesterSafeWalkId` is the SafeWalk ID of your user who wants to add a contact. The `sharingCode` is the code they received from the person they want to add as a trusted contact.

Possible error responses:
- **404 Not Found** – The sharing code does not match any user.
- **410 Gone** – The sharing code has expired. The target user must generate a new one.
- **400 Validation Error** – A user cannot add themselves as a trusted contact.
- **409 Conflict** – This trusted contact relationship already exists.

### List Trusted Contacts
To retrieve all active trusted contacts for a user, send a ```GET``` request to ```safewalk-platform-stack.apiendpoint/contacts/{safeWalkId}```

Replace `{safeWalkId}` with the user's SafeWalk ID.

Expect the following response:
```json
{
  "success": true,
  "data": {
    "contacts": [
      {
        "contactId": "87654321-4321-4321-4321-4321dcba4321",
        "requesterSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
        "targetSafeWalkId": "98765432-9876-9876-9876-9876fedc9876",
        "platformId": "abcd1234-0000-0000-0000-abcd1234abcd",
        "webhookUrl": "https://partner.app/webhook",
        "status": "ACTIVE",
        "createdAt": "2026-02-21T...",
        "updatedAt": "2026-02-21T...",
        "direction": "outgoing"
      },
      {
        "contactId": "11111111-1111-1111-1111-111111111111",
        "requesterSafeWalkId": "98765432-9876-9876-9876-9876fedc9876",
        "targetSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
        "platformId": "abcd1234-0000-0000-0000-abcd1234abcd",
        "webhookUrl": "https://partner.app/webhook",
        "status": "ACTIVE",
        "createdAt": "2026-02-20T...",
        "updatedAt": "2026-02-20T...",
        "direction": "incoming"
      }
    ],
    "count": 2
  }
}
```

The `direction` field indicates whether the user initiated the contact relationship (`outgoing` -> receives SOS-alarms) or received it (`incoming` -> sends SOS alarms to trusted contact).

### Revoke a Trusted Contact
To revoke/remove a trusted contact relationship, send a ```DELETE``` request to ```safewalk-platform-stack.apiendpoint/contacts/{contactId}```

Replace `{contactId}` with the ID of the contact relationship you want to revoke.

Expect the following response:
```json
{
  "success": true,
  "data": {
    "contactId": "87654321-4321-4321-4321-4321dcba4321",
    "status": "REVOKED"
  }
}
```

Note: You can only revoke contacts that were created by your platform. Attempting to revoke a contact from another platform will result in a 403 Forbidden error. 