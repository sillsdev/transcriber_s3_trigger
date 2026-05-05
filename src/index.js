import https from "https";
import path from "path";
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { Readable } from "stream";
import { execFile } from "child_process";

const host = process.env.SIL_TR_HOST;
const stagepath = process.env.SIL_TR_URLPATH;
const s3Client = new S3Client({ region: "us-east-1" });

/** @param {string} urlString */
function parseS3HttpUrl(urlString) {
  const s = String(urlString ?? "").trim();
  if (!s) {
    throw new Error("S3 URL is empty");
  }
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    const err = new Error(
      `Invalid URL (expected http(s) S3 URL): ${s.slice(0, 160)}`,
    );
    err.cause = e;
    throw err;
  }
  const hn = u.hostname;
  const virtual = hn.match(/^([^.]+)\.s3(?:\.([a-z0-9-]+))?\.amazonaws\.com$/i);
  if (virtual) {
    return {
      Bucket: virtual[1],
      Key: decodeURIComponent(
        u.pathname.replace(/^\//, "").replace(/\+/g, " "),
      ),
    };
  }
  if (/^s3[.-]/.test(hn) && hn.endsWith(".amazonaws.com")) {
    const parts = u.pathname.replace(/^\//, "").split("/");
    if (parts.length >= 2) {
      return {
        Bucket: parts[0],
        Key: decodeURIComponent(parts.slice(1).join("/").replace(/\+/g, " ")),
      };
    }
  }
  throw new Error(`Unsupported S3 URL: ${s.slice(0, 160)}`);
}

/** Pathname basename must match ffprobe-supported media (exclude PDF/doc/images, etc.). */
function isFfprobeableMessageUrl(urlString) {
  try {
    const u = new URL(urlString);
    const base = path.basename(u.pathname);
    return /\.(mp3|m4a|mp4|mpe?g|ogg|opus|wav|flac|aac|webm|mkv|mov|3gpp?|wma|aif|aiff|caf)$/i.test(
      base,
    );
  } catch {
    return false;
  }
}

/** true when S3 object does not exist (HeadObject/Get 404-style errors). */
function isS3NotFoundError(err) {
  const status = err?.$metadata?.httpStatusCode;
  if (status === 404) return true;
  const name = err?.name;
  return (
    name === "NotFound" ||
    name === "NoSuchKey" ||
    name === "NotFoundException"
  );
}

export const handler = async (event, context) => {
  const bucket = event.Records[0].s3.bucket.name;
  let key = decodeURIComponent(
    event.Records[0].s3.object.key.replace(/\+/g, " "),
  );
  console.log("hello! processing new s3 file!", key);

  const filename = path.basename(key);

  function getMedia() {
    return new Promise((resolve, reject) => {
      var options = {
        host: host,
        path: `${stagepath}/api/mediafiles/fromfile/${plan}/${encodeURI(
          filename,
        )}`,
        method: "GET",
      };
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        fn(val);
      };
      const req = https.request(options, (res) => {
        console.log("media statusCode:", res.statusCode, options);
        if (res.statusCode === 404) {
          done(reject, res.statusCode);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on("data", (d) => {
            chunks.push(d);
          });
          res.on("end", () => {
            console.log(
              "getMedia error body:",
              Buffer.concat(chunks).toString("utf8"),
            );
            done(reject, new Error(`getMedia failed: ${res.statusCode}`));
          });
          return;
        }
        const chunks = [];
        res.on("data", (d) => {
          chunks.push(d);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!body) {
            done(reject, new Error("getMedia empty response"));
            return;
          }
          try {
            done(resolve, JSON.parse(body));
          } catch (e) {
            console.log("getMedia parse error", e);
            done(reject, e);
          }
        });
      });

      req.on("error", (e) => {
        console.log("media error:", e);
        done(reject, e);
      });

      req.end();
    });
  }

  async function patchMedia(id, filesize, duration) {
    return new Promise((resolve, reject) => {
      var options = {
        host: host,
        path: `${stagepath}/api/mediafiles/${id}/fileinfo/${filesize}/${duration}`,
        method: "PATCH",
      };
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        fn(val);
      };
      const req = https.request(options, (res) => {
        if (res.statusCode === 404) {
          done(reject, res.statusCode);
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (d) => {
          chunks.push(d);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!body) return done(resolve);
          try {
            done(resolve, JSON.parse(body));
          } catch (_e) {
            done(resolve, body);
          }
        });
      });

      req.setTimeout(5000, () => {
        req.destroy(new Error("patchMedia timeout"));
      });

      req.on("error", (e) => {
        done(reject, e);
      });

      req.end();
    });
  }

  async function getFile() {
    const params = {
      Bucket: bucket,
      Key: key,
    };
    const command = new GetObjectCommand(params);
    const { Body } = await s3Client.send(command);
    const stream = Body instanceof Readable ? Body : Readable.from(Body);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function getFileStream(filekey) {
    var params = {
      Bucket: bucket,
      Key: filekey,
    };

    const command = new GetObjectCommand(params);
    const { Body } = await s3Client.send(command);
    return Body instanceof Readable ? Body : Readable.from(Body);
  }
  async function getMediaInfo() {
    return new Promise((resolve, reject) => {
      const options = {
        host: host,
        path: `${stagepath}/api/simpleresponse/baddurations`,
        method: "GET",
      };
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        fn(val);
      };
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on("data", (d) => {
            chunks.push(d);
          });
          res.on("end", () => {
            done(reject, new Error(`getMediaInfo failed: ${res.statusCode}`));
          });
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (d) => {
          chunks.push(d);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            done(resolve, body ? JSON.parse(body) : []);
          } catch (e) {
            console.log("getMediaInfo parse error", e);
            done(reject, e);
          }
        });
      });

      req.setTimeout(30000, () => {
        console.log("getMediaInfo request timeout");
        req.destroy(new Error("getMediaInfo timeout"));
      });

      req.on("error", (e) => {
        console.log("getMediaInfo error:", e);
        done(reject, e);
      });

      req.end();
    });
  }
  async function deleteTriggerObject() {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (e) {
      console.log("deleteTriggerObject error:", e);
    }
  }

  /**
   * Synthetic S3 key for the self-invoke payload only (no PutObject). Handler uses
   * key.startsWith("fixDuration") to select the fixDuration branch.
   */
  function nextFixDurationInvokeKey() {
    return `fixDuration/requeue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
  }

  /**
   * Schedules the next batch via Lambda.Invoke (avoids S3→Lambda recursion suppression on same bucket).
   * Requires lambda:InvokeFunction on this function in the execution role.
   *
   * Invoke returns 202 when the async invoke is *accepted* only. AWS recursive-loop detection can still
   * drop later hops (same function → same function) unless the function has recursion config Allow;
   * see serverless.yml `recursiveLoop: Allow` or `aws lambda put-function-recursion-config`.
   */
  async function invokeNextFixDurationRun(lambdaContext, syntheticKey) {
    const functionName =
      lambdaContext.functionName || process.env.AWS_LAMBDA_FUNCTION_NAME;
    if (!functionName) {
      throw new Error(
        "Cannot requeue fixDuration: missing function name (context.functionName / AWS_LAMBDA_FUNCTION_NAME)",
      );
    }
    const payload = {
      Records: [
        {
          eventVersion: "2.1",
          eventSource: "aws:s3",
          awsRegion: process.env.AWS_REGION || "us-east-1",
          s3: {
            bucket: { name: bucket },
            object: { key: syntheticKey },
          },
        },
      ],
    };
    const region = process.env.AWS_REGION || "us-east-1";
    const payloadStr = JSON.stringify(payload);

    const lambdaClient = new LambdaClient({ region });
    try {
      const out = await lambdaClient.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "Event",
          Payload: Buffer.from(payloadStr, "utf8"),
        }),
      );

    } catch (err) {
      console.log("fixDuration invoke: error", {
        functionName,
        syntheticKey,
        name: err?.name,
        message: err?.message,
        code: err?.Code ?? err?.code,
        $metadata: err?.$metadata,
      });
      throw err;
    }
  }

  async function fixDurations(lambdaContext) {
    const files = await getMediaInfo();
    await deleteTriggerObject();
    //array of objects like this: {
    //"message": "https://sil-transcriber-userfiles-dev.s3.amazonaws.com/MAT001_001-006backtranslation1_v1_3671_Matth.ogg",
    //"id": 19629,
    //"stringId": "19629",
    //"localId": null
    //},
    for (const file of files) {
      let durationSeconds;
      let outputFileSizeBytes;
      try {
        ({ durationSeconds, outputFileSizeBytes } = await getFileMetadata(
          file.message,
          { allowFallbackDuration: true },
        ));
      } catch (e) {
        console.log(
          "getFileMetadata failed (non-404 S3/other), skipping",
          file.message,
          e,
        );
        continue;
      }
      if (outputFileSizeBytes === undefined) {
        console.log("bad metadata, skipping", file.message, {
          durationSeconds,
          outputFileSizeBytes,
        });
        continue;
      }
      console.log(file.id, "output duration (s)", durationSeconds, "output size (bytes)", outputFileSizeBytes);
      await patchMedia(file.id, outputFileSizeBytes, durationSeconds);
    }
    const shouldRequeue = Array.isArray(files) && files.length > 0;
    if (shouldRequeue) {
      const syntheticKey = nextFixDurationInvokeKey();
      console.log("fixDuration requeue: scheduling next invoke", {
        parentRequestId: lambdaContext?.awsRequestId,
        filesCount: files.length,
        syntheticKey,
      });
      await invokeNextFixDurationRun(lambdaContext, syntheticKey);
    }
    return {
      success: true,
      requeued: shouldRequeue,
    };
  }
  /**
   * @param {string} messageUrl
   * @param {{ allowFallbackDuration?: boolean }} [opts]
   * Non-audio URLs always use duration -1 after HeadObject (size from S3).
   * When `allowFallbackDuration` is false (upload path): ffprobe must succeed or the call throws;
   * when true (fixDuration job): ffprobe/not-found fallbacks use -1 to clear API rows.
   */
  async function getFileMetadata(messageUrl, opts = {}) {
    const allowFallbackDuration = !!opts.allowFallbackDuration;
    const raw = messageUrl == null ? "" : String(messageUrl);
    const trimmed = raw.trim();

    if (!trimmed) {
      if (allowFallbackDuration) {
        console.log(
          "empty or missing message URL; PATCH duration -1 and size 0 so row leaves baddurations",
        );
        return { durationSeconds: -1, outputFileSizeBytes: 0 };
      }
      throw new Error("audio URL is missing or empty");
    }

    let Bucket;
    let Key;
    try {
      ({ Bucket, Key } = parseS3HttpUrl(trimmed));
    } catch (parseErr) {
      if (allowFallbackDuration) {
        console.log(
          "invalid message URL; PATCH duration -1 and size 0 so row leaves baddurations",
          trimmed,
          parseErr,
        );
        return { durationSeconds: -1, outputFileSizeBytes: 0 };
      }
      throw parseErr;
    }

    let head;
    try {
      head = await s3Client.send(new HeadObjectCommand({ Bucket, Key }));
    } catch (err) {
      if (allowFallbackDuration && isS3NotFoundError(err)) {
        console.log(
          "S3 object not found (HeadObject); PATCH duration -1 and size 0 so row leaves baddurations",
          { Bucket, Key },
        );
        return { durationSeconds: -1, outputFileSizeBytes: 0 };
      }
      throw err;
    }
    const outputFileSizeBytes = head.ContentLength ?? 0;

    /** @type {number} */
    let durationSeconds;

    if (!isFfprobeableMessageUrl(trimmed)) {
      durationSeconds = -1;
      console.log(
        "non-audio extension; PATCH duration -1 so row leaves baddurations",
        trimmed,
      );
      return { durationSeconds, outputFileSizeBytes };
    }
    try {
      const durationRaw = await execFilePromise(
        "/opt/bin/ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          trimmed,
        ],
        120,
      );
      const parsed = parseFloat(String(durationRaw).trim());
      if (!Number.isFinite(parsed)) {
        if (allowFallbackDuration) {
          durationSeconds = -1;
        } else {
          throw new Error(`invalid ffprobe duration for ${trimmed}`);
        }
      } else {
        durationSeconds = Math.ceil(parsed);
      }
    } catch (e) {
      if (allowFallbackDuration) {
        console.log(
          "ffprobe failed; patching duration -1 to drop from queue",
          trimmed,
          e,
        );
        durationSeconds = -1;
      } else {
        throw e;
      }
    }

    if (allowFallbackDuration && !Number.isFinite(durationSeconds)) {
      durationSeconds = -1;
    }
    return { durationSeconds, outputFileSizeBytes };
  }

  function execFilePromise(file, args, timeoutsecs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        fn(val);
      };
      const child = execFile(
        file,
        args,
        { timeout: timeoutsecs * 1000, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          if (error) {
            console.log(
              "execFile error",
              error,
              "stderr",
              stderr,
              "stdout",
              stdout,
            );
            done(reject, error);
            return;
          }
          done(resolve, stdout);
        },
      );
      const timer = setTimeout(() => {
        console.log("execFile timeout");
        try {
          child.kill("SIGKILL");
        } catch (e) {
          console.log("Cannot kill process", e);
        }
        done(reject, new Error("execFile timeout"));
      }, timeoutsecs * 1000);
    });
  }

  try {
    if (key.startsWith("exports")) return 0;
    if (key.startsWith("imports")) return 0; // await importProject();
    if (key.startsWith("fixDuration")) {
      await fixDurations(context);
      return;
    }
    //key looks like 139647_Tes/126282_Luk/NIV11-LUK-001-001004v01.mp3
    var parts = key.split("/");
    var plan = parts[1].split("_")[0];

    /* user media file */
    var x = await getMedia();
    const { durationSeconds, outputFileSizeBytes } = await getFileMetadata(
      x.data.attributes["audio-url"],
    );
    //patch it
    var x = await patchMedia(x.data.id, outputFileSizeBytes, durationSeconds);
    return x;
  } catch (e) {
    console.log("catch", key);
    console.log(e);
    return e;
  }
};
