import { Fn } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import type { Construct } from "constructs";
import { settings } from "./settings.js";

/**
 * The account's shared platform, which every FigBloom app plugs into (HR, CRM, Fleet, Platform, the self-hosted
 * Supabase). It is owned by other stacks; this app only READS their CloudFormation exports. They were read from
 * the live account on 2026-11-24 (`aws cloudformation list-exports`). While this app imports them, CloudFormation
 * refuses to delete or change them, which is how the other apps already hold them.
 *
 *   Network-prod  one VPC (10.20.0.0/16), public and private subnets in eu-west-1a/b, one NAT gateway
 *   Edge-prod     one internet-facing load balancer; HTTPS:443 answers 404 unless an app's host rule matches,
 *                 HTTP:80 redirects to HTTPS; idle timeout 120 s
 */
const exportsOf = {
  vpcId: "Network-prod:ExportsOutputRefVpc8378EB38272D6E3A",
  privateSubnets: [
    "Network-prod:ExportsOutputRefVpcprivateSubnet1SubnetCEAD37168693D373", // eu-west-1a, 10.20.4.0/22
    "Network-prod:ExportsOutputRefVpcprivateSubnet2Subnet2DE7549CDF5ACE3D", // eu-west-1b, 10.20.8.0/22
  ],
  edgeHttpsListener: "Edge-prod:ExportsOutputRefLbHttpsFC95E725FABF72B9",
  edgeSecurityGroup: "Edge-prod:ExportsOutputFnGetAttLbSecurityGroup89A8258DGroupId639A5917",
} as const;

/** The shared VPC with its two private subnets (outbound internet through the shared NAT gateway). */
export function sharedVpc(scope: Construct): ec2.IVpc {
  return ec2.Vpc.fromVpcAttributes(scope, "SharedVpc", {
    vpcId: Fn.importValue(exportsOf.vpcId),
    vpcCidrBlock: settings.platform.vpcCidr,
    availabilityZones: [...settings.platform.availabilityZones],
    privateSubnetIds: exportsOf.privateSubnets.map((name) => Fn.importValue(name)),
  });
}

/** The shared load balancer's security group (immutable: this app never edits it). */
export function edgeSecurityGroup(scope: Construct): ec2.ISecurityGroup {
  return ec2.SecurityGroup.fromSecurityGroupId(scope, "EdgeLbSg", Fn.importValue(exportsOf.edgeSecurityGroup), { mutable: false });
}

/** The shared load balancer's HTTPS listener. Apps add a certificate and a host rule to it. */
export function edgeHttpsListener(scope: Construct, securityGroup: ec2.ISecurityGroup): elbv2.IApplicationListener {
  return elbv2.ApplicationListener.fromApplicationListenerAttributes(scope, "EdgeHttps", {
    listenerArn: Fn.importValue(exportsOf.edgeHttpsListener),
    securityGroup,
  });
}
