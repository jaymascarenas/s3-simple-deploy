"use strict";

const readline = require("readline");
const Async = require("async");
const Crypto = require("crypto");
const chalk = require("chalk");
const Fs = require("fs");
const Glob = require("glob");
const Mime = require("mime");
const Path = require("path");
const {
  CloudFrontClient,
  CreateInvalidationCommand,
} = require("@aws-sdk/client-cloudfront");

const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

require("colors");

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
        return callback(null, "");
      }
      return Promise.resolve("");
    })
    .catch((error) => {
      console.error(("error: " + error).red);
      if (callback) {
        return callback(error);
      }
      return Promise.reject(error);
    });
};

function setup(options) {
  config = options;

  const region = config.region || "us-east-1";

  if (!config.publicRoot) {
    return Promise.reject("Must specify publicRoot");
  }

  if (!config.bucket) {
    return Promise.reject("Must specify bucket");
  }

  if (!config.acl) {
    config.acl = "public-read";
  }

  config.concurrentRequests = config.concurrentRequests || 10;

  s3 = new S3Client({ region });

  cloudfront = new CloudFrontClient({ region });

  return Promise.resolve();
}

function startDeploy() {
  return getFiles().then(uploadFiles).then(createInvalidation);
}

function getFiles() {
  return new Promise((resolve, reject) => {
    new Glob("**/*.*", { cwd: config.publicRoot }, (err, files) => {
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
                console.error("Error with additional putObject parameters", e);
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
                console.error("Error with metadata", e);
              }
            });
          }
          const body = Fs.readFileSync(Path.join(config.publicRoot, f));
          return {
            body: body,
            type: Mime.lookup(f),
            md5: Crypto.createHash("md5").update(body).digest("hex"),
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
  const key = Path.join(file.path.dir, file.path.base).replace(/\\/g, "/");
  const splitBucket = config.bucket.split("/");
  const validBucketName = splitBucket[0];
  const stagingFolder = splitBucket.slice(1).join("/");

  const params = {
    Bucket: validBucketName,
    Key: `${stagingFolder}/${key}`,
  };

  const command = new HeadObjectCommand(params);

  s3.send(command)
    .then((data) => {
      if (data.Metadata && data.Metadata["content-md5"] === file.md5) {
        return callback(null, false);
      }
      callback(null, true);
    })
    .catch((err) => {
      console.log(chalk.red("Error checking if upload is required:", err));
      if (err.name === "NotFound") {
        return callback(null, true);
      }
      callback(err);
    });
}

function uploadFile(file, callback) {
  const key = Path.join(file.path.dir, file.path.base).replace(/\\/g, "/");
  const splitBucket = config.bucket.split("/");
  const validBucketName = splitBucket[0];
  const stagingFolder = splitBucket.slice(1).join("/");

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
      "Content-MD5": file.md5,
    },
  };

  const command = new PutObjectCommand(params);

  s3.send(command)
    .then(() => {
      status.uploaded++;
      printProgress("Uploaded", `${file.path.dir}/${file.path.base}`);
      callback(null);
    })
    .catch((err) => {
      callback(err);
    });
}

function uploadFiles(files) {
  status.total = files.length;

  const processFile = (file, callback) => {
    checkIfUploadRequired(file, (err, required) => {
      if (err) {
        console.log(chalk.red("Error checking if upload is required:", err));
        return callback(err);
      }
      if (required) {
        return uploadFile(file, callback);
      }
      status.skipped++;
      printProgress("Skipped", file.path.dir + "/" + file.path.base);
      return callback();
    });
  };

  return new Promise((resolve, reject) => {
    Async.eachLimit(files, config.concurrentRequests, processFile, (err) => {
      if (err) {
        console.log(chalk.red("Error during file upload:", err));
        return reject(err);
      }
      console.log("\n");
      resolve();
    });
  });
}

function printProgress(action, file) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(
    "\r" +
      status.uploaded +
      " uploaded / " +
      status.skipped +
      " skipped / " +
      status.total +
      " total --- " +
      (((status.uploaded + status.skipped) / status.total) * 100).toFixed(2) +
      "% complete" +
      " --- " +
      action +
      " " +
      file
  );
}

function createInvalidation() {
  return new Promise((resolve, reject) => {
    if (!config.cloudFrontId) {
      return resolve();
    }
    console.log("\nCreating CloudFront invalidation...");
    const params = {
      DistributionId: config.cloudFrontId,
      InvalidationBatch: {
        CallerReference: new Date().toISOString(),
        Paths: {
          Quantity: 1,
          Items: ["/*"],
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
        console.log(chalk.red("Error creating CloudFront invalidation:", err));
        reject(err);
      });
  });
}
