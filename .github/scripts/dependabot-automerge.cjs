'use strict';

/**
 * Dependabot auto-merge controller (trusted main only).
 *
 * Executed exclusively by `.github/workflows/automerge-dependabot.yml` as a
 * `workflow_run` job after "Test and Release" completed. It runs with code and
 * configuration checked out from the controller run's SHA on the default
 * branch. It never executes, imports or interpolates pull request code,
 * titles, bodies or branch names: PR data is consumed strictly as JSON data.
 *
 * Trust model (fail closed):
 *  - Only "Test and Release" pull_request runs that completed successfully may
 *    trigger a merge decision.
 *  - Exactly one open, same-repo-head PR whose head SHA equals the triggering
 *    run's head SHA is a candidate. Payload `pull_requests` is a hint only.
 *  - The PR must be authored by Dependabot (login, numeric id and type all
 *    checked) and every PR commit must be authored by that same identity with
 *    a verified signature.
 *  - Only root package.json / package-lock.json may be modified; everything
 *    outside dependencies/devDependencies must be structurally unchanged.
 *  - Version classification is conservative: production patch and development
 *    patch/minor only. Everything else stays in the reviewed Hermes pipeline.
 *  - The three required checks must be present and successful both for the
 *    triggering run attempt and currently on the expected head.
 *  - Merge is SHA-bound (squash) and re-validated immediately before mutation.
 *  - With `enabled: false` (audit mode) the controller performs zero writes.
 */

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED = {
	REPO_ID: 1284294352,
	REPO_NAME: 'Percy2Live/ioBroker.bluetti',
	OWNER: 'Percy2Live',
	REPO: 'ioBroker.bluetti',
	WORKFLOW_ID: 305123310,
	WORKFLOW_NAME: 'Test and Release',
	WORKFLOW_PATH: '.github/workflows/test-and-release.yml',
	DEPENDABOT_LOGIN: 'dependabot[bot]',
	DEPENDABOT_ID: 49699333,
	DEPENDABOT_TYPE: 'Bot',
	BASE_REF: 'main',
	REQUIRED_CHECKS: ['check-and-lint', 'adapter-tests (22.x, ubuntu-latest)', 'adapter-tests (24.x, ubuntu-latest)'],
	ACTIONS_APP_ID: 15368,
	CONFIG_PATH: '.github/auto-merge.json',
	MAX_FILE_BYTES: 1024 * 1024,
	SUPPORTED_LOCKFILE_VERSIONS: [2, 3],
	MANIFEST_PATH: 'package.json',
	LOCKFILE_PATH: 'package-lock.json',
};

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Internal error type carrying the HTTP status of a failed API call.
 */
class ControllerError extends Error {
	/**
	 * @param {string} message - error message
	 * @param {number} [status] - HTTP status of the failed request
	 */
	constructor(message, status) {
		super(message);
		this.name = 'ControllerError';
		this.status = status;
	}
}

/* ---------------------------------------------------------------------- */
/* Pure validation / classification (no I/O)                                */
/* ---------------------------------------------------------------------- */

/**
 * Validate the strict configuration schema. Unknown fields, wrong types or
 * unsupported values are hard errors (fail closed).
 *
 * @param {object} rawConfig - parsed JSON configuration object
 */
function validateConfig(rawConfig) {
	if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
		return { ok: false, reason: 'config: not an object' };
	}
	const allowedTop = ['schemaVersion', 'enabled', 'mergeMethod', 'npm'];
	for (const key of Object.keys(rawConfig)) {
		if (!allowedTop.includes(key)) {
			return { ok: false, reason: `config: unknown field "${key}"` };
		}
	}
	if (rawConfig.schemaVersion !== 1) {
		return { ok: false, reason: 'config: schemaVersion must be 1' };
	}
	if (typeof rawConfig.enabled !== 'boolean') {
		return { ok: false, reason: 'config: enabled must be a boolean' };
	}
	if (rawConfig.mergeMethod !== 'squash') {
		return { ok: false, reason: 'config: mergeMethod must be "squash"' };
	}
	const npm = rawConfig.npm;
	if (npm === null || typeof npm !== 'object' || Array.isArray(npm)) {
		return { ok: false, reason: 'config: npm must be an object' };
	}
	const allowedNpmKeys = ['production', 'development'];
	for (const key of Object.keys(npm)) {
		if (!allowedNpmKeys.includes(key)) {
			return { ok: false, reason: `config: unknown npm field "${key}"` };
		}
	}
	const policy = {};
	const allowedBySection = { production: ['patch'], development: ['patch', 'minor'] };
	for (const section of ['production', 'development']) {
		const values = npm[section];
		if (!Array.isArray(values)) {
			return { ok: false, reason: `config: npm.${section} must be an array` };
		}
		for (const value of values) {
			if (!allowedBySection[section].includes(value)) {
				return { ok: false, reason: `config: npm.${section} value "${value}" is not allowed` };
			}
		}
		policy[section] = new Set(values);
	}
	return { ok: true, config: { enabled: rawConfig.enabled, mergeMethod: rawConfig.mergeMethod, npm: policy } };
}

/**
 * Parse a strict npm version spec: optional identical prefix (^ or ~), then a
 * canonical stable X.Y.Z. Rejects leading zeros, prerelease/build suffixes,
 * aliases, URLs, ranges, wildcards and overly long numeric components.
 *
 * @param {string} spec - npm version range spec, e.g. "^1.2.3"
 */
function parseVersionSpec(spec) {
	if (typeof spec !== 'string') {
		return { ok: false, reason: `version spec is not a string: ${typeof spec}` };
	}
	const match = /^([\^~]?)(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.exec(spec);
	if (!match) {
		return { ok: false, reason: `unsupported version spec format: ${JSON.stringify(spec)}` };
	}
	return {
		ok: true,
		prefix: match[1],
		major: BigInt(match[2]),
		minor: BigInt(match[3]),
		patch: BigInt(match[4]),
	};
}

/**
 * Compare two parsed versions: 1 if new is greater, -1 if smaller, 0 if equal.
 *
 * @param {object} oldV - parsed base version
 * @param {object} newV - parsed candidate new version
 */
function compareParsedVersions(oldV, newV) {
	if (newV.major > oldV.major) {
		return 1;
	}
	if (newV.major < oldV.major) {
		return -1;
	}
	if (newV.minor > oldV.minor) {
		return 1;
	}
	if (newV.minor < oldV.minor) {
		return -1;
	}
	if (newV.patch > oldV.patch) {
		return 1;
	}
	if (newV.patch < oldV.patch) {
		return -1;
	}
	return 0;
}

/**
 * Bump type for a strictly greater new version.
 *
 * @param {object} oldV - parsed base version
 * @param {object} newV - parsed candidate new version
 */
function bumpType(oldV, newV) {
	if (newV.major > oldV.major) {
		return 'major';
	}
	if (newV.minor > oldV.minor) {
		return 'minor';
	}
	return 'patch';
}

/**
 * Classify a single dependency version change against the policy.
 * Only same-prefix, strictly increasing, canonical stable versions of existing
 * dependencies qualify. `alias` specs that are unchanged are never classified.
 *
 * @param {string} section - dependency section ("production" or "development")
 * @param {string} oldSpec - base version range spec
 * @param {string} newSpec - new version range spec
 * @param {object} policy - validated policy configuration
 */
function classifyDependencyChange(section, oldSpec, newSpec, policy) {
	const oldV = parseVersionSpec(oldSpec);
	if (!oldV.ok) {
		return { ok: false, reason: `dependency ${section}: ${oldV.reason}` };
	}
	const newV = parseVersionSpec(newSpec);
	if (!newV.ok) {
		return { ok: false, reason: `dependency ${section}: ${newV.reason}` };
	}
	if (oldV.prefix !== newV.prefix) {
		return {
			ok: false,
			reason: `dependency ${section}: version range prefix changed (${JSON.stringify(oldV.prefix)} -> ${JSON.stringify(newV.prefix)})`,
		};
	}
	const cmp = compareParsedVersions(oldV, newV);
	if (cmp < 0) {
		return { ok: false, reason: `dependency ${section}: version downgrade (${oldSpec} -> ${newSpec})` };
	}
	if (cmp === 0) {
		return { ok: false, reason: `dependency ${section}: version unchanged` };
	}
	const type = bumpType(oldV, newV);
	if (!policy.npm[section].has(type)) {
		return {
			ok: false,
			reason: `dependency ${section}: ${type} update not allowed by policy (${oldSpec} -> ${newSpec})`,
		};
	}
	return { ok: true, type };
}

/**
 * Deep structural equality (order-insensitive for objects).
 *
 * @param {unknown} a - left value
 * @param {unknown} b - right value
 */
function deepEqual(a, b) {
	if (a === b) {
		return true;
	}
	if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return false;
	}
	if (Array.isArray(a)) {
		if (a.length !== b.length) {
			return false;
		}
		return a.every((item, index) => deepEqual(item, b[index]));
	}
	const keysA = Object.keys(a).sort();
	const keysB = Object.keys(b).sort();
	if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) {
		return false;
	}
	return keysA.every(key => deepEqual(a[key], b[key]));
}

/**
 * Validate the changed root package.json against the base manifest.
 * Everything outside dependencies/devDependencies must be structurally
 * identical; dependency names and their prod/dev assignment must not change;
 * only version values of existing names may change and every change must pass
 * the deterministic policy.
 *
 * @param {object} baseManifest - package.json at the merge base
 * @param {object} headManifest - package.json at the PR head
 * @param {object} policy - validated policy configuration
 */
function validateManifestDiff(baseManifest, headManifest, policy) {
	for (const name of [baseManifest, headManifest]) {
		if (name === null || typeof name !== 'object' || Array.isArray(name)) {
			return { ok: false, reason: 'manifest: not an object' };
		}
	}
	const stripDeps = manifest => {
		const copy = { ...manifest };
		delete copy.dependencies;
		delete copy.devDependencies;
		return copy;
	};
	if (!deepEqual(stripDeps(baseManifest), stripDeps(headManifest))) {
		return {
			ok: false,
			reason: 'manifest: change outside dependencies/devDependencies (scripts, version, config, overrides, repository, ...)',
		};
	}
	const baseDeps = baseManifest.dependencies ?? {};
	const headDeps = headManifest.dependencies ?? {};
	const baseDev = baseManifest.devDependencies ?? {};
	const headDev = headManifest.devDependencies ?? {};
	const sameKeys = (a, b) => {
		const keysA = Object.keys(a).sort();
		const keysB = Object.keys(b).sort();
		return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index]);
	};
	if (!sameKeys(baseDeps, headDeps)) {
		return { ok: false, reason: 'manifest: dependencies added, removed or moved' };
	}
	if (!sameKeys(baseDev, headDev)) {
		return { ok: false, reason: 'manifest: devDependencies added, removed or moved' };
	}
	// Dependency must stay in the same section (no prod/dev moves).
	for (const name of Object.keys(baseDeps)) {
		if (Object.prototype.hasOwnProperty.call(headDev, name)) {
			return { ok: false, reason: `manifest: dependency "${name}" moved between sections` };
		}
	}
	for (const name of Object.keys(baseDev)) {
		if (Object.prototype.hasOwnProperty.call(headDeps, name)) {
			return { ok: false, reason: `manifest: dependency "${name}" moved between sections` };
		}
	}
	const changes = [];
	for (const section of ['dependencies', 'devDependencies']) {
		const baseSection = section === 'dependencies' ? baseDeps : baseDev;
		const headSection = section === 'dependencies' ? headDeps : headDev;
		for (const name of Object.keys(baseSection)) {
			if (baseSection[name] !== headSection[name]) {
				changes.push({
					name,
					section: section === 'dependencies' ? 'production' : 'development',
					from: baseSection[name],
					to: headSection[name],
				});
			}
		}
	}
	if (changes.length === 0) {
		return { ok: false, reason: 'manifest: no dependency version change found' };
	}
	for (const change of changes) {
		const result = classifyDependencyChange(change.section, change.from, change.to, policy);
		if (!result.ok) {
			return { ok: false, reason: `${change.name}: ${result.reason}` };
		}
		change.type = result.type;
	}
	return { ok: true, changes };
}

/**
 * Validate head lockfile root metadata consistency with the head manifest.
 *
 * @param {object} lock - package-lock.json at the PR head
 * @param {object} manifest - package.json at the PR head
 */
function validateLockfile(lock, manifest) {
	if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
		return { ok: false, reason: 'lockfile: not an object' };
	}
	if (!EXPECTED.SUPPORTED_LOCKFILE_VERSIONS.includes(lock.lockfileVersion)) {
		return { ok: false, reason: `lockfile: unsupported lockfileVersion ${JSON.stringify(lock.lockfileVersion)}` };
	}
	const root = lock.packages && lock.packages[''];
	if (!root || typeof root !== 'object') {
		return { ok: false, reason: 'lockfile: missing root package entry' };
	}
	if (root.name !== manifest.name) {
		return { ok: false, reason: `lockfile: root name "${root.name}" does not match manifest "${manifest.name}"` };
	}
	if (root.version !== manifest.version) {
		return {
			ok: false,
			reason: `lockfile: root version "${root.version}" does not match manifest "${manifest.version}"`,
		};
	}
	return { ok: true };
}

/**
 * Validate the PR file list: only root package.json and package-lock.json,
 * both status "modified", package.json mandatory, count consistent with the
 * PR's changed_files.
 *
 * @param {Array} files - changed files of the pull request
 * @param {number} changedFilesCount - changed_files reported by the PR
 */
function validateFileList(files, changedFilesCount) {
	if (!Array.isArray(files)) {
		return { ok: false, reason: 'files: not an array' };
	}
	if (typeof changedFilesCount === 'number' && files.length !== changedFilesCount) {
		return { ok: false, reason: `files: collected ${files.length} files but PR reports ${changedFilesCount}` };
	}
	let changedManifest = false;
	let changedLockfile = false;
	for (const file of files) {
		if (file.status !== 'modified') {
			return {
				ok: false,
				reason: `files: "${file.filename}" has status "${file.status}" (only modified is allowed)`,
			};
		}
		if (file.filename === EXPECTED.MANIFEST_PATH) {
			changedManifest = true;
		} else if (file.filename === EXPECTED.LOCKFILE_PATH) {
			changedLockfile = true;
		} else {
			return {
				ok: false,
				reason: `files: unexpected path "${file.filename}" (only root ${EXPECTED.MANIFEST_PATH} and ${EXPECTED.LOCKFILE_PATH} are allowed)`,
			};
		}
	}
	if (!changedManifest) {
		return {
			ok: false,
			reason: `files: ${EXPECTED.MANIFEST_PATH} must be changed (lockfile-only updates are unsupported)`,
		};
	}
	if (!changedLockfile) {
		return { ok: false, reason: `files: ${EXPECTED.LOCKFILE_PATH} must be present` };
	}
	return { ok: true };
}

/**
 * Validate the identity fields of a PR object against the Dependabot profile.
 *
 * @param {object} pr - pull request object
 */
function validatePrIdentity(pr) {
	if (!pr || typeof pr !== 'object') {
		return { ok: false, reason: 'pr: missing' };
	}
	const user = pr.user || {};
	if (
		user.login !== EXPECTED.DEPENDABOT_LOGIN ||
		user.id !== EXPECTED.DEPENDABOT_ID ||
		user.type !== EXPECTED.DEPENDABOT_TYPE
	) {
		return {
			ok: false,
			reason: `pr author is not ${EXPECTED.DEPENDABOT_LOGIN} (login=${JSON.stringify(user.login)}, id=${JSON.stringify(user.id)}, type=${JSON.stringify(user.type)})`,
		};
	}
	return { ok: true };
}

/**
 * Validate the triggering run object.
 *
 * @param {object} run - triggering workflow run object
 */
function validateTriggerRun(run) {
	if (!run || typeof run !== 'object') {
		return { ok: false, reason: 'run: missing' };
	}
	if (run.repository == null || run.repository.id !== EXPECTED.REPO_ID) {
		return {
			ok: false,
			reason: `run: repository id ${JSON.stringify(run.repository && run.repository.id)} is not ${EXPECTED.REPO_ID}`,
		};
	}
	if (run.workflow_id !== EXPECTED.WORKFLOW_ID) {
		return {
			ok: false,
			reason: `run: workflow_id ${JSON.stringify(run.workflow_id)} is not ${EXPECTED.WORKFLOW_ID}`,
		};
	}
	if (run.name !== EXPECTED.WORKFLOW_NAME || run.path !== EXPECTED.WORKFLOW_PATH) {
		return { ok: false, reason: `run: workflow is not "${EXPECTED.WORKFLOW_NAME}" at ${EXPECTED.WORKFLOW_PATH}` };
	}
	if (run.event !== 'pull_request') {
		return { ok: false, reason: `run: event is "${run.event}", not "pull_request"` };
	}
	if (run.status !== 'completed') {
		return { ok: false, reason: `run: status is "${run.status}", not "completed"` };
	}
	if (run.conclusion !== 'success') {
		return { ok: false, reason: `run: conclusion is "${run.conclusion}", not "success"` };
	}
	if (typeof run.head_sha !== 'string' || !SHA_RE.test(run.head_sha)) {
		return { ok: false, reason: 'run: head_sha is not a valid 40-char SHA' };
	}
	if (typeof run.run_attempt !== 'number' || !Number.isSafeInteger(run.run_attempt)) {
		return { ok: false, reason: 'run: run_attempt is not a safe integer' };
	}
	return { ok: true };
}

/**
 * Validate required checks: all three required job names must exist, be
 * completed and successful in the triggering run attempt, and the current
 * check-runs on the expected head (GitHub Actions app) must all be completed
 * and successful as well.
 *
 * @param {Array} jobs - jobs of the triggering run attempt
 * @param {Array} headCheckRuns - current check runs for the expected head
 * @param {number} suiteId - check suite id of the triggering run
 * @param {string} headSha - expected head SHA
 */
function validateChecks(jobs, headCheckRuns, suiteId, headSha) {
	const byName = new Map();
	for (const job of jobs) {
		byName.set(job.name, job);
	}
	const jobResults = {};
	for (const required of EXPECTED.REQUIRED_CHECKS) {
		const job = byName.get(required);
		if (!job) {
			return { ok: false, reason: `checks: required job "${required}" missing from run attempt` };
		}
		if (job.status !== 'completed' || job.conclusion !== 'success') {
			return { ok: false, reason: `checks: required job "${required}" is ${job.status}/${job.conclusion}` };
		}
		jobResults[required] = `${job.status}/${job.conclusion}`;
	}
	const relevant = [];
	for (const checkRun of headCheckRuns) {
		const app = checkRun.app || {};
		if (app.id !== EXPECTED.ACTIONS_APP_ID) {
			continue;
		}
		if (EXPECTED.REQUIRED_CHECKS.includes(checkRun.name)) {
			relevant.push(checkRun);
		}
	}
	for (const required of EXPECTED.REQUIRED_CHECKS) {
		const matches = relevant.filter(checkRun => checkRun.name === required);
		if (matches.length === 0) {
			return {
				ok: false,
				reason: `checks: no current check-run "${required}" (app ${EXPECTED.ACTIONS_APP_ID}) for head`,
			};
		}
		for (const checkRun of matches) {
			if (checkRun.status !== 'completed' || checkRun.conclusion !== 'success') {
				return {
					ok: false,
					reason: `checks: current check-run "${required}" is ${checkRun.status}/${checkRun.conclusion}`,
				};
			}
		}
		const suiteIds = new Set(
			matches
				.map(checkRun => checkRun.check_suite && checkRun.check_suite.id)
				.filter(id => typeof id === 'number'),
		);
		if (typeof suiteId === 'number' && !suiteIds.has(suiteId)) {
			return {
				ok: false,
				reason: `checks: "${required}" is not associated with the triggering run's check suite`,
			};
		}
		if (typeof headSha === 'string' && matches.some(checkRun => checkRun.head_sha !== headSha)) {
			return { ok: false, reason: `checks: "${required}" is not associated with the expected head SHA` };
		}
	}
	return { ok: true, jobResults };
}

/* ---------------------------------------------------------------------- */
/* API adapter                                                             */
/* ---------------------------------------------------------------------- */

function createApi(github) {
	const request = (route, params) => github.request(route, { owner: EXPECTED.OWNER, repo: EXPECTED.REPO, ...params });

	async function paginate(route, params, arrayKey) {
		const items = [];
		let page = 1;
		for (;;) {
			const response = await request(route, { ...params, per_page: 100, page });
			const body = response.data;
			const batch = arrayKey === null ? body : body && body[arrayKey];
			if (!Array.isArray(batch)) {
				throw new ControllerError(
					`API response for ${route} did not contain the expected array`,
					response.status,
				);
			}
			items.push(...batch);
			if (batch.length < 100) {
				return items;
			}
			page += 1;
		}
	}

	return {
		getRun: runId =>
			request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: runId }).then(
				response => response.data,
			),
		listOpenPrs: () =>
			paginate('GET /repos/{owner}/{repo}/pulls', { state: 'open', base: EXPECTED.BASE_REF }, null),
		getPr: number =>
			request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: number }).then(
				response => response.data,
			),
		listPrCommits: number =>
			paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', { pull_number: number }, null),
		listPrFiles: number =>
			paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { pull_number: number }, null),
		compare: (baseSha, headSha) =>
			request('GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: `${baseSha}...${headSha}` }).then(
				response => response.data,
			),
		getRef: ref => request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref }).then(response => response.data),
		getJsonFile: async (filePath, ref) => {
			const response = await request('GET /repos/{owner}/{repo}/contents/{path}', { path: filePath, ref });
			const data = response.data;
			if (
				!data ||
				typeof data !== 'object' ||
				data.type !== 'file' ||
				data.encoding !== 'base64' ||
				typeof data.content !== 'string'
			) {
				throw new ControllerError(`file ${filePath} at ${ref} is not a base64 file object`, response.status);
			}
			if (typeof data.size === 'number' && data.size > EXPECTED.MAX_FILE_BYTES) {
				return {
					ok: false,
					reason: `file ${filePath} at ${ref} is ${data.size} bytes (> ${EXPECTED.MAX_FILE_BYTES})`,
				};
			}
			try {
				return { ok: true, value: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')) };
			} catch (error) {
				return { ok: false, reason: `file ${filePath} at ${ref} is not valid JSON: ${error.message}` };
			}
		},
		listAttemptJobs: (runId, attempt) =>
			paginate(
				'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
				{ run_id: runId, attempt_number: attempt },
				'jobs',
			),
		listHeadCheckRuns: headSha =>
			paginate('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ref: headSha }, 'check_runs'),
		mergePr: (number, sha, mergeMethod) =>
			request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
				pull_number: number,
				sha,
				merge_method: mergeMethod,
			}).then(response => response.data),
	};
}

/* ---------------------------------------------------------------------- */
/* Orchestrator                                                            */
/* ---------------------------------------------------------------------- */

function loadConfig(configPath) {
	let raw;
	try {
		raw = fs.readFileSync(configPath, 'utf8');
	} catch (error) {
		throw new ControllerError(`config: cannot read ${configPath}: ${error.message}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ControllerError(`config: ${configPath} is not valid JSON: ${error.message}`);
	}
	const validated = validateConfig(parsed);
	if (!validated.ok) {
		throw new ControllerError(validated.reason);
	}
	return validated.config;
}

/**
 * Controller entry point executed by actions/github-script.
 *
 * @param {object} deps - dependencies provided by github-script
 * @param {object} deps.github - octokit API client
 * @param {object} deps.context - workflow run context of the controller job
 * @param {object} deps.core - actions core (logging, summary, setFailed)
 * @param {object} [opts] - test-only overrides (configPath)
 * @returns {Promise<object>} decision result with audit data
 */
async function run({ github, context, core }, opts = {}) {
	const audit = {
		triggerRunId: null,
		attempt: null,
		controllerSha: null,
		prNumber: null,
		head: null,
		baseSha: null,
		mergeBase: null,
		reason: null,
		jobResults: {},
		result: null,
		mergeCommitSha: null,
	};
	const api = createApi(github);

	try {
		const config = loadConfig(opts.configPath || path.join(process.cwd(), EXPECTED.CONFIG_PATH));

		if (context.eventName !== 'workflow_run') {
			return finish('skip', `event is "${context.eventName}", not "workflow_run"`, audit, core, false);
		}
		const payloadRun = context.payload && context.payload.workflow_run;
		if (!payloadRun || typeof payloadRun.id !== 'number' || !Number.isSafeInteger(payloadRun.id)) {
			return finish('skip', 'payload: workflow_run id missing or not a safe integer', audit, core, false);
		}
		if (context.payload.action && context.payload.action !== 'completed') {
			return finish(
				'skip',
				`payload: workflow_run action is "${context.payload.action}", not "completed"`,
				audit,
				core,
				false,
			);
		}
		const payloadRepository = context.payload && context.payload.repository;
		if (!payloadRepository || payloadRepository.full_name !== EXPECTED.REPO_NAME) {
			return finish('skip', `payload: repository is not ${EXPECTED.REPO_NAME}`, audit, core, false);
		}

		// 1. Fresh load of the triggering run; never trust the payload alone.
		const runData = await api.getRun(payloadRun.id);
		audit.triggerRunId = runData.id;
		audit.attempt = runData.run_attempt;
		audit.controllerSha = context.sha;
		const runValidation = validateTriggerRun(runData);
		if (!runValidation.ok) {
			return finish('skip', runValidation.reason, audit, core, false);
		}
		if (payloadRun.run_attempt !== runData.run_attempt) {
			return finish(
				'skip',
				`payload attempt ${JSON.stringify(payloadRun.run_attempt)} does not match fresh run attempt ${runData.run_attempt}`,
				audit,
				core,
				false,
			);
		}
		if (payloadRun.head_sha !== runData.head_sha) {
			return finish('skip', 'payload head_sha does not match fresh run head_sha', audit, core, false);
		}
		const headSha = runData.head_sha;
		audit.head = headSha;

		// 2. Find exactly one open same-repo-head PR with that head SHA.
		const openPrs = await api.listOpenPrs();
		const candidates = openPrs.filter(
			pr => pr.head && pr.head.sha === headSha && pr.head.repo && pr.head.repo.id === EXPECTED.REPO_ID,
		);
		if (candidates.length === 0) {
			return finish(
				'skip',
				`no open same-repo PR found for head ${headSha} (payload pull_requests is a hint only)`,
				audit,
				core,
				false,
			);
		}
		if (candidates.length > 1) {
			return finish(
				'skip',
				`multiple open PRs claim head ${headSha}: #${candidates.map(pr => pr.number).join(', #')}`,
				audit,
				core,
				false,
			);
		}
		let pr = candidates[0];
		audit.prNumber = pr.number;

		// 3. Fresh PR state and identity validation.
		const prValidation = await validatePr(api, pr, headSha);
		if (!prValidation.ok) {
			return finish('skip', prValidation.reason, audit, core, false);
		}
		pr = prValidation.pr;
		audit.baseSha = pr.base.sha;

		// 4. All PR commits authored and verified by Dependabot.
		const commits = await api.listPrCommits(pr.number);
		if (commits.length === 0) {
			return finish('skip', 'pr has no commits', audit, core, false);
		}
		for (const commit of commits) {
			const author = commit.author;
			if (!author || author.id !== EXPECTED.DEPENDABOT_ID || author.type !== EXPECTED.DEPENDABOT_TYPE) {
				return finish(
					'skip',
					`commit ${commit.sha ? commit.sha.slice(0, 8) : '(unknown)'} is not authored by ${EXPECTED.DEPENDABOT_LOGIN} (id ${EXPECTED.DEPENDABOT_ID})`,
					audit,
					core,
					false,
				);
			}
			const verification = commit.commit && commit.commit.verification;
			if (!verification || verification.verified !== true) {
				return finish(
					'skip',
					`commit ${commit.sha ? commit.sha.slice(0, 8) : '(unknown)'} is not verified`,
					audit,
					core,
					false,
				);
			}
		}

		// 5. File list policy.
		const files = await api.listPrFiles(pr.number);
		const fileList = validateFileList(files, pr.changed_files);
		if (!fileList.ok) {
			return finish('unsupported-policy', fileList.reason, audit, core, false);
		}

		// 6. Manifest/lockfile comparison against the merge base.
		const comparison = await api.compare(pr.base.sha, headSha);
		const mergeBase = comparison && comparison.merge_base_commit && comparison.merge_base_commit.sha;
		if (typeof mergeBase !== 'string' || !SHA_RE.test(mergeBase)) {
			return finish('skip', 'compare: no valid merge_base_commit sha', audit, core, false);
		}
		audit.mergeBase = mergeBase;
		const [baseManifest, headManifest, headLock] = await Promise.all([
			api.getJsonFile(EXPECTED.MANIFEST_PATH, mergeBase),
			api.getJsonFile(EXPECTED.MANIFEST_PATH, headSha),
			api.getJsonFile(EXPECTED.LOCKFILE_PATH, headSha),
		]);
		for (const loaded of [baseManifest, headManifest, headLock]) {
			if (!loaded.ok) {
				return finish('unsupported-policy', loaded.reason, audit, core, false);
			}
		}
		const lockValidation = validateLockfile(headLock.value, headManifest.value);
		if (!lockValidation.ok) {
			return finish('unsupported-policy', lockValidation.reason, audit, core, false);
		}
		const manifestDiff = validateManifestDiff(baseManifest.value, headManifest.value, config);
		if (!manifestDiff.ok) {
			return finish('unsupported-policy', manifestDiff.reason, audit, core, false);
		}
		const changeSummary = manifestDiff.changes
			.map(change => `${change.section}:${change.name} ${change.from} -> ${change.to} (${change.type})`)
			.join(', ');

		// 7. Required checks: run attempt jobs and current head check-runs.
		const jobs = await api.listAttemptJobs(runData.id, runData.run_attempt);
		const headCheckRuns = await api.listHeadCheckRuns(headSha);
		const checksValidation = validateChecks(jobs, headCheckRuns, runData.check_suite_id, headSha);
		if (!checksValidation.ok) {
			return finish('skip', checksValidation.reason, audit, core, false);
		}
		audit.jobResults = checksValidation.jobResults;

		// 8. Pre-mutation revalidation (head, base and PR state unchanged).
		const mainRef = await api.getRef(`heads/${EXPECTED.BASE_REF}`);
		const mainSha = mainRef && mainRef.object && mainRef.object.sha;
		const freshPr = await api.getPr(pr.number);
		if (freshPr.state !== 'open' || freshPr.merged === true || freshPr.draft === true) {
			return finish('skip', 'pr is no longer open (merged/closed/draft) — idempotent skip', audit, core, false);
		}
		if (freshPr.head.sha !== headSha) {
			return finish('skip', `head drifted before mutation: ${freshPr.head.sha}`, audit, core, false);
		}
		if (freshPr.base.sha !== pr.base.sha) {
			return finish('skip', 'base drifted before mutation: new CI run/review required', audit, core, false);
		}
		const identityRecheck = validatePrIdentity(freshPr);
		if (!identityRecheck.ok) {
			return finish('skip', identityRecheck.reason, audit, core, false);
		}
		if (freshPr.head.repo == null || freshPr.head.repo.id !== EXPECTED.REPO_ID) {
			return finish('skip', 'head repository drifted before mutation', audit, core, false);
		}
		if (freshPr.mergeable !== true || freshPr.mergeable_state !== 'clean') {
			return finish(
				'skip',
				`mergeability is ${JSON.stringify(freshPr.mergeable)}/${JSON.stringify(freshPr.mergeable_state)} — not clean`,
				audit,
				core,
				false,
			);
		}
		const freshMainRef = await api.getRef(`heads/${EXPECTED.BASE_REF}`);
		const freshMainSha = freshMainRef && freshMainRef.object && freshMainRef.object.sha;
		if (freshMainSha !== mainSha) {
			return finish(
				'skip',
				`base branch moved before mutation (${mainSha ? mainSha.slice(0, 8) : '?'} -> ${freshMainSha ? freshMainSha.slice(0, 8) : '?'}) — new CI run/review required`,
				audit,
				core,
				false,
			);
		}

		// 9. Decision. Audit mode never writes.
		if (!config.enabled) {
			audit.reason = changeSummary;
			return finish(
				'merge-decision',
				`AUDIT MODE (enabled=false): would merge #${pr.number} at ${headSha} — ${changeSummary}`,
				audit,
				core,
				false,
			);
		}

		// 10. SHA-bound squash merge and readback.
		const mergeResponse = await api.mergePr(pr.number, headSha, config.mergeMethod);
		if (!mergeResponse || mergeResponse.merged !== true) {
			return finish(
				'error',
				`merge response did not confirm success (merged=${JSON.stringify(mergeResponse && mergeResponse.merged)})`,
				audit,
				core,
				true,
			);
		}
		audit.mergeCommitSha = mergeResponse.sha || null;
		const mergedPr = await api.getPr(pr.number);
		if (mergedPr.merged !== true) {
			return finish('error', 'merge readback: PR is not merged', audit, core, true);
		}
		if (mergedPr.merge_commit_sha !== mergeResponse.sha) {
			return finish(
				'error',
				`merge readback: merge_commit_sha mismatch (${mergedPr.merge_commit_sha} != ${mergeResponse.sha})`,
				audit,
				core,
				true,
			);
		}
		audit.reason = changeSummary;
		return finish(
			'merged',
			`merged #${pr.number} at ${headSha} (merge commit ${mergeResponse.sha}) — ${changeSummary}`,
			audit,
			core,
			false,
		);
	} catch (error) {
		const status = error && typeof error.status === 'number' ? ` (HTTP ${error.status})` : '';
		return finish('error', `fail closed: ${error.name || 'Error'}${status}: ${error.message}`, audit, core, true);
	}
}

async function validatePr(api, pr, headSha) {
	const fresh = await api.getPr(pr.number);
	if (fresh.merged === true) {
		return { ok: false, reason: 'pr is already merged — idempotent skip' };
	}
	if (fresh.state !== 'open') {
		return { ok: false, reason: `pr is "${fresh.state}", not open` };
	}
	if (fresh.draft === true) {
		return { ok: false, reason: 'pr is a draft' };
	}
	if (
		fresh.base == null ||
		fresh.base.ref !== EXPECTED.BASE_REF ||
		fresh.base.repo == null ||
		fresh.base.repo.id !== EXPECTED.REPO_ID
	) {
		return { ok: false, reason: `pr base is not ${EXPECTED.BASE_REF} in repository ${EXPECTED.REPO_ID}` };
	}
	if (fresh.head == null || fresh.head.repo == null || fresh.head.repo.id !== EXPECTED.REPO_ID) {
		return { ok: false, reason: 'pr head is not a same-repository head' };
	}
	if (fresh.head.sha !== headSha) {
		return { ok: false, reason: `pr head ${fresh.head.sha} does not match triggering run head ${headSha}` };
	}
	const identity = validatePrIdentity(fresh);
	if (!identity.ok) {
		return { ok: false, reason: identity.reason };
	}
	return { ok: true, pr: fresh };
}

function finish(result, reason, audit, core, failed) {
	audit.result = result;
	const lines = [
		'## Dependabot Auto-Merge Audit',
		`- Triggering run: ${audit.triggerRunId == null ? 'n/a' : audit.triggerRunId}${audit.attempt == null ? '' : ` (attempt ${audit.attempt})`}`,
		`- Controller SHA: ${audit.controllerSha == null ? 'n/a' : audit.controllerSha}`,
		`- PR: ${audit.prNumber == null ? 'none' : `#${audit.prNumber}`}`,
		`- Validated head: ${audit.head == null ? 'n/a' : audit.head}`,
		`- Base: ${audit.baseSha == null ? 'n/a' : `${EXPECTED.BASE_REF} @ ${audit.baseSha}`} (merge-base ${audit.mergeBase == null ? 'n/a' : audit.mergeBase})`,
		`- Required checks: ${Object.keys(audit.jobResults).length === 0 ? 'n/a' : EXPECTED.REQUIRED_CHECKS.map(name => `${name}=${audit.jobResults[name] || 'n/a'}`).join('; ')}`,
		`- Result: ${result}`,
		`- Detail: ${reason}`,
	];
	if (audit.mergeCommitSha) {
		lines.push(`- Merge commit: ${audit.mergeCommitSha}`);
	}
	const summary = `${lines.join('\n')}\n`;
	core.info(summary);
	if (core.summary && typeof core.summary.addRaw === 'function' && typeof core.summary.write === 'function') {
		core.summary.addRaw(summary);
		core.summary.write();
	}
	if (failed) {
		core.setFailed(`dependabot-automerge: ${result}: ${reason}`);
	}
	return { result, reason, audit };
}

module.exports = {
	run,
	// Exported for offline tests only; the runtime entry point is `run`.
	__pure: {
		validateConfig,
		parseVersionSpec,
		compareParsedVersions,
		bumpType,
		classifyDependencyChange,
		deepEqual,
		validateManifestDiff,
		validateLockfile,
		validateFileList,
		validatePrIdentity,
		validateTriggerRun,
		validateChecks,
	},
	EXPECTED,
	ControllerError,
};
