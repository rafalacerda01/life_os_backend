'use strict';
// Test-only launcher. No Firebase CLI, credential discovery, downloads or deploy.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const BACKEND = true;
const PROJECT = 'demo-life-os';
let java, child, javaClosed = false, interrupted = false;
const result = {project: PROJECT, node: process.version, inheritedCredentials: false, selections: []};
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-k01-'));
const profile = path.join(runtime, 'empty-profile');
fs.mkdirSync(profile);
const windows = process.env.SystemRoot || 'C:/Windows';
const env = {
  ...(process.platform === 'win32' ? {SystemRoot: windows, WINDIR: windows} : {}),
  PATH: [path.dirname(process.execPath), ...(process.platform === 'win32' ?
    [path.join(windows, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter),
  HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
  XDG_CONFIG_HOME: profile, CLOUDSDK_CONFIG: profile, TEMP: runtime, TMP: runtime,
  GCLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT,
  METADATA_SERVER_DETECTION: 'none', GCE_METADATA_HOST: '127.0.0.1:1',
  CI: 'true', FIREBASE_CLI_DISABLE_USAGE_REPORTING: '1',
};
const javaExe = process.env.K01_JAVA_EXE || (process.platform === 'win32' ?
  'C:/Program Files/Android/Android Studio/jbr/bin/java.exe' : '/usr/bin/java');
const jar = process.env.K01_FIRESTORE_JAR || path.join(os.homedir(),
  '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true; child?.kill(); java?.kill();
});
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function run() {
  if (process.argv.length !== 2 || Number(process.versions.node.split('.')[0]) < 22) {
    throw Error('NODE_22_OR_LATER_AND_NO_ARGUMENTS_REQUIRED');
  }
  for (const file of [javaExe, jar]) {
    if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw Error('LOCAL_JAVA_AND_JAR_REQUIRED');
  }
  const port = await freePort();
  const host = result.host = '127.0.0.1:' + port;
  java = spawn(javaExe, ['-Duser.language=en', '-Duser.country=US', '-Duser.home=' + profile,
    '-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--project_id', PROJECT,
    '--single_project_mode', '--single_project_mode_error', '--rules',
    BACKEND ? path.join(__dirname, 'deny-all.rules') : path.join(ROOT, 'firestore.rules')],
  {cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const log = fs.createWriteStream(path.join(runtime, 'emulator.log'));
  java.stdout.pipe(log, {end: false}); java.stderr.pipe(log, {end: false});
  java.once('close', () => {javaClosed = true; log.end();});
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('EMULATOR_READINESS_TIMEOUT')), 30000);
    let tail = '';
    const onData = data => {
      tail = (tail + data).slice(-16000);
      if (/Dev App Server is now running|API endpoint:/.test(tail)) {
        clearTimeout(timeout); resolve();
      }
    };
    java.stdout.on('data', onData); java.stderr.on('data', onData);
    java.once('error', error => {clearTimeout(timeout); reject(Error(error.code || 'JAVA_START_FAILED'));});
    java.once('exit', code => {clearTimeout(timeout); reject(Error('EMULATOR_EARLY_EXIT:' + code));});
  });
  const selections = BACKEND ? [
    {tag: 'sdk', cwd: ROOT, files: ['test/integration/account-cleanup-emulator.test.cjs'], minimum: 21},
  ] : [
    {tag: 'sdk', cwd: path.join(ROOT, 'functions'), files: ['test/account-cleanup-emulator.test.js'], minimum: 18},
    {tag: 'red', cwd: path.join(ROOT, 'functions'), files: ['test/cleanup-user-data.test.js'], minimum: 2,
      pattern: '^P1 RED: reused UID .* must preserve the recreated account$'},
    {tag: 'rules', cwd: path.join(ROOT, 'tools/firestore_rules'), minimum: 357,
      files: ['account-deletion.rules.test.js', 'p1-uid-policy.rules.test.js', 'k01-cleanup-manifests.rules.test.js']},
  ];
  const childEnv = {...env, FIRESTORE_EMULATOR_HOST: host, K01_EMULATOR_TEST: '1',
    K01_EVIDENCE_DIR: runtime,
    NODE_OPTIONS: '--require=' + JSON.stringify(path.join(__dirname, 'emulator-guard.cjs').replace(/\\/g, '/'))};
  for (const selection of selections) {
    if (interrupted || javaClosed) throw Error('EMULATOR_STOPPED');
    const args = ['--test', '--test-concurrency=1', '--test-reporter=tap',
      ...(selection.pattern ? ['--test-name-pattern=' + selection.pattern] : []), ...selection.files];
    const out = fs.openSync(path.join(runtime, selection.tag + '.tap'), 'w');
    const err = fs.openSync(path.join(runtime, selection.tag + '.stderr'), 'w');
    let timedOut = false;
    child = spawn(process.execPath, args, {cwd: selection.cwd, env: childEnv,
      windowsHide: true, stdio: ['ignore', out, err]});
    const timeout = setTimeout(() => {timedOut = true; child?.kill();}, 240000);
    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));
      });
    } finally {clearTimeout(timeout); fs.closeSync(out); fs.closeSync(err); child = null;}
    const tap = fs.readFileSync(path.join(runtime, selection.tag + '.tap'), 'utf8');
    const metrics = Object.fromEntries([...tap.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)\r?$/gm)]
      .map(match => [match[1], Number(match[2])]));
    const pass = exit.code === 0 && exit.signal === null && !timedOut &&
      metrics.tests >= selection.minimum && metrics.pass === metrics.tests &&
      metrics.fail === 0 && metrics.skipped === 0 && metrics.cancelled === 0;
    const record = {tag: selection.tag, args, ...exit, timedOut, metrics, pass};
    result.selections.push(record); console.log(JSON.stringify(record));
    if (!pass) throw Error('SELECTION_FAILED:' + selection.tag);
  }
}
run().catch(error => {result.error = error.message;}).finally(async () => {
  child?.kill();
  if (java && !javaClosed) {
    java.kill();
    await Promise.race([new Promise(resolve => java.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  result.emulatorStopped = javaClosed;
  result.io = fs.readdirSync(runtime).filter(file => /^emulator-io-\d+\.json$/.test(file))
    .map(file => JSON.parse(fs.readFileSync(path.join(runtime, file))))
    .filter(trace => trace.host === result.host);
  result.pass = !result.error && !interrupted && javaClosed &&
    result.selections.length === (BACKEND ? 1 : 3) && result.selections.every(s => s.pass) &&
    result.io.length > 0 && result.io.every(t => t.refused.length === 0 && t.adc.length === 0);
  fs.writeFileSync(path.join(runtime, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({pass: result.pass, project: PROJECT, artifacts: runtime,
    emulatorStopped: javaClosed, error: result.error,
    adc: result.io.reduce((n, t) => n + t.adc.length, 0),
    nonEmulatorConnections: result.io.reduce((n, t) => n + t.refused.length, 0)}));
  process.exitCode = result.pass ? 0 : 1;
});
