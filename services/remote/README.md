# Existing remote Hub and native-session compatibility

This directory contains the Hub, Bridge/native-session support, fixtures and
deployment sources imported from the current Pocket Vibe working tree.
Source paths and hashes are recorded in [UPSTREAM_SOURCE.json](UPSTREAM_SOURCE.json).
The Station integration and tests now use these in-repository files rather than
requiring a sibling checkout.

This is the existing remote-control baseline. Station-native receiving devices,
logical project bindings, shared meetings and cross-device Worker scheduling
remain future work. The independent Bridge GUI is retained for compatibility;
it is not the proposed final user flow.

## Install development dependencies

Use a separate Python environment. The existing container uses Python 3.13.5.

~~~powershell
cd services/remote
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-public.txt
~~~

Use requirements-bridge.txt instead when building the independent compatibility
Bridge. On macOS/Linux use .venv/bin/python.

## Run isolated tests

~~~powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
~~~

Fixtures use temporary loopback services/projects and test credentials. Native
MySQL checks are opt-in via HUB_TEST_MYSQL_URL and require a dedicated, initially
empty station_hub_test* database and a non-root account. They remove their own
test tables. Never use the production database.

From the Station repository root, enable the Python-backed Node fixtures:

~~~powershell
$env:POCKET_VIBE_TEST_PYTHON = (Resolve-Path services/remote/.venv/Scripts/python.exe).Path
npm.cmd test
~~~

Unset the variable after testing if it should not apply to later commands.
Fixtures are skipped when it is absent; a skipped check is not native acceptance.

## Start the existing public Hub

Configure the placeholders from [deploy/hub.env.example](deploy/hub.env.example)
in your own private environment, provide an isolated MySQL database, and run the
explicit schema migration/check before starting:

~~~powershell
.\.venv\Scripts\python.exe deploy/migrate.py migrate
.\.venv\Scripts\python.exe deploy/migrate.py check
.\.venv\Scripts\python.exe device/public_hub.py
~~~

The example env file is a template; the Python command does not automatically
load it. Keep credentials in local environment settings or an ignored private
file, not in source control. The production entry requires MySQL and HUB_SECRET;
it does not silently fall back to a local database.

The container listens on 8787. Public clients use the HTTPS/WSS gateway domain.
Keep one Hub instance and one worker until connection routing is redesigned.
No deployed default URL is included in this baseline.

For local protocol-only development, prefer fixtures or a deliberately isolated
mock service. The old device_hub.py demo and its development tokens are LAN-only.

## Build a cloud-upload source ZIP

~~~powershell
.\.venv\Scripts\python.exe scripts/package_hub.py --output runtime/review-package
~~~

Use a new output directory on each run; the exporter refuses to overwrite files.
It packages the allowlisted current sources, Dockerfile and checksums. It does
not deploy, modify MySQL, change DNS or publish a Bridge installer.

See [WeChat CloudRun deployment](docs/WEIXIN_CLOUD_DEPLOY.md),
[public protocol](docs/PUBLIC_REMOTE_CONTROL.md), and the dated native acceptance
records under docs/. Their older environment observations are historical; consult
the root [baseline record](../../docs/collaboration/BASELINE.md) for this upload.
