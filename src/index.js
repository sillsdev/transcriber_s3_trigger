const https = require("https");
const path = require("path");
const mp3 = require("mp3-duration");
const mm = require('music-metadata/lib/core');

const host = process.env.SIL_TR_HOST;
const stagepath = process.env.SIL_TR_URLPATH;

exports.handler = async event => {
  const bucket = event.Records[0].s3.bucket.name;
  const key = decodeURIComponent(
    event.Records[0].s3.object.key.replace(/\+/g, " ")
  );
  console.log("hello! processing new s3 file!", key);
  const filename = path.basename(key);
  const filesize = event.Records[0].s3.object.size;

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
  
  async function getFileStream(filekey) {
    const aws = require("aws-sdk");
    const s3 = new aws.S3(); // Pass in opts to S3 if necessary
    var params = {
      Bucket: bucket,
      Key: filekey 
    };
    const stream = s3.getObject(params).createReadStream().on('error', err => {
      console.log('stream error', err.message);
      return null;
    })
      .on('finish', () => {
        //console.log('stream finish');
      })
      .on('close', () => {
        console.log('stream close');
      });
    return stream;
  }
  async function FileToBuffer(filekey) {
    var stream = null;
    var tries = 0;
    while (stream === null && tries < 3) {
      try {      
        stream = await getFileStream(filekey); 
      } catch (e) {
        console.log("key", filekey);
        console.log(e);
      }
      tries++;
    }
    if (stream !== null) {
      const chunks = [];
      for await (let chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    console.log("stream null");
    return null;
  }
  
  async function putFile(filekey, body) {
    const aws = require("aws-sdk");
    const s3 = new aws.S3(); // Pass in opts to S3 if necessary
    var params = {
      Bucket: bucket,
      Key: filekey,
      Body: body,
      ContentType: "application/ptf", 
    };
    var mu = s3.upload(params);
    var data = await mu.promise();
    console.log("file saved ", data.Location);
    return data.Location;
  }

  async function exportProjectMedia() {
      const AdmZip = require('adm-zip');

      console.log("export offline project file", key);
      var start = 0;
      var zip = new AdmZip(await FileToBuffer(key));
      var statusFile = key.substr(0, key.length-3) + "sss";         
      await putFile(statusFile,"0");
      var zipEntries = zip.getEntries();
      var deletemf = true;
      var mediafiles = zipEntries.find(e => e.entryName=== 'data/Z_attachedmediafiles.json');
      if (!mediafiles) {
        mediafiles = zipEntries.find(e => e.entryName=== 'data/H_mediafiles.json');
        deletemf = false;
      }

      if (mediafiles) {
        var mediastr = mediafiles.getData().toString('utf8');
        if (deletemf) zip.deleteFile(mediafiles);
        var media = JSON.parse(mediastr);
        if (Array.isArray(media.data)){
          for (var element of media.data) {
            if (element.attributes["audio-url"])
            {
              try {
              zip.addFile(element.attributes["audio-url"], await FileToBuffer(element.attributes["s3file"]));
              } catch (e) {
                console.log("error adding file");
                console.log(e);
              }
            }
            start += 1;
            if (start % 10 === 0)
            {
              await putFile(statusFile,start.toString());
            }
          }; 
          console.log("done", start );
          await putFile(key.substr(0, key.length-3)+"ptf", zip.toBuffer());
          await putFile(statusFile,"-1");
        }
      }
      return start;
  }
  try {
    if (key.startsWith("exports")) {
      if (key.endsWith("tmp"))
        return await exportProjectMedia();
      return 0;
    }

    if (key.startsWith("imports"))
      return 0; // await importProject();

    /* user media file */
    var x = await getMedia();
    console.log("ID" + x.data.id);
    var stream = null;
    var tries = 0
    while (stream === null && tries < 5) {
      console.log(tries);
      stream = await getFileStream(key);
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
