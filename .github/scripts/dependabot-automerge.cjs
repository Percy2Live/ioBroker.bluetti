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
	// The paginated pulls/{number}/commits endpoint returns a maximum of 250
	// commits (documented REST limit); above that the list cannot be proven
	// complete, so the controller refuses instead of trusting a subset.
	MAX_PR_COMMITS: 250,
	SUPPORTED_LOCKFILE_VERSIONS: [2, 3],
	MANIFEST_PATH: 'package.json',
	LOCKFILE_PATH: 'package-lock.json',
};

const SHA_RE = /^[0-9a-f]{40}$/;

function isSha(value) {
	return typeof value === 'string' && SHA_RE.test(value);
}

function isSafeId(value) {
	return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Sanitize any value before it reaches logs or the job summary: strip control
 * characters (newlines, NUL, ...), collapse whitespace and cap the length.
 * Raw API messages, JSON parser fragments and token snippets must never be
 * echoed; error output uses fixed categories and route identifiers only.
 *
 * @param {unknown} value - value to sanitize
 * @param {number} [maxLength] - maximum number of characters to keep
 */
function sanitizeDetail(value, maxLength = 300) {
	let text = typeof value === 'string' ? value : '';
	if (text === '') {
		return 'n/a';
	}
	text = text
		// eslint-disable-next-line no-control-regex -- control characters are stripped deliberately
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

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
			// Fixed category: never echo configuration keys/values.
			return { ok: false, reason: 'config: unknown field' };
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
			return { ok: false, reason: 'config: unknown npm field' };
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
				// Fixed category: never echo configuration values.
				return { ok: false, reason: `config: npm.${section} value not allowed` };
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
		// Fixed category: never echo the (PR-controlled) spec text.
		return { ok: false, reason: 'version spec: unsupported format' };
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
			reason: `dependency ${section}: version range prefix changed`,
		};
	}
	const cmp = compareParsedVersions(oldV, newV);
	if (cmp < 0) {
		return { ok: false, reason: `dependency ${section}: version downgrade` };
	}
	if (cmp === 0) {
		return { ok: false, reason: `dependency ${section}: version unchanged` };
	}
	const type = bumpType(oldV, newV);
	if (!policy.npm[section].has(type)) {
		return {
			ok: false,
			reason: `dependency ${section}: ${type} update not allowed by policy`,
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
 * The root packages[""] entry must mirror the manifest's dependencies and
 * devDependencies structurally (same names, same specs, same prod/dev
 * assignment, aliases unchanged); a missing root section only passes when the
 * manifest section is really empty. Transitive resolution stays outside this
 * structural guarantee.
 *
 * @param {object} lock - package-lock.json at the PR head
 * @param {object} manifest - package.json at the PR head
 */
function validateLockfile(lock, manifest) {
	if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
		return { ok: false, reason: 'lockfile: not an object' };
	}
	if (!EXPECTED.SUPPORTED_LOCKFILE_VERSIONS.includes(lock.lockfileVersion)) {
		return { ok: false, reason: 'lockfile: unsupported lockfileVersion' };
	}
	const root = lock.packages && lock.packages[''];
	if (!root || typeof root !== 'object' || Array.isArray(root)) {
		return { ok: false, reason: 'lockfile: missing root package entry' };
	}
	if (root.name !== manifest.name) {
		// Fixed category: never echo lockfile/manifest strings.
		return { ok: false, reason: 'lockfile: root name does not match the manifest name' };
	}
	if (root.version !== manifest.version) {
		return {
			ok: false,
			reason: 'lockfile: root version does not match the manifest version',
		};
	}
	// A missing root dependencies section is only equivalent to a really
	// empty manifest section, never to a populated one.
	const rootDeps = root.dependencies === undefined ? {} : root.dependencies;
	const rootDevDeps = root.devDependencies === undefined ? {} : root.devDependencies;
	if (rootDeps === null || typeof rootDeps !== 'object' || Array.isArray(rootDeps)) {
		return { ok: false, reason: 'lockfile: root dependencies is not an object' };
	}
	if (rootDevDeps === null || typeof rootDevDeps !== 'object' || Array.isArray(rootDevDeps)) {
		return { ok: false, reason: 'lockfile: root devDependencies is not an object' };
	}
	if (!deepEqual(rootDeps, manifest.dependencies ?? {})) {
		return {
			ok: false,
			reason: 'lockfile: root dependencies do not match the manifest dependencies (added, removed, moved or changed version specs)',
		};
	}
	if (!deepEqual(rootDevDeps, manifest.devDependencies ?? {})) {
		return {
			ok: false,
			reason: 'lockfile: root devDependencies do not match the manifest devDependencies (added, removed, moved or changed version specs)',
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
	// changed_files is a mandatory field: a missing or non-integer count must
	// not silently pass as "optional".
	if (!isSafeId(changedFilesCount) || changedFilesCount < 0) {
		return { ok: false, reason: 'files: PR changed_files is missing or not a safe integer' };
	}
	if (files.length !== changedFilesCount) {
		return { ok: false, reason: `files: collected ${files.length} files but PR reports ${changedFilesCount}` };
	}
	let changedManifest = false;
	let changedLockfile = false;
	for (const file of files) {
		if (file.status !== 'modified') {
			// Fixed category: never echo PR-controlled file names.
			return {
				ok: false,
				reason: 'files: a changed file has a status other than "modified"',
			};
		}
		if (file.filename === EXPECTED.MANIFEST_PATH) {
			changedManifest = true;
		} else if (file.filename === EXPECTED.LOCKFILE_PATH) {
			changedLockfile = true;
		} else {
			return {
				ok: false,
				reason: `files: path outside the allowed root file set (only root ${EXPECTED.MANIFEST_PATH} and ${EXPECTED.LOCKFILE_PATH} are allowed)`,
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
 * Validate the completeness of the collected PR commit list against the PR's
 * reported commit count and the expected head. The paginated
 * pulls/{number}/commits endpoint returns at most MAX_PR_COMMITS commits, so
 * a PR reporting more is refused outright instead of trusting a subset.
 * Count drift, missing/duplicate/invalid SHAs and a missing expected head all
 * fail closed.
 *
 * @param {Array} commits - collected commits of the pull request
 * @param {number} reportedCount - commits reported by the PR object
 * @param {string} headSha - expected head SHA
 */
function validatePrCommits(commits, reportedCount, headSha) {
	if (!isSafeId(reportedCount) || reportedCount < 1) {
		return {
			ok: false,
			reason: 'commits: PR commit count is missing or not a safe positive integer',
		};
	}
	if (reportedCount > EXPECTED.MAX_PR_COMMITS) {
		return {
			ok: false,
			reason: `commits: PR reports ${reportedCount} commits, above the ${EXPECTED.MAX_PR_COMMITS} commit endpoint cap — unsupported for automatic merge`,
		};
	}
	if (!Array.isArray(commits)) {
		return { ok: false, reason: 'commits: collected list is not an array' };
	}
	if (commits.length !== reportedCount) {
		return { ok: false, reason: `commits: collected ${commits.length} commits but PR reports ${reportedCount}` };
	}
	const seen = new Set();
	for (const commit of commits) {
		if (!commit || typeof commit !== 'object') {
			return { ok: false, reason: 'commits: entry is not an object' };
		}
		if (!isSha(commit.sha)) {
			return { ok: false, reason: 'commits: entry has no valid 40-char SHA' };
		}
		if (seen.has(commit.sha)) {
			return { ok: false, reason: 'commits: duplicate SHA in the collected commit list' };
		}
		seen.add(commit.sha);
	}
	if (!seen.has(headSha)) {
		return { ok: false, reason: 'commits: expected head SHA is not part of the collected commit list' };
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
		// Fixed category: never echo author data from the PR.
		return {
			ok: false,
			reason: 'pr author is not the expected verified Dependabot identity (login/id/type mismatch)',
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
	if (!isSafeId(run.id) || run.id <= 0) {
		return { ok: false, reason: 'run: id is missing or not a safe positive integer' };
	}
	if (run.repository == null || run.repository.id !== EXPECTED.REPO_ID) {
		return { ok: false, reason: `run: repository id is not ${EXPECTED.REPO_ID}` };
	}
	if (run.workflow_id !== EXPECTED.WORKFLOW_ID) {
		return { ok: false, reason: `run: workflow_id is not ${EXPECTED.WORKFLOW_ID}` };
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
	if (!isSha(run.head_sha)) {
		return { ok: false, reason: 'run: head_sha is not a valid 40-char SHA' };
	}
	if (!isSafeId(run.run_attempt) || run.run_attempt < 1) {
		return { ok: false, reason: 'run: run_attempt is not a safe positive integer' };
	}
	// The check suite id is the mandatory binding between the triggering run
	// and the required head check runs; without it no check can be attributed.
	if (!isSafeId(run.check_suite_id)) {
		return { ok: false, reason: 'run: check_suite_id is missing or not a safe integer' };
	}
	return { ok: true };
}

/**
 * Validate required checks with unambiguous ID binding (fail closed).
 *
 *  - All three required job names must appear EXACTLY ONCE in the jobs of the
 *    triggering run attempt; duplicates are ambiguous and rejected. Every
 *    required job needs a safe integer id and must be completed/success.
 *  - The head check-run list (GitHub Actions app only) must contain EXACTLY
 *    ONE check run per required name; zero or multiple matches are rejected.
 *  - Each required head check run must be bound to the corresponding job of
 *    the exact attempt via its id (GitHub uses the job id as the check-run id
 *    for Actions-created check runs; verified against real run/job data),
 *    belong to the triggering run's check suite, point at the expected head
 *    SHA and be completed/success.
 *  - suiteId and headSha are mandatory inputs; callers must pass validated
 *    run.check_suite_id and the expected head.
 *
 * @param {Array} jobs - jobs of the triggering run attempt
 * @param {Array} headCheckRuns - current check runs for the expected head (filter=latest, paginated)
 * @param {number} suiteId - check suite id of the triggering run
 * @param {string} headSha - expected head SHA
 */
function validateChecks(jobs, headCheckRuns, suiteId, headSha) {
	if (!Array.isArray(jobs)) {
		return { ok: false, reason: 'checks: jobs is not an array' };
	}
	if (!Array.isArray(headCheckRuns)) {
		return { ok: false, reason: 'checks: head check runs is not an array' };
	}
	if (!isSafeId(suiteId)) {
		return { ok: false, reason: 'checks: triggering run check_suite_id missing' };
	}
	if (!isSha(headSha)) {
		return { ok: false, reason: 'checks: expected head SHA missing' };
	}
	const requiredJobs = new Map();
	for (const job of jobs) {
		if (!job || typeof job !== 'object' || !EXPECTED.REQUIRED_CHECKS.includes(job.name)) {
			continue;
		}
		if (requiredJobs.has(job.name)) {
			return { ok: false, reason: `checks: duplicate job "${job.name}" in run attempt` };
		}
		if (!isSafeId(job.id)) {
			return { ok: false, reason: `checks: required job "${job.name}" has no safe integer id` };
		}
		requiredJobs.set(job.name, job);
	}
	const jobResults = {};
	for (const required of EXPECTED.REQUIRED_CHECKS) {
		const job = requiredJobs.get(required);
		if (!job) {
			return { ok: false, reason: `checks: required job "${required}" missing from run attempt` };
		}
		if (job.status !== 'completed' || job.conclusion !== 'success') {
			return { ok: false, reason: `checks: required job "${required}" is ${job.status}/${job.conclusion}` };
		}
		jobResults[required] = `${job.status}/${job.conclusion}`;
		const matches = headCheckRuns.filter(
			checkRun =>
				checkRun &&
				typeof checkRun === 'object' &&
				checkRun.app &&
				checkRun.app.id === EXPECTED.ACTIONS_APP_ID &&
				checkRun.name === required,
		);
		if (matches.length === 0) {
			return {
				ok: false,
				reason: `checks: no current check-run "${required}" (app ${EXPECTED.ACTIONS_APP_ID}) for head`,
			};
		}
		if (matches.length > 1) {
			return {
				ok: false,
				reason: `checks: ambiguous current check-runs "${required}" (${matches.length} matches for this head)`,
			};
		}
		const checkRun = matches[0];
		if (!isSafeId(checkRun.id)) {
			return { ok: false, reason: `checks: check-run "${required}" has no safe integer id` };
		}
		if (checkRun.id !== job.id) {
			return {
				ok: false,
				reason: `checks: check-run "${required}" (id ${checkRun.id}) is not bound to the required attempt job (id ${job.id})`,
			};
		}
		if (checkRun.status !== 'completed' || checkRun.conclusion !== 'success') {
			return {
				ok: false,
				reason: `checks: current check-run "${required}" is ${checkRun.status}/${checkRun.conclusion}`,
			};
		}
		if (!checkRun.check_suite || !isSafeId(checkRun.check_suite.id) || checkRun.check_suite.id !== suiteId) {
			return {
				ok: false,
				reason: `checks: "${required}" is not associated with the triggering run's check suite`,
			};
		}
		if (checkRun.head_sha !== headSha) {
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
			// The size field is mandatory: without it no bounded size decision
			// can be made. It must be a safe non-negative integer within the limit.
			if (!isSafeId(data.size) || data.size < 0) {
				return {
					ok: false,
					reason: `file ${filePath} at ${ref} has no valid size field`,
				};
			}
			if (data.size > EXPECTED.MAX_FILE_BYTES) {
				return {
					ok: false,
					reason: `file ${filePath} at ${ref} is ${data.size} bytes (> ${EXPECTED.MAX_FILE_BYTES})`,
				};
			}
			let decoded;
			try {
				decoded = Buffer.from(data.content, 'base64').toString('utf8');
			} catch {
				return { ok: false, reason: `file ${filePath} at ${ref} could not be base64-decoded` };
			}
			// Decoding consistency: the decoded byte length must equal the
			// reported size, otherwise the content was truncated or padded.
			if (Buffer.byteLength(decoded, 'utf8') !== data.size) {
				return {
					ok: false,
					reason: `file ${filePath} at ${ref} decoded to ${Buffer.byteLength(decoded, 'utf8')} bytes but reports ${data.size} (possible truncation)`,
				};
			}
			try {
				return { ok: true, value: JSON.parse(decoded) };
			} catch {
				// Never echo parser messages: they can contain response fragments.
				return { ok: false, reason: `file ${filePath} at ${ref} is not valid JSON` };
			}
		},
		listAttemptJobs: (runId, attempt) =>
			paginate(
				'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
				{ run_id: runId, attempt_number: attempt },
				'jobs',
			),
		// The check-runs endpoint defaults to filter=latest, which returns the
		// latest check runs for this head across suites; the filter is set
		// explicitly and the result is still paginated because a head can have
		// more than 100 check runs (matrix jobs, bots, deploy).
		listHeadCheckRuns: headSha =>
			paginate(
				'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
				{ ref: headSha, filter: 'latest' },
				'check_runs',
			),
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
	} catch {
		// Fixed message without raw fs error details (fail closed).
		throw new ControllerError(`config: cannot read configuration file ${configPath}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Fixed category only: parser messages may contain file fragments.
		throw new ControllerError('config: configuration file is not valid JSON');
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
		if (runData.id !== payloadRun.id) {
			return finish('skip', 'fresh run id does not match the payload run id', audit, core, false);
		}
		audit.triggerRunId = runData.id;
		audit.attempt = runData.run_attempt;
		audit.controllerSha = context.sha;
		const runValidation = validateTriggerRun(runData);
		if (!runValidation.ok) {
			return finish('skip', runValidation.reason, audit, core, false);
		}
		if (payloadRun.run_attempt !== runData.run_attempt) {
			return finish('skip', 'payload attempt does not match the fresh run attempt', audit, core, false);
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
			return finish('skip', 'multiple open PRs claim the triggering head', audit, core, false);
		}
		let pr = candidates[0];
		// The candidate's number is a mandatory field: all API paths are built
		// from it and a missing number must never fall through to a fetch.
		if (!isSafeId(pr.number) || pr.number <= 0) {
			return finish(
				'skip',
				`candidate PR number is missing or not a safe positive integer (${JSON.stringify(pr.number)})`,
				audit,
				core,
				false,
			);
		}
		audit.prNumber = pr.number;

		// 3. Fresh PR state and identity validation.
		const prValidation = await validatePr(api, pr, headSha);
		if (!prValidation.ok) {
			return finish('skip', prValidation.reason, audit, core, false);
		}
		pr = prValidation.pr;
		audit.baseSha = pr.base.sha;

		// 4. All PR commits authored and verified by Dependabot. The collected
		// list must be complete: count-consistent with pr.commits, within the
		// documented 250-commit endpoint cap, unique, valid and including the
		// expected head (R2).
		const commits = await api.listPrCommits(pr.number);
		const commitsValidation = validatePrCommits(commits, pr.commits, headSha);
		if (!commitsValidation.ok) {
			if (isSafeId(pr.commits) && pr.commits > EXPECTED.MAX_PR_COMMITS) {
				return finish('unsupported-policy', commitsValidation.reason, audit, core, false);
			}
			return finish('skip', commitsValidation.reason, audit, core, false);
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

		// 8. Pre-mutation revalidation. The full initial PR validator is applied
		// again to a freshly fetched PR (base ref/repo identity included), the
		// observed base branch must return valid fixed SHAs, stay stable between
		// both reads and match the validated current PR base. There is no
		// captured CI base snapshot and no atomic base lock; with
		// required_status_checks.strict=false this observed consistency is NOT a
		// guarantee that CI ran against the newest merge combination.
		const mainRef = await api.getRef(`heads/${EXPECTED.BASE_REF}`);
		const mainSha = mainRef && mainRef.object && mainRef.object.sha;
		if (!isSha(mainSha)) {
			return finish(
				'skip',
				'base branch reference did not return a valid 40-char SHA before mutation',
				audit,
				core,
				false,
			);
		}
		const freshPr = await api.getPr(pr.number);
		const prRecheck = validatePrObject(freshPr, headSha);
		if (!prRecheck.ok) {
			return finish('skip', prRecheck.reason, audit, core, false);
		}
		if (freshPr.base.sha !== pr.base.sha) {
			return finish('skip', 'base drifted before mutation: new CI run/review required', audit, core, false);
		}
		if (freshPr.mergeable !== true || freshPr.mergeable_state !== 'clean') {
			return finish('skip', 'mergeability is not clean before mutation', audit, core, false);
		}
		const freshMainRef = await api.getRef(`heads/${EXPECTED.BASE_REF}`);
		const freshMainSha = freshMainRef && freshMainRef.object && freshMainRef.object.sha;
		if (!isSha(freshMainSha)) {
			return finish(
				'skip',
				'base branch reference did not return a valid 40-char SHA at revalidation',
				audit,
				core,
				false,
			);
		}
		if (freshMainSha !== mainSha) {
			return finish(
				'skip',
				`base branch moved before mutation (${mainSha.slice(0, 8)} -> ${freshMainSha.slice(0, 8)}) — new CI run/review required`,
				audit,
				core,
				false,
			);
		}
		if (freshMainSha !== freshPr.base.sha) {
			return finish(
				'skip',
				`PR base ${freshPr.base.sha.slice(0, 8)} differs from current base branch head ${freshMainSha.slice(0, 8)} — new CI run/review required`,
				audit,
				core,
				false,
			);
		}

		// 9. Final fresh read of the triggering run, its exact attempt and the
		// current required check results immediately before the decision; any
		// drift (newer attempt, re-run, changed check state) skips. This does
		// not turn the sequence into an atomic lock: a small read/merge race
		// remains, with the SHA-bound merge request and GitHub's server-side
		// branch protection as the final gates.
		const finalRun = await api.getRun(runData.id);
		if (
			finalRun.id !== runData.id ||
			finalRun.head_sha !== headSha ||
			finalRun.run_attempt !== runData.run_attempt
		) {
			return finish(
				'skip',
				'triggering run drifted before decision: newer attempt/head observed',
				audit,
				core,
				false,
			);
		}
		const finalRunValidation = validateTriggerRun(finalRun);
		if (!finalRunValidation.ok) {
			return finish('skip', finalRunValidation.reason, audit, core, false);
		}
		if (finalRun.check_suite_id !== runData.check_suite_id) {
			return finish('skip', 'triggering run check suite drifted before decision', audit, core, false);
		}
		const finalJobs = await api.listAttemptJobs(finalRun.id, finalRun.run_attempt);
		const finalHeadCheckRuns = await api.listHeadCheckRuns(headSha);
		const finalChecks = validateChecks(finalJobs, finalHeadCheckRuns, finalRun.check_suite_id, headSha);
		if (!finalChecks.ok) {
			return finish('skip', finalChecks.reason, audit, core, false);
		}
		audit.jobResults = finalChecks.jobResults;

		// 10. Decision. Audit mode never writes.
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

		// 11. SHA-bound squash merge and readback.
		const mergeResponse = await api.mergePr(pr.number, headSha, config.mergeMethod);
		if (!mergeResponse || mergeResponse.merged !== true) {
			return finish('error', 'merge response did not confirm success', audit, core, true);
		}
		if (!isSha(mergeResponse.sha)) {
			return finish(
				'error',
				'merge readback: response did not contain a valid merge commit SHA',
				audit,
				core,
				true,
			);
		}
		audit.mergeCommitSha = mergeResponse.sha;
		const mergedPr = await api.getPr(pr.number);
		if (mergedPr.merged !== true) {
			return finish('error', 'merge readback: PR is not merged', audit, core, true);
		}
		if (
			!mergedPr ||
			mergedPr.number !== pr.number ||
			!mergedPr.base ||
			!mergedPr.base.repo ||
			mergedPr.base.repo.id !== EXPECTED.REPO_ID
		) {
			return finish('error', 'merge readback: PR or repository identity mismatch', audit, core, true);
		}
		if (!mergedPr.head || !isSha(mergedPr.head.sha) || mergedPr.head.sha !== headSha) {
			return finish('error', 'merge readback: merged head differs from the validated head', audit, core, true);
		}
		if (!isSha(mergedPr.merge_commit_sha)) {
			return finish('error', 'merge readback: PR has no valid merge_commit_sha', audit, core, true);
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
		// Fixed error categories only: for controller-internal errors the
		// authored route message (sanitized) is kept; for any foreign error
		// only the error name and a numeric HTTP status are logged. Raw
		// messages, response bodies, JSON fragments and token snippets never
		// reach logs, summary or setFailed.
		let detail;
		if (error instanceof ControllerError) {
			detail = `fail closed: ${sanitizeDetail(error.message)}`;
		} else {
			const status =
				error && isSafeId(error.status) && error.status >= 100 && error.status <= 599
					? ` (HTTP ${error.status})`
					: '';
			const name =
				error && typeof error.name === 'string' && error.name !== '' ? sanitizeDetail(error.name, 60) : 'Error';
			detail = `fail closed: ${name}${status}`;
		}
		return finish('error', detail, audit, core, true);
	}
}

/**
 * Full PR validation on an already-fetched PR object. Used both for the
 * initial validation and immediately before the merge decision/mutation so
 * the complete PR/repo/base/author/head invariant holds at mutation time.
 *
 * @param {object} fresh - freshly fetched pull request object
 * @param {string} headSha - expected head SHA
 */
function validatePrObject(fresh, headSha) {
	if (!fresh || typeof fresh !== 'object') {
		return { ok: false, reason: 'pr: missing' };
	}
	if (fresh.merged === true) {
		return { ok: false, reason: 'pr is already merged — idempotent skip' };
	}
	// pr.number is a mandatory field: API paths are built from it.
	if (!isSafeId(fresh.number) || fresh.number <= 0) {
		return { ok: false, reason: 'pr: number is missing or not a safe positive integer' };
	}
	if (fresh.state !== 'open') {
		return { ok: false, reason: `pr is "${fresh.state}", not open` };
	}
	if (fresh.draft === true) {
		return { ok: false, reason: 'pr is a draft' };
	}
	if (fresh.base == null || typeof fresh.base !== 'object') {
		return { ok: false, reason: `pr base is not ${EXPECTED.BASE_REF} in repository ${EXPECTED.REPO_ID}` };
	}
	if (fresh.base.ref !== EXPECTED.BASE_REF || fresh.base.repo == null || fresh.base.repo.id !== EXPECTED.REPO_ID) {
		return { ok: false, reason: `pr base is not ${EXPECTED.BASE_REF} in repository ${EXPECTED.REPO_ID}` };
	}
	// A missing/invalid base SHA must not pass a bare equality check later.
	if (!isSha(fresh.base.sha)) {
		return { ok: false, reason: 'pr base SHA is missing or not a valid 40-char SHA' };
	}
	if (
		fresh.head == null ||
		typeof fresh.head !== 'object' ||
		fresh.head.repo == null ||
		fresh.head.repo.id !== EXPECTED.REPO_ID
	) {
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

/**
 * Fetch a fresh PR state and run the full validation on it.
 *
 * @param {object} api - API adapter
 * @param {object} pr - candidate PR object (only number is used)
 * @param {string} headSha - expected head SHA
 */
async function validatePr(api, pr, headSha) {
	const fresh = await api.getPr(pr.number);
	return validatePrObject(fresh, headSha);
}

function finish(result, reason, audit, core, failed) {
	audit.result = result;
	// All details are sanitized: control characters are stripped so that
	// injected newlines cannot forge summary lines, and the length is capped.
	const detail = sanitizeDetail(reason);
	const lines = [
		'## Dependabot Auto-Merge Audit',
		`- Triggering run: ${audit.triggerRunId == null ? 'n/a' : audit.triggerRunId}${audit.attempt == null ? '' : ` (attempt ${audit.attempt})`}`,
		`- Controller SHA: ${audit.controllerSha == null ? 'n/a' : audit.controllerSha}`,
		`- PR: ${audit.prNumber == null ? 'none' : `#${audit.prNumber}`}`,
		`- Validated head: ${audit.head == null ? 'n/a' : audit.head}`,
		`- Base: ${audit.baseSha == null ? 'n/a' : `${EXPECTED.BASE_REF} @ ${audit.baseSha}`} (merge-base ${audit.mergeBase == null ? 'n/a' : audit.mergeBase})`,
		`- Required checks: ${Object.keys(audit.jobResults).length === 0 ? 'n/a' : EXPECTED.REQUIRED_CHECKS.map(name => `${name}=${audit.jobResults[name] || 'n/a'}`).join('; ')}`,
		`- Result: ${result}`,
		`- Detail: ${detail}`,
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
		core.setFailed(`dependabot-automerge: ${result}: ${detail}`);
	}
	return { result, reason: detail, audit };
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
		validatePrCommits,
		validatePrIdentity,
		validatePrObject,
		validateTriggerRun,
		validateChecks,
	},
	EXPECTED,
	ControllerError,
};
