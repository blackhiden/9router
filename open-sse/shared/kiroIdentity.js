import { createHash } from "crypto";

export const KIRO_IDE_VERSION = "1.4.154";
export const KIRO_SDK_VERSION = "1.0.0";
export const KIRO_AGENT_OS = "windows";
export const KIRO_AGENT_OS_VERSION = "10.0.26200";
export const KIRO_NODE_VERSION = "22.21.1";

const CLIENTS = {
  streaming: { api: "codewhispererstreaming", metrics: "E" },
  runtime: { api: "codewhispererruntime", metrics: "N,E" },
};

/**
 * Build the User-Agent / X-Amz-User-Agent pair sent by Kiro IDE.
 * The machineId is a sha256 digest of the account's most stable identifier,
 * so no raw credential reaches a header.
 *
 * @param {object} [credentials]
 * @param {"runtime" | "streaming"} [client="runtime"]
 * @returns {{ "User-Agent": string, "X-Amz-User-Agent": string }}
 */
export function buildKiroIdentityHeaders(credentials, client = "runtime") {
  const seed =
    credentials?.providerSpecificData?.clientId
    || credentials?.refreshToken
    || credentials?.providerSpecificData?.profileArn
    || credentials?.apiKey
    || credentials?.accessToken
    || "kiro-anonymous";
  const machineId = createHash("sha256").update(String(seed)).digest("hex");
  const { api, metrics } = CLIENTS[client] || CLIENTS.runtime;
  const identity = `KiroIDE-${KIRO_IDE_VERSION}-${machineId}`;
  return {
    "User-Agent":
      `aws-sdk-js/${KIRO_SDK_VERSION} ua/2.1 os/${KIRO_AGENT_OS}#${KIRO_AGENT_OS_VERSION} lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
      `api/${api}#${KIRO_SDK_VERSION} m/${metrics} ${identity}`,
    "X-Amz-User-Agent": `aws-sdk-js/${KIRO_SDK_VERSION} ${identity}`,
  };
}
