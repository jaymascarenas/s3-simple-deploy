# S3 Simple Deploy

Node JS module and cli command for easily deploying to AWS S3.

## Installation

`npm install s3-simple-deploy`

## How it works

Simply uploads the entire contents of a dirctory to an S3 bucket.
MD5 hash is used to determine if a file has changed so that only changed files are uploaded.
Also sets ACL to public read on all uploaded files.

## AWS Credentials

You can configure AWS credentials in several ways (in priority order):

1. **Explicit Credentials** (Best for CI/CD pipelines):
   - Use `--access-key-id` and `--secret-access-key` options
   - Example: `s3-simple-deploy --access-key-id AKIAI... --secret-access-key abc123... --bucket my-bucket --public-root ./dist`

2. **AWS Profile** (Recommended for local multi-account deployments):
   - Use the `--profile` option to specify which AWS profile to use
   - Profiles are configured in `~/.aws/credentials` and `~/.aws/config`
   - Example: `s3-simple-deploy --profile production --bucket my-prod-bucket --public-root ./dist`

3. **Environment Variables**:
   - Set [`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-environment.html)
   - Or set [`AWS_PROFILE`](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-shared.html)

4. **Configuration File**:
   - Include credential properties in your config file


## Usage

### In your `package.json`

Simply add the following to your `package.json` file and run `npm run deploy` to deploy.

```
{
  ...
  "scfripts": {
    ...
    "deploy": "s3-simple-deploy --public-root ./dist --bucket magic-bucket-name"
  }
}
```

### Within node script

```
var s3SimpleDeploy = require('s3-simple-deploy');

// with callback
s3SimpleDeploy.deploy({
  publicRoot: './release',
  bucket: 'magic-bucket-name',
  acl: 'private'
}, function(error, result) {
  // done!
});

// with promise
s3SimpleDeploy.deploy({
  publicRoot: './release',
  bucket: 'magic-bucket-name',
  acl: 'private'
}).then(function(result) {
  // done!
}, function(error) {
  // error!
});

// with explicit credentials for CI/CD deployment
s3SimpleDeploy.deploy({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID_PROD,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_PROD,
  region: 'us-west-2',
  publicRoot: './release',
  bucket: 'my-prod-bucket',
  acl: 'private'
}).then(function(result) {
  // done!
}, function(error) {
  // error!
});

// with AWS profile for multi-account deployment
s3SimpleDeploy.deploy({
  profile: 'production',
  region: 'us-west-2',
  publicRoot: './release',
  bucket: 'my-prod-bucket',
  acl: 'private'
}).then(function(result) {
  // done!
}, function(error) {
  // error!
});

// with additional headers and metadata
s3SimpleDeploy.deploy({
  publicRoot: './release',
  bucket: 'magic-bucket-name',
  acl: 'private',
  putObjectParams: [
      {
          match: /^[^\/]+\.(js|css|html)$/,
          tags: { ContentEncoding: 'gzip' }
      }
  ],
  metadata: [
      {
          match: /^[^\/]+\.(js|css|html)$/,
          tags: { 'Build-Version': '1.0.1', 'Build-Timestamp': 442527840000 }
      }
  ]
}).then(function(result) {
  // done!
}, function(error) {
  // error!
});
```

#### `.deploy(...)` options

**Credential Options (in priority order):**
* `accessKeyId`: (optional) AWS Access Key ID - takes highest priority
* `secretAccessKey`: (optional) AWS Secret Access Key - required if accessKeyId is provided
* `profile`: (optional) The AWS profile to use for credentials
* If none of the above are specified, uses AWS default credential chain (environment variables, etc.)

**Deployment Options:**
* `region`: The S3 region to deploy to. Defaults to "us-east-1"
* `publicRoot`: The path to the directory you want to deploy to s3
* `bucket`: The s3 bucket name to deploy to
* `acl`: (optional) [Canned s3 policy](http://docs.aws.amazon.com/AmazonS3/latest/dev/acl-overview.html) to use (e.g. 'private', 'public-read'). Defaults to "public-read".
* `cacheControl`: (optional) Sets the CacheControl Header.
* `cloudFrontId`: (optional) The CloudFront distribution id to invalidate.
* `concurrentRequests`: The number of uploads to process concurrently. Defaults to 10.
* `putObjectParams`: (optional) Additional params to pass to [S3 putObject](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property) call (e.g. headers to set on uploaded files) ([{ match: RegExp, tags: { key: value } }])
* `metadata`: (optional) Additional metadata to set ([{ match: RegExp, tags: { key: value } }])


### With command `s3-simple-deploy`

`s3-simple-deploy --help`:

```
  Usage: s3-simple-deploy [options]

  Options:

    -h, --help                                  output usage information
    -V, --version                               output the version number
    -c, --config <configFile>                   A config file
    --region <region>                           The S3 region. Defaults to us-east-1
    --profile <profile>                         The AWS profile to use for credentials
    --access-key-id <accessKeyId>               AWS Access Key ID
    --secret-access-key <secretAccessKey>       AWS Secret Access Key
    --public-root <publicRoot>                  The path of the folder to deploy
    --bucket <bucket>                           The S3 bucket name
    --acl <acl>                                 The ACL policy. Defaults to public-read
    --cacheControl                              The CacheControl value
    --cloud-front-id <cloudFrontDistributionId> The CloudFront distribution id
    --concurrent-requests <concurrentRequests>  The number of uploads to send at the same time. Defaults to 10
```

Example usage:

**Basic deployment:**
`s3-simple-deploy --public-root ./public --bucket magic-bucket-name --acl public-read`

**Multi-account deployment with explicit credentials (CI/CD pipelines):**
```bash
# Deploy to development account using explicit credentials
s3-simple-deploy --access-key-id $AWS_ACCESS_KEY_ID_DEV --secret-access-key $AWS_SECRET_ACCESS_KEY_DEV --public-root ./dist --bucket my-dev-bucket

# Deploy to production account using explicit credentials
s3-simple-deploy --access-key-id $AWS_ACCESS_KEY_ID_PROD --secret-access-key $AWS_SECRET_ACCESS_KEY_PROD --public-root ./dist --bucket my-prod-bucket --region us-west-2
```

**Multi-account deployment with profiles (local development):**
```bash
# Deploy to development account
s3-simple-deploy --profile dev --public-root ./dist --bucket my-dev-bucket

# Deploy to production account  
s3-simple-deploy --profile production --public-root ./dist --bucket my-prod-bucket --region us-west-2

# Deploy with CloudFront invalidation
s3-simple-deploy --profile staging --public-root ./build --bucket my-staging-bucket --cloud-front-id E1234567890123
```

**Using a config file:**
`s3-simple-deploy --config deploy-config.json`

**Sample config file for multi-account setup:**
```json
{
  "profile": "production",
  "region": "us-west-2", 
  "publicRoot": "./dist",
  "bucket": "my-prod-bucket",
  "acl": "public-read",
  "cloudFrontId": "E1234567890123"
}
```

## Bitbucket Pipelines Integration

For CI/CD deployments, use explicit credentials with environment variables:

**bitbucket-pipelines.yml:**
```yaml
pipelines:
  branches:
    develop:
      - step:
          name: Deploy to Development
          script:
            - npm install
            - s3-simple-deploy --access-key-id $AWS_ACCESS_KEY_ID_DEV --secret-access-key $AWS_SECRET_ACCESS_KEY_DEV --bucket my-dev-bucket --public-root ./dist
    master:
      - step:
          name: Deploy to Production
          script:
            - npm install
            - s3-simple-deploy --access-key-id $AWS_ACCESS_KEY_ID_PROD --secret-access-key $AWS_SECRET_ACCESS_KEY_PROD --bucket my-prod-bucket --public-root ./dist --region us-west-2 --cloud-front-id E1234567890123
```

**Repository Variables to Set:**
- `AWS_ACCESS_KEY_ID_DEV` - Development account access key
- `AWS_SECRET_ACCESS_KEY_DEV` - Development account secret key  
- `AWS_ACCESS_KEY_ID_PROD` - Production account access key
- `AWS_SECRET_ACCESS_KEY_PROD` - Production account secret key