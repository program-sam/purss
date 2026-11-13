<?php
/*
 * Fixed engine administration for the product worker in a Compose deployment, replacing
 * `podman exec`. It accepts exactly the command arrays the worker's EngineAdmin builds:
 *   php -f ./cli/<allowlisted script> -- <arguments>
 *   php -r <one of three allowlisted snippets, by sha256> <arguments>
 * Authenticated with its own token (engine-helper-token), never the product's service token; the
 * engine sits on an internal network with no route from outside and none to the product's service listeners. Runs as Apache's user (www-data) with no shell.
 */
declare(strict_types=1);

function reply(int $status, array $body): never {
	http_response_code($status);
	header('Content-Type: application/json');
	header('Cache-Control: no-store');
	echo json_encode($body);
	exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') reply(405, ['error' => 'method']);
$token = @file_get_contents('/run/purss-secrets/engine-helper-token');
$headers = function_exists('getallheaders') ? array_change_key_case(getallheaders()) : [];
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? ($headers['authorization'] ?? '');
if ($token === false || strlen(trim($token)) < 32 || !hash_equals('Bearer ' . trim($token), $auth)) reply(401, ['error' => 'unauthorized']);

$allow = json_decode((string) file_get_contents(__DIR__ . '/../../purss/allowlist.json'), true);
$req = json_decode((string) file_get_contents('php://input', false, null, 0, 65536), true);
$cmd = is_array($req) ? ($req['command'] ?? null) : null;
if (!is_array($cmd) || !array_is_list($cmd) || count($cmd) < 3 || count($cmd) > 12) reply(400, ['error' => 'command']);
foreach ($cmd as $w) if (!is_string($w) || str_contains($w, "\0") || strlen($w) > 4096) reply(400, ['error' => 'command']);

$SAFE_ARG = '/^[A-Za-z0-9_.@=:\/~+-]{1,300}$/';
if ($cmd[0] !== 'php') reply(400, ['error' => 'command']);
if ($cmd[1] === '-f') {
	$script = preg_replace('#^\./cli/#', '', $cmd[2], 1, $n);
	if ($n !== 1 || !in_array($script, $allow['cliScripts'], true) || ($cmd[3] ?? null) !== '--') reply(400, ['error' => 'command']);
	$args = array_slice($cmd, 4);
} elseif ($cmd[1] === '-r') {
	if (!in_array(hash('sha256', $cmd[2]), $allow['snippetHashes'], true)) reply(400, ['error' => 'command']);
	$args = array_slice($cmd, 3);
} else {
	reply(400, ['error' => 'command']);
}
foreach ($args as $a) if (!preg_match($SAFE_ARG, $a)) reply(400, ['error' => 'argument']);

$proc = proc_open(array_merge(['/usr/bin/php'], array_slice($cmd, 1)), [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, '/var/www/FreshRSS', getenv());
if (!is_resource($proc)) reply(500, ['error' => 'spawn']);
fclose($pipes[0]);
stream_set_blocking($pipes[1], false);
stream_set_blocking($pipes[2], false);
$out = ''; $err = ''; $deadline = time() + 110;
while (true) {
	$r = [$pipes[1], $pipes[2]]; $w = null; $e = null;
	if (stream_select($r, $w, $e, 1) > 0) foreach ($r as $p) { $chunk = fread($p, 65536); if ($p === $pipes[1]) $out .= $chunk; else $err .= $chunk; }
	$st = proc_get_status($proc);
	if (!$st['running']) { $out .= stream_get_contents($pipes[1]); $err .= stream_get_contents($pipes[2]); break; }
	if (time() > $deadline) { proc_terminate($proc); reply(504, ['error' => 'timeout']); }
}
fclose($pipes[1]); fclose($pipes[2]);
proc_close($proc);
reply(200, ['exitCode' => $st['exitcode'], 'stdout' => substr($out, 0, 1 << 20), 'stderr' => substr($err, -8192)]);
