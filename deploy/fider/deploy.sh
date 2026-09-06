#!/usr/bin/env bash
# Build and release the feedback board on the Forkluck host.
#
#   deploy/fider/deploy.sh            sync this directory, build on the host, switch, verify
#   deploy/fider/deploy.sh rollback   switch back to the previously pinned image
#
# The image is built on the host (x86_64) from only this directory, then
# FIDER_IMAGE in the host's .env is pinned to the new immutable image ID, as
# the README requires. The previous pin is kept in .env.previous-image for
# rollback. The host's .env is otherwise never touched.
#   FEEDBACK_DEPLOY_HOST  ssh destination (default: chefclaw)
#   FEEDBACK_DIR          compose project on the host (default: /opt/forkluck-feedback)
set -euo pipefail

host="${FEEDBACK_DEPLOY_HOST:-chefclaw}"
dir="${FEEDBACK_DIR:-/opt/forkluck-feedback}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" "$@"; }

switch_to() {
    # $1: image reference to pin. Records the current pin first.
    remote "cd '$dir' && current=\$(grep -E '^FIDER_IMAGE=' .env | cut -d= -f2-) && \
        printf '%s\n' \"\$current\" > .env.previous-image && \
        sed -i -E 's|^FIDER_IMAGE=.*|FIDER_IMAGE=$1|' .env && docker compose up -d"
    remote "cd '$dir' && c=\$(docker compose ps -q feedback) && for i in \$(seq 1 40); do \
        st=\$(docker inspect --format '{{.State.Health.Status}}' \"\$c\" 2>/dev/null || echo none); \
        [ \"\$st\" = healthy ] && exit 0; sleep 3; done; echo 'feedback container not healthy' >&2; docker compose logs --tail 30 feedback; exit 1"
    remote "curl -s -o /dev/null -w 'local board -> %{http_code}\n' http://127.0.0.1:3004/"
}

case "${1:-deploy}" in
    deploy)
        if [[ -n "$(git -C "$repo_root" status --porcelain -- deploy/fider)" ]]; then
            echo "deploy/fider has uncommitted changes; deploy from a clean checkout." >&2
            exit 1
        fi
        commit="$(git -C "$repo_root" rev-parse --short HEAD)"
        tag="forkluck-feedback:$(date -u +%Y%m%d%H%M)-$commit"
        echo "Building $tag on $host from deploy/fider at $commit"

        # Build context only: the Dockerfile, the patch and the favicon.
        rsync -a --delete --include='Dockerfile' --include='forkluck.patch' --include='favicon.png' --exclude='*' \
            "$here/" "$host:$dir/build/"
        # Service files beside the compose project; the host's .env stays as is.
        rsync -a "$here/docker-compose.yml" "$here/bootstrap.py" "$here/backup.sh" "$host:$dir/"

        remote "docker build -q -t '$tag' '$dir/build' >/dev/null && docker image inspect --format '{{.Id}}' '$tag'" | tail -1 > /tmp/fider-image-id
        image_id="$(cat /tmp/fider-image-id)"
        echo "Built $tag ($image_id)"
        switch_to "$image_id"
        remote "cd '$dir' && docker compose exec -T feedback ./fider ping >/dev/null && echo 'fider ping ok'"
        echo "Released $tag. Roll back with: $0 rollback"
        ;;
    rollback)
        previous="$(remote "cat '$dir/.env.previous-image' 2>/dev/null" || true)"
        if [[ -z "$previous" ]]; then
            echo "No previous image recorded on $host." >&2; exit 1
        fi
        echo "Switching back to $previous"
        switch_to "$previous"
        echo "Rolled back."
        ;;
    *)
        echo "usage: $0 [deploy|rollback]" >&2; exit 2 ;;
esac
