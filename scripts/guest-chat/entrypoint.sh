#!/bin/sh
set -eu
# Set the namespace firewall before the application accepts any requests.
iptables -F OUTPUT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -d 172.31.251.3 -p tcp --dport 3128 -j ACCEPT
iptables -P OUTPUT DROP
# Node and every Codex child run as an unprivileged user with an empty capability set.
exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /usr/local/bin/node /app/guest.mjs
