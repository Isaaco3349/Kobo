// Generates an ed25519 key in NEAR's text format.   npm run keygen
import crypto from "node:crypto";
import { b58encode } from "../web/borsh.js";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
console.log("public key        :", "ed25519:" + b58encode(pub));
console.log("private key       :", "ed25519:" + b58encode(Buffer.concat([seed, pub])), " <- keep secret, .env only");
console.log("implicit account  :", pub.toString("hex"));
