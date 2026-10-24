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
const MERGEBASE = `c${'0'.repeat(39)}`;
const MAIN = `8ab2ecf5b09954d741d36fdfc3b1b22771158649`;
// For a same-repository PR against main the PR base SHA is the current head
// of the base branch; the controller enforces this invariant, so the default
// fixtures use the same SHA for both.
const BASE = MAIN;
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
		commits: 1,
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
		// By default the single commit IS the PR head, as a one-commit
		// Dependabot PR reports.
		sha: HEAD,
		author: { id: 49699333, login: 'dependabot[bot]', type: 'Bot' },
		commit: { verification: { verified: true } },
		...overrides,
	};
}

// Job and check-run ids mirror the real required run 40049726187 of PR #191
// (attempt 1): GitHub Actions uses the job id as the check-run id.
const JOBS = [
	{ id: 120739494003, name: 'check-and-lint', status: 'completed', conclusion: 'success' },
	{ id: 120739667335, name: 'adapter-tests (22.x, ubuntu-latest)', status: 'completed', conclusion: 'success' },
	{ id: 120739667235, name: 'adapter-tests (24.x, ubuntu-latest)', status: 'completed', conclusion: 'success' },
	{ id: 120739667187, name: 'adapter-tests (26.x, ubuntu-latest)', status: 'completed', conclusion: 'success' },
	{ id: 120739667228, name: 'adapter-tests (22.x, windows-latest)', status: 'completed', conclusion: 'success' },
	{ id: 120739667236, name: 'adapter-tests (24.x, macos-latest)', status: 'completed', conclusion: 'success' },
];

function makeCheckRuns(overrides = {}) {
	return controller.EXPECTED.REQUIRED_CHECKS.map(name => {
		const job = JOBS.find(entry => entry.name === name);
		return {
			id: job ? job.id : 1,
			name,
			head_sha: HEAD,
			status: 'completed',
			conclusion: 'success',
			app: { id: 15368 },
			check_suite: { id: SUITE_ID },
			...(overrides[name] || {}),
		};
	});
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

// Realistic lockfile root entry: mirrors the HEAD manifest's dependencies and
// devDependencies exactly, the way npm writes packages[""].
const LOCKFILE = {
	lockfileVersion: 3,
	packages: {
		'': {
			name: 'iobroker.bluetti',
			version: '1.0.2',
			dependencies: { '@iobroker/adapter-core': '^3.4.3' },
			devDependencies: {
				'@types/node': '^22.20.6',
				'@types/iobroker': 'npm:@iobroker/types@^7.2.2',
			},
		},
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
	function page(route, items, params) {
		const size = scenario.pageSize || 100;
		// The controller always starts a pagination at page 1, so the page
		// number comes from the request itself; no cross-invocation counter.
		const pageNumber = (params && params.page) || 1;
		return items.slice((pageNumber - 1) * size, pageNumber * size);
	}
	function fileBody(entry) {
		if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'b64')) {
			// Raw base64 passthrough for decoding-härtung tests: `b64` is used
			// verbatim as the API content, `size` optionally overrides the
			// byte size the API would report.
			return {
				type: 'file',
				encoding: 'base64',
				size: entry.size === undefined ? Buffer.from(entry.b64, 'base64').length : entry.size,
				content: entry.b64,
			};
		}
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
				return { status: 200, data: page('pulls', next('openPrs', [makePr()]), params), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
				return { status: 200, data: next('pr', makePr()), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits') {
				return { status: 200, data: page('commits', next('commits', [makeCommit()]), params), headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files') {
				return { status: 200, data: page('files', next('files', FILES), params), headers: {} };
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
				return { status: 200, data: { jobs: page('jobs', next('jobs', JOBS), params) }, headers: {} };
			}
			if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
				return {
					status: 200,
					data: { check_runs: page('check-runs', next('checkRuns', makeCheckRuns()), params) },
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

test('lockfile: root dependencies must mirror the manifest dependencies (R4)', () => {
	// Outdated dev version in the lockfile root.
	const staleDev = JSON.parse(JSON.stringify(LOCKFILE));
	staleDev.packages[''].devDependencies['@types/node'] = '^22.20.5';
	assert.equal(pure.validateLockfile(staleDev, HEAD_MANIFEST).ok, false, 'outdated root dev version');
	// Additional dependency in the lockfile root.
	const extra = JSON.parse(JSON.stringify(LOCKFILE));
	extra.packages[''].devDependencies['left-pad'] = '^1.0.0';
	assert.equal(pure.validateLockfile(extra, HEAD_MANIFEST).ok, false, 'extra root dependency');
	// Missing root dependencies although the manifest has production deps.
	const noDeps = JSON.parse(JSON.stringify(LOCKFILE));
	delete noDeps.packages[''].dependencies;
	assert.equal(pure.validateLockfile(noDeps, HEAD_MANIFEST).ok, false, 'missing root dependencies');
	// Dependency shifted between prod/dev sections.
	const shifted = JSON.parse(JSON.stringify(LOCKFILE));
	delete shifted.packages[''].dependencies['@iobroker/adapter-core'];
	shifted.packages[''].devDependencies['@iobroker/adapter-core'] = '^3.4.3';
	assert.equal(pure.validateLockfile(shifted, HEAD_MANIFEST).ok, false, 'prod/dev shift');
	// Alias entry with a changed version spec.
	const aliasChanged = JSON.parse(JSON.stringify(LOCKFILE));
	aliasChanged.packages[''].devDependencies['@types/iobroker'] = 'npm:@iobroker/types@^7.3.0';
	assert.equal(pure.validateLockfile(aliasChanged, HEAD_MANIFEST).ok, false, 'changed alias spec');
	// Null root sections are invalid objects.
	const nullDeps = JSON.parse(JSON.stringify(LOCKFILE));
	nullDeps.packages[''].dependencies = null;
	assert.equal(pure.validateLockfile(nullDeps, HEAD_MANIFEST).ok, false, 'null root dependencies');
	// Missing root section is equivalent to a really empty manifest section.
	const emptyManifest = { name: 'iobroker.bluetti', version: '1.0.2', devDependencies: {} };
	const emptyLock = { lockfileVersion: 3, packages: { '': { name: 'iobroker.bluetti', version: '1.0.2' } } };
	assert.equal(pure.validateLockfile(emptyLock, emptyManifest).ok, true, 'missing root deps only for empty manifest');
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

test('file list: changed_files is a mandatory field (Pflichtfeldhärtung)', () => {
	assert.equal(pure.validateFileList(FILES, undefined).ok, false, 'missing count');
	assert.equal(pure.validateFileList(FILES, null).ok, false, 'null count');
	assert.equal(pure.validateFileList(FILES, '2').ok, false, 'string count');
	assert.equal(pure.validateFileList(FILES, 1.5).ok, false, 'non-integer count');
	assert.equal(pure.validateFileList(FILES, -1).ok, false, 'negative count');
});

/* ---------------------------------------------------------------------- */
/* Unit tests: PR commit completeness (R2)                                  */
/* ---------------------------------------------------------------------- */

function manyCommits(count) {
	const list = Array.from({ length: count }, (_, index) =>
		// Distinct, valid 40-char SHAs with an "e" prefix so they never
		// collide with the head SHA (which starts with "a").
		makeCommit({ sha: `e${index.toString(16).padStart(2, '0')}${'0'.repeat(37)}` }),
	);
	list[count - 1] = makeCommit({ sha: HEAD });
	return list;
}

test('pr commits: count, cap, uniqueness and head inclusion are enforced (R2)', () => {
	assert.equal(pure.validatePrCommits(manyCommits(1), 1, HEAD).ok, true, 'single head commit');
	assert.equal(pure.validatePrCommits(manyCommits(100), 100, HEAD).ok, true, '100 commits');
	assert.equal(pure.validatePrCommits(manyCommits(250), 250, HEAD).ok, true, 'cap boundary 250');
	assert.equal(pure.validatePrCommits(manyCommits(251), 251, HEAD).ok, false, 'above the 250 cap');
	assert.equal(pure.validatePrCommits(manyCommits(250), 251, HEAD).ok, false, '251 reported, endpoint capped at 250');
	assert.equal(pure.validatePrCommits(manyCommits(100), 101, HEAD).ok, false, 'count drift');
	assert.equal(pure.validatePrCommits(manyCommits(100), 99, HEAD).ok, false, 'count drift downwards');
	const withoutHead = manyCommits(100);
	withoutHead[99] = makeCommit({ sha: OTHER_SHA });
	assert.equal(pure.validatePrCommits(withoutHead, 100, HEAD).ok, false, 'expected head missing');
	const duplicated = manyCommits(2);
	duplicated[1] = { ...duplicated[0] };
	assert.equal(pure.validatePrCommits(duplicated, 2, HEAD).ok, false, 'duplicate SHAs');
	const invalidSha = manyCommits(2);
	invalidSha[0] = makeCommit({ sha: 'deadbeef' });
	assert.equal(pure.validatePrCommits(invalidSha, 2, HEAD).ok, false, 'invalid SHA format');
	assert.equal(pure.validatePrCommits(manyCommits(1), undefined, HEAD).ok, false, 'missing reported count');
	assert.equal(pure.validatePrCommits(manyCommits(1), 0, HEAD).ok, false, 'zero reported count');
	assert.equal(pure.validatePrCommits(manyCommits(1), '1', HEAD).ok, false, 'string reported count');
	assert.equal(pure.validatePrCommits('nope', 1, HEAD).ok, false, 'commit list not an array');
});

test('pr object: number and base SHA are mandatory fields', () => {
	const number = makePr().number;
	assert.equal(pure.validatePrObject(makePr(), HEAD, number).ok, true, 'matching bound number');
	assert.equal(pure.validatePrObject(makePr(), HEAD, undefined).ok, false, 'bound number is mandatory');
	assert.equal(pure.validatePrObject(makePr(), HEAD, 0).ok, false, 'bound number must be positive');
	assert.equal(pure.validatePrObject(makePr({ number: undefined }), HEAD, number).ok, false, 'missing number');
	assert.equal(pure.validatePrObject(makePr({ number: 12.5 }), HEAD, number).ok, false, 'fractional number');
	assert.equal(pure.validatePrObject(makePr({ number: 0 }), HEAD, number).ok, false, 'zero number');
	assert.equal(pure.validatePrObject(makePr({ number: 189 }), HEAD, number).ok, false, 'number mismatch');
	assert.equal(
		pure.validatePrObject(makePr({ base: { ref: 'main', sha: undefined, repo: { id: REPO_ID } } }), HEAD, number)
			.ok,
		false,
		'missing base SHA',
	);
	assert.equal(
		pure.validatePrObject(makePr({ base: { ref: 'main', sha: 'short', repo: { id: REPO_ID } } }), HEAD, number).ok,
		false,
		'invalid base SHA',
	);
	assert.equal(
		pure.validatePrObject(makePr({ base: { ref: 'develop', sha: BASE, repo: { id: REPO_ID } } }), HEAD, number).ok,
		false,
		'retargeted base',
	);
	assert.equal(pure.validatePrObject(null, HEAD, number).ok, false);
});

test('pr object: draft status must be the explicit boolean false (N2-R3)', () => {
	const number = makePr().number;
	assert.equal(pure.validatePrObject(makePr(), HEAD, number).ok, true, 'explicit false passes');
	assert.equal(pure.validatePrObject(makePr({ draft: true }), HEAD, number).ok, false, 'draft true');
	assert.equal(pure.validatePrObject(makePr({ draft: undefined }), HEAD, number).ok, false, 'draft missing');
	assert.equal(pure.validatePrObject(makePr({ draft: null }), HEAD, number).ok, false, 'draft null');
	assert.equal(pure.validatePrObject(makePr({ draft: 'false' }), HEAD, number).ok, false, 'draft string');
	assert.equal(pure.validatePrObject(makePr({ draft: 0 }), HEAD, number).ok, false, 'draft number');
});

test('pr object: state and head mismatches are fixed categories without raw echoes (N2-R7)', () => {
	const number = makePr().number;
	const canary = 'SYNTHETIC-N2-CANARY\ninjected';
	const state = pure.validatePrObject(makePr({ state: canary }), HEAD, number);
	assert.equal(state.ok, false);
	assert.equal(state.reason.includes('SYNTHETIC-N2-CANARY'), false, 'state canary leaked');
	const head = pure.validatePrObject(
		makePr({ head: { sha: canary, ref: 'x', repo: { id: REPO_ID } } }),
		HEAD,
		number,
	);
	assert.equal(head.ok, false);
	assert.equal(head.reason.includes('SYNTHETIC-N2-CANARY'), false, 'head canary leaked');
	assert.match(head.reason, /does not match triggering run head/);
});

/* ---------------------------------------------------------------------- */
/* Unit tests: run, identity and check validation                          */
/* ---------------------------------------------------------------------- */

test('trigger run: every identity attribute is enforced', () => {
	assert.equal(pure.validateTriggerRun(makeRun()).ok, true);
	assert.equal(pure.validateTriggerRun(makeRun({ id: undefined })).ok, false, 'run id mandatory');
	assert.equal(pure.validateTriggerRun(makeRun({ id: 12.5 })).ok, false, 'run id must be a safe integer');
	assert.equal(pure.validateTriggerRun(makeRun({ check_suite_id: undefined })).ok, false, 'check_suite_id mandatory');
	assert.equal(
		pure.validateTriggerRun(makeRun({ check_suite_id: '999' })).ok,
		false,
		'check_suite_id must be an integer',
	);
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
	assert.equal(pure.validateTriggerRun(makeRun({ run_attempt: 0 })).ok, false, 'attempt must be >= 1');
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

test('checks: job and check-run binding is unambiguous and ID-bound (R5)', () => {
	// Duplicate required job names in the attempt are ambiguous.
	assert.equal(pure.validateChecks([...JOBS, JOBS[0]], makeCheckRuns(), SUITE_ID, HEAD).ok, false, 'duplicate jobs');
	// Required job without a safe integer id cannot be bound.
	const noId = JOBS.map(job => ({ name: job.name, status: job.status, conclusion: job.conclusion }));
	assert.equal(pure.validateChecks(noId, makeCheckRuns(), SUITE_ID, HEAD).ok, false, 'job without id');
	// Two successful same-name head check runs are ambiguous, not "any success".
	const duplicateSuccess = [...makeCheckRuns(), makeCheckRuns()[0]];
	assert.equal(pure.validateChecks(JOBS, duplicateSuccess, SUITE_ID, HEAD).ok, false, 'duplicate check-runs');
	// A successful same-name check-run bound to a foreign job id is rejected.
	const foreignJobId = makeCheckRuns({ 'check-and-lint': { id: 4711 } });
	assert.equal(pure.validateChecks(JOBS, foreignJobId, SUITE_ID, HEAD).ok, false, 'foreign job id');
	// Missing check_suite_id on the triggering run removes suite attribution.
	assert.equal(pure.validateChecks(JOBS, makeCheckRuns(), undefined, HEAD).ok, false, 'suite id missing');
	assert.equal(pure.validateChecks(JOBS, makeCheckRuns(), 1.5, HEAD).ok, false, 'suite id not an integer');
	// Missing head SHA removes head attribution.
	assert.equal(pure.validateChecks(JOBS, makeCheckRuns(), SUITE_ID, 'short').ok, false, 'head SHA invalid');
	// A check run without suite information cannot be attributed.
	const noSuite = makeCheckRuns({ 'check-and-lint': { check_suite: undefined } });
	assert.equal(pure.validateChecks(JOBS, noSuite, SUITE_ID, HEAD).ok, false, 'check run without suite');
	// Non-array inputs fail closed.
	assert.equal(pure.validateChecks('nope', makeCheckRuns(), SUITE_ID, HEAD).ok, false);
	assert.equal(pure.validateChecks(JOBS, 'nope', SUITE_ID, HEAD).ok, false);
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
	// The lockfile root must mirror the manifest dependencies (R4).
	files[`package-lock.json@${HEAD}`] = {
		...LOCKFILE,
		packages: {
			'': { ...LOCKFILE.packages[''], dependencies: { '@iobroker/adapter-core': '^3.4.4' } },
		},
	};
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'merge-decision', result.reason);
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
				makeCommit({ sha: `e${'0'.repeat(39)}` }),
				makeCommit({
					author: { id: 5, login: 'someone', type: 'User' },
					commit: { verification: { verified: true } },
				}),
			],
			pr: makePr({ commits: 2 }),
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
/* Orchestration: rework regressions R2/R3/R5/R6/R7 and mandatory fields   */
/* ---------------------------------------------------------------------- */

test('unsupported-policy: PR with more than 250 commits is rejected (R2)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			// The endpoint would cap any list at 250 commits.
			pr: makePr({ commits: 251 }),
			commits: manyCommits(250),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.match(result.reason, /250/);
	assert.equal(writes.length, 0);
});

test('audit mode: a 250-commit PR with a complete list still reaches a merge-decision (R2)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			pageSize: 100,
			pr: makePr({ commits: 250 }),
			commits: manyCommits(250),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'merge-decision', result.reason);
	assert.equal(writes.length, 0);
});

test('skip: commit count drift between PR object and collected list (R2)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			pr: makePr({ commits: 2 }),
			commits: [makeCommit()],
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /collected 1 commits but PR reports 2/);
	assert.equal(writes.length, 0);
});

test('skip: expected head missing from the collected commit list (R2)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			pr: makePr({ commits: 1 }),
			commits: [makeCommit({ sha: OTHER_SHA })],
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /expected head SHA is not part/);
	assert.equal(writes.length, 0);
});

test('skip: PR retargeted to develop with identical base SHA before mutation (R3)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			pr: count =>
				count === 0 ? makePr() : makePr({ base: { ref: 'develop', sha: BASE, repo: { id: REPO_ID } } }),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /pr base is not main/);
	assert.equal(writes.length, 0);
});

test('skip: fresh PR without base repository before mutation (R3)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			pr: count => (count === 0 ? makePr() : makePr({ base: { ref: 'main', sha: BASE, repo: null } })),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /pr base is not main/);
	assert.equal(writes.length, 0);
});

test('skip: base branch reference without a valid SHA passes nothing (R3)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			mainRef: { object: { sha: null } },
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /did not return a valid 40-char SHA/);
	assert.equal(writes.length, 0);
});

test('skip: base branch reference loses its SHA at revalidation (R3)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			mainRef: count => (count === 0 ? { object: { sha: MAIN } } : { object: {} }),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /did not return a valid 40-char SHA/);
	assert.equal(writes.length, 0);
});

test('skip: stable PR base differing from the current main head fails closed (R3)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			pr: makePr({ base: { ref: 'main', sha: OTHER_SHA, repo: { id: REPO_ID } } }),
			mainRef: { object: { sha: MAIN } },
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /differs from current base branch head/);
	assert.equal(writes.length, 0);
});

test('skip: newer attempt starts before the final decision (R5)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			run: count => (count === 0 ? makeRun() : makeRun({ run_attempt: 2 })),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /drifted before decision/);
	assert.equal(writes.length, 0);
});

test('skip: required checks drift to failure before the final decision (R5)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			checkRuns: count =>
				count === 0 ? makeCheckRuns() : makeCheckRuns({ 'check-and-lint': { conclusion: 'failure' } }),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /check-and-lint/);
	assert.equal(writes.length, 0);
});

test('skip: fresh run id differs from the payload run id (R5)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			run: makeRun({ id: RUN_ID + 1 }),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /fresh run id does not match the payload run id/);
	assert.equal(writes.length, 0);
});

test('error: readback with a different merged head fails closed (R6)', async () => {
	const { result, writes, core } = await runScenario({
		scenario: {
			pr: count =>
				count <= 1
					? makePr()
					: makePr({
							state: 'closed',
							merged: true,
							head: { sha: OTHER_SHA, ref: 'dependabot/x', repo: { id: REPO_ID } },
							merge_commit_sha: MERGE_SHA,
						}),
			mergeResponse: { merged: true, sha: MERGE_SHA },
			fileContents: defaultFiles(),
		},
		enabled: true,
	});
	assert.equal(result.result, 'error', result.reason);
	assert.match(result.reason, /merged head differs from the validated head/);
	assert.equal(core.__failures.length, 1);
	assert.equal(writes.length, 1);
});

test('error: merge response without a valid merge commit SHA fails closed (R6)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			pr: openThenMergedPr(),
			mergeResponse: { merged: true, sha: 'not-a-sha' },
			fileContents: defaultFiles(),
		},
		enabled: true,
	});
	assert.equal(result.result, 'error', result.reason);
	assert.match(result.reason, /response did not contain a valid merge commit SHA/);
	assert.equal(writes.length, 1);
});

test('error: readback with a foreign base repository fails closed (R6)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			pr: count =>
				count <= 1
					? makePr()
					: makePr({
							state: 'closed',
							merged: true,
							base: { ref: 'main', sha: BASE, repo: { id: 4711 } },
							merge_commit_sha: MERGE_SHA,
						}),
			mergeResponse: { merged: true, sha: MERGE_SHA },
			fileContents: defaultFiles(),
		},
		enabled: true,
	});
	assert.equal(result.result, 'error', result.reason);
	assert.match(result.reason, /identity mismatch/);
	assert.equal(writes.length, 1);
});

test('error: raw API exception never reaches logs, summary or setFailed (R7)', async () => {
	const canaryError = new Error('SYNTHETIC-CANARY-SECRET token=abcdef\nx-injected-header: 1');
	canaryError.status = 500;
	const { result, writes, core } = await runScenario({
		scenario: {
			run: () => {
				throw canaryError;
			},
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'error', result.reason);
	assert.match(result.reason, /HTTP 500/);
	const emitted = [result.reason, ...core.__info, ...core.__summaries, ...core.__failures].join('\n');
	assert.equal(emitted.includes('SYNTHETIC-CANARY'), false, 'canary leaked');
	assert.equal(emitted.includes('token=abcdef'), false, 'fragment leaked');
	assert.equal(writes.length, 0);
});

test('unsupported-policy: JSON parser fragments never reach the output (R7)', async () => {
	const files = defaultFiles();
	files[`package-lock.json@${HEAD}`] = { raw: '{"SYNTHETIC-CANARY-SECRET": "truncated' };
	const { result, writes, core } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	const emitted = [result.reason, ...core.__info, ...core.__summaries, ...core.__failures].join('\n');
	assert.equal(emitted.includes('SYNTHETIC-CANARY'), false, 'canary leaked');
	assert.equal(writes.length, 0);
});

test('unsupported-policy: control characters in file names are sanitized (R7)', async () => {
	const { result, writes, core } = await runScenario({
		scenario: {
			files: [
				{ filename: 'package.json', status: 'modified' },
				{ filename: 'package-lock.json\n## Forged-Summary-Line SYNTHETIC-CANARY', status: 'modified' },
			],
			pr: makePr({ changed_files: 2 }),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'unsupported-policy', result.reason);
	const summary = core.__summaries.join('');
	assert.equal(summary.includes('SYNTHETIC-CANARY'), false, 'canary leaked');
	assert.equal(summary.includes('\n## Forged-Summary-Line'), false, 'newline injection survived');
	assert.equal(writes.length, 0);
});

test('error: unknown config field with canary content never reaches the output (R7)', async () => {
	const { result, core } = await runScenario({
		configTemplate: { ...CONFIG_TEMPLATE, 'SYNTHETIC-CANARY\ninjected': true },
		scenario: { fileContents: defaultFiles() },
	});
	assert.equal(result.result, 'error', result.reason);
	const emitted = [result.reason, ...core.__info, ...core.__summaries, ...core.__failures].join('\n');
	assert.equal(emitted.includes('SYNTHETIC-CANARY'), false, 'canary leaked');
});

test('unsupported-policy: PR without a changed_files count fails closed (Pflichtfeld)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			pr: makePr({ changed_files: undefined }),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.match(result.reason, /changed_files/);
	assert.equal(writes.length, 0);
});

test('skip: candidate PR without a valid number fails closed (Pflichtfeld)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			openPrs: [makePr({ number: undefined })],
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /candidate PR number/);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: lockfile without a valid size field fails closed (Pflichtfeld)', async () => {
	const files = defaultFiles();
	files[`package-lock.json@${HEAD}`] = { raw: JSON.stringify(LOCKFILE), size: null };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.match(result.reason, /no valid size field/);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: lockfile size mismatching the decoded content fails closed (Pflichtfeld)', async () => {
	const files = defaultFiles();
	files[`package-lock.json@${HEAD}`] = { raw: JSON.stringify(LOCKFILE), size: 5 };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.match(result.reason, /possible truncation/);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: manifest with a non-integer size field fails closed (Pflichtfeld)', async () => {
	const files = defaultFiles();
	files[`package.json@${HEAD}`] = { raw: JSON.stringify(HEAD_MANIFEST), size: 'many' };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.match(result.reason, /no valid size field/);
	assert.equal(writes.length, 0);
});

test('skip: head drifts between validation and mutation', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			fileContents: defaultFiles(),
			pr: count => (count === 0 ? makePr() : makePr({ head: { sha: OTHER_SHA, repo: { id: REPO_ID } } })),
		},
		enabled: true,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /does not match triggering run head/);
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
/* N2-R3: PR number binding and mandatory draft status                      */
/* ---------------------------------------------------------------------- */

test('skip: fresh PR number mismatch at initial validation fails closed (N2-R3)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			// The candidate list reports #188; every fresh GET responds with
			// another, otherwise fully valid PR number.
			pr: makePr({ number: 189 }),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /does not match the bound pull request number/);
	assert.equal(writes.length, 0);
});

test('skip: PR number drift between initial and final validation fails closed (N2-R3)', async () => {
	const { result, writes } = await runScenario({
		scenario: {
			pr: count => (count === 0 ? makePr() : makePr({ number: 189 })),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /does not match the bound pull request number/);
	assert.equal(writes.length, 0);
});

test('skip: unknown draft status fails closed (N2-R3)', async () => {
	for (const draft of [undefined, null, 'false']) {
		const { result, writes } = await runScenario({
			scenario: { pr: makePr({ draft }), fileContents: defaultFiles() },
			enabled: false,
		});
		assert.equal(result.result, 'skip', `${String(draft)}: ${result.reason}`);
		assert.match(result.reason, /draft status is unknown/);
		assert.equal(writes.length, 0);
	}
});

test('skip: number mismatch and unknown draft perform no mutation in the fake enabled path (N2-R3)', async () => {
	const mismatch = await runScenario({
		scenario: { pr: makePr({ number: 189 }), fileContents: defaultFiles() },
		enabled: true,
	});
	assert.equal(mismatch.result.result, 'skip', mismatch.result.reason);
	assert.equal(mismatch.writes.length, 0, 'no PUT before full validation');
	const draft = await runScenario({
		scenario: { pr: makePr({ draft: undefined }), fileContents: defaultFiles() },
		enabled: true,
	});
	assert.equal(draft.result.result, 'skip', draft.result.reason);
	assert.equal(draft.writes.length, 0, 'no PUT before full validation');
});

/* ---------------------------------------------------------------------- */
/* N2-R7: canaries in name, message, number, head and status fields          */
/* ---------------------------------------------------------------------- */

function emittedText(result, core) {
	return [result.reason, ...core.__info, ...core.__summaries, ...core.__failures].join('\n');
}

test('error: foreign error name and message never reach info, summary or setFailed (N2-R7)', async () => {
	const foreign = new Error('hidden canary message');
	foreign.name = 'SYNTHETIC-N2-CANARY\nraw response';
	foreign.status = 500;
	const { result, writes, core } = await runScenario({
		scenario: {
			run: () => {
				throw foreign;
			},
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'error', result.reason);
	assert.equal(result.reason, 'fail closed: unexpected error (HTTP 500)');
	const emitted = emittedText(result, core);
	assert.equal(emitted.includes('SYNTHETIC-N2-CANARY'), false, 'name canary leaked');
	assert.equal(emitted.includes('hidden canary message'), false, 'message canary leaked');
	assert.equal(writes.length, 0);
});

test('skip: invalid candidate PR number is never serialized into outputs (N2-R7)', async () => {
	const { result, writes, core } = await runScenario({
		scenario: {
			openPrs: [makePr({ number: 'SYNTHETIC-N2-CANARY\nraw JSON' })],
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.match(result.reason, /candidate PR number/);
	const emitted = emittedText(result, core);
	assert.equal(emitted.includes('SYNTHETIC-N2-CANARY'), false, 'number canary leaked');
	assert.equal(writes.length, 0);
});

test('skip: invalid PR head value is never echoed (N2-R7)', async () => {
	const { result, writes, core } = await runScenario({
		scenario: {
			pr: makePr({ head: { sha: 'SYNTHETIC-N2-CANARY\nraw JSON', ref: 'x', repo: { id: REPO_ID } } }),
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	const emitted = emittedText(result, core);
	assert.equal(emitted.includes('SYNTHETIC-N2-CANARY'), false, 'head canary leaked');
	assert.equal(writes.length, 0);
});

test('skip: run event/status/conclusion values are never echoed (N2-R7)', async () => {
	for (const override of [
		{ event: 'SYNTHETIC-N2-CANARY' },
		{ status: 'SYNTHETIC-N2-CANARY' },
		{ conclusion: 'SYNTHETIC-N2-CANARY' },
	]) {
		const { result, core } = await runScenario({
			scenario: { run: makeRun(override), fileContents: defaultFiles() },
			enabled: false,
		});
		assert.equal(result.result, 'skip', result.reason);
		const emitted = emittedText(result, core);
		assert.equal(emitted.includes('SYNTHETIC-N2-CANARY'), false, 'run field canary leaked');
	}
});

test('skip: non-open PR state value is never echoed (N2-R7)', async () => {
	const { result, core } = await runScenario({
		scenario: { pr: makePr({ state: 'SYNTHETIC-N2-CANARY' }), fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	const emitted = emittedText(result, core);
	assert.equal(emitted.includes('SYNTHETIC-N2-CANARY'), false, 'state canary leaked');
});

test('skip: check job and check-run status values are never echoed (N2-R7)', async () => {
	const poisoned = JOBS.map(job =>
		job.name === 'check-and-lint'
			? { ...job, status: 'SYNTHETIC-N2-CANARY', conclusion: 'SYNTHETIC-N2-CANARY' }
			: job,
	);
	const { result, core } = await runScenario({
		scenario: { jobs: poisoned, fileContents: defaultFiles() },
		enabled: false,
	});
	assert.equal(result.result, 'skip', result.reason);
	const emitted = emittedText(result, core);
	assert.equal(emitted.includes('SYNTHETIC-N2-CANARY'), false, 'status canary leaked');
});

/* ----------------------------------------------------------------------
 * N4-R7: audit metadata is typed, validated and fail closed
 * ---------------------------------------------------------------------- */

const N4_CANARY = 'SYNTHETIC-N4-CANARY\nraw response';

test('skip: invalid run_attempt is never adopted into the audit (N4-R7)', async () => {
	for (const attempt of [undefined, null, '1', N4_CANARY, 0, 1.5, -1]) {
		const scenario = { run: makeRun({ run_attempt: attempt }), fileContents: defaultFiles() };
		const { result, writes, core } = await runScenario({ scenario, enabled: false });
		assert.equal(result.result, 'skip', result.reason);
		assert.match(result.reason, /run_attempt/);
		// The rejected value must not be adopted: the audit attempt stays
		// unknown and never reaches any output channel.
		assert.equal(result.audit.attempt, null, 'rejected attempt was adopted into the audit');
		assert.equal(emittedText(result, core).includes('SYNTHETIC-N4-CANARY'), false, 'attempt canary leaked');
		assert.equal(writes.length, 0);
	}
});

test('skip: invalid controller run SHA fails closed before a merge decision (N4-R7)', async () => {
	for (const sha of [undefined, null, 'short', 'X'.repeat(40), N4_CANARY]) {
		const { result, writes, core } = await runScenario({
			scenario: { fileContents: defaultFiles() },
			enabled: false,
			context: { sha },
		});
		assert.equal(result.result, 'skip', result.reason);
		assert.match(result.reason, /controller: run SHA/);
		assert.equal(result.audit.controllerSha, null, 'invalid controller SHA was adopted');
		// info, summary and setFailed are inspected separately; none may
		// contain the raw (unvalidated) SHA value.
		assert.equal(result.reason.includes('SYNTHETIC-N4-CANARY'), false, 'canary in reason');
		assert.equal(core.__info.join('\n').includes('SYNTHETIC-N4-CANARY'), false, 'canary in info');
		assert.equal(core.__summaries.join('').includes('SYNTHETIC-N4-CANARY'), false, 'canary in summary');
		assert.equal(core.__failures.join('\n').includes('SYNTHETIC-N4-CANARY'), false, 'canary in setFailed');
		assert.match(core.__summaries.join(''), /Controller SHA: n\/a/);
		assert.equal(writes.length, 0);
	}
});

test('skip: invalid controller SHA blocks the fake-enabled merge path too (N4-R7)', async () => {
	const { result, writes } = await runScenario({
		scenario: { fileContents: defaultFiles() },
		enabled: true,
		context: { sha: N4_CANARY },
	});
	assert.equal(result.result, 'skip', result.reason);
	assert.equal(writes.length, 0, 'no merge mutation without a validated controller SHA');
});

test('audit output: valid metadata is preserved in info, summary and setFailed (N4-R7)', async () => {
	const { result, core } = await runScenario({ scenario: { fileContents: defaultFiles() }, enabled: false });
	assert.equal(result.result, 'merge-decision', result.reason);
	const summary = core.__summaries.join('');
	assert.match(summary, new RegExp(`Triggering run: ${RUN_ID} \\(attempt 1\\)`));
	assert.match(summary, new RegExp(`Controller SHA: ${CONTROLLER_SHA}`));
	assert.match(summary, /PR: #188/);
	assert.match(summary, new RegExp(`Validated head: ${HEAD}`));
	assert.match(summary, new RegExp(`Base: main @ ${BASE} \\(merge-base ${MERGEBASE}\\)`));
	assert.match(summary, /check-and-lint=completed\/success/);
	// The info channel mirrors the summary exactly.
	assert.equal(core.__info.length, 1);
	assert.equal(core.__info[0], summary);
	// A skip/decision path never calls setFailed.
	assert.equal(core.__failures.length, 0);
});

test('audit output: early skip paths render unknown fields as the fixed n/a representation (N4-R7)', async () => {
	const { result, writes, core } = await runScenario({
		scenario: { fileContents: defaultFiles() },
		enabled: false,
		context: { eventName: 'pull_request' },
	});
	assert.equal(result.result, 'skip', result.reason);
	const summary = core.__summaries.join('');
	assert.match(summary, /Triggering run: n\/a/);
	assert.match(summary, /Controller SHA: n\/a/);
	assert.match(summary, /PR: none/);
	assert.match(summary, /Validated head: n\/a/);
	assert.match(summary, /Required checks: n\/a/);
	assert.equal(core.__failures.length, 0);
	assert.equal(writes.length, 0);
});

test('error: setFailed keeps the fixed category and the allowed numeric HTTP status (N4-R7)', async () => {
	const foreign = new Error('hidden canary message');
	foreign.status = 502;
	const { result, writes, core } = await runScenario({
		scenario: {
			// The failure happens AFTER the run metadata was validated and
			// adopted, so the error path must still project it safely.
			openPrs: () => {
				throw foreign;
			},
			fileContents: defaultFiles(),
		},
		enabled: false,
	});
	assert.equal(result.result, 'error', result.reason);
	// The allowed numeric HTTP status is preserved, the raw message is not.
	assert.equal(result.reason, 'fail closed: unexpected error (HTTP 502)');
	assert.equal(core.__failures.length, 1);
	assert.match(core.__failures[0], /^dependabot-automerge: error: fail closed: unexpected error \(HTTP 502\)$/);
	// Already-validated audit metadata survives on the error path.
	assert.match(core.__summaries.join(''), new RegExp(`Triggering run: ${RUN_ID} \\(attempt 1\\)`));
	assert.match(core.__summaries.join(''), new RegExp(`Controller SHA: ${CONTROLLER_SHA}`));
	assert.equal(writes.length, 0);
});

/* ---------------------------------------------------------------------- */
/* N2-D1: strict base64 / UTF-8 decoding                                    */
/* ---------------------------------------------------------------------- */

test('strict base64: accepts padded and line-wrapped representations, rejects everything else (N2-D1)', () => {
	const raw = Buffer.from(JSON.stringify(LOCKFILE)).toString('base64');
	const size = Buffer.byteLength(JSON.stringify(LOCKFILE));
	assert.equal(pure.strictBase64(raw, size), raw, 'padded representation');
	assert.equal(pure.strictBase64(raw.replace(/(.{60})/g, '$1\n'), size), raw, 'legitimate LF line wraps');
	assert.equal(pure.strictBase64(raw.replace(/(.{60})/g, '$1\r\n'), size), raw, 'CRLF line wraps');
	assert.equal(pure.strictBase64(`!${raw}!!!`, size), null, 'stray characters are not ignored');
	assert.equal(pure.strictBase64(` ${raw}`, size), null, 'space is not a line wrap');
	assert.equal(pure.strictBase64(raw, size + 1), null, 'size drift up');
	assert.equal(pure.strictBase64(raw, size - 1), null, 'size drift down');
	assert.equal(pure.strictBase64(null, 5), null, 'content must be a string');
	assert.equal(pure.strictBase64(raw, '3'), null, 'size must be a safe integer');
	assert.equal(pure.strictBase64('', 0), '', 'empty file');
	assert.equal(pure.strictBase64('', 1), null, 'empty content with a positive size');
	const maxRawLength = Math.ceil(controller.EXPECTED.MAX_FILE_BYTES / 3) * 4 * 2;
	assert.equal(pure.strictBase64('A'.repeat(maxRawLength + 1), 0), null, 'raw bound before allocation');
	// Padding must sit exactly where the reported size implies.
	const one = Buffer.from('a').toString('base64');
	const two = Buffer.from('ab').toString('base64');
	const three = Buffer.from('abc').toString('base64');
	assert.equal(pure.strictBase64(one, 1), one, 'two padding characters for size%3==1');
	assert.equal(pure.strictBase64(two, 2), two, 'one padding character for size%3==2');
	assert.equal(pure.strictBase64(three, 3), three, 'no padding for size%3==0');
	assert.equal(pure.strictBase64('YWJj', 1), null, 'padding inconsistent with the reported size');
	assert.equal(pure.strictBase64('YQ=', 1), null, 'single padding character');
	assert.equal(pure.strictBase64('YQ====', 1), null, 'excess padding');
	assert.equal(pure.strictBase64('YQ==A', 1), null, 'padding followed by data');
	assert.equal(pure.strictBase64('Y=WJj', 3), null, 'padding in the middle');
});

test('unsupported-policy: base64 content with stray characters fails closed (N2-D1)', async () => {
	const files = defaultFiles();
	const lockB64 = Buffer.from(JSON.stringify(LOCKFILE)).toString('base64');
	files[`package-lock.json@${HEAD}`] = { b64: `!${lockB64}!!!` };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.match(result.reason, /base64/);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: padding inside the base64 body fails closed (N2-D1)', async () => {
	const files = defaultFiles();
	const lockB64 = Buffer.from(JSON.stringify(LOCKFILE)).toString('base64');
	files[`package-lock.json@${HEAD}`] = { b64: `${lockB64.slice(0, 4)}=${lockB64.slice(5)}` };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.match(result.reason, /base64/);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: valid base64 of invalid UTF-8 bytes fails closed (N2-D1)', async () => {
	const files = defaultFiles();
	// '{"a' followed by an orphaned UTF-8 lead byte: the representation is
	// strictly valid base64 with a consistent size, but the bytes are not
	// UTF-8 — no silent replacement characters may pass as JSON data.
	files[`package-lock.json@${HEAD}`] = { b64: Buffer.from([0x7b, 0x22, 0x61, 0xc3, 0x28]).toString('base64') };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'unsupported-policy', result.reason);
	assert.match(result.reason, /not valid UTF-8/);
	assert.equal(writes.length, 0);
});

test('audit mode: legitimate line-wrapped base64 content still reaches a merge-decision (N2-D1)', async () => {
	const files = defaultFiles();
	const lockB64 = Buffer.from(JSON.stringify(LOCKFILE)).toString('base64');
	files[`package-lock.json@${HEAD}`] = { b64: lockB64.replace(/(.{60})/g, '$1\n') };
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'merge-decision', result.reason);
	assert.equal(writes.length, 0);
});

/* ----------------------------------------------------------------------
 * N4-D1: canonical base64 zero pad bits
 * ---------------------------------------------------------------------- */

// Base64 alphabet for pad-bit mutations: index -> character.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Build a JSON payload (the lockfile plus trailing spaces) whose byte length
 * has the requested `size % 3` remainder, so both padding shapes can be
 * exercised with still-valid JSON.
 *
 * @param {number} remainder - desired `size % 3` remainder (0, 1 or 2)
 */
function paddedRawLockfile(remainder) {
	let raw = JSON.stringify(LOCKFILE);
	while (Buffer.byteLength(raw) % 3 !== remainder) {
		raw += ' ';
	}
	return raw;
}

test('strict base64: every non-zero pad-bit variant is rejected for both padding shapes (N4-D1)', () => {
	for (const remainder of [1, 2]) {
		const raw = paddedRawLockfile(remainder);
		const size = Buffer.byteLength(raw);
		const canonical = Buffer.from(raw).toString('base64');
		// The canonical representation itself passes.
		assert.equal(pure.strictBase64(canonical, size), canonical, `canonical size%3==${remainder}`);
		// Enumerate ALL non-zero values of the unused low-order bits of the
		// last payload character. Each mutant is a different representation
		// of exactly the same decoded bytes — the canonicality requirement
		// (RFC 4648 §3.5) is what rejects them, not length or padding count.
		const padding = remainder === 1 ? '==' : '=';
		const lastPayloadIndex = canonical.length - padding.length - 1;
		const lastValue = B64_ALPHABET.indexOf(canonical[lastPayloadIndex]);
		const unusedBits = remainder === 1 ? 4 : 2;
		const variants = (1 << unusedBits) - 1;
		for (let delta = 1; delta <= variants; delta += 1) {
			const mutantValue = lastValue ^ delta;
			// Only in-alphabet characters can appear at all; values with set
			// bits beyond the alphabet size are not representable mutations.
			if (mutantValue >= 64) {
				continue;
			}
			const mutant =
				canonical.slice(0, lastPayloadIndex) +
				B64_ALPHABET[mutantValue] +
				canonical.slice(lastPayloadIndex + 1);
			assert.notEqual(mutant, canonical, 'mutation is a no-op');
			// Proof of the equivalence: same decoded bytes, different text.
			assert.equal(
				Buffer.from(mutant, 'base64').toString('base64'),
				canonical,
				'mutant does not decode to the same bytes',
			);
			assert.equal(pure.strictBase64(mutant, size), null, `non-canonical pad bits accepted (delta ${delta})`);
		}
	}
});

test('strict base64: canonical unpadded representations are unaffected (N4-D1)', () => {
	const raw = paddedRawLockfile(0);
	const size = Buffer.byteLength(raw);
	const canonical = Buffer.from(raw).toString('base64');
	assert.equal(canonical.endsWith('='), false, 'control payload must be unpadded');
	assert.equal(pure.strictBase64(canonical, size), canonical, 'canonical unpadded representation');
	// An unpadded representation has no unused bits: changing the last
	// character changes the decoded BYTES (it is not a pad-bit variant), so
	// the pure representation validator correctly has no canonicality
	// complaint at this level — the different bytes fail later, through the
	// size/JSON consistency of the decoded content.
	const mutant = canonical.slice(0, -1) + B64_ALPHABET[(B64_ALPHABET.indexOf(canonical.slice(-1)) + 1) % 64];
	assert.notEqual(Buffer.from(mutant, 'base64').toString('base64'), canonical, 'mutant changed no bytes');
	assert.equal(pure.strictBase64(mutant, size), mutant, 'unpadded form must not be rejected as non-canonical');
});

test('audit mode: canonical lockfile representations of all three padding shapes reach merge-decision (N4-D1)', async () => {
	for (const remainder of [0, 1, 2]) {
		const raw = paddedRawLockfile(remainder);
		const canonical = Buffer.from(raw).toString('base64');
		const files = defaultFiles();
		files[`package-lock.json@${HEAD}`] = { b64: canonical, size: Buffer.byteLength(raw) };
		const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
		assert.equal(result.result, 'merge-decision', result.reason);
		assert.equal(writes.length, 0);
	}
});

test('audit mode: canonical line-wrapped base64 with padding still reaches merge-decision (N4-D1)', async () => {
	const raw = paddedRawLockfile(1);
	const canonical = Buffer.from(raw).toString('base64');
	const files = defaultFiles();
	files[`package-lock.json@${HEAD}`] = {
		b64: canonical.replace(/(.{60})/g, '$1\r\n'),
		size: Buffer.byteLength(raw),
	};
	const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
	assert.equal(result.result, 'merge-decision', result.reason);
	assert.equal(writes.length, 0);
});

test('unsupported-policy: non-canonical pad bits never reach a merge decision (N4-D1)', async () => {
	for (const remainder of [1, 2]) {
		const raw = paddedRawLockfile(remainder);
		const size = Buffer.byteLength(raw);
		const canonical = Buffer.from(raw).toString('base64');
		const padding = remainder === 1 ? '==' : '=';
		const lastPayloadIndex = canonical.length - padding.length - 1;
		const mutantValue = B64_ALPHABET.indexOf(canonical[lastPayloadIndex]) ^ 1;
		const mutant =
			canonical.slice(0, lastPayloadIndex) + B64_ALPHABET[mutantValue] + canonical.slice(lastPayloadIndex + 1);
		// The orchestration input decodes to the very same bytes; only the
		// representation differs (the exact N4 counterexample shape).
		assert.equal(Buffer.from(mutant, 'base64').toString('base64'), canonical);
		const files = defaultFiles();
		files[`package-lock.json@${HEAD}`] = { b64: mutant, size };
		const { result, writes } = await runScenario({ scenario: { fileContents: files }, enabled: false });
		assert.equal(result.result, 'unsupported-policy', result.reason);
		assert.match(result.reason, /base64/);
		assert.equal(writes.length, 0);
	}
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

test('test-and-release workflow: check-and-lint executes the controller test suite (R1)', () => {
	const yaml = readWorkflow('test-and-release.yml');
	const checkBlock = yaml.slice(yaml.indexOf('check-and-lint:'), yaml.indexOf('adapter-tests:'));
	assert.match(checkBlock, /test-command:\s*'npm run test:package && npm run test:workflow'/);
	// No job, matrix, trigger or gate names were added or renamed.
	assert.match(yaml, /needs:\s*check-and-lint/);
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
