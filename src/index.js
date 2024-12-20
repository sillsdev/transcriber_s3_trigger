const https = require("https");
const path = require("path");
const mp3 = require("mp3-duration");
const mm = require("music-metadata/lib/core");

const host = process.env.SIL_TR_HOST;
const stagepath = process.env.SIL_TR_URLPATH;

exports.handler = async (event) => {
  const bucket = event.Records[0].s3.bucket.name;
  let key = decodeURIComponent(
    event.Records[0].s3.object.key.replace(/\+/g, " ")
  );
  console.log("hello! processing new s3 file!", key);
  //key looks like 139647_Tes/126282_Luk/NIV11-LUK-001-001004v01.mp3
  var parts = key.split("/");
  var plan = parts[1].split("_")[0];

  const filename = path.basename(key);
  const filesize = event.Records[0].s3.object.size;

  function getMedia() {
    return new Promise((resolve, reject) => {
      // options for API request
      var options = {
        host: host,
        path: `${stagepath}/api/mediafiles/fromfile/${plan}/${encodeURI(
          filename
        )}`,
        method: "GET",
      };
      const req = https.request(options, (res) => {
        console.log("media statusCode:", res.statusCode, options);
        if (res.statusCode === 404) {
          //not found
          reject(res.statusCode);
        }
        res.on("data", (d) => {
          resolve(JSON.parse(d));
        });
      });

      req.on("error", (e) => {
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
          stagepath +
          "/api/mediafiles/" +
          id +
          "/fileinfo/" +
          filesize +
          "/" +
          duration,
        method: "PATCH",
      };

      const req = https.request(options, (res) => {
        console.log("media statusCode:", res.statusCode, options);
        if (res.statusCode === 404) {
          //not found
          reject(res.statusCode);
        }
        res.on("data", (d) => {
          resolve(JSON.parse(d));
        });
      });

      req.on("error", (e) => {
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
      Key: key, // path to the object you're looking for
    };
    const data = await s3.getObject(params).promise();
    return data.Body;
  }

  async function getFileStream(filekey) {
    const aws = require("aws-sdk");
    const s3 = new aws.S3(); // Pass in opts to S3 if necessary
    var params = {
      Bucket: bucket,
      Key: filekey,
    };
    const stream = s3
      .getObject(params)
      .createReadStream()
      .on("error", (err) => {
        console.log("stream error", err.message);
        return null;
      })
      .on("finish", () => {
        //console.log('stream finish');
      })
      .on("close", () => {
        //console.log("stream close");
      });
    return stream;
  }

  try {
    if (key.startsWith("exports")) return 0; 
    if (key.startsWith("imports")) return 0; // await importProject();

    /* user media file */
    var x = await getMedia();
    var stream = null;
    var tries = 0;
    while (stream === null && tries < 5) {
      console.log(tries);
      stream = await getFileStream(key);
      tries++;
    }
    if (stream !== null) {
      var metadata = await mm.parseStream(
        stream,
        x.data.attributes["content-type"]
      );
      var duration = metadata.format.duration;

      if (duration === undefined) {
        duration = await mp3(await getFile()); //this doesn't do m4a files correctly so it's a backup only
        console.log("Your file is " + duration + " seconds long - mm");
      } else {
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
    console.log("catch", key);
    console.log(e);
    return e;
  }
};
