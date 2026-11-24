import { CfnOutput, Duration, IgnoreMode, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { DataStack } from "./data-stack.js";
import { edgeHttpsListener, edgeSecurityGroup, sharedVpc } from "./platform.js";
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
 *   API service      in the shared private subnets, reached through the shared load balancer by host name
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
    const vpc = sharedVpc(this);
    const privateSubnets = { subnets: vpc.privateSubnets };
    const immutable = (id: string, group: ec2.ISecurityGroup) =>
      // Used through immutable references so nothing here writes rules into the data stack (a cross-stack cycle).
      ec2.SecurityGroup.fromSecurityGroupId(this, id, group.securityGroupId, { mutable: false });

    const image = ecs.ContainerImage.fromDockerImageAsset(
      new DockerImageAsset(this, "ApiImage", {
        directory: props.repoRoot,
        file: "infra/api/Dockerfile",
        platform: Platform.LINUX_AMD64,
        ignoreMode: IgnoreMode.DOCKER,
      }),
    );

    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: `figbloom-${settings.component}-prod` });

    const logGroup = (id: string, suffix: string, days: number) =>
      new logs.LogGroup(this, id, {
        logGroupName: `/figbloom/${settings.component}/${suffix}`,
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
    // The shared load balancer keeps idle connections for 120 s; the API must keep them longer, or it closes
    // a connection the balancer is about to reuse and the client gets a 502.
    const keepAliveMs = (settings.platform.loadBalancerIdleTimeoutSeconds + 5) * 1000;
    const apiTd = taskDefinition("ApiTask", `figbloom-${settings.component}`, settings.api.cpu, settings.api.memoryMiB);
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
        // TLS ends at the shared load balancer, which redirects HTTP to HTTPS for every host.
        HSTS_ENABLED: "true",
        // The load balancer adds the client's address to X-Forwarded-For; trust exactly that one hop, from inside the VPC.
        API_TRUST_PROXY_HOPS: "1",
        API_TRUST_PROXY_CIDRS: settings.platform.vpcCidr,
        MFA_ENFORCEMENT: "enforce",
        SERVER_KEEP_ALIVE_TIMEOUT_MS: String(keepAliveMs),
        SERVER_HEADERS_TIMEOUT_MS: String(keepAliveMs + 1000),
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

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      serviceName: "api",
      taskDefinition: apiTd,
      desiredCount: settings.api.desiredCount,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: privateSubnets,
      securityGroups: [immutable("ApiSgRef", data.apiSg)],
      healthCheckGracePeriod: Duration.seconds(90),
      circuitBreaker: { enable: true, rollback: true },
    });

    // Plug into the shared load balancer the way the other apps do: our certificate on its HTTPS listener,
    // and a rule that sends our host name to our tasks. Every other host is untouched.
    const edgeSg = edgeSecurityGroup(this);
    const listener = edgeHttpsListener(this, edgeSg);
    new elbv2.ApplicationListenerCertificate(this, "Certificate", {
      listener,
      certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
    });
    const targets = new elbv2.ApplicationTargetGroup(this, "ApiTargets", {
      vpc,
      port: settings.api.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
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
    const hostRule = new elbv2.ApplicationListenerRule(this, "HostRule", {
      listener,
      priority: settings.platform.listenerRulePriority,
      conditions: [elbv2.ListenerCondition.hostHeaders([settings.apiDomain])],
      action: elbv2.ListenerAction.forward([targets]),
    });
    apiService.attachToApplicationTargetGroup(targets);
    // ECS refuses a target group that no load balancer uses yet: create the rule first.
    apiService.node.addDependency(hostRule);
    new ec2.CfnSecurityGroupIngress(this, "EdgeToApi", {
      groupId: data.apiSg.securityGroupId,
      sourceSecurityGroupId: edgeSg.securityGroupId,
      ipProtocol: "tcp",
      fromPort: settings.api.port,
      toPort: settings.api.port,
      description: "API port from the shared load balancer only",
    });

    // ---- worker -----------------------------------------------------------------------------------------
    const workerTd = taskDefinition("WorkerTask", `figbloom-${settings.component}-worker`, settings.worker.cpu, settings.worker.memoryMiB);
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
      assignPublicIp: false,
      vpcSubnets: privateSubnets,
      securityGroups: [immutable("WorkerSgRef", data.workerSg)],
      circuitBreaker: { enable: true, rollback: true },
    });

    // ---- operator task (no service; run with infra/scripts/ops.sh) ---------------------------------------
    const opsTd = taskDefinition("OpsTask", `figbloom-${settings.component}-ops`, 256, 512);
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
    new CfnOutput(this, "DnsNote", {
      value: `${settings.apiDomain} CNAME -> the LoadBalancerDns output of the Edge-prod stack`,
    });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "OpsTaskDefinition", { value: opsTd.family });
    new CfnOutput(this, "OpsSubnets", { value: vpc.privateSubnets.map((s) => s.subnetId).join(",") });
    new CfnOutput(this, "OpsSecurityGroup", { value: data.opsSg.securityGroupId });
    new CfnOutput(this, "OpsLogGroup", { value: opsLogs.logGroupName });
  }
}
