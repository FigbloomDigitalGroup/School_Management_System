/**
 * Every production choice in one place. Changing a value here and deploying changes the live system,
 * so read the note beside it first.
 */
export const settings = {
  /** Ireland, where the rest of the FigBloom platform runs (profile figbloom-prod). */
  region: "eu-west-1",
  /** Stack names and tags follow the account's convention: <Component>-prod, Project=figbloom. */
  stacks: { data: "SchoolsApiData-prod", service: "SchoolsApi-prod" },
  /** Names for secrets (figbloom/<component>/...) and log groups (/figbloom/<component>/...). */
  component: "schools-api",

  /** The API's public address. Its certificate is attached to the shared load balancer (infra/README.md). */
  apiDomain: "sms-api.figbloom.org",
  /**
   * Browser origins allowed to call the API (exact origins; the API refuses wildcards). The first is also where
   * account e-mails link (accept-invite, reset-password): the web app's address once it runs on the API.
   */
  webOrigins: ["https://schoolmanagement.figbloom.org"],

  /** Senders for Resend. figbloom.org must be verified in Resend, or every send is refused. */
  email: {
    accountFrom: "FigBloom <no-reply@figbloom.org>",
    billingFrom: "FigBloom Billing <billing@figbloom.org>",
  },

  /** The shared platform this app plugs into (lib/platform.ts). Values read from the live account on 2026-11-24. */
  platform: {
    vpcCidr: "10.20.0.0/16",
    availabilityZones: ["eu-west-1a", "eu-west-1b"],
    /** Idle timeout of the shared load balancer. The API's keep-alive must be longer, or idle connections end in 502s. */
    loadBalancerIdleTimeoutSeconds: 120,
    /**
     * Priority of this app's host rule on the shared HTTPS listener. Must be unique on that listener;
     * in use on 2026-11-24: 100, 101 (HR), 500 (CRM).
     */
    listenerRulePriority: 300,
  },

  database: {
    instanceIdentifier: "figbloom-schools-api-prod",
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
