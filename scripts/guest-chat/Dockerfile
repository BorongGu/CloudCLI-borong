FROM ubuntu:22.04
COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i s,http://,https://,g /etc/apt/sources.list && apt-get -o Acquire::https::Timeout=20 -o Acquire::Retries=1 update && apt-get install -y --no-install-recommends ca-certificates iptables util-linux && rm -rf /var/lib/apt/lists/*
COPY node codex /usr/local/bin/
COPY guest.mjs guest-egress.mjs /app/
COPY public /app/public
COPY entrypoint.sh /usr/local/bin/guest-entry
RUN chmod -R a+rX /app && chmod 755 /usr/local/bin/guest-entry /usr/local/bin/node /usr/local/bin/codex && mkdir -p /workspace /home/guest && chown 1000:1000 /workspace /home/guest
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/guest-entry"]
