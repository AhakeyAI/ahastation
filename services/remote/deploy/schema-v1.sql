-- Apply only in the dedicated station_hub database, using a migration account. Schema v1.

CREATE TABLE hub_credentials (
	digest VARCHAR(64) NOT NULL,
	owner VARCHAR(36) NOT NULL,
	device VARCHAR(36),
	scope VARCHAR(16) NOT NULL,
	expires FLOAT(53) NOT NULL,
	revoked INTEGER NOT NULL,
	PRIMARY KEY (digest)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_bin

;
CREATE INDEX ix_hub_credentials_owner ON hub_credentials (owner);

CREATE TABLE hub_devices (
	id VARCHAR(36) NOT NULL,
	owner VARCHAR(36) NOT NULL,
	name VARCHAR(160) NOT NULL,
	revoked INTEGER NOT NULL,
	created FLOAT(53) NOT NULL,
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_bin

;
CREATE INDEX ix_hub_devices_owner ON hub_devices (owner);

CREATE TABLE hub_pairs (
	digest VARCHAR(64) NOT NULL,
	owner VARCHAR(36) NOT NULL,
	expires FLOAT(53) NOT NULL,
	used INTEGER NOT NULL,
	PRIMARY KEY (digest)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_bin

;

CREATE TABLE hub_rates (
	`key` VARCHAR(64) NOT NULL,
	`window` INTEGER NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (`key`, `window`)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_bin

;

CREATE TABLE hub_schema (
	id INTEGER NOT NULL AUTO_INCREMENT,
	version INTEGER NOT NULL,
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_bin

;

CREATE TABLE hub_task_keys (
	owner VARCHAR(36) NOT NULL,
	`key` VARCHAR(80) NOT NULL,
	digest VARCHAR(64) NOT NULL,
	task VARCHAR(36) NOT NULL,
	PRIMARY KEY (owner, `key`)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_bin

;

CREATE TABLE hub_tasks (
	id VARCHAR(36) NOT NULL,
	owner VARCHAR(36) NOT NULL,
	device VARCHAR(36) NOT NULL,
	agent VARCHAR(160) NOT NULL,
	status VARCHAR(32) NOT NULL,
	data LONGTEXT NOT NULL,
	created FLOAT(53) NOT NULL,
	updated FLOAT(53) NOT NULL,
	revision INTEGER NOT NULL,
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_bin

;
CREATE INDEX ix_hub_tasks_device ON hub_tasks (device);
CREATE INDEX ix_hub_tasks_owner ON hub_tasks (owner);

CREATE TABLE hub_users (
	id VARCHAR(36) NOT NULL,
	login VARCHAR(80) NOT NULL,
	password VARCHAR(220) NOT NULL,
	recovery VARCHAR(64) NOT NULL,
	created FLOAT(53) NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (login)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_bin

;
INSERT INTO hub_schema (id,version) VALUES (1,1);
