set -e

#!/usr/bin/env bash

# Pre-flight: fail fast if another bisonw instance is already holding the
# DB lock. Without this check, bisonw waits ~3s (bbolt lock timeout in
# client/db/bolt.dbLockTimeout) and then fails. As of 2026-04-19 the
# DB init error is also a typed bolt.ErrDBLocked with the dbPath and the
# holder PID (via lsof), but fast-failing in the shell still beats
# waiting 3s for a guaranteed failure.
existing_bisonw_pids=$(pgrep -f 'client/cmd/bisonw/bisonw' || true)
if [ -n "$existing_bisonw_pids" ]; then
    echo "ERROR: another bisonw instance is already running:" >&2
    ps -o pid,etime,command -p $existing_bisonw_pids >&2
    echo "" >&2
    echo "Kill it first (e.g. 'kill $(echo $existing_bisonw_pids | awk '{print $1}')') or" >&2
    echo "the new instance will time out waiting for the DB lock." >&2
    exit 1
fi

## mainnet
#
# pprof is available at:
# http://127.0.0.1:3333/debug/pprof/goroutine?debug=1
#
# --no-embed-site is helful for development, but should be removed for production releases
(./client/cmd/bisonw/bisonw --webaddr=127.0.0.1:3333 --log=trace --httpprof --no-embed-site)

## mainnet with dedicated DB:
#(./client/cmd/bisonw/bisonw --db=/Users/norwnd/d-e-x-c-db/mainnet/dexc.db --webaddr=127.0.0.1:3333 --log=trace --httpprof)
## testnet with dedicated DB:
#(./client/cmd/bisonw/bisonw --db=/Users/norwnd/d-e-x-c-db/testnet/dexc.db --webaddr=127.0.0.1:3333 --log=trace --testnet --httpprof)
