/**
 * Every production choice in one place. Changing a value here and deploying changes the live system,
 * so read the note beside it first.
 */
export const settings = {
  /** Ireland. The figbloom-prod AWS profile and the API's S3 example both use it. */
  region: "eu-west-1",
  /** The API's public address. TLS certificate: AWS Certificate Manager, DNS-validated (see infra/README.md). */
  apiDomain: "sms-api.figbloom.org",
  /** Browser origins allowed to call the API (exact origins; the API refuses wildcards). */
  webOrigins: ["https://schoolmanagement.figbloom.org"],

  /** Address range of the API's private network. API_TRUST_PROXY_CIDRS is this range (the load balancer lives in it). */
  vpcCidr: "10.40.0.0/16",

  database: {
    name: "figbloom_api",
    /** The RDS master user. It owns every table and runs the migrations; the API never connects as it. */
    owner: "figbloom_owner",
    /** 2 vCPU burstable, 2 GiB. About 200 connections. */
    instanceType: "t4g.small",
    /** A standby in a second zone. Doubles the database cost; turn on when downtime during an AWS zone failure matters. */
    multiAz: false,
    storageGiB: 20,
    maxStorageGiB: 100,
    backupRetentionDays: 14,
    /** UTC. 03:00-04:00 and Sunday 04:30-05:30 in Nairobi. */
    backupWindow: "00:00-01:00",
    maintenanceWindow: "sun:01:30-sun:02:30",
  },

  api: {
    port: 4100,
    /** Two tasks so one can fail or be replaced without an outage. */
    desiredCount: 2,
    cpu: 512,
    memoryMiB: 1024,
    /** Per task. Budget: 2 tasks x (10 + 10 cancel headroom) + worker + release, well under the database's ~200. */
    poolMax: 10,
  },

  worker: {
    desiredCount: 1,
    cpu: 256,
    memoryMiB: 512,
  },

  logs: {
    /** API and worker logs. They carry error classes and codes, not request bodies. */
    serviceRetentionDays: 90,
    /** Release and operator commands. bootstrap-admin prints a single-use 30-minute setup token here. */
    opsRetentionDays: 7,
  },
} as const;
