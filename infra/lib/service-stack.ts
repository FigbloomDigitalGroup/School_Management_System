import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import { IgnoreMode } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { DataStack } from "./data-stack.js";
import { settings } from "./settings.js";

export interface ServiceStackProps extends StackProps {
  data: DataStack;
  /** ACM certificate for settings.apiDomain, ISSUED, in settings.region. */
  certificateArn: string;
  /** The repository root (the image's build context). */
  repoRoot: string;
}

/**
 * The running parts: one image, three uses.
 *   API service      behind an HTTPS load balancer; health = /readyz
 *   worker service   no inbound traffic
 *   ops task         run by hand (infra/scripts/ops.sh) for bootstrap-admin and session-hmac
 * Every API and worker task first runs the image's `release` command as an init container (migrate, role
 * passwords, session-mint key). The serving container starts only if that succeeded, and it never receives
 * the owner's credentials (apps/api: the serving process must not hold them).
 */
export class ServiceStack extends Stack {
  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);
    const { data } = props;
    const vpc = data.vpc;
    const publicSubnets = { subnetType: ec2.SubnetType.PUBLIC };

    const image = ecs.ContainerImage.fromDockerImageAsset(
      new DockerImageAsset(this, "ApiImage", {
        directory: props.repoRoot,
        file: "infra/api/Dockerfile",
        platform: Platform.LINUX_AMD64,
        ignoreMode: IgnoreMode.DOCKER,
      }),
    );

    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: "figbloom-api" });

    const logGroup = (id: string, name: string, days: number) =>
      new logs.LogGroup(this, id, {
        logGroupName: `/figbloom-api/${name}`,
        retention: days as logs.RetentionDays,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    const apiLogs = logGroup("ApiLogs", "api", settings.logs.serviceRetentionDays);
    const workerLogs = logGroup("WorkerLogs", "worker", settings.logs.serviceRetentionDays);
    const opsLogs = logGroup("OpsLogs", "ops", settings.logs.opsRetentionDays);

    const dbEnv: Record<string, string> = {
      APP_ENV: "production",
      NODE_ENV: "production",
      DB_HOST: data.db.dbInstanceEndpointAddress,
      DB_PORT: data.db.dbInstanceEndpointPort,
      DB_NAME: settings.database.name,
    };
    const secret = ecs.Secret.fromSecretsManager;
    const ownerSecrets = {
      OWNER_DB_USERNAME: secret(data.ownerSecret, "username"),
      OWNER_DB_PASSWORD: secret(data.ownerSecret, "password"),
      APP_DB_PASSWORD: secret(data.appDbPassword),
      WORKER_DB_PASSWORD: secret(data.workerDbPassword),
      SESSION_MINT_HMAC_KEY: secret(data.sessionMintHmacKey),
    };

    const taskDefinition = (id: string, family: string, cpu: number, memoryLimitMiB: number) =>
      new ecs.FargateTaskDefinition(this, id, {
        family,
        cpu,
        memoryLimitMiB,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
    const linuxParameters = (id: string) => new ecs.LinuxParameters(this, id, { initProcessEnabled: true });
    const addRelease = (td: ecs.FargateTaskDefinition, prefix: string) =>
      td.addContainer("release", {
        image,
        command: ["release"],
        essential: false,
        environment: dbEnv,
        secrets: ownerSecrets,
        linuxParameters: linuxParameters(`${prefix}ReleaseLinux`),
        logging: ecs.LogDrivers.awsLogs({ logGroup: opsLogs, streamPrefix: `release-${prefix.toLowerCase()}` }),
      });

    // ---- API --------------------------------------------------------------------------------------------
    const apiTd = taskDefinition("ApiTask", "figbloom-api", settings.api.cpu, settings.api.memoryMiB);
    const apiRelease = addRelease(apiTd, "Api");
    const api = apiTd.addContainer("api", {
      image,
      command: ["api"],
      essential: true,
      environment: {
        ...dbEnv,
        API_HOST: "0.0.0.0",
        API_PORT: String(settings.api.port),
        RUNTIME_ROLE: "figbloom_app",
        APPLICATION_NAME: "figbloom-api",
        POOL_MAX: String(settings.api.poolMax),
        CORS_ALLOWED_ORIGINS: settings.webOrigins.join(","),
        // TLS ends at the load balancer for this host only, and it serves HTTPS only.
        HSTS_ENABLED: "true",
        // The load balancer adds the client's address to X-Forwarded-For; trust exactly that one hop, from inside the VPC.
        API_TRUST_PROXY_HOPS: "1",
        API_TRUST_PROXY_CIDRS: settings.vpcCidr,
        MFA_ENFORCEMENT: "enforce",
        // ECS takes the task out of the load balancer (deregistration delay) before it sends SIGTERM,
        // so a short drain is enough. Hard limit must exceed grace + drain (the API checks).
        SHUTDOWN_DRAIN_DELAY_MS: "5000",
        SHUTDOWN_GRACE_MS: "10000",
        SHUTDOWN_HARD_TIMEOUT_MS: "20000",
      },
      secrets: {
        APP_DB_PASSWORD: secret(data.appDbPassword),
        SESSION_MINT_HMAC_KEY: secret(data.sessionMintHmacKey),
        IDEMPOTENCY_FINGERPRINT_KEY: secret(data.idempotencyFingerprintKey),
        MFA_ENCRYPTION_KEY: secret(data.mfaEncryptionKey),
      },
      portMappings: [{ containerPort: settings.api.port }],
      stopTimeout: Duration.seconds(30),
      linuxParameters: linuxParameters("ApiLinux"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogs, streamPrefix: "api" }),
    });
    api.addContainerDependencies({ container: apiRelease, condition: ecs.ContainerDependencyCondition.SUCCESS });

    // The API's security group lives in the data stack (the database's rule names it). Used here through an
    // IMMUTABLE reference, so the load balancer cannot write its rule into the data stack (a cross-stack cycle);
    // the one rule it needs is added below, in this stack.
    const apiSg = ec2.SecurityGroup.fromSecurityGroupId(this, "ApiSgRef", data.apiSg.securityGroupId, { mutable: false });
    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      serviceName: "api",
      taskDefinition: apiTd,
      desiredCount: settings.api.desiredCount,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: true,
      vpcSubnets: publicSubnets,
      securityGroups: [apiSg],
      healthCheckGracePeriod: Duration.seconds(90),
      circuitBreaker: { enable: true, rollback: true },
    });

    // HTTPS only. There is deliberately no port 80: a bearer token sent to http:// would cross the internet
    // in clear before any redirect could happen.
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc, description: "FigBloom API load balancer (HTTPS from anywhere)" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    new ec2.CfnSecurityGroupIngress(this, "AlbToApi", {
      groupId: data.apiSg.securityGroupId,
      sourceSecurityGroupId: albSg.securityGroupId,
      ipProtocol: "tcp",
      fromPort: settings.api.port,
      toPort: settings.api.port,
      description: "API port from the load balancer only",
    });
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      vpcSubnets: publicSubnets,
      internetFacing: true,
      securityGroup: albSg,
      // The API's keep-alive (65 s) must outlast this.
      idleTimeout: Duration.seconds(60),
      dropInvalidHeaderFields: true,
    });
    const https = alb.addListener("Https", {
      port: 443,
      open: false,
      certificates: [acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    });
    https.addTargets("Api", {
      port: settings.api.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService.loadBalancerTarget({ containerName: "api", containerPort: settings.api.port })],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        // Ready = database reachable AND the session-mint key matches (apps/api/docs/OPERATIONS.md).
        path: "/readyz",
        healthyHttpCodes: "200",
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // ---- worker -----------------------------------------------------------------------------------------
    const workerTd = taskDefinition("WorkerTask", "figbloom-worker", settings.worker.cpu, settings.worker.memoryMiB);
    const workerRelease = addRelease(workerTd, "Worker");
    const worker = workerTd.addContainer("worker", {
      image,
      command: ["worker"],
      essential: true,
      environment: dbEnv,
      secrets: { WORKER_DB_PASSWORD: secret(data.workerDbPassword) },
      stopTimeout: Duration.seconds(30),
      linuxParameters: linuxParameters("WorkerLinux"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogs, streamPrefix: "worker" }),
    });
    worker.addContainerDependencies({ container: workerRelease, condition: ecs.ContainerDependencyCondition.SUCCESS });
    new ecs.FargateService(this, "WorkerService", {
      cluster,
      serviceName: "worker",
      taskDefinition: workerTd,
      desiredCount: settings.worker.desiredCount,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: true,
      vpcSubnets: publicSubnets,
      securityGroups: [ec2.SecurityGroup.fromSecurityGroupId(this, "WorkerSgRef", data.workerSg.securityGroupId, { mutable: false })],
      circuitBreaker: { enable: true, rollback: true },
    });

    // ---- operator task (no service; run with infra/scripts/ops.sh) ---------------------------------------
    const opsTd = taskDefinition("OpsTask", "figbloom-ops", 256, 512);
    opsTd.addContainer("ops", {
      image,
      command: ["session-hmac", "status"],
      essential: true,
      environment: dbEnv,
      secrets: ownerSecrets,
      linuxParameters: linuxParameters("OpsLinux"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: opsLogs, streamPrefix: "ops" }),
    });

    new CfnOutput(this, "ApiUrl", { value: `https://${settings.apiDomain}` });
    new CfnOutput(this, "LoadBalancerDns", {
      value: alb.loadBalancerDnsName,
      description: `DNS: make ${settings.apiDomain} a CNAME to this`,
    });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "OpsTaskDefinition", { value: opsTd.family });
    new CfnOutput(this, "OpsSubnets", { value: vpc.selectSubnets(publicSubnets).subnetIds.join(",") });
    new CfnOutput(this, "OpsSecurityGroup", { value: data.opsSg.securityGroupId });
    new CfnOutput(this, "OpsLogGroup", { value: opsLogs.logGroupName });
  }
}
