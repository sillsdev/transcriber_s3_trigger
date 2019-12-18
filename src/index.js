const https = require("https");
const path = require("path");
const mm = require('music-metadata/lib/core');

const host = process.env.SIL_TR_HOST;
const stagepath = process.env.SIL_TR_URLPATH;

exports.handler = async event => {
  console.log("hello! processing new s3 file!");
  const bucket = event.Records[0].s3.bucket.name;
  const key = decodeURIComponent(
    event.Records[0].s3.object.key.replace(/\+/g, " ")
  );
  const filename = path.basename(key);
  const region = event.Records[0].awsRegion;
  const filesize = event.Records[0].s3.object.size;
  console.log(bucket);
  console.log(key);

  function getMedia() {
    return new Promise((resolve, reject) => {
      // options for API request
      var options = {
        host: host,
        path: stagepath + "/api/mediafiles/fromfile/" + encodeURI(filename),
        method: "GET"
      };
      console.log("getMedia:", options);
      const req = https.request(options, res => {
        console.log("media statusCode:", res.statusCode);
        if (res.statusCode === 404) {
          //not found
          reject(res.statusCode);
        }
        res.on("data", d => {
          resolve(JSON.parse(d));
        });
      });

      req.on("error", e => {
        console.log("media error:", e);
        reject(e);
      });

      // req.write(postData);

      req.end();
    });
  }
  async function patchMedia(id, filesize, duration) {
    return new Promise((resolve, reject) => {
      // options for API request
      var options = {
        host: host,
        path:
          stagepath + "/api/mediafiles/" +
          id +
          "/fileinfo/" +
          filesize +
          "/" +
          duration,
        method: "PATCH"
      };

      const req = https.request(options, res => {
        console.log(options);
        console.log("media statusCode:", res.statusCode);
        if (res.statusCode === 404) {
          //not found
          reject(res.statusCode);
        }
        res.on("data", d => {
          resolve(JSON.parse(d));
        });
      });

      req.on("error", e => {
        console.log("media error:", e);
        reject(e);
      });

      // req.write(postData);

      req.end();
    });
  }
  /*
  async function getFile() {
    const aws = require("aws-sdk");
    const s3 = new aws.S3(); // Pass in opts to S3 if necessary
    var params = {
      Bucket: bucket, // your bucket name,
      Key: key // path to the object you're looking for
    };
    const data = await s3.getObject(params).promise();
    return data.Body;
  }
  */
  async function getFileStream() {
    const aws = require("aws-sdk");
    const s3 = new aws.S3(); // Pass in opts to S3 if necessary
    var params = {
      Bucket: bucket, // your bucket name,
      Key: key // path to the object you're looking for
    };
    const stream = s3.getObject(params).createReadStream().on('error', err => {
      console.log('stream error', err);
    })
      .on('finish', () => {
        console.log('stream finish');
      })
      .on('close', () => {
        console.log('stream close');
      });
    return stream;
  }
  try {
    var x = await getMedia();
    console.log("ID" + x.data.id);
    var stream = await getFileStream();
    var metadata = await mm.parseStream(stream);
    console.log("Your file is " + metadata.format.duration + " seconds long");
    //patch it
    var x = await patchMedia(x.data.id, filesize, metadata.format.duration);
    return x;
  } catch (e) {
    console.log("catch");
    console.log(e);
    return e;
  }
};
