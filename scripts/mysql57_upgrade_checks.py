"""Exercise the operator SQL on an owned loopback server, never a cloud DB."""
import hashlib
import json
import secrets
import time
import uuid
from pathlib import Path
import pymysql
from pymysql.constants import CLIENT
from sqlalchemy import MetaData, create_engine, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.schema import CreateTable
from hub_store import HubStore, metadata, schema, devices, tasks
from collaboration_store import CollaborationStore, entities


def verify_upgrade_sql(admin, config, secret, sql_root, expected_data_directory):
    with admin.cursor() as cursor:
        cursor.execute("SELECT @@datadir, VERSION()")
        actual, version = cursor.fetchone()
        assert admin.host == "127.0.0.1"
        assert Path(actual).resolve() == Path(expected_data_directory).resolve()
        assert version.startswith("5.7."), version
        cursor.execute("SHOW VARIABLES WHERE Variable_name IN "
                       "('innodb_default_row_format','innodb_large_prefix',"
                       "'innodb_file_format','innodb_file_per_table','innodb_page_size')")
        settings = dict(cursor.fetchall())
        cursor.execute("CREATE DATABASE station_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
        cursor.execute("GRANT ALL ON station_hub.* TO 'station_fixture'@'127.0.0.1'")
    report = {"version": version, "initialSettings": settings, "checks": {}}
    url = create_engine_url(config).set(database="station_hub")
    engine = create_engine(url, pool_pre_ping=True)
    store = HubStore(engine, secret)

    def run_file(name):
        connection = pymysql.connect(
            host="127.0.0.1", port=config["port"], user=config["user"],
            password=config["password"], database="station_hub", charset="utf8mb4",
            autocommit=True, client_flag=CLIENT.MULTI_STATEMENTS)
        try:
            with connection.cursor() as cursor:
                cursor.execute((sql_root / name).read_text(encoding="utf-8"))
                while cursor.nextset():
                    pass
        finally:
            connection.close()

    def schema_version():
        with engine.connect() as connection:
            return connection.execute(select(schema.c.version).where(schema.c.id == 1)).scalar()

    def old_data():
        with engine.connect() as connection:
            return {
                table.name: sorted(
                    [dict(row) for row in connection.execute(select(table)).mappings()],
                    key=lambda row: json.dumps(row, sort_keys=True))
                for table in metadata.sorted_tables if table is not schema
            }

    def set_global(name, value):
        assert name in ("innodb_default_row_format", "innodb_large_prefix")
        with admin.cursor() as cursor:
            cursor.execute("SET GLOBAL " + name + "=%s", (value,))

    try:
        metadata.create_all(engine)
        with engine.begin() as connection:
            connection.execute(schema.insert().values(id=1, version=1))
        identity = store.identity("legacy-preserved", "owned-fixture-password", register=True)
        device_id = str(uuid.uuid4())
        with engine.begin() as connection:
            connection.execute(devices.insert().values(
                id=device_id, owner=identity["owner_id"], name="Legacy device",
                revoked=0, created=time.time()))
            connection.execute(tasks.insert().values(
                id=str(uuid.uuid4()), owner=identity["owner_id"], device=device_id,
                agent="legacy-fixture", status="done", data='{"result":"preserved"}',
                created=time.time(), updated=time.time(), revision=1))
        before = old_data()
        run_file("01-preflight.sql")
        run_file("03-verify-and-set-schema2.sql")
        assert schema_version() == 1
        report["checks"]["missingTablesDoNotPromoteSchema"] = True

        # Exercise the legacy default instead of assuming a composite key fails.
        set_global("innodb_default_row_format", "compact")
        probe = entities.to_metadata(MetaData(), name="compact_key_probe")
        try:
            with engine.begin() as connection:
                connection.execute(CreateTable(probe))
        except DBAPIError as error:
            assert error.orig.args[0] in (1071, 1709), error
            report["checks"]["originalIndexWithCompactDefault"] = {"accepted": False, "errorCode": error.orig.args[0]}
        else:
            with engine.connect() as connection:
                row_format = connection.execute(text(
                    "SELECT ROW_FORMAT FROM information_schema.TABLES "
                    "WHERE TABLE_SCHEMA='station_hub' AND TABLE_NAME='compact_key_probe'")).scalar()
            report["checks"]["originalIndexWithCompactDefault"] = {"accepted": True, "rowFormat": row_format}

        # The operator SQL must work without changing the server default.
        run_file("02-create-collaboration-tables.sql")
        assert schema_version() == 1
        run_file("03-verify-and-set-schema2.sql")
        assert schema_version() == 2
        run_file("04-add-text-artifacts.sql")
        run_file("05-verify-text-artifacts.sql")
        store.ready()
        assert before == old_data()
        store.authenticate(identity["control_token"], "control")
        report["checks"]["navicatSqlWithCompactDefaultCreatesDynamicTables"] = True
        report["checks"]["allLegacyRowsAndCredentialPreserved"] = True
        report["legacyRowsDigest"] = hashlib.sha256(
            json.dumps(before, sort_keys=True).encode()).hexdigest()

        run_file("02-create-collaboration-tables.sql")
        run_file("03-verify-and-set-schema2.sql")
        assert schema_version() == 2 and before == old_data()
        run_file("04-add-text-artifacts.sql")
        run_file("05-verify-text-artifacts.sql")
        run_file("06-rollback-text-artifacts.sql")
        assert before == old_data()
        report["checks"]["textArtifactAdditiveSqlAndRollbackReadOnly"] = True
        report["checks"]["sqlRerunIsIdempotent"] = True
        with engine.begin() as connection:
            connection.execute(update(schema).where(schema.c.id == 1).values(version=99))
        run_file("03-verify-and-set-schema2.sql")
        run_file("04-add-text-artifacts.sql")
        assert schema_version() == 99
        with engine.begin() as connection:
            connection.execute(update(schema).where(schema.c.id == 1).values(version=2))
        report["checks"]["unknownSchemaVersionIsNotOverwritten"] = True

        set_global("innodb_large_prefix", "OFF")
        blocked = entities.to_metadata(MetaData(), name="large_prefix_off_probe")
        blocked.dialect_options["mysql"]["row_format"] = "DYNAMIC"
        try:
            with engine.begin() as connection:
                connection.execute(CreateTable(blocked))
        except DBAPIError as error:
            assert error.orig.args[0] in (1071, 1709), error
            report["checks"]["originalIndexWithLargePrefixOff"] = {"accepted": False, "errorCode": error.orig.args[0]}
        else:
            with engine.connect() as connection:
                row_format = connection.execute(text(
                    "SELECT ROW_FORMAT FROM information_schema.TABLES "
                    "WHERE TABLE_SCHEMA='station_hub' AND TABLE_NAME='large_prefix_off_probe'")).scalar()
            report["checks"]["originalIndexWithLargePrefixOff"] = {"accepted": True, "rowFormat": row_format}
        set_global("innodb_large_prefix", settings["innodb_large_prefix"])

        app_password = secrets.token_urlsafe(32)
        with admin.cursor() as cursor:
            cursor.execute("CREATE USER 'station_upgrade_app'@'127.0.0.1' IDENTIFIED BY %s",
                           (app_password,))
            cursor.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON station_hub.* "
                           "TO 'station_upgrade_app'@'127.0.0.1'")
        app_engine = create_engine(
            url.set(username="station_upgrade_app", password=app_password), pool_pre_ping=True)
        try:
            runtime = HubStore(app_engine, secret)
            runtime.ready()
            principal = runtime.authenticate(identity["control_token"], "control")
            runtime.rate("owned-upgrade-check", 10)
            runtime.rate("owned-upgrade-check", 10)
            service = CollaborationStore(runtime)
            registered = service.command(principal, {
                "protocol": 2, "requestId": str(uuid.uuid4()), "action": "device.register",
                "payload": {"deviceId": str(uuid.uuid4()), "config": {
                    "name": "5.7 兼容测试", "platform": "windows", "acceptingTasks": False,
                    "maxConcurrency": 1, "agents": []}}})
            assert registered["ok"] is True
            assert service.snapshot(identity["owner_id"])["cursor"] > 0
            try:
                with app_engine.begin() as connection:
                    connection.execute(text("CREATE TABLE app_ddl_must_be_denied (id INTEGER)"))
            except DBAPIError as error:
                assert error.orig.args[0] == 1142, error
            else:
                raise AssertionError("Application account unexpectedly has CREATE")
            report["checks"]["dmlOnlyRuntimeReadyRegistrationSnapshotAndRate"] = True
            report["checks"]["applicationCannotCreateTables"] = True
        finally:
            app_engine.dispose()
        report["pass"] = True
        return report
    finally:
        set_global("innodb_default_row_format", settings["innodb_default_row_format"])
        set_global("innodb_large_prefix", settings["innodb_large_prefix"])
        engine.dispose()


def create_engine_url(config):
    from sqlalchemy.engine import URL
    return URL.create(
        "mysql+pymysql", username=config["user"], password=config["password"],
        host="127.0.0.1", port=config["port"], database=config["database"],
        query={"charset": "utf8mb4"})
