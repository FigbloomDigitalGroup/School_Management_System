import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { settings } from "./settings.js";

/**
 * Everything that holds data or secrets: the network, PostgreSQL and the generated keys.
 * Kept apart from the services, with termination protection, so redeploying or even deleting
 * the service stack can never take the database with it.
 */
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly db: rds.DatabaseInstance;
  /** The owner's generated credentials (JSON: username, password, host, ...). */
  readonly ownerSecret: secretsmanager.ISecret;
  readonly appDbPassword: secretsmanager.Secret;
  readonly workerDbPassword: secretsmanager.Secret;
  readonly sessionMintHmacKey: secretsmanager.Secret;
  readonly idempotencyFingerprintKey: secretsmanager.Secret;
  readonly mfaEncryptionKey: secretsmanager.Secret;
  /** One security group per kind of task, so the database lets in exactly these. */
  readonly apiSg: ec2.SecurityGroup;
  readonly workerSg: ec2.SecurityGroup;
  readonly opsSg: ec2.SecurityGroup;

  /** Named, not looked up: synth needs no AWS call and the network never moves under us. */
  override get availabilityZones(): string[] {
    return [`${settings.region}a`, `${settings.region}b`];
  }

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Public subnets for the load balancer and the tasks (tasks take a public address for outbound calls such as
    // M-Pesa and push; their security groups admit nothing from the internet). Isolated subnets for the database,
    // which has no route to or from the internet. No NAT gateway.
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(settings.vpcCidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "database", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const sg = (name: string, description: string) =>
      new ec2.SecurityGroup(this, name, { vpc: this.vpc, description, allowAllOutbound: true });
    this.apiSg = sg("ApiSg", "FigBloom API tasks (inbound only from the load balancer)");
    this.workerSg = sg("WorkerSg", "FigBloom worker tasks (no inbound)");
    this.opsSg = sg("OpsSg", "FigBloom one-off operator tasks (no inbound)");
    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc: this.vpc,
      description: "FigBloom PostgreSQL (inbound 5432 from the API, worker and operator tasks only)",
      allowAllOutbound: false,
    });
    for (const [peer, what] of [
      [this.apiSg, "API"],
      [this.workerSg, "worker"],
      [this.opsSg, "operator tasks"],
    ] as const) {
      dbSg.addIngressRule(peer, ec2.Port.tcp(5432), `PostgreSQL from the ${what}`);
    }

    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 });
    const parameterGroup = new rds.ParameterGroup(this, "DbParams", {
      engine,
      description: "FigBloom API PostgreSQL 16",
      parameters: {
        "rds.force_ssl": "1",
        password_encryption: "scram-sha-256",
        // Never write bound parameters (they can hold keys and personal data) into the server log.
        log_parameter_max_length: "0",
        log_parameter_max_length_on_error: "0",
      },
    });

    const db = settings.database;
    // Created here (not inside the instance) so it can be kept if the stack is ever deleted: a snapshot is
    // useless without the owner's password.
    const ownerSecret = new rds.DatabaseSecret(this, "DbOwnerSecret", { username: db.owner, secretName: "figbloom-api/db-owner" });
    ownerSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.db = new rds.DatabaseInstance(this, "Db", {
      engine,
      instanceType: new ec2.InstanceType(db.instanceType),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      publiclyAccessible: false,
      credentials: rds.Credentials.fromSecret(ownerSecret),
      databaseName: db.name,
      parameterGroup,
      multiAz: db.multiAz,
      allocatedStorage: db.storageGiB,
      maxAllocatedStorage: db.maxStorageGiB,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      backupRetention: Duration.days(db.backupRetentionDays),
      preferredBackupWindow: db.backupWindow,
      preferredMaintenanceWindow: db.maintenanceWindow,
      deleteAutomatedBackups: false,
      copyTagsToSnapshot: true,
      autoMinorVersionUpgrade: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
    });
    this.ownerSecret = ownerSecret;

    // Generated once and kept even if the stack is deleted. Letters and digits only, so they survive URLs
    // and the session-hmac script's "no whitespace" rule.
    const generated = (id: string, name: string, description: string, length: number) => {
      const secret = new secretsmanager.Secret(this, id, {
        secretName: `figbloom-api/${name}`,
        description,
        generateSecretString: { passwordLength: length, excludePunctuation: true, includeSpace: false },
      });
      secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return secret;
    };
    this.appDbPassword = generated("AppDbPassword", "app-db-password", "Login password of figbloom_app (the API)", 40);
    this.workerDbPassword = generated("WorkerDbPassword", "worker-db-password", "Login password of figbloom_worker (the worker)", 40);
    this.sessionMintHmacKey = generated(
      "SessionMintHmacKey",
      "session-mint-hmac-key",
      "SESSION_MINT_HMAC_KEY. Must match the database's active key; rotate only with apps/api/docs/SESSION-HMAC-PROVISIONING.md",
      64,
    );
    this.idempotencyFingerprintKey = generated("IdempotencyFingerprintKey", "idempotency-fingerprint-key", "IDEMPOTENCY_FINGERPRINT_KEY", 64);
    this.mfaEncryptionKey = generated(
      "MfaEncryptionKey",
      "mfa-encryption-key",
      "MFA_ENCRYPTION_KEY. Encrypts every user's two-step secret: changing or losing it locks everyone with two-step out",
      64,
    );
  }
}
