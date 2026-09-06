# Fider source is pinned; the small, published patch adds the existing Ghost
# mail bridge endpoint and account deletion by the owning OAuth identity.
FROM golang:1.25-bookworm AS source
WORKDIR /source
RUN git clone https://github.com/getfider/fider.git . \
    && git checkout f164f69172002aba6296980c27160a196191dbd6
COPY forkluck.patch /tmp/forkluck.patch
RUN git apply /tmp/forkluck.patch

FROM source AS source_archive
COPY Dockerfile /source/Dockerfile.forkluck
COPY forkluck.patch /source/forkluck.patch
RUN tar --exclude=.git -czf /tmp/forkluck-fider-source.tar.gz -C /source .

FROM source AS server
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOMAXPROCS=2 go build -p 2 -ldflags '-s -w -X github.com/getfider/fider/app/pkg/env.commithash=f164f69172002aba6296980c27160a196191dbd6-forkluck -X github.com/getfider/fider/app/pkg/env.version=forkluck' -o fider .

FROM node:22-bookworm AS ui
WORKDIR /ui
COPY --from=source /source/package.json /source/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --maxsockets 2
COPY --from=source /source ./
RUN make build-ssr && make build-ui

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /source/fider /source/LICENSE ./
COPY --from=source /source/migrations ./migrations
COPY --from=source /source/views ./views
COPY --from=source /source/static ./static
COPY --from=source_archive /tmp/forkluck-fider-source.tar.gz ./static/forkluck-fider-source.tar.gz
COPY --from=ui /ui/locale ./locale
COPY --from=ui /ui/dist ./dist
COPY --from=ui /ui/robots.txt /ui/ssr.js ./
# The Forkluck mark from the marketing site; Fider resizes it per request.
COPY favicon.png ./favicon.png
EXPOSE 3000
HEALTHCHECK --timeout=5s CMD ./fider ping
CMD ["sh", "-c", "./fider migrate && exec ./fider"]
