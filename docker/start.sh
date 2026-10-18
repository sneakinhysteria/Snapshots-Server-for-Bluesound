#!/bin/sh
# Starts the services shairport-sync needs (D-Bus, Avahi, NQPTP), then the app.
set -e

if [ -S /run/dbus/system_bus_socket ]; then
  # The host's D-Bus is mounted (-v /var/run/dbus:/var/run/dbus): register the AirPlay receivers
  # with the host's Avahi. A second mDNS responder on the same IP address (host networking)
  # fights the host's one over the address records and both keep renaming themselves.
  echo "Using the host's D-Bus/Avahi for AirPlay announcements"
else
  rm -rf /run/dbus/dbus.pid /run/avahi-daemon/pid
  dbus-uuidgen --ensure
  dbus-daemon --system
  # Announce on one interface only: on hosts where the LAN port is bridged (eth0 inside br0),
  # Avahi hears its own announcements twice. Default: the interface of the default route.
  IFACES="${AVAHI_INTERFACES:-$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')}"
  if [ -n "$IFACES" ]; then
    sed -i "s/^#\?allow-interfaces=.*/allow-interfaces=$IFACES/" /etc/avahi/avahi-daemon.conf
  fi
  sed -i "s/^#\?host-name=.*/host-name=${AVAHI_HOSTNAME:-snapshots-server-for-bluesound}/" /etc/avahi/avahi-daemon.conf
  avahi-daemon --daemonize --no-chroot
fi

(/usr/local/bin/nqptp > /dev/null 2>&1) &
exec node --disable-warning=ExperimentalWarning /app/src/server.ts
