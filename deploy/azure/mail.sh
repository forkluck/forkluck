#!/usr/bin/env bash
# Provisions the Forkluck email stack on Azure Communication Services.
# Every step is idempotent: rerun any subcommand safely.
set -euo pipefail

SUB=5e73a477-191d-4556-bcac-1e0d28910da9
RG=forkluck-mail
LOC=eastus
DATA_LOC=UnitedStates
ECS=forkluck-ecs
CS=forkluck-cs
DOMAIN=forkluck.com
STORAGE=forkluckmail
SEND_QUEUE=newsletter-send
EVENTS_QUEUE=mail-events
SMTP_APP=forkluck-ghost-smtp
SYSTEM_TOPIC="${CS}-events"
EVENT_SUB="${EVENTS_QUEUE}-sub"
DMARC_RUA=guero@forkluck.com

say() { printf '\n== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }

# The communication command group ships as an extension; install it without prompting.
ensure_extension() {
    az config set extension.use_dynamic_install=yes_without_prompt --only-show-errors >/dev/null
    az extension show --name communication >/dev/null 2>&1 ||
        az extension add --name communication --only-show-errors >/dev/null
}

domain_id() {
    az communication email domain show \
        --domain-name "$DOMAIN" --email-service-name "$ECS" -g "$RG" \
        --query id -o tsv
}

storage_id() {
    az storage account show --name "$STORAGE" -g "$RG" --query id -o tsv
}

cs_id() {
    az communication show --name "$CS" -g "$RG" --query id -o tsv
}

cmd_create() {
    az account set --subscription "$SUB"
    ensure_extension

    az group show -n "$RG" >/dev/null 2>&1 ||
        az group create -n "$RG" -l "$LOC" -o none

    # Email Service and Communication Service both live at location "global".
    az communication email show --name "$ECS" -g "$RG" >/dev/null 2>&1 ||
        az communication email create --name "$ECS" -g "$RG" \
            --location global --data-location "$DATA_LOC" -o none

    az communication show --name "$CS" -g "$RG" >/dev/null 2>&1 ||
        az communication create --name "$CS" -g "$RG" \
            --location global --data-location "$DATA_LOC" -o none

    say "Email service $ECS and communication service $CS ready in $RG."
}

cmd_domain() {
    az account set --subscription "$SUB"
    ensure_extension

    az communication email domain show \
        --domain-name "$DOMAIN" --email-service-name "$ECS" -g "$RG" >/dev/null 2>&1 ||
        az communication email domain create \
            --domain-name "$DOMAIN" --email-service-name "$ECS" -g "$RG" \
            --location global --domain-management CustomerManaged -o none

    say "DNS records to add in Cloudflare for $DOMAIN"
    # verificationRecords holds one array per record kind: Domain, SPF, DKIM, DKIM2.
    az communication email domain show \
        --domain-name "$DOMAIN" --email-service-name "$ECS" -g "$RG" \
        --query "verificationRecords.[Domain, SPF, DKIM, DKIM2][][].{name:name, type:type, value:value}" \
        -o table

    cat <<EOF

Recommended DMARC record (add manually, not returned by Azure):
  _dmarc  TXT  "v=DMARC1; p=none; rua=mailto:${DMARC_RUA}"

IMPORTANT: the apex SPF record must MERGE with the existing Cloudflare Email
Routing include rather than replace it. The apex TXT should end up as:
  v=spf1 include:_spf.mx.cloudflare.net include:spf.protection.outlook.com ~all

Once every record is live, run: $0 verify
EOF
}

cmd_verify() {
    az account set --subscription "$SUB"
    ensure_extension

    local kind
    for kind in Domain SPF DKIM DKIM2; do
        say "Initiating verification: $kind"
        az communication email domain initiate-verification \
            --domain-name "$DOMAIN" --email-service-name "$ECS" -g "$RG" \
            --verification-type "$kind" -o none || warn "initiate-verification $kind failed; continuing"
    done

    local deadline states
    deadline=$(( $(date +%s) + 900 ))  # 15 minutes
    while :; do
        states=$(az communication email domain show \
            --domain-name "$DOMAIN" --email-service-name "$ECS" -g "$RG" \
            --query "[verificationStates.Domain.status, verificationStates.SPF.status, verificationStates.DKIM.status, verificationStates.DKIM2.status]" \
            -o tsv)
        printf '%s  Domain/SPF/DKIM/DKIM2: %s\n' "$(date +%T)" "$(echo "$states" | tr '\n' ' ')"
        if [[ $(echo "$states" | grep -cx Verified) -eq 4 ]]; then
            say "All four records verified."
            return 0
        fi
        if [[ $(date +%s) -ge $deadline ]]; then
            warn "Timed out after 15 minutes; DNS may still be propagating. Rerun: $0 verify"
            return 1
        fi
        sleep 20
    done
}

cmd_senders() {
    az account set --subscription "$SUB"
    ensure_extension

    local user
    for user in no-reply noreply hello; do
        az communication email domain sender-username show \
            --sender-username "$user" --domain-name "$DOMAIN" \
            --email-service-name "$ECS" -g "$RG" >/dev/null 2>&1 ||
            az communication email domain sender-username create \
                --sender-username "$user" --domain-name "$DOMAIN" \
                --email-service-name "$ECS" -g "$RG" \
                --username "$user" --display-name "Forkluck" -o none
    done

    # VERIFY: this extension names the flag --user-engmnt-tracking (not
    # --user-engagement-tracking); older/newer builds may differ.
    az communication email domain update \
        --domain-name "$DOMAIN" --email-service-name "$ECS" -g "$RG" \
        --user-engmnt-tracking Enabled -o none

    az communication update --name "$CS" -g "$RG" \
        --linked-domains "$(domain_id)" -o none

    say "Senders no-reply/noreply/hello created; $DOMAIN linked to $CS."
}

cmd_bridge() {
    az account set --subscription "$SUB"
    ensure_extension

    az storage account show --name "$STORAGE" -g "$RG" >/dev/null 2>&1 ||
        az storage account create --name "$STORAGE" -g "$RG" -l "$LOC" \
            --sku Standard_LRS --allow-blob-public-access false \
            --min-tls-version TLS1_2 -o none

    local key queue
    key=$(az storage account keys list --account-name "$STORAGE" -g "$RG" \
        --query "[0].value" -o tsv)
    for queue in "$SEND_QUEUE" "$EVENTS_QUEUE"; do
        az storage queue create --name "$queue" \
            --account-name "$STORAGE" --account-key "$key" -o none
    done

    az eventgrid system-topic show --name "$SYSTEM_TOPIC" -g "$RG" >/dev/null 2>&1 ||
        az eventgrid system-topic create --name "$SYSTEM_TOPIC" -g "$RG" -l global \
            --topic-type Microsoft.Communication.CommunicationServices \
            --source "$(cs_id)" -o none

    az eventgrid system-topic event-subscription show \
        --name "$EVENT_SUB" --system-topic-name "$SYSTEM_TOPIC" -g "$RG" >/dev/null 2>&1 ||
        az eventgrid system-topic event-subscription create \
            --name "$EVENT_SUB" --system-topic-name "$SYSTEM_TOPIC" -g "$RG" \
            --endpoint-type storagequeue \
            --endpoint "$(storage_id)/queueservices/default/queues/${EVENTS_QUEUE}" \
            --included-event-types \
            Microsoft.Communication.EmailDeliveryReportReceived \
            Microsoft.Communication.EmailEngagementTrackingReportReceived -o none

    cat <<EOF

Storage account $STORAGE with queues $SEND_QUEUE and $EVENTS_QUEUE ready;
delivery + engagement events flow into $EVENTS_QUEUE.

Fetch AZURE_STORAGE_CONNECTION_STRING yourself when you need it:
  az storage account show-connection-string --name $STORAGE -g $RG --query connectionString -o tsv
EOF
}

cmd_smtp() {
    az account set --subscription "$SUB"
    ensure_extension

    local app_id tenant_id secret
    app_id=$(az ad app list --display-name "$SMTP_APP" --query "[0].appId" -o tsv)
    if [[ -z "$app_id" ]]; then
        app_id=$(az ad app create --display-name "$SMTP_APP" --query appId -o tsv)
    fi
    az ad sp show --id "$app_id" >/dev/null 2>&1 ||
        az ad sp create --id "$app_id" -o none

    tenant_id=$(az account show --query tenantId -o tsv)

    az role assignment create \
        --assignee "$app_id" \
        --role "Communication and Email Service Owner" \
        --scope "$(cs_id)" -o none

    secret=$(az ad app credential reset --id "$app_id" --years 2 \
        --display-name "ghost-smtp" --query password -o tsv)

    cat <<EOF

SMTP host:     smtp.azurecomm.net:587  (STARTTLS)
SMTP username: ${CS}|${app_id}|${tenant_id}
SMTP password: ${secret}

!! The password above is shown ONCE and cannot be retrieved again. Store it in
!! /opt/ghost/.env as ACS_SMTP_PASS now. Rerunning this step mints a new secret
!! and invalidates the old one.
EOF
}

cmd_keys() {
    az account set --subscription "$SUB"
    ensure_extension

    warn "Printing a live secret to stdout; do not paste this into a shared log."
    az communication list-key --name "$CS" -g "$RG" \
        --query primaryConnectionString -o tsv
}

cmd_all() {
    cmd_create
    cmd_domain
    cat <<EOF

STOP: add the DNS records above in Cloudflare (merging the apex SPF), then run:
  $0 verify
  $0 senders
  $0 bridge
  $0 smtp
EOF
}

case "${1:-}" in
    create) cmd_create ;;
    domain) cmd_domain ;;
    verify) cmd_verify ;;
    senders) cmd_senders ;;
    bridge) cmd_bridge ;;
    smtp) cmd_smtp ;;
    keys) cmd_keys ;;
    all) cmd_all ;;
    *)
        echo "usage: $0 {create|domain|verify|senders|bridge|smtp|keys|all}" >&2
        exit 2
        ;;
esac
