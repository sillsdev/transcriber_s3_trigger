const https = require("https");
const path = require("path");
const mp3 = require("mp3-duration");
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
  async function getFileStream() {
    const aws = require("aws-sdk");
    const s3 = new aws.S3(); // Pass in opts to S3 if necessary
    var params = {
      Bucket: bucket, // your bucket name,
      Key: key // path to the object you're looking for
    };
    const stream = s3.getObject(params).createReadStream().on('error', err => {
      console.log('stream error', err);
      return null;
    })
      .on('finish', () => {
        console.log('stream finish');
      })
      .on('close', () => {
        console.log('stream close');
      });
    return stream;
  }
  /*
    async function importProject() {
      const AdmZip = require('adm-zip');
      //const moment = require('moment');
  
      console.log("import offline project file");
      var stream = null;
      var tries = 0
      while (stream === null && tries < 5) {
        console.log(tries);
        stream = await getFileStream();
        tries++;
      }
      if (stream !== null) {
        const chunks = []
        for await (let chunk of stream) {
          chunks.push(chunk)
        }
        var zip = new AdmZip(Buffer.concat(chunks));
        let valid = false;
        var exportTime;
        var zipEntries = zip.getEntries();
        for (let entry of zipEntries) {
          if (entry.entryName === 'SILTranscriberOffline') {
            exportTime = entry.getData().toString('utf8');
            valid = true;
            console.log(exportTime);
            break;
          }
        }
        if (!valid)
          return -1;
        console.log('here');
      }
      return -1;
    }
  */
  try {
    if (key.startsWith("exports"))
      return 0;

    if (key.startsWith("imports"))
      return 0; // await importProject();

    /* user media file */
    var x = await getMedia();
    console.log("ID" + x.data.id);
    var stream = null;
    var tries = 0
    while (stream === null && tries < 5) {
      console.log(tries);
      stream = await getFileStream();
      tries++;
    }
    if (stream !== null) {
      var metadata = await mm.parseStream(stream, x.data.attributes["content-type"]);
      var duration = metadata.format.duration;

      if (duration === undefined) {
        duration = await mp3(await getFile()); //this doesn't do m4a files correctly so it's a backup only
        console.log("Your file is " + duration + " seconds long - mm");
      }
      else {
        console.log("Your file is " + duration + " seconds long - meta");
      }
      //patch it
      var x = await patchMedia(x.data.id, filesize, duration);
      return x;

    } else {
      console.log("file could not be opened");
      return 0;
    }
  } catch (e) {
    console.log("catch");
    console.log(e);
    return e;
  }
};
