import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./upload-bunny.sh', import.meta.url));

// Fake aws CLI. It stores the bucket in a directory and logs each call.
// UPLOAD_TEST_DROP names an asset that the fake storage does not store:
// once, or always when UPLOAD_TEST_DROP_ALWAYS is set.
const fakeAws = `#!/usr/bin/env python3
import fnmatch, json, os, shutil, sys
bucket = os.environ['UPLOAD_TEST_BUCKET']
args = sys.argv[1:]
with open(os.environ['UPLOAD_TEST_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
values = ('--endpoint-url', '--cache-control', '--bucket', '--prefix', '--query', '--output')
plain, excludes, prefix, i = [], [], '', 0
while i < len(args):
    if args[i] in values:
        if args[i] == '--prefix':
            prefix = args[i + 1]
        i += 2
    elif args[i] == '--exclude':
        excludes.append(args[i + 1])
        i += 2
    else:
        plain.append(args[i])
        i += 1

def key(url):
    return url.split('/', 3)[3]

def put(source, name):
    drop = os.environ.get('UPLOAD_TEST_DROP')
    marker = os.path.join(bucket, '.dropped')
    if drop and name == drop:
        if os.environ.get('UPLOAD_TEST_DROP_ALWAYS') or not os.path.exists(marker):
            open(marker, 'w').close()
            return
    target = os.path.join(bucket, name)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copy(source, target)

if plain[0] == 'configure':
    sys.exit(0)
if plain[0] == 's3api':
    keys = []
    for root, _, files in os.walk(bucket):
        for file in files:
            name = os.path.relpath(os.path.join(root, file), bucket)
            if name.startswith(prefix) and file != '.dropped':
                keys.append(name)
    print('\\t'.join(keys) if keys else 'None')
    sys.exit(0)
command = plain[1]
rest = [value for value in plain[2:] if not value.startswith('--')]
if command == 'rm':
    os.remove(os.path.join(bucket, key(rest[0])))
elif rest[0].startswith('s3://'):
    sys.stdout.write(open(os.path.join(bucket, key(rest[0]))).read())
elif '--recursive' in args:
    source, target = rest
    for root, _, files in os.walk(source):
        for file in files:
            name = os.path.relpath(os.path.join(root, file), source)
            if not any(fnmatch.fnmatch(name, e) for e in excludes):
                put(os.path.join(root, file), key(target) + name)
else:
    put(rest[0], key(rest[1]))
`;

// Fake public host. It serves the bucket directory. UPLOAD_TEST_HOST_404
// gives 404 for one path, UPLOAD_TEST_SPA gives the SPA fallback (200 HTML)
// for every path.
const fakeHost = `#!/usr/bin/env python3
import http.server, os, sys
bucket = os.environ['UPLOAD_TEST_BUCKET']
class Handler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        path = self.path.lstrip('/')
        if os.environ.get('UPLOAD_TEST_SPA'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
        elif path == os.environ.get('UPLOAD_TEST_HOST_404') or not os.path.isfile(os.path.join(bucket, path)):
            self.send_response(404)
            self.send_header('Content-Type', 'text/html')
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript')
        self.end_headers()
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
`;

// Fake date for GNU date options on any platform.
const fakeDate = `#!/usr/bin/env python3
import datetime, sys
now = datetime.datetime.now(datetime.timezone.utc)
args = sys.argv[1:]
if '-d' in args:
    days = int(args[args.index('-d') + 1].split()[0])
    now += datetime.timedelta(days=days)
print(now.strftime(args[-1].lstrip('+')))
`;

const assets = ['assets/index-a1.js', 'assets/page-b2.js', 'assets/app-c3.css'];

async function fixture(t, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'upload-bunny-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const bucket = join(directory, 'bucket');
  const dist = join(directory, 'dist');
  const log = join(directory, 'calls.jsonl');
  mkdirSync(bin);
  mkdirSync(bucket);
  for (const file of ['index.html', 'sw.js', 'workbox.js', ...assets]) {
    mkdirSync(join(dist, file, '..'), { recursive: true });
    writeFileSync(join(dist, file), `content of ${file}`);
  }
  writeFileSync(join(bin, 'aws'), fakeAws, { mode: 0o700 });
  writeFileSync(join(bin, 'date'), fakeDate, { mode: 0o700 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(directory, 'host.py'), fakeHost);

  const testEnv = {
    ...process.env,
    UPLOAD_TEST_BUCKET: bucket,
    UPLOAD_TEST_LOG: log,
    ...env
  };
  const host = spawn('python3', [join(directory, 'host.py')], { env: testEnv });
  t.after(() => host.kill());
  const port = await new Promise((resolve, reject) => {
    host.stdout.once('data', data => resolve(String(data).trim()));
    host.once('error', reject);
  });

  return {
    bucket,
    run: () =>
      spawnSync('bash', [script, dist], {
        encoding: 'utf8',
        env: {
          ...testEnv,
          PATH: bin + delimiter + process.env.PATH,
          BUNNY_STORAGE_ZONE: 'test-zone',
          BUNNY_S3_ENDPOINT: 'https://storage.invalid',
          PUBLIC_URL: `http://127.0.0.1:${port}/`
        }
      }),
    uploads: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line))
            .filter(call => call[0] === 's3' && call[1] === 'cp')
            .map(call => call[3])
        : []
  };
}

void test('checks the assets, then publishes the entry points', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Check: all +3 assets are available\./);
  const uploads = f.uploads();
  assert.deepEqual(uploads.slice(0, 2), [
    's3://test-zone/assets/',
    's3://test-zone/'
  ]);
  assert.deepEqual(uploads.slice(2, 4), [
    's3://test-zone/index.html',
    's3://test-zone/sw.js'
  ]);
  assert.ok(existsSync(join(f.bucket, 'index.html')));
});

void test('uploads an asset again when the storage did not keep it', async t => {
  const f = await fixture(t, { UPLOAD_TEST_DROP: 'assets/page-b2.js' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Check 1: +1 assets are missing:\nassets\/page-b2\.js/
  );
  assert.ok(f.uploads().includes('s3://test-zone/assets/page-b2.js'));
  assert.ok(existsSync(join(f.bucket, 'assets/page-b2.js')));
  assert.ok(existsSync(join(f.bucket, 'index.html')));
});

const stopCases = [
  {
    name: 'the storage never keeps an asset',
    env: { UPLOAD_TEST_DROP: 'assets/page-b2.js', UPLOAD_TEST_DROP_ALWAYS: '1' }
  },
  {
    name: 'the public host returns 404',
    env: { UPLOAD_TEST_HOST_404: 'assets/index-a1.js' }
  },
  {
    name: 'the public host returns the SPA fallback',
    env: { UPLOAD_TEST_SPA: '1' }
  }
];

for (const { name, env } of stopCases) {
  void test(`stops before the entry points when ${name}`, async t => {
    const f = await fixture(t, env);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Check 3: /);
    assert.match(result.stderr, /Deploy stopped: assets are missing\./);
    assert.ok(!existsSync(join(f.bucket, 'index.html')));
    assert.ok(!existsSync(join(f.bucket, 'sw.js')));
  });
}
