'use strict';

const readline = require('readline');
const Async = require('async');
const Crypto = require('crypto');
const chalk = require('chalk');
const Fs = require('fs');
const Glob = require('glob');
const Mime = require('mime');
const Path = require('path');
const {
  CloudFrontClient,
  CreateInvalidationCommand,
} = require('@aws-sdk/client-cloudfront');
const { fromIni } = require('@aws-sdk/credential-providers');

const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

require('colors');

let config, s3, cloudfront;

let status = {
  total: 0,
  uploaded: 0,
  skipped: 0,
};

module.exports.deploy = (options, callback) => {
  return setup(options)
    .then(startDeploy)
    .then(() => {
      console.log(
        chalk.green.bold(
          `Deployed ${config.publicRoot} to ${config.bucket} on S3!`
        )
      );
      if (callback) {
        return callback(null, '');
      }
      return Promise.resolve('');
    })
    .catch((error) => {
      console.error(('error: ' + error).red);
      if (callback) {
        return callback(error);
      }
      return Promise.reject(error);
    });
};

function setup(options) {
  config = options;

  const region = config.region || 'us-east-1';

  if (!config.publicRoot) {
    return Promise.reject('Must specify publicRoot');
  }

  if (!config.bucket) {
    return Promise.reject('Must specify bucket');
  }

  if (!config.acl) {
    config.acl = 'public-read';
  }

  config.concurrentRequests = config.concurrentRequests || 10;

  // Configure AWS client options
  const clientConfig = { region };

  // Priority order for credentials:
  // 1. Explicit credentials (accessKeyId + secretAccessKey)
  // 2. Profile credentials
  // 3. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
  // 4. Other AWS credential chain methods

  if (config.accessKeyId && config.secretAccessKey) {
    // Use explicit credentials
    clientConfig.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  } else if (config.profile) {
    // Use profile credentials
    clientConfig.credentials = fromIni({ profile: config.profile });
  } else {
    // If neither explicit credentials nor profile is specified,
    // AWS SDK will use the default credential chain (environment variables, etc.)
    console.log('No Profile or Access Key Found, using default profile');
  }
  s3 = new S3Client(clientConfig);

  cloudfront = new CloudFrontClient(clientConfig);

  return Promise.resolve();
}

async function startDeploy() {
  try {
    console.log('🚀 Starting deployment');

    console.log('📦 Gathering files...');
    const files = await getFiles();
    console.log(`📦 Found ${files.length} files`);

    console.log('⬆️ Uploading files...');
    await uploadFiles(files);
    console.log('⬆️ Upload completed');

    console.log('🧹 Creating CloudFront invalidation...');
    await createInvalidation();
    console.log('🧹 Invalidation completed');

    console.log('✅ Deployment finished successfully');
  } catch (err) {
    console.error('❌ Deployment failed', {
      stage: err?._phase ?? 'unknown',
      message: err?.message,
      errorName: err?.name,
      metadata: err?.$metadata,
    });

    // Preserve original stack + error for CI / callers
    throw err;
  }
}

function getFiles() {
  return new Promise((resolve, reject) => {
    new Glob('**/*.*', { cwd: config.publicRoot }, (err, files) => {
      if (err) {
        return reject(err);
      }
      const addHeaders =
        Array.isArray(config.putObjectParams) &&
        config.putObjectParams.length > 0;
      const addMetadata =
        Array.isArray(config.metadata) && config.metadata.length > 0;
      files = files.filter(
        (f) => !Fs.lstatSync(Path.join(config.publicRoot, f)).isDirectory()
      );
      resolve(
        files.map((f) => {
          const extraHeaders = {};
          if (addHeaders) {
            config.putObjectParams.forEach((h) => {
              try {
                if (h.match.test(f)) {
                  Object.assign(extraHeaders, h.tags);
                }
              } catch (e) {
                console.error('Error with additional putObject parameters', e);
              }
            });
          }
          const extraMetadata = {};
          if (addMetadata) {
            config.metadata.forEach((m) => {
              try {
                if (m.match.test(f)) {
                  Object.assign(extraMetadata, m.tags);
                }
              } catch (e) {
                console.error('Error with metadata', e);
              }
            });
          }
          const body = Fs.readFileSync(Path.join(config.publicRoot, f));
          return {
            body: body,
            type: Mime.lookup(f),
            md5: Crypto.createHash('md5').update(body).digest('hex'),
            path: Path.parse(f),
            extraHeaders,
            extraMetadata,
          };
        })
      );
    });
  });
}

function checkIfUploadRequired(file, callback) {
  const key = Path.join(file.path.dir, file.path.base).replace(/\\/g, '/');
  const splitBucket = config.bucket.split('/');
  const validBucketName = splitBucket[0];
  const stagingFolder = splitBucket.slice(1).join('/');

  const params = {
    Bucket: validBucketName,
    Key: `${stagingFolder}/${key}`,
  };

  const command = new HeadObjectCommand(params);

  s3.send(command)
    .then((data) => {
      if (data.Metadata && data.Metadata['content-md5'] === file.md5) {
        return callback(null, false);
      }
      callback(null, true);
    })
    .catch((err) => {
      if (err.name === 'NotFound') {
        return callback(null, true);
      } else {
        console.log(chalk.red('Error checking if upload is required:', err));
      }
      callback(err);
    });
}

function uploadFile(file, callback) {
  const key = Path.join(file.path.dir, file.path.base).replace(/\\/g, '/');
  const splitBucket = config.bucket.split('/');
  const validBucketName = splitBucket[0];
  const stagingFolder = splitBucket.slice(1).join('/');

  const params = {
    ...file.extraHeaders,
    Bucket: validBucketName,
    Key: `${stagingFolder}/${key}`,
    ACL: config.acl,
    Body: file.body,
    CacheControl: config.cacheControl,
    ContentType: file.type,
    Metadata: {
      ...file.extraMetadata,
      'Content-MD5': file.md5,
    },
  };

  const command = new PutObjectCommand(params);

  s3.send(command)
    .then(() => {
      status.uploaded++;
      printProgress('Uploaded', `${file.path.dir}/${file.path.base}`);
      callback(null);
    })
    .catch((err) => {
      callback(err);
    });
}

function uploadFiles(files) {
  status.total = files.length;

  // Collect per-file failures without aborting the entire run
  const failures = [];

  const recordFailure = (err, file, phase) => {
    const enriched = err || new Error('Unknown error');
    enriched._phase = phase;
    enriched._file = `${file.path.dir}/${file.path.base}`;
    failures.push(enriched);

    console.log(chalk.red(`${phase} failed for ${file.path.base}`));
    console.log(enriched);
  };

  const processFile = (file, callback) => {
    checkIfUploadRequired(file, (err, required) => {
      if (err) {
        recordFailure(err, file, 'check');
        // swallow error so eachLimit continues
        return callback();
      }

      if (!required) {
        status.skipped++;
        printProgress('Skipped', `${file.path.dir}/${file.path.base}`);
        return callback();
      }

      uploadFile(file, (uploadErr) => {
        if (uploadErr) {
          recordFailure(uploadErr, file, 'upload');
          // swallow error so eachLimit continues
          return callback();
        }

        // uploadFile already increments status.uploaded + prints progress
        return callback();
      });
    });
  };

  return new Promise((resolve) => {
    Async.eachLimit(files, config.concurrentRequests, processFile, () => {
      // eachLimit final callback err is meaningless here because we never pass errors up
      if (failures.length) {
        console.log(
          chalk.yellow(
            `\nUpload completed with ${failures.length} failure(s) out of ${files.length} files.`
          )
        );

        // Optional: show first few failures as a quick summary
        failures.slice(0, 10).forEach((e, i) => {
          console.log(
            chalk.yellow(
              `${i + 1}. [${e._phase}] ${e._file} — ${e.name || 'Error'}: ${
                e.message || String(e)
              }`
            )
          );
        });

        if (failures.length > 10) {
          console.log(chalk.yellow(`...and ${failures.length - 10} more.`));
        }
      } else {
        console.log(chalk.green('\nUpload completed with no failures.'));
      }

      // Resolve with a report instead of rejecting
      resolve({
        uploaded: status.uploaded,
        skipped: status.skipped,
        total: status.total,
        failures,
      });
    });
  });
}

function printProgress(action, file) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(
    '\r' +
      status.uploaded +
      ' uploaded / ' +
      status.skipped +
      ' skipped / ' +
      status.total +
      ' total --- ' +
      (((status.uploaded + status.skipped) / status.total) * 100).toFixed(2) +
      '% complete' +
      ' --- ' +
      action +
      ' ' +
      file
  );
}

function createInvalidation() {
  return new Promise((resolve, reject) => {
    if (!config.cloudFrontId) {
      console.error(
        '\nNo Cloudfront ID Found. Please check Site Configuration'
      );
      return resolve();
    }

    const params = {
      DistributionId: config.cloudFrontId,
      InvalidationBatch: {
        CallerReference: new Date().toISOString(),
        Paths: {
          Quantity: 1,
          Items: ['/*'],
        },
      },
    };
    const command = new CreateInvalidationCommand(params);

    cloudfront
      .send(command)
      .then(() => {
        resolve();
      })
      .catch((err) => {
        console.log(chalk.red('Error creating CloudFront invalidation:', err));
        reject(err);
      });
  });
}
