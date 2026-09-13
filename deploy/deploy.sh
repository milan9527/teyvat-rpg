#!/usr/bin/env bash
# Deploy Teyvat Online to AWS, resource by resource, with the AWS CLI — no CloudFormation.
#
#   ./deploy/deploy.sh              # everything, in order (first run ~15 min, mostly RDS)
#   ./deploy/deploy.sh net          # vpc, subnets, routing, security groups
#   ./deploy/deploy.sh data         # secrets, RDS Postgres, ElastiCache Redis (starts them)
#   ./deploy/deploy.sh image        # build + push the arm64 server image to ECR
#   ./deploy/deploy.sh alb          # load balancer, target group, listener
#   ./deploy/deploy.sh ecs          # roles, log group, cluster, task definition, service
#   ./deploy/deploy.sh cdn          # S3 bucket, origin access control, CloudFront distribution
#   ./deploy/deploy.sh web          # build the client, sync to S3, invalidate the edge
#   ./deploy/deploy.sh smoke        # assert the live deployment from outside
#   ./deploy/deploy.sh redeploy     # new image -> new task definition -> restart the service
#   ./deploy/deploy.sh state|logs   # what exists / the server's CloudWatch logs
#   CONFIRM=yes ./deploy/deploy.sh down    # delete all of it (including the database)
#
# Every created id is appended to `deploy/.aws-state`, and every step is skipped when its id is
# already in there. That file is what makes this script re-runnable: without it a second run
# would either fail on duplicate names or quietly build a second VPC. It is the state that
# CloudFormation would have kept for us — treat it as precious, and if you delete it by hand,
# delete the resources too (`down` reads the same file).
#
# Layout:
#   CloudFront (default *.cloudfront.net domain, AWS certificate)
#     ├── default behaviour  -> S3 bucket (private, read via OAC) — the Vite bundle
#     └── /api/*, /ws*       -> ALB :80 -> Fargate task :8787 — REST + the WebSocket gateway
#   the task (public subnet, public IP, no NAT) -> RDS Postgres + ElastiCache Redis (private)
#
# One task, on purpose: the world simulation is authoritative and in-process, so two tasks are
# two different worlds and players would stop seeing each other. Deployments therefore replace
# the task rather than rolling over it (~1 min of downtime), which is the honest trade for a
# single-writer simulation.
set -euo pipefail

REGION=${AWS_REGION:-us-east-1}
NAME=${NAME:-teyvat}
REPO=${REPO:-teyvat-server}
AZ1=${AZ1:-${REGION}a}
AZ2=${AZ2:-${REGION}b}
# AWS-managed prefix list "com.amazonaws.global.cloudfront.origin-facing": the ALB accepts
# traffic only from CloudFront, so the distribution is the single front door and nobody can
# bypass the edge (or the HTTPS redirect) by hitting the load balancer's own DNS name.
CF_PREFIX_LIST=${CF_PREFIX_LIST:-pl-3b927c52}
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
STATE="$ROOT/deploy/.aws-state"
touch "$STATE"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }
aws_() { aws --region "$REGION" --output text "$@"; }
awsj() { aws --region "$REGION" --output json "$@"; }

recall()   { grep -m1 "^$1=" "$STATE" 2>/dev/null | cut -d= -f2- || true; }
remember() { sed -i "/^$1=/d" "$STATE"; printf '%s=%s\n' "$1" "$2" >> "$STATE"; info "$1 = $2"; }
need()     { local v; v=$(recall "$1"); [ -n "$v" ] || die "missing $1 — run an earlier step"; echo "$v"; }

# once KEY cmd... — run the command only if KEY is not already known, and store its stdout.
once() {
  local k=$1; shift
  local have; have=$(recall "$k")
  if [ -n "$have" ]; then info "$k = $have (exists)"; return 0; fi
  local out
  out=$("$@") || die "$k: command failed"
  [ -n "$out" ] || die "$k: command produced no id"
  remember "$k" "$out"
}
# done_once KEY cmd... — for side effects with no id (attributes, ingress rules, attachments).
done_once() {
  local k=$1; shift
  [ -n "$(recall "$k")" ] && { info "$k (done)"; return 0; }
  "$@" >/dev/null || die "$k: command failed"
  remember "$k" yes
}

preflight() {
  command -v aws >/dev/null || die "aws cli not found"
  ACCOUNT=$(aws_ sts get-caller-identity --query Account) || die "no AWS credentials"
  REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
  BUCKET=${BUCKET:-$NAME-web-$ACCOUNT-$REGION}
}

# ================================================================================== network ==
net() {
  preflight
  say "network"
  once VPC aws_ ec2 create-vpc --cidr-block 10.80.0.0/16 \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=$NAME}]" --query Vpc.VpcId
  local vpc; vpc=$(need VPC)
  done_once VPC_DNS aws_ ec2 modify-vpc-attribute --vpc-id "$vpc" --enable-dns-hostnames

  once IGW aws_ ec2 create-internet-gateway \
    --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=$NAME}]" \
    --query InternetGateway.InternetGatewayId
  done_once IGW_ATTACHED aws_ ec2 attach-internet-gateway --vpc-id "$vpc" --internet-gateway-id "$(need IGW)"

  subnet() {  # subnet KEY cidr az name
    once "$1" aws_ ec2 create-subnet --vpc-id "$vpc" --cidr-block "$2" --availability-zone "$3" \
      --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$4}]" --query Subnet.SubnetId
  }
  # Public: the ALB and the task. The task needs a public IP to reach ECR, Secrets Manager and
  # CloudWatch; a NAT gateway would be the alternative at ~$32/month for the same three calls.
  subnet PUB_A 10.80.0.0/20  "$AZ1" "$NAME-public-a"
  subnet PUB_B 10.80.16.0/20 "$AZ2" "$NAME-public-b"
  # Private: Postgres and Redis, with no route off the VPC at all.
  subnet PRIV_A 10.80.32.0/20 "$AZ1" "$NAME-private-a"
  subnet PRIV_B 10.80.48.0/20 "$AZ2" "$NAME-private-b"

  once RTB aws_ ec2 create-route-table --vpc-id "$vpc" \
    --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=$NAME-public}]" \
    --query RouteTable.RouteTableId
  local rtb; rtb=$(need RTB)
  done_once RTB_ROUTE aws_ ec2 create-route --route-table-id "$rtb" \
    --destination-cidr-block 0.0.0.0/0 --gateway-id "$(need IGW)"
  local i=0
  for k in PUB_A PUB_B; do
    i=$((i + 1))
    done_once "RTB_ASSOC_$i" aws_ ec2 associate-route-table --route-table-id "$rtb" --subnet-id "$(need $k)"
    done_once "PUBIP_$i" aws_ ec2 modify-subnet-attribute --subnet-id "$(need $k)" --map-public-ip-on-launch
  done

  say "security groups"
  sg() {  # sg KEY name description  (ASCII only: EC2 rejects non-ASCII descriptions)
    once "$1" aws_ ec2 create-security-group --vpc-id "$vpc" --group-name "$2" \
      --description "$3" --query GroupId
  }
  sg SG_ALB   "$NAME-alb"   "$NAME ALB - CloudFront only"
  sg SG_TASK  "$NAME-task"  "$NAME server task"
  sg SG_DB    "$NAME-db"    "$NAME postgres"
  sg SG_REDIS "$NAME-redis" "$NAME redis"
  done_once SG_ALB_IN aws_ ec2 authorize-security-group-ingress --group-id "$(need SG_ALB)" \
    --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,PrefixListIds=[{PrefixListId=$CF_PREFIX_LIST,Description=cloudfront}]"
  done_once SG_TASK_IN aws_ ec2 authorize-security-group-ingress --group-id "$(need SG_TASK)" \
    --ip-permissions "IpProtocol=tcp,FromPort=8787,ToPort=8787,UserIdGroupPairs=[{GroupId=$(need SG_ALB),Description=alb}]"
  done_once SG_DB_IN aws_ ec2 authorize-security-group-ingress --group-id "$(need SG_DB)" \
    --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$(need SG_TASK),Description=task}]"
  done_once SG_REDIS_IN aws_ ec2 authorize-security-group-ingress --group-id "$(need SG_REDIS)" \
    --ip-permissions "IpProtocol=tcp,FromPort=6379,ToPort=6379,UserIdGroupPairs=[{GroupId=$(need SG_TASK),Description=task}]"
}

# ===================================================================== secrets, rds, redis ==
secrets() {
  preflight
  say "secrets"
  # Hex, so nothing in the password needs percent-encoding when `entrypoint.sh` interpolates it
  # into postgres://user:pass@host/db.
  mk_secret() {  # mk_secret KEY name value
    local k=$1 n=$2 v=$3 arn
    [ -n "$(recall "$k")" ] && { info "$k = $(recall "$k") (exists)"; return 0; }
    if arn=$(aws_ secretsmanager create-secret --name "$n" --secret-string "$v" --query ARN 2>/dev/null); then
      remember "$k" "$arn"; return 0
    fi
    # A previous teardown leaves the name in a 7-30 day recovery window; reuse it rather than
    # inventing a second name that the next `down` would not know about.
    arn=$(aws_ secretsmanager describe-secret --secret-id "$n" --query ARN) \
      || die "$k: cannot create or find secret $n"
    aws_ secretsmanager restore-secret --secret-id "$n" >/dev/null 2>&1 || true
    aws_ secretsmanager put-secret-value --secret-id "$n" --secret-string "$v" >/dev/null
    remember "$k" "$arn"
  }
  mk_secret DB_SECRET  "$NAME/db"  "{\"username\":\"$NAME\",\"password\":\"$(openssl rand -hex 20)\"}"
  mk_secret JWT_SECRET "$NAME/jwt" "$(openssl rand -hex 32)"
}

data() {
  preflight
  secrets
  local pw
  pw=$(aws_ secretsmanager get-secret-value --secret-id "$(need DB_SECRET)" --query SecretString \
       | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])')

  say "postgres"
  once DB_SUBNETS aws_ rds create-db-subnet-group --db-subnet-group-name "$NAME-db" \
    --db-subnet-group-description "$NAME private subnets" \
    --subnet-ids "$(need PRIV_A)" "$(need PRIV_B)" --query DBSubnetGroup.DBSubnetGroupName
  once DB_ID aws_ rds create-db-instance \
    --db-instance-identifier "$NAME-pg" --engine postgres --engine-version 17.6 \
    --db-instance-class "${DB_CLASS:-db.t4g.micro}" \
    --allocated-storage 20 --storage-type gp3 --storage-encrypted \
    --master-username "$NAME" --master-user-password "$pw" --db-name "$NAME" \
    --db-subnet-group-name "$(need DB_SUBNETS)" --vpc-security-group-ids "$(need SG_DB)" \
    --no-publicly-accessible --no-multi-az --backup-retention-period 1 \
    --no-deletion-protection --copy-tags-to-snapshot \
    --query DBInstance.DBInstanceIdentifier

  say "redis"
  once REDIS_SUBNETS aws_ elasticache create-cache-subnet-group --cache-subnet-group-name "$NAME" \
    --cache-subnet-group-description "$NAME private subnets" \
    --subnet-ids "$(need PRIV_A)" "$(need PRIV_B)" --query CacheSubnetGroup.CacheSubnetGroupName
  once REDIS_ID aws_ elasticache create-cache-cluster --cache-cluster-id "$NAME-redis" \
    --engine redis --engine-version 7.1 --cache-node-type "${CACHE_CLASS:-cache.t4g.micro}" \
    --num-cache-nodes 1 --az-mode single-az \
    --cache-subnet-group-name "$(need REDIS_SUBNETS)" --security-group-ids "$(need SG_REDIS)" \
    --query CacheCluster.CacheClusterId
  info "both are provisioning in the background (RDS ~8 min); 'endpoints' waits for them"
}

endpoints() {
  say "waiting for the data layer"
  aws --region "$REGION" rds wait db-instance-available --db-instance-identifier "$(need DB_ID)"
  aws --region "$REGION" elasticache wait cache-cluster-available --cache-cluster-id "$(need REDIS_ID)"
  remember DB_HOST "$(aws_ rds describe-db-instances --db-instance-identifier "$(need DB_ID)" \
    --query 'DBInstances[0].Endpoint.Address')"
  remember REDIS_HOST "$(aws_ elasticache describe-cache-clusters --cache-cluster-id "$(need REDIS_ID)" \
    --show-cache-node-info --query 'CacheClusters[0].CacheNodes[0].Endpoint.Address')"
}

# ==================================================================================== image ==
image() {
  preflight
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "docker daemon unreachable"
  # Fargate ARM is ~20% cheaper and this box is aarch64, so the build is native. On x86 this
  # would need buildx + qemu; refuse rather than push an image that dies inside RunTask.
  [ "$(uname -m)" = aarch64 ] || die "host is $(uname -m): build with 'docker buildx build --platform linux/arm64 --push'"
  aws_ ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 || {
    say "creating ECR repository $REPO"
    aws_ ecr create-repository --repository-name "$REPO" \
      --image-scanning-configuration scanOnPush=true >/dev/null
  }
  local tag uri
  tag=$(date -u +%Y%m%d-%H%M%S)
  uri="$REGISTRY/$REPO:$tag"
  say "building $uri (linux/arm64)"
  docker build --platform linux/arm64 -f "$ROOT/deploy/Dockerfile" -t "$uri" "$ROOT"
  aws_ ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  docker push "$uri"
  # A timestamp tag, never `latest`: the task definition has to *change* for ECS to start a new
  # task, and a moving tag leaves the service on old code with no diff to see.
  remember IMAGE "$uri"
}

# ====================================================================================== alb ==
alb() {
  preflight
  say "load balancer"
  once ALB_ARN aws_ elbv2 create-load-balancer --name "$NAME-alb" --type application \
    --scheme internet-facing --subnets "$(need PUB_A)" "$(need PUB_B)" \
    --security-groups "$(need SG_ALB)" --query 'LoadBalancers[0].LoadBalancerArn'
  remember ALB_DNS "$(aws_ elbv2 describe-load-balancers --load-balancer-arns "$(need ALB_ARN)" \
    --query 'LoadBalancers[0].DNSName')"
  # A client sitting in a menu sends nothing; the default 60 s idle timeout would cut its socket.
  done_once ALB_IDLE aws_ elbv2 modify-load-balancer-attributes --load-balancer-arn "$(need ALB_ARN)" \
    --attributes Key=idle_timeout.timeout_seconds,Value=300
  once TG_ARN aws_ elbv2 create-target-group --name "$NAME-tg" --protocol HTTP --port 8787 \
    --vpc-id "$(need VPC)" --target-type ip --health-check-path /api/health \
    --health-check-interval-seconds 15 --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn'
  done_once TG_DRAIN aws_ elbv2 modify-target-group-attributes --target-group-arn "$(need TG_ARN)" \
    --attributes Key=deregistration_delay.timeout_seconds,Value=10
  once LISTENER aws_ elbv2 create-listener --load-balancer-arn "$(need ALB_ARN)" \
    --protocol HTTP --port 80 \
    --default-actions "Type=forward,TargetGroupArn=$(need TG_ARN)" \
    --query 'Listeners[0].ListenerArn'
}

# ====================================================================================== ecs ==
roles() {
  preflight
  say "iam"
  local trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  once EXEC_ROLE aws_ iam create-role --role-name "$NAME-exec" \
    --assume-role-policy-document "$trust" --query Role.Arn
  done_once EXEC_ROLE_MANAGED aws_ iam attach-role-policy --role-name "$NAME-exec" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  # The execution role pulls the image and writes logs (managed policy above) and reads exactly
  # these two secrets — the password and the session key — and nothing else in the account.
  done_once EXEC_ROLE_SECRETS aws_ iam put-role-policy --role-name "$NAME-exec" \
    --policy-name read-own-secrets --policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":[\"$(need DB_SECRET)\",\"$(need JWT_SECRET)\"]}]}"
  # The server itself calls no AWS API — it talks to Postgres and Redis over the network — so
  # there is no task role at all. Nothing to grant is better than an empty role to grow.
}

taskdef() {
  preflight
  local img; img=$(need IMAGE)
  local json=/tmp/$NAME-taskdef.json
  cat > "$json" <<JSON
{
  "family": "$NAME-server",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "${TASK_CPU:-512}",
  "memory": "${TASK_MEM:-1024}",
  "runtimePlatform": { "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "$(need EXEC_ROLE)",
  "containerDefinitions": [{
    "name": "server",
    "image": "$img",
    "essential": true,
    "portMappings": [{ "containerPort": 8787, "protocol": "tcp" }],
    "environment": [
      { "name": "NODE_ENV",  "value": "production" },
      { "name": "PORT",      "value": "8787" },
      { "name": "HOST",      "value": "0.0.0.0" },
      { "name": "DB_HOST",   "value": "$(need DB_HOST)" },
      { "name": "DB_PORT",   "value": "5432" },
      { "name": "DB_NAME",   "value": "$NAME" },
      { "name": "DB_USER",   "value": "$NAME" },
      { "name": "REDIS_URL", "value": "redis://$(need REDIS_HOST):6379" }
    ],
    "secrets": [
      { "name": "DB_PASSWORD", "valueFrom": "$(need DB_SECRET):password::" },
      { "name": "JWT_SECRET",  "valueFrom": "$(need JWT_SECRET)" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/$NAME",
        "awslogs-region": "$REGION",
        "awslogs-stream-prefix": "server"
      }
    }
  }]
}
JSON
  # The assembled DATABASE_URL is never stored anywhere: `entrypoint.sh` composes it at start
  # from these plain endpoints plus the injected password, so no API reply ever prints it.
  remember TASKDEF "$(aws_ ecs register-task-definition --cli-input-json "file://$json" \
    --query 'taskDefinition.taskDefinitionArn')"
}

ecs() {
  preflight
  roles
  say "logs and cluster"
  done_once LOG_GROUP aws_ logs create-log-group --log-group-name "/ecs/$NAME"
  done_once LOG_RETENTION aws_ logs put-retention-policy --log-group-name "/ecs/$NAME" --retention-in-days 14
  once CLUSTER aws_ ecs create-cluster --cluster-name "$NAME" --query 'cluster.clusterName'
  [ -n "$(recall DB_HOST)" ] && [ -n "$(recall REDIS_HOST)" ] || endpoints
  taskdef

  say "service"
  if [ -n "$(recall SERVICE)" ]; then
    info "SERVICE = $(recall SERVICE) (exists) — use 'redeploy' to roll a new image"
  else
    remember SERVICE "$(aws_ ecs create-service --cluster "$(need CLUSTER)" \
      --service-name "$NAME-server" --task-definition "$(need TASKDEF)" \
      --desired-count 1 --launch-type FARGATE \
      --deployment-configuration 'minimumHealthyPercent=0,maximumPercent=100' \
      --health-check-grace-period-seconds 120 \
      --network-configuration "awsvpcConfiguration={subnets=[$(need PUB_A),$(need PUB_B)],securityGroups=[$(need SG_TASK)],assignPublicIp=ENABLED}" \
      --load-balancers "targetGroupArn=$(need TG_ARN),containerName=server,containerPort=8787" \
      --query 'service.serviceName')"
  fi
  wait_stable
}

wait_stable() {
  say "waiting for the task to boot and pass its health checks"
  # The service existing is not the server running: the task still has to pull the image, run
  # initSchema() against a cold Postgres and answer two health checks 15 s apart.
  aws --region "$REGION" ecs wait services-stable --cluster "$(need CLUSTER)" --services "$(need SERVICE)" \
    || die "the service did not stabilise — './deploy/deploy.sh logs' will say why"
  aws_ elbv2 describe-target-health --target-group-arn "$(need TG_ARN)" \
    --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]'
}

redeploy() {
  image
  taskdef
  aws_ ecs update-service --cluster "$(need CLUSTER)" --service "$(need SERVICE)" \
    --task-definition "$(need TASKDEF)" --query 'service.serviceName' >/dev/null
  wait_stable
}

# ====================================================================================== cdn ==
cdn() {
  preflight
  say "s3 bucket $BUCKET"
  if ! aws_ s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
    aws_ s3api create-bucket --bucket "$BUCKET" >/dev/null   # us-east-1 takes no LocationConstraint
  fi
  remember BUCKET "$BUCKET"
  aws_ s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' >/dev/null
  aws_ s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null

  say "origin access control"
  once OAC aws_ cloudfront create-origin-access-control --origin-access-control-config \
    "Name=$NAME,Description=$NAME bundle,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
    --query OriginAccessControl.Id

  say "distribution"
  if [ -z "$(recall CDN_ID)" ]; then
    local cfg=/tmp/$NAME-cdn.json
    # Managed policy ids: CachingOptimized for the bundle, CachingDisabled +
    # AllViewerExceptHostHeader for the gateway (the origin request policy is what carries the
    # Upgrade/Connection/Sec-WebSocket-* headers through, and dropping Host lets the ALB route).
    #
    # No CustomErrorResponses on purpose. The usual SPA "403/404 -> /index.html 200" rewrite
    # applies to *every* behaviour, including the ALB ones, so every API 401/404 would come back
    # as an HTML page with status 200. The client is one page at / with no client-side routes.
    cat > "$cfg" <<JSON
{
  "CallerReference": "$NAME-$(date -u +%s)",
  "Comment": "Teyvat Online",
  "Enabled": true,
  "HttpVersion": "http2and3",
  "IsIPV6Enabled": true,
  "DefaultRootObject": "index.html",
  "PriceClass": "PriceClass_All",
  "Aliases": { "Quantity": 0 },
  "Origins": {
    "Quantity": 2,
    "Items": [
      {
        "Id": "s3",
        "DomainName": "$BUCKET.s3.$REGION.amazonaws.com",
        "OriginAccessControlId": "$(need OAC)",
        "S3OriginConfig": { "OriginAccessIdentity": "" },
        "OriginPath": "",
        "CustomHeaders": { "Quantity": 0 }
      },
      {
        "Id": "alb",
        "DomainName": "$(need ALB_DNS)",
        "OriginPath": "",
        "CustomHeaders": { "Quantity": 0 },
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "http-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
          "OriginReadTimeout": 60,
          "OriginKeepaliveTimeout": 60
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] } },
    "Compress": true,
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6"
  },
  "CacheBehaviors": {
    "Quantity": 2,
    "Items": [
      {
        "PathPattern": "/ws*",
        "TargetOriginId": "alb",
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": { "Quantity": 7,
          "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] } },
        "Compress": false,
        "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac"
      },
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "alb",
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": { "Quantity": 7,
          "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] } },
        "Compress": true,
        "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac"
      }
    ]
  },
  "ViewerCertificate": { "CloudFrontDefaultCertificate": true },
  "Restrictions": { "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 } }
}
JSON
    local out
    out=$(awsj cloudfront create-distribution --distribution-config "file://$cfg")
    remember CDN_ID     "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Distribution"]["Id"])')"
    remember CDN_DOMAIN "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Distribution"]["DomainName"])')"
  else
    info "CDN_ID = $(recall CDN_ID) (exists)"
  fi

  # Only this distribution may read the bucket. Written after the distribution exists, because
  # the condition names its ARN.
  aws_ s3api put-bucket-policy --bucket "$BUCKET" --policy \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"arn:aws:cloudfront::$ACCOUNT:distribution/$(need CDN_ID)\"}}}]}" >/dev/null
  info "site: https://$(need CDN_DOMAIN)"
}

# ====================================================================================== web ==
web() {
  preflight
  local bucket dist; bucket=$(need BUCKET); dist="$ROOT/client/dist"
  say "building the client bundle"
  npm --prefix "$ROOT/client" run build
  say "syncing to s3://$bucket"
  # Two passes: everything Vite fingerprints can be immutable for a year, but index.html names
  # those files — cache it and the browser keeps asking for the chunks this sync just deleted.
  aws --region "$REGION" s3 sync "$dist" "s3://$bucket" --delete --exclude index.html \
    --cache-control 'public,max-age=31536000,immutable'
  aws --region "$REGION" s3 cp "$dist/index.html" "s3://$bucket/index.html" \
    --cache-control 'no-cache' --content-type 'text/html; charset=utf-8'
  say "invalidating the edge"
  aws_ cloudfront create-invalidation --distribution-id "$(need CDN_ID)" --paths '/*' \
    --query 'Invalidation.Id'
}

smoke() {
  say "smoke test"
  WEB_BUCKET=$(recall BUCKET) node "$ROOT/deploy/smoke.mjs" "https://$(need CDN_DOMAIN)"
}

state() { say "deploy/.aws-state"; cat "$STATE"; }
logs()  { aws --region "$REGION" logs tail "/ecs/$NAME" --since "${SINCE:-15m}" ${FOLLOW:+--follow}; }

# ===================================================================================== down ==
down() {
  preflight
  [ "${CONFIRM:-}" = yes ] || die "refusing without CONFIRM=yes (this deletes the database)"
  say "deleting, in reverse order"
  # Reverse order matters: a security group cannot be deleted while something uses it, and the
  # VPC cannot go while any of its members remain.
  [ -n "$(recall SERVICE)" ] && aws_ ecs update-service --cluster "$(recall CLUSTER)" \
    --service "$(recall SERVICE)" --desired-count 0 >/dev/null 2>&1 || true
  [ -n "$(recall SERVICE)" ] && aws_ ecs delete-service --cluster "$(recall CLUSTER)" \
    --service "$(recall SERVICE)" --force >/dev/null 2>&1 || true
  [ -n "$(recall CLUSTER)" ] && aws_ ecs delete-cluster --cluster "$(recall CLUSTER)" >/dev/null 2>&1 || true
  if [ -n "$(recall CDN_ID)" ]; then
    info "disabling the distribution (CloudFront needs it disabled before deletion; ~15 min)"
    local etag cfg
    cfg=$(awsj cloudfront get-distribution-config --id "$(recall CDN_ID)")
    etag=$(printf '%s' "$cfg" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ETag"])')
    printf '%s' "$cfg" | python3 -c '
import json,sys
d=json.load(sys.stdin)["DistributionConfig"]; d["Enabled"]=False
print(json.dumps(d))' > /tmp/$NAME-cdn-off.json
    aws_ cloudfront update-distribution --id "$(recall CDN_ID)" --if-match "$etag" \
      --distribution-config "file:///tmp/$NAME-cdn-off.json" >/dev/null 2>&1 || true
    info "when it says Deployed: aws cloudfront delete-distribution --id $(recall CDN_ID) --if-match <etag>"
  fi
  [ -n "$(recall BUCKET)" ] && aws --region "$REGION" s3 rm "s3://$(recall BUCKET)" --recursive >/dev/null 2>&1 || true
  [ -n "$(recall BUCKET)" ] && aws_ s3api delete-bucket --bucket "$(recall BUCKET)" >/dev/null 2>&1 || true
  [ -n "$(recall LISTENER)" ] && aws_ elbv2 delete-listener --listener-arn "$(recall LISTENER)" >/dev/null 2>&1 || true
  [ -n "$(recall ALB_ARN)" ] && aws_ elbv2 delete-load-balancer --load-balancer-arn "$(recall ALB_ARN)" >/dev/null 2>&1 || true
  sleep 20
  [ -n "$(recall TG_ARN)" ] && aws_ elbv2 delete-target-group --target-group-arn "$(recall TG_ARN)" >/dev/null 2>&1 || true
  [ -n "$(recall DB_ID)" ] && aws_ rds delete-db-instance --db-instance-identifier "$(recall DB_ID)" \
    --skip-final-snapshot >/dev/null 2>&1 || true
  [ -n "$(recall REDIS_ID)" ] && aws_ elasticache delete-cache-cluster --cache-cluster-id "$(recall REDIS_ID)" >/dev/null 2>&1 || true
  aws_ iam delete-role-policy --role-name "$NAME-exec" --policy-name read-own-secrets >/dev/null 2>&1 || true
  aws_ iam detach-role-policy --role-name "$NAME-exec" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy >/dev/null 2>&1 || true
  aws_ iam delete-role --role-name "$NAME-exec" >/dev/null 2>&1 || true
  for s in "$(recall DB_SECRET)" "$(recall JWT_SECRET)"; do
    [ -n "$s" ] && aws_ secretsmanager delete-secret --secret-id "$s" \
      --recovery-window-in-days 7 >/dev/null 2>&1 || true
  done
  info "RDS and ElastiCache take several minutes to disappear; the VPC cannot be deleted until"
  info "they and the ALB are gone. Re-run 'down' afterwards to finish the network, or:"
  info "  aws ec2 delete-subnet/delete-route-table/detach-internet-gateway/delete-vpc"
  aws_ rds wait db-instance-deleted --db-instance-identifier "$(recall DB_ID)" 2>/dev/null || true
  for k in PUB_A PUB_B PRIV_A PRIV_B; do
    [ -n "$(recall $k)" ] && aws_ ec2 delete-subnet --subnet-id "$(recall $k)" >/dev/null 2>&1 || true
  done
  [ -n "$(recall RTB)" ] && aws_ ec2 delete-route-table --route-table-id "$(recall RTB)" >/dev/null 2>&1 || true
  [ -n "$(recall IGW)" ] && aws_ ec2 detach-internet-gateway --internet-gateway-id "$(recall IGW)" \
    --vpc-id "$(recall VPC)" >/dev/null 2>&1 || true
  [ -n "$(recall IGW)" ] && aws_ ec2 delete-internet-gateway --internet-gateway-id "$(recall IGW)" >/dev/null 2>&1 || true
  for k in SG_ALB SG_TASK SG_DB SG_REDIS; do
    [ -n "$(recall $k)" ] && aws_ ec2 delete-security-group --group-id "$(recall $k)" >/dev/null 2>&1 || true
  done
  [ -n "$(recall VPC)" ] && aws_ ec2 delete-vpc --vpc-id "$(recall VPC)" >/dev/null 2>&1 || true
  info "done (best effort). deploy/.aws-state kept so you can see what was there."
}

case "${1:-all}" in
  all)      net; data; image; alb; cdn; ecs; web; smoke ;;
  net)      net ;;
  secrets)  secrets ;;
  data)     data ;;
  endpoints) endpoints ;;
  image)    image ;;
  alb)      alb ;;
  ecs)      ecs ;;
  taskdef)  taskdef ;;
  cdn)      cdn ;;
  web)      web ;;
  smoke)    smoke ;;
  redeploy) redeploy ;;
  wait)     wait_stable ;;
  state)    state ;;
  logs)     logs ;;
  down)     down ;;
  *) die "unknown command '$1' (all|net|data|image|alb|ecs|cdn|web|smoke|redeploy|state|logs|down)" ;;
esac
