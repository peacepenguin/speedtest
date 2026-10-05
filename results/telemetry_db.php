<?php

require_once 'idObfuscation.php';

define('TELEMETRY_SETTINGS_FILE', 'telemetry_settings.php');

// Columns of speedtest_users. The extended list adds latency/jitter measured
// during the download and upload tests; databases created before those
// columns existed are still supported by falling back to the base list.
define('SPEEDTEST_COLUMNS_BASE', 'id, timestamp, ip, ispinfo, ua, lang, dl, ul, ping, jitter, log, extra');
define('SPEEDTEST_COLUMNS_EXTENDED', SPEEDTEST_COLUMNS_BASE.', dl_ping, dl_jitter, ul_ping, ul_jitter');

/**
 * @return PDO|false
 */
function getPdo($returnErrorMessage = false)
{
    if (
        !file_exists(TELEMETRY_SETTINGS_FILE)
        || !is_readable(TELEMETRY_SETTINGS_FILE)
    ) {
		if($returnErrorMessage){
			return 'missing TELEMETRY_SETTINGS_FILE';
		}
        return false;
    }

    require TELEMETRY_SETTINGS_FILE;

    if (!isset($db_type)) {
		if($returnErrorMessage){
			return "db_type not set in '" . TELEMETRY_SETTINGS_FILE . "'";
		}
        return false;
    }

    $pdoOptions = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION
    ];

    try {
        if ('mssql' === $db_type) {
            if (!isset(
                $MsSql_server,
                $MsSql_databasename,
				$MsSql_WindowsAuthentication
            )) {
				if($returnErrorMessage){
					return "Required MSSQL database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
                return false;
            }
			
			if (!$MsSql_WindowsAuthentication and
			    !isset(
						$MsSql_username,
						$MsSql_password
						)
				) {
				if($returnErrorMessage){
					return "Required MSSQL database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
                return false;
            }
            $dsn = 'sqlsrv:'
                .'server='.$MsSql_server
                .';Database='.$MsSql_databasename;
			
			if($MsSql_TrustServerCertificate === true){
				$dsn = $dsn . ';TrustServerCertificate=1';
			}
			if($MsSql_TrustServerCertificate === false){
				$dsn = $dsn . ';TrustServerCertificate=0';
			}
			
			if($MsSql_WindowsAuthentication){
				return new PDO($dsn, "", "", $pdoOptions);
			} else {
				return new PDO($dsn, $MsSql_username, $MsSql_password, $pdoOptions);
			}
        }

        if ('mysql' === $db_type) {
            if (!isset(
                $MySql_hostname,
                $MySql_port,
                $MySql_databasename,
                $MySql_username,
                $MySql_password
            )) {
                if($returnErrorMessage){
					return "Required mysql database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
				return false;
            }

            $dsn = 'mysql:'
                .'host='.$MySql_hostname
                .';port='.$MySql_port
                .';dbname='.$MySql_databasename;

            return new PDO($dsn, $MySql_username, $MySql_password, $pdoOptions);
        }

        if ('sqlite' === $db_type) {
            if (!isset($Sqlite_db_file)) {
				if($returnErrorMessage){
					return "Required sqlite database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
                return false;
            }

			// Check if directory exists and is writable
			$db_dir = dirname($Sqlite_db_file);
			if (!is_dir($db_dir)) {
				if ($returnErrorMessage) {
					return "SQLite database directory does not exist: " . $db_dir . ". Please create it and ensure it's writable by the web server.";
				}
				return false;
			}
			if (!is_writable($db_dir)) {
				if ($returnErrorMessage) {
					return "SQLite database directory is not writable: " . $db_dir . ". Please ensure the web server has write permissions (e.g., chmod 755 or 775).";
				}
				return false;
			}

            $pdo = new PDO('sqlite:'.$Sqlite_db_file, null, null, $pdoOptions);

            # TODO: Why create table only in sqlite mode?
            $pdo->exec('
                CREATE TABLE IF NOT EXISTS `speedtest_users` (
                `id`        INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                `ispinfo`   text,
                `extra`     text,
                `timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
                `ip`        text NOT NULL,
                `ua`        text NOT NULL,
                `lang`      text NOT NULL,
                `dl`        text,
                `ul`        text,
                `ping`      text,
                `jitter`    text,
                `log`       longtext,
                `dl_ping`   text,
                `dl_jitter` text,
                `ul_ping`   text,
                `ul_jitter` text
                );
            ');

            // Databases created by older versions lack the latency/jitter
            // under load columns: add them. If this fails, inserts and
            // selects fall back to the original columns.
            try {
                $existing = [];
                foreach ($pdo->query('PRAGMA table_info(`speedtest_users`)') as $column) {
                    $existing[] = $column['name'];
                }
                foreach (['dl_ping', 'dl_jitter', 'ul_ping', 'ul_jitter'] as $column) {
                    if (!in_array($column, $existing, true)) {
                        $pdo->exec('ALTER TABLE `speedtest_users` ADD COLUMN `'.$column.'` text');
                    }
                }
            } catch (Exception $e) {
            }

            return $pdo;
        }

        if ('postgresql' === $db_type) {
            if (!isset(
                $PostgreSql_hostname,
                $PostgreSql_databasename,
                $PostgreSql_username,
                $PostgreSql_password
            )) {
                if($returnErrorMessage){
					return "Required postgresql database settings missing in '" . TELEMETRY_SETTINGS_FILE . "'";
				}
				return false;
            }

            $dsn = 'pgsql:'
                .'host='.$PostgreSql_hostname
                .';dbname='.$PostgreSql_databasename;

            return new PDO($dsn, $PostgreSql_username, $PostgreSql_password, $pdoOptions);
        }
    } catch (Exception $e) {
		if($returnErrorMessage){
			return $e->getMessage();
		}
        return false;
    }

	if($returnErrorMessage){
		return "db_type '" . $db_type . "' not supported";
	}
    return false;
}

/**
 * @return bool
 */
function isObfuscationEnabled()
{
    require TELEMETRY_SETTINGS_FILE;

    return
        isset($enable_id_obfuscation)
        && true === $enable_id_obfuscation;
}

/**
 * @return string|false returns the id of the inserted column or false on error if returnErrorMessage is false or a error message if returnErrorMessage is true
 */
function insertSpeedtestUser($ip, $ispinfo, $extra, $ua, $lang, $dl, $ul, $ping, $jitter, $log, $returnExceptionOnError = false, $loadedPing = null)
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
		if($returnExceptionOnError){
			return new Exception("Failed to get database connection object");
		}
        return false;
    }

    try {
        $id = false;
        if (is_array($loadedPing)) {
            // Newer schema: also store latency and jitter measured under load.
            // Databases created before these columns existed reject the
            // statement, in which case we fall back to the original columns.
            try {
                $stmt = $pdo->prepare(
                    'INSERT INTO speedtest_users
        (ip,ispinfo,extra,ua,lang,dl,ul,ping,jitter,log,dl_ping,dl_jitter,ul_ping,ul_jitter)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
                );
                $stmt->execute([
                    $ip, $ispinfo, $extra, $ua, $lang, $dl, $ul, $ping, $jitter, $log,
                    $loadedPing['dl_ping'], $loadedPing['dl_jitter'],
                    $loadedPing['ul_ping'], $loadedPing['ul_jitter'],
                ]);
                $id = $pdo->lastInsertId();
            } catch (Exception $e) {
                $id = false;
            }
        }
        if (false === $id) {
            $stmt = $pdo->prepare(
                'INSERT INTO speedtest_users
        (ip,ispinfo,extra,ua,lang,dl,ul,ping,jitter,log)
        VALUES (?,?,?,?,?,?,?,?,?,?)'
            );
            $stmt->execute([
                $ip, $ispinfo, $extra, $ua, $lang, $dl, $ul, $ping, $jitter, $log
            ]);
            $id = $pdo->lastInsertId();
        }
    } catch (Exception $e) {
		if($returnExceptionOnError){
			return $e;
		}
        return false;
    }

    if (isObfuscationEnabled()) {
        return obfuscateId($id);
    }

    return $id;
}

/**
 * @param int|string $id
 *
 * @return array|null|false|exception returns the speedtest data as array, null
 *                          if no data is found for the given id or
 *                          false or an exception if there was an error (based on returnExceptionOnError)
 *
 * @throws RuntimeException
 */
function getSpeedtestUserById($id,$returnExceptionOnError = false)
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
		if($returnExceptionOnError){
			return new Exception("Failed to get database connection object");
		}
        return false;
    }

    if (isObfuscationEnabled()) {
        $id = deobfuscateId($id);
    }

    try {
        // Prefer the columns with latency/jitter under load; fall back to the
        // original schema when the database doesn't have them yet.
        $row = null;
        foreach ([SPEEDTEST_COLUMNS_EXTENDED, SPEEDTEST_COLUMNS_BASE] as $attempt => $columns) {
            try {
                $stmt = $pdo->prepare(
                    'SELECT '.$columns.' FROM speedtest_users WHERE id = :id'
                );
                $stmt->bindValue(':id', $id, PDO::PARAM_INT);
                $stmt->execute();
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                break;
            } catch (Exception $e) {
                if ($attempt === 1) {
                    throw $e;
                }
            }
        }
    } catch (Exception $e) {
		if($returnExceptionOnError){
			return $e;
		}
        return false;
    }

    if (!is_array($row)) {
        return null;
    }

    $row['id_formatted'] = $row['id'];
    if (isObfuscationEnabled()) {
        $row['id_formatted'] = obfuscateId($row['id']).' (deobfuscated: '.$row['id'].')';
    }

    return $row;
}

/**
 * @return array|false
 */
function getLatestSpeedtestUsers()
{
    $pdo = getPdo();
    if (!($pdo instanceof PDO)) {
        return false;
    }

    require TELEMETRY_SETTINGS_FILE;
	
    try {
        $rows = null;
        foreach ([SPEEDTEST_COLUMNS_EXTENDED, SPEEDTEST_COLUMNS_BASE] as $attempt => $columns) {
            $sql = 'SELECT ';

            if('mssql' === $db_type) {$sql .= ' TOP(100) ';}

            $sql .= $columns.'
            FROM speedtest_users
            ORDER BY timestamp DESC ';

            if('mssql' !== $db_type) {$sql .= ' LIMIT 100 ';}

            try {
                $stmt = $pdo->query($sql);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                break;
            } catch (Exception $e) {
                if ($attempt === 1) {
                    throw $e;
                }
            }
        }

        foreach ($rows as $i => $row) {
            $rows[$i]['id_formatted'] = $row['id'];
            if (isObfuscationEnabled()) {
                $rows[$i]['id_formatted'] = obfuscateId($row['id']).' (deobfuscated: '.$row['id'].')';
            }
        }
    } catch (Exception $e) {
        return false;
    }

    return $rows;
}
